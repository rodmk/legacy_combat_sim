use std::collections::{HashMap, HashSet};
use std::time::Instant;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::analysis::{analyze_build_catalog, InferredMeta};
use crate::catalog::{BuildCatalog, Catalogs};
use crate::combat::combat_signature;
use crate::inference::{prune_opponent_mixture, pruned_score_proves_below, PrunedMixture};
use crate::model::{CombatSignature, MatchupRole, Player};
use crate::search::{candidate_frontiers_cached, CandidateGroup, MatchupEvaluationCache};

/// Controls active-archive equilibrium solving over a fixed candidate pool.
#[derive(Clone, Debug, Serialize)]
pub struct CandidateMetaOptions {
    /// Maximum rounds performed by this invocation.
    pub maximum_rounds: usize,
    /// Profitable responses admitted per round.
    pub batch_size: usize,
    /// Advantage above 0.5 required for admission.
    pub response_tolerance: f64,
    /// Maximum equilibrium mass omitted during candidate screening.
    pub opponent_pruning_tolerance: f64,
    /// Approximate combat-tail threshold used for screening.
    pub minimum_survival_probability: f64,
}

impl Default for CandidateMetaOptions {
    fn default() -> Self {
        Self {
            maximum_rounds: 100,
            batch_size: 2,
            response_tolerance: 1e-3,
            opponent_pruning_tolerance: 5e-3,
            minimum_survival_probability: 0.01,
        }
    }
}

/// One active-archive solve and fixed-pool response pass.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CandidateMetaRound {
    /// One-based round number.
    pub round: usize,
    /// Active strategies before admissions.
    pub active_count_before: usize,
    /// Equilibrium over the active archive.
    pub equilibrium: InferredMeta,
    /// Mixture used for response screening.
    pub opponent_mixture: PrunedMixture,
    /// Inactive combat-distinct candidates screened.
    pub pool_candidates: usize,
    /// Approximate matchup evaluations.
    pub approximate_matchups: usize,
    /// Candidates promoted for exact evaluation.
    pub exact_finalists: usize,
    /// Exact matchup evaluations.
    pub exact_matchups: usize,
    /// Strongest exact inactive response score.
    pub best_response_score: f64,
    /// Candidate IDs admitted during this round.
    pub additions: Vec<String>,
    /// Whether no profitable inactive response remained.
    pub converged: bool,
    /// Wall-clock duration of the round.
    #[serde(default)]
    pub elapsed_ms: u128,
}

/// Resumable state for fixed-pool candidate-meta solving.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CandidateMetaState {
    /// Candidate IDs currently in the active archive.
    pub active_ids: Vec<String>,
    /// Completed round reports.
    pub rounds: Vec<CandidateMetaRound>,
    /// Whether the fixed candidate pool is closed at the requested tolerance.
    pub converged: bool,
}

#[derive(Clone)]
struct PoolSource {
    id: String,
}

#[derive(Clone)]
struct PoolGroup {
    signature: CombatSignature,
    representative: Player,
    sources: Vec<PoolSource>,
}

impl CandidateGroup for PoolGroup {
    type Source = PoolSource;

    fn signature(&self) -> &CombatSignature {
        &self.signature
    }

    fn representative(&self) -> &Player {
        &self.representative
    }

    fn sources(&self) -> &[Self::Source] {
        &self.sources
    }
}

