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

CombatSim.defeatRoundSignature = function(att, def) {
  let weapons = [ att.weapon1, att.weapon2 ].map(function(weapon) {
    return [ weapon.skill, att[weapon.skill], weapon.min_damage, weapon.max_damage ];
  }).sort(function(left, right) {
    return JSON.stringify(left).localeCompare(JSON.stringify(right));
  });
  return JSON.stringify([
    att.level,
    att.accuracy,
    weapons,
    def.max_hp,
    def.armor,
    def.dodge,
    def.def_skill,
  ]);
};

CombatSim.createDefeatRoundCache = function(minimum_survival_probability) {
  return {
    values: new Map(),
    hits: 0,
    misses: 0,
    minimum_survival_probability: minimum_survival_probability || 0,
  };
};

CombatSim.defeatRoundDistribution = function(att, def, cache) {
  let cache_key;
  if (cache) {
    cache_key = this.defeatRoundSignature(att, def);
    if (cache.values.has(cache_key)) {
      cache.hits++;
      return cache.values.get(cache_key);
    }
    cache.misses++;
  }
  let attack = Array.from(this.attackDamageDistribution(att, def));
  let healing_cost = new Uint32Array(def.max_hp + 1);
  let remaining_hp = new Float64Array(def.max_hp + 1);
  let defeat_rounds = new Array(this.MAX_COMBAT_ROUNDS + 1).fill(0);
  let surviving_hp_by_round = new Array(this.MAX_COMBAT_ROUNDS + 1).fill(0);
  let surviving_healing_cost_by_round = new Array(this.MAX_COMBAT_ROUNDS + 1).fill(0);
  let full_hp_probability_by_round = new Array(this.MAX_COMBAT_ROUNDS + 1).fill(0);
  attack.sort(function(a, b) { return a[0] - b[0]; });
  let attack_damage = new Uint32Array(attack.length);
  let attack_probability = new Float64Array(attack.length);
  for (let outcome = 0; outcome < attack.length; outcome++) {
    attack_damage[outcome] = attack[outcome][0];
    attack_probability[outcome] = attack[outcome][1];
  }

  for (let hit_points = 1; hit_points <= def.max_hp; hit_points++) {
    healing_cost[hit_points] = this.healingCost(hit_points, def.max_hp);
  }

  remaining_hp[def.max_hp] = 1;
  surviving_hp_by_round[0] = def.max_hp;
  full_hp_probability_by_round[0] = 1;
  let survives = 1;
  let truncated = false;

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

      for (let outcome = 0; outcome < attack.length; outcome++) {
        let damage = attack_damage[outcome];
        if (damage >= hit_points) {
          break;
        }

        let probability = state_probability * attack_probability[outcome];
        let next_hit_points = hit_points - damage;
        next_remaining_hp[next_hit_points] += probability;
      }
    }

    let next_survives = 0;
    for (let hit_points = 1; hit_points <= def.max_hp; hit_points++) {
      let state_probability = next_remaining_hp[hit_points];
      next_survives += state_probability;
      next_surviving_hp += hit_points * state_probability;
      next_surviving_healing_cost += healing_cost[hit_points] * state_probability;
    }
    if (next_survives > survives) {
      let survival_scale = survives / next_survives;
      for (let hit_points = 1; hit_points <= def.max_hp; hit_points++) {
        next_remaining_hp[hit_points] *= survival_scale;
      }
      next_surviving_hp *= survival_scale;
      next_surviving_healing_cost *= survival_scale;
      next_survives = survives;
    }
    defeat_rounds[round] = survives - next_survives;
    survives = next_survives;
    next_full_hp_probability = next_remaining_hp[def.max_hp];
    has_survivors = next_survives > 0;

    remaining_hp = next_remaining_hp;
    surviving_hp_by_round[round] = next_surviving_hp;
    surviving_healing_cost_by_round[round] = next_surviving_healing_cost;
    full_hp_probability_by_round[round] = next_full_hp_probability;
    if (!has_survivors) {
      break;
    }
    if (cache && survives <= cache.minimum_survival_probability) {
      surviving_hp_by_round[this.MAX_COMBAT_ROUNDS] = next_surviving_hp;
      surviving_healing_cost_by_round[this.MAX_COMBAT_ROUNDS] = next_surviving_healing_cost;
      full_hp_probability_by_round[this.MAX_COMBAT_ROUNDS] = next_full_hp_probability;
      truncated = true;
      break;
    }
  }

  let result = {
    defeat_rounds: defeat_rounds,
    survives: survives,
    truncated: truncated,
    surviving_hp_by_round: surviving_hp_by_round,
    surviving_healing_cost_by_round: surviving_healing_cost_by_round,
    full_hp_probability_by_round: full_hp_probability_by_round,
  };
  if (cache) {
    cache.values.set(cache_key, result);
  }
  return result;
};

