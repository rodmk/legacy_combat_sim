use serde::Serialize;

use crate::exact::{combat_result_distribution, CombatResult, DefeatRoundCache, PlayerResult};
use crate::model::Player;

/// Dense row-player payoff matrix.
pub type PayoffMatrix = Vec<Vec<f64>>;

/// Health and economy metrics for one side of a matchup.
#[derive(Clone, Copy, Debug, Serialize)]
pub struct MatchupMetrics {
    /// Probability of winning.
    pub win_probability: f64,
    /// Probability of a draw.
    pub draw_probability: f64,
    /// Unconditional expected HP lost.
    pub expected_hp_lost: f64,
    /// Expected HP lost conditional on winning.
    pub expected_hp_lost_on_win: Option<f64>,
    /// Probability of taking zero damage conditional on winning.
    pub zero_damage_win_probability: Option<f64>,
    /// Unconditional expected healing cost.
    pub expected_healing_cost: f64,
    /// Expected healing cost conditional on winning.
    pub expected_healing_cost_on_win: Option<f64>,
}

/// Directional or role-averaged matchup result.
#[derive(Clone, Copy, Debug, Serialize)]
pub struct MatchupResult {
    /// Candidate metrics.
    #[serde(flatten)]
    pub candidate: MatchupMetrics,
    /// Win-plus-half-draw payoff.
    pub score: f64,
    /// Error bound caused by optional combat-tail truncation.
    pub score_error_bound: f64,
    /// Opponent metrics when requested.
    pub opponent: Option<MatchupMetrics>,
}

/// Set of equally scoring best responses.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct BestResponse {
    /// Best attainable payoff.
    pub score: f64,
    /// Indices attaining the best payoff.
    pub players: Vec<usize>,
}

/// Approximate symmetric mixed equilibrium.
#[derive(Clone, Debug, Serialize)]
pub struct MixedEquilibrium {
    /// Probability assigned to each player.
    pub strategy: Vec<f64>,
    /// Best-response advantage over 0.5.
    pub exploitability: f64,
    /// Requested convergence tolerance.
    pub tolerance: f64,
    /// Fictitious-play iterations performed.
    pub iterations: usize,
    /// Whether exploitability reached the requested tolerance.
    pub converged: bool,
}

/// Pure-strategy dominance frontier.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DominanceFrontier {
    /// Non-dominated player indices.
    pub players: Vec<usize>,
    /// Direct dominators for every player.
    pub dominated_by: Vec<Vec<usize>>,
}

/// One elimination in an iterated-dominance round.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Elimination {
    /// Eliminated original player index.
    pub player: usize,
    /// Original player indices dominating it in this round.
    pub dominated_by: Vec<usize>,
}

/// One round of iterated dominance.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct EliminationRound {
    /// Players active at the beginning of the round.
    pub active_players: Vec<usize>,
    /// Players removed by the round.
    pub eliminated: Vec<Elimination>,
}

/// Stable kernel after iterated pure-strategy elimination.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DominanceKernel {
    /// Surviving original player indices.
    pub players: Vec<usize>,
    /// Elimination history.
    pub rounds: Vec<EliminationRound>,
}

/// Evaluates a directional active-versus-opponent matchup.
///
/// The opponent is restored to normal mode. When active-mode speed ties the
/// opponent's normal-mode speed, both caller initiative orders are averaged.
pub fn candidate_matchup(
    active: &Player,
    opponent: &Player,
    cache: Option<&mut DefeatRoundCache>,
    include_opponent: bool,
) -> MatchupResult {
    let normal_opponent = opponent.in_normal_mode();
    let mut cache = cache;
    let forward = combat_result_distribution(active, &normal_opponent, cache.as_deref_mut());
    let mut candidate_results = vec![forward.player1];
    let mut opponent_results = vec![forward.player2];
    let mut outcomes = vec![forward];
    if active.stats.speed == normal_opponent.stats.speed {
        let reverse = combat_result_distribution(&normal_opponent, active, cache);
        candidate_results.push(reverse.player2);
        opponent_results.push(reverse.player1);
        outcomes.push(reverse_caller_order(reverse));
    }
    let candidate = aggregate_metrics(&candidate_results, &outcomes, true);
    MatchupResult {
        candidate,
        score: outcomes
            .iter()
            .map(|result| result.outcome.player1_wins + result.outcome.draws / 2.0)
            .sum::<f64>()
            / outcomes.len() as f64,
        score_error_bound: outcomes
            .iter()
            .map(|result| result.outcome_error_bound)
            .sum::<f64>()
            / outcomes.len() as f64,
        opponent: include_opponent.then(|| aggregate_metrics(&opponent_results, &outcomes, false)),
    }
}

