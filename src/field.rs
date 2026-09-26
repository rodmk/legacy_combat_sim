use std::collections::{HashMap, HashSet};

use anyhow::{bail, Result};
use serde::Serialize;

use crate::catalog::Catalogs;
use crate::combat::combat_signature;
use crate::game::candidate_matchup;
use crate::inference::{search_response_seeds, InferenceOptions};
use crate::model::{AttackType, BuildDefinition, CombatSignature, MatchupRole, Player, WeaponType};
use crate::search::{
    adaptive_stat_frontiers, equipment_concept_signature, AdaptiveStatOptions,
    EquipmentNeighborhoodOptions,
};

/// An observed opponent and its relative encounter frequency.
#[derive(Clone)]
pub struct FieldOpponent {
    /// Catalog identifier.
    pub id: String,
    /// Complete observed build.
    pub build: BuildDefinition,
    /// Nonnegative relative frequency.
    pub weight: f64,
}

/// Search budget for field suggestions.
#[derive(Clone, Debug)]
pub struct FieldSuggestionOptions {
    /// Enumerate owned equipment concepts before selecting search seeds.
    pub inventory_first: bool,
    /// Maximum number of distinct concepts sent to joint response search.
    pub search_seeds: usize,
    /// Joint response passes for each selected seed.
    pub search_iterations: usize,
    /// Coarse search results receiving finer stat refinement.
    pub refinement_seeds: usize,
    /// Number of distinct final builds returned.
    pub result_count: usize,
    /// Joint response search configuration.
    pub inference: InferenceOptions,
}

impl Default for FieldSuggestionOptions {
    fn default() -> Self {
        Self {
            inventory_first: false,
            search_seeds: 4,
            search_iterations: 1,
            refinement_seeds: 2,
            result_count: 5,
            inference: InferenceOptions {
                beam_width: 4,
                expansion_width: 1,
                equipment: EquipmentNeighborhoodOptions {
                    fixed_equipment: true,
                    ..EquipmentNeighborhoodOptions::default()
                },
                ..InferenceOptions::default()
            },
        }
    }
}

/// Exact field score for one build.
#[derive(Clone, Debug, Serialize)]
pub struct FieldSuggestion {
    /// Source build or search seed identifier.
    pub source: String,
    /// Exact weighted win-plus-half-draw score.
    pub score: f64,
    /// Weighted score when this build is the active combatant.
    pub offense_score: f64,
    /// Weighted score when this build is the defending combatant.
    pub defense_score: f64,
    /// Weighted standard deviation of matchup scores across opponents.
    pub opponent_score_stddev: f64,
    /// Weighted lower decile of matchup scores.
    pub opponent_score_p10: f64,
    /// Minimum and maximum score after removing one positive-weight opponent.
    pub leave_one_out_score_range: Option<(f64, f64)>,
    /// Lowest score against any observed opponent.
    pub worst_score: f64,
    /// Scores in the same order as the input field.
    pub opponent_scores: Vec<f64>,
    /// Directional scores in the same order as the input field.
    pub directional_scores: Vec<DirectionalScore>,
    /// Complete suggested build.
    pub build: BuildDefinition,
}

/// Exact candidate payoffs in each combat role against one opponent.
#[derive(Clone, Copy, Debug, Serialize)]
pub struct DirectionalScore {
    /// Candidate active, opponent defending.
    pub offense: f64,
    /// Opponent active, candidate defending.
    pub defense: f64,
    /// Equal-weight average of both roles.
    pub average: f64,
}

/// Exact baseline and strongest distinct field suggestions.
#[derive(Clone, Debug, Serialize)]
pub struct FieldSuggestionReport {
    /// Observed opponent identifiers and normalized weights.
    pub field: Vec<(String, f64)>,
    /// Whether suggestions are limited to owned inventory.
    pub inventory_constrained: bool,
    /// Whether owned equipment combinations supplied the initial search concepts.
    pub inventory_first: bool,
    /// Exact score of the supplied current build.
    pub current: FieldSuggestion,
    /// Unique equipment concepts considered as search starts.
    pub observed_seed_count: usize,
    /// Starting points sent to joint search.
    pub searched_seeds: Vec<String>,
    /// Coarse responses receiving finer stat refinement.
    pub refined_seeds: Vec<String>,
    /// Exact top builds from observed seeds and joint search.
    pub suggestions: Vec<FieldSuggestion>,
}

