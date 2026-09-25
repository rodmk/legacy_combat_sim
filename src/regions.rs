use std::collections::{BTreeMap, HashMap, HashSet};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::catalog::{BuildCatalog, Catalogs, ItemVariantGroup};
use crate::combat::{combat_probability, combat_signature};
use crate::model::{
    AttackType, BuildDefinition, CombatSignature, ItemSelection, Loadout, MatchupRole, Player,
    StatAllocation, Stats, Weapon, WeaponType,
};

const ATTACK_TYPES: [AttackType; 4] = [
    AttackType::Normal,
    AttackType::Quick,
    AttackType::Aimed,
    AttackType::Cover,
];

const SCREEN_STATS: [StatAllocation; 10] = [
    stats(173, 2, 4, 4),
    stats(145, 2, 4, 32),
    stats(123, 2, 4, 54),
    stats(101, 2, 4, 76),
    stats(70, 2, 4, 107),
    stats(145, 2, 32, 4),
    stats(123, 2, 54, 4),
    stats(101, 2, 76, 4),
    stats(70, 2, 107, 4),
    stats(70, 37, 38, 38),
];

const fn stats(hp: i32, speed: i32, accuracy: i32, dodge: i32) -> StatAllocation {
    StatAllocation {
        hp,
        speed,
        accuracy,
        dodge,
    }
}

/// Breadth controls for the two-stage global equipment-signature funnel.
#[derive(Clone, Debug)]
pub struct CandidateGenerationOptions {
    /// Prefix used for generated build identifiers.
    pub candidate_prefix: String,
    /// Signatures retained globally per weapon profile after envelope screening.
    pub global_shortlist_size: usize,
    /// Signatures retained per armor and weapon-pair bucket after envelope screening.
    pub bucket_shortlist_size: usize,
    /// Configured signatures retained globally per weapon profile.
    pub configured_global_size: usize,
    /// Configured signatures retained per weapon-pair bucket.
    pub configured_bucket_size: usize,
    /// Number of crystal sockets populated on each item.
    pub socket_capacity: usize,
}

impl Default for CandidateGenerationOptions {
    fn default() -> Self {
        Self {
            candidate_prefix: "Region".to_owned(),
            global_shortlist_size: 2_000,
            bucket_shortlist_size: 2,
            configured_global_size: 125,
            configured_bucket_size: 1,
            socket_capacity: 4,
        }
    }
}

/// Reduction counts for one weapon-family profile.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CandidateProfileReport {
    /// Weapon-family pair.
    pub profile: String,
    /// Complete base-item and weapon-mod signature count.
    pub signatures: usize,
    /// Signatures entering configured proxy evaluation.
    pub envelope_shortlist: usize,
    /// Configured signatures exported as candidate builds.
    pub configured_signatures: usize,
    /// Attack-mode-specific builds exported for the profile.
    pub builds: usize,
    /// Configured finalists in descending proxy-score order.
    pub finalists: Vec<ConfiguredCandidate>,
}

/// A configured equipment finalist retained for global response seeding.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ConfiguredCandidate {
    /// Proxy score against the conditioning mixture.
    pub score: f64,
    /// Strongest configured attack-mode build for this equipment.
    pub build: BuildDefinition,
}

/// Selects unique equipment leaders while preferring distinct weapon pairs.
pub fn select_diverse_leaders(
    candidates: &[ConfiguredCandidate],
    count: usize,
) -> Vec<ConfiguredCandidate> {
    let mut ranked = candidates.to_vec();
    ranked.sort_by(|left, right| compare_score(right.score, left.score));
    let mut selected = Vec::new();
    let mut equipment = HashSet::new();
    let mut weapons = HashSet::new();
    for prefer_new_weapons in [true, false] {
        for candidate in &ranked {
            if selected.len() == count {
                return selected;
            }
            let equipment_key = equipment_signature(&candidate.build.equipment);
            let weapon_key = weapon_pair_signature(&candidate.build.equipment);
            if equipment.contains(&equipment_key)
                || prefer_new_weapons && weapons.contains(&weapon_key)
            {
                continue;
            }
            equipment.insert(equipment_key);
            weapons.insert(weapon_key);
            selected.push(candidate.clone());
        }
    }
    selected
}

