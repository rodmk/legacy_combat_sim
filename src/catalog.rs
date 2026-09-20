use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::Path;

use anyhow::{bail, Context, Result};
use serde::Deserialize;

use crate::model::{
    AttackType, BuildDefinition, CombatRole, CrystalDefinition, ItemDefinition, ItemSelection,
    Matchup, Multipliers, Player, Stats, Weapon, WeaponModDefinition, WeaponType,
};

/// Ordered mapping from stable build keys to build definitions.
pub type BuildCatalog = BTreeMap<String, BuildDefinition>;

#[derive(Debug, Deserialize)]
struct EquipmentCatalog {
    armor: HashMap<String, ItemDefinition>,
    weapons: HashMap<String, ItemDefinition>,
    miscs: HashMap<String, ItemDefinition>,
}

#[derive(Debug)]
/// Equipment, modifier, and build catalogs used to materialize combatants.
pub struct Catalogs {
    equipment: EquipmentCatalog,
    crystals: HashMap<String, CrystalDefinition>,
    weapon_mods: HashMap<String, WeaponModDefinition>,
    builds: BuildCatalog,
}

#[derive(Clone)]
struct MaterializedItem {
    key: String,
    weapon_type: Option<WeaponType>,
    stats: Stats,
}

impl Catalogs {
    /// Loads the equipment data and primary build catalogs bundled with the crate.
    pub fn bundled() -> Result<Self> {
        let equipment = serde_json::from_str(include_str!("../data/equipment.json"))?;
        let crystals = serde_json::from_str(include_str!("../data/crystals.json"))?;
        let weapon_mods = serde_json::from_str(include_str!("../data/weapon-mods.json"))?;
        let mut catalogs = Self {
            equipment,
            crystals,
            weapon_mods,
            builds: BTreeMap::new(),
        };
        for (name, data) in [
            ("builds.json", include_str!("../data/builds.json")),
            ("game-builds.json", include_str!("../data/game-builds.json")),
            (
                "kernel-builds.json",
                include_str!("../data/kernel-builds.json"),
            ),
        ] {
            catalogs.merge_builds(serde_json::from_str(data).with_context(|| name.to_owned())?)?;
        }
        Ok(catalogs)
    }

    /// Merges a schema-compatible JSON build catalog from disk.
    ///
    /// Returns an error if a key duplicates any previously loaded build.
    pub fn add_build_catalog(&mut self, path: &Path) -> Result<()> {
        let data = fs::read_to_string(path)
            .with_context(|| format!("failed to read build catalog {}", path.display()))?;
        let builds = serde_json::from_str(&data)
            .with_context(|| format!("failed to parse build catalog {}", path.display()))?;
        self.merge_builds(builds)
    }

    fn merge_builds(&mut self, builds: BuildCatalog) -> Result<()> {
        for (key, build) in builds {
            if self.builds.insert(key.clone(), build).is_some() {
                bail!("duplicate build key: {key}");
            }
        }
        Ok(())
    }

    /// Looks up a build by its stable catalog key.
    pub fn build(&self, key: &str) -> Result<&BuildDefinition> {
        self.builds
            .get(key)
            .with_context(|| format!("unknown build: {key}"))
    }

    /// Iterates over build keys in stable lexical order.
    pub fn build_keys(&self) -> impl Iterator<Item = &str> {
        self.builds.keys().map(String::as_str)
    }

    /// Iterates over build keys and definitions in stable lexical order.
    pub fn builds(&self) -> impl Iterator<Item = (&str, &BuildDefinition)> {
        self.builds.iter().map(|(key, build)| (key.as_str(), build))
    }

    /// Returns the members of a bundled named enemy set.
    ///
    /// Supported names are `shadow-dojo` and `reference`. Shadow Dojo membership
    /// follows the existing `ShadowDojo` build-key convention; reference membership
    /// includes builds whose `reference` property is absent or true.
    pub fn enemy_set(&self, name: &str) -> Result<Vec<(&str, &BuildDefinition)>> {
        let prefix = match name {
            "shadow-dojo" => "ShadowDojo",
            "reference" => {
                return Ok(self
                    .builds
                    .iter()
                    .filter(|(_, build)| build.reference != Some(false))
                    .map(|(key, build)| (key.as_str(), build))
                    .collect())
            }
            _ => bail!("unknown enemy set: {name}; available sets: shadow-dojo, reference"),
        };
        Ok(self
            .builds
            .iter()
            .filter(|(key, _)| key.starts_with(prefix))
            .map(|(key, build)| (key.as_str(), build))
            .collect())
    }