struct Seed {
    id: String,
    build: BuildDefinition,
    score: f64,
    profile: (WeaponType, WeaponType),
}

/// Scores observed builds, refines diverse leaders, and validates final scores exactly.
pub fn suggest_field_builds(
    catalogs: &Catalogs,
    current_id: &str,
    current: &BuildDefinition,
    field: &[FieldOpponent],
    options: &FieldSuggestionOptions,
) -> Result<FieldSuggestionReport> {
    if field.is_empty() || options.result_count == 0 || options.search_iterations == 0 {
        bail!("field, result count, and search iterations must be positive");
    }
    if field
        .iter()
        .any(|entry| !entry.weight.is_finite() || entry.weight < 0.0)
    {
        bail!("field weights must be finite and nonnegative");
    }
    if let Some(inventory) = &options.inference.equipment.inventory {
        inventory.validate(catalogs)?;
        let shortages = inventory.shortages(current);
        if !shortages.is_empty() {
            bail!(
                "starting build {current_id} is not in inventory: {}; select an owned build with --build",
                shortages.join(", ")
            );
        }
    } else if options.inventory_first {
        bail!("inventory-first search requires an inventory");
    }
    let total_weight = field.iter().map(|entry| entry.weight).sum::<f64>();
    if total_weight <= 0.0 {
        bail!("field weights must have positive total mass");
    }
    let weights = field
        .iter()
        .map(|entry| entry.weight / total_weight)
        .collect::<Vec<_>>();
    let opponents = field
        .iter()
        .map(|entry| catalogs.materialize(&entry.build, MatchupRole::Active))
        .collect::<Result<Vec<_>>>()?;
    let opponent_ids = field
        .iter()
        .map(|entry| entry.id.clone())
        .collect::<Vec<_>>();
    let current_score = score_build(catalogs, current_id, current, &opponents, &weights)?;

    let mut starting_builds = Vec::new();
    if options.inventory_first {
        let inventory = options.inference.equipment.inventory.as_ref().unwrap();
        starting_builds.extend(
            inventory
                .equipment_seeds(catalogs, current)?
                .into_iter()
                .enumerate()
                .map(|(index, build)| (format!("InventoryConcept{:03}", index + 1), build)),
        );
    } else {
        starting_builds.push((current_id.to_owned(), current.clone()));
        starting_builds.extend(
            field
                .iter()
                .filter(|entry| {
                    options
                        .inference
                        .equipment
                        .inventory
                        .as_ref()
                        .is_none_or(|inventory| inventory.contains(&entry.build))
                })
                .map(|entry| (entry.id.clone(), entry.build.clone())),
        );
    }
    let mut observed = Vec::new();
    for (id, build) in starting_builds {
        let player = catalogs.materialize(&build, MatchupRole::Active)?;
        let mut types = [player.weapon1.weapon_type, player.weapon2.weapon_type];
        types.sort();
        let score = score_build(catalogs, &id, &build, &opponents, &weights)?.score;
        observed.push(Seed {
            id,
            build,
            score,
            profile: (types[0], types[1]),
        });
    }
    observed.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| left.id.cmp(&right.id))
    });
    let mut seeds = Vec::new();
    let mut concepts = HashSet::new();
    if let Some(current) = observed.iter().find(|seed| seed.id == current_id) {
        concepts.insert(equipment_concept_signature(&current.build));
        seeds.push(current);
    }
    for seed in &observed {
        if concepts.insert(equipment_concept_signature(&seed.build)) {
            seeds.push(seed);
        }
    }
    let observed_seed_count = seeds.len();
    seeds.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| left.id.cmp(&right.id))
    });
    let mut selected = Vec::new();
    let mut selected_ids = HashSet::new();
    if options.search_seeds > 0 {
        if !options.inventory_first {
            if let Some(seed) = seeds.iter().find(|seed| seed.id == current_id) {
                selected_ids.insert(seed.id.clone());
                selected.push(seed);
            }
        }
        let mut profiles = selected
            .iter()
            .map(|seed| seed.profile)
            .collect::<HashSet<_>>();
        for seed in &seeds {
            if selected.len() == options.search_seeds {
                break;
            }
            if profiles.insert(seed.profile) && selected_ids.insert(seed.id.clone()) {
                selected.push(seed);
            }
        }
        for seed in &seeds {
            if selected.len() == options.search_seeds {
                break;
            }
            if selected_ids.insert(seed.id.clone()) {
                selected.push(seed);
            }
        }
    }

    let responses = search_response_seeds(
        catalogs,
        &selected
            .iter()
            .map(|seed| seed.build.clone())
            .collect::<Vec<_>>(),
        &opponents,
        &opponent_ids,
        &weights,
        &options.inference,
        options.search_iterations,
    )?;
    let mut candidates = observed
        .iter()
        .map(|seed| (seed.id.clone(), seed.build.clone()))
        .collect::<Vec<_>>();
    let response_start = candidates.len();
    for (seed, response) in selected.iter().zip(responses) {
        for entry in response.beam {
            candidates.push((seed.id.clone(), entry.build));
        }
    }
    let mut coarse = candidates[response_start..]
        .iter()
        .map(|(source, build)| {
            score_build(catalogs, source, build, &opponents, &weights)
                .map(|scored| (source.clone(), build.clone(), scored.score))
        })
        .collect::<Result<Vec<_>>>()?;
    coarse.sort_by(|left, right| right.2.total_cmp(&left.2));
    let mut refined_concepts = HashSet::new();
    let mut refined_seeds = Vec::new();
    for (source, build, _) in coarse {
        if refined_concepts.len() >= options.refinement_seeds {
            break;
        }
        if !refined_concepts.insert(equipment_concept_signature(&build)) {
            continue;
        }
        refined_seeds.push(source.clone());
        let refined = adaptive_stat_frontiers(
            catalogs,
            &build,
            &opponents,
            &opponent_ids,
            &[
                AttackType::Normal,
                AttackType::Quick,
                AttackType::Aimed,
                AttackType::Cover,
            ],
            &AdaptiveStatOptions {
                point_strides: vec![11, 5, 2],
                minimum_survival_probability: options.inference.stats.minimum_survival_probability,
                opponent_weights: Some(weights.clone()),
                weighted_best_only: true,
                converge: false,
                ..options.inference.stats.clone()
            },
        )?;
        if let Some(best) = refined.exact.best_weighted {
            let stat_source = &best.sources[0];
            let mut build = build;
            build.stats = stat_source.stats;
            build.attack_type = stat_source.attack_type;
            candidates.push((source, build));
        }
    }
    let mut by_signature = HashMap::<CombatSignature, FieldSuggestion>::new();
    for (source, build) in candidates {
        let player = catalogs.materialize(&build, MatchupRole::Active)?;
        let signature = combat_signature(&player);
        if by_signature.contains_key(&signature) {
            continue;
        }
        let scored = score_player(source, build, &player, &opponents, &weights);
        by_signature.insert(signature, scored);
    }
    let mut ranked = by_signature.into_values().collect::<Vec<_>>();
    ranked.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| right.worst_score.total_cmp(&left.worst_score))
            .then_with(|| left.source.cmp(&right.source))
    });
    let mut shown_concepts = HashSet::new();
    let suggestions = ranked
        .into_iter()
        .filter(|entry| shown_concepts.insert(equipment_concept_signature(&entry.build)))
        .take(options.result_count)
        .collect();
    Ok(FieldSuggestionReport {
        field: opponent_ids.into_iter().zip(weights).collect(),
        inventory_constrained: options.inference.equipment.inventory.is_some(),
        inventory_first: options.inventory_first,
        current: current_score,
        observed_seed_count,
        searched_seeds: selected.iter().map(|seed| seed.id.clone()).collect(),
        refined_seeds,
        suggestions,
    })
}

