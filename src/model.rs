use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, Deserialize)]
/// Additive combat and equipment statistics.
pub struct Stats {
    #[serde(default)]
    /// Armor used for damage reduction.
    pub armor: i32,
    #[serde(default)]
    /// Initiative statistic.
    pub speed: i32,
    #[serde(default)]
    /// Accuracy statistic.
    pub accuracy: i32,
    #[serde(default)]
    /// Dodge statistic.
    pub dodge: i32,
    #[serde(default)]
    /// Melee weapon skill.
    pub melee_skill: i32,
    #[serde(default)]
    /// Gun weapon skill.
    pub gun_skill: i32,
    #[serde(default)]
    /// Projectile weapon skill.
    pub proj_skill: i32,
    #[serde(default)]
    /// Defensive weapon skill.
    pub def_skill: i32,
    #[serde(default)]
    /// Minimum weapon damage when these stats describe equipment.
    pub min_damage: i32,
    #[serde(default)]
    /// Maximum weapon damage when these stats describe equipment.
    pub max_damage: i32,
}

impl Stats {
    /// Adds every field from `other` to this value.
    pub fn add(&mut self, other: Self) {
        self.armor += other.armor;
        self.speed += other.speed;
        self.accuracy += other.accuracy;
        self.dodge += other.dodge;
        self.melee_skill += other.melee_skill;
        self.gun_skill += other.gun_skill;
        self.proj_skill += other.proj_skill;
        self.def_skill += other.def_skill;
        self.min_damage += other.min_damage;
        self.max_damage += other.max_damage;
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "lowercase")]
/// The skill family used by a weapon.
pub enum WeaponType {
    /// Uses melee skill.
    Melee,
    /// Uses gun skill.
    Gun,
    /// Uses projectile skill.
    Projectile,
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
/// A build's selected attack mode.
pub enum AttackType {
    /// No mode-specific adjustments.
    #[default]
    Normal,
    /// Higher speed with lower accuracy and dodge.
    Quick,
    /// Higher accuracy with lower speed and dodge.
    Aimed,
    /// Higher dodge with lower speed and accuracy.
    Cover,
}

/// The directional role for which a build is materialized.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MatchupRole {
    /// Apply the build's selected attack mode for the active side of a matchup.
    Active,
    /// Use normal-mode speed, accuracy, and dodge for the opposing side.
    Opponent,
}

#[derive(Clone, Debug, Deserialize)]
/// A build as represented in a JSON build catalog.
pub struct BuildDefinition {
    /// Display name.
    pub name: String,
    /// Character level; materialization currently accepts level 80 only.
    pub level: u32,
    #[serde(default)]
    /// Whether the build participates in the `reference` enemy set.
    pub reference: Option<bool>,
    #[serde(default)]
    /// Mode used when this build initiates combat.
    pub attack_type: AttackType,
    /// Allocated character-stat points.
    pub stats: StatAllocation,
    /// Equipped armor, weapons, and miscellaneous items.
    pub equipment: Loadout,
}

#[derive(Clone, Copy, Debug, Deserialize)]
/// Allocated character-stat points before training and equipment bonuses.
pub struct StatAllocation {
    /// HP points; each point grants five HP.
    pub hp: i32,
    /// Speed points; each point grants five speed.
    pub speed: i32,
    /// Accuracy points.
    pub accuracy: i32,
    /// Dodge points.
    pub dodge: i32,
}

#[derive(Clone, Debug, Deserialize)]
/// The five equipment slots in a build.
pub struct Loadout {
    /// Armor slot.
    pub armor: ItemSelection,
    /// First weapon slot.
    pub weapon1: ItemSelection,
    /// Second weapon slot.
    pub weapon2: ItemSelection,
    /// First miscellaneous slot.
    pub misc1: ItemSelection,
    /// Second miscellaneous slot.
    pub misc2: ItemSelection,
}

#[derive(Clone, Debug, Deserialize)]
/// An equipment catalog key with optional crystals and weapon modifications.
pub struct ItemSelection {
    /// Equipment catalog key.
    pub item: String,
    #[serde(default)]
    /// Crystal catalog keys applied together after weapon modifications.
    pub crystals: Vec<String>,
    #[serde(default)]
    /// Weapon-mod catalog keys applied together before crystals.
    pub mods: Vec<String>,
}