    /// Validates and converts a build definition into combat-ready statistics.
    ///
    /// [`CombatRole::Attacker`] applies the build's selected attack mode.
    /// [`CombatRole::Defender`] uses normal-mode speed, accuracy, and dodge.
    /// Builds must be level 80, allocate exactly 183 points, and respect the
    /// minimum allocation for each statistic. HP and speed points grant five
    /// points each; fully trained base statistics and the five-damage Combat
    /// Tactics bonus are added before equipment.
    ///
    /// Equipment bonuses are additive. With mixed weapon families, each weapon's
    /// contribution to its own skill is doubled. Weapon modifications are applied
    /// before crystals. Within each modifier group, bonuses are calculated from
    /// the same pre-group value, summed, rounded up, and then added. Attack-mode
    /// multipliers are applied last and rounded up.
    pub fn materialize(&self, build: &BuildDefinition, role: CombatRole) -> Result<Player> {
        if build.level != 80 {
            bail!("builds require level 80");
        }
        let points = build.stats.hp + build.stats.speed + build.stats.accuracy + build.stats.dodge;
        if points != 183 {
            bail!("stats for {} total {points}; expected 183", build.name);
        }
        if build.stats.hp < 2
            || build.stats.speed < 2
            || build.stats.accuracy < 4
            || build.stats.dodge < 4
        {
            bail!("{} has a stat below its minimum", build.name);
        }

        let selections = [
            &build.equipment.armor,
            &build.equipment.weapon1,
            &build.equipment.weapon2,
            &build.equipment.misc1,
            &build.equipment.misc2,
        ];
        let mut items = Vec::with_capacity(selections.len());
        for selection in selections {
            items.push(self.materialize_item(selection)?);
        }
        if items[0].weapon_type.is_some()
            || items[1].weapon_type.is_none()
            || items[2].weapon_type.is_none()
            || items[3].weapon_type.is_some()
            || items[4].weapon_type.is_some()
        {
            bail!("{} has equipment in an incompatible slot", build.name);
        }

        let mut stats = Stats {
            armor: 5,
            speed: 50 + build.stats.speed * 5,
            accuracy: 10 + build.stats.accuracy,
            dodge: 10 + build.stats.dodge,
            melee_skill: 450,
            gun_skill: 450,
            proj_skill: 450,
            def_skill: 450,
            ..Stats::default()
        };
        let mixed_weapons = items[1].weapon_type != items[2].weapon_type;
        for (index, item) in items.iter().enumerate() {
            let mut bonuses = item.stats;
            if mixed_weapons && (index == 1 || index == 2) {
                match item.weapon_type.expect("weapons were checked") {
                    WeaponType::Melee => bonuses.melee_skill *= 2,
                    WeaponType::Gun => bonuses.gun_skill *= 2,
                    WeaponType::Projectile => bonuses.proj_skill *= 2,
                }
            }
            stats.add(bonuses);
        }

        if role == CombatRole::Attacker {
            apply_attack_type(&mut stats, build.attack_type);
        }
        Ok(Player {
            name: build.name.clone(),
            level: build.level,
            max_hp: build.stats.hp * 5,
            stats,
            weapon1: weapon_from_item(&items[1])?,
            weapon2: weapon_from_item(&items[2])?,
        })
    }

    /// Materializes both sides of a directional build matchup with the correct roles.
    pub fn materialize_matchup(
        &self,
        attacker: &BuildDefinition,
        defender: &BuildDefinition,
    ) -> Result<Matchup> {
        Ok(Matchup {
            attacker: self.materialize(attacker, CombatRole::Attacker)?,
            defender: self.materialize(defender, CombatRole::Defender)?,
        })
    }