/// Averages a matchup across both active/opponent roles.
pub fn role_averaged_matchup(
    player: &Player,
    opponent: &Player,
    cache: Option<&mut DefeatRoundCache>,
    include_opponent: bool,
) -> MatchupResult {
    let mut cache = cache;
    let attacking = candidate_matchup(player, opponent, cache.as_deref_mut(), true);
    let defending = candidate_matchup(opponent, player, cache, true);
    let attacking_opponent = attacking.opponent.expect("opponent metrics requested");
    let defending_opponent = defending.opponent.expect("opponent metrics requested");
    MatchupResult {
        candidate: combine_metrics(attacking.candidate, defending_opponent),
        score: (attacking.score + 1.0 - defending.score) / 2.0,
        score_error_bound: (attacking.score_error_bound + defending.score_error_bound) / 2.0,
        opponent: include_opponent
            .then(|| combine_metrics(attacking_opponent, defending.candidate)),
    }
}

/// Builds an antisymmetric role-averaged payoff matrix.
pub fn payoff_matrix(players: &[Player]) -> PayoffMatrix {
    let mut matrix = vec![vec![0.0; players.len()]; players.len()];
    let mut cache = DefeatRoundCache::new(0.0);
    for index in 0..players.len() {
        matrix[index][index] = 0.5;
        for opponent in index + 1..players.len() {
            let score =
                role_averaged_matchup(&players[index], &players[opponent], Some(&mut cache), false)
                    .score;
            matrix[index][opponent] = score;
            matrix[opponent][index] = 1.0 - score;
        }
    }
    matrix
}

/// Scores one mixed strategy against every pure opponent.
pub fn strategy_scores(matrix: &[Vec<f64>], strategy: &[f64]) -> Vec<f64> {
    (0..matrix.len())
        .map(|opponent| {
            strategy
                .iter()
                .enumerate()
                .map(|(player, probability)| probability * matrix[player][opponent])
                .sum()
        })
        .collect()
}

/// Returns the lowest pure-opponent score for a mixed strategy.
pub fn worst_case_score(matrix: &[Vec<f64>], strategy: &[f64]) -> f64 {
    strategy_scores(matrix, strategy)
        .into_iter()
        .fold(f64::INFINITY, f64::min)
}

/// Finds all pure best responses to an opponent mixture.
pub fn best_response(matrix: &[Vec<f64>], opponent_strategy: &[f64]) -> BestResponse {
    let scores = matrix
        .iter()
        .map(|row| {
            row.iter()
                .zip(opponent_strategy)
                .map(|(payoff, probability)| payoff * probability)
                .sum::<f64>()
        })
        .collect::<Vec<_>>();
    let score = scores.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    BestResponse {
        score,
        players: tied_indices(&scores, score),
    }
}

/// Best-response advantage over the symmetric game value of 0.5.
pub fn exploitability(matrix: &[Vec<f64>], strategy: &[f64]) -> f64 {
    best_response(matrix, strategy).score - 0.5
}

/// Finds pure strategies with the strongest worst-case payoff.
pub fn pure_maximin(matrix: &[Vec<f64>]) -> BestResponse {
    let scores = matrix
        .iter()
        .map(|row| row.iter().copied().fold(f64::INFINITY, f64::min))
        .collect::<Vec<_>>();
    let score = scores.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    BestResponse {
        score,
        players: tied_indices(&scores, score),
    }
}

