use std::collections::{HashMap, HashSet};

use anyhow::{bail, Result};
use serde::Serialize;

use crate::catalog::Catalogs;
use crate::combat::combat_signature;
use crate::exact::DefeatRoundCache;
use crate::game::role_averaged_matchup;
use crate::model::{
    AttackType, BuildDefinition, CombatSignature, MatchupRole, Player, StatAllocation,
};

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

/// Candidate metrics against a fixed opponent set.
#[derive(Clone, Debug)]
pub struct FrontierCandidate {
    /// Canonical combat signature.
    pub signature: CombatSignature,
    /// Materialized representative.
    pub representative: Player,
    /// Source allocations represented by the candidate.
    pub sources: Vec<StatAllocationSource>,
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
pub struct CandidateFrontiers {
    /// Opponent identifiers.
    pub opponent_ids: Vec<String>,
    /// Normalized opponent weights.
    pub opponent_weights: Vec<f64>,
    /// Evaluated candidate count.
    pub candidate_count: usize,
    /// Evaluated matchup count.
    pub evaluated_matchups: usize,
    /// Componentwise combat frontier.
    pub combat_frontier: Vec<FrontierCandidate>,
    /// Combat-plus-economy frontier.
    pub combat_economy_frontier: Vec<FrontierCandidate>,
    /// Candidate with the strongest worst matchup.
    pub best_worst_case: Option<FrontierCandidate>,
    /// Candidate with the strongest uniform average.
    pub best_average: Option<FrontierCandidate>,
    /// Candidate with the strongest weighted score.
    pub best_weighted: Option<FrontierCandidate>,
    /// Candidate with the lowest credits per win.
    pub cheapest_per_win: Option<FrontierCandidate>,
    /// Cheapest candidate whose uniform average score is at least 0.5.
    pub cheapest_average_winner: Option<FrontierCandidate>,
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

/// Evaluates stat groups and retains combat and economic Pareto frontiers.
pub fn candidate_frontiers(
    groups: &[StatAllocationGroup],
    opponents: &[Player],
    opponent_ids: &[String],
    opponent_weights: Option<&[f64]>,
    minimum_survival_probability: f64,
) -> Result<CandidateFrontiers> {
    if opponents.is_empty() || opponents.len() != opponent_ids.len() {
        bail!("opponents and opponent IDs must be non-empty and have equal length");
    }
    let weights = opponent_weights
        .map(<[f64]>::to_vec)
        .unwrap_or_else(|| vec![1.0 / opponents.len() as f64; opponents.len()]);
    if weights.len() != opponents.len() || (weights.iter().sum::<f64>() - 1.0).abs() > 1e-12 {
        bail!("opponent weights must match the opponents and sum to one");
    }
    let mut cache = DefeatRoundCache::new(minimum_survival_probability);
    let mut combat_frontier = Vec::new();
    let mut economy_frontier = Vec::new();
    let mut best_worst_case: Option<FrontierCandidate> = None;
    let mut best_average: Option<FrontierCandidate> = None;
    let mut best_weighted: Option<FrontierCandidate> = None;
    let mut cheapest_per_win: Option<FrontierCandidate> = None;
    let mut cheapest_average_winner: Option<FrontierCandidate> = None;
    for group in groups {
        let matchups = opponents
            .iter()
            .map(|opponent| {
                role_averaged_matchup(&group.representative, opponent, Some(&mut cache), false)
            })
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
            signature: group.signature.clone(),
            representative: group.representative.clone(),
            sources: group.sources.clone(),
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
    }
    Ok(CandidateFrontiers {
        opponent_ids: opponent_ids.to_vec(),
        opponent_weights: weights,
        candidate_count: groups.len(),
        evaluated_matchups: groups.len() * opponents.len(),
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

fn mean(values: &[f64]) -> f64 {
    values.iter().sum::<f64>() / values.len() as f64
}

fn dominates(left: &FrontierCandidate, right: &FrontierCandidate, economy: bool) -> bool {
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

fn add_to_frontier(
    frontier: &mut Vec<FrontierCandidate>,
    candidate: FrontierCandidate,
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

fn replace_if(
    selected: &mut Option<FrontierCandidate>,
    candidate: &FrontierCandidate,
    better: impl Fn(&FrontierCandidate, &FrontierCandidate) -> bool,
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
}