#[derive(Clone, Debug)]
/// A materialized weapon ready for combat simulation.
pub struct Weapon {
    /// Skill family checked when the weapon attacks.
    pub weapon_type: WeaponType,
    /// Inclusive minimum base damage.
    pub min_damage: i32,
    /// Inclusive maximum base damage.
    pub max_damage: i32,
}

/// Speed, accuracy, and dodge before an attack-mode adjustment.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize)]
pub struct ModeStats {
    /// Normal-mode speed.
    pub speed: i32,
    /// Normal-mode accuracy.
    pub accuracy: i32,
    /// Normal-mode dodge.
    pub dodge: i32,
}

#[derive(Clone, Debug)]
/// Fully materialized combat statistics for one role in a matchup.
pub struct Player {
    /// Display name.
    pub name: String,
    /// Character level used by armor reduction.
    pub level: u32,
    /// HP at the beginning of every fight.
    pub max_hp: i32,
    /// Final additive statistics after equipment and attack-mode adjustments.
    pub stats: Stats,
    /// Speed, accuracy, and dodge before attack-mode adjustments.
    pub normal_mode: ModeStats,
    /// First weapon.
    pub weapon1: Weapon,
    /// Second weapon.
    pub weapon2: Weapon,
}

/// The combat-relevant portion of one weapon.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
pub struct WeaponSignature {
    /// Skill family checked by the weapon.
    pub weapon_type: WeaponType,
    /// Inclusive minimum base damage.
    pub min_damage: i32,
    /// Inclusive maximum base damage.
    pub max_damage: i32,
}

/// A skill family used by the equipped weapons and its effective value.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
pub struct ActiveSkillSignature {
    /// Active weapon family.
    pub weapon_type: WeaponType,
    /// Effective skill value for that family.
    pub value: i32,
}

/// Canonical combat behavior used to identify equivalent builds.
#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize)]
pub struct CombatSignature {
    /// Character level.
    pub level: u32,
    /// Maximum HP.
    pub max_hp: i32,
    /// Armor after equipment bonuses.
    pub armor: i32,
    /// Active-mode speed.
    pub speed: i32,
    /// Active-mode accuracy.
    pub accuracy: i32,
    /// Active-mode dodge.
    pub dodge: i32,
    /// Normal-mode speed, accuracy, and dodge.
    pub normal_mode: ModeStats,
    /// Defense skill.
    pub def_skill: i32,
    /// Values for only the skill families used by the equipped weapons.
    pub active_skills: Vec<ActiveSkillSignature>,
    /// Combat-relevant weapons sorted independently of equipment slot.
    pub weapons: Vec<WeaponSignature>,
}

/// Builds that materialize to the same combat signature.
#[derive(Debug)]
pub struct EquivalentBuildGroup<'a> {
    /// Shared canonical combat signature.
    pub signature: CombatSignature,
    /// Materialized first build in the group.
    pub representative: Player,
    /// Group members in input order.
    pub builds: Vec<&'a BuildDefinition>,
}

/// Role-correct combatants for a directional build matchup.
#[derive(Clone, Debug)]
pub struct Matchup {
    /// The directional active build with its selected attack mode applied.
    pub active: Player,
    /// The opposing build in normal mode.
    pub opponent: Player,
}

impl Player {
    /// Returns this player's skill value for `weapon`.
    pub fn skill_for(&self, weapon: &Weapon) -> i32 {
        match weapon.weapon_type {
            WeaponType::Melee => self.stats.melee_skill,
            WeaponType::Gun => self.stats.gun_skill,
            WeaponType::Projectile => self.stats.proj_skill,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Serialize, PartialEq, Eq)]
/// Aggregate outcomes from a Monte Carlo run.
pub struct SimulationResult {
    /// Fights won by the first player passed to the simulator.
    pub player1_wins: u64,
    /// Fights won by the second player passed to the simulator.
    pub player2_wins: u64,
    /// Fights unresolved after the round limit.
    pub draws: u64,
}