fn score_build(
    catalogs: &Catalogs,
    source: &str,
    build: &BuildDefinition,
    opponents: &[Player],
    weights: &[f64],
) -> Result<FieldSuggestion> {
    let player = catalogs.materialize(build, MatchupRole::Active)?;
    Ok(score_player(
        source.to_owned(),
        build.clone(),
        &player,
        opponents,
        weights,
    ))
}

fn score_player(
    source: String,
    build: BuildDefinition,
    player: &Player,
    opponents: &[Player],
    weights: &[f64],
) -> FieldSuggestion {
    let directional_scores = opponents
        .iter()
        .map(|opponent| {
            let offense = candidate_matchup(player, opponent, None, false).score;
            let defense = 1.0 - candidate_matchup(opponent, player, None, false).score;
            DirectionalScore {
                offense,
                defense,
                average: (offense + defense) / 2.0,
            }
        })
        .collect::<Vec<_>>();
    let opponent_scores = directional_scores
        .iter()
        .map(|entry| entry.average)
        .collect::<Vec<_>>();
    let score: f64 = opponent_scores
        .iter()
        .zip(weights)
        .map(|(score, weight)| score * weight)
        .sum();
    let offense_score: f64 = directional_scores
        .iter()
        .zip(weights)
        .map(|(entry, weight)| entry.offense * weight)
        .sum();
    let defense_score: f64 = directional_scores
        .iter()
        .zip(weights)
        .map(|(entry, weight)| entry.defense * weight)
        .sum();
    let opponent_score_stddev = opponent_scores
        .iter()
        .zip(weights)
        .map(|(value, weight)| weight * (value - score).powi(2))
        .sum::<f64>()
        .sqrt();
    let mut weighted_scores = opponent_scores
        .iter()
        .copied()
        .zip(weights.iter().copied())
        .collect::<Vec<_>>();
    weighted_scores.sort_by(|left, right| left.0.total_cmp(&right.0));
    let mut cumulative_weight = 0.0;
    let opponent_score_p10 = weighted_scores
        .iter()
        .find_map(|(value, weight)| {
            cumulative_weight += weight;
            (cumulative_weight >= 0.1).then_some(*value)
        })
        .unwrap_or(score);
    let leave_one_out_score_range = opponent_scores
        .iter()
        .zip(weights)
        .filter(|(_, weight)| **weight > 0.0 && **weight < 1.0)
        .map(|(value, weight)| (score - weight * value) / (1.0 - weight))
        .fold(None, |range: Option<(f64, f64)>, value| {
            Some(match range {
                Some((minimum, maximum)) => (minimum.min(value), maximum.max(value)),
                None => (value, value),
            })
        });
    let worst_score = opponent_scores
        .iter()
        .copied()
        .fold(f64::INFINITY, f64::min);
    FieldSuggestion {
        source,
        score,
        offense_score,
        defense_score,
        opponent_score_stddev,
        opponent_score_p10,
        leave_one_out_score_range,
        worst_score,
        opponent_scores,
        directional_scores,
        build,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::role_averaged_matchup;
    use crate::inventory::Inventory;

    #[test]
    fn field_weights_control_exact_scores_and_are_normalized() {
        let catalogs = Catalogs::bundled().unwrap();
        let current = catalogs.build("CurrentBuild").unwrap();
        let field = [
            FieldOpponent {
                id: "LiveSample001".to_owned(),
                build: catalogs.build("LiveSample001").unwrap().clone(),
                weight: 3.0,
            },
            FieldOpponent {
                id: "LiveSample002".to_owned(),
                build: catalogs.build("LiveSample002").unwrap().clone(),
                weight: 1.0,
            },
        ];
        let report = suggest_field_builds(
            &catalogs,
            "CurrentBuild",
            current,
            &field,
            &FieldSuggestionOptions {
                search_seeds: 0,
                result_count: 3,
                ..FieldSuggestionOptions::default()
            },
        )
        .unwrap();
        assert_eq!(report.field[0].1, 0.75);
        assert_eq!(report.field[1].1, 0.25);
        let expected =
            report.current.opponent_scores[0] * 0.75 + report.current.opponent_scores[1] * 0.25;
        assert!((report.current.score - expected).abs() < 1e-12);
        assert!(
            (report.current.score
                - (report.current.offense_score + report.current.defense_score) / 2.0)
                .abs()
                < 1e-12
        );
        for (average, directional) in report
            .current
            .opponent_scores
            .iter()
            .zip(&report.current.directional_scores)
        {
            assert!((average - directional.average).abs() < 1e-12);
            assert!((average - (directional.offense + directional.defense) / 2.0).abs() < 1e-12);
        }
        let current_player = catalogs.materialize(current, MatchupRole::Active).unwrap();
        let first_opponent = catalogs
            .materialize(&field[0].build, MatchupRole::Active)
            .unwrap();
        let prior_score =
            role_averaged_matchup(&current_player, &first_opponent, None, false).score;
        assert!((report.current.opponent_scores[0] - prior_score).abs() < 1e-12);
        let expected_variance = report
            .current
            .opponent_scores
            .iter()
            .zip([0.75, 0.25])
            .map(|(score, weight)| weight * (score - expected).powi(2))
            .sum::<f64>();
        assert!((report.current.opponent_score_stddev.powi(2) - expected_variance).abs() < 1e-12);
        assert_eq!(
            report.current.opponent_score_p10,
            report
                .current
                .opponent_scores
                .iter()
                .copied()
                .fold(f64::INFINITY, f64::min)
        );
        let leave_one_out = report.current.leave_one_out_score_range.unwrap();
        let scores = &report.current.opponent_scores;
        assert!((leave_one_out.0 - scores[0].min(scores[1])).abs() < 1e-12);
        assert!((leave_one_out.1 - scores[0].max(scores[1])).abs() < 1e-12);
        assert!(report.suggestions[0].score >= report.current.score);
        let concepts = report
            .suggestions
            .iter()
            .map(|entry| equipment_concept_signature(&entry.build))
            .collect::<HashSet<_>>();
        assert_eq!(concepts.len(), report.suggestions.len());
        assert!(report.refined_seeds.is_empty());
    }

    #[test]
    fn inventory_limits_seeds_but_not_field_opponents() {
        let catalogs = Catalogs::bundled().unwrap();
        let current = catalogs.build("CurrentBuild").unwrap();
        let inventory: Inventory = serde_json::from_value(serde_json::json!({
            "items": {"DarkLegionArmor": 1, "RiftGun": 2, "BioSpinalEnhancer": 2},
            "crystals": {"CorruptedWater": 4, "AmuletCrystal": 8, "CorruptedPink": 3, "PerfectPink": 5},
            "mods": {}
        }))
        .unwrap();
        let field = [FieldOpponent {
            id: "LiveSample001".to_owned(),
            build: catalogs.build("LiveSample001").unwrap().clone(),
            weight: 1.0,
        }];
        let report = suggest_field_builds(
            &catalogs,
            "CurrentBuild",
            current,
            &field,
            &FieldSuggestionOptions {
                search_seeds: 0,
                inference: InferenceOptions {
                    equipment: EquipmentNeighborhoodOptions {
                        inventory: Some(inventory.clone()),
                        ..EquipmentNeighborhoodOptions::default()
                    },
                    ..InferenceOptions::default()
                },
                ..FieldSuggestionOptions::default()
            },
        )
        .unwrap();
        assert!(report.inventory_constrained);
        assert_eq!(report.field.len(), 1);
        assert_eq!(report.observed_seed_count, 1);
        assert!(report
            .suggestions
            .iter()
            .all(|entry| inventory.contains(&entry.build)));
    }

    #[test]
    fn inventory_first_uses_owned_concepts_without_current_seed() {
        let catalogs = Catalogs::bundled().unwrap();
        let current = catalogs.build("CurrentBuild").unwrap();
        let inventory: Inventory = serde_json::from_value(serde_json::json!({
            "items": {"DarkLegionArmor": 1, "RiftGun": 2, "BioSpinalEnhancer": 2},
            "crystals": {"CorruptedWater": 4, "AmuletCrystal": 8, "CorruptedPink": 3, "PerfectPink": 5},
            "mods": {}
        }))
        .unwrap();
        let field = [FieldOpponent {
            id: "LiveSample001".to_owned(),
            build: catalogs.build("LiveSample001").unwrap().clone(),
            weight: 1.0,
        }];
        let report = suggest_field_builds(
            &catalogs,
            "CurrentBuild",
            current,
            &field,
            &FieldSuggestionOptions {
                inventory_first: true,
                search_seeds: 0,
                inference: InferenceOptions {
                    equipment: EquipmentNeighborhoodOptions {
                        inventory: Some(inventory),
                        ..EquipmentNeighborhoodOptions::default()
                    },
                    ..InferenceOptions::default()
                },
                ..FieldSuggestionOptions::default()
            },
        )
        .unwrap();
        assert!(report.inventory_first);
        assert_eq!(report.observed_seed_count, 1);
        assert_eq!(report.suggestions[0].source, "InventoryConcept001");
    }
}
