use std::collections::{HashMap, HashSet};

use anyhow::{bail, Context, Result};
use serde::Serialize;

use crate::catalog::{Catalogs, ItemVariantReport};
use crate::combat::combat_signature;
use crate::exact::DefeatRoundCache;
use crate::game::role_averaged_matchup;
use crate::game::MatchupResult;
use crate::model::{
    AttackType, BuildDefinition, CombatSignature, ItemSelection, Loadout, MatchupRole, Player,
    StatAllocation, WeaponType,
};

/// A combat-equivalent group accepted by the shared frontier evaluator.
pub trait CandidateGroup {
    /// Provenance retained on evaluated candidates.
    type Source: Clone;

    /// Canonical combat signature.
    fn signature(&self) -> &CombatSignature;
    /// Materialized combat representative.
    fn representative(&self) -> &Player;
    /// Concrete inputs represented by the group.
    fn sources(&self) -> &[Self::Source];
}

/// Reusable exact or truncated matchup cache for search stages sharing one
/// survival threshold.
#[derive(Debug)]
pub struct MatchupEvaluationCache {
    defeat_rounds: DefeatRoundCache,
    matchups: HashMap<(CombatSignature, CombatSignature), MatchupResult>,
    /// Number of complete matchup-cache hits.
    pub hits: u64,
    /// Number of complete matchup-cache misses.
    pub misses: u64,
}

impl MatchupEvaluationCache {
    /// Creates an empty search cache with the specified tail threshold.
    pub fn new(minimum_survival_probability: f64) -> Self {
        Self {
            defeat_rounds: DefeatRoundCache::new(minimum_survival_probability),
            matchups: HashMap::new(),
            hits: 0,
            misses: 0,
        }
    }

    /// Number of complete role-averaged matchups retained.
    pub fn len(&self) -> usize {
        self.matchups.len()
    }

    /// Whether no complete role-averaged matchup is retained.
    pub fn is_empty(&self) -> bool {
        self.matchups.is_empty()
    }

    fn evaluate(&mut self, player: &Player, opponent: &Player) -> MatchupResult {
        let key = (combat_signature(player), combat_signature(opponent));
        if let Some(result) = self.matchups.get(&key) {
            self.hits += 1;
            return *result;
        }
        self.misses += 1;
        let result = role_averaged_matchup(player, opponent, Some(&mut self.defeat_rounds), false);
        self.matchups.insert(key, result);
        result
    }
}

/// One stat allocation and attack mode represented by a combat-equivalent group.
#[derive(Clone, Debug, Serialize)]
pub struct StatAllocationSource {
    /// Selected attack mode.
    pub attack_type: AttackType,
    /// Allocated points.
    pub stats: StatAllocation,
}

/// Combat-equivalent stat allocations with one materialized representative.
#[derive(Clone, Debug)]
pub struct StatAllocationGroup {
    /// Canonical combat signature.
    pub signature: CombatSignature,
    /// Materialized representative.
    pub representative: Player,
    /// Allocations represented by the group.
    pub sources: Vec<StatAllocationSource>,
}

impl CandidateGroup for StatAllocationGroup {
    type Source = StatAllocationSource;

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

/// A slot that can be varied by equipment search.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EquipmentSlot {
    /// Armor slot.
    Armor,
    /// First weapon slot.
    Weapon1,
    /// Second weapon slot.
    Weapon2,
    /// First miscellaneous slot.
    Misc1,
    /// Second miscellaneous slot.
    Misc2,
}

/// One build and replacement represented by an equipment group.
#[derive(Clone, Debug, Serialize)]
pub struct EquipmentSource {
    /// Slot replaced to produce the build.
    pub slot: EquipmentSlot,
    /// Replacement descriptor.
    pub equipment: ItemSelection,
    /// Complete candidate build.
    pub build: BuildDefinition,
    /// Dominated crystals replaced before varying the selected slot.
    pub normalization: Vec<EquipmentReplacement>,
}

/// One crystal-normalization replacement.
#[derive(Clone, Debug, Serialize)]
pub struct EquipmentReplacement {
    /// Slot containing the replacement.
    pub slot: EquipmentSlot,
    /// Original descriptor.
    pub from: ItemSelection,
    /// Nondominated descriptor.
    pub to: ItemSelection,
}

/// Combat-equivalent equipment replacements with one representative.
#[derive(Clone, Debug)]
pub struct EquipmentGroup {
    /// Canonical combat signature.
    pub signature: CombatSignature,
    /// Materialized representative.
    pub representative: Player,
    /// Replacements represented by the group.
    pub sources: Vec<EquipmentSource>,
}

impl CandidateGroup for EquipmentGroup {
    type Source = EquipmentSource;

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

/// Equipment-neighborhood reduction counts.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub struct EquipmentNeighborhoodCounts {
    /// Nondominated slot-level variants considered before combat grouping.
    pub slot_variants: usize,
    /// Unique combat signatures after grouping.
    pub unique_combat_signatures: usize,
    /// Combat-distinct normalized forms of the seed build.
    pub normalized_builds: usize,
}

/// One-step equipment replacements grouped by combat behavior.
#[derive(Clone, Debug)]
pub struct EquipmentNeighborhood {
    /// Combat-equivalent replacement groups.
    pub groups: Vec<EquipmentGroup>,
    /// Reduction counts.
    pub counts: EquipmentNeighborhoodCounts,
}

