use std::collections::HashMap;

use anyhow::Result;
use serde::Serialize;

use crate::catalog::{BuildCatalog, Catalogs};
use crate::combat::combat_signature;
use crate::exact::DefeatRoundCache;
use crate::game::{
    dominance_frontier, iterated_dominance_kernel, mixed_equilibrium, pure_maximin,
    role_averaged_matchup, MatchupMetrics,
};
use crate::model::{CombatSignature, MatchupRole, Player};

/// Per-candidate aggregate metrics from a catalog analysis.
#[derive(Clone, Debug, Serialize)]
pub struct CandidateAnalysis {
    /// Representative build key.
    pub id: String,
    /// Combat-equivalent source build keys.
    pub build_keys: Vec<String>,
    /// Unique display names represented by the group.
    pub names: Vec<String>,
    /// Whether no other candidate componentwise dominates this candidate.
    pub frontier: bool,
    /// Representative IDs that dominate this candidate.
    pub dominated_by: Vec<String>,
    /// Lowest score against any candidate.
    pub worst_score: f64,
    /// Mean score against a uniform field.
    pub average_score: f64,
    /// Mean win probability against a uniform field.
    pub average_win_probability: f64,
    /// Mean draw probability against a uniform field.
    pub average_draw_rate: f64,
    /// Mean unconditional HP lost.
    pub average_hp_lost: f64,
    /// Win-probability-weighted HP lost conditional on winning.
    pub average_hp_lost_on_win: Option<f64>,
    /// Win-probability-weighted zero-damage probability conditional on winning.
    pub average_zero_damage_win_probability: Option<f64>,
    /// Mean unconditional healing cost.
    pub average_healing_cost: f64,
    /// Win-probability-weighted healing cost conditional on winning.
    pub average_healing_cost_on_win: Option<f64>,
    /// Mean healing credits divided by mean win probability.
    pub healing_credits_per_win: Option<f64>,
    /// Strongest opponent score against this pure candidate minus 0.5.
    pub exploitability: f64,
    /// Opponents attaining this candidate's worst score.
    pub limiting_opponents: Vec<String>,
}

/// Weighted equilibrium member.
#[derive(Clone, Debug, Serialize)]
pub struct StrategyWeight {
    /// Representative build key.
    pub candidate: String,
    /// Equilibrium probability.
    pub weight: f64,
}

/// Named mixed-equilibrium report.
#[derive(Clone, Debug, Serialize)]
pub struct InferredMeta {
    /// Positive-weight strategies.
    pub weights: Vec<StrategyWeight>,
    /// Best-response advantage over 0.5.
    pub exploitability: f64,
    /// Requested solver tolerance.
    pub tolerance: f64,
    /// Solver iterations.
    pub iterations: usize,
    /// Whether the requested tolerance was reached.
    pub converged: bool,
}

/// Named elimination from one dominance round.
#[derive(Clone, Debug, Serialize)]
pub struct NamedElimination {
    /// Eliminated candidate.
    pub candidate: String,
    /// Candidates dominating it in this round.
    pub dominated_by: Vec<String>,
}

/// Named iterated-dominance round.
#[derive(Clone, Debug, Serialize)]
pub struct NamedEliminationRound {
    /// Candidates active at the start of the round.
    pub active_candidates: Vec<String>,
    /// Candidates removed by the round.
    pub eliminated: Vec<NamedElimination>,
}

/// Named pure maximin result.
#[derive(Clone, Debug, Serialize)]
pub struct NamedMaximin {
    /// Best worst-case score.
    pub score: f64,
    /// Candidates attaining it.
    pub candidates: Vec<String>,
}

