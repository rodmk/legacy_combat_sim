// noprotect - for jsbin
/*eslint-env node,
  global module require */
'use strict';

function main() {
  // ============================ COMBAT SIMULATION ============================
  let combatResults = function(attacker, opponents) {
    console.log('---');
    console.log('Attacker: ' + attacker.name);

    let fights = 100000;
    opponents.forEach(function(defender) {
      let res = CombatSim.simulateCombat(attacker, defender, fights);
      let win_rate = res.player1_wins / fights;

      let opponent_text = ' VS ' + defender.name + ': ';
      let win_rate_text = (win_rate * 100).toFixed(2) + '%';
      let output_width = 60;
      let spaces = Array(output_width - opponent_text.length - win_rate_text.length).join(' ');
      console.log(opponent_text + spaces + win_rate_text);
    });
  };

  let testCombatants = [];
  testCombatants.push(Player.generateFullyTrainedPlayer(
    'CStaff/VSword + Scouts',
    { hp: 70, speed: 5, accuracy: 4, dodge: 104 },
    [
      Item.DarkLegionArmor
        .socket(Crystals.allAbyssCrystals),
      Item.CoreStaff
        .socket(Crystals.allAmuletCrystals),
      Item.VoidSword
        .socket(Crystals.allPerfectFires),
      Item.ScoutDrones
        .socket(Crystals.allPerfectAirs),
      Item.ScoutDrones
        .socket(Crystals.allPerfectAirs),
    ]
  ));

  console.log(testCombatants);

  let combatants = [];
  combatants = combatants.concat(testCombatants);
  combatants = combatants.concat(Player.generateReferencePlayers());

  console.log('Running Simulation');
  testCombatants.forEach(function(testCombatant) {
    let combatant = Object.assign({}, testCombatant);
    combatResults(combatant, combatants);
  });
}

