use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use serde::Serialize;

use crate::combat::{combat_probability, damage_after_armor, MAX_COMBAT_ROUNDS};
use crate::model::{Player, Weapon, WeaponType};

/// Discrete damage values and their probabilities.
pub type DamageDistribution = BTreeMap<i32, f64>;

/// Exact win, loss, and draw probabilities.
#[derive(Clone, Copy, Debug, Serialize)]
pub struct OutcomeDistribution {
    /// Probability that the first player wins.
    pub player1_wins: f64,
    /// Probability that the second player wins.
    pub player2_wins: f64,
    /// Probability that neither player wins within the round limit.
    pub draws: f64,
}

/// Exact health and healing metrics for one player.
#[derive(Clone, Copy, Debug, Serialize)]
pub struct PlayerResult {
    /// Win probability.
    pub wins: f64,
    /// Unconditional expected HP remaining after wins and draws.
    pub expected_hp_remaining: f64,
    /// Expected HP lost conditional on winning.
    pub expected_hp_lost_on_win: Option<f64>,
    /// Probability of taking zero damage conditional on winning.
    pub zero_damage_win_probability: Option<f64>,
    /// Expected healing cost conditional on winning.
    pub expected_healing_cost_on_win: Option<f64>,
    /// Unconditional expected healing cost, including revival after defeat.
    pub expected_healing_cost: f64,
    /// Unconditional expected HP lost, treating defeat as zero remaining HP.
    pub expected_hp_lost: f64,
}