/// Complete deterministic analysis of one build catalog.
#[derive(Clone, Debug, Serialize)]
pub struct CatalogAnalysis {
    /// Number of source builds before equivalence grouping.
    pub source_build_count: usize,
    /// Number of combat-distinct candidates.
    pub candidate_count: usize,
    /// Aggregate candidate metrics.
    pub candidates: Vec<CandidateAnalysis>,
    /// Non-dominated candidate IDs.
    pub frontier: Vec<String>,
    /// Stable iterated-dominance kernel.
    pub strategic_kernel: Vec<String>,
    /// Named elimination history.
    pub elimination_rounds: Vec<NamedEliminationRound>,
    /// Candidate order used by every matrix.
    pub matrix_order: Vec<String>,
    /// Pure maximin result.
    pub pure_maximin: NamedMaximin,
    /// Approximate symmetric equilibrium.
    pub inferred_meta: InferredMeta,
    /// Win-plus-half-draw payoff matrix.
    pub score_matrix: Vec<Vec<f64>>,
    /// Win-probability matrix.
    pub win_probability_matrix: Vec<Vec<f64>>,
    /// Draw-probability matrix.
    pub draw_matrix: Vec<Vec<f64>>,
    /// Unconditional HP-loss matrix.
    pub hp_loss_matrix: Vec<Vec<f64>>,
    /// Conditional-on-win HP-loss matrix.
    pub win_hp_loss_matrix: Vec<Vec<Option<f64>>>,
    /// Conditional zero-damage-win matrix.
    pub zero_damage_win_matrix: Vec<Vec<Option<f64>>>,
    /// Unconditional healing-cost matrix.
    pub healing_cost_matrix: Vec<Vec<f64>>,
    /// Conditional-on-win healing-cost matrix.
    pub win_healing_cost_matrix: Vec<Vec<Option<f64>>>,
}

struct CandidateGroup {
    build_keys: Vec<String>,
    names: Vec<String>,
    player: Player,
}

