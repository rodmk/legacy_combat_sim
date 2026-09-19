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

CombatSim.healingCost = function(current_hp, max_hp) {
  // Assume healing costs the rounded missing HP divided by six, plus five
  // credits when reviving from zero HP.
  return Math.round((max_hp - current_hp) / 6) + (current_hp === 0 ? 5 : 0);
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

CombatSim.combatSignature = function(player) {
  let weapons = [ player.weapon1, player.weapon2 ].map(function(weapon) {
    return [ weapon.skill, weapon.min_damage, weapon.max_damage ];
  });
  let active_skills = Array.from(new Set(weapons.map(function(weapon) {
    return weapon[0];
  }))).sort().map(function(skill) {
    return [ skill, player[skill] ];
  });
  weapons.sort(function(a, b) {
    return JSON.stringify(a).localeCompare(JSON.stringify(b));
  });

  return JSON.stringify([
    player.level,
    player.max_hp,
    player.armor,
    player.speed,
    player.accuracy,
    player.dodge,
    player.def_skill,
    active_skills,
    weapons,
  ]);
};

CombatSim.defeatRoundDistribution = function(att, def) {
  let attack = Array.from(this.attackDamageDistribution(att, def));
  let lethal_probability = new Float64Array(def.max_hp + 1);
  let healing_cost = new Uint32Array(def.max_hp + 1);
  let remaining_hp = new Float64Array(def.max_hp + 1);
  let defeat_rounds = new Array(this.MAX_COMBAT_ROUNDS + 1).fill(0);
  let surviving_hp_by_round = new Array(this.MAX_COMBAT_ROUNDS + 1).fill(0);
  let surviving_healing_cost_by_round = new Array(this.MAX_COMBAT_ROUNDS + 1).fill(0);
  let full_hp_probability_by_round = new Array(this.MAX_COMBAT_ROUNDS + 1).fill(0);
  attack.sort(function(a, b) { return a[0] - b[0]; });

  for (let hit_points = 1; hit_points <= def.max_hp; hit_points++) {
    healing_cost[hit_points] = this.healingCost(hit_points, def.max_hp);
    for (let outcome = 0; outcome < attack.length; outcome++) {
      if (attack[outcome][0] >= hit_points) {
        lethal_probability[hit_points] += attack[outcome][1];
      }
    }
  }

  remaining_hp[def.max_hp] = 1;
  surviving_hp_by_round[0] = def.max_hp;
  full_hp_probability_by_round[0] = 1;

  for (let round = 1; round <= this.MAX_COMBAT_ROUNDS; round++) {
    let next_remaining_hp = new Float64Array(def.max_hp + 1);
    let next_surviving_hp = 0;
    let next_surviving_healing_cost = 0;
    let next_full_hp_probability = 0;
    let has_survivors = false;

    for (let hit_points = 1; hit_points <= def.max_hp; hit_points++) {
      let state_probability = remaining_hp[hit_points];
      if (state_probability === 0) {
        continue;
      }

      defeat_rounds[round] += state_probability * lethal_probability[hit_points];
      for (let outcome = 0; outcome < attack.length; outcome++) {
        let damage = attack[outcome][0];
        if (damage >= hit_points) {
          break;
        }

        let probability = state_probability * attack[outcome][1];
        let next_hit_points = hit_points - damage;
        next_remaining_hp[next_hit_points] += probability;
        next_surviving_hp += next_hit_points * probability;
        next_surviving_healing_cost += healing_cost[next_hit_points] * probability;
        if (next_hit_points === def.max_hp) {
          next_full_hp_probability += probability;
        }
        has_survivors = true;
      }
    }

    remaining_hp = next_remaining_hp;
    surviving_hp_by_round[round] = next_surviving_hp;
    surviving_healing_cost_by_round[round] = next_surviving_healing_cost;
    full_hp_probability_by_round[round] = next_full_hp_probability;
    if (!has_survivors) {
      break;
    }
  }

  let survives = 0;
  for (let hit_points = 1; hit_points <= def.max_hp; hit_points++) {
    survives += remaining_hp[hit_points];
  }

  return {
    defeat_rounds: defeat_rounds,
    survives: survives,
    surviving_hp_by_round: surviving_hp_by_round,
    surviving_healing_cost_by_round: surviving_healing_cost_by_round,
    full_hp_probability_by_round: full_hp_probability_by_round,
  };
};

CombatSim.combatResultDistribution = function(player1, player2) {
  let first = player1;
  let second = player2;
  let first_is_player1 = true;

  if (player2.speed > player1.speed) {
    first = player2;
    second = player1;
    first_is_player1 = false;
  }

  let first_defeats_second = this.defeatRoundDistribution(first, second);
  let second_defeats_first = this.defeatRoundDistribution(second, first);
  let first_wins = 0;
  let second_wins = 0;
  let first_win_hp = 0;
  let second_win_hp = 0;
  let first_zero_damage_wins = 0;
  let second_zero_damage_wins = 0;
  let first_win_healing_cost = 0;
  let second_win_healing_cost = 0;
  let first_survival_probability = 1;
  let second_survival_probability = 1;

  for (let round = 1; round <= this.MAX_COMBAT_ROUNDS; round++) {
    first_wins += first_defeats_second.defeat_rounds[round] * second_survival_probability;
    first_win_hp += first_defeats_second.defeat_rounds[round] *
      second_defeats_first.surviving_hp_by_round[round - 1];
    first_zero_damage_wins += first_defeats_second.defeat_rounds[round] *
      second_defeats_first.full_hp_probability_by_round[round - 1];
    first_win_healing_cost += first_defeats_second.defeat_rounds[round] *
      second_defeats_first.surviving_healing_cost_by_round[round - 1];
    first_survival_probability -= first_defeats_second.defeat_rounds[round];
    second_wins += second_defeats_first.defeat_rounds[round] * first_survival_probability;
    second_win_hp += second_defeats_first.defeat_rounds[round] *
      first_defeats_second.surviving_hp_by_round[round];
    second_zero_damage_wins += second_defeats_first.defeat_rounds[round] *
      first_defeats_second.full_hp_probability_by_round[round];
    second_win_healing_cost += second_defeats_first.defeat_rounds[round] *
      first_defeats_second.surviving_healing_cost_by_round[round];
    second_survival_probability -= second_defeats_first.defeat_rounds[round];
  }

  let draws = first_defeats_second.survives * second_defeats_first.survives;
  let first_draw_hp = second_defeats_first.surviving_hp_by_round[this.MAX_COMBAT_ROUNDS] *
    first_defeats_second.survives;
  let second_draw_hp = first_defeats_second.surviving_hp_by_round[this.MAX_COMBAT_ROUNDS] *
    second_defeats_first.survives;
  let first_draw_healing_cost = second_defeats_first
    .surviving_healing_cost_by_round[this.MAX_COMBAT_ROUNDS] * first_defeats_second.survives;
  let second_draw_healing_cost = first_defeats_second
    .surviving_healing_cost_by_round[this.MAX_COMBAT_ROUNDS] * second_defeats_first.survives;
  let first_result = {
    wins: first_wins,
    expected_hp_remaining: first_win_hp + first_draw_hp,
    expected_hp_lost_on_win: first_wins > 0 ? first.max_hp - (first_win_hp / first_wins) : null,
    zero_damage_win_probability: first_wins > 0 ? first_zero_damage_wins / first_wins : null,
    expected_healing_cost_on_win: first_wins > 0 ? first_win_healing_cost / first_wins : null,
    expected_healing_cost: first_win_healing_cost + first_draw_healing_cost +
      (second_wins * this.healingCost(0, first.max_hp)),
  };
  let second_result = {
    wins: second_wins,
    expected_hp_remaining: second_win_hp + second_draw_hp,
    expected_hp_lost_on_win: second_wins > 0 ? second.max_hp - (second_win_hp / second_wins) : null,
    zero_damage_win_probability: second_wins > 0 ? second_zero_damage_wins / second_wins : null,
    expected_healing_cost_on_win: second_wins > 0 ? second_win_healing_cost / second_wins : null,
    expected_healing_cost: second_win_healing_cost + second_draw_healing_cost +
      (first_wins * this.healingCost(0, second.max_hp)),
  };
  first_result.expected_hp_lost = first.max_hp - first_result.expected_hp_remaining;
  second_result.expected_hp_lost = second.max_hp - second_result.expected_hp_remaining;

  return {
    outcome: {
      player1_wins: first_is_player1 ? first_wins : second_wins,
      player2_wins: first_is_player1 ? second_wins : first_wins,
      draws: draws,
    },
    player1: first_is_player1 ? first_result : second_result,
    player2: first_is_player1 ? second_result : first_result,
  };
};

CombatSim.combatOutcomeDistribution = function(player1, player2) {
  return this.combatResultDistribution(player1, player2).outcome;
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

Player.groupEquivalentBuilds = function(builds) {
  let groups_by_signature = new Map();

  builds.forEach(function(build) {
    let player = Player.generateBuild(build);
    let signature = CombatSim.combatSignature(player);
    let group = groups_by_signature.get(signature);

    if (!group) {
      group = {
        signature: signature,
        representative: player,
        builds: [],
      };
      groups_by_signature.set(signature, group);
    }

    group.builds.push(build);
  });

  return Array.from(groups_by_signature.values());
};

Player.generateReferencePlayers = function(catalogs) {
  let builds = catalogs ? mergeBuildCatalogs(catalogs) : Build;
  return Object.keys(builds)
    .filter(function(key) {
      return builds[key].reference !== false;
    })
    .map(function(key) {
      return Player.generateBuild(builds[key]);
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

let BuildCatalogs = deepFreeze(require('./data/build-catalogs'));

let mergeBuildCatalogs = function(catalogs) {
  let merged = {};
  catalogs.forEach(function(catalog) {
    Object.keys(catalog).forEach(function(key) {
      if (merged[key]) {
        throw new Error('Duplicate build key: ' + key + '.');
      }
      merged[key] = catalog[key];
    });
  });
  return merged;
};

let Build = deepFreeze(mergeBuildCatalogs(BuildCatalogs));

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
//                                  BuildSearch
// =============================================================================
function BuildSearch() {}

BuildSearch.activeWeaponSkills = function(active_weapon_types) {
  return Array.from(new Set(active_weapon_types.map(function(type) {
    return WEAPON_TYPE_TO_SKILL[type];
  }))).sort();
};

BuildSearch.crystalMultisets = function(crystal_keys, socket_capacity) {
  let multisets = [];

  if (crystal_keys.length === 0) {
    return [ [] ];
  }

  let addMultisets = function(start, remaining, selected) {
    if (remaining === 0) {
      multisets.push(selected.slice());
      return;
    }

    for (let i = start; i < crystal_keys.length; i++) {
      selected.push(crystal_keys[i]);
      addMultisets(i, remaining - 1, selected);
      selected.pop();
    }
  };

  addMultisets(0, socket_capacity, []);
  return multisets;
};

BuildSearch.modCombinations = function(item) {
  let mod_slots = idx(item, 'mod_slots', 0);
  let combinations = [ [] ];

  for (let slot = 1; slot <= mod_slots; slot++) {
    let compatible_mods = Object.keys(WeaponMod).filter(function(key) {
      return WeaponMod[key].slot === slot && WeaponMod[key].compatible.includes(item.catalogKey);
    });
    let next_combinations = [];

    combinations.forEach(function(combination) {
      compatible_mods.forEach(function(key) {
        next_combinations.push(combination.concat([ key ]));
      });
    });
    combinations = next_combinations;
  }

  return combinations;
};

BuildSearch.itemCombatStats = function(item, active_weapon_types) {
  let combat_stats = [
    'min_damage',
    'max_damage',
    'armor',
    'dodge',
    'accuracy',
    'speed',
    'def_skill',
  ].concat(this.activeWeaponSkills(active_weapon_types));

  return combat_stats.map(function(stat) {
    return [ stat, idx(item, stat, 0) ];
  });
};

BuildSearch.usefulCrystalKeys = function(item, crystal_keys, active_weapon_types) {
  let active_skills = new Set(this.activeWeaponSkills(active_weapon_types));

  return crystal_keys.filter(function(key) {
    return Object.keys(Item[key].mult).some(function(stat) {
      let is_weapon_skill = stat === 'melee_skill' || stat === 'gun_skill' ||
        stat === 'proj_skill';
      let is_relevant_skill = !is_weapon_skill || active_skills.has(stat);
      return is_relevant_skill && typeof item[stat] === 'number' && item[stat] !== 0;
    });
  });
};

BuildSearch.itemVariantSignature = function(item, active_weapon_types) {
  return JSON.stringify([
    idx(item, 'type', null),
    this.itemCombatStats(item, active_weapon_types),
  ]);
};

BuildSearch.pruneDominatedItemVariants = function(groups, active_weapon_types) {
  let frontier = [];
  let stats = function(group) {
    return BuildSearch.itemCombatStats(group.representative, active_weapon_types)
      .map(function(stat) { return stat[1]; });
  };
  let dominates = function(left, right) {
    let strictly_better = false;
    for (let i = 0; i < left.length; i++) {
      if (left[i] < right[i]) {
        return false;
      }
      strictly_better = strictly_better || left[i] > right[i];
    }
    return strictly_better;
  };

  groups.forEach(function(group) {
    let candidate_stats = stats(group);
    if (frontier.some(function(entry) { return dominates(entry.stats, candidate_stats); })) {
      return;
    }

    frontier = frontier.filter(function(entry) {
      return !dominates(candidate_stats, entry.stats);
    });
    frontier.push({ group: group, stats: candidate_stats });
  });

  return frontier.map(function(entry) { return entry.group; });
};

BuildSearch.generateItemVariants = function(item_key, options) {
  let item = Item[item_key];
  let settings = options || {};
  let active_weapon_types = settings.activeWeaponTypes || [ 'melee', 'gun', 'projectile' ];
  let crystal_keys = settings.crystalKeys || Object.keys(crystalDefinitions);
  let socket_capacity = idx(settings, 'socketCapacity', 4);
  let useful_crystals = this.usefulCrystalKeys(item, crystal_keys, active_weapon_types);
  let crystal_multisets = this.crystalMultisets(useful_crystals, socket_capacity);
  let mod_combinations = this.modCombinations(item);
  let groups_by_signature = new Map();

  mod_combinations.forEach(function(mod_keys) {
    let modded_item = item.applyMods(mod_keys.map(function(key) { return WeaponMod[key]; }));

    crystal_multisets.forEach(function(selected_crystals) {
      let variant = modded_item.socket(selected_crystals.map(function(key) { return Item[key]; }));
      let signature = BuildSearch.itemVariantSignature(variant, active_weapon_types);
      let group = groups_by_signature.get(signature);

      if (!group) {
        group = { signature: signature, representative: variant, sources: [] };
        groups_by_signature.set(signature, group);
      }

      group.sources.push({
        item: item_key,
        mods: mod_keys.slice(),
        crystals: selected_crystals.slice(),
      });
    });
  });

  return Array.from(groups_by_signature.values());
};

BuildSearch.generateItemVariantsForWeapons = function(item_key, weapon_keys, options) {
  let active_weapon_types = Array.from(new Set(weapon_keys.map(function(key) {
    return Item[key].type;
  })));
  let settings = Object.assign({}, options, { activeWeaponTypes: active_weapon_types });
  return this.generateItemVariants(item_key, settings);
};

BuildSearch.itemVariantReport = function(item_key, options) {
  let item = Item[item_key];
  let settings = options || {};
  let active_weapon_types = settings.activeWeaponTypes || [ 'melee', 'gun', 'projectile' ];
  let crystal_keys = settings.crystalKeys || Object.keys(crystalDefinitions);
  let socket_capacity = idx(settings, 'socketCapacity', 4);
  let useful_crystals = this.usefulCrystalKeys(item, crystal_keys, active_weapon_types);
  let mod_count = this.modCombinations(item).length;
  let groups = this.generateItemVariants(item_key, settings);
  let nondominated_groups = this.pruneDominatedItemVariants(groups, active_weapon_types);
  let orderedCount = function(crystal_count) {
    return (crystal_count === 0 ? 1 : Math.pow(crystal_count, socket_capacity)) * mod_count;
  };

  return {
    groups: groups,
    nondominated_groups: nondominated_groups,
    counts: {
      unfiltered_ordered: orderedCount(crystal_keys.length),
      filtered_ordered: orderedCount(useful_crystals.length),
      canonical: groups.reduce(function(sum, group) { return sum + group.sources.length; }, 0),
      unique_effective: groups.length,
      nondominated: nondominated_groups.length,
    },
    useful_crystals: useful_crystals,
  };
};

BuildSearch.slotVariantFrontier = function(slot, options) {
  let settings = options || {};
  let catalog = equipmentCatalog[slot];
  if (!catalog) {
    throw new Error('Unknown equipment slot: ' + slot + '.');
  }

  let active_weapon_types = settings.activeWeaponTypes || [ 'melee', 'gun', 'projectile' ];
  let item_keys = settings.itemKeys || Object.keys(catalog);
  if (slot === 'weapons') {
    if (!settings.weaponType) {
      throw new Error('Weapon slot frontiers require a weapon type.');
    }
    item_keys = item_keys.filter(function(key) {
      return catalog[key].type === settings.weaponType;
    });
  }

  let item_frontiers = [];
  item_keys.forEach(function(key) {
    let report = BuildSearch.itemVariantReport(key, settings);
    item_frontiers = item_frontiers.concat(report.nondominated_groups);
  });

  let groups_by_signature = new Map();
  item_frontiers.forEach(function(group) {
    let existing = groups_by_signature.get(group.signature);
    if (!existing) {
      existing = {
        signature: group.signature,
        representative: group.representative,
        sources: [],
      };
      groups_by_signature.set(group.signature, existing);
    }
    existing.sources = existing.sources.concat(group.sources);
  });

  let unique_effective_groups = Array.from(groups_by_signature.values());
  let nondominated_groups = this.pruneDominatedItemVariants(
    unique_effective_groups,
    active_weapon_types
  );

  return {
    groups: nondominated_groups,
    counts: {
      base_items: item_keys.length,
      item_frontier_variants: item_frontiers.length,
      unique_effective: unique_effective_groups.length,
      nondominated: nondominated_groups.length,
    },
  };
};

BuildSearch.initiativeSpeedPoints = function(build, opponents, attack_type) {
  let minimum_speed_points = 2;
  let maximum_speed_points = 173;
  let speed_by_points = new Map();
  let selected_points = new Set([ minimum_speed_points ]);

  for (let speed_points = minimum_speed_points;
    speed_points <= maximum_speed_points; speed_points++) {
    let stats = {
      hp: 2,
      speed: speed_points,
      accuracy: 4,
      dodge: 177 - speed_points,
    };
    let candidate = Object.assign({}, build, { stats: stats, attack_type: attack_type });
    speed_by_points.set(speed_points, Player.generateBuild(candidate).speed);
  }

  opponents.forEach(function(opponent) {
    for (let speed_points = minimum_speed_points;
      speed_points <= maximum_speed_points; speed_points++) {
      let speed = speed_by_points.get(speed_points);
      if (speed === opponent.speed) {
        selected_points.add(speed_points);
      }
      if (speed > opponent.speed) {
        selected_points.add(speed_points);
        break;
      }
    }
  });

  return Array.from(selected_points).sort(function(a, b) { return a - b; });
};

BuildSearch.forEachStatAllocation = function(speed_points, options, visit) {
  let settings = options || {};
  let allowed_hp_points = settings.hpPoints ? new Set(settings.hpPoints) : null;
  let count = 0;

  Array.from(new Set(speed_points)).sort(function(a, b) { return a - b; })
    .forEach(function(speed) {
      for (let hp = 2; hp <= 175 - speed; hp++) {
        if (allowed_hp_points && !allowed_hp_points.has(hp)) {
          continue;
        }
        for (let accuracy = 4; accuracy <= 179 - speed - hp; accuracy++) {
          let dodge = 183 - speed - hp - accuracy;
          if (dodge < 4) {
            continue;
          }
          visit({ hp: hp, speed: speed, accuracy: accuracy, dodge: dodge });
          count++;
        }
      }
    });

  return count;
};

BuildSearch.statAllocationReport = function(build, opponents, attack_types, options) {
  return attack_types.map(function(attack_type) {
    let speed_points = BuildSearch.initiativeSpeedPoints(build, opponents, attack_type);
    let signatures = new Set();
    let count = BuildSearch.forEachStatAllocation(speed_points, options, function(stats) {
      let candidate = Object.assign({}, build, { stats: stats, attack_type: attack_type });
      signatures.add(CombatSim.combatSignature(Player.generateBuild(candidate)));
    });

    return {
      attack_type: attack_type,
      speed_points: speed_points,
      allocations: count,
      unique_combat_signatures: signatures.size,
    };
  });
};

// =============================================================================
//                                  MatchupGame
// =============================================================================
function MatchupGame() {}

MatchupGame.symmetrizedScore = function(player, opponent) {
  let forward = CombatSim.combatOutcomeDistribution(player, opponent);
  let reverse = CombatSim.combatOutcomeDistribution(opponent, player);
  let forward_score = forward.player1_wins + (forward.draws / 2);
  let reverse_score = reverse.player2_wins + (reverse.draws / 2);
  return (forward_score + reverse_score) / 2;
};

MatchupGame.payoffMatrix = function(players) {
  let matrix = players.map(function() {
    return new Array(players.length).fill(0);
  });

  for (let i = 0; i < players.length; i++) {
    matrix[i][i] = 0.5;
    for (let j = i + 1; j < players.length; j++) {
      let score = this.symmetrizedScore(players[i], players[j]);
      matrix[i][j] = score;
      matrix[j][i] = 1 - score;
    }
  }

  return matrix;
};

MatchupGame.strategyScores = function(matrix, strategy) {
  return matrix[0].map(function(unused, opponent) {
    return strategy.reduce(function(score, probability, player) {
      return score + (probability * matrix[player][opponent]);
    }, 0);
  });
};

MatchupGame.worstCaseScore = function(matrix, strategy) {
  return Math.min.apply(null, this.strategyScores(matrix, strategy));
};

MatchupGame.bestResponse = function(matrix, opponent_strategy) {
  let scores = matrix.map(function(row) {
    return row.reduce(function(score, payoff, opponent) {
      return score + (payoff * opponent_strategy[opponent]);
    }, 0);
  });
  let best_score = Math.max.apply(null, scores);
  let tolerance = 1e-12;
  return {
    score: best_score,
    players: scores.map(function(score, player) {
      return Math.abs(score - best_score) <= tolerance ? player : null;
    }).filter(function(player) { return player !== null; }),
  };
};

MatchupGame.exploitability = function(matrix, strategy) {
  return this.bestResponse(matrix, strategy).score - 0.5;
};

MatchupGame.pureMaximin = function(matrix) {
  let worst_case_scores = matrix.map(function(row) {
    return Math.min.apply(null, row);
  });
  let best_score = Math.max.apply(null, worst_case_scores);
  let tolerance = 1e-12;
  return {
    score: best_score,
    players: worst_case_scores.map(function(score, player) {
      return Math.abs(score - best_score) <= tolerance ? player : null;
    }).filter(function(player) { return player !== null; }),
  };
};

MatchupGame.dominanceFrontier = function(matrix) {
  let tolerance = 1e-12;
  let dominated_by = matrix.map(function() { return []; });

  let dominates = function(left, right) {
    let strictly_better = false;
    for (let opponent = 0; opponent < left.length; opponent++) {
      if (left[opponent] < right[opponent] - tolerance) {
        return false;
      }
      strictly_better = strictly_better || left[opponent] > right[opponent] + tolerance;
    }
    return strictly_better;
  };

  for (let candidate = 0; candidate < matrix.length; candidate++) {
    for (let other = 0; other < matrix.length; other++) {
      if (candidate !== other && dominates(matrix[other], matrix[candidate])) {
        dominated_by[candidate].push(other);
      }
    }
  }

  return {
    players: dominated_by.map(function(dominators, player) {
      return dominators.length === 0 ? player : null;
    }).filter(function(player) { return player !== null; }),
    dominated_by: dominated_by,
  };
};

MatchupGame.iteratedDominanceKernel = function(matrix) {
  let active = matrix.map(function(unused, player) { return player; });
  let rounds = [];

  while (active.length > 1) {
    let restricted_matrix = active.map(function(player) {
      return active.map(function(opponent) { return matrix[player][opponent]; });
    });
    let frontier = this.dominanceFrontier(restricted_matrix);
    let survivors = frontier.players.map(function(player) { return active[player]; });
    let eliminated = active.map(function(player, restricted_player) {
      let dominators = frontier.dominated_by[restricted_player];
      return dominators.length === 0 ? null : {
        player: player,
        dominated_by: dominators.map(function(other) { return active[other]; }),
      };
    }).filter(function(elimination) { return elimination !== null; });

    if (eliminated.length === 0) {
      break;
    }

    rounds.push({
      active_players: active,
      eliminated: eliminated,
    });
    active = survivors;
  }

  return { players: active, rounds: rounds };
};

MatchupGame.analyzeBuildCatalog = function(catalog) {
  let groups_by_signature = new Map();

  Object.keys(catalog).sort().forEach(function(key) {
    let build = catalog[key];
    let player = Player.generateBuild(build);
    let signature = CombatSim.combatSignature(player);
    let group = groups_by_signature.get(signature);
    if (!group) {
      group = { build_keys: [], names: [], player: player };
      groups_by_signature.set(signature, group);
    }
    group.build_keys.push(key);
    if (!group.names.includes(build.name)) {
      group.names.push(build.name);
    }
  });

  let groups = Array.from(groups_by_signature.values());
  let players = groups.map(function(group) { return group.player; });
  let score_matrix = players.map(function() { return new Array(players.length).fill(0); });
  let win_probability_matrix = players.map(function() {
    return new Array(players.length).fill(0);
  });
  let draw_matrix = players.map(function() { return new Array(players.length).fill(0); });
  let hp_loss_matrix = players.map(function() { return new Array(players.length).fill(0); });
  let win_hp_loss_matrix = players.map(function() { return new Array(players.length).fill(null); });
  let zero_damage_win_matrix = players.map(function() { return new Array(players.length).fill(null); });
  let healing_cost_matrix = players.map(function() { return new Array(players.length).fill(0); });
  let win_healing_cost_matrix = players.map(function() {
    return new Array(players.length).fill(null);
  });
  let average = function(left, right) { return (left + right) / 2; };
  let combinedWinMetric = function(left, right, metric) {
    let wins = left.wins + right.wins;
    if (wins === 0) {
      return null;
    }
    return (
      (left.wins * (left[metric] || 0)) +
      (right.wins * (right[metric] || 0))
    ) / wins;
  };

  for (let i = 0; i < players.length; i++) {
    let self_result = CombatSim.combatResultDistribution(players[i], players[i]);
    score_matrix[i][i] = 0.5;
    win_probability_matrix[i][i] = average(
      self_result.outcome.player1_wins,
      self_result.outcome.player2_wins
    );
    draw_matrix[i][i] = self_result.outcome.draws;
    hp_loss_matrix[i][i] = average(
      self_result.player1.expected_hp_lost,
      self_result.player2.expected_hp_lost
    );
    win_hp_loss_matrix[i][i] = combinedWinMetric(
      self_result.player1, self_result.player2, 'expected_hp_lost_on_win'
    );
    zero_damage_win_matrix[i][i] = combinedWinMetric(
      self_result.player1, self_result.player2, 'zero_damage_win_probability'
    );
    healing_cost_matrix[i][i] = average(
      self_result.player1.expected_healing_cost,
      self_result.player2.expected_healing_cost
    );
    win_healing_cost_matrix[i][i] = combinedWinMetric(
      self_result.player1, self_result.player2, 'expected_healing_cost_on_win'
    );

    for (let j = i + 1; j < players.length; j++) {
      let forward_result = CombatSim.combatResultDistribution(players[i], players[j]);
      let reverse_result = CombatSim.combatResultDistribution(players[j], players[i]);
      let forward = forward_result.outcome;
      let reverse = reverse_result.outcome;
      let score = (
        forward.player1_wins + (forward.draws / 2) +
        reverse.player2_wins + (reverse.draws / 2)
      ) / 2;
      let draws = (forward.draws + reverse.draws) / 2;
      score_matrix[i][j] = score;
      score_matrix[j][i] = 1 - score;
      win_probability_matrix[i][j] = average(
        forward.player1_wins, reverse.player2_wins
      );
      win_probability_matrix[j][i] = average(
        forward.player2_wins, reverse.player1_wins
      );
      draw_matrix[i][j] = draws;
      draw_matrix[j][i] = draws;
      hp_loss_matrix[i][j] = average(
        forward_result.player1.expected_hp_lost,
        reverse_result.player2.expected_hp_lost
      );
      hp_loss_matrix[j][i] = average(
        forward_result.player2.expected_hp_lost,
        reverse_result.player1.expected_hp_lost
      );
      win_hp_loss_matrix[i][j] = combinedWinMetric(
        forward_result.player1, reverse_result.player2, 'expected_hp_lost_on_win'
      );
      win_hp_loss_matrix[j][i] = combinedWinMetric(
        forward_result.player2, reverse_result.player1, 'expected_hp_lost_on_win'
      );
      zero_damage_win_matrix[i][j] = combinedWinMetric(
        forward_result.player1, reverse_result.player2, 'zero_damage_win_probability'
      );
      zero_damage_win_matrix[j][i] = combinedWinMetric(
        forward_result.player2, reverse_result.player1, 'zero_damage_win_probability'
      );
      healing_cost_matrix[i][j] = average(
        forward_result.player1.expected_healing_cost,
        reverse_result.player2.expected_healing_cost
      );
      healing_cost_matrix[j][i] = average(
        forward_result.player2.expected_healing_cost,
        reverse_result.player1.expected_healing_cost
      );
      win_healing_cost_matrix[i][j] = combinedWinMetric(
        forward_result.player1, reverse_result.player2, 'expected_healing_cost_on_win'
      );
      win_healing_cost_matrix[j][i] = combinedWinMetric(
        forward_result.player2, reverse_result.player1, 'expected_healing_cost_on_win'
      );
    }
  }

  let frontier = this.dominanceFrontier(score_matrix);
  let kernel = this.iteratedDominanceKernel(score_matrix);
  let maximin = this.pureMaximin(score_matrix);
  let ids = groups.map(function(group) { return group.build_keys[0]; });
  let candidates = groups.map(function(group, player) {
    let worst_score = Math.min.apply(null, score_matrix[player]);
    let average_score = score_matrix[player].reduce(function(sum, score) {
      return sum + score;
    }, 0) / score_matrix[player].length;
    let average_win_probability = win_probability_matrix[player].reduce(function(sum, wins) {
      return sum + wins;
    }, 0) / win_probability_matrix[player].length;
    let average_draw_rate = draw_matrix[player].reduce(function(sum, draw_rate) {
      return sum + draw_rate;
    }, 0) / draw_matrix[player].length;
    let average_hp_lost = hp_loss_matrix[player].reduce(function(sum, hp_loss) {
      return sum + hp_loss;
    }, 0) / hp_loss_matrix[player].length;
    let conditionalWinMean = function(values) {
      let weighted_sum = 0;
      let wins = 0;
      values.forEach(function(value, opponent) {
        if (value !== null) {
          let win_probability = win_probability_matrix[player][opponent];
          weighted_sum += value * win_probability;
          wins += win_probability;
        }
      });
      return wins > 0 ? weighted_sum / wins : null;
    };
    let average_hp_lost_on_win = conditionalWinMean(win_hp_loss_matrix[player]);
    let average_zero_damage_win_probability = conditionalWinMean(
      zero_damage_win_matrix[player]
    );
    let average_healing_cost = healing_cost_matrix[player].reduce(function(sum, cost) {
      return sum + cost;
    }, 0) / healing_cost_matrix[player].length;
    let average_healing_cost_on_win = conditionalWinMean(win_healing_cost_matrix[player]);
    let best_response_score = Math.max.apply(null, score_matrix.map(function(row) {
      return row[player];
    }));
    let limiting_opponents = score_matrix[player].map(function(score, opponent) {
      return Math.abs(score - worst_score) <= 1e-12 ? ids[opponent] : null;
    }).filter(function(opponent) { return opponent !== null; });

    return {
      id: ids[player],
      build_keys: group.build_keys,
      names: group.names,
      frontier: frontier.dominated_by[player].length === 0,
      dominated_by: frontier.dominated_by[player].map(function(other) { return ids[other]; }),
      worst_score: worst_score,
      average_score: average_score,
      average_win_probability: average_win_probability,
      average_draw_rate: average_draw_rate,
      average_hp_lost: average_hp_lost,
      average_hp_lost_on_win: average_hp_lost_on_win,
      average_zero_damage_win_probability: average_zero_damage_win_probability,
      average_healing_cost: average_healing_cost,
      average_healing_cost_on_win: average_healing_cost_on_win,
      healing_credits_per_win: average_win_probability > 0 ?
        average_healing_cost / average_win_probability : null,
      exploitability: best_response_score - 0.5,
      limiting_opponents: limiting_opponents,
    };
  });

  return {
    source_build_count: Object.keys(catalog).length,
    candidate_count: candidates.length,
    candidates: candidates,
    frontier: frontier.players.map(function(player) { return ids[player]; }),
    strategic_kernel: kernel.players.map(function(player) { return ids[player]; }),
    elimination_rounds: kernel.rounds.map(function(round) {
      return {
        active_candidates: round.active_players.map(function(player) { return ids[player]; }),
        eliminated: round.eliminated.map(function(elimination) {
          return {
            candidate: ids[elimination.player],
            dominated_by: elimination.dominated_by.map(function(player) { return ids[player]; }),
          };
        }),
      };
    }),
    matrix_order: ids,
    pure_maximin: {
      score: maximin.score,
      candidates: maximin.players.map(function(player) { return ids[player]; }),
    },
    score_matrix: score_matrix,
    win_probability_matrix: win_probability_matrix,
    draw_matrix: draw_matrix,
    hp_loss_matrix: hp_loss_matrix,
    win_hp_loss_matrix: win_hp_loss_matrix,
    zero_damage_win_matrix: zero_damage_win_matrix,
    healing_cost_matrix: healing_cost_matrix,
    win_healing_cost_matrix: win_healing_cost_matrix,
  };
};

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
    BuildCatalogs: BuildCatalogs,
    mergeBuildCatalogs: mergeBuildCatalogs,
    BuildSearch: BuildSearch,
    MatchupGame: MatchupGame,
  };
}
