'use strict';

const equipment = require('./equipment');
const crystals = require('./crystals');
const weaponMods = require('./weapon-mods');
const builds = require('./builds');

/** @param {import('../types').WeaponModDefinition} mod */
function compatibilityClass(mod) {
  return mod.slot + ':' + mod.compatible.slice().sort().join(',');
}

/**
 * @param {import('../types').WeaponModDefinition} left
 * @param {import('../types').WeaponModDefinition} right
 */
function dominates(left, right) {
  /** @type {Set<keyof import('../types').GearStats>} */
  let stats = new Set(
    /** @type {Array<keyof import('../types').GearStats>} */ (
      Object.keys(left.mult).concat(Object.keys(right.mult))
    )
  );
  let noWorse = Array.from(stats).every(function(stat) {
    return (left.mult[stat] || 1) >= (right.mult[stat] || 1);
  });
  let better = Array.from(stats).some(function(stat) {
    return (left.mult[stat] || 1) > (right.mult[stat] || 1);
  });
  return noWorse && better;
}

Object.keys(weaponMods).forEach(function(key) {
  weaponMods[key].compatible.forEach(function(weaponKey) {
    let weapon = equipment.weapons[weaponKey];
    if (!weapon) {
      throw new Error(key + ' references unknown weapon ' + weaponKey + '.');
    }
    if ((weapon.mod_slots || 0) < weaponMods[key].slot) {
      throw new Error(key + ' exceeds the mod slot capacity of ' + weaponKey + '.');
    }
  });
});

Object.keys(weaponMods).forEach(function(leftKey) {
  Object.keys(weaponMods).forEach(function(rightKey) {
    let left = weaponMods[leftKey];
    let right = weaponMods[rightKey];
    if (leftKey !== rightKey &&
        compatibilityClass(left) === compatibilityClass(right) &&
        dominates(left, right)) {
      throw new Error(rightKey + ' is strictly dominated by ' + leftKey + '.');
    }
  });
});

/**
 * @param {string} buildKey
 * @param {string} slotName
 * @param {import('../types').BuildItemDefinition | import('../types').BuildWeaponDefinition} slot
 * @param {Readonly<Record<string, import('../types').EquipmentDefinition>>} group
 */
function validateBuildSlot(buildKey, slotName, slot, group) {
  if (!group[slot.item]) {
    throw new Error(buildKey + '.' + slotName + ' references unknown item ' + slot.item + '.');
  }
  (slot.crystals || []).forEach(function(crystalKey) {
    if (!crystals[crystalKey]) {
      throw new Error(buildKey + '.' + slotName + ' references unknown crystal ' + crystalKey + '.');
    }
  });

  let occupiedSlots = new Set();
  let weaponSlot = /** @type {import('../types').BuildWeaponDefinition} */ (slot);
  let modCapacity = equipment.weapons[slot.item] ? equipment.weapons[slot.item].mod_slots || 0 : 0;
  if ((weaponSlot.mods || []).length > modCapacity) {
    throw new Error(buildKey + '.' + slotName + ' exceeds its weapon mod capacity.');
  }
  (weaponSlot.mods || []).forEach(function(modKey) {
    let mod = weaponMods[modKey];
    if (!mod) {
      throw new Error(buildKey + '.' + slotName + ' references unknown mod ' + modKey + '.');
    }
    if (!mod.compatible.includes(slot.item)) {
      throw new Error(modKey + ' is not compatible with ' + slot.item + '.');
    }
    if (occupiedSlots.has(mod.slot)) {
      throw new Error(buildKey + '.' + slotName + ' repeats mod slot ' + mod.slot + '.');
    }
    occupiedSlots.add(mod.slot);
  });
}

Object.keys(builds).forEach(function(buildKey) {
  let build = builds[buildKey];
  let statTotal = build.stats.hp + build.stats.speed + build.stats.accuracy + build.stats.dodge;
  if (statTotal !== 183) {
    throw new Error(buildKey + ' allocates ' + statTotal + ' stats instead of 183.');
  }

  validateBuildSlot(buildKey, 'armor', build.equipment.armor, equipment.armor);
  validateBuildSlot(buildKey, 'weapon1', build.equipment.weapon1, equipment.weapons);
  validateBuildSlot(buildKey, 'weapon2', build.equipment.weapon2, equipment.weapons);
  validateBuildSlot(buildKey, 'misc1', build.equipment.misc1, equipment.miscs);
  validateBuildSlot(buildKey, 'misc2', build.equipment.misc2, equipment.miscs);
});