/// Groups equivalent builds, evaluates every matchup, and solves the restricted game.
pub fn analyze_build_catalog(
    catalogs: &Catalogs,
    catalog: &BuildCatalog,
) -> Result<CatalogAnalysis> {
    let mut groups = Vec::<CandidateGroup>::new();
    let mut group_by_signature = HashMap::<CombatSignature, usize>::new();
    for (key, build) in catalog {
        let player = catalogs.materialize(build, MatchupRole::Active)?;
        let signature = combat_signature(&player);
        if let Some(index) = group_by_signature.get(&signature) {
            let group = &mut groups[*index];
            group.build_keys.push(key.clone());
            if !group.names.contains(&build.name) {
                group.names.push(build.name.clone());
            }
        } else {
            group_by_signature.insert(signature, groups.len());
            groups.push(CandidateGroup {
                build_keys: vec![key.clone()],
                names: vec![build.name.clone()],
                player,
            });
        }
    }

    let size = groups.len();
    let mut score_matrix = float_matrix(size);
    let mut win_probability_matrix = float_matrix(size);
    let mut draw_matrix = float_matrix(size);
    let mut hp_loss_matrix = float_matrix(size);
    let mut win_hp_loss_matrix = option_matrix(size);
    let mut zero_damage_win_matrix = option_matrix(size);
    let mut healing_cost_matrix = float_matrix(size);
    let mut win_healing_cost_matrix = option_matrix(size);
    let mut cache = DefeatRoundCache::new(0.0);

    for row in 0..size {
        let self_result = role_averaged_matchup(
            &groups[row].player,
            &groups[row].player,
            Some(&mut cache),
            true,
        );
        assign_metrics(
            row,
            row,
            self_result.candidate,
            &mut win_probability_matrix,
            &mut draw_matrix,
            &mut hp_loss_matrix,
            &mut win_hp_loss_matrix,
            &mut zero_damage_win_matrix,
            &mut healing_cost_matrix,
            &mut win_healing_cost_matrix,
        );
        score_matrix[row][row] = 0.5;
        for column in row + 1..size {
            let result = role_averaged_matchup(
                &groups[row].player,
                &groups[column].player,
                Some(&mut cache),
                true,
            );
            assign_metrics(
                row,
                column,
                result.candidate,
                &mut win_probability_matrix,
                &mut draw_matrix,
                &mut hp_loss_matrix,
                &mut win_hp_loss_matrix,
                &mut zero_damage_win_matrix,
                &mut healing_cost_matrix,
                &mut win_healing_cost_matrix,
            );
            assign_metrics(
                column,
                row,
                result.opponent.expect("opponent metrics requested"),
                &mut win_probability_matrix,
                &mut draw_matrix,
                &mut hp_loss_matrix,
                &mut win_hp_loss_matrix,
                &mut zero_damage_win_matrix,
                &mut healing_cost_matrix,
                &mut win_healing_cost_matrix,
            );
            score_matrix[row][column] = result.score;
            score_matrix[column][row] = 1.0 - result.score;
        }
    }

    let frontier = dominance_frontier(&score_matrix);
    let kernel = iterated_dominance_kernel(&score_matrix);
    let maximin = pure_maximin(&score_matrix);
    let equilibrium = mixed_equilibrium(&score_matrix, 0.001, 100_000);
    let ids = groups
        .iter()
        .map(|group| group.build_keys[0].clone())
        .collect::<Vec<_>>();
    let candidates = groups
        .iter()
        .enumerate()
        .map(|(player, group)| {
            candidate_analysis(
                player,
                group,
                &ids,
                &frontier.dominated_by,
                &score_matrix,
                &win_probability_matrix,
                &draw_matrix,
                &hp_loss_matrix,
                &win_hp_loss_matrix,
                &zero_damage_win_matrix,
                &healing_cost_matrix,
                &win_healing_cost_matrix,
            )
        })
        .collect();

    Ok(CatalogAnalysis {
        source_build_count: catalog.len(),
        candidate_count: size,
        candidates,
        frontier: frontier
            .players
            .iter()
            .map(|player| ids[*player].clone())
            .collect(),
        strategic_kernel: kernel
            .players
            .iter()
            .map(|player| ids[*player].clone())
            .collect(),
        elimination_rounds: kernel
            .rounds
            .into_iter()
            .map(|round| NamedEliminationRound {
                active_candidates: round
                    .active_players
                    .iter()
                    .map(|player| ids[*player].clone())
                    .collect(),
                eliminated: round
                    .eliminated
                    .into_iter()
                    .map(|entry| NamedElimination {
                        candidate: ids[entry.player].clone(),
                        dominated_by: entry
                            .dominated_by
                            .iter()
                            .map(|player| ids[*player].clone())
                            .collect(),
                    })
                    .collect(),
            })
            .collect(),
        matrix_order: ids.clone(),
        pure_maximin: NamedMaximin {
            score: maximin.score,
            candidates: maximin
                .players
                .iter()
                .map(|player| ids[*player].clone())
                .collect(),
        },
        inferred_meta: InferredMeta {
            weights: equilibrium
                .strategy
                .iter()
                .enumerate()
                .filter(|(_, weight)| **weight > 0.0)
                .map(|(player, weight)| StrategyWeight {
                    candidate: ids[player].clone(),
                    weight: *weight,
                })
                .collect(),
            exploitability: equilibrium.exploitability,
            tolerance: equilibrium.tolerance,
            iterations: equilibrium.iterations,
            converged: equilibrium.converged,
        },
        score_matrix,
        win_probability_matrix,
        draw_matrix,
        hp_loss_matrix,
        win_hp_loss_matrix,
        zero_damage_win_matrix,
        healing_cost_matrix,
        win_healing_cost_matrix,
    })
}

#[allow(clippy::too_many_arguments)]
fn assign_metrics(
    row: usize,
    column: usize,
    result: MatchupMetrics,
    wins: &mut [Vec<f64>],
    draws: &mut [Vec<f64>],
    hp_loss: &mut [Vec<f64>],
    win_hp_loss: &mut [Vec<Option<f64>>],
    zero_damage: &mut [Vec<Option<f64>>],
    healing: &mut [Vec<f64>],
    win_healing: &mut [Vec<Option<f64>>],
) {
    wins[row][column] = result.win_probability;
    draws[row][column] = result.draw_probability;
    hp_loss[row][column] = result.expected_hp_lost;
    win_hp_loss[row][column] = result.expected_hp_lost_on_win;
    zero_damage[row][column] = result.zero_damage_win_probability;
    healing[row][column] = result.expected_healing_cost;
    win_healing[row][column] = result.expected_healing_cost_on_win;
}

