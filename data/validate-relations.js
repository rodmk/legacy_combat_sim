'use strict';

const equipment = require('./equipment');
const weaponMods = require('./weapon-mods');

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
    if (!equipment.weapons[weaponKey]) {
      throw new Error(key + ' references unknown weapon ' + weaponKey + '.');
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