// =============================================================================
//                                   Utilities
// =============================================================================
// Returns a random number between min and max
function getRandom(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function ceil(num) {
  // Because of floating number arithmetic, subtract some epsilon first before
  // applying ceil. That way expressions like ceil(110 * 1.1) === 110.
  const EPSILON = 0.0000000001;
  return Math.ceil(num - EPSILON);
}


function idx(obj, key, def) {
  if (obj && typeof obj[key] !== 'undefined') {
    return obj[key];
  } else {
    return def;
  }
}

function deepFreeze(o) {
  let prop, propKey;
  Object.freeze(o); // First freeze the object.
  for (propKey in o) {
    prop = o[propKey];
    if (!o.hasOwnProperty(propKey) || typeof prop !== 'object' || Object.isFrozen(prop)) {
      // If the object is on the prototype, not an object, or is already frozen,
      // skip it. Note that this might leave an unfrozen reference somewhere in the
      // object if there is an already frozen object containing an unfrozen object.
      continue;
    }

    deepFreeze(prop); // Recursively call deepFreeze.
  }
  return o;
}

// =============================================================================
//                                   CombatSim
// =============================================================================
function CombatSim() {}
// Assume fights still unresolved after 100 rounds are draws.
CombatSim.MAX_COMBAT_ROUNDS = 100;

// Perform combat with player1 initiating each fight.
CombatSim.simulateCombat = function(player1, player2, fights) {
  let player1_wins = 0;
  let player2_wins = 0;
  let draws = 0;

  for (let i = 0; i < fights; i++) {
    let r;

    if (player2.speed > player1.speed) {
      r = this.fight(player2, player1);
    } else {
      r = this.fight(player1, player2);
    }

    if (r === player1) {
      player1_wins++;
    } else if (r === player2) {
      player2_wins++;
    } else {
      draws++;
    }
  }

  let results = {
    player1_wins: player1_wins,
    player2_wins: player2_wins,
    draws: draws,
  };
  return results;
};

// Complete the fight
CombatSim.fight = function(att, def) {
  let att_hp = att.max_hp;
  let def_hp = def.max_hp;

  for (let round = 0; round < this.MAX_COMBAT_ROUNDS; round++) {
    def_hp -=
      this.attemptHit(att, def, att.weapon1) +
      this.attemptHit(att, def, att.weapon2);

    if (def_hp <= 0) {
      return att;
    }

    att_hp -=
      this.attemptHit(def, att, def.weapon1) +
      this.attemptHit(def, att, def.weapon2);

    if (att_hp <= 0) {
      return def;
    }
  }

  return null;
};

// Returns damage given to p2 by p1 in one hit
CombatSim.attemptHit = function(att, def, weapon) {
  let net_damage = 0;

  // Roll to-hit and to-damage to see if any damage is applied.
  if (this.rollCombat(att.accuracy, def.dodge) &&
      this.rollCombat(att[weapon.skill], def.def_skill)) {
    let base_damage = getRandom(weapon.min_damage, weapon.max_damage);
    net_damage = this.damageAfterArmor(att.level, def.armor, base_damage);
  }

  return net_damage;
};

CombatSim.damageAfterArmor = function(attacker_level, defender_armor, base_damage) {
  let level_modifier = Math.min(attacker_level, 80) * 7 / 2;
  // The current formula does not specify how to handle fractional final damage;
  // assume it is rounded to the nearest integer.
  return Math.round(base_damage * (level_modifier / (level_modifier + defender_armor)));
};

CombatSim.weaponDamageDistribution = function(att, def, weapon) {
  let accuracy_probability = this.combatProbability(att.accuracy, def.dodge);
  let skill_probability = this.combatProbability(att[weapon.skill], def.def_skill);
  let damaging_hit_probability = accuracy_probability * skill_probability;
  let distribution = new Map();

  if (damaging_hit_probability < 1) {
    distribution.set(0, 1 - damaging_hit_probability);
  }

  let base_damage_outcomes = weapon.max_damage - weapon.min_damage + 1;
  let outcome_probability = damaging_hit_probability / base_damage_outcomes;
  if (outcome_probability > 0) {
    for (let base_damage = weapon.min_damage; base_damage <= weapon.max_damage; base_damage++) {
      let damage = this.damageAfterArmor(att.level, def.armor, base_damage);
      distribution.set(damage, (distribution.get(damage) || 0) + outcome_probability);
    }
  }

  return distribution;
};

CombatSim.attackDamageDistribution = function(att, def) {
  let weapon1_distribution = this.weaponDamageDistribution(att, def, att.weapon1);
  let weapon2_distribution = this.weaponDamageDistribution(att, def, att.weapon2);
  let distribution = new Map();

  weapon1_distribution.forEach(function(weapon1_probability, weapon1_damage) {
    weapon2_distribution.forEach(function(weapon2_probability, weapon2_damage) {
      let damage = weapon1_damage + weapon2_damage;
      let probability = weapon1_probability * weapon2_probability;
      distribution.set(damage, (distribution.get(damage) || 0) + probability);
    });
  });

  return distribution;
};

CombatSim.combatOutcomeDistribution = function(player1, player2) {
  let first = player1;
  let second = player2;
  let first_is_player1 = true;

  if (player2.speed > player1.speed) {
    first = player2;
    second = player1;
    first_is_player1 = false;
  }

  let first_attack = this.attackDamageDistribution(first, second);
  let second_attack = this.attackDamageDistribution(second, first);
  let states = new Map();
  let first_wins = 0;
  let second_wins = 0;
  states.set(first.max_hp + ',' + second.max_hp, 1);

  for (let round = 0; round < this.MAX_COMBAT_ROUNDS; round++) {
    let after_round = new Map();

    states.forEach(function(state_probability, state) {
      let hit_points = state.split(',').map(Number);
      let first_hp = hit_points[0];
      let second_hp = hit_points[1];

      first_attack.forEach(function(first_attack_probability, first_damage) {
        let probability_after_first_attack = state_probability * first_attack_probability;
        let remaining_second_hp = second_hp - first_damage;

        if (remaining_second_hp <= 0) {
          first_wins += probability_after_first_attack;
          return;
        }

        second_attack.forEach(function(second_attack_probability, second_damage) {
          let probability_after_second_attack =
            probability_after_first_attack * second_attack_probability;
          let remaining_first_hp = first_hp - second_damage;

          if (remaining_first_hp <= 0) {
            second_wins += probability_after_second_attack;
            return;
          }

          let next_state = remaining_first_hp + ',' + remaining_second_hp;
          after_round.set(
            next_state,
            (after_round.get(next_state) || 0) + probability_after_second_attack
          );
        });
      });
    });

    states = after_round;
    if (states.size === 0) {
      break;
    }
  }

  let draws = 0;
  states.forEach(function(probability) {
    draws += probability;
  });

  return {
    player1_wins: first_is_player1 ? first_wins : second_wins,
    player2_wins: first_is_player1 ? second_wins : first_wins,
    draws: draws,
  };
};

// Rolls stats against each other
CombatSim.rollCombat = function(stat1, stat2) {
  return Math.random() < this.combatProbability(stat1, stat2);
};

CombatSim.combatProbability = function(offense, defense) {
  // Assume PHP division preserves the fractional offense / 4 and defense / 4
  // values used by the documented combat-percentage formula.
  let offense_range = (offense + 1) - (offense / 4);
  let defense_range = (defense + 1) - (defense / 4);
  let combinations = offense_range * defense_range;
  let overlap;

  if (defense > offense) {
    overlap = Math.max((offense + 1) - (defense / 4), 0);
    return (overlap * (overlap / 2)) / combinations;
  }

  overlap = Math.max((defense + 1) - (offense / 4), 0);
  return (combinations - (overlap * (overlap / 2))) / combinations;
};

let WEAPON_TYPE_TO_SKILL = Object.freeze({
  melee:      'melee_skill',
  gun:        'gun_skill',
  projectile: 'proj_skill',
  unarmed:    'def_skill',
});

let ATTACK_TYPE_MULTIPLIERS = deepFreeze({
  normal: {},
  quick: {
    speed: 1.2,
    accuracy: 0.9,
    dodge: 0.9,
  },
  aimed: {
    speed: 0.9,
    accuracy: 1.2,
    dodge: 0.9,
  },
  cover: {
    speed: 0.9,
    accuracy: 0.9,
    dodge: 1.2,
  },
});

// =============================================================================
//                                    Player
// =============================================================================
function Player() {}

Player.emptyStats = function() {
  return {
    level:       80,
    max_hp:      0,
    armor:       0,
    speed:       0,
    accuracy:    0,
    dodge:       0,
    melee_skill: 0,
    gun_skill:   0,
    proj_skill:  0,
    def_skill:   0,
    weapon1: { type: 'unarmed', min_damage: 0, max_damage: 0 },
    weapon2: { type: 'unarmed', min_damage: 0, max_damage: 0 },
  };
};

Player.fullyTrainedStats = function() {
  return {
    level:       80,
    max_hp:      0,                  // Base 0
    armor:       5,                  // 5 from 'Resilience' Ability
    speed:       50,                 // 50 from 'Time Control' Ability
    accuracy:    10,                 // 10 from 'Target Practice' Ability
    dodge:       10,                 // 10 from 'Agility Training' Ability
    melee_skill: 450,                // Maximum of 400 + 50 from 'Weapon Training' Ability
    gun_skill:   450,
    proj_skill:  450,
    def_skill:   450,                // Maximum of 400 + 50 from 'Self Defense' Ability
    weapon1:     { type: 'unarmed', min_damage: 5, max_damage: 5 }, // +5 Damage bonus from 'Combat Tactics'
    weapon2:     { type: 'unarmed', min_damage: 5, max_damage: 5 },
  };
};

Player.generateFullyTrainedPlayer = function(name, stat_points, items, attack_type) {
  let hp_points       = stat_points.hp;
  let speed_points    = stat_points.speed;
  let dodge_points    = stat_points.dodge;
  let accuracy_points = stat_points.accuracy;

  if (hp_points < 2) {
    throw new Error('HP must be at least 10 (2 points)');
  }

  if (speed_points < 2) {
    throw new Error('Speed must be at least 2 points');
  }

  if (dodge_points < 4) {
    throw new Error('Dodge must be at least 4 points');
  }

  if (accuracy_points < 4) {
    throw new Error('Accuracy must be at least 4 points');
  }

  const MAX_STATS = 183; // 12 fixed + 3 base + 158 from leveling + 10 from 'Versatility' ability
  let total_stats = hp_points + speed_points + dodge_points + accuracy_points;
  if (total_stats !== MAX_STATS) {
    throw new Error('Stats dont add up to max. Total:' + total_stats + ' Expected:' + MAX_STATS + '.');
  }

  let stats = this.fullyTrainedStats();
  stats.max_hp   += hp_points * 5;
  stats.speed    += speed_points * 5;
  stats.dodge    += dodge_points;
  stats.accuracy += accuracy_points;

  let player = this.generatePlayer(name, stats, items, attack_type);
  return player;
};

Player.generatePlayer = function(name, raw_stats, items, attack_type) {
  let stats = Object.assign(this.emptyStats(), raw_stats);
  stats.name = name;

  let equip_stats = Equipment.computeBonuses(items);

  // Player Stats
  stats.armor       += idx(equip_stats, 'armor',       0);
  stats.speed       += idx(equip_stats, 'speed',       0);
  stats.accuracy    += idx(equip_stats, 'accuracy',    0);
  stats.dodge       += idx(equip_stats, 'dodge',       0);
  stats.melee_skill += idx(equip_stats, 'melee_skill', 0);
  stats.gun_skill   += idx(equip_stats, 'gun_skill',   0);
  stats.proj_skill  += idx(equip_stats, 'proj_skill',  0);
  stats.def_skill   += idx(equip_stats, 'def_skill',   0);

  let selected_attack_type = attack_type || 'normal';
  let attack_type_multipliers = ATTACK_TYPE_MULTIPLIERS[selected_attack_type];
  if (!attack_type_multipliers) {
    throw new Error('Unknown attack type: ' + attack_type + '.');
  }
  for (let stat in attack_type_multipliers) {
    // Assume all attack-type adjustments happen before the final result is
    // rounded up.
    stats[stat] = ceil(stats[stat] * attack_type_multipliers[stat]);
  }

  // Weapon 1
  stats.weapon1.type = idx(equip_stats.weapon1, 'type', stats.weapon1.type);
  stats.weapon1.skill = WEAPON_TYPE_TO_SKILL[stats.weapon1.type];
  stats.weapon1.min_damage += idx(equip_stats.weapon1, 'min_damage', 0);
  stats.weapon1.max_damage += idx(equip_stats.weapon1, 'max_damage', 0);

  // Weapon 2
  stats.weapon2.type = idx(equip_stats.weapon2, 'type', stats.weapon2.type);
  stats.weapon2.skill = WEAPON_TYPE_TO_SKILL[stats.weapon2.type];
  stats.weapon2.min_damage += idx(equip_stats.weapon2, 'min_damage', 0);
  stats.weapon2.max_damage += idx(equip_stats.weapon2, 'max_damage', 0);

  return stats;
};

Player.generateBuild = function(build) {
  if (build.level !== 80) {
    throw new Error('Builds require level 80.');
  }

  let slots = [
    build.equipment.armor,
    build.equipment.weapon1,
    build.equipment.weapon2,
    build.equipment.misc1,
    build.equipment.misc2,
  ];
  let items = slots.map(function(slot) {
    let item = Item[slot.item];
    if (slot.mods) {
      item = item.applyMods(slot.mods.map(function(key) {
        return WeaponMod[key];
      }));
    }
    if (slot.crystals) {
      item = item.socket(slot.crystals.map(function(key) {
        return Item[key];
      }));
    }
    return item;
  });

  return Player.generateFullyTrainedPlayer(build.name, build.stats, items, build.attack_type);
};

Player.generateReferencePlayers = function() {
  return Object.keys(Build)
    .filter(function(key) {
      return Build[key].reference !== false;
    })
    .map(function(key) {
      return Player.generateBuild(Build[key]);
    });
};

// =============================================================================
//                                   Equipment
// =============================================================================
function Equipment(stats, catalogKey) {
  Object.assign(this, stats);
  if (catalogKey) {
    Object.defineProperty(this, 'catalogKey', {
      value: catalogKey,
      enumerable: false,
    });
  }
  deepFreeze(this);
}

Equipment.applyMultipliers = function(item, modifiers) {
  let new_stats = Object.assign({}, item);
  let stat_bonuses = {};

  modifiers.forEach(function(modifier) {
    for (let stat in new_stats) {
      let stat_mult = idx(modifier.mult, stat, null);
      if (stat_mult !== null) {
        stat_bonuses[stat] = idx(stat_bonuses, stat, 0) + (new_stats[stat] * (stat_mult - 1));
      }
    }
  });

  for (let stat in stat_bonuses) {
    new_stats[stat] += ceil(stat_bonuses[stat]);
  }

  return new_stats;
};

Equipment.computeBonuses = function(items) {
  let stats = {};

  let weapon1 = items[1];
  stats.weapon1 = weapon1;

  let weapon2 = items[2];
  stats.weapon2 = weapon2;

  let mixed_weap_type = (weapon1 && weapon2) && (weapon1.type !== weapon2.type);

  for (let i = 0; i < 5; i++) {
    let stat_mult = {};
    if ((i === 1 || i === 2) && mixed_weap_type) {
      // Weapon skill doubled on mixed types
      stat_mult[WEAPON_TYPE_TO_SKILL[items[i].type]] = 2;
    }

    for (let stat in items[i]) {
      let stat_bonus = idx(items[i], stat, null);
      if (stat_bonus !== null) {
        stats[stat] = idx(stats, stat, 0) + (stat_bonus * idx(stat_mult, stat, 1));
      }
    }
  }

  return stats;
};


Equipment.prototype.socket = function(crystals) {
  if (!crystals || crystals.length === 0) {
    return this;
  }

  let new_stats = Equipment.applyMultipliers(this, crystals);
  new_stats.crystals = crystals;
  let new_item = new Equipment(new_stats, this.catalogKey);
  return new_item;
};

Equipment.prototype.applyMods = function(mods) {
  if (!mods || mods.length === 0) {
    return this;
  }
  if (!this.type || !this.catalogKey) {
    throw new Error('Weapon mods can only be applied to catalog weapons.');
  }
  if (this.mods) {
    throw new Error('Weapon mods have already been applied to ' + this.name + '.');
  }

  let modSlots = idx(this, 'mod_slots', 0);
  if (mods.length > modSlots) {
    let label = modSlots === 1 ? 'weapon mod' : 'weapon mods';
    throw new Error(this.name + ' supports at most ' + modSlots + ' ' + label + '.');
  }

  let occupiedSlots = {};
  mods.forEach(function(mod) {
    if (mod.slot > modSlots) {
      throw new Error(this.name + ' does not have weapon mod slot ' + mod.slot + '.');
    }
    if (!mod.compatible.includes(this.catalogKey)) {
      throw new Error(mod.name + ' is not compatible with ' + this.name + '.');
    }
    if (occupiedSlots[mod.slot]) {
      throw new Error('Weapon mod slot ' + mod.slot + ' is already occupied.');
    }
    occupiedSlots[mod.slot] = true;
  }, this);

  let new_stats = Equipment.applyMultipliers(this, mods);
  new_stats.mods = mods;
  return new Equipment(new_stats, this.catalogKey);
};

let itemDefinitions = {
  none: {
    name: 'None',
  },
};

let equipmentCatalog = require('./data/equipment');
Object.keys(equipmentCatalog).forEach(function(category) {
  Object.keys(equipmentCatalog[category]).forEach(function(key) {
    itemDefinitions[key] = new Equipment(equipmentCatalog[category][key], key);
  });
});

let crystalDefinitions = require('./data/crystals');
Object.keys(crystalDefinitions).forEach(function(key) {
  itemDefinitions[key] = new Equipment(crystalDefinitions[key]);
});

let Item = deepFreeze(itemDefinitions);

let weaponModDefinitions = require('./data/weapon-mods');
Object.keys(weaponModDefinitions).forEach(function(key) {
  weaponModDefinitions[key].compatible.forEach(function(weaponKey) {
    if (!equipmentCatalog.weapons[weaponKey]) {
      throw new Error(key + ' references unknown weapon ' + weaponKey + '.');
    }
  });
});
let WeaponMod = deepFreeze(weaponModDefinitions);

let Build = deepFreeze(require('./data/builds'));

/**
 * For convenience when socketing items, below are 4x crystal arrays for all
 * crystal types.
 */
let Crystals = deepFreeze({
  allPerfectAirs: [ Item.PerfectAir, Item.PerfectAir, Item.PerfectAir, Item.PerfectAir ],
  allPerfectWaters: [ Item.PerfectWater, Item.PerfectWater, Item.PerfectWater, Item.PerfectWater ],
  allPerfectFires: [ Item.PerfectFire, Item.PerfectFire, Item.PerfectFire, Item.PerfectFire ],
  allPerfectVoids: [ Item.PerfectVoid, Item.PerfectVoid, Item.PerfectVoid, Item.PerfectVoid ],
  allPerfectGreens: [ Item.PerfectGreen, Item.PerfectGreen, Item.PerfectGreen, Item.PerfectGreen ],
  allPerfectOranges: [ Item.PerfectOrange, Item.PerfectOrange, Item.PerfectOrange, Item.PerfectOrange ],
  allPerfectYellows: [ Item.PerfectYellow, Item.PerfectYellow, Item.PerfectYellow, Item.PerfectYellow ],
  allPerfectPinks: [ Item.PerfectPink, Item.PerfectPink, Item.PerfectPink, Item.PerfectPink ],
  allAbyssCrystals: [ Item.AbyssCrystal, Item.AbyssCrystal, Item.AbyssCrystal, Item.AbyssCrystal ],
  allAmuletCrystals: [ Item.AmuletCrystal, Item.AmuletCrystal, Item.AmuletCrystal, Item.AmuletCrystal ],
});

// =============================================================================

// Main entry point
if (typeof require === 'undefined' || require.main === module) {
  main();
}

if (typeof module !== 'undefined') {
  module.exports = {
    CombatSim: CombatSim,
    Player: Player,
    Equipment: Equipment,
    Item: Item,
    WeaponMod: WeaponMod,
    Build: Build,
  };
}