/// Controls a one-step equipment neighborhood.
#[derive(Clone, Debug)]
pub struct EquipmentNeighborhoodOptions {
    /// Slots to vary. All five are used when empty.
    pub slots: Vec<EquipmentSlot>,
    /// Optional item allowlist per slot.
    pub item_keys_by_slot: HashMap<EquipmentSlot, Vec<String>>,
    /// Optional crystal allowlist.
    pub crystal_keys: Option<Vec<String>>,
    /// Number of sockets to fill on every generated descriptor.
    pub socket_capacity: usize,
    /// Replace dominated seed crystals before generating neighbors.
    pub normalize: bool,
    /// Vary crystals and mods while keeping each slot's base item fixed.
    pub fixed_equipment: bool,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct ItemVariantCacheKey {
    item: String,
    weapon_types: Vec<WeaponType>,
    crystal_keys: Option<Vec<String>>,
    socket_capacity: usize,
    fixed_mods: Option<Vec<String>>,
}

#[derive(Debug, Default)]
struct ItemVariantReportCache {
    reports: HashMap<ItemVariantCacheKey, ItemVariantReport>,
}

impl Default for EquipmentNeighborhoodOptions {
    fn default() -> Self {
        Self {
            slots: Vec::new(),
            item_keys_by_slot: HashMap::new(),
            crystal_keys: None,
            socket_capacity: 4,
            normalize: true,
            fixed_equipment: false,
        }
    }
}

/// Candidate metrics against a fixed opponent set.
#[derive(Clone, Debug)]
pub struct FrontierCandidate<S> {
    /// Canonical combat signature.
    pub signature: CombatSignature,
    /// Materialized representative.
    pub representative: Player,
    /// Source allocations represented by the candidate.
    pub sources: Vec<S>,
    /// Score against each opponent.
    pub matchup_scores: Vec<f64>,
    /// Lowest matchup score.
    pub worst_score: f64,
    /// Uniform average score.
    pub average_score: f64,
    /// Opponent-weighted score.
    pub weighted_score: f64,
    /// Weighted truncation error bound.
    pub weighted_score_error_bound: f64,
    /// Uniform average win probability.
    pub average_win_probability: f64,
    /// Uniform average healing cost.
    pub average_healing_cost: f64,
    /// Total healing cost divided by total win probability.
    pub healing_credits_per_win: f64,
}

/// Multi-objective frontier result for a candidate set.
#[derive(Clone, Debug)]
pub struct CandidateFrontiers<S> {
    /// Opponent identifiers.
    pub opponent_ids: Vec<String>,
    /// Normalized opponent weights.
    pub opponent_weights: Vec<f64>,
    /// Evaluated candidate count.
    pub candidate_count: usize,
    /// Evaluated matchup count.
    pub evaluated_matchups: usize,
    /// Every evaluated candidate in input order.
    pub candidates: Vec<FrontierCandidate<S>>,
    /// Componentwise combat frontier.
    pub combat_frontier: Vec<FrontierCandidate<S>>,
    /// Combat-plus-economy frontier.
    pub combat_economy_frontier: Vec<FrontierCandidate<S>>,
    /// Candidate with the strongest worst matchup.
    pub best_worst_case: Option<FrontierCandidate<S>>,
    /// Candidate with the strongest uniform average.
    pub best_average: Option<FrontierCandidate<S>>,
    /// Candidate with the strongest weighted score.
    pub best_weighted: Option<FrontierCandidate<S>>,
    /// Candidate with the lowest credits per win.
    pub cheapest_per_win: Option<FrontierCandidate<S>>,
    /// Cheapest candidate whose uniform average score is at least 0.5.
    pub cheapest_average_winner: Option<FrontierCandidate<S>>,
}

/// Two-stage exact equipment best-response result.
#[derive(Clone, Debug)]
pub struct EquipmentBestResponse {
    /// Strongest exact weighted candidate.
    pub best_response: FrontierCandidate<EquipmentSource>,
    /// Nondominated slot variants before combat grouping.
    pub slot_variants: usize,
    /// Unique approximate candidates.
    pub candidate_count: usize,
    /// Approximate matchup evaluations.
    pub evaluated_matchups: usize,
    /// Candidates whose error intervals survived screening.
    pub finalist_count: usize,
    /// Exact matchup evaluations.
    pub exact_matchups: usize,
}

/// Best exact candidate retained for one equipment concept.
#[derive(Clone, Debug)]
pub struct EquipmentBeamEntry {
    /// Canonical concept signature, insensitive to weapon and misc slot order.
    pub concept_signature: String,
    /// Best exact combat variant for the concept.
    pub best_response: FrontierCandidate<EquipmentSource>,
}

/// Bounded collection of distinct equipment concepts after exact validation.
#[derive(Clone, Debug)]
pub struct EquipmentResponseBeam {
    /// Concepts ordered by decreasing exact weighted score.
    pub beam: Vec<EquipmentBeamEntry>,
    /// Distinct concepts found during approximate evaluation.
    pub concept_count: usize,
    /// Concepts selected for exact validation.
    pub selected_concept_count: usize,
    /// Unique combat candidates in the neighborhood.
    pub candidate_count: usize,
    /// Approximate candidates surviving interval screening.
    pub finalist_count: usize,
    /// Approximate matchup evaluations.
    pub evaluated_matchups: usize,
    /// Exact matchup evaluations.
    pub exact_matchups: usize,
}

/// One pass in adaptive equipment response closure.
#[derive(Clone, Debug)]
pub struct EquipmentResponseIteration {
    /// One-based pass number.
    pub iteration: usize,
    /// Combat signatures retained after the pass.
    pub signatures: Vec<CombatSignature>,
    /// Unique candidates evaluated during the pass.
    pub candidate_count: usize,
    /// Exact finalists evaluated during the pass.
    pub finalist_count: usize,
}

/// Equipment beam repeatedly expanded until it stops improving.
#[derive(Clone, Debug)]
pub struct AdaptiveEquipmentResponse {
    /// Final distinct concepts ordered by score.
    pub beam: Vec<EquipmentBeamEntry>,
    /// Per-pass convergence record.
    pub iterations: Vec<EquipmentResponseIteration>,
    /// Whether every entry stabilized or the beam repeated.
    pub converged: bool,
}

/// Controls progressive stat-allocation refinement.
#[derive(Clone, Debug)]
pub struct AdaptiveStatOptions {
    /// Coarse-to-fine positive allocation strides.
    pub point_strides: Vec<i32>,
    /// Optional allowed HP allocations.
    pub hp_points: Option<HashSet<i32>>,
    /// Truncation threshold used during approximate frontier search.
    pub minimum_survival_probability: f64,
    /// Opponent weights; uniform when omitted.
    pub opponent_weights: Option<Vec<f64>>,
    /// Restrict exact validation to the weighted-best interval when true.
    pub weighted_best_only: bool,
    /// Continue unit-radius expansion until no allocation is added.
    pub converge: bool,
}

impl Default for AdaptiveStatOptions {
    fn default() -> Self {
        Self {
            point_strides: vec![11, 5, 2, 1],
            hp_points: None,
            minimum_survival_probability: 0.0,
            opponent_weights: None,
            weighted_best_only: false,
            converge: true,
        }
    }
}

/// One coarse-to-fine stat search stage.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub struct StatSearchStage {
    /// Allocation stride used to seed or expand this stage.
    pub point_stride: i32,
    /// Combat-equivalent candidates accumulated at this stage.
    pub candidate_count: usize,
    /// Combat frontier size.
    pub combat_frontier_count: usize,
    /// Combat-and-economy frontier size.
    pub combat_economy_frontier_count: usize,
}

/// Exact stat frontiers plus approximate-search accounting.
#[derive(Clone, Debug)]
pub struct AdaptiveStatFrontiers {
    /// Exact evaluation of interval-surviving frontier candidates.
    pub exact: CandidateFrontiers<StatAllocationSource>,
    /// Approximate combat-equivalent candidate count.
    pub search_candidate_count: usize,
    /// Approximate matchup evaluation count.
    pub search_evaluated_matchups: usize,
    /// Exact finalist count.
    pub exact_finalist_count: usize,
    /// Coarse-to-fine stage summaries.
    pub stages: Vec<StatSearchStage>,
    /// Number of unit-radius convergence passes.
    pub convergence_iterations: usize,
    /// Whether unit-radius expansion found no further allocation.
    pub converged: bool,
}

/// One jointly optimized equipment and stat response.
#[derive(Clone, Debug)]
pub struct JointResponseEntry {
    /// Canonical combat signature.
    pub signature: CombatSignature,
    /// Canonical equipment concept signature.
    pub concept_signature: String,
    /// Exact weighted score against the target mixture.
    pub weighted_score: f64,
    /// Complete response build.
    pub build: BuildDefinition,
}

/// One pass of alternating equipment and stat optimization.
#[derive(Clone, Debug, Serialize)]
pub struct JointResponseIteration {
    /// One-based pass number.
    pub iteration: usize,
    /// Whether this pass used the complete configured stat-refinement schedule.
    pub full_stat_fidelity: bool,
    /// Seeds expanded during this pass.
    pub seed_count: usize,
    /// Equipment candidates evaluated.
    pub equipment_candidate_count: usize,
    /// Exact equipment finalists evaluated.
    pub equipment_finalist_count: usize,
    /// Adaptive stat searches performed.
    pub stat_search_requests: usize,
    /// Approximate stat candidates evaluated.
    pub stat_candidate_count: usize,
    /// Exact stat finalists evaluated.
    pub exact_stat_finalist_count: usize,
    /// Improvement in the leading exact score after the first pass.
    pub improvement: Option<f64>,
}

/// Result of alternating equipment and stat response search.
#[derive(Clone, Debug)]
pub struct JointEquipmentStatResponse {
    /// Final response beam ordered by exact weighted score.
    pub beam: Vec<JointResponseEntry>,
    /// Per-pass search accounting.
    pub iterations: Vec<JointResponseIteration>,
    /// Whether a beam repeated or score improvement reached the tolerance.
    pub converged: bool,
    /// Stable machine-readable termination reason.
    pub convergence_reason: &'static str,
}

/// Returns a canonical equipment identity that ignores interchangeable slot order
/// and repeated copies of the same crystal type.
pub fn equipment_concept_signature(build: &BuildDefinition) -> String {
    fn descriptor(item: &ItemSelection) -> (String, Vec<String>, Vec<String>) {
        let mut mods = item.mods.clone();
        mods.sort();
        let mut crystals = item.crystals.clone();
        crystals.sort();
        crystals.dedup();
        (item.item.clone(), mods, crystals)
    }
    let mut weapons = [
        descriptor(&build.equipment.weapon1),
        descriptor(&build.equipment.weapon2),
    ];
    weapons.sort();
    let mut miscs = [
        descriptor(&build.equipment.misc1),
        descriptor(&build.equipment.misc2),
    ];
    miscs.sort();
    serde_json::to_string(&(descriptor(&build.equipment.armor), weapons, miscs))
        .expect("equipment descriptors are serializable")
}

/// Runs bounded-error screening followed by exact evaluation of surviving equipment.
pub fn equipment_best_response(
    catalogs: &Catalogs,
    build: &BuildDefinition,
    opponents: &[Player],
    opponent_ids: &[String],
    opponent_weights: Option<&[f64]>,
    options: &EquipmentNeighborhoodOptions,
    minimum_survival_probability: f64,
) -> Result<EquipmentBestResponse> {
    let neighborhood = equipment_neighborhood(catalogs, build, options)?;
    let approximate = candidate_frontiers(
        &neighborhood.groups,
        opponents,
        opponent_ids,
        opponent_weights,
        minimum_survival_probability,
    )?;
    let incumbent_lower_bound = approximate
        .candidates
        .iter()
        .map(|candidate| candidate.weighted_score - candidate.weighted_score_error_bound)
        .fold(f64::NEG_INFINITY, f64::max);
    let survivors = approximate
        .candidates
        .iter()
        .filter(|candidate| {
            candidate.weighted_score + candidate.weighted_score_error_bound
                >= incumbent_lower_bound - 1e-12
        })
        .map(|candidate| candidate.signature.clone())
        .collect::<HashSet<_>>();
    let finalists = neighborhood
        .groups
        .iter()
        .filter(|group| survivors.contains(&group.signature))
        .cloned()
        .collect::<Vec<_>>();
    let exact = candidate_frontiers(&finalists, opponents, opponent_ids, opponent_weights, 0.0)?;
    let best_response = exact
        .best_weighted
        .context("equipment neighborhood produced no candidates")?;
    Ok(EquipmentBestResponse {
        best_response,
        slot_variants: neighborhood.counts.slot_variants,
        candidate_count: neighborhood.counts.unique_combat_signatures,
        evaluated_matchups: approximate.evaluated_matchups,
        finalist_count: finalists.len(),
        exact_matchups: exact.evaluated_matchups,
    })
}