/// Approximates a symmetric equilibrium with fictitious play.
pub fn mixed_equilibrium(
    matrix: &[Vec<f64>],
    tolerance: f64,
    max_iterations: usize,
) -> MixedEquilibrium {
    let pure = pure_maximin(matrix);
    if pure.score >= 0.5 - 1e-12 {
        let probability = 1.0 / pure.players.len() as f64;
        let strategy = (0..matrix.len())
            .map(|player| {
                if pure.players.contains(&player) {
                    probability
                } else {
                    0.0
                }
            })
            .collect::<Vec<_>>();
        return MixedEquilibrium {
            exploitability: exploitability(matrix, &strategy),
            strategy,
            tolerance,
            iterations: 0,
            converged: true,
        };
    }

    let mut row_counts = vec![1.0; matrix.len()];
    let mut column_counts = vec![1.0; matrix.len()];
    let mut strategy = normalize(&row_counts);
    let mut current_exploitability = exploitability(matrix, &strategy);
    for iteration in 1..=max_iterations {
        let row_strategy = normalize(&row_counts);
        let column_strategy = normalize(&column_counts);
        let row_response = best_response(matrix, &column_strategy);
        let column_scores = strategy_scores(matrix, &row_strategy);
        let minimum = column_scores.iter().copied().fold(f64::INFINITY, f64::min);
        let column_responses = tied_indices(&column_scores, minimum);
        for player in &row_response.players {
            row_counts[*player] += 1.0 / row_response.players.len() as f64;
        }
        for player in &column_responses {
            column_counts[*player] += 1.0 / column_responses.len() as f64;
        }
        let rows = normalize(&row_counts);
        let columns = normalize(&column_counts);
        strategy = rows
            .iter()
            .zip(columns)
            .map(|(row, column)| (row + column) / 2.0)
            .collect();
        current_exploitability = exploitability(matrix, &strategy);
        if current_exploitability <= tolerance {
            return MixedEquilibrium {
                strategy,
                exploitability: current_exploitability,
                tolerance,
                iterations: iteration,
                converged: true,
            };
        }
    }
    MixedEquilibrium {
        strategy,
        exploitability: current_exploitability,
        tolerance,
        iterations: max_iterations,
        converged: false,
    }
}

/// Finds the pure-strategy componentwise dominance frontier.
pub fn dominance_frontier(matrix: &[Vec<f64>]) -> DominanceFrontier {
    let mut dominated_by = vec![Vec::new(); matrix.len()];
    for candidate in 0..matrix.len() {
        for other in 0..matrix.len() {
            if candidate != other && dominates(&matrix[other], &matrix[candidate]) {
                dominated_by[candidate].push(other);
            }
        }
    }
    DominanceFrontier {
        players: dominated_by
            .iter()
            .enumerate()
            .filter_map(|(player, dominators)| dominators.is_empty().then_some(player))
            .collect(),
        dominated_by,
    }
}

/// Repeats dominance elimination until no additional strategy is removed.
pub fn iterated_dominance_kernel(matrix: &[Vec<f64>]) -> DominanceKernel {
    let mut active = (0..matrix.len()).collect::<Vec<_>>();
    let mut rounds = Vec::new();
    while active.len() > 1 {
        let restricted = active
            .iter()
            .map(|player| {
                active
                    .iter()
                    .map(|opponent| matrix[*player][*opponent])
                    .collect()
            })
            .collect::<Vec<Vec<f64>>>();
        let frontier = dominance_frontier(&restricted);
        let survivors = frontier
            .players
            .iter()
            .map(|player| active[*player])
            .collect();
        let eliminated = active
            .iter()
            .enumerate()
            .filter_map(|(restricted_player, player)| {
                let dominators = &frontier.dominated_by[restricted_player];
                (!dominators.is_empty()).then(|| Elimination {
                    player: *player,
                    dominated_by: dominators.iter().map(|other| active[*other]).collect(),
                })
            })
            .collect::<Vec<_>>();
        if eliminated.is_empty() {
            break;
        }
        rounds.push(EliminationRound {
            active_players: active,
            eliminated,
        });
        active = survivors;
    }
    DominanceKernel {
        players: active,
        rounds,
    }
}

fn reverse_caller_order(mut result: CombatResult) -> CombatResult {
    std::mem::swap(
        &mut result.outcome.player1_wins,
        &mut result.outcome.player2_wins,
    );
    std::mem::swap(&mut result.player1, &mut result.player2);
    result
}