/// Generated global candidate archive and its reduction counts.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CandidateGenerationResult {
    /// Candidate builds keyed by deterministic profile-local identifiers.
    pub catalog: BuildCatalog,
    /// Per-profile enumeration and reduction counts.
    pub profiles: Vec<CandidateProfileReport>,
    /// Complete signature count across all profiles.
    pub signature_count: usize,
}

#[derive(Clone)]
struct EquipmentEntry {
    signature: String,
    equipment: Loadout,
}

#[derive(Clone)]
struct ScoredEntry {
    entry: EquipmentEntry,
    score: f64,
}

#[derive(Clone)]
struct ConfiguredEntry {
    entry: EquipmentEntry,
    score: f64,
    leader: BuildDefinition,
    builds: Vec<BuildDefinition>,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct VariantKey {
    selection: ItemSelection,
    weapon_types: Vec<WeaponType>,
    socket_capacity: usize,
}

/// Enumerates every canonical five-item equipment signature, screens it with
/// optimistic envelopes, and exports configured proxy finalists.
///
/// Envelope and configuration scores are heuristic rankings rather than
/// admissible bounds. Every base signature is scored, but signatures removed
/// by either shortlist are not fully configured and may contain responses that
/// the exported catalog does not represent.
pub fn generate_candidate_catalog(
    catalogs: &Catalogs,
    opponents: &[Player],
    weights: &[f64],
    options: &CandidateGenerationOptions,
) -> Result<CandidateGenerationResult> {
    anyhow::ensure!(
        !opponents.is_empty(),
        "candidate generation requires opponents"
    );
    anyhow::ensure!(
        opponents.len() == weights.len() && (weights.iter().sum::<f64>() - 1.0).abs() <= 1e-12,
        "opponent weights must match opponents and sum to one"
    );
    anyhow::ensure!(
        options.global_shortlist_size > 0
            && options.bucket_shortlist_size > 0
            && options.configured_global_size > 0
            && options.configured_bucket_size > 0,
        "candidate shortlist sizes must be positive"
    );

    let profiles = [
        (WeaponType::Melee, WeaponType::Melee),
        (WeaponType::Gun, WeaponType::Gun),
        (WeaponType::Projectile, WeaponType::Projectile),
        (WeaponType::Melee, WeaponType::Gun),
        (WeaponType::Melee, WeaponType::Projectile),
        (WeaponType::Gun, WeaponType::Projectile),
    ];
    let mut catalog = BTreeMap::new();
    let mut reports = Vec::new();
    let mut signature_count = 0;
    let mut variant_cache = HashMap::<VariantKey, Vec<ItemVariantGroup>>::new();

    for (left, right) in profiles {
        let entries = equipment_entries(catalogs, left, right)?;
        signature_count += entries.len();
        let mut scored = Vec::with_capacity(entries.len());
        let mut buckets = HashMap::<String, Vec<ScoredEntry>>::new();
        for entry in entries {
            let score = envelope_score(
                catalogs,
                &entry,
                opponents,
                weights,
                options.socket_capacity,
                &mut variant_cache,
            )?;
            let scored_entry = ScoredEntry {
                entry: entry.clone(),
                score,
            };
            let bucket = buckets.entry(first_stage_bucket(&entry)).or_default();
            bucket.push(scored_entry.clone());
            rank_scored(bucket);
            bucket.truncate(options.bucket_shortlist_size);
            scored.push(scored_entry);
        }
        rank_scored(&mut scored);
        let mut shortlisted = scored
            .iter()
            .take(options.global_shortlist_size)
            .map(|entry| entry.entry.signature.clone())
            .collect::<HashSet<_>>();
        for bucket in buckets.values() {
            shortlisted.extend(bucket.iter().map(|entry| entry.entry.signature.clone()));
        }
        let mut configured = Vec::with_capacity(shortlisted.len());
        for entry in scored
            .into_iter()
            .filter(|entry| shortlisted.contains(&entry.entry.signature))
        {
            configured.push(configure_entry(
                catalogs,
                entry.entry,
                opponents,
                weights,
                options.socket_capacity,
                &mut variant_cache,
            )?);
        }
        rank_configured(&mut configured);
        let mut configured_shortlist = configured
            .iter()
            .take(options.configured_global_size)
            .map(|entry| entry.entry.signature.clone())
            .collect::<HashSet<_>>();
        let mut configured_buckets = HashMap::<String, Vec<&ConfiguredEntry>>::new();
        for entry in &configured {
            let bucket = configured_buckets
                .entry(weapon_pair_bucket(&entry.entry))
                .or_default();
            bucket.push(entry);
            bucket.sort_by(|left, right| compare_score(right.score, left.score));
            bucket.truncate(options.configured_bucket_size);
        }
        for bucket in configured_buckets.values() {
            configured_shortlist.extend(bucket.iter().map(|entry| entry.entry.signature.clone()));
        }
        let finalists = configured
            .into_iter()
            .filter(|entry| configured_shortlist.contains(&entry.entry.signature))
            .collect::<Vec<_>>();
        let prefix = format!(
            "{}{}{}",
            options.candidate_prefix,
            type_name(left),
            type_name(right)
        );
        let mut build_index = 0;
        for finalist in &finalists {
            for mut build in finalist.builds.clone() {
                build_index += 1;
                let id = format!("{prefix}{build_index:04}");
                build.name = id.clone();
                build.reference = Some(false);
                catalog.insert(id, build);
            }
        }
        reports.push(CandidateProfileReport {
            profile: format!("{}+{}", type_key(left), type_key(right)),
            signatures: profile_signature_count(catalogs, left, right)?,
            envelope_shortlist: shortlisted.len(),
            configured_signatures: finalists.len(),
            builds: build_index,
            finalists: finalists
                .iter()
                .map(|entry| ConfiguredCandidate {
                    score: entry.score,
                    build: entry.leader.clone(),
                })
                .collect(),
        });
    }

    Ok(CandidateGenerationResult {
        catalog,
        profiles: reports,
        signature_count,
    })
}

fn equipment_entries(
    catalogs: &Catalogs,
    left_type: WeaponType,
    right_type: WeaponType,
) -> Result<Vec<EquipmentEntry>> {
    let left = catalogs.weapon_descriptors(left_type)?;
    let right = if left_type == right_type {
        left.clone()
    } else {
        catalogs.weapon_descriptors(right_type)?
    };
    let armors = catalogs.item_keys("armor")?;
    let miscs = catalogs.item_keys("miscs")?;
    let mut entries = Vec::with_capacity(profile_signature_count(catalogs, left_type, right_type)?);
    for (left_index, weapon1) in left.iter().enumerate() {
        for (right_index, weapon2) in right.iter().enumerate() {
            if left_type == right_type && right_index < left_index {
                continue;
            }
            for (misc1_index, misc1) in miscs.iter().enumerate() {
                for misc2 in &miscs[misc1_index..] {
                    for armor in &armors {
                        let equipment = Loadout {
                            armor: plain(armor),
                            weapon1: weapon1.clone(),
                            weapon2: weapon2.clone(),
                            misc1: plain(misc1),
                            misc2: plain(misc2),
                        };
                        entries.push(EquipmentEntry {
                            signature: equipment_signature(&equipment),
                            equipment,
                        });
                    }
                }
            }
        }
    }
    Ok(entries)
}

fn weapon_pair_signature(equipment: &Loadout) -> String {
    let mut weapons = [&equipment.weapon1, &equipment.weapon2]
        .map(|selection| {
            let mut mods = selection.mods.clone();
            mods.sort();
            (selection.item.clone(), mods)
        })
        .to_vec();
    weapons.sort();
    serde_json::to_string(&weapons).expect("weapon signature")
}

fn profile_signature_count(
    catalogs: &Catalogs,
    left_type: WeaponType,
    right_type: WeaponType,
) -> Result<usize> {
    let left = catalogs.weapon_descriptors(left_type)?.len();
    let right = catalogs.weapon_descriptors(right_type)?.len();
    let weapons = if left_type == right_type {
        left * (left + 1) / 2
    } else {
        left * right
    };
    let miscs = catalogs.item_keys("miscs")?.len();
    let misc_pairs = miscs * (miscs + 1) / 2;
    Ok(weapons * misc_pairs * catalogs.item_keys("armor")?.len())
}

fn envelope_score(
    catalogs: &Catalogs,
    entry: &EquipmentEntry,
    opponents: &[Player],
    weights: &[f64],
    socket_capacity: usize,
    cache: &mut HashMap<VariantKey, Vec<ItemVariantGroup>>,
) -> Result<f64> {
    let weapon_types = active_weapon_types(catalogs, &entry.equipment)?;
    let groups = slot_groups(
        catalogs,
        &entry.equipment,
        &weapon_types,
        socket_capacity,
        cache,
    )?;
    let mixed = weapon_types.len() == 2;
    let mut maximum = Stats::default();
    for (slot, variants) in groups.iter().enumerate() {
        maximum.armor += max_stat(variants, |stats| stats.armor);
        maximum.speed += max_stat(variants, |stats| stats.speed);
        maximum.accuracy += max_stat(variants, |stats| stats.accuracy);
        maximum.dodge += max_stat(variants, |stats| stats.dodge);
        maximum.def_skill += max_stat(variants, |stats| stats.def_skill);
        maximum.melee_skill += max_stat(variants, |stats| stats.melee_skill)
            * skill_multiplier(slot, mixed, WeaponType::Melee, variants);
        maximum.gun_skill += max_stat(variants, |stats| stats.gun_skill)
            * skill_multiplier(slot, mixed, WeaponType::Gun, variants);
        maximum.proj_skill += max_stat(variants, |stats| stats.proj_skill)
            * skill_multiplier(slot, mixed, WeaponType::Projectile, variants);
    }
    let weapons = [&groups[1], &groups[2]].map(|variants| Weapon {
        weapon_type: variants[0].weapon_type.expect("weapon slot"),
        min_damage: 5 + max_stat(variants, |stats| stats.min_damage),
        max_damage: 5 + max_stat(variants, |stats| stats.max_damage),
    });
    let mut best: f64 = 0.0;
    for stats in SCREEN_STATS {
        for attack_type in ATTACK_TYPES {
            let player = envelope_player(maximum, weapons.clone(), stats, attack_type);
            best = best.max(weighted_proxy(&player, opponents, weights));
        }
    }
    Ok(best)
}

fn configure_entry(
    catalogs: &Catalogs,
    entry: EquipmentEntry,
    opponents: &[Player],
    weights: &[f64],
    socket_capacity: usize,
    cache: &mut HashMap<VariantKey, Vec<ItemVariantGroup>>,
) -> Result<ConfiguredEntry> {
    let weapon_types = active_weapon_types(catalogs, &entry.equipment)?;
    let groups = slot_groups(
        catalogs,
        &entry.equipment,
        &weapon_types,
        socket_capacity,
        cache,
    )?;
    let mut objectives: Vec<fn(Stats) -> i32> = vec![
        |stats| stats.armor,
        |stats| stats.dodge,
        |stats| stats.accuracy,
        |stats| stats.speed,
        |stats| stats.def_skill,
        |stats| stats.min_damage,
        |stats| stats.max_damage,
    ];
    for weapon_type in &weapon_types {
        objectives.push(match weapon_type {
            WeaponType::Melee => |stats| stats.melee_skill,
            WeaponType::Gun => |stats| stats.gun_skill,
            WeaponType::Projectile => |stats| stats.proj_skill,
        });
    }
    let mut specializations = Vec::new();
    let mut seen = HashSet::<CombatSignature>::new();
    for objective in objectives {
        let selections = groups
            .iter()
            .map(|variants| {
                variants
                    .iter()
                    .max_by_key(|group| objective(group.stats))
                    .expect("descriptor variants")
                    .sources[0]
                    .clone()
            })
            .collect::<Vec<_>>();
        let build = BuildDefinition {
            name: "Signature specialization".to_owned(),
            level: 80,
            reference: Some(false),
            attack_type: AttackType::Normal,
            stats: stats(70, 37, 38, 38),
            equipment: Loadout {
                armor: selection(&selections[0]),
                weapon1: selection(&selections[1]),
                weapon2: selection(&selections[2]),
                misc1: selection(&selections[3]),
                misc2: selection(&selections[4]),
            },
        };
        let player = catalogs.materialize(&build, MatchupRole::Active)?;
        if seen.insert(combat_signature(&player)) {
            specializations.push(build);
        }
    }
    let mut best_by_mode = HashMap::<AttackType, (f64, BuildDefinition)>::new();
    for specialization in specializations {
        for allocation in SCREEN_STATS {
            for attack_type in ATTACK_TYPES {
                let mut build = specialization.clone();
                build.stats = allocation;
                build.attack_type = attack_type;
                let player = catalogs.materialize(&build, MatchupRole::Active)?;
                let score = weighted_proxy(&player, opponents, weights);
                if best_by_mode
                    .get(&attack_type)
                    .is_none_or(|(best, _)| score > *best)
                {
                    best_by_mode.insert(attack_type, (score, build));
                }
            }
        }
    }
    let (score, leader) = best_by_mode
        .values()
        .max_by(|left, right| compare_score(left.0, right.0))
        .expect("attack modes");
    let score = *score;
    let leader = leader.clone();
    let builds = ATTACK_TYPES
        .iter()
        .map(|attack_type| best_by_mode.remove(attack_type).expect("attack mode").1)
        .collect();
    Ok(ConfiguredEntry {
        entry,
        score,
        leader,
        builds,
    })
}

fn slot_groups(
    catalogs: &Catalogs,
    equipment: &Loadout,
    weapon_types: &[WeaponType],
    socket_capacity: usize,
    cache: &mut HashMap<VariantKey, Vec<ItemVariantGroup>>,
) -> Result<Vec<Vec<ItemVariantGroup>>> {
    [
        &equipment.armor,
        &equipment.weapon1,
        &equipment.weapon2,
        &equipment.misc1,
        &equipment.misc2,
    ]
    .into_iter()
    .map(|descriptor| {
        let key = VariantKey {
            selection: descriptor.clone(),
            weapon_types: weapon_types.to_vec(),
            socket_capacity,
        };
        if let Some(groups) = cache.get(&key) {
            return Ok(groups.clone());
        }
        let groups = catalogs
            .descriptor_variant_report(descriptor, weapon_types, None, socket_capacity)?
            .nondominated_groups;
        cache.insert(key, groups.clone());
        Ok(groups)
    })
    .collect()
}

fn envelope_player(
    equipment: Stats,
    weapons: [Weapon; 2],
    allocated: StatAllocation,
    attack_type: AttackType,
) -> Player {
    let normal_mode = crate::model::ModeStats {
        speed: 50 + allocated.speed * 5 + equipment.speed,
        accuracy: 10 + allocated.accuracy + equipment.accuracy,
        dodge: 10 + allocated.dodge + equipment.dodge,
    };
    let mut stats = equipment;
    stats.armor += 5;
    stats.speed = normal_mode.speed;
    stats.accuracy = normal_mode.accuracy;
    stats.dodge = normal_mode.dodge;
    stats.melee_skill += 450;
    stats.gun_skill += 450;
    stats.proj_skill += 450;
    stats.def_skill += 450;
    apply_mode(&mut stats, attack_type);
    Player {
        name: "Screened".to_owned(),
        level: 80,
        max_hp: allocated.hp * 5,
        stats,
        normal_mode,
        weapon1: weapons[0].clone(),
        weapon2: weapons[1].clone(),
    }
}

fn weighted_proxy(player: &Player, opponents: &[Player], weights: &[f64]) -> f64 {
    opponents
        .iter()
        .zip(weights)
        .map(|(opponent, weight)| weight * role_averaged_proxy(player, opponent))
        .sum()
}

fn role_averaged_proxy(player: &Player, opponent: &Player) -> f64 {
    (proxy_score(player, opponent) + 1.0 - proxy_score(opponent, player)) / 2.0
}

fn proxy_score(attacker: &Player, defender: &Player) -> f64 {
    let defending = defender.in_normal_mode();
    let attacking_defender = attacker.in_normal_mode();
    let damage = expected_damage(attacker, &defending);
    let return_damage = expected_damage(defender, &attacking_defender);
    let rounds_to_win = if damage > 0.0 {
        f64::from(defending.max_hp) / damage
    } else {
        f64::INFINITY
    };
    let rounds_to_lose = if return_damage > 0.0 {
        f64::from(attacking_defender.max_hp) / return_damage
    } else {
        f64::INFINITY
    };
    if rounds_to_win.is_infinite() && rounds_to_lose.is_infinite() {
        return 0.5;
    }
    let mut margin = ((rounds_to_lose + 0.5) / (rounds_to_win + 0.5)).ln();
    if attacker.stats.speed > defending.stats.speed {
        margin += 0.1;
    } else if attacker.stats.speed < defending.stats.speed {
        margin -= 0.1;
    }
    1.0 / (1.0 + (-2.0 * margin).exp())
}

fn expected_damage(attacker: &Player, defender: &Player) -> f64 {
    [&attacker.weapon1, &attacker.weapon2]
        .into_iter()
        .map(|weapon| {
            let hit = combat_probability(attacker.stats.accuracy, defender.stats.dodge)
                * combat_probability(attacker.skill_for(weapon), defender.stats.def_skill);
            let base = f64::from(weapon.min_damage + weapon.max_damage) / 2.0;
            let level_modifier = f64::from(attacker.level.min(80)) * 7.0 / 2.0;
            let damage = (base
                * (level_modifier / (level_modifier + f64::from(defender.stats.armor))))
            .round();
            hit * damage
        })
        .sum()
}

fn active_weapon_types(catalogs: &Catalogs, equipment: &Loadout) -> Result<Vec<WeaponType>> {
    let mut types = vec![
        catalogs
            .item_weapon_type(&equipment.weapon1.item)?
            .context("weapon1 is not a weapon")?,
        catalogs
            .item_weapon_type(&equipment.weapon2.item)?
            .context("weapon2 is not a weapon")?,
    ];
    types.sort();
    types.dedup();
    Ok(types)
}

fn max_stat(groups: &[ItemVariantGroup], getter: fn(Stats) -> i32) -> i32 {
    groups
        .iter()
        .map(|group| getter(group.stats))
        .max()
        .unwrap_or(0)
}

fn skill_multiplier(
    slot: usize,
    mixed: bool,
    weapon_type: WeaponType,
    groups: &[ItemVariantGroup],
) -> i32 {
    if mixed && (slot == 1 || slot == 2) && groups[0].weapon_type == Some(weapon_type) {
        2
    } else {
        1
    }
}

fn apply_mode(stats: &mut Stats, attack_type: AttackType) {
    let multiply = |value: i32, multiplier: f64| (f64::from(value) * multiplier).ceil() as i32;
    match attack_type {
        AttackType::Normal => {}
        AttackType::Quick => {
            stats.speed = multiply(stats.speed, 1.2);
            stats.accuracy = multiply(stats.accuracy, 0.9);
            stats.dodge = multiply(stats.dodge, 0.9);
        }
        AttackType::Aimed => {
            stats.speed = multiply(stats.speed, 0.9);
            stats.accuracy = multiply(stats.accuracy, 1.2);
            stats.dodge = multiply(stats.dodge, 0.9);
        }
        AttackType::Cover => {
            stats.speed = multiply(stats.speed, 0.9);
            stats.accuracy = multiply(stats.accuracy, 0.9);
            stats.dodge = multiply(stats.dodge, 1.2);
        }
    }
}

fn rank_scored(entries: &mut [ScoredEntry]) {
    entries.sort_by(|left, right| {
        compare_score(right.score, left.score)
            .then_with(|| left.entry.signature.cmp(&right.entry.signature))
    });
}

fn rank_configured(entries: &mut [ConfiguredEntry]) {
    entries.sort_by(|left, right| {
        compare_score(right.score, left.score)
            .then_with(|| left.entry.signature.cmp(&right.entry.signature))
    });
}

fn compare_score(left: f64, right: f64) -> std::cmp::Ordering {
    left.total_cmp(&right)
}

fn first_stage_bucket(entry: &EquipmentEntry) -> String {
    format!(
        "{}|{}",
        entry.equipment.armor.item,
        weapon_pair_bucket(entry)
    )
}

fn weapon_pair_bucket(entry: &EquipmentEntry) -> String {
    let mut weapons = [
        entry.equipment.weapon1.item.as_str(),
        entry.equipment.weapon2.item.as_str(),
    ];
    weapons.sort();
    format!("{}|{}", weapons[0], weapons[1])
}

fn equipment_signature(equipment: &Loadout) -> String {
    let mut weapons = [
        descriptor_key(&equipment.weapon1),
        descriptor_key(&equipment.weapon2),
    ];
    weapons.sort();
    let mut miscs = [
        descriptor_key(&equipment.misc1),
        descriptor_key(&equipment.misc2),
    ];
    miscs.sort();
    format!(
        "{}|{}|{}|{}|{}",
        descriptor_key(&equipment.armor),
        weapons[0],
        weapons[1],
        miscs[0],
        miscs[1]
    )
}

fn descriptor_key(selection: &ItemSelection) -> String {
    let mut mods = selection.mods.clone();
    mods.sort();
    format!("{}:[{}]", selection.item, mods.join(","))
}

fn plain(item: &str) -> ItemSelection {
    ItemSelection {
        item: item.to_owned(),
        crystals: Vec::new(),
        mods: Vec::new(),
    }
}

fn selection(source: &crate::catalog::ItemVariantSource) -> ItemSelection {
    ItemSelection {
        item: source.item.clone(),
        crystals: source.crystals.clone(),
        mods: source.mods.clone(),
    }
}

fn type_key(weapon_type: WeaponType) -> &'static str {
    match weapon_type {
        WeaponType::Melee => "melee",
        WeaponType::Gun => "gun",
        WeaponType::Projectile => "projectile",
    }
}

