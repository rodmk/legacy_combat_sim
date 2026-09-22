use std::collections::{HashMap, HashSet};
use std::time::Instant;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::analysis::{analyze_build_catalog, InferredMeta};
use crate::catalog::{BuildCatalog, Catalogs};
use crate::combat::combat_signature;
use crate::inference::{
    prune_opponent_mixture, pruned_score_proves_below, search_response_seeds, InferenceOptions,
    PrunedMixture,
};
use crate::model::{BuildDefinition, CombatSignature, MatchupRole};
use crate::regions::{select_diverse_leaders, CandidateGenerationResult};
use crate::search::{equipment_concept_signature, JointEquipmentStatResponse};

/// One globally distributed equipment seed.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct GlobalSeed {
    /// Stable seed identifier.
    pub id: String,
    /// Weapon-family profile that produced the seed.
    pub profile: String,
    /// Configured proxy score used to rank the seed.
    pub proxy_score: f64,
    /// Complete configured seed build.
    pub build: BuildDefinition,
}

/// Controls one global challenger screen and confirmation pass.
#[derive(Clone, Debug)]
pub struct GlobalChallengeOptions {
    /// Diverse equipment leaders selected per weapon profile.
    pub leaders_per_profile: usize,
    /// Screening score required for confirmation.
    pub screening_promotion_score: f64,
    /// Confirmed score required for admission.
    pub admission_score: f64,
    /// Novel equipment concepts admitted per cycle.
    pub batch_size: usize,
    /// Response-search controls shared with configuration closure.
    pub inference: InferenceOptions,
}

impl Default for GlobalChallengeOptions {
    fn default() -> Self {
        let inference = InferenceOptions {
            beam_width: 4,
            expansion_width: 1,
            joint_maximum_iterations: 16,
            screening_iterations: Some(1),
            screening_promotion_score: 0.505,
            admission_score: 0.51,
            equipment: crate::search::EquipmentNeighborhoodOptions {
                fixed_equipment: true,
                ..crate::search::EquipmentNeighborhoodOptions::default()
            },
            ..InferenceOptions::default()
        };
        Self {
            leaders_per_profile: 3,
            screening_promotion_score: 0.505,
            admission_score: 0.51,
            batch_size: 2,
            inference,
        }
    }
}

/// Compact result for one searched global seed.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct GlobalSeedResult {
    /// Seed identifier.
    pub seed: String,
    /// Strongest response score returned by the oracle.
    pub best_score: Option<f64>,
    /// Whether the joint oracle converged.
    pub converged: bool,
    /// Joint oracle termination reason.
    pub convergence_reason: String,
}

/// Durable result of the global screening phase.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct GlobalScreeningCheckpoint {
    /// Seeds promoted to full confirmation.
    pub promoted: Vec<GlobalSeed>,
    /// Per-seed screening summaries.
    pub screening: Vec<GlobalSeedResult>,
}

/// One admitted globally discovered response.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct GlobalAdmission {
    /// Stable generated challenger identifier.
    pub id: String,
    /// Exact response score against the retained equilibrium mixture.
    pub score: f64,
    /// Source global seed.
    pub seed: String,
    /// Complete challenger build.
    pub build: BuildDefinition,
}

/// Result of one global challenger cycle.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct GlobalChallengeResult {
    /// Equilibrium before global response search.
    pub equilibrium: InferredMeta,
    /// Pruned mixture searched by the response oracle.
    pub opponent_mixture: PrunedMixture,
    /// Number of globally distributed seeds screened.
    pub seed_count: usize,
    /// Number of seeds promoted to confirmation.
    pub promoted_seed_count: usize,
    /// Number of seeds run through full confirmation.
    #[serde(default)]
    pub confirmed_seed_count: usize,
    /// Per-seed screening summaries.
    pub screening: Vec<GlobalSeedResult>,
    /// Per-seed confirmation summaries.
    pub confirmation: Vec<GlobalSeedResult>,
    /// Responses admitted for configuration closure.
    pub admitted: Vec<GlobalAdmission>,
    /// Build catalog containing the admitted challengers.
    pub challenger_catalog: BuildCatalog,
    /// Whether no confirmed response from the selected seed set exceeded the
    /// admission threshold. This is not exhaustive closure over every legal or
    /// generated equipment signature.
    pub globally_closed: bool,
    /// Wall-clock duration of screening and confirmation.
    #[serde(default)]
    pub elapsed_ms: u128,
}

/// Converts configured region finalists into weapon-diverse global seeds.
///
/// Only `leaders_per_profile` local-search starting points are retained per
/// weapon profile. Other configured finalists and local response basins are
/// not covered by a successful challenge result.
pub fn global_seeds(
    generation: &CandidateGenerationResult,
    leaders_per_profile: usize,
) -> Vec<GlobalSeed> {
    let mut seeds = Vec::new();
    let mut equipment = HashSet::new();
    for profile in &generation.profiles {
        for (index, candidate) in select_diverse_leaders(&profile.finalists, leaders_per_profile)
            .into_iter()
            .enumerate()
        {
            if equipment.insert(equipment_concept_signature(&candidate.build)) {
                seeds.push(GlobalSeed {
                    id: format!(
                        "Global{}{:02}",
                        profile
                            .profile
                            .split('+')
                            .map(title_case)
                            .collect::<String>(),
                        index + 1
                    ),
                    profile: profile.profile.clone(),
                    proxy_score: candidate.score,
                    build: candidate.build,
                });
            }
        }
    }
    seeds
}