/// Selects distinct equipment concepts approximately, then validates their
/// interval-surviving combat variants exactly.
#[allow(clippy::too_many_arguments)]
pub fn equipment_response_beam(
    catalogs: &Catalogs,
    build: &BuildDefinition,
    opponents: &[Player],
    opponent_ids: &[String],
    opponent_weights: Option<&[f64]>,
    options: &EquipmentNeighborhoodOptions,
    minimum_survival_probability: f64,
    beam_width: usize,
) -> Result<EquipmentResponseBeam> {
    let mut approximate_cache = MatchupEvaluationCache::new(minimum_survival_probability);
    let mut exact_cache = MatchupEvaluationCache::new(0.0);
    let mut variant_cache = ItemVariantReportCache::default();
    equipment_response_beam_cached(
        catalogs,
        build,
        opponents,
        opponent_ids,
        opponent_weights,
        options,
        beam_width,
        &mut variant_cache,
        &mut approximate_cache,
        &mut exact_cache,
    )
}

#[allow(clippy::too_many_arguments)]
fn equipment_response_beam_cached(
    catalogs: &Catalogs,
    build: &BuildDefinition,
    opponents: &[Player],
    opponent_ids: &[String],
    opponent_weights: Option<&[f64]>,
    options: &EquipmentNeighborhoodOptions,
    beam_width: usize,
    variant_cache: &mut ItemVariantReportCache,
    approximate_cache: &mut MatchupEvaluationCache,
    exact_cache: &mut MatchupEvaluationCache,
) -> Result<EquipmentResponseBeam> {
    if beam_width == 0 {
        bail!("equipment response beam width must be positive");
    }
    let neighborhood = equipment_neighborhood_cached(catalogs, build, options, variant_cache)?;
    let approximate = candidate_frontiers_cached(
        &neighborhood.groups,
        opponents,
        opponent_ids,
        opponent_weights,
        approximate_cache,
    )?;
    let mut by_concept = HashMap::<String, Vec<usize>>::new();
    for (candidate_index, candidate) in approximate.candidates.iter().enumerate() {
        for source in &candidate.sources {
            by_concept
                .entry(equipment_concept_signature(&source.build))
                .or_default()
                .push(candidate_index);
        }
    }
    let concept_count = by_concept.len();
    let mut selected = by_concept
        .into_iter()
        .map(|(signature, candidate_indices)| {
            let approximate_score = candidate_indices
                .iter()
                .map(|index| approximate.candidates[*index].weighted_score)
                .fold(f64::NEG_INFINITY, f64::max);
            let lower_bound = candidate_indices
                .iter()
                .map(|index| {
                    let candidate = &approximate.candidates[*index];
                    candidate.weighted_score - candidate.weighted_score_error_bound
                })
                .fold(f64::NEG_INFINITY, f64::max);
            let finalists = candidate_indices
                .into_iter()
                .filter(|index| {
                    let candidate = &approximate.candidates[*index];
                    candidate.weighted_score + candidate.weighted_score_error_bound
                        >= lower_bound - 1e-12
                })
                .map(|index| approximate.candidates[index].signature.clone())
                .collect::<HashSet<_>>();
            (signature, approximate_score, finalists)
        })
        .collect::<Vec<_>>();
    selected.sort_by(|left, right| right.1.total_cmp(&left.1));
    selected.truncate(beam_width);
    let finalist_signatures = selected
        .iter()
        .flat_map(|(_, _, finalists)| finalists.iter().cloned())
        .collect::<HashSet<_>>();
    let finalists = neighborhood
        .groups
        .iter()
        .filter(|group| finalist_signatures.contains(&group.signature))
        .cloned()
        .collect::<Vec<_>>();
    let exact = candidate_frontiers_cached(
        &finalists,
        opponents,
        opponent_ids,
        opponent_weights,
        exact_cache,
    )?;
    let exact_by_signature = exact
        .candidates
        .into_iter()
        .map(|candidate| (candidate.signature.clone(), candidate))
        .collect::<HashMap<_, _>>();
    let mut beam = Vec::with_capacity(selected.len());
    for (concept_signature, _, signatures) in selected {
        let mut candidates = signatures
            .iter()
            .filter_map(|signature| exact_by_signature.get(signature).cloned())
            .collect::<Vec<_>>();
        candidates.sort_by(|left, right| right.weighted_score.total_cmp(&left.weighted_score));
        if let Some(mut best_response) = candidates.into_iter().next() {
            best_response
                .sources
                .retain(|source| equipment_concept_signature(&source.build) == concept_signature);
            if !best_response.sources.is_empty() {
                beam.push(EquipmentBeamEntry {
                    concept_signature,
                    best_response,
                });
            }
        }
    }
    beam.sort_by(|left, right| {
        right
            .best_response
            .weighted_score
            .total_cmp(&left.best_response.weighted_score)
    });
    Ok(EquipmentResponseBeam {
        selected_concept_count: beam.len(),
        beam,
        concept_count,
        candidate_count: neighborhood.counts.unique_combat_signatures,
        finalist_count: finalists.len(),
        evaluated_matchups: approximate.evaluated_matchups,
        exact_matchups: exact.evaluated_matchups,
    })
}

/// Repeatedly advances every improving equipment concept until the retained beam
/// stabilizes, repeats, or reaches `maximum_iterations`.
#[allow(clippy::too_many_arguments)]
pub fn adaptive_equipment_response_beam(
    catalogs: &Catalogs,
    build: &BuildDefinition,
    opponents: &[Player],
    opponent_ids: &[String],
    opponent_weights: Option<&[f64]>,
    options: &EquipmentNeighborhoodOptions,
    minimum_survival_probability: f64,
    beam_width: usize,
    maximum_iterations: usize,
    improvement_tolerance: f64,
) -> Result<AdaptiveEquipmentResponse> {
    let initial = equipment_response_beam(
        catalogs,
        build,
        opponents,
        opponent_ids,
        opponent_weights,
        options,
        minimum_survival_probability,
        beam_width,
    )?;
    let mut states = initial
        .beam
        .into_iter()
        .map(|entry| {
            let seen = HashSet::from([entry.best_response.signature.clone()]);
            (entry, false, seen)
        })
        .collect::<Vec<_>>();
    let mut iterations = vec![EquipmentResponseIteration {
        iteration: 1,
        signatures: states
            .iter()
            .map(|(entry, _, _)| entry.best_response.signature.clone())
            .collect(),
        candidate_count: initial.candidate_count,
        finalist_count: initial.finalist_count,
    }];
    for iteration in 2..=maximum_iterations {
        let previous = sorted_signatures(&states);
        let mut candidate_count = 0;
        let mut finalist_count = 0;
        for (entry, stable, seen) in &mut states {
            if *stable {
                continue;
            }
            let response = equipment_best_response(
                catalogs,
                &entry.best_response.sources[0].build,
                opponents,
                opponent_ids,
                opponent_weights,
                options,
                minimum_survival_probability,
            )?;
            candidate_count += response.candidate_count;
            finalist_count += response.finalist_count;
            let candidate = response.best_response;
            let improved = candidate.weighted_score
                > entry.best_response.weighted_score + improvement_tolerance;
            if !improved || seen.contains(&candidate.signature) {
                *stable = true;
                continue;
            }
            seen.insert(candidate.signature.clone());
            *entry = EquipmentBeamEntry {
                concept_signature: equipment_concept_signature(&candidate.sources[0].build),
                best_response: candidate,
            };
        }
        let mut best_by_concept =
            HashMap::<String, (EquipmentBeamEntry, bool, HashSet<CombatSignature>)>::new();
        for state in states {
            let key = state.0.concept_signature.clone();
            if best_by_concept.get(&key).is_none_or(|existing| {
                state.0.best_response.weighted_score > existing.0.best_response.weighted_score
            }) {
                best_by_concept.insert(key, state);
            }
        }
        states = best_by_concept.into_values().collect();
        states.sort_by(|left, right| {
            right
                .0
                .best_response
                .weighted_score
                .total_cmp(&left.0.best_response.weighted_score)
        });
        states.truncate(beam_width);
        let next = sorted_signatures(&states);
        iterations.push(EquipmentResponseIteration {
            iteration,
            signatures: next.clone(),
            candidate_count,
            finalist_count,
        });
        if states.iter().all(|(_, stable, _)| *stable) || previous == next {
            return Ok(AdaptiveEquipmentResponse {
                beam: states.into_iter().map(|state| state.0).collect(),
                iterations,
                converged: true,
            });
        }
    }
    Ok(AdaptiveEquipmentResponse {
        beam: states.into_iter().map(|state| state.0).collect(),
        iterations,
        converged: false,
    })
}