fn type_name(weapon_type: WeaponType) -> &'static str {
    match weapon_type {
        WeaponType::Melee => "Melee",
        WeaponType::Gun => "Gun",
        WeaponType::Projectile => "Projectile",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_signature_space_matches_expected_total() {
        let catalogs = Catalogs::bundled().unwrap();
        let profiles = [
            (WeaponType::Melee, WeaponType::Melee),
            (WeaponType::Gun, WeaponType::Gun),
            (WeaponType::Projectile, WeaponType::Projectile),
            (WeaponType::Melee, WeaponType::Gun),
            (WeaponType::Melee, WeaponType::Projectile),
            (WeaponType::Gun, WeaponType::Projectile),
        ];
        let counts = profiles
            .into_iter()
            .map(|(left, right)| profile_signature_count(&catalogs, left, right).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(counts, vec![64_260, 44_100, 27_720, 99_960, 78_540, 64_680]);
        assert_eq!(counts.into_iter().sum::<usize>(), 379_260);
    }

    #[test]
    fn diverse_leaders_prefer_distinct_weapon_pairs() {
        let catalogs = Catalogs::bundled().unwrap();
        let base = catalogs.build("EntryLevelCrystalSwords").unwrap();
        let candidate = |score, weapon1: &str, weapon2: &str, armor: &str| {
            let mut build = base.clone();
            build.equipment.weapon1 = plain(weapon1);
            build.equipment.weapon2 = plain(weapon2);
            build.equipment.armor = plain(armor);
            ConfiguredCandidate { score, build }
        };
        let candidates = vec![
            candidate(0.9, "CrystalSword", "CrystalSword", "CrystalArmor"),
            candidate(0.8, "CrystalSword", "CrystalSword", "DarkLegionArmor"),
            candidate(0.7, "KnuckleDuster", "CrystalSword", "CrystalArmor"),
            candidate(0.6, "KnuckleDuster", "KnuckleDuster", "CrystalArmor"),
        ];
        let selected = select_diverse_leaders(&candidates, 3);
        assert_eq!(
            selected.iter().map(|entry| entry.score).collect::<Vec<_>>(),
            vec![0.9, 0.7, 0.6]
        );
    }
}
