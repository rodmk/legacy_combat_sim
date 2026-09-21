use std::collections::{HashMap, HashSet};

use anyhow::{bail, Context, Result};
use serde::Serialize;

use crate::analysis::{analyze_build_catalog, CatalogAnalysis, StrategyWeight};
use crate::catalog::{BuildCatalog, Catalogs};
use crate::combat::combat_signature;
use crate::model::{AttackType, BuildDefinition, CombatSignature, MatchupRole, Player};
use crate::search::{
    candidate_frontiers, equipment_concept_signature, joint_equipment_stat_response_beam,
    AdaptiveStatOptions, CandidateGroup, EquipmentNeighborhoodOptions, JointResponseEntry,
};

#[derive(Clone)]
struct ResponseGroup {
    signature: CombatSignature,
    representative: Player,
    sources: Vec<BuildDefinition>,
}

impl CandidateGroup for ResponseGroup {
    type Source = BuildDefinition;

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

/// A normalized opponent mixture with a bounded amount of discarded mass.
#[derive(Clone, Debug, Serialize)]
pub struct PrunedMixture {
    /// Retained and renormalized strategies.
    pub retained: Vec<StrategyWeight>,
    /// Strategies removed from the smallest weight upward.
    pub dropped: Vec<StrategyWeight>,
    /// Original probability mass removed.
    pub dropped_weight: f64,
    /// Maximum error induced in any score in `[0, 1]`.
    pub maximum_score_error: f64,
}

/// Removes the smallest equilibrium weights without exceeding a mass budget.
pub fn prune_opponent_mixture(
    entries: &[StrategyWeight],
    maximum_dropped_weight: f64,
) -> Result<PrunedMixture> {
    if !maximum_dropped_weight.is_finite() || !(0.0..1.0).contains(&maximum_dropped_weight) {
        bail!("opponent pruning tolerance must be at least zero and less than one");
    }
    let total = entries.iter().map(|entry| entry.weight).sum::<f64>();
    if entries.is_empty() || (total - 1.0).abs() > 1e-12 {
        bail!("opponent mixture weights must be nonempty and sum to one");
    }
    let mut retained = entries.to_vec();
    retained.sort_by(|left, right| left.weight.total_cmp(&right.weight));
    let mut dropped = Vec::new();
    let mut dropped_weight = 0.0;
    while retained.len() > 1
        && dropped_weight + retained[0].weight <= maximum_dropped_weight + 1e-12
    {
        let entry = retained.remove(0);
        dropped_weight += entry.weight;
        dropped.push(entry);
    }
    let retained_weight = 1.0 - dropped_weight;
    for entry in &mut retained {
        entry.weight /= retained_weight;
    }
    Ok(PrunedMixture {
        retained,
        dropped,
        dropped_weight,
        maximum_score_error: dropped_weight,
    })
}

/// Controls iterative restricted-meta closure.
#[derive(Clone, Debug)]
pub struct InferenceOptions {
    /// Maximum archive-expansion rounds.
    pub maximum_rounds: usize,
    /// Novel responses admitted per round.
    pub batch_size: usize,
    /// Score above 0.5 required for admission.
    pub improvement_tolerance: f64,
    /// Maximum equilibrium weight omitted during response search.
    pub opponent_pruning_tolerance: f64,
    /// Maximum distinct responses retained by the joint oracle.
    pub beam_width: usize,
    /// Seeds expanded by the joint oracle per pass.
    pub expansion_width: usize,
    /// Maximum alternating equipment/stat passes per oracle call.
    pub joint_maximum_iterations: usize,
    /// Equipment-neighborhood controls.
    pub equipment: EquipmentNeighborhoodOptions,
    /// Stat-refinement controls.
    pub stats: AdaptiveStatOptions,
}

impl Default for InferenceOptions {
    fn default() -> Self {
        Self {
            maximum_rounds: 16,
            batch_size: 2,
            improvement_tolerance: 1e-3,
            opponent_pruning_tolerance: 2.5e-4,
            beam_width: 8,
            expansion_width: 2,
            joint_maximum_iterations: 8,
            equipment: EquipmentNeighborhoodOptions::default(),
            stats: AdaptiveStatOptions::default(),
        }
    }
}

/// One response admitted to the strategy archive.
#[derive(Clone, Debug, Serialize)]
pub struct AdmittedResponse {
    /// Stable generated build key.
    pub id: String,
    /// Equipment concept identity.
    pub concept_signature: String,
    /// Exact score against the full pre-admission equilibrium.
    pub score_against_equilibrium: f64,
    /// Complete admitted build.
    pub build: BuildDefinition,
}

/// One restricted solve and response-expansion pass.
#[derive(Clone, Debug, Serialize)]
pub struct InferenceRound {
    /// One-based round number.
    pub round: usize,
    /// Archive size before response search.
    pub archive_size_before: usize,
    /// Archive size after admissions.
    pub archive_size_after: usize,
    /// Responses admitted this round.
    pub added: Vec<AdmittedResponse>,
    /// Equilibrium before admissions.
    pub equilibrium: crate::analysis::InferredMeta,
    /// Opponent-mixture pruning report.
    pub opponent_mixture: PrunedMixture,
    /// Distinct supported equipment concepts used to seed response search.
    pub response_seed_count: usize,
    /// Whether the joint oracle itself converged.
    pub response_converged: bool,
    /// Joint oracle termination reason.
    pub response_convergence_reason: String,
}

/// Final archive and round history from endogenous response closure.
#[derive(Clone, Debug, Serialize)]
pub struct InferenceResult {
    /// Expanded strategy catalog.
    pub catalog: BuildCatalog,
    /// Per-round admissions and equilibria.
    pub rounds: Vec<InferenceRound>,
    /// True when a full round admitted no novel profitable response.
    pub converged: bool,
    /// Exact analysis of the final archive.
    pub analysis: CatalogAnalysis,
}

/// Repeatedly solves the restricted game and admits novel profitable joint
/// equipment/stat responses until closure or the round limit.
pub fn endogenous_equipment_search(
    catalogs: &Catalogs,
    initial_catalog: &BuildCatalog,
    options: &InferenceOptions,
) -> Result<InferenceResult> {
    if options.maximum_rounds == 0 || options.batch_size == 0 {
        bail!("inference round and batch limits must be positive");
    }
    let mut catalog = initial_catalog.clone();
    let mut rounds = Vec::new();
    for round in 1..=options.maximum_rounds {
        let before = analyze_build_catalog(catalogs, &catalog)?;
        let mixture = prune_opponent_mixture(
            &before.inferred_meta.weights,
            options.opponent_pruning_tolerance,
        )?;
        let opponents = mixture
            .retained
            .iter()
            .map(|entry| {
                let build = catalog
                    .get(&entry.candidate)
                    .with_context(|| format!("equilibrium references {}", entry.candidate))?;
                catalogs.materialize(build, MatchupRole::Active)
            })
            .collect::<Result<Vec<_>>>()?;
        let opponent_ids = mixture
            .retained
            .iter()
            .map(|entry| entry.candidate.clone())
            .collect::<Vec<_>>();
        let opponent_weights = mixture
            .retained
            .iter()
            .map(|entry| entry.weight)
            .collect::<Vec<_>>();
        let starting_ids = equilibrium_seed_ids(&catalog, &before.inferred_meta.weights)?;
        let response_seed_count = starting_ids.len();
        let mut response_by_signature = HashMap::<CombatSignature, JointResponseEntry>::new();
        let mut response_converged = true;
        let mut response_reasons = Vec::with_capacity(starting_ids.len());
        for starting_id in starting_ids {
            let response = joint_equipment_stat_response_beam(
                catalogs,
                &catalog[&starting_id],
                &opponents,
                &opponent_ids,
                Some(&opponent_weights),
                &[
                    AttackType::Normal,
                    AttackType::Quick,
                    AttackType::Aimed,
                    AttackType::Cover,
                ],
                &options.equipment,
                &options.stats,
                options.stats.minimum_survival_probability,
                options.beam_width,
                options.expansion_width,
                options.joint_maximum_iterations,
                options.improvement_tolerance,
            )?;
            response_converged &= response.converged;
            response_reasons.push(response.convergence_reason);
            for entry in response.beam {
                if response_by_signature
                    .get(&entry.signature)
                    .is_none_or(|existing| entry.weighted_score > existing.weighted_score)
                {
                    response_by_signature.insert(entry.signature.clone(), entry);
                }
            }
        }
        let mut response_beam = response_by_signature.into_values().collect::<Vec<_>>();
        response_reasons.sort_unstable();
        response_reasons.dedup();
        let response_convergence_reason = response_reasons.join(",");
        let full_opponents = before
            .inferred_meta
            .weights
            .iter()
            .map(|entry| catalogs.materialize(&catalog[&entry.candidate], MatchupRole::Active))
            .collect::<Result<Vec<_>>>()?;
        let full_ids = before
            .inferred_meta
            .weights
            .iter()
            .map(|entry| entry.candidate.clone())
            .collect::<Vec<_>>();
        let full_weights = before
            .inferred_meta
            .weights
            .iter()
            .map(|entry| entry.weight)
            .collect::<Vec<_>>();
        let response_groups = response_beam
            .iter()
            .map(|entry| {
                Ok(ResponseGroup {
                    signature: entry.signature.clone(),
                    representative: catalogs.materialize(&entry.build, MatchupRole::Active)?,
                    sources: vec![entry.build.clone()],
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let validation = candidate_frontiers(
            &response_groups,
            &full_opponents,
            &full_ids,
            Some(&full_weights),
            0.0,
        )?;
        for entry in &mut response_beam {
            entry.weighted_score = validation
                .candidates
                .iter()
                .find(|candidate| candidate.signature == entry.signature)
                .context("validated response signature is missing")?
                .weighted_score;
        }
        response_beam.sort_by(|left, right| right.weighted_score.total_cmp(&left.weighted_score));
        let archived = catalog
            .values()
            .map(|build| {
                catalogs
                    .materialize(build, MatchupRole::Active)
                    .map(|player| combat_signature(&player))
            })
            .collect::<Result<HashSet<_>>>()?;
        let profitable = response_beam
            .iter()
            .filter(|entry| {
                entry.weighted_score > 0.5 + options.improvement_tolerance
                    && !archived.contains(&entry.signature)
            })
            .take(options.batch_size)
            .cloned()
            .collect::<Vec<_>>();
        let archive_size_before = catalog.len();
        let mut added = Vec::new();
        for entry in profitable {
            let id = format!("EndogenousResponse{}", catalog.len());
            let mut build = entry.build;
            build.name = format!("Endogenous Response {}", catalog.len());
            build.reference = Some(false);
            catalog.insert(id.clone(), build.clone());
            added.push(AdmittedResponse {
                id,
                concept_signature: entry.concept_signature,
                score_against_equilibrium: entry.weighted_score,
                build,
            });
        }
        let no_admission = added.is_empty();
        rounds.push(InferenceRound {
            round,
            archive_size_before,
            archive_size_after: catalog.len(),
            added,
            equilibrium: before.inferred_meta,
            opponent_mixture: mixture,
            response_seed_count,
            response_converged,
            response_convergence_reason,
        });
        if no_admission {
            let analysis = analyze_build_catalog(catalogs, &catalog)?;
            return Ok(InferenceResult {
                catalog,
                rounds,
                converged: response_converged,
                analysis,
            });
        }
    }
    let analysis = analyze_build_catalog(catalogs, &catalog)?;
    Ok(InferenceResult {
        catalog,
        rounds,
        converged: false,
        analysis,
    })
}

fn equilibrium_seed_ids(catalog: &BuildCatalog, weights: &[StrategyWeight]) -> Result<Vec<String>> {
    let mut concepts = HashSet::new();
    let mut seeds = Vec::new();
    for entry in weights.iter().filter(|entry| entry.weight > 0.0) {
        let build = catalog
            .get(&entry.candidate)
            .with_context(|| format!("equilibrium references {}", entry.candidate))?;
        if concepts.insert(equipment_concept_signature(build)) {
            seeds.push(entry.candidate.clone());
        }
    }
    if seeds.is_empty() {
        bail!("equilibrium has no support");
    }
    Ok(seeds)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};

    use crate::search::EquipmentSlot;

    #[test]
    fn mixture_pruning_matches_mass_budget() {
        let entries = vec![
            StrategyWeight {
                candidate: "large".to_owned(),
                weight: 0.8,
            },
            StrategyWeight {
                candidate: "small".to_owned(),
                weight: 0.2,
            },
        ];
        let result = prune_opponent_mixture(&entries, 0.2).unwrap();
        assert_eq!(result.dropped[0].candidate, "small");
        assert_eq!(result.retained[0].candidate, "large");
        assert!((result.retained[0].weight - 1.0).abs() <= 1e-12);
    }

    #[test]
    fn response_seeds_cover_supported_equipment_concepts() {
        let catalogs = Catalogs::bundled().unwrap();
        let first = catalogs.build("ShadowDojoDLGunBuild2").unwrap().clone();
        let mut equivalent = first.clone();
        equivalent.attack_type = AttackType::Quick;
        let distinct = catalogs.build("ShadowDojoArmorStackCores").unwrap().clone();
        let catalog = BuildCatalog::from([
            ("first".to_owned(), first),
            ("equivalent".to_owned(), equivalent),
            ("distinct".to_owned(), distinct),
        ]);
        let weights = vec![
            StrategyWeight {
                candidate: "first".to_owned(),
                weight: 0.5,
            },
            StrategyWeight {
                candidate: "equivalent".to_owned(),
                weight: 0.25,
            },
            StrategyWeight {
                candidate: "distinct".to_owned(),
                weight: 0.25,
            },
        ];
        assert_eq!(
            equilibrium_seed_ids(&catalog, &weights).unwrap(),
            ["first", "distinct"]
        );
    }

    #[test]
    fn closed_single_build_archive_terminates() {
        let catalogs = Catalogs::bundled().unwrap();
        let seed = catalogs.build("ShadowDojoDLGunBuild2").unwrap().clone();
        let catalog = BuildCatalog::from([("seed".to_owned(), seed.clone())]);
        let mut options = InferenceOptions {
            maximum_rounds: 1,
            batch_size: 1,
            improvement_tolerance: 1.0,
            beam_width: 1,
            expansion_width: 1,
            joint_maximum_iterations: 1,
            equipment: EquipmentNeighborhoodOptions {
                slots: vec![EquipmentSlot::Weapon1],
                item_keys_by_slot: HashMap::from([(
                    EquipmentSlot::Weapon1,
                    vec![seed.equipment.weapon1.item.clone()],
                )]),
                crystal_keys: Some(Vec::new()),
                socket_capacity: 0,
                ..EquipmentNeighborhoodOptions::default()
            },
            stats: AdaptiveStatOptions {
                point_strides: vec![32],
                hp_points: Some(HashSet::from([seed.stats.hp])),
                converge: false,
                ..AdaptiveStatOptions::default()
            },
            ..InferenceOptions::default()
        };
        let incomplete = endogenous_equipment_search(&catalogs, &catalog, &options).unwrap();
        assert!(!incomplete.converged);
        options.joint_maximum_iterations = 2;
        let result = endogenous_equipment_search(&catalogs, &catalog, &options).unwrap();
        assert!(result.converged);
        assert_eq!(result.catalog.len(), 1);
        assert!(result.rounds[0].added.is_empty());
    }
}
