use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::Path;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::catalog::Catalogs;
use crate::model::{BuildDefinition, ItemSelection, MatchupRole};

/// Owned quantities available to one complete build.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Inventory {
    /// Counts of base equipment items.
    #[serde(default)]
    pub items: BTreeMap<String, usize>,
    /// Counts of loose crystals, shared across all equipment slots.
    #[serde(default)]
    pub crystals: BTreeMap<String, usize>,
    /// Counts of weapon modifications, shared across both weapons.
    #[serde(default)]
    pub mods: BTreeMap<String, usize>,
}

impl Inventory {
    /// Reads an inventory document and checks its keys against the catalogs.
    pub fn from_path(path: &Path, catalogs: &Catalogs) -> Result<Self> {
        let data = fs::read_to_string(path)
            .with_context(|| format!("failed to read inventory {}", path.display()))?;
        let inventory: Self = serde_json::from_str(&data)
            .with_context(|| format!("invalid inventory JSON in {}", path.display()))?;
        inventory.validate(catalogs)?;
        Ok(inventory)
    }

    /// Rejects unknown item, crystal, and modification keys.
    pub fn validate(&self, catalogs: &Catalogs) -> Result<()> {
        let items = ["armor", "weapons", "miscs"]
            .into_iter()
            .map(|category| catalogs.item_keys(category))
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .flatten()
            .collect::<HashSet<_>>();
        let crystals = catalogs.crystal_keys().into_iter().collect::<HashSet<_>>();
        let mods = catalogs.mod_keys().into_iter().collect::<HashSet<_>>();
        for key in self.items.keys() {
            if !items.contains(key.as_str()) {
                bail!("inventory contains unknown item {key}");
            }
        }
        for key in self.crystals.keys() {
            if !crystals.contains(key.as_str()) {
                bail!("inventory contains unknown crystal {key}");
            }
        }
        for key in self.mods.keys() {
            if !mods.contains(key.as_str()) {
                bail!("inventory contains unknown weapon modification {key}");
            }
        }
        Ok(())
    }

    /// Whether every equipped item, crystal, and modification is owned.
    pub fn contains(&self, build: &BuildDefinition) -> bool {
        self.shortages(build).is_empty()
    }

    /// Returns missing quantities for a complete build.
    pub fn shortages(&self, build: &BuildDefinition) -> Vec<String> {
        let mut items = BTreeMap::<&str, usize>::new();
        let mut crystals = BTreeMap::<&str, usize>::new();
        let mut mods = BTreeMap::<&str, usize>::new();
        for selection in selections(build) {
            *items.entry(&selection.item).or_default() += 1;
            for crystal in &selection.crystals {
                *crystals.entry(crystal).or_default() += 1;
            }
            for modification in &selection.mods {
                *mods.entry(modification).or_default() += 1;
            }
        }
        let mut shortages = Vec::new();
        for (key, needed) in items {
            let owned = self.items.get(key).copied().unwrap_or(0);
            if needed > owned {
                shortages.push(format!("item {key}: need {needed}, own {owned}"));
            }
        }
        for (key, needed) in crystals {
            let owned = self.crystals.get(key).copied().unwrap_or(0);
            if needed > owned {
                shortages.push(format!("crystal {key}: need {needed}, own {owned}"));
            }
        }
        for (key, needed) in mods {
            let owned = self.mods.get(key).copied().unwrap_or(0);
            if needed > owned {
                shortages.push(format!("mod {key}: need {needed}, own {owned}"));
            }
        }
        shortages
    }

    /// Enumerates owned base-equipment combinations using a build's crystals and stats.
    pub fn equipment_seeds(
        &self,
        catalogs: &Catalogs,
        template: &BuildDefinition,
    ) -> Result<Vec<BuildDefinition>> {
        let owned = |category| -> Result<Vec<String>> {
            Ok(catalogs
                .item_keys(category)?
                .into_iter()
                .filter(|key| self.items.get(*key).copied().unwrap_or(0) > 0)
                .map(str::to_owned)
                .collect())
        };
        let armors = owned("armor")?;
        let weapons = owned("weapons")?;
        let miscs = owned("miscs")?;
        let mut seeds = Vec::new();
        for armor in &armors {
            for (first_index, first_weapon) in weapons.iter().enumerate() {
                for second_weapon in weapons.iter().skip(first_index) {
                    for (first_misc_index, first_misc) in miscs.iter().enumerate() {
                        for second_misc in miscs.iter().skip(first_misc_index) {
                            let mut build = template.clone();
                            build.equipment.armor.item = armor.clone();
                            build.equipment.weapon1.item = first_weapon.clone();
                            build.equipment.weapon2.item = second_weapon.clone();
                            build.equipment.misc1.item = first_misc.clone();
                            build.equipment.misc2.item = second_misc.clone();
                            for selection in [
                                &mut build.equipment.armor,
                                &mut build.equipment.weapon1,
                                &mut build.equipment.weapon2,
                                &mut build.equipment.misc1,
                                &mut build.equipment.misc2,
                            ] {
                                selection.mods.clear();
                            }
                            if !self.contains(&build) {
                                continue;
                            }
                            catalogs.materialize(&build, MatchupRole::Active)?;
                            seeds.push(build);
                        }
                    }
                }
            }
        }
        Ok(seeds)
    }
}