#[allow(clippy::too_many_arguments)]
fn candidate_analysis(
    player: usize,
    group: &CandidateGroup,
    ids: &[String],
    dominated_by: &[Vec<usize>],
    scores: &[Vec<f64>],
    wins: &[Vec<f64>],
    draws: &[Vec<f64>],
    hp_loss: &[Vec<f64>],
    win_hp_loss: &[Vec<Option<f64>>],
    zero_damage: &[Vec<Option<f64>>],
    healing: &[Vec<f64>],
    win_healing: &[Vec<Option<f64>>],
) -> CandidateAnalysis {
    let worst_score = scores[player].iter().copied().fold(f64::INFINITY, f64::min);
    let average_win_probability = mean(&wins[player]);
    let limiting_opponents = scores[player]
        .iter()
        .enumerate()
        .filter(|(_, score)| (*score - worst_score).abs() <= 1e-12)
        .map(|(opponent, _)| ids[opponent].clone())
        .collect();
    let best_response_score = scores
        .iter()
        .map(|row| row[player])
        .fold(f64::NEG_INFINITY, f64::max);
    CandidateAnalysis {
        id: ids[player].clone(),
        build_keys: group.build_keys.clone(),
        names: group.names.clone(),
        frontier: dominated_by[player].is_empty(),
        dominated_by: dominated_by[player]
            .iter()
            .map(|other| ids[*other].clone())
            .collect(),
        worst_score,
        average_score: mean(&scores[player]),
        average_win_probability,
        average_draw_rate: mean(&draws[player]),
        average_hp_lost: mean(&hp_loss[player]),
        average_hp_lost_on_win: conditional_mean(&win_hp_loss[player], &wins[player]),
        average_zero_damage_win_probability: conditional_mean(&zero_damage[player], &wins[player]),
        average_healing_cost: mean(&healing[player]),
        average_healing_cost_on_win: conditional_mean(&win_healing[player], &wins[player]),
        healing_credits_per_win: (average_win_probability > 0.0)
            .then(|| mean(&healing[player]) / average_win_probability),
        exploitability: best_response_score - 0.5,
        limiting_opponents,
    }
}

fn float_matrix(size: usize) -> Vec<Vec<f64>> {
    vec![vec![0.0; size]; size]
}

fn option_matrix(size: usize) -> Vec<Vec<Option<f64>>> {
    vec![vec![None; size]; size]
}

fn mean(values: &[f64]) -> f64 {
    values.iter().sum::<f64>() / values.len() as f64
}

fn conditional_mean(values: &[Option<f64>], wins: &[f64]) -> Option<f64> {
    let (weighted, total) = values
        .iter()
        .zip(wins)
        .filter_map(|(value, wins)| value.map(|value| (value * wins, wins)))
        .fold((0.0, 0.0), |(weighted, total), (value, wins)| {
            (weighted + value, total + wins)
        });
    (total > 0.0).then(|| weighted / total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shadow_dojo_analysis_matches_expected_kernel() {
        let catalogs = Catalogs::bundled().unwrap();
        let catalog = catalogs
            .builds()
            .filter(|(key, _)| key.starts_with("ShadowDojo"))
            .map(|(key, build)| (key.to_owned(), build.clone()))
            .collect::<BuildCatalog>();
        let analysis = analyze_build_catalog(&catalogs, &catalog).unwrap();
        assert_eq!(analysis.source_build_count, 15);
        assert_eq!(
            analysis.frontier,
            vec![
                "ShadowDojoArmorStackCores",
                "ShadowDojoDLGunBuild3",
                "ShadowDojoHFCoreVoid",
                "ShadowDojoSG1SplitBombs",
            ]
        );
        assert_eq!(analysis.strategic_kernel, vec!["ShadowDojoDLGunBuild3"]);
        assert_eq!(
            analysis.pure_maximin.candidates,
            vec!["ShadowDojoDLGunBuild3"]
        );
        assert_eq!(analysis.inferred_meta.weights.len(), 1);
        assert_eq!(
            analysis.inferred_meta.weights[0].candidate,
            "ShadowDojoDLGunBuild3"
        );
    }
}
