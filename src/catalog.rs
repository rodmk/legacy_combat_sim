use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::Path;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::model::{
    AttackType, BuildDefinition, EquivalentBuildGroup, ItemSelection, Matchup, MatchupRole,
    ModeStats, Player, Stats, Weapon, WeaponType,
};

/// Ordered mapping from stable build keys to build definitions.
pub type BuildCatalog = BTreeMap<String, BuildDefinition>;

/// One concrete way to socket and modify an equipment item.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ItemVariantSource {
    /// Equipment catalog key.
    pub item: String,
    /// One selected modification per supported modification slot.
    pub mods: Vec<String>,
    /// Canonically ordered crystal multiset.
    pub crystals: Vec<String>,
}

/// Socket and modification choices with identical combat statistics.
#[derive(Clone, Debug)]
pub struct ItemVariantGroup {
    /// Materialized statistics shared by the choices.
    pub stats: Stats,
    /// Weapon family, when the item is a weapon.
    pub weapon_type: Option<WeaponType>,
    /// Concrete choices represented by this group.
    pub sources: Vec<ItemVariantSource>,
}

/// Counts recorded while reducing an item's raw variant space.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub struct ItemVariantCounts {
    /// Ordered crystal sequences before relevance filtering.
    pub unfiltered_ordered: usize,
    /// Ordered crystal sequences after relevance filtering.
    pub filtered_ordered: usize,
    /// Canonical multisets after relevance filtering, including modifications.
    pub canonical: usize,
    /// Distinct effective combat-stat groups.
    pub unique_effective: usize,
    /// Componentwise nondominated effective groups.
    pub nondominated: usize,
}

/// Canonical variants and reduction statistics for one equipment item.
#[derive(Clone, Debug)]
pub struct ItemVariantReport {
    /// All distinct effective variants.
    pub groups: Vec<ItemVariantGroup>,
    /// Variants not componentwise dominated by another variant.
    pub nondominated_groups: Vec<ItemVariantGroup>,
    /// Variant-space counts.
    pub counts: ItemVariantCounts,
    /// Crystal keys that can change a relevant nonzero item statistic.
    pub useful_crystals: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct EquipmentCatalog {
    armor: HashMap<String, ItemDefinition>,
    weapons: HashMap<String, ItemDefinition>,
    miscs: HashMap<String, ItemDefinition>,
}

#[derive(Clone, Debug, Deserialize)]
struct ItemDefinition {
    name: String,
    #[serde(rename = "type")]
    weapon_type: Option<WeaponType>,
    #[serde(default)]
    mod_slots: u8,
    #[serde(flatten)]
    stats: Stats,
}

#[derive(Clone, Debug, Deserialize)]
struct CrystalDefinition {
    mult: Multipliers,
}

#[derive(Clone, Debug, Deserialize)]
struct WeaponModDefinition {
    name: String,
    slot: u8,
    compatible: Vec<String>,
    mult: Multipliers,
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
struct Multipliers {
    armor: Option<f64>,
    speed: Option<f64>,
    accuracy: Option<f64>,
    dodge: Option<f64>,
    melee_skill: Option<f64>,
    gun_skill: Option<f64>,
    proj_skill: Option<f64>,
    def_skill: Option<f64>,
    min_damage: Option<f64>,
    max_damage: Option<f64>,
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
        if let Some(key) = builds.keys().find(|key| self.builds.contains_key(*key)) {
            bail!("duplicate build key: {key}");
        }
        self.builds.extend(builds);
        Ok(())
    }

    /// Looks up a build by its stable catalog key.
    pub fn build(&self, key: &str) -> Result<&BuildDefinition> {
        self.builds
            .get(key)
            .with_context(|| format!("unknown build: {key}"))
    }

    /// Iterates over build keys and definitions in stable lexical order.
    pub fn builds(&self) -> impl Iterator<Item = (&str, &BuildDefinition)> {
        self.builds.iter().map(|(key, build)| (key.as_str(), build))
    }

    /// Returns the weapon family for an equipment catalog key.
    pub fn item_weapon_type(&self, key: &str) -> Result<Option<WeaponType>> {
        Ok(self.item_definition(key)?.weapon_type)
    }