/// Alternates bounded equipment response beams with adaptive stat refinement.
///
/// Every retained score is exact. Approximate distributions only decide which
/// equipment and stat candidates require exact validation.
#[allow(clippy::too_many_arguments)]
pub fn joint_equipment_stat_response_beam(
    catalogs: &Catalogs,
    build: &BuildDefinition,
    opponents: &[Player],
    opponent_ids: &[String],
    opponent_weights: Option<&[f64]>,
    attack_types: &[AttackType],
    equipment_options: &EquipmentNeighborhoodOptions,
    stat_options: &AdaptiveStatOptions,
    minimum_survival_probability: f64,
    beam_width: usize,
    expansion_width: usize,
    maximum_iterations: usize,
    improvement_tolerance: f64,
) -> Result<JointEquipmentStatResponse> {
    if beam_width == 0 || expansion_width == 0 || maximum_iterations == 0 {
        bail!("joint response widths and iteration limit must be positive");
    }
    let mut seeds = vec![build.clone()];
    let mut seen_beams = HashSet::<Vec<String>>::new();
    let mut iterations = Vec::new();
    let mut beam = Vec::new();
    let mut previous_best_score = None;
    let progressive_stat_fidelity = stat_options.point_strides.len() > 1 || stat_options.converge;
    let mut full_stat_fidelity = !progressive_stat_fidelity;
    let mut skip_equipment_expansion = false;
    let mut retained_equipment_beam = Vec::<EquipmentBeamEntry>::new();
    let mut stat_approximate_cache =
        MatchupEvaluationCache::new(stat_options.minimum_survival_probability);
    let mut stat_exact_cache = MatchupEvaluationCache::new(0.0);
    let mut equipment_approximate_cache = MatchupEvaluationCache::new(minimum_survival_probability);
    let mut equipment_exact_cache = MatchupEvaluationCache::new(0.0);
    let mut item_variant_cache = ItemVariantReportCache::default();
    for iteration in 1..=maximum_iterations {
        let expanded_seeds = if skip_equipment_expansion {
            Vec::new()
        } else {
            seeds.iter().take(expansion_width).collect::<Vec<_>>()
        };
        let mut equipment_candidate_count = 0;
        let mut equipment_finalist_count = 0;
        let equipment_beam = if skip_equipment_expansion {
            retained_equipment_beam.clone()
        } else {
            let mut equipment_by_signature = HashMap::<CombatSignature, EquipmentBeamEntry>::new();
            for seed in &expanded_seeds {
                let response = equipment_response_beam_cached(
                    catalogs,
                    seed,
                    opponents,
                    opponent_ids,
                    opponent_weights,
                    equipment_options,
                    beam_width,
                    &mut item_variant_cache,
                    &mut equipment_approximate_cache,
                    &mut equipment_exact_cache,
                )?;
                equipment_candidate_count += response.candidate_count;
                equipment_finalist_count += response.finalist_count;
                for entry in response.beam {
                    let signature = entry.best_response.signature.clone();
                    if equipment_by_signature
                        .get(&signature)
                        .is_none_or(|existing| {
                            entry.best_response.weighted_score
                                > existing.best_response.weighted_score
                        })
                    {
                        equipment_by_signature.insert(signature, entry);
                    }
                }
            }
            let mut equipment_beam = equipment_by_signature.into_values().collect::<Vec<_>>();
            equipment_beam.sort_by(|left, right| {
                right
                    .best_response
                    .weighted_score
                    .total_cmp(&left.best_response.weighted_score)
            });
            equipment_beam.truncate(beam_width);
            retained_equipment_beam = equipment_beam.clone();
            equipment_beam
        };

        let mut response_by_signature = HashMap::<CombatSignature, JointResponseEntry>::new();
        let mut stat_candidate_count = 0;
        let mut exact_stat_finalist_count = 0;
        for entry in &equipment_beam {
            let equipment_build = &entry.best_response.sources[0].build;
            let mut search_options = stat_options.clone();
            search_options.opponent_weights = opponent_weights.map(<[f64]>::to_vec);
            search_options.weighted_best_only = true;
            if !full_stat_fidelity {
                search_options.point_strides = vec![stat_options.point_strides[0]];
                search_options.converge = false;
            }
            let stats = adaptive_stat_frontiers_cached(
                catalogs,
                equipment_build,
                opponents,
                opponent_ids,
                attack_types,
                &search_options,
                &mut stat_approximate_cache,
                &mut stat_exact_cache,
            )?;
            stat_candidate_count += stats.search_candidate_count;
            exact_stat_finalist_count += stats.exact_finalist_count;
            let best = stats
                .exact
                .best_weighted
                .context("stat response produced no candidates")?;
            let source = &best.sources[0];
            let mut response_build = equipment_build.clone();
            response_build.stats = source.stats;
            response_build.attack_type = source.attack_type;
            let response = JointResponseEntry {
                signature: best.signature.clone(),
                concept_signature: equipment_concept_signature(&response_build),
                weighted_score: best.weighted_score,
                build: response_build,
            };
            if response_by_signature
                .get(&response.signature)
                .is_none_or(|existing| response.weighted_score > existing.weighted_score)
            {
                response_by_signature.insert(response.signature.clone(), response);
            }
        }
        beam = response_by_signature.into_values().collect();
        beam.sort_by(|left, right| right.weighted_score.total_cmp(&left.weighted_score));
        beam.truncate(beam_width);
        if beam.is_empty() {
            bail!("joint response produced an empty beam");
        }
        let improvement = previous_best_score.map(|score| beam[0].weighted_score - score);
        iterations.push(JointResponseIteration {
            iteration,
            full_stat_fidelity,
            seed_count: expanded_seeds.len(),
            equipment_candidate_count,
            equipment_finalist_count,
            stat_search_requests: equipment_beam.len(),
            stat_candidate_count,
            exact_stat_finalist_count,
            improvement,
        });
        let mut beam_key = beam
            .iter()
            .map(|entry| serde_json::to_string(&entry.signature).unwrap_or_default())
            .collect::<Vec<_>>();
        beam_key.sort();
        let repeated = !seen_beams.insert(beam_key);
        let within_tolerance = improvement.is_some_and(|value| value <= improvement_tolerance);
        if (repeated || within_tolerance) && full_stat_fidelity {
            return Ok(JointEquipmentStatResponse {
                beam,
                iterations,
                converged: true,
                convergence_reason: if repeated {
                    "repeated_beam"
                } else {
                    "score_tolerance"
                },
            });
        }
        previous_best_score = Some(beam[0].weighted_score);
        seeds = beam.iter().map(|entry| entry.build.clone()).collect();
        skip_equipment_expansion = (repeated || within_tolerance) && !full_stat_fidelity;
        if skip_equipment_expansion {
            full_stat_fidelity = true;
        }
    }
    Ok(JointEquipmentStatResponse {
        beam,
        iterations,
        converged: false,
        convergence_reason: "iteration_limit",
    })
}

/// Builds the one-slot equipment neighborhood used by response search.
pub fn equipment_neighborhood(
    catalogs: &Catalogs,
    build: &BuildDefinition,
    options: &EquipmentNeighborhoodOptions,
) -> Result<EquipmentNeighborhood> {
    let mut cache = ItemVariantReportCache::default();
    equipment_neighborhood_cached(catalogs, build, options, &mut cache)
}