fn selections(build: &BuildDefinition) -> [&ItemSelection; 5] {
    [
        &build.equipment.armor,
        &build.equipment.weapon1,
        &build.equipment.weapon2,
        &build.equipment.misc1,
        &build.equipment.misc2,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::search::{equipment_neighborhood, EquipmentNeighborhoodOptions, EquipmentSlot};

    fn current_inventory(build: &BuildDefinition) -> Inventory {
        let mut inventory = Inventory::default();
        for selection in selections(build) {
            *inventory.items.entry(selection.item.clone()).or_default() += 1;
            for crystal in &selection.crystals {
                *inventory.crystals.entry(crystal.clone()).or_default() += 1;
            }
            for modification in &selection.mods {
                *inventory.mods.entry(modification.clone()).or_default() += 1;
            }
        }
        inventory
    }

    #[test]
    fn quantities_are_shared_across_equipment_slots() {
        let catalogs = Catalogs::bundled().unwrap();
        let current = catalogs.build("CurrentBuild").unwrap();
        let mut inventory = current_inventory(current);
        inventory.validate(&catalogs).unwrap();
        assert!(inventory.contains(current));
        inventory.items.insert("RiftGun".to_owned(), 1);
        assert!(inventory
            .shortages(current)
            .iter()
            .any(|line| line.contains("RiftGun")));
        inventory.items.insert("RiftGun".to_owned(), 2);
        inventory.crystals.insert("AmuletCrystal".to_owned(), 7);
        assert!(inventory
            .shortages(current)
            .iter()
            .any(|line| line.contains("AmuletCrystal")));
    }

    #[test]
    fn unknown_keys_are_rejected() {
        let catalogs = Catalogs::bundled().unwrap();
        let mut inventory = Inventory::default();
        inventory.items.insert("UnknownItem".to_owned(), 1);
        assert!(inventory.validate(&catalogs).is_err());
    }

    #[test]
    fn neighborhood_uses_only_owned_resources_and_can_leave_sockets_empty() {
        let catalogs = Catalogs::bundled().unwrap();
        let current = catalogs.build("CurrentBuild").unwrap();
        let mut inventory = current_inventory(current);
        inventory.items.insert("AlienRifle".to_owned(), 1);
        let neighborhood = equipment_neighborhood(
            &catalogs,
            current,
            &EquipmentNeighborhoodOptions {
                slots: vec![EquipmentSlot::Weapon1],
                item_keys_by_slot: std::collections::HashMap::from([(
                    EquipmentSlot::Weapon1,
                    vec!["AlienRifle".to_owned()],
                )]),
                inventory: Some(inventory.clone()),
                ..EquipmentNeighborhoodOptions::default()
            },
        )
        .unwrap();
        let sources = neighborhood
            .groups
            .iter()
            .flat_map(|group| &group.sources)
            .collect::<Vec<_>>();
        assert!(!sources.is_empty());
        assert!(sources
            .iter()
            .all(|source| inventory.contains(&source.build)));
        assert!(sources
            .iter()
            .any(|source| source.equipment.crystals.is_empty()));
    }

    #[test]
    fn mod_slots_can_remain_empty_when_no_mod_is_owned() {
        let catalogs = Catalogs::bundled().unwrap();
        let mut build = catalogs.build("LiveSample013").unwrap().clone();
        build.equipment.weapon2.mods.clear();
        let inventory = current_inventory(&build);
        let neighborhood = equipment_neighborhood(
            &catalogs,
            &build,
            &EquipmentNeighborhoodOptions {
                slots: vec![EquipmentSlot::Weapon2],
                item_keys_by_slot: std::collections::HashMap::from([(
                    EquipmentSlot::Weapon2,
                    vec!["CrystalCrossbow".to_owned()],
                )]),
                inventory: Some(inventory.clone()),
                ..EquipmentNeighborhoodOptions::default()
            },
        )
        .unwrap();
        let sources = neighborhood
            .groups
            .iter()
            .flat_map(|group| &group.sources)
            .collect::<Vec<_>>();
        assert!(!sources.is_empty());
        assert!(sources
            .iter()
            .all(|source| source.equipment.mods.is_empty()));
        assert!(sources
            .iter()
            .all(|source| inventory.contains(&source.build)));
    }

    #[test]
    fn owned_equipment_combinations_are_enumerated() {
        let catalogs = Catalogs::bundled().unwrap();
        let current = catalogs.build("CurrentBuild").unwrap();
        let mut inventory = current_inventory(current);
        inventory.items.insert("CoreStaff".to_owned(), 2);
        inventory.items.insert("VoidAxe".to_owned(), 2);
        inventory.items.insert("OrphicAmulet".to_owned(), 1);
        let seeds = inventory.equipment_seeds(&catalogs, current).unwrap();
        assert_eq!(seeds.len(), 12);
        assert!(seeds.iter().all(|build| inventory.contains(build)));
        assert!(seeds.iter().any(|build| {
            build.equipment.weapon1.item == "CoreStaff"
                && build.equipment.weapon2.item == "VoidAxe"
                && build.equipment.misc2.item == "OrphicAmulet"
        }));
    }
}
