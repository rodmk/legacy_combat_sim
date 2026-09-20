use rand::Rng;

use crate::model::{Player, SimulationResult, Weapon};

pub const MAX_COMBAT_ROUNDS: usize = 100;

pub fn combat_probability(offense: i32, defense: i32) -> f64 {
    let offense = f64::from(offense);
    let defense = f64::from(defense);
    let offense_range = (offense + 1.0) - (offense / 4.0);
    let defense_range = (defense + 1.0) - (defense / 4.0);
    let combinations = offense_range * defense_range;
    if defense > offense {
        let overlap = ((offense + 1.0) - (defense / 4.0)).max(0.0);
        (overlap * (overlap / 2.0)) / combinations
    } else {
        let overlap = ((defense + 1.0) - (offense / 4.0)).max(0.0);
        (combinations - (overlap * (overlap / 2.0))) / combinations
    }
}

pub fn damage_after_armor(attacker_level: u32, defender_armor: i32, base_damage: i32) -> i32 {
    let level_modifier = f64::from(attacker_level.min(80)) * 7.0 / 2.0;
    (f64::from(base_damage) * (level_modifier / (level_modifier + f64::from(defender_armor))))
        .round() as i32
}

pub fn simulate<R: Rng + ?Sized>(
    player1: &Player,
    player2: &Player,
    fights: u64,
    rng: &mut R,
) -> SimulationResult {
    let mut result = SimulationResult::default();
    for _ in 0..fights {
        let winner = if player2.stats.speed > player1.stats.speed {
            fight(player2, player1, rng).map(|winner| if winner == 0 { 1 } else { 0 })
        } else {
            fight(player1, player2, rng)
        };
        match winner {
            Some(0) => result.player1_wins += 1,
            Some(1) => result.player2_wins += 1,
            None => result.draws += 1,
            _ => unreachable!(),
        }
    }
    result
}

fn fight<R: Rng + ?Sized>(attacker: &Player, defender: &Player, rng: &mut R) -> Option<usize> {
    let mut attacker_hp = attacker.max_hp;
    let mut defender_hp = defender.max_hp;
    for _ in 0..MAX_COMBAT_ROUNDS {
        defender_hp -= attack(attacker, defender, rng);
        if defender_hp <= 0 {
            return Some(0);
        }
        attacker_hp -= attack(defender, attacker, rng);
        if attacker_hp <= 0 {
            return Some(1);
        }
    }
    None
}

fn attack<R: Rng + ?Sized>(attacker: &Player, defender: &Player, rng: &mut R) -> i32 {
    attempt_hit(attacker, defender, &attacker.weapon1, rng)
        + attempt_hit(attacker, defender, &attacker.weapon2, rng)
}

fn attempt_hit<R: Rng + ?Sized>(
    attacker: &Player,
    defender: &Player,
    weapon: &Weapon,
    rng: &mut R,
) -> i32 {
    if rng.gen::<f64>() < combat_probability(attacker.stats.accuracy, defender.stats.dodge)
        && rng.gen::<f64>()
            < combat_probability(attacker.skill_for(weapon), defender.stats.def_skill)
    {
        let base_damage = rng.gen_range(weapon.min_damage..=weapon.max_damage);
        damage_after_armor(attacker.level, defender.stats.armor, base_damage)
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_abs_diff_eq;

    #[test]
    fn equal_stats_have_even_odds() {
        assert_abs_diff_eq!(combat_probability(100, 100), 0.5);
        assert_abs_diff_eq!(combat_probability(101, 101), 0.5);
    }

    #[test]
    fn probability_is_symmetric() {
        assert_abs_diff_eq!(
            combat_probability(100, 200),
            1.0 - combat_probability(200, 100)
        );
        assert_eq!(combat_probability(100, 500), 0.0);
        assert_eq!(combat_probability(500, 100), 1.0);
    }

    #[test]
    fn armor_damage_matches_legacy_rounding() {
        assert_eq!(damage_after_armor(80, 65, 100), 81);
    }
}