fn equipment_neighborhood_cached(
    catalogs: &Catalogs,
    build: &BuildDefinition,
    options: &EquipmentNeighborhoodOptions,
    variant_cache: &mut ItemVariantReportCache,
) -> Result<EquipmentNeighborhood> {
    let slots = if options.slots.is_empty() {
        vec![
            EquipmentSlot::Armor,
            EquipmentSlot::Weapon1,
            EquipmentSlot::Weapon2,
            EquipmentSlot::Misc1,
            EquipmentSlot::Misc2,
        ]
    } else {
        options.slots.clone()
    };
    let normalized_builds = if options.normalize {
        normalize_equipment(catalogs, build, &slots)?
    } else {
        vec![(build.clone(), Vec::new())]
    };
    let mut groups = Vec::<EquipmentGroup>::new();
    let mut group_by_signature = HashMap::<CombatSignature, usize>::new();
    let mut slot_variants = 0;
    for (base_build, normalization) in &normalized_builds {
        for slot in slots.iter().copied() {
            let category = slot_category(slot);
            let item_keys = if options.fixed_equipment {
                vec![get_slot(&base_build.equipment, slot).item.clone()]
            } else {
                match options.item_keys_by_slot.get(&slot) {
                    Some(keys) => keys.clone(),
                    None => catalogs
                        .item_keys(category)?
                        .into_iter()
                        .map(str::to_owned)
                        .collect(),
                }
            };
            for item_key in item_keys {
                if !catalogs.item_keys(category)?.contains(&item_key.as_str()) {
                    bail!("unknown {category} item: {item_key}");
                }
                let mut weapon_types = [
                    catalogs.item_weapon_type(&base_build.equipment.weapon1.item)?,
                    catalogs.item_weapon_type(&base_build.equipment.weapon2.item)?,
                ];
                match slot {
                    EquipmentSlot::Weapon1 => {
                        weapon_types[0] = catalogs.item_weapon_type(&item_key)?;
                    }
                    EquipmentSlot::Weapon2 => {
                        weapon_types[1] = catalogs.item_weapon_type(&item_key)?;
                    }
                    _ => {}
                }
                let mut active_weapon_types = weapon_types
                    .into_iter()
                    .flatten()
                    .collect::<Vec<WeaponType>>();
                active_weapon_types.sort();
                active_weapon_types.dedup();
                let mut crystal_keys = options.crystal_keys.clone();
                if let Some(keys) = &mut crystal_keys {
                    keys.sort();
                }
                let fixed_mods = options.fixed_equipment.then(|| {
                    let mut mods = get_slot(&base_build.equipment, slot).mods.clone();
                    mods.sort();
                    mods
                });
                let cache_key = ItemVariantCacheKey {
                    item: item_key.clone(),
                    weapon_types: active_weapon_types.clone(),
                    crystal_keys,
                    socket_capacity: options.socket_capacity,
                    fixed_mods,
                };
                let report = if let Some(report) = variant_cache.reports.get(&cache_key) {
                    report.clone()
                } else {
                    let report = if options.fixed_equipment {
                        catalogs.descriptor_variant_report(
                            get_slot(&base_build.equipment, slot),
                            &active_weapon_types,
                            options.crystal_keys.as_deref(),
                            options.socket_capacity,
                        )?
                    } else {
                        catalogs.item_variant_report(
                            &item_key,
                            &active_weapon_types,
                            options.crystal_keys.as_deref(),
                            options.socket_capacity,
                        )?
                    };
                    variant_cache.reports.insert(cache_key, report.clone());
                    report
                };
                slot_variants += report.nondominated_groups.len();
                for variant in report.nondominated_groups {
                    for descriptor in variant.sources {
                        let selection = ItemSelection {
                            item: descriptor.item,
                            crystals: descriptor.crystals,
                            mods: descriptor.mods,
                        };
                        let mut candidate = base_build.clone();
                        set_slot(&mut candidate.equipment, slot, selection.clone());
                        let representative =
                            catalogs.materialize(&candidate, MatchupRole::Active)?;
                        let signature = combat_signature(&representative);
                        let source = EquipmentSource {
                            slot,
                            equipment: selection,
                            build: candidate,
                            normalization: normalization.clone(),
                        };
                        if let Some(index) = group_by_signature.get(&signature) {
                            groups[*index].sources.push(source);
                        } else {
                            group_by_signature.insert(signature.clone(), groups.len());
                            groups.push(EquipmentGroup {
                                signature,
                                representative,
                                sources: vec![source],
                            });
                        }
                    }
                }
            }
        }
    }
    Ok(EquipmentNeighborhood {
        counts: EquipmentNeighborhoodCounts {
            slot_variants,
            unique_combat_signatures: groups.len(),
            normalized_builds: normalized_builds.len(),
        },
        groups,
    })
}

/// Finds speed allocations that tie or first exceed each opponent's normal speed.
pub fn initiative_speed_points(
    catalogs: &Catalogs,
    build: &BuildDefinition,
    opponents: &[Player],
    attack_type: AttackType,
) -> Result<Vec<i32>> {
    let mut speed_by_points = HashMap::new();
    let mut selected = HashSet::from([2]);
    for speed in 2..=173 {
        let mut candidate = build.clone();
        candidate.stats = StatAllocation {
            hp: 2,
            speed,
            accuracy: 4,
            dodge: 177 - speed,
        };
        candidate.attack_type = attack_type;
        speed_by_points.insert(
            speed,
            catalogs
                .materialize(&candidate, MatchupRole::Active)?
                .stats
                .speed,
        );
    }
    for opponent in opponents {
        let defender_speed = opponent.normal_mode.speed;
        for speed in 2..=173 {
            let candidate_speed = speed_by_points[&speed];
            if candidate_speed == defender_speed {
                selected.insert(speed);
            }
            if candidate_speed > defender_speed {
                selected.insert(speed);
                break;
            }
        }
    }
    let mut selected = selected.into_iter().collect::<Vec<_>>();
    selected.sort_unstable();
    Ok(selected)
}

/// Enumerates legal allocations for selected speed values and an optional grid.
pub fn stat_allocations(
    speed_points: &[i32],
    hp_points: Option<&HashSet<i32>>,
    point_stride: i32,
) -> Result<Vec<StatAllocation>> {
    if point_stride <= 0 {
        bail!("stat allocation point stride must be a positive integer");
    }
    let mut speeds = speed_points.to_vec();
    speeds.sort_unstable();
    speeds.dedup();
    let mut allocations = Vec::new();
    for speed in speeds {
        for hp in values(2, 175 - speed, point_stride) {
            if hp_points.is_some_and(|allowed| !allowed.contains(&hp)) {
                continue;
            }
            for accuracy in values(4, 179 - speed - hp, point_stride) {
                let dodge = 183 - speed - hp - accuracy;
                if dodge >= 4 {
                    allocations.push(StatAllocation {
                        hp,
                        speed,
                        accuracy,
                        dodge,
                    });
                }
            }
        }
    }
    Ok(allocations)
}

/// Groups legal stat allocations by their canonical combat behavior.
pub fn stat_allocation_groups(
    catalogs: &Catalogs,
    build: &BuildDefinition,
    opponents: &[Player],
    attack_types: &[AttackType],
    hp_points: Option<&HashSet<i32>>,
    point_stride: i32,
) -> Result<Vec<StatAllocationGroup>> {
    let mut groups = Vec::<StatAllocationGroup>::new();
    let mut group_by_signature = HashMap::<CombatSignature, usize>::new();
    for attack_type in attack_types {
        let speeds = initiative_speed_points(catalogs, build, opponents, *attack_type)?;
        for stats in stat_allocations(&speeds, hp_points, point_stride)? {
            let mut candidate = build.clone();
            candidate.stats = stats;
            candidate.attack_type = *attack_type;
            let representative = catalogs.materialize(&candidate, MatchupRole::Active)?;
            let signature = combat_signature(&representative);
            let source = StatAllocationSource {
                attack_type: *attack_type,
                stats,
            };
            if let Some(index) = group_by_signature.get(&signature) {
                groups[*index].sources.push(source);
            } else {
                group_by_signature.insert(signature.clone(), groups.len());
                groups.push(StatAllocationGroup {
                    signature,
                    representative,
                    sources: vec![source],
                });
            }
        }
    }
    Ok(groups)
}

/// Progressively refines stat allocations around approximate Pareto frontiers,
/// then evaluates all interval-surviving finalists exactly.
pub fn adaptive_stat_frontiers(
    catalogs: &Catalogs,
    build: &BuildDefinition,
    opponents: &[Player],
    opponent_ids: &[String],
    attack_types: &[AttackType],
    options: &AdaptiveStatOptions,
) -> Result<AdaptiveStatFrontiers> {
    let mut approximate_cache = MatchupEvaluationCache::new(options.minimum_survival_probability);
    let mut exact_cache = MatchupEvaluationCache::new(0.0);
    adaptive_stat_frontiers_cached(
        catalogs,
        build,
        opponents,
        opponent_ids,
        attack_types,
        options,
        &mut approximate_cache,
        &mut exact_cache,
    )
}