/// Screens and confirms globally distributed response seeds.
///
/// Closure applies only to `seeds`. The restricted equilibrium is consumed
/// even when its iterative solver reports that it exhausted its iteration
/// limit, so callers requiring a stronger certificate must inspect
/// `result.equilibrium.converged`.
pub fn run_global_challenge<F>(
    catalogs: &Catalogs,
    catalog: &BuildCatalog,
    seeds: &[GlobalSeed],
    checkpoint: Option<GlobalScreeningCheckpoint>,
    options: &GlobalChallengeOptions,
    mut screened: F,
) -> Result<GlobalChallengeResult>
where
    F: FnMut(&GlobalScreeningCheckpoint) -> Result<()>,
{
    let started = Instant::now();
    let analysis = analyze_build_catalog(catalogs, catalog)?;
    let mixture = prune_opponent_mixture(
        &analysis.inferred_meta.weights,
        options.inference.opponent_pruning_tolerance,
    )?;
    let opponents = mixture
        .retained
        .iter()
        .map(|entry| {
            catalogs.materialize(
                catalog
                    .get(&entry.candidate)
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
    let checkpoint = if let Some(checkpoint) = checkpoint {
        checkpoint
    } else {
        let responses = search_response_seeds(
            catalogs,
            &seeds
                .iter()
                .map(|seed| seed.build.clone())
                .collect::<Vec<_>>(),
            &opponents,
            &opponent_ids,
            &weights,
            &options.inference,
            options.inference.screening_iterations.unwrap_or(1),
        )?;
        let promoted = seeds
            .iter()
            .zip(&responses)
            .filter(|(_, response)| {
                best_score(response).is_some_and(|score| score > options.screening_promotion_score)
            })
            .map(|(seed, _)| seed.clone())
            .collect::<Vec<_>>();
        let checkpoint = GlobalScreeningCheckpoint {
            promoted,
            screening: summaries(seeds, &responses),
        };
        screened(&checkpoint)?;
        checkpoint
    };
    let screening = checkpoint.screening;
    let promoted_seed_count = checkpoint.promoted.len();
    let mut confirmed = checkpoint.promoted;
    let mut confirmation_responses = search_response_seeds(
        catalogs,
        &confirmed
            .iter()
            .map(|seed| seed.build.clone())
            .collect::<Vec<_>>(),
        &opponents,
        &opponent_ids,
        &weights,
        &options.inference,
        options.inference.joint_maximum_iterations,
    )?;
    let active = catalog
        .values()
        .map(|build| {
            catalogs
                .materialize(build, MatchupRole::Active)
                .map(|player| combat_signature(&player))
        })
        .collect::<Result<HashSet<_>>>()?;
    let next_index = next_challenge_index(catalog);
    let mut admitted = rank_admissions(
        &confirmed,
        &confirmation_responses,
        &active,
        options,
        next_index,
    );
    if admitted.is_empty() && confirmed.len() < seeds.len() {
        let promoted_ids = confirmed
            .iter()
            .map(|seed| seed.id.as_str())
            .collect::<HashSet<_>>();
        let fallback = seeds
            .iter()
            .filter(|seed| !promoted_ids.contains(seed.id.as_str()))
            .cloned()
            .collect::<Vec<_>>();
        confirmation_responses.extend(search_response_seeds(
            catalogs,
            &fallback
                .iter()
                .map(|seed| seed.build.clone())
                .collect::<Vec<_>>(),
            &opponents,
            &opponent_ids,
            &weights,
            &options.inference,
            options.inference.joint_maximum_iterations,
        )?);
        confirmed.extend(fallback);
        admitted = rank_admissions(
            &confirmed,
            &confirmation_responses,
            &active,
            options,
            next_index,
        );
    }
    let confirmations_converged = confirmation_responses
        .iter()
        .all(|response| response.converged);
    let all_seeds_confirmed = confirmed.len() == seeds.len();
    let pruning_proves_closure = confirmation_responses.iter().all(|response| {
        best_score(response).is_some_and(|score| {
            pruned_score_proves_below(score, mixture.dropped_weight, options.admission_score)
        })
    });
    if admitted.is_empty()
        && all_seeds_confirmed
        && confirmations_converged
        && !pruning_proves_closure
    {
        let full_opponents = analysis
            .inferred_meta
            .weights
            .iter()
            .map(|entry| {
                catalogs.materialize(
                    catalog
                        .get(&entry.candidate)
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
        confirmation_responses = search_response_seeds(
            catalogs,
            &confirmed
                .iter()
                .map(|seed| seed.build.clone())
                .collect::<Vec<_>>(),
            &full_opponents,
            &full_ids,
            &full_weights,
            &options.inference,
            options.inference.joint_maximum_iterations,
        )?;
        admitted = rank_admissions(
            &confirmed,
            &confirmation_responses,
            &active,
            options,
            next_index,
        );
    }
    let challenger_catalog = admitted
        .iter()
        .map(|entry| (entry.id.clone(), entry.build.clone()))
        .collect();
    let confirmations_converged = confirmation_responses
        .iter()
        .all(|response| response.converged);
    let all_seeds_confirmed = confirmed.len() == seeds.len();
    Ok(GlobalChallengeResult {
        equilibrium: analysis.inferred_meta,
        opponent_mixture: mixture,
        seed_count: seeds.len(),
        promoted_seed_count,
        confirmed_seed_count: confirmed.len(),
        screening,
        confirmation: summaries(&confirmed, &confirmation_responses),
        globally_closed: admitted.is_empty() && all_seeds_confirmed && confirmations_converged,
        elapsed_ms: started.elapsed().as_millis(),
        admitted,
        challenger_catalog,
    })
}

fn rank_admissions(
    seeds: &[GlobalSeed],
    results: &[JointEquipmentStatResponse],
    active: &HashSet<CombatSignature>,
    options: &GlobalChallengeOptions,
    next_index: usize,
) -> Vec<GlobalAdmission> {
    let mut responses =
        HashMap::<CombatSignature, (&GlobalSeed, &crate::search::JointResponseEntry)>::new();
    for (seed, result) in seeds.iter().zip(results) {
        for response in &result.beam {
            if active.contains(&response.signature) {
                continue;
            }
            responses
                .entry(response.signature.clone())
                .and_modify(|current| {
                    if response.weighted_score > current.1.weighted_score {
                        *current = (seed, response);
                    }
                })
                .or_insert((seed, response));
        }
    }
    let mut ranked = responses.into_values().collect::<Vec<_>>();
    ranked.sort_by(|left, right| right.1.weighted_score.total_cmp(&left.1.weighted_score));
    let mut concepts = HashSet::new();
    let mut admitted = Vec::new();
    for (seed, response) in ranked {
        if response.weighted_score <= options.admission_score
            || !concepts.insert(response.concept_signature.clone())
        {
            continue;
        }
        let id = format!("GlobalChallenge{:03}", next_index + admitted.len());
        let mut build = response.build.clone();
        build.name = id.clone();
        build.reference = Some(false);
        admitted.push(GlobalAdmission {
            id,
            score: response.weighted_score,
            seed: seed.id.clone(),
            build,
        });
        if admitted.len() == options.batch_size {
            break;
        }
    }
    admitted
}

fn summaries(
    seeds: &[GlobalSeed],
    responses: &[JointEquipmentStatResponse],
) -> Vec<GlobalSeedResult> {
    seeds
        .iter()
        .zip(responses)
        .map(|(seed, response)| GlobalSeedResult {
            seed: seed.id.clone(),
            best_score: best_score(response),
            converged: response.converged,
            convergence_reason: response.convergence_reason.to_owned(),
        })
        .collect()
}

fn best_score(response: &JointEquipmentStatResponse) -> Option<f64> {
    response.beam.first().map(|entry| entry.weighted_score)
}

fn next_challenge_index(catalog: &BuildCatalog) -> usize {
    catalog
        .keys()
        .filter_map(|id| id.strip_prefix("GlobalChallenge")?.parse::<usize>().ok())
        .max()
        .unwrap_or(0)
        + 1
}

fn title_case(value: &str) -> String {
    let mut characters = value.chars();
    characters
        .next()
        .map(char::to_uppercase)
        .into_iter()
        .flatten()
        .chain(characters)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::Catalogs;
    use crate::regions::{CandidateProfileReport, ConfiguredCandidate};

    #[test]
    fn global_seed_selection_covers_every_weapon_profile() {
        let catalogs = Catalogs::bundled().unwrap();
        let base = catalogs.build("EntryLevelCrystalSwords").unwrap();
        let profiles = (0..6)
            .map(|profile| {
                let finalists = (0..4)
                    .map(|rank| {
                        let mut build = base.clone();
                        build.equipment.weapon1.item = format!("Weapon{profile}-{rank}");
                        build.equipment.weapon2.item = format!("Pair{profile}-{rank}");
                        ConfiguredCandidate {
                            score: 1.0 - f64::from(rank) / 10.0,
                            build,
                        }
                    })
                    .collect();
                CandidateProfileReport {
                    profile: format!("type{profile}+type{profile}"),
                    signatures: 4,
                    envelope_shortlist: 4,
                    configured_signatures: 4,
                    builds: 16,
                    finalists,
                }
            })
            .collect();
        let generation = CandidateGenerationResult {
            catalog: BuildCatalog::new(),
            profiles,
            signature_count: 24,
        };
        let seeds = global_seeds(&generation, 3);
        assert_eq!(seeds.len(), 18);
        assert!(seeds.iter().all(|seed| seed.id.starts_with("GlobalType")));
    }
}