CombatSim.combatResultDistribution = function(player1, player2, cache) {
  let first = player1;
  let second = player2;
  let first_is_player1 = true;

  if (player2.speed > player1.speed) {
    first = player2;
    second = player1;
    first_is_player1 = false;
  }

  let first_defeats_second = this.defeatRoundDistribution(first, second, cache);
  let second_defeats_first = this.defeatRoundDistribution(second, first, cache);
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
  let first_tail = first_defeats_second.truncated ? first_defeats_second.survives : 0;
  let second_tail = second_defeats_first.truncated ? second_defeats_first.survives : 0;
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
    outcome_error_bound: first_tail + second_tail - (first_tail * second_tail),
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

BuildSearch.itemVariantReportCache = new Map();

BuildSearch.cachedItemVariantReport = function(item_key, options) {
  let settings = options || {};
  let key = JSON.stringify([
    item_key,
    settings.activeWeaponTypes || [ 'melee', 'gun', 'projectile' ],
    settings.crystalKeys || Object.keys(crystalDefinitions),
    idx(settings, 'socketCapacity', 4),
  ]);
  if (!this.itemVariantReportCache.has(key)) {
    this.itemVariantReportCache.set(key, this.itemVariantReport(item_key, settings));
  }
  return this.itemVariantReportCache.get(key);
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

BuildSearch.normalizeEquipment = function(build, options) {
  let settings = options || {};
  let slots = settings.slots || [ 'armor', 'weapon1', 'weapon2', 'misc1', 'misc2' ];
  let dominates = function(left, right) {
    let strictly_better = false;
    let stats = new Set(Object.keys(left.mult).concat(Object.keys(right.mult)));
    for (let stat of stats) {
      let left_multiplier = idx(left.mult, stat, 1);
      let right_multiplier = idx(right.mult, stat, 1);
      if (left_multiplier < right_multiplier) {
        return false;
      }
      strictly_better = strictly_better || left_multiplier > right_multiplier;
    }
    return strictly_better;
  };
  let crystal_keys = Object.keys(crystalDefinitions);
  let replacements = new Map();
  crystal_keys.forEach(function(key) {
    let dominators = crystal_keys.filter(function(other) {
      return dominates(Item[other], Item[key]);
    });
    dominators = dominators.filter(function(candidate) {
      return !dominators.some(function(other) {
        return other !== candidate && dominates(Item[other], Item[candidate]);
      });
    });
    replacements.set(key, dominators.length > 0 ? dominators : [ key ]);
  });
  let variants = [ { build: build, replacements: [] } ];

  slots.forEach(function(slot) {
    let next_variants = [];
    variants.forEach(function(entry) {
      let descriptor = entry.build.equipment[slot];
      if (!descriptor.crystals) {
        next_variants.push(entry);
        return;
      }
      let crystal_sets = [ [] ];
      descriptor.crystals.forEach(function(key) {
        crystal_sets = crystal_sets.flatMap(function(selected) {
          return replacements.get(key).map(function(replacement) {
            return selected.concat([ replacement ]);
          });
        });
      });
      let descriptors = new Map();
      crystal_sets.forEach(function(crystals) {
        let replacement = Object.assign({}, descriptor, { crystals: crystals.sort() });
        descriptors.set(JSON.stringify(replacement), replacement);
      });
      descriptors.forEach(function(replacement) {
        let equipment = Object.assign({}, entry.build.equipment);
        equipment[slot] = replacement;
        let changed = JSON.stringify(replacement) !== JSON.stringify(descriptor);
        next_variants.push({
          build: Object.assign({}, entry.build, { equipment: equipment }),
          replacements: changed ? entry.replacements.concat([ {
            slot: slot,
            from: descriptor,
            to: replacement,
          } ]) : entry.replacements,
        });
      });
    });
    variants = next_variants;
  });

  let variants_by_signature = new Map();
  variants.forEach(function(entry) {
    let signature = CombatSim.combatSignature(Player.generateBuild(entry.build));
    if (!variants_by_signature.has(signature)) {
      variants_by_signature.set(signature, entry);
    }
  });
  return Array.from(variants_by_signature.values());
};

BuildSearch.equipmentConceptSignature = function(build) {
  let descriptor = function(equipment) {
    return [
      equipment.item,
      (equipment.mods || []).slice().sort(),
      Array.from(new Set(equipment.crystals || [])).sort(),
    ];
  };
  let weapons = [
    descriptor(build.equipment.weapon1),
    descriptor(build.equipment.weapon2),
  ].sort(function(left, right) {
    return JSON.stringify(left).localeCompare(JSON.stringify(right));
  });
  let miscs = [
    descriptor(build.equipment.misc1),
    descriptor(build.equipment.misc2),
  ].sort(function(left, right) {
    return JSON.stringify(left).localeCompare(JSON.stringify(right));
  });
  return JSON.stringify([
    descriptor(build.equipment.armor),
    weapons,
    miscs,
  ]);
};

BuildSearch.equipmentNeighborhood = function(build, options) {
  let settings = options || {};
  let slots = settings.slots || [ 'armor', 'weapon1', 'weapon2', 'misc1', 'misc2' ];
  let catalog_by_slot = {
    armor: 'armor',
    weapon1: 'weapons',
    weapon2: 'weapons',
    misc1: 'miscs',
    misc2: 'miscs',
  };
  let groups_by_signature = new Map();
  let variant_count = 0;
  slots.forEach(function(slot) {
    if (!catalog_by_slot[slot]) {
      throw new Error('Unknown equipment slot: ' + slot + '.');
    }
  });
  let normalized_builds = settings.normalize === false ?
    [ { build: build, replacements: [] } ] : this.normalizeEquipment(build, settings);

  normalized_builds.forEach(function(normalized) {
    let base_build = normalized.build;
    let weapon_keys = [
      base_build.equipment.weapon1.item,
      base_build.equipment.weapon2.item,
    ];
    slots.forEach(function(slot) {
      let catalog_name = catalog_by_slot[slot];
      if (!catalog_name) {
        throw new Error('Unknown equipment slot: ' + slot + '.');
      }
      let catalog = equipmentCatalog[catalog_name];
      let item_keys = settings.itemKeysBySlot && settings.itemKeysBySlot[slot] ||
      Object.keys(catalog);
      let slot_groups = [];

      item_keys.forEach(function(item_key) {
        if (!catalog[item_key]) {
          throw new Error('Unknown ' + catalog_name + ' item: ' + item_key + '.');
        }
        let active_weapon_keys = weapon_keys.slice();
        if (slot === 'weapon1') {
          active_weapon_keys[0] = item_key;
        } else if (slot === 'weapon2') {
          active_weapon_keys[1] = item_key;
        }
        let report = BuildSearch.cachedItemVariantReport(item_key, {
          activeWeaponTypes: active_weapon_keys.map(function(key) { return Item[key].type; }),
          crystalKeys: settings.crystalKeys,
          socketCapacity: settings.socketCapacity,
        });
        slot_groups = slot_groups.concat(report.nondominated_groups);
      });

      variant_count += slot_groups.length;
      slot_groups.forEach(function(group) {
        group.sources.forEach(function(source) {
          let equipment = Object.assign({}, base_build.equipment);
          equipment[slot] = {
            item: source.item,
            crystals: source.crystals.slice(),
          };
          if (source.mods.length > 0) {
            equipment[slot].mods = source.mods.slice();
          }
          let candidate = Object.assign({}, base_build, { equipment: equipment });
          let player = Player.generateBuild(candidate);
          let signature = CombatSim.combatSignature(player);
          let existing = groups_by_signature.get(signature);
          if (!existing) {
            existing = { signature: signature, representative: player, sources: [] };
            groups_by_signature.set(signature, existing);
          }
          existing.sources.push({
            slot: slot,
            equipment: equipment[slot],
            build: candidate,
            normalization: normalized.replacements,
          });
        });
      });
    });
  });

  return {
    groups: Array.from(groups_by_signature.values()),
    counts: {
      slot_variants: variant_count,
      unique_combat_signatures: groups_by_signature.size,
      normalized_builds: normalized_builds.length,
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
  let point_stride = settings.pointStride === undefined ? 1 : settings.pointStride;
  let count = 0;
  if (!Number.isInteger(point_stride) || point_stride <= 0) {
    throw new Error('Stat allocation point stride must be a positive integer.');
  }
  let values = function(minimum, maximum) {
    let result = [];
    for (let value = minimum; value <= maximum; value += point_stride) {
      result.push(value);
    }
    if (result[result.length - 1] !== maximum) {
      result.push(maximum);
    }
    return result;
  };

  Array.from(new Set(speed_points)).sort(function(a, b) { return a - b; })
    .forEach(function(speed) {
      values(2, 175 - speed).forEach(function(hp) {
        if (allowed_hp_points && !allowed_hp_points.has(hp)) {
          return;
        }
        values(4, 179 - speed - hp).forEach(function(accuracy) {
          let dodge = 183 - speed - hp - accuracy;
          if (dodge < 4) {
            return;
          }
          visit({ hp: hp, speed: speed, accuracy: accuracy, dodge: dodge });
          count++;
        });
      });
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

BuildSearch.statAllocationGroups = function(build, opponents, attack_types, options) {
  let groups_by_signature = new Map();

  attack_types.forEach(function(attack_type) {
    let speed_points = BuildSearch.initiativeSpeedPoints(build, opponents, attack_type);
    BuildSearch.forEachStatAllocation(speed_points, options, function(stats) {
      let candidate = Object.assign({}, build, { stats: stats, attack_type: attack_type });
      let player = Player.generateBuild(candidate);
      let signature = CombatSim.combatSignature(player);
      let group = groups_by_signature.get(signature);
      if (!group) {
        group = { signature: signature, representative: player, sources: [] };
        groups_by_signature.set(signature, group);
      }
      group.sources.push({
        attack_type: attack_type,
        stats: Object.assign({}, stats),
      });
    });
  });

  return Array.from(groups_by_signature.values());
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

MatchupGame.mixedEquilibrium = function(matrix, options) {
  options = options || {};
  let tolerance = options.tolerance === undefined ? 1e-3 : options.tolerance;
  let max_iterations = options.maxIterations || 100000;
  let pure = this.pureMaximin(matrix);

  if (pure.score >= 0.5 - 1e-12) {
    let pure_strategy = matrix.map(function(unused, player) {
      return pure.players.includes(player) ? 1 / pure.players.length : 0;
    });
    return {
      strategy: pure_strategy,
      exploitability: this.exploitability(matrix, pure_strategy),
      tolerance: tolerance,
      iterations: 0,
      converged: true,
    };
  }

  let row_counts = new Array(matrix.length).fill(1);
  let column_counts = new Array(matrix.length).fill(1);
  let normalize = function(counts) {
    let total = counts.reduce(function(sum, count) { return sum + count; }, 0);
    return counts.map(function(count) { return count / total; });
  };
  let strategy;
  let exploitability;

  for (let iteration = 1; iteration <= max_iterations; iteration++) {
    let row_strategy = normalize(row_counts);
    let column_strategy = normalize(column_counts);
    let row_response = this.bestResponse(matrix, column_strategy);
    let column_scores = this.strategyScores(matrix, row_strategy);
    let minimum_column_score = Math.min.apply(null, column_scores);
    let column_responses = column_scores.map(function(score, player) {
      return Math.abs(score - minimum_column_score) <= 1e-12 ? player : null;
    }).filter(function(player) { return player !== null; });

    row_response.players.forEach(function(player) {
      row_counts[player] += 1 / row_response.players.length;
    });
    column_responses.forEach(function(player) {
      column_counts[player] += 1 / column_responses.length;
    });

    row_strategy = normalize(row_counts);
    column_strategy = normalize(column_counts);
    strategy = row_strategy.map(function(probability, player) {
      return (probability + column_strategy[player]) / 2;
    });
    exploitability = this.exploitability(matrix, strategy);
    if (exploitability <= tolerance) {
      return {
        strategy: strategy,
        exploitability: exploitability,
        tolerance: tolerance,
        iterations: iteration,
        converged: true,
      };
    }
  }

  return {
    strategy: strategy,
    exploitability: exploitability,
    tolerance: tolerance,
    iterations: max_iterations,
    converged: false,
  };
};

MatchupGame.candidateMatchup = function(player, opponent, cache) {
  let forward = CombatSim.combatResultDistribution(player, opponent, cache);
  let results = [ forward.player1 ];
  let outcomes = [ forward.outcome ];
  let error_bounds = [ forward.outcome_error_bound ];

  if (player.speed === opponent.speed) {
    let reverse = CombatSim.combatResultDistribution(opponent, player, cache);
    results.push(reverse.player2);
    outcomes.push({
      player1_wins: reverse.outcome.player2_wins,
      player2_wins: reverse.outcome.player1_wins,
      draws: reverse.outcome.draws,
    });
    error_bounds.push(reverse.outcome_error_bound);
  }

  let total_wins = results.reduce(function(sum, result) { return sum + result.wins; }, 0);
  return {
    score: outcomes.reduce(function(sum, outcome) {
      return sum + outcome.player1_wins + (outcome.draws / 2);
    }, 0) / outcomes.length,
    score_error_bound: error_bounds.reduce(function(sum, error) {
      return sum + error;
    }, 0) / error_bounds.length,
    win_probability: total_wins / results.length,
    expected_healing_cost: results.reduce(function(sum, result) {
      return sum + result.expected_healing_cost;
    }, 0) / results.length,
  };
};

MatchupGame.candidateFrontiers = function(groups, opponents, opponent_ids, options) {
  options = options || {};
  let opponent_weights = options.opponentWeights || opponents.map(function() {
    return 1 / opponents.length;
  });
  if (opponent_weights.length !== opponents.length ||
      Math.abs(opponent_weights.reduce(function(sum, weight) {
        return sum + weight;
      }, 0) - 1) > 1e-12) {
    throw new Error('Opponent weights must match the opponents and sum to one.');
  }
  let previous_result = options.previousResult;
  let track_frontiers = options.trackFrontiers !== false;
  let combat_frontier = previous_result ? previous_result.combat_frontier : [];
  let economy_frontier = previous_result ? previous_result.combat_economy_frontier : [];
  let candidate_count = previous_result ? previous_result.candidate_count : 0;
  let evaluated_matchups = previous_result ? previous_result.evaluated_matchups : 0;
  let defeat_cache = options.defeatCache ||
    CombatSim.createDefeatRoundCache(options.minimumSurvivalProbability);
  let matchup_cache = options.matchupCache || { values: new Map(), hits: 0, misses: 0 };
  let dominates = function(left, right, include_economy) {
    let strictly_better = false;
    for (let opponent = 0; opponent < left.matchup_scores.length; opponent++) {
      if (left.matchup_scores[opponent] < right.matchup_scores[opponent] - 1e-12) {
        return false;
      }
      strictly_better = strictly_better ||
        left.matchup_scores[opponent] > right.matchup_scores[opponent] + 1e-12;
    }
    if (include_economy) {
      if (left.healing_credits_per_win > right.healing_credits_per_win + 1e-12) {
        return false;
      }
      strictly_better = strictly_better ||
        left.healing_credits_per_win < right.healing_credits_per_win - 1e-12;
    }
    return strictly_better;
  };
  let addToFrontier = function(frontier, candidate, include_economy) {
    if (frontier.some(function(entry) { return dominates(entry, candidate, include_economy); })) {
      return frontier;
    }
    return frontier.filter(function(entry) {
      return !dominates(candidate, entry, include_economy);
    }).concat([ candidate ]);
  };

  let best_worst_case = previous_result ? previous_result.best_worst_case : null;
  let best_average = previous_result ? previous_result.best_average : null;
  let cheapest_per_win = previous_result ? previous_result.cheapest_per_win : null;
  let cheapest_average_winner = previous_result ? previous_result.cheapest_average_winner : null;
  let best_weighted = previous_result ? previous_result.best_weighted : null;
  let candidates = [];
  let opponent_signatures = opponents.map(function(opponent) {
    return CombatSim.combatSignature(opponent);
  });
  groups.forEach(function(group) {
    let group_signature = group.signature || CombatSim.combatSignature(group.representative);
    let matchups = opponents.map(function(opponent, opponent_index) {
      let matchup_key = JSON.stringify([
        group_signature,
        opponent_signatures[opponent_index],
        defeat_cache.minimum_survival_probability,
      ]);
      if (matchup_cache.values.has(matchup_key)) {
        matchup_cache.hits++;
        return matchup_cache.values.get(matchup_key);
      }
      matchup_cache.misses++;
      evaluated_matchups++;
      let matchup = MatchupGame.candidateMatchup(group.representative, opponent, defeat_cache);
      matchup_cache.values.set(matchup_key, matchup);
      return matchup;
    });
    let matchup_scores = matchups.map(function(matchup) { return matchup.score; });
    let matchup_error_bounds = matchups.map(function(matchup) {
      return matchup.score_error_bound;
    });
    let total_wins = matchups.reduce(function(sum, matchup) {
      return sum + matchup.win_probability;
    }, 0);
    let total_healing_cost = matchups.reduce(function(sum, matchup) {
      return sum + matchup.expected_healing_cost;
    }, 0);
    let candidate = {
      signature: group_signature,
      representative: group.representative,
      sources: group.sources,
      matchup_scores: matchup_scores,
      worst_score: Math.min.apply(null, matchup_scores),
      average_score: matchup_scores.reduce(function(sum, score) {
        return sum + score;
      }, 0) / matchup_scores.length,
      weighted_score: matchup_scores.reduce(function(sum, score, opponent) {
        return sum + (score * opponent_weights[opponent]);
      }, 0),
      weighted_score_error_bound: matchup_error_bounds.reduce(function(sum, error, opponent) {
        return sum + (error * opponent_weights[opponent]);
      }, 0),
      average_win_probability: total_wins / matchups.length,
      average_healing_cost: total_healing_cost / matchups.length,
      healing_credits_per_win: total_wins > 0 ? total_healing_cost / total_wins : Infinity,
    };
    if (track_frontiers) {
      combat_frontier = addToFrontier(combat_frontier, candidate, false);
      economy_frontier = addToFrontier(economy_frontier, candidate, true);
    }
    if (!best_worst_case || candidate.worst_score > best_worst_case.worst_score) {
      best_worst_case = candidate;
    }
    if (!best_average || candidate.average_score > best_average.average_score) {
      best_average = candidate;
    }
    if (!best_weighted || candidate.weighted_score > best_weighted.weighted_score) {
      best_weighted = candidate;
    }
    if (!cheapest_per_win ||
        candidate.healing_credits_per_win < cheapest_per_win.healing_credits_per_win) {
      cheapest_per_win = candidate;
    }
    if (candidate.average_score >= 0.5 && (!cheapest_average_winner ||
        candidate.healing_credits_per_win < cheapest_average_winner.healing_credits_per_win)) {
      cheapest_average_winner = candidate;
    }
    candidates.push(candidate);
    candidate_count++;
  });

  return {
    opponent_ids: opponent_ids,
    opponent_weights: opponent_weights,
    candidate_count: candidate_count,
    evaluated_matchups: evaluated_matchups,
    defeat_cache: {
      entries: defeat_cache.values.size,
      hits: defeat_cache.hits,
      misses: defeat_cache.misses,
      minimum_survival_probability: defeat_cache.minimum_survival_probability,
    },
    matchup_cache: {
      entries: matchup_cache.values.size,
      hits: matchup_cache.hits,
      misses: matchup_cache.misses,
    },
    combat_frontier: combat_frontier,
    combat_economy_frontier: economy_frontier,
    best_worst_case: best_worst_case,
    best_average: best_average,
    best_weighted: best_weighted,
    candidates: options.includeCandidates ? candidates : undefined,
    cheapest_per_win: cheapest_per_win,
    cheapest_average_winner: cheapest_average_winner,
  };
};

MatchupGame.equipmentBestResponse = function(
  build, opponents, opponent_ids, opponent_weights, options
) {
  options = options || {};
  let minimum_survival_probability = options.minimumSurvivalProbability === undefined ?
    0.01 : options.minimumSurvivalProbability;
  let neighborhood = BuildSearch.equipmentNeighborhood(build, options);
  let approximate = this.candidateFrontiers(
    neighborhood.groups, opponents, opponent_ids, {
      defeatCache: options.defeatCache,
      matchupCache: options.matchupCache,
      minimumSurvivalProbability: minimum_survival_probability,
      opponentWeights: opponent_weights,
      includeCandidates: true,
      trackFrontiers: false,
    }
  );
  let incumbent_lower_bound = Math.max.apply(null, approximate.candidates.map(function(candidate) {
    return candidate.weighted_score - candidate.weighted_score_error_bound;
  }));
  let survivor_signatures = new Set(approximate.candidates.filter(function(candidate) {
    return candidate.weighted_score + candidate.weighted_score_error_bound >=
      incumbent_lower_bound - 1e-12;
  }).map(function(candidate) {
    return candidate.signature;
  }));
  let finalists = neighborhood.groups.filter(function(group) {
    return survivor_signatures.has(group.signature);
  });
  let exact = this.candidateFrontiers(finalists, opponents, opponent_ids, {
    defeatCache: options.exactDefeatCache,
    matchupCache: options.exactMatchupCache,
    opponentWeights: opponent_weights,
    trackFrontiers: false,
  });

  return {
    best_response: exact.best_weighted,
    slot_variants: neighborhood.counts.slot_variants,
    candidate_count: neighborhood.counts.unique_combat_signatures,
    evaluated_matchups: approximate.evaluated_matchups,
    finalist_count: finalists.length,
    exact_matchups: exact.evaluated_matchups,
  };
};

MatchupGame.equipmentResponseBeam = function(
  build, opponents, opponent_ids, opponent_weights, options
) {
  options = options || {};
  let beam_width = options.beamWidth || 8;
  let minimum_survival_probability = options.minimumSurvivalProbability === undefined ?
    0.01 : options.minimumSurvivalProbability;
  let neighborhood = BuildSearch.equipmentNeighborhood(build, options);
  let approximate = this.candidateFrontiers(
    neighborhood.groups, opponents, opponent_ids, {
      defeatCache: options.defeatCache,
      matchupCache: options.matchupCache,
      minimumSurvivalProbability: minimum_survival_probability,
      opponentWeights: opponent_weights,
      includeCandidates: true,
      trackFrontiers: false,
    }
  );
  let concepts = new Map();
  approximate.candidates.forEach(function(candidate) {
    candidate.sources.forEach(function(source) {
      let signature = BuildSearch.equipmentConceptSignature(source.build);
      if (!concepts.has(signature)) {
        concepts.set(signature, { signature: signature, candidates: new Map() });
      }
      concepts.get(signature).candidates.set(candidate.signature, candidate);
    });
  });
  let selected_concepts = Array.from(concepts.values()).map(function(concept) {
    let candidates = Array.from(concept.candidates.values());
    concept.lower_bound = Math.max.apply(null, candidates.map(function(candidate) {
      return candidate.weighted_score - candidate.weighted_score_error_bound;
    }));
    concept.approximate_score = Math.max.apply(null, candidates.map(function(candidate) {
      return candidate.weighted_score;
    }));
    concept.finalist_signatures = new Set(candidates.filter(function(candidate) {
      return candidate.weighted_score + candidate.weighted_score_error_bound >=
        concept.lower_bound - 1e-12;
    }).map(function(candidate) { return candidate.signature; }));
    return concept;
  }).sort(function(left, right) {
    return right.approximate_score - left.approximate_score;
  }).slice(0, beam_width);
  let finalist_signatures = new Set();
  selected_concepts.forEach(function(concept) {
    concept.finalist_signatures.forEach(function(signature) {
      finalist_signatures.add(signature);
    });
  });
  let finalists = neighborhood.groups.filter(function(group) {
    return finalist_signatures.has(group.signature);
  });
  let exact = this.candidateFrontiers(finalists, opponents, opponent_ids, {
    defeatCache: options.exactDefeatCache,
    matchupCache: options.exactMatchupCache,
    opponentWeights: opponent_weights,
    includeCandidates: true,
    trackFrontiers: false,
  });
  let exact_by_signature = new Map(exact.candidates.map(function(candidate) {
    return [ candidate.signature, candidate ];
  }));
  let beam = selected_concepts.map(function(concept) {
    let candidates = Array.from(concept.finalist_signatures).map(function(signature) {
      return exact_by_signature.get(signature);
    }).filter(function(candidate) { return candidate !== undefined; });
    candidates.sort(function(left, right) {
      return right.weighted_score - left.weighted_score;
    });
    let best = Object.assign({}, candidates[0], {
      sources: candidates[0].sources.filter(function(source) {
        return BuildSearch.equipmentConceptSignature(source.build) === concept.signature;
      }),
    });
    return {
      concept_signature: concept.signature,
      best_response: best,
    };
  }).sort(function(left, right) {
    return right.best_response.weighted_score - left.best_response.weighted_score;
  });

  return {
    beam: beam,
    concept_count: concepts.size,
    selected_concept_count: selected_concepts.length,
    candidate_count: neighborhood.counts.unique_combat_signatures,
    finalist_count: finalists.length,
    evaluated_matchups: approximate.evaluated_matchups,
    exact_matchups: exact.evaluated_matchups,
  };
};

MatchupGame.adaptiveEquipmentBestResponse = function(
  build, opponents, opponent_ids, opponent_weights, options
) {
  options = options || {};
  let minimum_survival_probability = options.minimumSurvivalProbability === undefined ?
    0.01 : options.minimumSurvivalProbability;
  let shared_options = Object.assign({}, options, {
    defeatCache: options.defeatCache ||
      CombatSim.createDefeatRoundCache(minimum_survival_probability),
    matchupCache: options.matchupCache || { values: new Map(), hits: 0, misses: 0 },
    exactDefeatCache: options.exactDefeatCache || CombatSim.createDefeatRoundCache(),
    exactMatchupCache: options.exactMatchupCache || { values: new Map(), hits: 0, misses: 0 },
  });
  let maximum_iterations = options.maxIterations === undefined ? Infinity : options.maxIterations;
  let improvement_tolerance = options.improvementTolerance === undefined ?
    1e-6 : options.improvementTolerance;
  let current_build = build;
  let current_signature = CombatSim.combatSignature(Player.generateBuild(current_build));
  let seen = new Set([ current_signature ]);
  let iterations = [];
  let best;
  let accepted_best;

  for (let iteration = 1; iteration <= maximum_iterations; iteration++) {
    let result = this.equipmentBestResponse(
      current_build, opponents, opponent_ids, opponent_weights, shared_options
    );
    best = result.best_response;
    let improvement = iterations.length === 0 ? null :
      best.weighted_score - iterations[iterations.length - 1].score;
    iterations.push({
      iteration: iteration,
      score: best.weighted_score,
      slot: best.sources[0].slot,
      equipment: best.sources[0].equipment,
      candidate_count: result.candidate_count,
      evaluated_matchups: result.evaluated_matchups,
    });
    if (best.signature === current_signature || seen.has(best.signature)) {
      return { best_response: accepted_best || best, iterations: iterations, converged: true };
    }
    if (improvement !== null && improvement <= improvement_tolerance) {
      return { best_response: accepted_best, iterations: iterations, converged: true };
    }
    accepted_best = best;
    current_build = best.sources[0].build;
    current_signature = best.signature;
    seen.add(current_signature);
  }

  return { best_response: best, iterations: iterations, converged: false };
};

MatchupGame.adaptiveEquipmentResponseBeam = function(
  build, opponents, opponent_ids, opponent_weights, options
) {
  options = options || {};
  let minimum_survival_probability = options.minimumSurvivalProbability === undefined ?
    0.01 : options.minimumSurvivalProbability;
  let beam_width = options.beamWidth || 8;
  let maximum_iterations = options.maxIterations === undefined ? Infinity : options.maxIterations;
  let improvement_tolerance = options.improvementTolerance === undefined ?
    1e-6 : options.improvementTolerance;
  let shared_options = Object.assign({}, options, {
    beamWidth: beam_width,
    defeatCache: options.defeatCache ||
      CombatSim.createDefeatRoundCache(minimum_survival_probability),
    matchupCache: options.matchupCache || { values: new Map(), hits: 0, misses: 0 },
    exactDefeatCache: options.exactDefeatCache || CombatSim.createDefeatRoundCache(),
    exactMatchupCache: options.exactMatchupCache || { values: new Map(), hits: 0, misses: 0 },
  });
  let initial = this.equipmentResponseBeam(
    build, opponents, opponent_ids, opponent_weights, shared_options
  );
  let beam = initial.beam.map(function(entry) {
    return Object.assign({
      stable: false,
      seen_signatures: new Set([ entry.best_response.signature ]),
    }, entry);
  });
  let iterations = [ {
    iteration: 1,
    beam: beam,
    candidate_count: initial.candidate_count,
    finalist_count: initial.finalist_count,
    evaluated_matchups: initial.evaluated_matchups,
    exact_matchups: initial.exact_matchups,
  } ];

  for (let iteration = 2; iteration <= maximum_iterations; iteration++) {
    let advances = beam.filter(function(entry) {
      return !entry.stable;
    }).map(function(entry) {
      let response = MatchupGame.equipmentBestResponse(
        entry.best_response.sources[0].build,
        opponents,
        opponent_ids,
        opponent_weights,
        shared_options
      );
      let candidate = response.best_response;
      let improved = candidate.weighted_score >
        entry.best_response.weighted_score + improvement_tolerance;
      let repeated = entry.seen_signatures.has(candidate.signature);
      if (!improved || repeated) {
        return {
          entry: Object.assign({}, entry, { stable: true }),
          response: response,
        };
      }
      let seen_signatures = new Set(entry.seen_signatures);
      seen_signatures.add(candidate.signature);
      return {
        entry: {
          concept_signature: BuildSearch.equipmentConceptSignature(
            candidate.sources[0].build
          ),
          best_response: candidate,
          stable: false,
          seen_signatures: seen_signatures,
        },
        response: response,
      };
    });
    let best_by_concept = new Map();
    beam.filter(function(entry) { return entry.stable; }).concat(
      advances.map(function(advance) { return advance.entry; })
    ).forEach(function(entry) {
      let existing = best_by_concept.get(entry.concept_signature);
      if (!existing || entry.best_response.weighted_score >
          existing.best_response.weighted_score) {
        best_by_concept.set(entry.concept_signature, entry);
      }
    });
    let next_beam = Array.from(best_by_concept.values()).sort(function(left, right) {
      return right.best_response.weighted_score - left.best_response.weighted_score;
    }).slice(0, beam_width);
    let previous_signatures = beam.map(function(entry) {
      return entry.best_response.signature;
    }).sort();
    let next_signatures = next_beam.map(function(entry) {
      return entry.best_response.signature;
    }).sort();
    iterations.push({
      iteration: iteration,
      beam: next_beam,
      candidate_count: advances.reduce(function(sum, advance) {
        return sum + advance.response.candidate_count;
      }, 0),
      finalist_count: advances.reduce(function(sum, advance) {
        return sum + advance.response.finalist_count;
      }, 0),
      evaluated_matchups: advances.reduce(function(sum, advance) {
        return sum + advance.response.evaluated_matchups;
      }, 0),
      exact_matchups: advances.reduce(function(sum, advance) {
        return sum + advance.response.exact_matchups;
      }, 0),
    });
    beam = next_beam;
    if (beam.every(function(entry) { return entry.stable; }) ||
        JSON.stringify(previous_signatures) === JSON.stringify(next_signatures)) {
      return { beam: beam, iterations: iterations, converged: true };
    }
  }

  return { beam: beam, iterations: iterations, converged: false };
};

MatchupGame.expandEquipmentArchive = function(catalog, options) {
  options = options || {};
  let batch_size = options.batchSize || 2;
  let improvement_tolerance = options.improvementTolerance === undefined ?
    1e-6 : options.improvementTolerance;
  let catalog_matchup_cache = options.catalogMatchupCache || {
    values: new Map(), hits: 0, misses: 0,
  };
  let analysis_started = Date.now();
  let before = this.analyzeBuildCatalog(catalog, {
    matchupCache: catalog_matchup_cache,
  });
  let analysis_ms = Date.now() - analysis_started;
  let equilibrium_entries = before.inferred_meta.weights;
  let opponents = equilibrium_entries.map(function(entry) {
    return Player.generateBuild(catalog[entry.candidate]);
  });
  let opponent_ids = equilibrium_entries.map(function(entry) { return entry.candidate; });
  let opponent_weights = equilibrium_entries.map(function(entry) { return entry.weight; });
  let starting_build = options.startBuild || catalog[equilibrium_entries.slice().sort(
    function(left, right) { return right.weight - left.weight; }
  )[0].candidate];
  let search_started = Date.now();
  let response = this.adaptiveEquipmentResponseBeam(
    starting_build,
    opponents,
    opponent_ids,
    opponent_weights,
    options
  );
  let search_ms = Date.now() - search_started;
  let archived_signatures = new Set(Object.keys(catalog).map(function(key) {
    return CombatSim.combatSignature(Player.generateBuild(catalog[key]));
  }));
  let archived_concepts = new Set(Object.keys(catalog).map(function(key) {
    return BuildSearch.equipmentConceptSignature(catalog[key]);
  }));
  let profitable = response.beam.filter(function(entry) {
    return entry.best_response.weighted_score > 0.5 + improvement_tolerance &&
      !archived_signatures.has(entry.best_response.signature) &&
      !archived_concepts.has(entry.concept_signature);
  });
  let provisional_catalog = Object.assign({}, catalog);
  profitable.forEach(function(entry, index) {
    provisional_catalog['ProvisionalResponse' + index] = Object.assign(
      {}, entry.best_response.sources[0].build, { reference: false }
    );
  });
  let provisional_analysis = profitable.length > 0 ? this.analyzeBuildCatalog(
    provisional_catalog, { matchupCache: catalog_matchup_cache }
  ) : before;
  let provisional_frontier = new Set(provisional_analysis.candidates.filter(
    function(candidate) { return candidate.frontier; }
  ).map(function(candidate) { return candidate.id; }));
  let selected = profitable.slice(0, 1);
  profitable.slice(1).forEach(function(entry, index) {
    if (selected.length < batch_size &&
        provisional_frontier.has('ProvisionalResponse' + (index + 1))) {
      selected.push(entry);
    }
  });
  let expanded_catalog = Object.assign({}, catalog);
  selected.forEach(function(entry, index) {
    let key = 'EndogenousResponse' + (Object.keys(catalog).length + index);
    let build = Object.assign({}, entry.best_response.sources[0].build, {
      name: 'Endogenous Response ' + (Object.keys(catalog).length + index),
      reference: false,
    });
    expanded_catalog[key] = build;
  });
  let solve_started = Date.now();
  let after = selected.length > 0 ? this.analyzeBuildCatalog(expanded_catalog, {
    matchupCache: catalog_matchup_cache,
  }) : before;
  let solve_ms = Date.now() - solve_started;

  return {
    catalog: expanded_catalog,
    added: selected.map(function(entry, index) {
      return {
        id: 'EndogenousResponse' + (Object.keys(catalog).length + index),
        concept_signature: entry.concept_signature,
        score_against_equilibrium: entry.best_response.weighted_score,
        build: expanded_catalog['EndogenousResponse' + (Object.keys(catalog).length + index)],
      };
    }),
    before: before,
    after: after,
    response: response,
    screened_response_count: profitable.length,
    timings_ms: {
      initial_analysis: analysis_ms,
      response_search: search_ms,
      expanded_analysis: solve_ms,
      total: analysis_ms + search_ms + solve_ms,
    },
  };
};

MatchupGame.endogenousEquipmentSearch = function(catalog, options) {
  options = options || {};
  let maximum_rounds = options.maxRounds === undefined ? Infinity : options.maxRounds;
  let minimum_survival_probability = options.minimumSurvivalProbability === undefined ?
    0.01 : options.minimumSurvivalProbability;
  let shared_options = Object.assign({}, options, {
    catalogMatchupCache: options.catalogMatchupCache || {
      values: new Map(), hits: 0, misses: 0,
    },
    defeatCache: options.defeatCache ||
      CombatSim.createDefeatRoundCache(minimum_survival_probability),
    matchupCache: options.matchupCache || { values: new Map(), hits: 0, misses: 0 },
    exactDefeatCache: options.exactDefeatCache || CombatSim.createDefeatRoundCache(),
    exactMatchupCache: options.exactMatchupCache || { values: new Map(), hits: 0, misses: 0 },
  });
  delete shared_options.startBuild;
  let current_catalog = Object.assign({}, catalog);
  let rounds = [];
  let started = Date.now();

  for (let round = 1; round <= maximum_rounds; round++) {
    let expansion = this.expandEquipmentArchive(current_catalog, shared_options);
    let support = new Set(expansion.after.inferred_meta.weights.map(function(entry) {
      return entry.candidate;
    }));
    rounds.push({
      round: round,
      archive_size_before: Object.keys(current_catalog).length,
      archive_size_after: Object.keys(expansion.catalog).length,
      added: expansion.added,
      added_to_support: expansion.added.filter(function(entry) {
        return support.has(entry.id);
      }).map(function(entry) { return entry.id; }),
      support_size: support.size,
      equilibrium: expansion.after.inferred_meta,
      response_converged: expansion.response.converged,
      response_iterations: expansion.response.iterations.length,
      timings_ms: expansion.timings_ms,
    });
    current_catalog = expansion.catalog;
    if (expansion.added.length === 0) {
      return {
        catalog: current_catalog,
        rounds: rounds,
        converged: true,
        elapsed_ms: Date.now() - started,
        caches: MatchupGame.equipmentSearchCacheStats(shared_options),
      };
    }
  }

  return {
    catalog: current_catalog,
    rounds: rounds,
    converged: false,
    elapsed_ms: Date.now() - started,
    caches: MatchupGame.equipmentSearchCacheStats(shared_options),
  };
};

MatchupGame.equipmentSearchCacheStats = function(options) {
  let stats = function(cache) {
    return { entries: cache.values.size, hits: cache.hits, misses: cache.misses };
  };
  return {
    catalog_matchups: stats(options.catalogMatchupCache),
    approximate_matchups: stats(options.matchupCache),
    exact_matchups: stats(options.exactMatchupCache),
  };
};

MatchupGame.jointEquipmentStatResponseBeam = function(
  build, opponents, opponent_ids, opponent_weights, attack_types, options
) {
  options = options || {};
  let beam_width = options.beamWidth || 8;
  let maximum_iterations = options.jointMaxIterations === undefined ?
    Infinity : options.jointMaxIterations;
  let improvement_tolerance = options.improvementTolerance === undefined ?
    1e-6 : options.improvementTolerance;
  let minimum_survival_probability = options.minimumSurvivalProbability === undefined ?
    0.01 : options.minimumSurvivalProbability;
  let shared_options = Object.assign({}, options, {
    beamWidth: beam_width,
    defeatCache: options.defeatCache ||
      CombatSim.createDefeatRoundCache(minimum_survival_probability),
    matchupCache: options.matchupCache || { values: new Map(), hits: 0, misses: 0 },
    exactDefeatCache: options.exactDefeatCache || CombatSim.createDefeatRoundCache(),
    exactMatchupCache: options.exactMatchupCache || { values: new Map(), hits: 0, misses: 0 },
  });
  let seeds = [ build ];
  let seen_beams = new Set();
  let iterations = [];
  let equipment_ms = 0;
  let stat_ms = 0;
  let beam = [];
  let equipment;
  let previous_best_score = null;

  for (let iteration = 1; iteration <= maximum_iterations; iteration++) {
    let equipment_started = Date.now();
    let responses = seeds.map(function(seed) {
      return MatchupGame.equipmentResponseBeam(
        seed, opponents, opponent_ids, opponent_weights, shared_options
      );
    });
    let incumbent_groups = seeds.map(function(seed) {
      return {
        signature: CombatSim.combatSignature(Player.generateBuild(seed)),
        representative: Player.generateBuild(seed),
        sources: [ { build: seed } ],
      };
    });
    let incumbents = MatchupGame.candidateFrontiers(
      incumbent_groups, opponents, opponent_ids, {
        defeatCache: shared_options.exactDefeatCache,
        matchupCache: shared_options.exactMatchupCache,
        opponentWeights: opponent_weights,
        includeCandidates: true,
        trackFrontiers: false,
      }
    );
    let equipment_by_concept = new Map();
    let add_equipment_entry = function(entry) {
      let existing = equipment_by_concept.get(entry.concept_signature);
      if (!existing || entry.best_response.weighted_score >
          existing.best_response.weighted_score) {
        equipment_by_concept.set(entry.concept_signature, entry);
      }
    };
    responses.forEach(function(response) {
      response.beam.forEach(add_equipment_entry);
    });
    incumbents.candidates.forEach(function(candidate) {
      add_equipment_entry({
        concept_signature: BuildSearch.equipmentConceptSignature(candidate.sources[0].build),
        best_response: candidate,
      });
    });
    let equipment_beam = Array.from(equipment_by_concept.values()).sort(
      function(left, right) {
        return right.best_response.weighted_score - left.best_response.weighted_score;
      }
    ).slice(0, beam_width);
    equipment_ms += Date.now() - equipment_started;
    equipment = {
      beam: equipment_beam,
      candidate_count: responses.reduce(function(sum, response) {
        return sum + response.candidate_count;
      }, 0),
      finalist_count: responses.reduce(function(sum, response) {
        return sum + response.finalist_count;
      }, 0) + incumbents.candidate_count,
      evaluated_matchups: responses.reduce(function(sum, response) {
        return sum + response.evaluated_matchups;
      }, 0),
      exact_matchups: responses.reduce(function(sum, response) {
        return sum + response.exact_matchups;
      }, 0) + incumbents.evaluated_matchups,
    };

    let responses_by_signature = new Map();
    equipment_beam.forEach(function(entry) {
      let equipment_build = entry.best_response.sources[0].build;
      let stat_started = Date.now();
      let stats = MatchupGame.adaptiveStatFrontiers(
        equipment_build,
        opponents,
        opponent_ids,
        attack_types,
        Object.assign({}, shared_options, { opponentWeights: opponent_weights })
      );
      stat_ms += Date.now() - stat_started;
      let source = stats.best_weighted.sources[0];
      let response_build = Object.assign({}, equipment_build, {
        stats: source.stats,
        attack_type: source.attack_type,
      });
      let signature = CombatSim.combatSignature(Player.generateBuild(response_build));
      let response = {
        signature: signature,
        concept_signature: BuildSearch.equipmentConceptSignature(response_build),
        weighted_score: stats.best_weighted.weighted_score,
        build: response_build,
        stat_search: stats,
      };
      let existing = responses_by_signature.get(signature);
      if (!existing || response.weighted_score > existing.weighted_score) {
        responses_by_signature.set(signature, response);
      }
    });
    beam = Array.from(responses_by_signature.values()).sort(function(left, right) {
      return right.weighted_score - left.weighted_score;
    }).slice(0, beam_width);
    let beam_signature = JSON.stringify(beam.map(function(entry) {
      return entry.signature;
    }).sort());
    iterations.push({
      iteration: iteration,
      seed_count: seeds.length,
      equipment_candidate_count: equipment.candidate_count,
      equipment_finalist_count: equipment.finalist_count,
      beam: beam,
    });
    let repeated = seen_beams.has(beam_signature);
    let improvement = previous_best_score === null ? null :
      beam[0].weighted_score - previous_best_score;
    if (repeated || (improvement !== null && improvement <= improvement_tolerance)) {
      return {
        beam: beam,
        equipment_response: equipment,
        iterations: iterations,
        converged: true,
        convergence_reason: repeated ? 'repeated_beam' : 'score_tolerance',
        timings_ms: {
          equipment: equipment_ms,
          stats: stat_ms,
          total: equipment_ms + stat_ms,
        },
      };
    }
    seen_beams.add(beam_signature);
    previous_best_score = beam[0].weighted_score;
    seeds = beam.map(function(entry) { return entry.build; });
  }

  return {
    beam: beam,
    equipment_response: equipment,
    iterations: iterations,
    converged: false,
    convergence_reason: 'iteration_limit',
    timings_ms: {
      equipment: equipment_ms,
      stats: stat_ms,
      total: equipment_ms + stat_ms,
    },
  };
};

MatchupGame.adaptiveStatFrontiers = function(build, opponents, opponent_ids, attack_types, options) {
  options = options || {};
  let point_strides = options.pointStrides || [ 11, 5, 2, 1 ];
  if (point_strides.length === 0 || point_strides.some(function(point_stride) {
    return !Number.isInteger(point_stride) || point_stride <= 0;
  })) {
    throw new Error('Adaptive stat search requires positive integer point strides.');
  }
  let minimum_survival_probability = options.minimumSurvivalProbability || 0;
  let allowed_hp_points = options.hpPoints ? new Set(options.hpPoints) : null;
  let groups_by_signature = new Map();
  let source_keys = new Set();
  let search_cache = CombatSim.createDefeatRoundCache(minimum_survival_probability);
  let matchup_cache = { values: new Map(), hits: 0, misses: 0 };
  let pending_groups = [];
  let addSource = function(source) {
    if (source.stats.hp < 2 || source.stats.speed < 2 ||
        source.stats.accuracy < 4 || source.stats.dodge < 4 ||
        source.stats.hp + source.stats.speed + source.stats.accuracy + source.stats.dodge !== 183 ||
        (allowed_hp_points && !allowed_hp_points.has(source.stats.hp))) {
      return false;
    }
    let source_key = JSON.stringify([ source.attack_type, source.stats ]);
    if (source_keys.has(source_key)) {
      return false;
    }
    source_keys.add(source_key);
    let candidate = Object.assign({}, build, {
      stats: source.stats,
      attack_type: source.attack_type,
    });
    let player = Player.generateBuild(candidate);
    let signature = CombatSim.combatSignature(player);
    let group = groups_by_signature.get(signature);
    if (!group) {
      group = { signature: signature, representative: player, sources: [] };
      groups_by_signature.set(signature, group);
      pending_groups.push(group);
    }
    group.sources.push({
      attack_type: source.attack_type,
      stats: Object.assign({}, source.stats),
    });
    return true;
  };
  let expandFrontier = function(frontier_result, radius, point_stride) {
    let added = 0;
    let frontier = frontier_result.combat_frontier.concat(
      frontier_result.combat_economy_frontier
    );
    frontier.forEach(function(candidate) {
      candidate.sources.forEach(function(source) {
        for (let hp_offset = -radius; hp_offset <= radius; hp_offset += point_stride) {
          for (let accuracy_offset = -radius; accuracy_offset <= radius;
            accuracy_offset += point_stride) {
            let stats = {
              hp: source.stats.hp + hp_offset,
              speed: source.stats.speed,
              accuracy: source.stats.accuracy + accuracy_offset,
            };
            stats.dodge = 183 - stats.hp - stats.speed - stats.accuracy;
            if (addSource({ attack_type: source.attack_type, stats: stats })) {
              added++;
            }
          }
        }
      });
    });
    return added;
  };

  let incumbent_source_key = null;
  let current_attack_type = build.attack_type || 'normal';
  if (attack_types.includes(current_attack_type)) {
    let incumbent_source = { attack_type: current_attack_type, stats: build.stats };
    if (addSource(incumbent_source)) {
      incumbent_source_key = JSON.stringify([ current_attack_type, build.stats ]);
    }
  }
  attack_types.forEach(function(attack_type) {
    let speed_points = BuildSearch.initiativeSpeedPoints(build, opponents, attack_type);
    BuildSearch.forEachStatAllocation(speed_points, {
      hpPoints: options.hpPoints,
      pointStride: point_strides[0],
    }, function(stats) {
      addSource({ attack_type: attack_type, stats: stats });
    });
  });

  let stages = [];
  let frontier_result;
  point_strides.forEach(function(point_stride, stage) {
    frontier_result = MatchupGame.candidateFrontiers(
      pending_groups,
      opponents,
      opponent_ids,
      {
        defeatCache: search_cache,
        matchupCache: matchup_cache,
        previousResult: frontier_result,
        opponentWeights: options.opponentWeights,
      }
    );
    pending_groups = [];
    stages.push({
      point_stride: point_stride,
      candidate_count: frontier_result.candidate_count,
      evaluated_matchups: frontier_result.evaluated_matchups,
      combat_frontier_count: frontier_result.combat_frontier.length,
      combat_economy_frontier_count: frontier_result.combat_economy_frontier.length,
    });

    if (stage === point_strides.length - 1) {
      return;
    }
    let next_stride = point_strides[stage + 1];
    expandFrontier(frontier_result, point_stride, next_stride);
  });

  let convergence = [];
  let convergence_iteration = 0;
  let converged = false;
  while (!converged) {
    convergence_iteration++;
    let added = expandFrontier(frontier_result, 1, 1);
    if (added === 0) {
      convergence.push({
        iteration: convergence_iteration,
        added_allocations: 0,
        candidate_count: frontier_result.candidate_count,
        combat_frontier_count: frontier_result.combat_frontier.length,
        combat_economy_frontier_count: frontier_result.combat_economy_frontier.length,
      });
      converged = true;
      continue;
    }
    frontier_result = MatchupGame.candidateFrontiers(
      pending_groups,
      opponents,
      opponent_ids,
      {
        defeatCache: search_cache,
        matchupCache: matchup_cache,
        previousResult: frontier_result,
        opponentWeights: options.opponentWeights,
      }
    );
    pending_groups = [];
    convergence.push({
      iteration: convergence_iteration,
      added_allocations: added,
      candidate_count: frontier_result.candidate_count,
      combat_frontier_count: frontier_result.combat_frontier.length,
      combat_economy_frontier_count: frontier_result.combat_economy_frontier.length,
    });
  }

  let finalist_source_keys = new Set();
  frontier_result.combat_frontier.concat(frontier_result.combat_economy_frontier)
    .forEach(function(candidate) {
      candidate.sources.forEach(function(source) {
        finalist_source_keys.add(JSON.stringify([ source.attack_type, source.stats ]));
      });
    });
  if (incumbent_source_key !== null) {
    finalist_source_keys.add(incumbent_source_key);
  }
  let finalists = Array.from(groups_by_signature.values()).filter(function(group) {
    return group.sources.some(function(source) {
      return finalist_source_keys.has(JSON.stringify([ source.attack_type, source.stats ]));
    });
  });
  let exact_result = MatchupGame.candidateFrontiers(finalists, opponents, opponent_ids, {
    opponentWeights: options.opponentWeights,
  });
  exact_result.search_candidate_count = frontier_result.candidate_count;
  exact_result.search_evaluated_matchups = frontier_result.evaluated_matchups;
  exact_result.search_defeat_cache = frontier_result.defeat_cache;
  exact_result.search_matchup_cache = frontier_result.matchup_cache;
  exact_result.minimum_survival_probability = minimum_survival_probability;
  exact_result.exact_finalist_count = finalists.length;
  exact_result.stages = stages;
  exact_result.convergence = convergence;
  exact_result.converged = converged;
  return exact_result;
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

MatchupGame.analyzeBuildCatalog = function(catalog, options) {
  options = options || {};
  let matchup_cache = options.matchupCache || { values: new Map(), hits: 0, misses: 0 };
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
  let combatResult = function(player, opponent) {
    let key = JSON.stringify([
      CombatSim.combatSignature(player),
      CombatSim.combatSignature(opponent),
    ]);
    if (matchup_cache.values.has(key)) {
      matchup_cache.hits++;
      return matchup_cache.values.get(key);
    }
    matchup_cache.misses++;
    let result = CombatSim.combatResultDistribution(player, opponent);
    matchup_cache.values.set(key, result);
    return result;
  };

  for (let i = 0; i < players.length; i++) {
    let self_result = combatResult(players[i], players[i]);
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
      let forward_result = combatResult(players[i], players[j]);
      let reverse_result = combatResult(players[j], players[i]);
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
  let equilibrium = this.mixedEquilibrium(score_matrix);
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
    inferred_meta: {
      weights: equilibrium.strategy.map(function(weight, player) {
        return { candidate: ids[player], weight: weight };
      }).filter(function(entry) { return entry.weight > 0; }),
      exploitability: equilibrium.exploitability,
      tolerance: equilibrium.tolerance,
      iterations: equilibrium.iterations,
      converged: equilibrium.converged,
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