#[allow(clippy::too_many_arguments)]
fn adaptive_stat_frontiers_cached(
    catalogs: &Catalogs,
    build: &BuildDefinition,
    opponents: &[Player],
    opponent_ids: &[String],
    attack_types: &[AttackType],
    options: &AdaptiveStatOptions,
    approximate_cache: &mut MatchupEvaluationCache,
    exact_cache: &mut MatchupEvaluationCache,
) -> Result<AdaptiveStatFrontiers> {
    if options.point_strides.is_empty() || options.point_strides.iter().any(|stride| *stride <= 0) {
        bail!("adaptive stat search requires positive point strides");
    }
    let mut groups = Vec::<StatAllocationGroup>::new();
    let mut group_by_signature = HashMap::<CombatSignature, usize>::new();
    let mut source_keys = HashSet::<(AttackType, StatAllocation)>::new();
    let incumbent = (build.attack_type, build.stats);
    if attack_types.contains(&build.attack_type) {
        add_stat_source(
            catalogs,
            build,
            StatAllocationSource {
                attack_type: build.attack_type,
                stats: build.stats,
            },
            options.hp_points.as_ref(),
            &mut groups,
            &mut group_by_signature,
            &mut source_keys,
        )?;
    }
    for attack_type in attack_types {
        let speeds = initiative_speed_points(catalogs, build, opponents, *attack_type)?;
        for stats in stat_allocations(
            &speeds,
            options.hp_points.as_ref(),
            options.point_strides[0],
        )? {
            add_stat_source(
                catalogs,
                build,
                StatAllocationSource {
                    attack_type: *attack_type,
                    stats,
                },
                options.hp_points.as_ref(),
                &mut groups,
                &mut group_by_signature,
                &mut source_keys,
            )?;
        }
    }

    let mut stages = Vec::new();
    let mut approximate = None;
    for (stage, point_stride) in options.point_strides.iter().copied().enumerate() {
        let result = candidate_frontiers_cached(
            &groups,
            opponents,
            opponent_ids,
            options.opponent_weights.as_deref(),
            approximate_cache,
        )?;
        stages.push(StatSearchStage {
            point_stride,
            candidate_count: result.candidate_count,
            combat_frontier_count: result.combat_frontier.len(),
            combat_economy_frontier_count: result.combat_economy_frontier.len(),
        });
        if let Some(next_stride) = options.point_strides.get(stage + 1).copied() {
            expand_stat_frontiers(
                catalogs,
                build,
                &result,
                point_stride,
                next_stride,
                options.hp_points.as_ref(),
                &mut groups,
                &mut group_by_signature,
                &mut source_keys,
            )?;
        }
        approximate = Some(result);
    }
    let mut approximate = approximate.context("adaptive stat search produced no stage")?;
    let mut convergence_iterations = 0;
    let mut converged = !options.converge;
    if options.converge {
        loop {
            convergence_iterations += 1;
            let added = expand_stat_frontiers(
                catalogs,
                build,
                &approximate,
                1,
                1,
                options.hp_points.as_ref(),
                &mut groups,
                &mut group_by_signature,
                &mut source_keys,
            )?;
            if added == 0 {
                converged = true;
                break;
            }
            approximate = candidate_frontiers_cached(
                &groups,
                opponents,
                opponent_ids,
                options.opponent_weights.as_deref(),
                approximate_cache,
            )?;
        }
    }

    let mut frontier_candidates = approximate
        .combat_frontier
        .iter()
        .chain(&approximate.combat_economy_frontier)
        .collect::<Vec<_>>();
    if options.weighted_best_only {
        let lower_bound = frontier_candidates
            .iter()
            .map(|candidate| candidate.weighted_score - candidate.weighted_score_error_bound)
            .fold(f64::NEG_INFINITY, f64::max);
        frontier_candidates.retain(|candidate| {
            candidate.weighted_score + candidate.weighted_score_error_bound >= lower_bound - 1e-12
        });
    }
    let mut finalist_sources = frontier_candidates
        .iter()
        .flat_map(|candidate| &candidate.sources)
        .map(|source| (source.attack_type, source.stats))
        .collect::<HashSet<_>>();
    if source_keys.contains(&incumbent) {
        finalist_sources.insert(incumbent);
    }
    let finalists = groups
        .iter()
        .filter(|group| {
            group
                .sources
                .iter()
                .any(|source| finalist_sources.contains(&(source.attack_type, source.stats)))
        })
        .cloned()
        .collect::<Vec<_>>();
    let exact = candidate_frontiers_cached(
        &finalists,
        opponents,
        opponent_ids,
        options.opponent_weights.as_deref(),
        exact_cache,
    )?;
    Ok(AdaptiveStatFrontiers {
        search_candidate_count: approximate.candidate_count,
        search_evaluated_matchups: approximate.evaluated_matchups,
        exact_finalist_count: finalists.len(),
        exact,
        stages,
        convergence_iterations,
        converged,
    })
}

#[allow(clippy::too_many_arguments)]
fn add_stat_source(
    catalogs: &Catalogs,
    build: &BuildDefinition,
    source: StatAllocationSource,
    hp_points: Option<&HashSet<i32>>,
    groups: &mut Vec<StatAllocationGroup>,
    group_by_signature: &mut HashMap<CombatSignature, usize>,
    source_keys: &mut HashSet<(AttackType, StatAllocation)>,
) -> Result<bool> {
    let stats = source.stats;
    if stats.hp < 2
        || stats.speed < 2
        || stats.accuracy < 4
        || stats.dodge < 4
        || stats.hp + stats.speed + stats.accuracy + stats.dodge != 183
        || hp_points.is_some_and(|allowed| !allowed.contains(&stats.hp))
        || !source_keys.insert((source.attack_type, stats))
    {
        return Ok(false);
    }
    let mut candidate = build.clone();
    candidate.stats = stats;
    candidate.attack_type = source.attack_type;
    let representative = catalogs.materialize(&candidate, MatchupRole::Active)?;
    let signature = combat_signature(&representative);
    if let Some(index) = group_by_signature.get(&signature) {
        groups[*index].sources.push(source);
    } else {
        group_by_signature.insert(signature.clone(), groups.len());
        groups.push(StatAllocationGroup {
            signature,
            representative,
            sources: vec![source],
        });
    }
    Ok(true)
}

#[allow(clippy::too_many_arguments)]
fn expand_stat_frontiers(
    catalogs: &Catalogs,
    build: &BuildDefinition,
    frontier: &CandidateFrontiers<StatAllocationSource>,
    radius: i32,
    stride: i32,
    hp_points: Option<&HashSet<i32>>,
    groups: &mut Vec<StatAllocationGroup>,
    group_by_signature: &mut HashMap<CombatSignature, usize>,
    source_keys: &mut HashSet<(AttackType, StatAllocation)>,
) -> Result<usize> {
    let sources = frontier
        .combat_frontier
        .iter()
        .chain(&frontier.combat_economy_frontier)
        .flat_map(|candidate| candidate.sources.clone())
        .collect::<Vec<_>>();
    let mut added = 0;
    for source in sources {
        for hp_offset in (-radius..=radius).step_by(stride as usize) {
            for accuracy_offset in (-radius..=radius).step_by(stride as usize) {
                let stats = StatAllocation {
                    hp: source.stats.hp + hp_offset,
                    speed: source.stats.speed,
                    accuracy: source.stats.accuracy + accuracy_offset,
                    dodge: 183
                        - source.stats.speed
                        - source.stats.hp
                        - hp_offset
                        - source.stats.accuracy
                        - accuracy_offset,
                };
                added += usize::from(add_stat_source(
                    catalogs,
                    build,
                    StatAllocationSource {
                        attack_type: source.attack_type,
                        stats,
                    },
                    hp_points,
                    groups,
                    group_by_signature,
                    source_keys,
                )?);
            }
        }
    }
    Ok(added)
}

/// Evaluates stat groups and retains combat and economic Pareto frontiers.
pub fn candidate_frontiers<G: CandidateGroup>(
    groups: &[G],
    opponents: &[Player],
    opponent_ids: &[String],
    opponent_weights: Option<&[f64]>,
    minimum_survival_probability: f64,
) -> Result<CandidateFrontiers<G::Source>> {
    let mut cache = MatchupEvaluationCache::new(minimum_survival_probability);
    candidate_frontiers_cached(
        groups,
        opponents,
        opponent_ids,
        opponent_weights,
        &mut cache,
    )
}