/// Solves a generated candidate pool while checkpointing after every round.
///
/// Closure is relative to `pool`; it does not cover candidates discarded by
/// upstream generation. Restricted equilibria are currently used even when
/// their iterative solver reaches its iteration limit, so round reports must
/// be inspected when equilibrium convergence is required.
pub fn solve_candidate_meta<F>(
    catalogs: &Catalogs,
    pool: &BuildCatalog,
    mut state: CandidateMetaState,
    options: &CandidateMetaOptions,
    mut checkpoint: F,
) -> Result<CandidateMetaState>
where
    F: FnMut(&CandidateMetaState) -> Result<()>,
{
    if pool.is_empty() || state.active_ids.is_empty() {
        bail!("candidate pool and initial archive must be non-empty");
    }
    let groups = pool_groups(catalogs, pool)?;
    let group_by_id = groups
        .iter()
        .enumerate()
        .flat_map(|(index, group)| group.sources.iter().map(move |source| (&source.id, index)))
        .collect::<HashMap<_, _>>();
    for id in &state.active_ids {
        if !pool.contains_key(id) {
            bail!("candidate pool is missing active strategy {id}");
        }
    }
    let mut approximate_cache = MatchupEvaluationCache::new(options.minimum_survival_probability);
    let mut exact_cache = MatchupEvaluationCache::new(0.0);
    for _ in 0..options.maximum_rounds {
        let round_started = Instant::now();
        if state.converged {
            break;
        }
        let active = state
            .active_ids
            .iter()
            .map(|id| (id.clone(), pool[id].clone()))
            .collect::<BuildCatalog>();
        let analysis = analyze_build_catalog(catalogs, &active)?;
        let mixture = prune_opponent_mixture(
            &analysis.inferred_meta.weights,
            options.opponent_pruning_tolerance,
        )?;
        let opponents = mixture
            .retained
            .iter()
            .map(|entry| {
                catalogs.materialize(
                    pool.get(&entry.candidate)
                        .with_context(|| format!("missing opponent {}", entry.candidate))?,
                    MatchupRole::Active,
                )
            })
            .collect::<Result<Vec<_>>>()?;
        let opponent_ids = mixture
            .retained
            .iter()
            .map(|entry| entry.candidate.clone())
            .collect::<Vec<_>>();
        let weights = mixture
            .retained
            .iter()
            .map(|entry| entry.weight)
            .collect::<Vec<_>>();
        let active_signatures = state
            .active_ids
            .iter()
            .map(|id| groups[group_by_id[id]].signature.clone())
            .collect::<HashSet<_>>();
        let candidates = groups
            .iter()
            .filter(|group| !active_signatures.contains(&group.signature))
            .cloned()
            .collect::<Vec<_>>();
        let approximate = candidate_frontiers_cached(
            &candidates,
            &opponents,
            &opponent_ids,
            Some(&weights),
            &mut approximate_cache,
        )?;
        let lower_bound = approximate
            .candidates
            .iter()
            .map(|candidate| candidate.weighted_score - candidate.weighted_score_error_bound)
            .fold(f64::NEG_INFINITY, f64::max);
        let finalist_signatures = approximate
            .candidates
            .iter()
            .filter(|candidate| {
                candidate.weighted_score + candidate.weighted_score_error_bound
                    >= lower_bound - 1e-12
            })
            .map(|candidate| candidate.signature.clone())
            .collect::<HashSet<_>>();
        let finalists = candidates
            .iter()
            .filter(|group| finalist_signatures.contains(&group.signature))
            .cloned()
            .collect::<Vec<_>>();
        let exact_result = candidate_frontiers_cached(
            &finalists,
            &opponents,
            &opponent_ids,
            Some(&weights),
            &mut exact_cache,
        )?;
        let mut exact_matchups = exact_result.evaluated_matchups;
        let mut exact_finalists = finalists.len();
        let mut exact = exact_result.candidates;
        exact.sort_by(|left, right| right.weighted_score.total_cmp(&left.weighted_score));
        let mut additions = exact
            .iter()
            .filter(|candidate| candidate.weighted_score > 0.5 + options.response_tolerance)
            .take(options.batch_size)
            .map(|candidate| candidate.sources[0].id.clone())
            .collect::<Vec<_>>();
        let mut best_response_score = exact
            .first()
            .map_or(0.5, |candidate| candidate.weighted_score);
        if additions.is_empty()
            && !pruned_score_proves_below(
                best_response_score,
                mixture.dropped_weight,
                0.5 + options.response_tolerance,
            )
        {
            let full_opponents = analysis
                .inferred_meta
                .weights
                .iter()
                .map(|entry| {
                    catalogs.materialize(
                        pool.get(&entry.candidate)
                            .with_context(|| format!("missing opponent {}", entry.candidate))?,
                        MatchupRole::Active,
                    )
                })
                .collect::<Result<Vec<_>>>()?;
            let full_ids = analysis
                .inferred_meta
                .weights
                .iter()
                .map(|entry| entry.candidate.clone())
                .collect::<Vec<_>>();
            let full_weights = analysis
                .inferred_meta
                .weights
                .iter()
                .map(|entry| entry.weight)
                .collect::<Vec<_>>();
            let full_result = candidate_frontiers_cached(
                &candidates,
                &full_opponents,
                &full_ids,
                Some(&full_weights),
                &mut exact_cache,
            )?;
            exact_matchups += full_result.evaluated_matchups;
            exact_finalists = candidates.len();
            exact = full_result.candidates;
            exact.sort_by(|left, right| right.weighted_score.total_cmp(&left.weighted_score));
            additions = exact
                .iter()
                .filter(|candidate| candidate.weighted_score > 0.5 + options.response_tolerance)
                .take(options.batch_size)
                .map(|candidate| candidate.sources[0].id.clone())
                .collect();
            best_response_score = exact
                .first()
                .map_or(0.5, |candidate| candidate.weighted_score);
        }
        state.active_ids.extend(additions.clone());
        state.converged = additions.is_empty();
        state.rounds.push(CandidateMetaRound {
            round: state.rounds.len() + 1,
            active_count_before: analysis.candidate_count,
            equilibrium: analysis.inferred_meta,
            opponent_mixture: mixture,
            pool_candidates: candidates.len(),
            approximate_matchups: approximate.evaluated_matchups,
            exact_finalists,
            exact_matchups,
            best_response_score,
            additions,
            converged: state.converged,
            elapsed_ms: round_started.elapsed().as_millis(),
        });
        checkpoint(&state)?;
    }
    Ok(state)
}

/// Selects one deterministic initial candidate from each generated weapon profile.
pub fn endogenous_initial_ids(pool: &BuildCatalog) -> Vec<String> {
    let mut prefixes = HashSet::new();
    pool.keys()
        .filter(|id| {
            let prefix = id.trim_end_matches(|character: char| character.is_ascii_digit());
            prefixes.insert(prefix.to_owned())
        })
        .take(6)
        .cloned()
        .collect()
}

fn pool_groups(catalogs: &Catalogs, pool: &BuildCatalog) -> Result<Vec<PoolGroup>> {
    let mut groups = Vec::<PoolGroup>::new();
    let mut by_signature = HashMap::<CombatSignature, usize>::new();
    for (id, build) in pool {
        let representative = catalogs.materialize(build, MatchupRole::Active)?;
        let signature = combat_signature(&representative);
        if let Some(index) = by_signature.get(&signature) {
            groups[*index].sources.push(PoolSource { id: id.clone() });
        } else {
            by_signature.insert(signature.clone(), groups.len());
            groups.push(PoolGroup {
                signature,
                representative,
                sources: vec![PoolSource { id: id.clone() }],
            });
        }
    }
    Ok(groups)
}