/// Exact combat result for both players.
#[derive(Clone, Copy, Debug, Serialize)]
pub struct CombatResult {
    /// Win/loss/draw probabilities in caller order.
    pub outcome: OutcomeDistribution,
    /// Maximum probability mass omitted by an optional truncated cache.
    pub outcome_error_bound: f64,
    /// Metrics for the first player passed to the evaluator.
    pub player1: PlayerResult,
    /// Metrics for the second player passed to the evaluator.
    pub player2: PlayerResult,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct DefeatWeaponSignature {
    weapon_type: WeaponType,
    skill: i32,
    min_damage: i32,
    max_damage: i32,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct DefeatRoundSignature {
    attacker_level: u32,
    attacker_accuracy: i32,
    weapons: Vec<DefeatWeaponSignature>,
    defender_hp: i32,
    defender_armor: i32,
    defender_dodge: i32,
    defender_skill: i32,
}

#[derive(Debug)]
struct DefeatRoundDistribution {
    defeat_rounds: Vec<f64>,
    survives: f64,
    truncated: bool,
    surviving_hp_by_round: Vec<f64>,
    surviving_healing_cost_by_round: Vec<f64>,
    full_hp_probability_by_round: Vec<f64>,
}

/// Reuses directional defeat distributions across exact matchup evaluations.
#[derive(Debug, Default)]
pub struct DefeatRoundCache {
    values: HashMap<DefeatRoundSignature, Arc<DefeatRoundDistribution>>,
    /// Number of cache hits.
    pub hits: u64,
    /// Number of cache misses.
    pub misses: u64,
    /// Stop propagating a combat tail at or below this survival probability.
    pub minimum_survival_probability: f64,
}

impl DefeatRoundCache {
    /// Creates an empty exact cache. A zero threshold performs no truncation.
    pub fn new(minimum_survival_probability: f64) -> Self {
        Self {
            minimum_survival_probability,
            ..Self::default()
        }
    }

    /// Number of cached directional matchups.
    pub fn len(&self) -> usize {
        self.values.len()
    }

    /// Whether the cache contains no directional matchups.
    pub fn is_empty(&self) -> bool {
        self.values.is_empty()
    }
}

/// Healing credits required to restore `current_hp` to `max_hp`.
pub fn healing_cost(current_hp: i32, max_hp: i32) -> i32 {
    (f64::from(max_hp - current_hp) / 6.0).round() as i32 + if current_hp == 0 { 5 } else { 0 }
}

/// Exact damage distribution for one weapon attempt.
pub fn weapon_damage_distribution(
    attacker: &Player,
    defender: &Player,
    weapon: &Weapon,
) -> DamageDistribution {
    let hit_probability = combat_probability(attacker.stats.accuracy, defender.stats.dodge)
        * combat_probability(attacker.skill_for(weapon), defender.stats.def_skill);
    let mut distribution = DamageDistribution::new();
    if hit_probability < 1.0 {
        distribution.insert(0, 1.0 - hit_probability);
    }
    let outcomes = weapon.max_damage - weapon.min_damage + 1;
    let probability = hit_probability / f64::from(outcomes);
    if probability > 0.0 {
        for damage in weapon.min_damage..=weapon.max_damage {
            let adjusted = damage_after_armor(attacker.level, defender.stats.armor, damage);
            *distribution.entry(adjusted).or_default() += probability;
        }
    }
    distribution
}

/// Exact combined damage distribution for both equipped weapons.
pub fn attack_damage_distribution(attacker: &Player, defender: &Player) -> DamageDistribution {
    let first = weapon_damage_distribution(attacker, defender, &attacker.weapon1);
    let second = weapon_damage_distribution(attacker, defender, &attacker.weapon2);
    let mut distribution = DamageDistribution::new();
    for (first_damage, first_probability) in first {
        for (second_damage, second_probability) in &second {
            *distribution
                .entry(first_damage + second_damage)
                .or_default() += first_probability * second_probability;
        }
    }
    distribution
}

/// Computes exact outcome, HP, and healing distributions for a matchup.
pub fn combat_result_distribution(
    player1: &Player,
    player2: &Player,
    mut cache: Option<&mut DefeatRoundCache>,
) -> CombatResult {
    let (first, second, first_is_player1) = if player2.stats.speed > player1.stats.speed {
        (player2, player1, false)
    } else {
        (player1, player2, true)
    };
    let first_defeats_second = defeat_round_distribution(first, second, cache.as_deref_mut());
    let second_defeats_first = defeat_round_distribution(second, first, cache);

    let mut first_wins = 0.0;
    let mut second_wins = 0.0;
    let mut first_win_hp = 0.0;
    let mut second_win_hp = 0.0;
    let mut first_zero_damage_wins = 0.0;
    let mut second_zero_damage_wins = 0.0;
    let mut first_win_healing_cost = 0.0;
    let mut second_win_healing_cost = 0.0;
    let mut first_survival_probability = 1.0;
    let mut second_survival_probability = 1.0;

    for round in 1..=MAX_COMBAT_ROUNDS {
        first_wins += first_defeats_second.defeat_rounds[round] * second_survival_probability;
        first_win_hp += first_defeats_second.defeat_rounds[round]
            * second_defeats_first.surviving_hp_by_round[round - 1];
        first_zero_damage_wins += first_defeats_second.defeat_rounds[round]
            * second_defeats_first.full_hp_probability_by_round[round - 1];
        first_win_healing_cost += first_defeats_second.defeat_rounds[round]
            * second_defeats_first.surviving_healing_cost_by_round[round - 1];
        first_survival_probability -= first_defeats_second.defeat_rounds[round];

        second_wins += second_defeats_first.defeat_rounds[round] * first_survival_probability;
        second_win_hp += second_defeats_first.defeat_rounds[round]
            * first_defeats_second.surviving_hp_by_round[round];
        second_zero_damage_wins += second_defeats_first.defeat_rounds[round]
            * first_defeats_second.full_hp_probability_by_round[round];
        second_win_healing_cost += second_defeats_first.defeat_rounds[round]
            * first_defeats_second.surviving_healing_cost_by_round[round];
        second_survival_probability -= second_defeats_first.defeat_rounds[round];
    }

    let draws = first_defeats_second.survives * second_defeats_first.survives;
    let first_tail = if first_defeats_second.truncated {
        first_defeats_second.survives
    } else {
        0.0
    };
    let second_tail = if second_defeats_first.truncated {
        second_defeats_first.survives
    } else {
        0.0
    };
    let first_draw_hp = second_defeats_first.surviving_hp_by_round[MAX_COMBAT_ROUNDS]
        * first_defeats_second.survives;
    let second_draw_hp = first_defeats_second.surviving_hp_by_round[MAX_COMBAT_ROUNDS]
        * second_defeats_first.survives;
    let first_draw_healing = second_defeats_first.surviving_healing_cost_by_round
        [MAX_COMBAT_ROUNDS]
        * first_defeats_second.survives;
    let second_draw_healing = first_defeats_second.surviving_healing_cost_by_round
        [MAX_COMBAT_ROUNDS]
        * second_defeats_first.survives;

    let first_result = player_result(
        first,
        PlayerAggregates {
            wins: first_wins,
            win_hp: first_win_hp,
            draw_hp: first_draw_hp,
            zero_damage_wins: first_zero_damage_wins,
            win_healing: first_win_healing_cost,
            draw_healing: first_draw_healing,
            losses: second_wins,
        },
    );
    let second_result = player_result(
        second,
        PlayerAggregates {
            wins: second_wins,
            win_hp: second_win_hp,
            draw_hp: second_draw_hp,
            zero_damage_wins: second_zero_damage_wins,
            win_healing: second_win_healing_cost,
            draw_healing: second_draw_healing,
            losses: first_wins,
        },
    );

    CombatResult {
        outcome: OutcomeDistribution {
            player1_wins: if first_is_player1 {
                first_wins
            } else {
                second_wins
            },
            player2_wins: if first_is_player1 {
                second_wins
            } else {
                first_wins
            },
            draws,
        },
        outcome_error_bound: first_tail + second_tail - first_tail * second_tail,
        player1: if first_is_player1 {
            first_result
        } else {
            second_result
        },
        player2: if first_is_player1 {
            second_result
        } else {
            first_result
        },
    }
}

struct PlayerAggregates {
    wins: f64,
    win_hp: f64,
    draw_hp: f64,
    zero_damage_wins: f64,
    win_healing: f64,
    draw_healing: f64,
    losses: f64,
}

fn player_result(player: &Player, aggregate: PlayerAggregates) -> PlayerResult {
    let expected_hp_remaining = aggregate.win_hp + aggregate.draw_hp;
    PlayerResult {
        wins: aggregate.wins,
        expected_hp_remaining,
        expected_hp_lost_on_win: (aggregate.wins > 0.0)
            .then(|| f64::from(player.max_hp) - aggregate.win_hp / aggregate.wins),
        zero_damage_win_probability: (aggregate.wins > 0.0)
            .then(|| aggregate.zero_damage_wins / aggregate.wins),
        expected_healing_cost_on_win: (aggregate.wins > 0.0)
            .then(|| aggregate.win_healing / aggregate.wins),
        expected_healing_cost: aggregate.win_healing
            + aggregate.draw_healing
            + aggregate.losses * f64::from(healing_cost(0, player.max_hp)),
        expected_hp_lost: f64::from(player.max_hp) - expected_hp_remaining,
    }
}

fn defeat_round_distribution(
    attacker: &Player,
    defender: &Player,
    mut cache: Option<&mut DefeatRoundCache>,
) -> Arc<DefeatRoundDistribution> {
    let signature = defeat_round_signature(attacker, defender);
    if let Some(cache) = cache.as_deref_mut() {
        if let Some(value) = cache.values.get(&signature) {
            cache.hits += 1;
            return Arc::clone(value);
        }
        cache.misses += 1;
    }

    let attack = attack_damage_distribution(attacker, defender)
        .into_iter()
        .collect::<Vec<_>>();
    let max_hp = defender.max_hp as usize;
    let healing = (0..=defender.max_hp)
        .map(|hp| healing_cost(hp, defender.max_hp))
        .collect::<Vec<_>>();
    let mut remaining_hp = vec![0.0; max_hp + 1];
    let mut next_remaining_hp = vec![0.0; max_hp + 1];
    let mut defeat_rounds = vec![0.0; MAX_COMBAT_ROUNDS + 1];
    let mut surviving_hp_by_round = vec![0.0; MAX_COMBAT_ROUNDS + 1];
    let mut surviving_healing_cost_by_round = vec![0.0; MAX_COMBAT_ROUNDS + 1];
    let mut full_hp_probability_by_round = vec![0.0; MAX_COMBAT_ROUNDS + 1];
    remaining_hp[max_hp] = 1.0;
    surviving_hp_by_round[0] = f64::from(defender.max_hp);
    full_hp_probability_by_round[0] = 1.0;
    let mut survives = 1.0;
    let mut truncated = false;
    let threshold = cache
        .as_deref()
        .map_or(0.0, |cache| cache.minimum_survival_probability);

    for round in 1..=MAX_COMBAT_ROUNDS {
        next_remaining_hp.fill(0.0);
        for hit_points in 1..=max_hp {
            let state_probability = remaining_hp[hit_points];
            if state_probability == 0.0 {
                continue;
            }
            for (damage, probability) in &attack {
                if *damage >= hit_points as i32 {
                    break;
                }
                next_remaining_hp[hit_points - *damage as usize] += state_probability * probability;
            }
        }

        let mut next_survives = 0.0;
        let mut next_surviving_hp = 0.0;
        let mut next_surviving_healing = 0.0;
        for hit_points in 1..=max_hp {
            let probability = next_remaining_hp[hit_points];
            next_survives += probability;
            next_surviving_hp += hit_points as f64 * probability;
            next_surviving_healing += f64::from(healing[hit_points]) * probability;
        }
        if next_survives > survives {
            let scale = survives / next_survives;
            for probability in &mut next_remaining_hp[1..] {
                *probability *= scale;
            }
            next_surviving_hp *= scale;
            next_surviving_healing *= scale;
            next_survives = survives;
        }
        defeat_rounds[round] = survives - next_survives;
        survives = next_survives;
        let full_hp_probability = next_remaining_hp[max_hp];
        std::mem::swap(&mut remaining_hp, &mut next_remaining_hp);
        surviving_hp_by_round[round] = next_surviving_hp;
        surviving_healing_cost_by_round[round] = next_surviving_healing;
        full_hp_probability_by_round[round] = full_hp_probability;
        if next_survives == 0.0 {
            break;
        }
        if cache.is_some() && survives <= threshold {
            surviving_hp_by_round[MAX_COMBAT_ROUNDS] = next_surviving_hp;
            surviving_healing_cost_by_round[MAX_COMBAT_ROUNDS] = next_surviving_healing;
            full_hp_probability_by_round[MAX_COMBAT_ROUNDS] = full_hp_probability;
            truncated = true;
            break;
        }
    }

    let result = Arc::new(DefeatRoundDistribution {
        defeat_rounds,
        survives,
        truncated,
        surviving_hp_by_round,
        surviving_healing_cost_by_round,
        full_hp_probability_by_round,
    });
    if let Some(cache) = cache {
        cache.values.insert(signature, Arc::clone(&result));
    }
    result
}

fn defeat_round_signature(attacker: &Player, defender: &Player) -> DefeatRoundSignature {
    let mut weapons = [&attacker.weapon1, &attacker.weapon2]
        .map(|weapon| DefeatWeaponSignature {
            weapon_type: weapon.weapon_type,
            skill: attacker.skill_for(weapon),
            min_damage: weapon.min_damage,
            max_damage: weapon.max_damage,
        })
        .to_vec();
    weapons.sort_unstable_by_key(|weapon| {
        (
            weapon.weapon_type,
            weapon.skill,
            weapon.min_damage,
            weapon.max_damage,
        )
    });
    DefeatRoundSignature {
        attacker_level: attacker.level,
        attacker_accuracy: attacker.stats.accuracy,
        weapons,
        defender_hp: defender.max_hp,
        defender_armor: defender.stats.armor,
        defender_dodge: defender.stats.dodge,
        defender_skill: defender.stats.def_skill,
    }
}

#[cfg(test)]
mod tests {
    use approx::assert_abs_diff_eq;

    use super::*;
    use crate::catalog::Catalogs;

    #[test]
    fn exact_result_matches_expected_distribution() {
        let catalogs = Catalogs::bundled().unwrap();
        let matchup = catalogs
            .materialize_matchup(
                catalogs.build("DualVoidBowsWithScouts").unwrap(),
                catalogs.build("ShadowDojoDLGunBuild2").unwrap(),
            )
            .unwrap();
        let result = combat_result_distribution(&matchup.active, &matchup.opponent, None);
        assert_abs_diff_eq!(
            result.outcome.player1_wins,
            0.053433800933837185,
            epsilon = 1e-12
        );
        assert_abs_diff_eq!(
            result.outcome.player2_wins,
            0.9465661990661627,
            epsilon = 1e-12
        );
        assert_abs_diff_eq!(
            result.player1.expected_healing_cost,
            62.07704858111972,
            epsilon = 1e-10
        );
        assert_abs_diff_eq!(
            result.player2.expected_hp_lost,
            422.021857964081,
            epsilon = 1e-9
        );
    }

    #[test]
    fn exact_cache_reuses_directional_matchups() {
        let catalogs = Catalogs::bundled().unwrap();
        let matchup = catalogs
            .materialize_matchup(
                catalogs.build("DualVoidBowsWithScouts").unwrap(),
                catalogs.build("ShadowDojoDLGunBuild2").unwrap(),
            )
            .unwrap();
        let mut cache = DefeatRoundCache::new(0.0);
        combat_result_distribution(&matchup.active, &matchup.opponent, Some(&mut cache));
        combat_result_distribution(&matchup.active, &matchup.opponent, Some(&mut cache));
        assert_eq!(cache.misses, 2);
        assert_eq!(cache.hits, 2);
        assert_eq!(cache.len(), 2);
    }
}