/// Evaluates candidates while reusing complete matchup and directional defeat
/// distributions from preceding search stages.
pub fn candidate_frontiers_cached<G: CandidateGroup>(
    groups: &[G],
    opponents: &[Player],
    opponent_ids: &[String],
    opponent_weights: Option<&[f64]>,
    cache: &mut MatchupEvaluationCache,
) -> Result<CandidateFrontiers<G::Source>> {
    if opponents.is_empty() || opponents.len() != opponent_ids.len() {
        bail!("opponents and opponent IDs must be non-empty and have equal length");
    }
    let weights = opponent_weights
        .map(<[f64]>::to_vec)
        .unwrap_or_else(|| vec![1.0 / opponents.len() as f64; opponents.len()]);
    if weights.len() != opponents.len() || (weights.iter().sum::<f64>() - 1.0).abs() > 1e-12 {
        bail!("opponent weights must match the opponents and sum to one");
    }
    let mut combat_frontier = Vec::new();
    let mut economy_frontier = Vec::new();
    let mut best_worst_case: Option<FrontierCandidate<G::Source>> = None;
    let mut best_average: Option<FrontierCandidate<G::Source>> = None;
    let mut best_weighted: Option<FrontierCandidate<G::Source>> = None;
    let mut cheapest_per_win: Option<FrontierCandidate<G::Source>> = None;
    let mut cheapest_average_winner: Option<FrontierCandidate<G::Source>> = None;
    let mut candidates = Vec::with_capacity(groups.len());
    for group in groups {
        let matchups = opponents
            .iter()
            .map(|opponent| cache.evaluate(group.representative(), opponent))
            .collect::<Vec<_>>();
        let scores = matchups
            .iter()
            .map(|matchup| matchup.score)
            .collect::<Vec<_>>();
        let total_wins = matchups
            .iter()
            .map(|matchup| matchup.candidate.win_probability)
            .sum::<f64>();
        let total_healing = matchups
            .iter()
            .map(|matchup| matchup.candidate.expected_healing_cost)
            .sum::<f64>();
        let candidate = FrontierCandidate {
            signature: group.signature().clone(),
            representative: group.representative().clone(),
            sources: group.sources().to_vec(),
            worst_score: scores.iter().copied().fold(f64::INFINITY, f64::min),
            average_score: mean(&scores),
            weighted_score: scores
                .iter()
                .zip(&weights)
                .map(|(score, weight)| score * weight)
                .sum(),
            weighted_score_error_bound: matchups
                .iter()
                .zip(&weights)
                .map(|(matchup, weight)| matchup.score_error_bound * weight)
                .sum(),
            average_win_probability: total_wins / matchups.len() as f64,
            average_healing_cost: total_healing / matchups.len() as f64,
            healing_credits_per_win: if total_wins > 0.0 {
                total_healing / total_wins
            } else {
                f64::INFINITY
            },
            matchup_scores: scores,
        };
        add_to_frontier(&mut combat_frontier, candidate.clone(), false);
        add_to_frontier(&mut economy_frontier, candidate.clone(), true);
        replace_if(&mut best_worst_case, &candidate, |left, right| {
            left.worst_score > right.worst_score
        });
        replace_if(&mut best_average, &candidate, |left, right| {
            left.average_score > right.average_score
        });
        replace_if(&mut best_weighted, &candidate, |left, right| {
            left.weighted_score > right.weighted_score
        });
        replace_if(&mut cheapest_per_win, &candidate, |left, right| {
            left.healing_credits_per_win < right.healing_credits_per_win
        });
        if candidate.average_score >= 0.5 {
            replace_if(&mut cheapest_average_winner, &candidate, |left, right| {
                left.healing_credits_per_win < right.healing_credits_per_win
            });
        }
        candidates.push(candidate);
    }
    Ok(CandidateFrontiers {
        opponent_ids: opponent_ids.to_vec(),
        opponent_weights: weights,
        candidate_count: groups.len(),
        evaluated_matchups: groups.len() * opponents.len(),
        candidates,
        combat_frontier,
        combat_economy_frontier: economy_frontier,
        best_worst_case,
        best_average,
        best_weighted,
        cheapest_per_win,
        cheapest_average_winner,
    })
}

fn values(minimum: i32, maximum: i32, stride: i32) -> Vec<i32> {
    let mut result = (minimum..=maximum)
        .step_by(stride as usize)
        .collect::<Vec<_>>();
    if result.last().copied() != Some(maximum) {
        result.push(maximum);
    }
    result
}

fn slot_category(slot: EquipmentSlot) -> &'static str {
    match slot {
        EquipmentSlot::Armor => "armor",
        EquipmentSlot::Weapon1 | EquipmentSlot::Weapon2 => "weapons",
        EquipmentSlot::Misc1 | EquipmentSlot::Misc2 => "miscs",
    }
}

fn set_slot(loadout: &mut Loadout, slot: EquipmentSlot, selection: ItemSelection) {
    *match slot {
        EquipmentSlot::Armor => &mut loadout.armor,
        EquipmentSlot::Weapon1 => &mut loadout.weapon1,
        EquipmentSlot::Weapon2 => &mut loadout.weapon2,
        EquipmentSlot::Misc1 => &mut loadout.misc1,
        EquipmentSlot::Misc2 => &mut loadout.misc2,
    } = selection;
}

fn get_slot(loadout: &Loadout, slot: EquipmentSlot) -> &ItemSelection {
    match slot {
        EquipmentSlot::Armor => &loadout.armor,
        EquipmentSlot::Weapon1 => &loadout.weapon1,
        EquipmentSlot::Weapon2 => &loadout.weapon2,
        EquipmentSlot::Misc1 => &loadout.misc1,
        EquipmentSlot::Misc2 => &loadout.misc2,
    }
}

fn normalize_equipment(
    catalogs: &Catalogs,
    build: &BuildDefinition,
    slots: &[EquipmentSlot],
) -> Result<Vec<(BuildDefinition, Vec<EquipmentReplacement>)>> {
    let mut variants = vec![(build.clone(), Vec::new())];
    for slot in slots {
        let mut next = Vec::new();
        for (candidate, replacements) in variants {
            let original = get_slot(&candidate.equipment, *slot).clone();
            let mut crystal_sets = vec![Vec::<String>::new()];
            for crystal in &original.crystals {
                let replacements = catalogs.nondominated_crystal_replacements(crystal)?;
                crystal_sets = crystal_sets
                    .into_iter()
                    .flat_map(|selected| {
                        replacements.iter().map(move |replacement| {
                            let mut next = selected.clone();
                            next.push(replacement.clone());
                            next
                        })
                    })
                    .collect();
            }
            let mut descriptors = HashSet::<ItemSelection>::new();
            for mut crystals in crystal_sets {
                crystals.sort();
                let mut replacement = original.clone();
                replacement.crystals = crystals;
                if !descriptors.insert(replacement.clone()) {
                    continue;
                }
                let mut normalized = candidate.clone();
                set_slot(&mut normalized.equipment, *slot, replacement.clone());
                let mut history = replacements.clone();
                if replacement != original {
                    history.push(EquipmentReplacement {
                        slot: *slot,
                        from: original.clone(),
                        to: replacement,
                    });
                }
                next.push((normalized, history));
            }
        }
        variants = next;
    }
    let mut signatures = HashSet::new();
    variants.retain(|(candidate, _)| {
        catalogs
            .materialize(candidate, MatchupRole::Active)
            .map(|player| signatures.insert(combat_signature(&player)))
            .unwrap_or(false)
    });
    Ok(variants)
}

fn sorted_signatures(
    states: &[(EquipmentBeamEntry, bool, HashSet<CombatSignature>)],
) -> Vec<CombatSignature> {
    let mut signatures = states
        .iter()
        .map(|(entry, _, _)| entry.best_response.signature.clone())
        .collect::<Vec<_>>();
    signatures.sort_by_key(|signature| serde_json::to_string(signature).unwrap_or_default());
    signatures
}

fn mean(values: &[f64]) -> f64 {
    values.iter().sum::<f64>() / values.len() as f64
}

fn dominates<S>(left: &FrontierCandidate<S>, right: &FrontierCandidate<S>, economy: bool) -> bool {
    let mut strictly_better = false;
    for (left, right) in left.matchup_scores.iter().zip(&right.matchup_scores) {
        if left < &(right - 1e-12) {
            return false;
        }
        strictly_better |= left > &(right + 1e-12);
    }
    if economy {
        if left.healing_credits_per_win > right.healing_credits_per_win + 1e-12 {
            return false;
        }
        strictly_better |= left.healing_credits_per_win < right.healing_credits_per_win - 1e-12;
    }
    strictly_better
}

fn add_to_frontier<S: Clone>(
    frontier: &mut Vec<FrontierCandidate<S>>,
    candidate: FrontierCandidate<S>,
    economy: bool,
) {
    if frontier
        .iter()
        .any(|entry| dominates(entry, &candidate, economy))
    {
        return;
    }
    frontier.retain(|entry| !dominates(&candidate, entry, economy));
    frontier.push(candidate);
}