fn aggregate_metrics(
    results: &[PlayerResult],
    outcomes: &[CombatResult],
    player1: bool,
) -> MatchupMetrics {
    let total_wins = results.iter().map(|result| result.wins).sum::<f64>();
    let conditional = |value: fn(&PlayerResult) -> Option<f64>| {
        (total_wins > 0.0).then(|| {
            results
                .iter()
                .map(|result| result.wins * value(result).unwrap_or(0.0))
                .sum::<f64>()
                / total_wins
        })
    };
    MatchupMetrics {
        win_probability: outcomes
            .iter()
            .map(|result| {
                if player1 {
                    result.outcome.player1_wins
                } else {
                    result.outcome.player2_wins
                }
            })
            .sum::<f64>()
            / outcomes.len() as f64,
        draw_probability: outcomes
            .iter()
            .map(|result| result.outcome.draws)
            .sum::<f64>()
            / outcomes.len() as f64,
        expected_hp_lost: results
            .iter()
            .map(|result| result.expected_hp_lost)
            .sum::<f64>()
            / results.len() as f64,
        expected_hp_lost_on_win: conditional(|result| result.expected_hp_lost_on_win),
        zero_damage_win_probability: conditional(|result| result.zero_damage_win_probability),
        expected_healing_cost: results
            .iter()
            .map(|result| result.expected_healing_cost)
            .sum::<f64>()
            / results.len() as f64,
        expected_healing_cost_on_win: conditional(|result| result.expected_healing_cost_on_win),
    }
}

fn combine_metrics(left: MatchupMetrics, right: MatchupMetrics) -> MatchupMetrics {
    let total_wins = left.win_probability + right.win_probability;
    let conditional = |left_value: Option<f64>, right_value: Option<f64>| {
        (total_wins > 0.0).then(|| {
            (left.win_probability * left_value.unwrap_or(0.0)
                + right.win_probability * right_value.unwrap_or(0.0))
                / total_wins
        })
    };
    MatchupMetrics {
        win_probability: (left.win_probability + right.win_probability) / 2.0,
        draw_probability: (left.draw_probability + right.draw_probability) / 2.0,
        expected_hp_lost: (left.expected_hp_lost + right.expected_hp_lost) / 2.0,
        expected_hp_lost_on_win: conditional(
            left.expected_hp_lost_on_win,
            right.expected_hp_lost_on_win,
        ),
        zero_damage_win_probability: conditional(
            left.zero_damage_win_probability,
            right.zero_damage_win_probability,
        ),
        expected_healing_cost: (left.expected_healing_cost + right.expected_healing_cost) / 2.0,
        expected_healing_cost_on_win: conditional(
            left.expected_healing_cost_on_win,
            right.expected_healing_cost_on_win,
        ),
    }
}

fn normalize(counts: &[f64]) -> Vec<f64> {
    let total = counts.iter().sum::<f64>();
    counts.iter().map(|count| count / total).collect()
}

fn tied_indices(scores: &[f64], target: f64) -> Vec<usize> {
    scores
        .iter()
        .enumerate()
        .filter_map(|(player, score)| ((score - target).abs() <= 1e-12).then_some(player))
        .collect()
}

fn dominates(left: &[f64], right: &[f64]) -> bool {
    let mut strictly_better = false;
    for (left, right) in left.iter().zip(right) {
        if left < &(right - 1e-12) {
            return false;
        }
        strictly_better |= left > &(right + 1e-12);
    }
    strictly_better
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn solves_pure_equilibrium() {
        let matrix = vec![vec![0.5, 0.7], vec![0.3, 0.5]];
        let equilibrium = mixed_equilibrium(&matrix, 0.001, 100_000);
        assert_eq!(equilibrium.strategy, vec![1.0, 0.0]);
        assert_eq!(equilibrium.exploitability, 0.0);
        assert_eq!(equilibrium.iterations, 0);
        assert!(equilibrium.converged);
    }

    #[test]
    fn finds_iterated_dominance_kernel() {
        let matrix = vec![
            vec![0.5, 0.6, 0.7],
            vec![0.4, 0.5, 0.8],
            vec![0.3, 0.2, 0.5],
        ];
        let kernel = iterated_dominance_kernel(&matrix);
        assert_eq!(kernel.players, vec![0]);
        assert_eq!(kernel.rounds.len(), 2);
        assert_eq!(kernel.rounds[0].eliminated[0].player, 2);
        assert_eq!(kernel.rounds[1].eliminated[0].player, 1);
    }
}