    /// Returns stable item keys for an equipment category.
    pub fn item_keys(&self, category: &str) -> Result<Vec<&str>> {
        let catalog = match category {
            "armor" => &self.equipment.armor,
            "weapons" => &self.equipment.weapons,
            "miscs" => &self.equipment.miscs,
            _ => bail!("unknown equipment category: {category}"),
        };
        let mut keys = catalog.keys().map(String::as_str).collect::<Vec<_>>();
        keys.sort_unstable();
        Ok(keys)
    }

    /// Returns the minimal crystal keys that dominate `key`, or the key itself
    /// when it is not dominated componentwise across multiplier fields.
    pub fn nondominated_crystal_replacements(&self, key: &str) -> Result<Vec<String>> {
        let crystal = self
            .crystals
            .get(key)
            .with_context(|| format!("unknown crystal: {key}"))?;
        let mut dominators = self
            .crystals
            .iter()
            .filter(|(_, candidate)| multiplier_dominates(candidate.mult, crystal.mult))
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();
        let candidates = dominators.clone();
        dominators.retain(|candidate| {
            !candidates.iter().any(|other| {
                other != candidate
                    && multiplier_dominates(
                        self.crystals[other].mult,
                        self.crystals[candidate].mult,
                    )
            })
        });
        if dominators.is_empty() {
            Ok(vec![key.to_owned()])
        } else {
            dominators.sort();
            Ok(dominators)
        }
    }

    /// Generates canonical socket and modification variants for an item.
    ///
    /// Crystals that cannot affect a nonzero combat statistic used by either
    /// active weapon family are omitted. Crystals are treated as multisets and
    /// every supported weapon-modification slot is filled. The returned frontier
    /// removes variants whose relevant statistics are componentwise dominated.
    pub fn item_variant_report(
        &self,
        item_key: &str,
        active_weapon_types: &[WeaponType],
        crystal_keys: Option<&[String]>,
        socket_capacity: usize,
    ) -> Result<ItemVariantReport> {
        self.item_variant_report_with_mods(
            item_key,
            active_weapon_types,
            crystal_keys,
            socket_capacity,
            None,
        )
    }

    /// Generates crystal variants while preserving a descriptor's item and mods.
    pub fn descriptor_variant_report(
        &self,
        descriptor: &ItemSelection,
        active_weapon_types: &[WeaponType],
        crystal_keys: Option<&[String]>,
        socket_capacity: usize,
    ) -> Result<ItemVariantReport> {
        self.item_variant_report_with_mods(
            &descriptor.item,
            active_weapon_types,
            crystal_keys,
            socket_capacity,
            Some(&descriptor.mods),
        )
    }