fn replace_if<S: Clone>(
    selected: &mut Option<FrontierCandidate<S>>,
    candidate: &FrontierCandidate<S>,
    better: impl Fn(&FrontierCandidate<S>, &FrontierCandidate<S>) -> bool,
) {
    if selected
        .as_ref()
        .is_none_or(|current| better(candidate, current))
    {
        *selected = Some(candidate.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stat_allocation_generation_matches_legacy_counts() {
        let allocations = stat_allocations(&[173], None, 1).unwrap();
        assert_eq!(allocations.len(), 1);
        assert_eq!(allocations[0].hp, 2);
        assert_eq!(allocations[0].dodge, 4);
        let hp = HashSet::from([2]);
        assert_eq!(stat_allocations(&[2], Some(&hp), 1).unwrap().len(), 172);
    }

    #[test]
    fn candidate_evaluation_cache_reuses_complete_matchups() {
        let catalogs = Catalogs::bundled().unwrap();
        let build = catalogs.build("ShadowDojoDLGunBuild3").unwrap();
        let player = catalogs.materialize(build, MatchupRole::Active).unwrap();
        let group = StatAllocationGroup {
            signature: combat_signature(&player),
            representative: player.clone(),
            sources: vec![StatAllocationSource {
                attack_type: build.attack_type,
                stats: build.stats,
            }],
        };
        let mut cache = MatchupEvaluationCache::new(1e-6);
        let ids = vec!["opponent".to_owned()];
        candidate_frontiers_cached(
            std::slice::from_ref(&group),
            std::slice::from_ref(&player),
            &ids,
            Some(&[1.0]),
            &mut cache,
        )
        .unwrap();
        candidate_frontiers_cached(&[group], &[player], &ids, Some(&[1.0]), &mut cache).unwrap();
        assert_eq!(cache.misses, 1);
        assert_eq!(cache.hits, 1);
        assert_eq!(cache.len(), 1);
    }

    #[test]
    fn initiative_thresholds_match_legacy_fixture() {
        let catalogs = Catalogs::bundled().unwrap();
        let build = catalogs.build("ShadowDojoDLGunBuild3").unwrap();
        let opponents = [
            "ShadowDojoArmorStackCores",
            "ShadowDojoDLGunBuild3",
            "ShadowDojoHFCoreVoid",
            "ShadowDojoSG1SplitBombs",
        ]
        .iter()
        .map(|key| {
            catalogs
                .materialize(catalogs.build(key).unwrap(), MatchupRole::Active)
                .unwrap()
        })
        .collect::<Vec<_>>();
        assert_eq!(
            initiative_speed_points(&catalogs, build, &opponents, AttackType::Normal).unwrap(),
            vec![2, 3, 16, 19, 24]
        );
    }

    #[test]
    fn equipment_response_matches_exhaustive_fixture() {
        let catalogs = Catalogs::bundled().unwrap();
        let build = catalogs.build("ShadowDojoDLGunBuild2").unwrap().clone();
        let opponent = catalogs.materialize(&build, MatchupRole::Active).unwrap();
        let options = EquipmentNeighborhoodOptions {
            slots: vec![EquipmentSlot::Weapon1],
            item_keys_by_slot: HashMap::from([(
                EquipmentSlot::Weapon1,
                vec!["RiftGun".to_owned(), "AlienRifle".to_owned()],
            )]),
            crystal_keys: Some(vec!["PerfectFire".to_owned()]),
            socket_capacity: 1,
            ..EquipmentNeighborhoodOptions::default()
        };
        let neighborhood = equipment_neighborhood(&catalogs, &build, &options).unwrap();
        assert!(!neighborhood.groups.is_empty());
        assert!(neighborhood.counts.slot_variants >= neighborhood.groups.len());
        let ids = vec!["opponent".to_owned()];
        let opponents = vec![opponent];
        let exact =
            candidate_frontiers(&neighborhood.groups, &opponents, &ids, Some(&[1.0]), 0.0).unwrap();
        let response = equipment_best_response(
            &catalogs,
            &build,
            &opponents,
            &ids,
            Some(&[1.0]),
            &options,
            1e-6,
        )
        .unwrap();
        assert_eq!(response.candidate_count, response.evaluated_matchups);
        assert_eq!(response.exact_matchups, response.finalist_count);
        assert_eq!(
            response.best_response.signature,
            exact.best_weighted.unwrap().signature
        );
        assert_eq!(
            response.best_response.sources[0].slot,
            EquipmentSlot::Weapon1
        );

        let beam_options = EquipmentNeighborhoodOptions {
            crystal_keys: Some(
                ["PerfectFire", "AmuletCrystal", "BerserkerCrystal"]
                    .map(str::to_owned)
                    .to_vec(),
            ),
            socket_capacity: 2,
            ..options
        };
        let beam = equipment_response_beam(
            &catalogs,
            &build,
            &opponents,
            &ids,
            Some(&[1.0]),
            &beam_options,
            1e-6,
            2,
        )
        .unwrap();
        assert_eq!(beam.beam.len(), 2);
        assert_eq!(
            beam.beam
                .iter()
                .map(|entry| &entry.concept_signature)
                .collect::<HashSet<_>>()
                .len(),
            2
        );
        let adaptive = adaptive_equipment_response_beam(
            &catalogs,
            &build,
            &opponents,
            &ids,
            Some(&[1.0]),
            &beam_options,
            1e-6,
            2,
            3,
            1e-6,
        )
        .unwrap();
        assert!(adaptive.converged);
        assert!(adaptive.beam.len() <= 2);
    }

    #[test]
    fn equipment_normalization_matches_legacy_fixture() {
        let catalogs = Catalogs::bundled().unwrap();
        let build = catalogs.build("ShadowDojoDLGunBuild3").unwrap();
        let slots = [
            EquipmentSlot::Armor,
            EquipmentSlot::Weapon1,
            EquipmentSlot::Weapon2,
            EquipmentSlot::Misc1,
            EquipmentSlot::Misc2,
        ];
        let normalized = normalize_equipment(&catalogs, build, &slots).unwrap();
        assert_eq!(normalized.len(), 1);
        assert_eq!(normalized[0].1.len(), 3);
        assert_eq!(
            normalized[0].0.equipment.weapon2.crystals,
            vec!["BerserkerCrystal".to_owned(); 4]
        );
        assert_eq!(
            normalized[0].0.equipment.misc1.crystals,
            vec!["GreenInferno".to_owned(); 4]
        );
        assert_eq!(
            normalized[0].0.equipment.misc2.crystals,
            vec!["GreenInferno".to_owned(); 4]
        );
    }

    #[test]
    fn adaptive_stat_search_matches_exhaustive_best() {
        let catalogs = Catalogs::bundled().unwrap();
        let build = catalogs.build("ShadowDojoDLGunBuild3").unwrap();
        let opponent_ids = [
            "ShadowDojoArmorStackCores",
            "ShadowDojoDLGunBuild3",
            "ShadowDojoHFCoreVoid",
            "ShadowDojoSG1SplitBombs",
        ]
        .map(str::to_owned)
        .to_vec();
        let opponents = opponent_ids
            .iter()
            .map(|key| {
                catalogs
                    .materialize(catalogs.build(key).unwrap(), MatchupRole::Active)
                    .unwrap()
            })
            .collect::<Vec<_>>();
        let hp_points = HashSet::from([2]);
        let exhaustive_groups = stat_allocation_groups(
            &catalogs,
            build,
            &opponents,
            &[AttackType::Normal],
            Some(&hp_points),
            1,
        )
        .unwrap();
        let exhaustive =
            candidate_frontiers(&exhaustive_groups, &opponents, &opponent_ids, None, 1e-6).unwrap();
        let adaptive = adaptive_stat_frontiers(
            &catalogs,
            build,
            &opponents,
            &opponent_ids,
            &[AttackType::Normal],
            &AdaptiveStatOptions {
                hp_points: Some(hp_points),
                minimum_survival_probability: 1e-6,
                weighted_best_only: true,
                ..AdaptiveStatOptions::default()
            },
        )
        .unwrap();
        assert!(adaptive.converged);
        assert_eq!(
            adaptive.exact.best_weighted.unwrap().signature,
            exhaustive.best_weighted.unwrap().signature
        );
        assert!(adaptive.search_candidate_count < exhaustive_groups.len());
    }

    #[test]
    fn joint_response_combines_equipment_and_stats() {
        let catalogs = Catalogs::bundled().unwrap();
        let build = catalogs.build("ShadowDojoDLGunBuild2").unwrap();
        let opponent_ids = vec!["ShadowDojoDLGunBuild2".to_owned()];
        let opponents = vec![catalogs.materialize(build, MatchupRole::Active).unwrap()];
        let equipment_options = EquipmentNeighborhoodOptions {
            slots: vec![EquipmentSlot::Weapon1],
            item_keys_by_slot: HashMap::from([(
                EquipmentSlot::Weapon1,
                vec!["RiftGun".to_owned(), "AlienRifle".to_owned()],
            )]),
            crystal_keys: Some(vec!["PerfectFire".to_owned()]),
            socket_capacity: 1,
            ..EquipmentNeighborhoodOptions::default()
        };
        let response = joint_equipment_stat_response_beam(
            &catalogs,
            build,
            &opponents,
            &opponent_ids,
            Some(&[1.0]),
            &[AttackType::Normal],
            &equipment_options,
            &AdaptiveStatOptions {
                point_strides: vec![20],
                hp_points: Some(HashSet::from([build.stats.hp])),
                converge: false,
                ..AdaptiveStatOptions::default()
            },
            1e-6,
            2,
            1,
            2,
            1e-6,
        )
        .unwrap();
        assert!(!response.beam.is_empty());
        assert!(response
            .beam
            .iter()
            .all(|entry| (0.0..=1.0).contains(&entry.weighted_score)));
        assert!(!response.iterations.is_empty());
    }
}
