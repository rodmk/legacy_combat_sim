use std::collections::{HashMap, HashSet};
use std::time::Instant;

use anyhow::{bail, Context, Result};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::analysis::{analyze_build_catalog, CatalogAnalysis, StrategyWeight};
use crate::catalog::{BuildCatalog, Catalogs};
use crate::combat::combat_signature;
use crate::model::{
    AttackType, BuildDefinition, CombatSignature, ItemSelection, MatchupRole, Player, WeaponType,
};
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
#[derive(Clone, Debug, Deserialize, Serialize)]
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

/// Returns whether a score against a renormalized pruned mixture proves that
/// the corresponding full-mixture score cannot exceed `threshold`.
pub fn pruned_score_proves_below(pruned_score: f64, dropped_weight: f64, threshold: f64) -> bool {
    (1.0 - dropped_weight) * pruned_score + dropped_weight <= threshold
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
    /// Optional cheap response-search iterations run before full confirmation.
    pub screening_iterations: Option<usize>,
    /// Minimum screening score required for full confirmation.
    pub screening_promotion_score: f64,
    /// Minimum confirmed score required for admission.
    pub admission_score: f64,
    /// Tail threshold used for the equipment-screening pass.
    pub equipment_screening_minimum_survival_probability: f64,
    /// Diversified weapon-pair seeds screened globally per round; zero disables
    /// global discovery.
    pub global_seed_count: usize,
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
            opponent_pruning_tolerance: 5e-3,
            beam_width: 8,
            expansion_width: 2,
            joint_maximum_iterations: 8,
            screening_iterations: None,
            screening_promotion_score: 0.505,
            admission_score: 0.501,
            equipment_screening_minimum_survival_probability: 0.1,
            global_seed_count: 0,
            equipment: EquipmentNeighborhoodOptions::default(),
            stats: AdaptiveStatOptions {
                minimum_survival_probability: 0.01,
                ..AdaptiveStatOptions::default()
            },
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
    /// Screening seeds promoted to full confirmation.
    pub promoted_seed_count: usize,
    /// Strongest response score from the mixture used for final closure.
    #[serde(default)]
    pub best_response_score: f64,
    /// Whether an ambiguous pruning bound required a full-mixture oracle pass.
    #[serde(default)]
    pub full_mixture_validation: bool,
    /// Whether the joint oracle itself converged.
    pub response_converged: bool,
    /// Joint oracle termination reason.
    pub response_convergence_reason: String,
    /// Wall-clock duration of the round.
    pub elapsed_ms: u128,
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

/// Runs the joint response oracle independently from each supplied seed.
pub fn search_response_seeds(
    catalogs: &Catalogs,
    seeds: &[BuildDefinition],
    opponents: &[Player],
    opponent_ids: &[String],
    opponent_weights: &[f64],
    options: &InferenceOptions,
    maximum_iterations: usize,
) -> Result<Vec<crate::search::JointEquipmentStatResponse>> {
    seeds
        .par_iter()
        .map(|seed| {
            joint_equipment_stat_response_beam(
                catalogs,
                seed,
                opponents,
                opponent_ids,
                Some(opponent_weights),
                &[
                    AttackType::Normal,
                    AttackType::Quick,
                    AttackType::Aimed,
                    AttackType::Cover,
                ],
                &options.equipment,
                &options.stats,
                options.equipment_screening_minimum_survival_probability,
                options.beam_width,
                options.expansion_width,
                maximum_iterations,
                options.improvement_tolerance,
            )
        })
        .collect()
}

/// Repeatedly solves the restricted game and admits novel profitable joint
/// equipment/stat responses until closure or the round limit.
pub fn endogenous_equipment_search(
    catalogs: &Catalogs,
    initial_catalog: &BuildCatalog,
    options: &InferenceOptions,
) -> Result<InferenceResult> {
    endogenous_equipment_search_with_screening(catalogs, initial_catalog, options, None, |_, _| {
        Ok(())
    })
}

/// Runs endogenous closure with an optional completed screening phase and a
/// callback that can persist newly promoted seeds before confirmation.
///
/// This is a local response search from supported equipment concepts rather
/// than exhaustive enumeration of every legal build. Restricted equilibria
/// are currently used even when their iterative solver reaches its iteration
/// limit, so `InferenceResult::converged` alone is not a complete equilibrium
/// convergence certificate.
pub fn endogenous_equipment_search_with_screening<F>(
    catalogs: &Catalogs,
    initial_catalog: &BuildCatalog,
    options: &InferenceOptions,
    mut promoted_seeds: Option<Vec<BuildDefinition>>,
    mut screened: F,
) -> Result<InferenceResult>
where
    F: FnMut(usize, &[BuildDefinition]) -> Result<()>,
{
    if options.maximum_rounds == 0 || options.batch_size == 0 {
        bail!("inference round and batch limits must be positive");
    }
    let mut catalog = initial_catalog.clone();
    let mut rounds = Vec::new();
    for round in 1..=options.maximum_rounds {
        let round_started = Instant::now();
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
        let mut starting_builds = starting_ids
            .iter()
            .map(|id| catalog[id].clone())
            .collect::<Vec<_>>();
        if options.global_seed_count > 0 {
            let baseline = &starting_builds[0];
            let global = global_weapon_seeds(
                catalogs,
                baseline,
                &opponents,
                &opponent_ids,
                &opponent_weights,
                options.global_seed_count,
            )?;
            let mut concepts = starting_builds
                .iter()
                .map(equipment_concept_signature)
                .collect::<HashSet<_>>();
            starting_builds.extend(
                global
                    .into_iter()
                    .filter(|build| concepts.insert(equipment_concept_signature(build))),
            );
        }
        let response_seed_count = starting_builds.len();
        let archived = catalog
            .values()
            .map(|build| {
                catalogs
                    .materialize(build, MatchupRole::Active)
                    .map(|player| combat_signature(&player))
            })
            .collect::<Result<HashSet<_>>>()?;
        let (mut responses, promoted_seed_count, fallback_seeds) = if let Some(promoted) =
            promoted_seeds.take()
        {
            let count = promoted.len();
            let promoted_concepts = promoted
                .iter()
                .map(equipment_concept_signature)
                .collect::<HashSet<_>>();
            let fallback = starting_builds
                .iter()
                .filter(|build| !promoted_concepts.contains(&equipment_concept_signature(build)))
                .cloned()
                .collect();
            (
                search_response_seeds(
                    catalogs,
                    &promoted,
                    &opponents,
                    &opponent_ids,
                    &opponent_weights,
                    options,
                    options.joint_maximum_iterations,
                )?,
                count,
                fallback,
            )
        } else if let Some(screening_iterations) = options.screening_iterations {
            let screening = search_response_seeds(
                catalogs,
                &starting_builds,
                &opponents,
                &opponent_ids,
                &opponent_weights,
                options,
                screening_iterations,
            )?;
            let promoted = starting_builds
                .iter()
                .cloned()
                .zip(screening)
                .filter(|(_, response)| {
                    response
                        .beam
                        .iter()
                        .any(|entry| entry.weighted_score > options.screening_promotion_score)
                })
                .map(|(build, _)| build)
                .collect::<Vec<_>>();
            screened(round, &promoted)?;
            let count = promoted.len();
            let promoted_concepts = promoted
                .iter()
                .map(equipment_concept_signature)
                .collect::<HashSet<_>>();
            let fallback = starting_builds
                .iter()
                .filter(|build| !promoted_concepts.contains(&equipment_concept_signature(build)))
                .cloned()
                .collect();
            (
                search_response_seeds(
                    catalogs,
                    &promoted,
                    &opponents,
                    &opponent_ids,
                    &opponent_weights,
                    options,
                    options.joint_maximum_iterations,
                )?,
                count,
                fallback,
            )
        } else {
            (
                search_response_seeds(
                    catalogs,
                    &starting_builds,
                    &opponents,
                    &opponent_ids,
                    &opponent_weights,
                    options,
                    options.joint_maximum_iterations,
                )?,
                response_seed_count,
                Vec::new(),
            )
        };
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
        let mut response_beam = validated_response_beam(
            catalogs,
            &responses,
            &full_opponents,
            &full_ids,
            &full_weights,
        )?;
        let mut profitable = response_beam
            .iter()
            .filter(|entry| {
                entry.weighted_score > options.admission_score
                    && !archived.contains(&entry.signature)
            })
            .take(options.batch_size)
            .cloned()
            .collect::<Vec<_>>();
        if profitable.is_empty() && !fallback_seeds.is_empty() {
            responses.extend(search_response_seeds(
                catalogs,
                &fallback_seeds,
                &opponents,
                &opponent_ids,
                &opponent_weights,
                options,
                options.joint_maximum_iterations,
            )?);
            response_beam = validated_response_beam(
                catalogs,
                &responses,
                &full_opponents,
                &full_ids,
                &full_weights,
            )?;
            profitable = response_beam
                .iter()
                .filter(|entry| {
                    entry.weighted_score > options.admission_score
                        && !archived.contains(&entry.signature)
                })
                .take(options.batch_size)
                .cloned()
                .collect();
        }
        let mut best_response_score = responses
            .iter()
            .flat_map(|response| &response.beam)
            .map(|entry| entry.weighted_score)
            .max_by(f64::total_cmp)
            .unwrap_or(0.5);
        let mut full_mixture_validation = false;
        if profitable.is_empty()
            && responses.iter().all(|response| response.converged)
            && !pruned_score_proves_below(
                best_response_score,
                mixture.dropped_weight,
                options.admission_score,
            )
        {
            responses = search_response_seeds(
                catalogs,
                &starting_builds,
                &full_opponents,
                &full_ids,
                &full_weights,
                options,
                options.joint_maximum_iterations,
            )?;
            response_beam = validated_response_beam(
                catalogs,
                &responses,
                &full_opponents,
                &full_ids,
                &full_weights,
            )?;
            profitable = response_beam
                .iter()
                .filter(|entry| {
                    entry.weighted_score > options.admission_score
                        && !archived.contains(&entry.signature)
                })
                .take(options.batch_size)
                .cloned()
                .collect();
            best_response_score = responses
                .iter()
                .flat_map(|response| &response.beam)
                .map(|entry| entry.weighted_score)
                .max_by(f64::total_cmp)
                .unwrap_or(0.5);
            full_mixture_validation = true;
        }
        let response_converged = responses.iter().all(|response| response.converged);
        let mut response_reasons = responses
            .iter()
            .map(|response| response.convergence_reason)
            .collect::<Vec<_>>();
        response_reasons.sort_unstable();
        response_reasons.dedup();
        let response_convergence_reason = response_reasons.join(",");
        let archive_size_before = catalog.len();
        let mut added = Vec::new();
        let configuration_index = catalog
            .keys()
            .filter_map(|id| {
                id.strip_prefix("ConfigurationResponse")?
                    .parse::<usize>()
                    .ok()
            })
            .max()
            .unwrap_or(0)
            + 1;
        for (index, entry) in profitable.into_iter().enumerate() {
            let id = if options.equipment.fixed_equipment {
                format!("ConfigurationResponse{:03}", configuration_index + index)
            } else {
                format!("EndogenousResponse{}", catalog.len())
            };
            let mut build = entry.build;
            build.name = id.clone();
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
            promoted_seed_count,
            best_response_score,
            full_mixture_validation,
            response_converged,
            response_convergence_reason,
            elapsed_ms: round_started.elapsed().as_millis(),
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

fn validated_response_beam(
    catalogs: &Catalogs,
    responses: &[crate::search::JointEquipmentStatResponse],
    opponents: &[Player],
    opponent_ids: &[String],
    opponent_weights: &[f64],
) -> Result<Vec<JointResponseEntry>> {
    let mut by_signature = HashMap::<CombatSignature, JointResponseEntry>::new();
    for response in responses {
        for entry in &response.beam {
            if by_signature
                .get(&entry.signature)
                .is_none_or(|existing| entry.weighted_score > existing.weighted_score)
            {
                by_signature.insert(entry.signature.clone(), entry.clone());
            }
        }
    }
    let mut beam = by_signature.into_values().collect::<Vec<_>>();
    let groups = beam
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
        &groups,
        opponents,
        opponent_ids,
        Some(opponent_weights),
        0.0,
    )?;
    for entry in &mut beam {
        entry.weighted_score = validation
            .candidates
            .iter()
            .find(|candidate| candidate.signature == entry.signature)
            .context("validated response signature is missing")?
            .weighted_score;
    }
    beam.sort_by(|left, right| right.weighted_score.total_cmp(&left.weighted_score));
    Ok(beam)
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

fn global_weapon_seeds(
    catalogs: &Catalogs,
    baseline: &BuildDefinition,
    opponents: &[Player],
    opponent_ids: &[String],
    opponent_weights: &[f64],
    limit: usize,
) -> Result<Vec<BuildDefinition>> {
    let weapon_keys = catalogs.item_keys("weapons")?;
    let mut groups = Vec::<ResponseGroup>::new();
    let mut group_by_signature = HashMap::<CombatSignature, usize>::new();
    for (left_index, left) in weapon_keys.iter().enumerate() {
        for right in &weapon_keys[left_index..] {
            let mut build = baseline.clone();
            build.equipment.weapon1 = ItemSelection {
                item: (*left).to_owned(),
                crystals: Vec::new(),
                mods: Vec::new(),
            };
            build.equipment.weapon2 = ItemSelection {
                item: (*right).to_owned(),
                crystals: Vec::new(),
                mods: Vec::new(),
            };
            let representative = catalogs.materialize(&build, MatchupRole::Active)?;
            let signature = combat_signature(&representative);
            if let Some(index) = group_by_signature.get(&signature) {
                groups[*index].sources.push(build);
            } else {
                group_by_signature.insert(signature.clone(), groups.len());
                groups.push(ResponseGroup {
                    signature,
                    representative,
                    sources: vec![build],
                });
            }
        }
    }
    let mut candidates = candidate_frontiers(
        &groups,
        opponents,
        opponent_ids,
        Some(opponent_weights),
        1e-6,
    )?
    .candidates;
    candidates.sort_by(|left, right| right.weighted_score.total_cmp(&left.weighted_score));
    let mut profiles = HashSet::<(WeaponType, WeaponType)>::new();
    let mut selected = Vec::new();
    for candidate in &candidates {
        let mut types = [
            candidate.representative.weapon1.weapon_type,
            candidate.representative.weapon2.weapon_type,
        ];
        types.sort();
        if profiles.insert((types[0], types[1])) {
            selected.push(candidate.sources[0].clone());
            if selected.len() == limit {
                return Ok(selected);
            }
        }
    }
    let mut concepts = selected
        .iter()
        .map(equipment_concept_signature)
        .collect::<HashSet<_>>();
    for candidate in candidates {
        let build = &candidate.sources[0];
        if concepts.insert(equipment_concept_signature(build)) {
            selected.push(build.clone());
            if selected.len() == limit {
                break;
            }
        }
    }
    Ok(selected)
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
    fn pruning_bound_distinguishes_safe_and_ambiguous_closure() {
        assert!(pruned_score_proves_below(0.49, 0.005, 0.51));
        assert!(!pruned_score_proves_below(0.509, 0.005, 0.51));
        assert!(pruned_score_proves_below(0.51, 0.0, 0.51));
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
    fn global_weapon_screen_preserves_profile_diversity() {
        let catalogs = Catalogs::bundled().unwrap();
        let baseline = catalogs.build("CurrentDualRifts750").unwrap();
        let opponent = catalogs.materialize(baseline, MatchupRole::Active).unwrap();
        let seeds = global_weapon_seeds(
            &catalogs,
            baseline,
            &[opponent],
            &["CurrentDualRifts750".to_owned()],
            &[1.0],
            6,
        )
        .unwrap();
        assert_eq!(seeds.len(), 6);
        let profiles = seeds
            .iter()
            .map(|build| {
                let mut types = [
                    catalogs
                        .item_weapon_type(&build.equipment.weapon1.item)
                        .unwrap()
                        .unwrap(),
                    catalogs
                        .item_weapon_type(&build.equipment.weapon2.item)
                        .unwrap()
                        .unwrap(),
                ];
                types.sort();
                (types[0], types[1])
            })
            .collect::<HashSet<_>>();
        assert_eq!(profiles.len(), 6);
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
        assert!(result.rounds[0].best_response_score.is_finite());
        assert!(!result.rounds[0].full_mixture_validation);

        options.screening_iterations = Some(1);
        options.screening_promotion_score = 2.0;
        options.admission_score = 2.0;
        let screened = endogenous_equipment_search(&catalogs, &catalog, &options).unwrap();
        assert!(screened.converged);
        assert_eq!(screened.rounds[0].promoted_seed_count, 0);
        assert!(screened.rounds[0].response_converged);
        assert!(!screened.rounds[0].response_convergence_reason.is_empty());
        assert!(screened.rounds[0].best_response_score.is_finite());
    }
}