    fn item_variant_report_with_mods(
        &self,
        item_key: &str,
        active_weapon_types: &[WeaponType],
        crystal_keys: Option<&[String]>,
        socket_capacity: usize,
        fixed_mods: Option<&[String]>,
    ) -> Result<ItemVariantReport> {
        let definition = self.item_definition(item_key)?;
        let mut crystals = crystal_keys.map(<[String]>::to_vec).unwrap_or_else(|| {
            let mut keys = self.crystals.keys().cloned().collect::<Vec<_>>();
            keys.sort();
            keys
        });
        for key in &crystals {
            if !self.crystals.contains_key(key) {
                bail!("unknown crystal: {key}");
            }
        }
        let unfiltered_count = crystals.len();
        crystals.retain(|key| {
            useful_multiplier(
                definition.stats,
                self.crystals[key].mult,
                active_weapon_types,
            )
        });
        let useful_crystals = crystals.clone();
        let crystal_sets = crystal_multisets(&crystals, socket_capacity);
        let mod_sets = match fixed_mods {
            Some(mods) => {
                self.materialize_item(&ItemSelection {
                    item: item_key.to_owned(),
                    crystals: Vec::new(),
                    mods: mods.to_vec(),
                })?;
                vec![mods.to_vec()]
            }
            None => self.mod_combinations(item_key, definition)?,
        };
        let mut groups = Vec::<ItemVariantGroup>::new();
        let mut group_by_key = HashMap::<(Option<WeaponType>, Vec<i32>), usize>::new();
        for mods in &mod_sets {
            for selected_crystals in &crystal_sets {
                let source = ItemVariantSource {
                    item: item_key.to_owned(),
                    mods: mods.clone(),
                    crystals: selected_crystals.clone(),
                };
                let materialized = self.materialize_item(&ItemSelection {
                    item: source.item.clone(),
                    mods: source.mods.clone(),
                    crystals: source.crystals.clone(),
                })?;
                let key = (
                    materialized.weapon_type,
                    relevant_stats(materialized.stats, active_weapon_types),
                );
                if let Some(index) = group_by_key.get(&key) {
                    groups[*index].sources.push(source);
                } else {
                    group_by_key.insert(key, groups.len());
                    groups.push(ItemVariantGroup {
                        stats: materialized.stats,
                        weapon_type: materialized.weapon_type,
                        sources: vec![source],
                    });
                }
            }
        }
        let nondominated_groups = groups
            .iter()
            .enumerate()
            .filter(|(index, group)| {
                let candidate = relevant_stats(group.stats, active_weapon_types);
                !groups.iter().enumerate().any(|(other_index, other)| {
                    other_index != *index
                        && dominates_stats(
                            &relevant_stats(other.stats, active_weapon_types),
                            &candidate,
                        )
                })
            })
            .map(|(_, group)| group.clone())
            .collect::<Vec<_>>();
        let ordered = |count: usize| {
            (if count == 0 {
                1
            } else {
                count.pow(socket_capacity as u32)
            }) * mod_sets.len()
        };
        Ok(ItemVariantReport {
            counts: ItemVariantCounts {
                unfiltered_ordered: ordered(unfiltered_count),
                filtered_ordered: ordered(useful_crystals.len()),
                canonical: groups.iter().map(|group| group.sources.len()).sum(),
                unique_effective: groups.len(),
                nondominated: nondominated_groups.len(),
            },
            groups,
            nondominated_groups,
            useful_crystals,
        })
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
    /// [`MatchupRole::Active`] applies the build's selected attack mode.
    /// [`MatchupRole::Opponent`] uses normal-mode speed, accuracy, and dodge.
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
    pub fn materialize(&self, build: &BuildDefinition, role: MatchupRole) -> Result<Player> {
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

        let normal_mode = ModeStats {
            speed: stats.speed,
            accuracy: stats.accuracy,
            dodge: stats.dodge,
        };
        if role == MatchupRole::Active {
            apply_attack_type(&mut stats, build.attack_type);
        }
        Ok(Player {
            name: build.name.clone(),
            level: build.level,
            max_hp: build.stats.hp * 5,
            stats,
            normal_mode,
            weapon1: weapon_from_item(&items[1])?,
            weapon2: weapon_from_item(&items[2])?,
        })
    }

    /// Materializes both sides of a directional build matchup with the correct roles.
    pub fn materialize_matchup(
        &self,
        active: &BuildDefinition,
        opponent: &BuildDefinition,
    ) -> Result<Matchup> {
        Ok(Matchup {
            active: self.materialize(active, MatchupRole::Active)?,
            opponent: self.materialize(opponent, MatchupRole::Opponent)?,
        })
    }

    /// Groups builds by canonical combat behavior while preserving input order.
    ///
    /// Weapon slot order and statistics for unused weapon families do not split a
    /// group. Attack-mode statistics and their normal-mode defensive counterparts
    /// are both included.
    pub fn group_equivalent_builds<'a>(
        &self,
        builds: impl IntoIterator<Item = &'a BuildDefinition>,
    ) -> Result<Vec<EquivalentBuildGroup<'a>>> {
        let mut groups = Vec::<EquivalentBuildGroup<'a>>::new();
        let mut group_by_signature = HashMap::<crate::model::CombatSignature, usize>::new();
        for build in builds {
            let representative = self.materialize(build, MatchupRole::Active)?;
            let signature = crate::combat::combat_signature(&representative);
            if let Some(index) = group_by_signature.get(&signature) {
                groups[*index].builds.push(build);
            } else {
                group_by_signature.insert(signature.clone(), groups.len());
                groups.push(EquivalentBuildGroup {
                    signature,
                    representative,
                    builds: vec![build],
                });
            }
        }
        Ok(groups)
    }

