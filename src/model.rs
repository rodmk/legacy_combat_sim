use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, Deserialize)]
pub struct Stats {
    #[serde(default)]
    pub armor: i32,
    #[serde(default)]
    pub speed: i32,
    #[serde(default)]
    pub accuracy: i32,
    #[serde(default)]
    pub dodge: i32,
    #[serde(default)]
    pub melee_skill: i32,
    #[serde(default)]
    pub gun_skill: i32,
    #[serde(default)]
    pub proj_skill: i32,
    #[serde(default)]
    pub def_skill: i32,
    #[serde(default)]
    pub min_damage: i32,
    #[serde(default)]
    pub max_damage: i32,
}

impl Stats {
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

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum WeaponType {
    Melee,
    Gun,
    Projectile,
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AttackType {
    #[default]
    Normal,
    Quick,
    Aimed,
    Cover,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ItemDefinition {
    pub name: String,
    #[serde(rename = "type")]
    pub weapon_type: Option<WeaponType>,
    #[serde(default)]
    pub mod_slots: u8,
    #[serde(flatten)]
    pub stats: Stats,
}

#[derive(Clone, Debug, Deserialize)]
pub struct CrystalDefinition {
    pub name: String,
    pub mult: Multipliers,
}

#[derive(Clone, Debug, Deserialize)]
pub struct WeaponModDefinition {
    pub name: String,
    pub slot: u8,
    pub compatible: Vec<String>,
    pub mult: Multipliers,
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
pub struct Multipliers {
    pub armor: Option<f64>,
    pub speed: Option<f64>,
    pub accuracy: Option<f64>,
    pub dodge: Option<f64>,
    pub melee_skill: Option<f64>,
    pub gun_skill: Option<f64>,
    pub proj_skill: Option<f64>,
    pub def_skill: Option<f64>,
    pub min_damage: Option<f64>,
    pub max_damage: Option<f64>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct BuildDefinition {
    pub name: String,
    pub level: u32,
    #[serde(default)]
    pub reference: Option<bool>,
    #[serde(default)]
    pub attack_type: AttackType,
    pub stats: StatAllocation,
    pub equipment: Loadout,
}

#[derive(Clone, Copy, Debug, Deserialize)]
pub struct StatAllocation {
    pub hp: i32,
    pub speed: i32,
    pub accuracy: i32,
    pub dodge: i32,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Loadout {
    pub armor: ItemSelection,
    pub weapon1: ItemSelection,
    pub weapon2: ItemSelection,
    pub misc1: ItemSelection,
    pub misc2: ItemSelection,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ItemSelection {
    pub item: String,
    #[serde(default)]
    pub crystals: Vec<String>,
    #[serde(default)]
    pub mods: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct Weapon {
    pub weapon_type: WeaponType,
    pub min_damage: i32,
    pub max_damage: i32,
}

#[derive(Clone, Debug)]
pub struct Player {
    pub name: String,
    pub level: u32,
    pub max_hp: i32,
    pub stats: Stats,
    pub weapon1: Weapon,
    pub weapon2: Weapon,
}

impl Player {
    pub fn skill_for(&self, weapon: &Weapon) -> i32 {
        match weapon.weapon_type {
            WeaponType::Melee => self.stats.melee_skill,
            WeaponType::Gun => self.stats.gun_skill,
            WeaponType::Projectile => self.stats.proj_skill,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Serialize, PartialEq, Eq)]
pub struct SimulationResult {
    pub player1_wins: u64,
    pub player2_wins: u64,
    pub draws: u64,
}