    fn materialize_item(&self, selection: &ItemSelection) -> Result<MaterializedItem> {
        let definition = self
            .equipment
            .armor
            .get(&selection.item)
            .or_else(|| self.equipment.weapons.get(&selection.item))
            .or_else(|| self.equipment.miscs.get(&selection.item))
            .with_context(|| format!("unknown item: {}", selection.item))?;
        let mut item = MaterializedItem {
            key: selection.item.clone(),
            weapon_type: definition.weapon_type,
            stats: definition.stats,
        };

        if !selection.mods.is_empty() {
            if definition.weapon_type.is_none() {
                bail!("weapon mods cannot be applied to {}", definition.name);
            }
            if selection.mods.len() > usize::from(definition.mod_slots) {
                bail!(
                    "{} supports at most {} weapon mods",
                    definition.name,
                    definition.mod_slots
                );
            }
            let mut slots = HashSet::new();
            let mut multipliers = Vec::with_capacity(selection.mods.len());
            for key in &selection.mods {
                let weapon_mod = self
                    .weapon_mods
                    .get(key)
                    .with_context(|| format!("unknown weapon mod: {key}"))?;
                if weapon_mod.slot > definition.mod_slots
                    || !weapon_mod.compatible.contains(&selection.item)
                {
                    bail!(
                        "{} is not compatible with {}",
                        weapon_mod.name,
                        definition.name
                    );
                }
                if !slots.insert(weapon_mod.slot) {
                    bail!("weapon mod slot {} is already occupied", weapon_mod.slot);
                }
                multipliers.push(weapon_mod.mult);
            }
            apply_multipliers(&mut item.stats, &multipliers);
        }

        let multipliers = selection
            .crystals
            .iter()
            .map(|key| {
                self.crystals
                    .get(key)
                    .map(|crystal| crystal.mult)
                    .with_context(|| format!("unknown crystal: {key}"))
            })
            .collect::<Result<Vec<_>>>()?;
        apply_multipliers(&mut item.stats, &multipliers);
        Ok(item)
    }
}

fn weapon_from_item(item: &MaterializedItem) -> Result<Weapon> {
    Ok(Weapon {
        weapon_type: item
            .weapon_type
            .with_context(|| format!("{} is not a weapon", item.key))?,
        min_damage: item.stats.min_damage + 5,
        max_damage: item.stats.max_damage + 5,
    })
}

fn apply_attack_type(stats: &mut Stats, attack_type: AttackType) {
    let (speed, accuracy, dodge) = match attack_type {
        AttackType::Normal => return,
        AttackType::Quick => (1.2, 0.9, 0.9),
        AttackType::Aimed => (0.9, 1.2, 0.9),
        AttackType::Cover => (0.9, 0.9, 1.2),
    };
    stats.speed = adjusted(stats.speed, speed);
    stats.accuracy = adjusted(stats.accuracy, accuracy);
    stats.dodge = adjusted(stats.dodge, dodge);
}

fn adjusted(value: i32, multiplier: f64) -> i32 {
    (f64::from(value) * multiplier - 1e-10).ceil() as i32
}

fn apply_multipliers(stats: &mut Stats, modifiers: &[Multipliers]) {
    macro_rules! apply {
        ($field:ident) => {{
            let bonus: f64 = modifiers
                .iter()
                .filter_map(|modifier| modifier.$field)
                .map(|multiplier| f64::from(stats.$field) * (multiplier - 1.0))
                .sum();
            if bonus != 0.0 {
                stats.$field += (bonus - 1e-10).ceil() as i32;
            }
        }};
    }
    apply!(armor);
    apply!(speed);
    apply!(accuracy);
    apply!(dodge);
    apply!(melee_skill);
    apply!(gun_skill);
    apply!(proj_skill);
    apply!(def_skill);
    apply!(min_damage);
    apply!(max_damage);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_bundled_catalogs_and_shadow_dojo() {
        let catalogs = Catalogs::bundled().unwrap();
        assert_eq!(catalogs.enemy_set("shadow-dojo").unwrap().len(), 15);
        assert!(catalogs.build("ShadowDojoDLGunBuild2").is_ok());
    }

    #[test]
    fn materializes_known_build() {
        let catalogs = Catalogs::bundled().unwrap();
        let player = catalogs
            .materialize(
                catalogs.build("ShadowDojoDLGunBuild2").unwrap(),
                CombatRole::Attacker,
            )
            .unwrap();
        assert_eq!(player.max_hp, 865);
        assert_eq!(player.weapon1.weapon_type, WeaponType::Gun);
        assert_eq!(player.weapon1.min_damage, 80);
        assert_eq!(player.weapon1.max_damage, 86);
        assert_eq!(player.weapon2.weapon_type, WeaponType::Gun);
        assert_eq!(player.weapon2.min_damage, 120);
        assert_eq!(player.weapon2.max_damage, 138);
    }
}
