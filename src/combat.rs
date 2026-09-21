use rand::Rng;

use crate::model::{
    ActiveSkillSignature, CombatSignature, Player, SimulationResult, Weapon, WeaponSignature,
};

/// Number of complete attack-and-counterattack rounds before an unresolved fight draws.
pub const MAX_COMBAT_ROUNDS: usize = 100;

/// Returns the documented probability that one statistic beats another.
///
/// Division remains fractional, matching the PHP formula on which the legacy
/// implementation is based. Equal values produce a probability of `0.5`.
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

/// Applies level-based armor reduction and rounds the result to the nearest integer.
///
/// Attacker level is capped at 80 before calculating the modifier.
pub fn damage_after_armor(attacker_level: u32, defender_armor: i32, base_damage: i32) -> i32 {
    let level_modifier = f64::from(attacker_level.min(80)) * 7.0 / 2.0;
    (f64::from(base_damage) * (level_modifier / (level_modifier + f64::from(defender_armor))))
        .round() as i32
}

/// Produces a canonical signature for every statistic that can affect combat.
///
/// Weapons and their active skill families are sorted so swapping weapon slots
/// does not change the signature. Skill families unused by either weapon are
/// intentionally excluded. Both active attack-mode statistics and normal-mode
/// defensive statistics are retained.
pub fn combat_signature(player: &Player) -> CombatSignature {
    let mut weapons = [&player.weapon1, &player.weapon2]
        .map(|weapon| WeaponSignature {
            weapon_type: weapon.weapon_type,
            min_damage: weapon.min_damage,
            max_damage: weapon.max_damage,
        })
        .to_vec();
    weapons.sort_unstable();

    let mut weapon_types = weapons
        .iter()
        .map(|weapon| weapon.weapon_type)
        .collect::<Vec<_>>();
    weapon_types.sort_unstable();
    weapon_types.dedup();
    let active_skills = weapon_types
        .into_iter()
        .map(|weapon_type| ActiveSkillSignature {
            weapon_type,
            value: match weapon_type {
                crate::model::WeaponType::Melee => player.stats.melee_skill,
                crate::model::WeaponType::Gun => player.stats.gun_skill,
                crate::model::WeaponType::Projectile => player.stats.proj_skill,
            },
        })
        .collect();

    CombatSignature {
        level: player.level,
        max_hp: player.max_hp,
        armor: player.stats.armor,
        speed: player.stats.speed,
        accuracy: player.stats.accuracy,
        dodge: player.stats.dodge,
        normal_mode: player.normal_mode,
        def_skill: player.stats.def_skill,
        active_skills,
        weapons,
    }
}

/// Simulates `fights` independent combats and aggregates their outcomes.
///
/// The faster player attacks first. A speed tie favors `player1`, preserving the
/// caller's initiative. Each turn resolves both weapons before checking for defeat;
/// a defeated opponent does not counterattack. Fights still unresolved after
/// [`MAX_COMBAT_ROUNDS`] are draws.
///
/// The caller owns the random-number generator, allowing reproducible runs and a
/// deliberate choice of generator without coupling the combat model to one RNG.
pub fn simulate<R: Rng + ?Sized>(
    player1: &Player,
    player2: &Player,
    fights: u64,
    rng: &mut R,
) -> SimulationResult {
    let mut result = SimulationResult::default();
    let matchup = PreparedMatchup::new(player1, player2);
    for _ in 0..fights {
        match matchup.fight(rng) {
            FightOutcome::Player1Win => result.player1_wins += 1,
            FightOutcome::Player2Win => result.player2_wins += 1,
            FightOutcome::Draw => result.draws += 1,
        }
    }
    result
}

#[derive(Clone, Copy)]
enum FightOutcome {
    Player1Win,
    Player2Win,
    Draw,
}

struct PreparedMatchup {
    attacker: PreparedPlayer,
    defender: PreparedPlayer,
    attacker_is_player1: bool,
}

impl PreparedMatchup {
    fn new(player1: &Player, player2: &Player) -> Self {
        if player2.stats.speed > player1.stats.speed {
            Self {
                attacker: PreparedPlayer::new(player2, player1),
                defender: PreparedPlayer::new(player1, player2),
                attacker_is_player1: false,
            }
        } else {
            Self {
                attacker: PreparedPlayer::new(player1, player2),
                defender: PreparedPlayer::new(player2, player1),
                attacker_is_player1: true,
            }
        }
    }

    fn fight<R: Rng + ?Sized>(&self, rng: &mut R) -> FightOutcome {
        let mut attacker_hp = self.attacker.max_hp;
        let mut defender_hp = self.defender.max_hp;
        for _ in 0..MAX_COMBAT_ROUNDS {
            defender_hp -= self.attacker.attack(rng);
            if defender_hp <= 0 {
                return if self.attacker_is_player1 {
                    FightOutcome::Player1Win
                } else {
                    FightOutcome::Player2Win
                };
            }
            attacker_hp -= self.defender.attack(rng);
            if attacker_hp <= 0 {
                return if self.attacker_is_player1 {
                    FightOutcome::Player2Win
                } else {
                    FightOutcome::Player1Win
                };
            }
        }
        FightOutcome::Draw
    }
}

struct PreparedPlayer {
    max_hp: i32,
    weapons: [PreparedWeapon; 2],
}

impl PreparedPlayer {
    fn new(attacker: &Player, defender: &Player) -> Self {
        Self {
            max_hp: attacker.max_hp,
            weapons: [
                PreparedWeapon::new(attacker, defender, &attacker.weapon1),
                PreparedWeapon::new(attacker, defender, &attacker.weapon2),
            ],
        }
    }

    fn attack<R: Rng + ?Sized>(&self, rng: &mut R) -> i32 {
        self.weapons[0].attempt_hit(rng) + self.weapons[1].attempt_hit(rng)
    }
}

struct PreparedWeapon {
    accuracy_probability: f64,
    skill_probability: f64,
    damage_outcomes: Vec<i32>,
}

impl PreparedWeapon {
    fn new(attacker: &Player, defender: &Player, weapon: &Weapon) -> Self {
        Self {
            accuracy_probability: combat_probability(attacker.stats.accuracy, defender.stats.dodge),
            skill_probability: combat_probability(
                attacker.skill_for(weapon),
                defender.stats.def_skill,
            ),
            damage_outcomes: (weapon.min_damage..=weapon.max_damage)
                .map(|damage| damage_after_armor(attacker.level, defender.stats.armor, damage))
                .collect(),
        }
    }

    fn attempt_hit<R: Rng + ?Sized>(&self, rng: &mut R) -> i32 {
        if rng.gen::<f64>() < self.accuracy_probability && rng.gen::<f64>() < self.skill_probability
        {
            self.damage_outcomes[rng.gen_range(0..self.damage_outcomes.len())]
        } else {
            0
        }
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

    #[test]
    fn signature_ignores_unused_skills() {
        let catalogs = crate::catalog::Catalogs::bundled().unwrap();
        let mut player = catalogs
            .materialize(
                catalogs.build("ShadowDojoDLGunBuild2").unwrap(),
                crate::model::MatchupRole::Active,
            )
            .unwrap();
        let original = combat_signature(&player);
        player.stats.melee_skill += 100;
        player.stats.proj_skill += 100;
        assert_eq!(combat_signature(&player), original);
    }
}