    fn materialize_item(&self, selection: &ItemSelection) -> Result<MaterializedItem> {
        let definition = self.item_definition(&selection.item)?;
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

    fn item_definition(&self, key: &str) -> Result<&ItemDefinition> {
        self.equipment
            .armor
            .get(key)
            .or_else(|| self.equipment.weapons.get(key))
            .or_else(|| self.equipment.miscs.get(key))
            .with_context(|| format!("unknown item: {key}"))
    }

    fn mod_combinations(
        &self,
        item_key: &str,
        definition: &ItemDefinition,
    ) -> Result<Vec<Vec<String>>> {
        let mut combinations = vec![Vec::new()];
        for slot in 1..=definition.mod_slots {
            let mut compatible = self
                .weapon_mods
                .iter()
                .filter(|(_, weapon_mod)| {
                    weapon_mod.slot == slot
                        && weapon_mod.compatible.iter().any(|key| key == item_key)
                })
                .map(|(key, _)| key.clone())
                .collect::<Vec<_>>();
            compatible.sort();
            if compatible.is_empty() {
                bail!(
                    "{} has no compatible modification for slot {slot}",
                    definition.name
                );
            }
            combinations = combinations
                .into_iter()
                .flat_map(|combination| {
                    compatible.iter().map(move |key| {
                        let mut next = combination.clone();
                        next.push(key.clone());
                        next
                    })
                })
                .collect();
        }
        Ok(combinations)
    }
}

fn crystal_multisets(keys: &[String], capacity: usize) -> Vec<Vec<String>> {
    fn add(
        keys: &[String],
        start: usize,
        remaining: usize,
        selected: &mut Vec<String>,
        result: &mut Vec<Vec<String>>,
    ) {
        if remaining == 0 {
            result.push(selected.clone());
            return;
        }
        for index in start..keys.len() {
            selected.push(keys[index].clone());
            add(keys, index, remaining - 1, selected, result);
            selected.pop();
        }
    }
    if keys.is_empty() {
        return vec![Vec::new()];
    }
    let mut result = Vec::new();
    add(keys, 0, capacity, &mut Vec::new(), &mut result);
    result
}

fn relevant_stats(stats: Stats, weapon_types: &[WeaponType]) -> Vec<i32> {
    let mut values = vec![
        stats.min_damage,
        stats.max_damage,
        stats.armor,
        stats.dodge,
        stats.accuracy,
        stats.speed,
        stats.def_skill,
    ];
    let active = weapon_types.iter().copied().collect::<HashSet<_>>();
    for weapon_type in [WeaponType::Gun, WeaponType::Melee, WeaponType::Projectile] {
        if active.contains(&weapon_type) {
            values.push(match weapon_type {
                WeaponType::Melee => stats.melee_skill,
                WeaponType::Gun => stats.gun_skill,
                WeaponType::Projectile => stats.proj_skill,
            });
        }
    }
    values
}

fn useful_multiplier(stats: Stats, multiplier: Multipliers, weapon_types: &[WeaponType]) -> bool {
    let active = weapon_types.iter().copied().collect::<HashSet<_>>();
    (stats.armor != 0 && multiplier.armor.is_some())
        || (stats.speed != 0 && multiplier.speed.is_some())
        || (stats.accuracy != 0 && multiplier.accuracy.is_some())
        || (stats.dodge != 0 && multiplier.dodge.is_some())
        || (stats.def_skill != 0 && multiplier.def_skill.is_some())
        || (stats.min_damage != 0 && multiplier.min_damage.is_some())
        || (stats.max_damage != 0 && multiplier.max_damage.is_some())
        || (active.contains(&WeaponType::Melee)
            && stats.melee_skill != 0
            && multiplier.melee_skill.is_some())
        || (active.contains(&WeaponType::Gun)
            && stats.gun_skill != 0
            && multiplier.gun_skill.is_some())
        || (active.contains(&WeaponType::Projectile)
            && stats.proj_skill != 0
            && multiplier.proj_skill.is_some())
}

fn dominates_stats(left: &[i32], right: &[i32]) -> bool {
    left.iter().zip(right).all(|(left, right)| left >= right)
        && left.iter().zip(right).any(|(left, right)| left > right)
}

fn multiplier_dominates(left: Multipliers, right: Multipliers) -> bool {
    let fields = [
        (left.armor, right.armor),
        (left.speed, right.speed),
        (left.accuracy, right.accuracy),
        (left.dodge, right.dodge),
        (left.melee_skill, right.melee_skill),
        (left.gun_skill, right.gun_skill),
        (left.proj_skill, right.proj_skill),
        (left.def_skill, right.def_skill),
        (left.min_damage, right.min_damage),
        (left.max_damage, right.max_damage),
    ];
    fields
        .iter()
        .all(|(left, right)| left.unwrap_or(1.0) >= right.unwrap_or(1.0))
        && fields
            .iter()
            .any(|(left, right)| left.unwrap_or(1.0) > right.unwrap_or(1.0))
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
    fn duplicate_catalog_merge_is_atomic() {
        let mut catalogs = Catalogs::bundled().unwrap();
        let original_len = catalogs.builds.len();
        let build = catalogs.build("ShadowDojoDLGunBuild2").unwrap().clone();
        let mut additions = BuildCatalog::new();
        additions.insert("ANewBuild".to_owned(), build.clone());
        additions.insert("ShadowDojoDLGunBuild2".to_owned(), build);

        assert!(catalogs.merge_builds(additions).is_err());
        assert_eq!(catalogs.builds.len(), original_len);
        assert!(catalogs.build("ANewBuild").is_err());
    }

    #[test]
    fn materializes_known_build() {
        let catalogs = Catalogs::bundled().unwrap();
        let player = catalogs
            .materialize(
                catalogs.build("ShadowDojoDLGunBuild2").unwrap(),
                MatchupRole::Active,
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

    #[test]
    fn groups_combat_equivalent_builds() {
        let catalogs = Catalogs::bundled().unwrap();
        let original = catalogs
            .build("CoreStaffVoidSwordWithScouts")
            .unwrap()
            .clone();
        let mut reordered = original.clone();
        reordered.name = "Reordered weapons".to_owned();
        std::mem::swap(
            &mut reordered.equipment.weapon1,
            &mut reordered.equipment.weapon2,
        );
        let mut distinct = original.clone();
        distinct.name = "Quick attack".to_owned();
        distinct.attack_type = AttackType::Quick;

        let groups = catalogs
            .group_equivalent_builds([&original, &reordered, &distinct])
            .unwrap();
        assert_eq!(groups.len(), 2);
        let equivalent = groups.iter().find(|group| group.builds.len() == 2).unwrap();
        assert_eq!(equivalent.builds[0].name, original.name);
        assert_eq!(equivalent.builds[1].name, reordered.name);
        assert_eq!(equivalent.representative.name, original.name);
        assert_ne!(groups[0].signature, groups[1].signature);
    }

    #[test]
    fn item_variants_match_legacy_fixture() {
        let catalogs = Catalogs::bundled().unwrap();
        let crystals = [
            "PerfectGreen",
            "PerfectOrange",
            "PerfectYellow",
            "PerfectFire",
        ]
        .map(str::to_owned);
        let report = catalogs
            .item_variant_report(
                "RiftGun",
                &[WeaponType::Gun, WeaponType::Projectile],
                Some(&crystals),
                1,
            )
            .unwrap();

        assert_eq!(
            report.useful_crystals,
            ["PerfectGreen", "PerfectFire"].map(str::to_owned)
        );
        assert_eq!(report.groups.len(), 2);
        assert_eq!(
            report.counts,
            ItemVariantCounts {
                unfiltered_ordered: 4,
                filtered_ordered: 2,
                canonical: 2,
                unique_effective: 2,
                nondominated: 2,
            }
        );
    }
}
