/*eslint-env node*/
'use strict';

let src = require('../combatsim.js');
let Player = src.Player;
let Equipment = src.Equipment;
let Item = src.Item;
let WeaponMod = src.WeaponMod;
let Build = src.Build;
let BuildCatalogs = src.BuildCatalogs;
let mergeBuildCatalogs = src.mergeBuildCatalogs;
let BuildSearch = src.BuildSearch;
let MatchupGame = src.MatchupGame;
let CombatSim = src.CombatSim;

let jsondiffpatch = require('jsondiffpatch');

let testDeepEqualWithDiff = function(test, a, b) {
  let own_props_a = Object.assign({}, a);
  let own_props_b = Object.assign({}, b);

  test.deepEqual(
    own_props_a,
    own_props_b,
    'Difference: ' + JSON.stringify(jsondiffpatch.diff(own_props_a, own_props_b))
  );
};

let testDistributionMatchesMonteCarlo = function(test, expected, sampleDamage, randomState) {
  let observedCounts = new Map();
  let sampleCount = 100000;
  let originalRandom = Math.random;

  Math.random = function() {
    randomState = (randomState * 16807) % 2147483647;
    return (randomState - 1) / 2147483646;
  };

  try {
    for (let sample = 0; sample < sampleCount; sample++) {
      let damage = sampleDamage();
      observedCounts.set(damage, (observedCounts.get(damage) || 0) + 1);
    }
  } finally {
    Math.random = originalRandom;
  }

  test.deepEqual(
    Array.from(observedCounts.keys()).sort(function(a, b) { return a - b; }),
    Array.from(expected.keys()).sort(function(a, b) { return a - b; })
  );

  expected.forEach(function(expectedProbability, damage) {
    let observedProbability = observedCounts.get(damage) / sampleCount;
    test.ok(
      Math.abs(observedProbability - expectedProbability) < 0.005,
      'damage ' + damage + ': expected ' + expectedProbability +
        ', observed ' + observedProbability
    );
  });
};

exports.testCombatInitiative = function(test) {
  let slower = { name: 'Slower', speed: 100 };
  let faster = { name: 'Faster', speed: 101 };
  let originalFight = CombatSim.fight;
  let attackers = [];

  CombatSim.fight = function(attacker) {
    attackers.push(attacker);
    return attacker;
  };

  try {
    CombatSim.simulateCombat(slower, faster, 4);
    test.deepEqual(attackers, [ faster, faster, faster, faster ]);

    attackers = [];
    CombatSim.simulateCombat(faster, slower, 4);
    test.deepEqual(attackers, [ faster, faster, faster, faster ]);

    attackers = [];
    faster.speed = slower.speed;
    CombatSim.simulateCombat(slower, faster, 4);
    test.deepEqual(attackers, [ slower, slower, slower, slower ]);
  } finally {
    CombatSim.fight = originalFight;
  }

  test.done();
};

exports.testDefeatedPlayerCannotRetaliate = function(test) {
  let attacker = {
    name: 'Attacker',
    max_hp: 10,
    weapon1: {},
    weapon2: {},
  };
  let defender = {
    name: 'Defender',
    max_hp: 10,
    weapon1: {},
    weapon2: {},
  };
  let originalAttemptHit = CombatSim.attemptHit;
  let attacks = [];

  CombatSim.attemptHit = function(player) {
    attacks.push(player.name);
    return 5;
  };

  try {
    test.strictEqual(CombatSim.fight(attacker, defender), attacker);
    test.deepEqual(attacks, [ 'Attacker', 'Attacker' ]);
  } finally {
    CombatSim.attemptHit = originalAttemptHit;
  }

  test.done();
};

exports.testSurvivingPlayerCounterattacksWithBothWeapons = function(test) {
  let attacker = {
    name: 'Attacker',
    max_hp: 5,
    weapon1: {},
    weapon2: {},
  };
  let defender = {
    name: 'Defender',
    max_hp: 10,
    weapon1: {},
    weapon2: {},
  };
  let originalAttemptHit = CombatSim.attemptHit;
  let attacks = [];

  CombatSim.attemptHit = function(player) {
    attacks.push(player.name);
    return player === attacker ? 1 : 3;
  };

  try {
    test.strictEqual(CombatSim.fight(attacker, defender), defender);
    test.deepEqual(attacks, [ 'Attacker', 'Attacker', 'Defender', 'Defender' ]);
  } finally {
    CombatSim.attemptHit = originalAttemptHit;
  }

  test.done();
};

exports.testCombatRoundLimitProducesDraw = function(test) {
  let player1 = {
    max_hp: 10,
    weapon1: {},
    weapon2: {},
  };
  let player2 = {
    max_hp: 10,
    weapon1: {},
    weapon2: {},
  };
  let originalAttemptHit = CombatSim.attemptHit;
  let attempts = 0;

  CombatSim.attemptHit = function() {
    attempts++;
    return 0;
  };

  try {
    test.strictEqual(CombatSim.fight(player1, player2), null);
    test.equal(attempts, CombatSim.MAX_COMBAT_ROUNDS * 4);
  } finally {
    CombatSim.attemptHit = originalAttemptHit;
  }

  test.done();
};

exports.testCombatResultsIncludeDraws = function(test) {
  let player1 = { speed: 1 };
  let player2 = { speed: 1 };
  let originalFight = CombatSim.fight;

  CombatSim.fight = function() {
    return null;
  };

  try {
    test.deepEqual(CombatSim.simulateCombat(player1, player2, 3), {
      player1_wins: 0,
      player2_wins: 0,
      draws: 3,
    });
  } finally {
    CombatSim.fight = originalFight;
  }

  test.done();
};

exports.testPlayerGeneration = function(test) {
  let test_player = Player.generatePlayer(
    'Test Player',
    {
      max_hp: 50,
      armor: 10,
      speed: 11,
      accuracy: 12,
      dodge: 13,
      melee_skill: 14,
      gun_skill: 15,
      proj_skill: 16,
      def_skill: 17,
    },
    [ Item.none, Item.none, Item.none, Item.none, Item.none ]
  );

  let expected_stats = {
    name: 'Test Player',
    level: 80,
    max_hp: 50,
    armor: 10,
    speed: 11,
    accuracy: 12,
    dodge: 13,
    melee_skill: 14,
    gun_skill: 15,
    proj_skill: 16,
    def_skill: 17,
    weapon1: {
      type: 'unarmed',
      skill: 'def_skill',
      min_damage: 0,
      max_damage: 0,
    },
    weapon2: {
      type: 'unarmed',
      skill: 'def_skill',
      min_damage: 0,
      max_damage: 0,
    },
  };

  testDeepEqualWithDiff(test, test_player, expected_stats);

  test.done();
};

exports.testNullPlayerGeneration = function(test) {
  let test_player = Player.generatePlayer(
    'Test Player',
    { },
    [ Item.none, Item.none, Item.none, Item.none, Item.none ]
  );

  let expected_stats = {
    name: 'Test Player',
    level: 80,
    max_hp: 0,
    armor: 0,
    speed: 0,
    accuracy: 0,
    dodge: 0,
    melee_skill: 0,
    gun_skill: 0,
    proj_skill: 0,
    def_skill: 0,
    weapon1: {
      type: 'unarmed',
      skill: 'def_skill',
      min_damage: 0,
      max_damage: 0,
    },
    weapon2: {
      type: 'unarmed',
      skill: 'def_skill',
      min_damage: 0,
      max_damage: 0,
    },
  };

  testDeepEqualWithDiff(test, test_player, expected_stats);

  test.done();
};

exports.testFullyTrainedPlayerGeneration = function(test) {
  let test_player = Player.generateFullyTrainedPlayer(
    'Test Player',
    { hp: 70, speed: 10, accuracy: 53, dodge: 50 },
    [ Item.none, Item.none, Item.none, Item.none, Item.none ]
  );

  let expected_stats = {
    name: 'Test Player',
    level: 80,
    max_hp: 350,
    armor: 5,
    speed: 100,
    accuracy: 63,
    dodge: 60,
    melee_skill: 450,
    gun_skill: 450,
    proj_skill: 450,
    def_skill: 450,
    weapon1: {
      type: 'unarmed',
      skill: 'def_skill',
      min_damage: 5,
      max_damage: 5,
    },
    weapon2: {
      type: 'unarmed',
      skill: 'def_skill',
      min_damage: 5,
      max_damage: 5,
    },
  };

  testDeepEqualWithDiff(test, test_player, expected_stats);

  test.done();
};

exports.testPlayerGenerationWithItem = function(test) {
  let armor = new Equipment({
    armor:       10,
    dodge:       5,
  });

  let amulet = new Equipment({
    accuracy:    5,
    dodge:       5,
    def_skill:   20,
    gun_skill:   20,
    melee_skill: 20,
    proj_skill:  20
  });

  let sword = new Equipment({
    type:        'melee',
    min_damage:  10,
    max_damage:  20,
    accuracy:    10,
    speed:       50,
    melee_skill: 15,
    proj_skill:  5,
    def_skill:   5
  });

  let gun = new Equipment({
    type:        'gun',
    min_damage:  20,
    max_damage:  30,
    accuracy:    10,
    speed:       50,
    gun_skill:   15,
    proj_skill:  5,
    def_skill:   5
  });

  // Same weapon
  let test_player = Player.generatePlayer(
    'Test Player',
    { },
    [ armor, sword, sword, amulet, amulet ]
  );

  let expected_stats = {
    name: 'Test Player',
    level: 80,
    max_hp: 0,
    armor: 10,
    speed: 100,
    accuracy: 30,
    dodge: 15,
    melee_skill: 70,
    gun_skill: 40,
    proj_skill: 50,
    def_skill: 50,
    weapon1: {
      type: 'melee',
      skill: 'melee_skill',
      min_damage: 10,
      max_damage: 20,
    },
    weapon2: {
      type: 'melee',
      skill: 'melee_skill',
      min_damage: 10,
      max_damage: 20,
    },
  };

  testDeepEqualWithDiff(test, test_player, expected_stats);



  // Test mixed weapon bonuses
  test_player = Player.generatePlayer(
    'Test Player',
    { },
    [
      Item.none,
      sword,
      gun,
      Item.none,
      Item.none
    ]
  );

  expected_stats = {
    name: 'Test Player',
    level: 80,
    max_hp: 0,
    armor: 0,
    speed: 100,
    accuracy: 20,
    dodge: 0,
    melee_skill: 30,
    gun_skill: 30,
    proj_skill: 10, // ensure dual wield bonus only applies to corresponding skill
    def_skill: 10,
    weapon1: {
      type: 'melee',
      skill: 'melee_skill',
      min_damage: 10,
      max_damage: 20,
    },
    weapon2: {
      type: 'gun',
      skill: 'gun_skill',
      min_damage: 20,
      max_damage: 30,
    },
  };

  testDeepEqualWithDiff(test, test_player, expected_stats);



  test_player = Player.generateFullyTrainedPlayer(
    'Test Player',
    { hp: 70, speed: 10, accuracy: 53, dodge: 50 },
    [ armor, sword, gun, amulet, amulet ]
  );

  expected_stats = {
    name: 'Test Player',
    level: 80,
    max_hp: 350,
    armor: 15,
    speed: 200,
    accuracy: 93,
    dodge: 75,
    melee_skill: 520,
    gun_skill: 520,
    proj_skill: 500,
    def_skill: 500,
    // Test that ability combat stat bonuses get added
    weapon1: {
      type: 'melee',
      skill: 'melee_skill',
      min_damage: 15,
      max_damage: 25,
    },
    weapon2: {
      type: 'gun',
      skill: 'gun_skill',
      min_damage: 25,
      max_damage: 35,
    },
  };

  testDeepEqualWithDiff(test, test_player, expected_stats);

  test.done();
};

exports.testCurrentArmorDamageFormula = function(test) {
  let attacker = {
    level: 80,
    accuracy: 1,
    gun_skill: 1,
  };
  let defender = {
    armor: 280,
    dodge: 1,
    def_skill: 1,
  };
  let weapon = {
    skill: 'gun_skill',
    min_damage: 101,
    max_damage: 101,
  };
  let originalRollCombat = CombatSim.rollCombat;

  CombatSim.rollCombat = function() {
    return true;
  };

  try {
    test.equal(CombatSim.attemptHit(attacker, defender, weapon), 51);

    defender.armor = 0;
    test.equal(CombatSim.attemptHit(attacker, defender, weapon), 101);

    attacker.level = 100;
    defender.armor = 280;
    test.equal(CombatSim.attemptHit(attacker, defender, weapon), 51);

    defender.armor = 100000;
    test.equal(CombatSim.attemptHit(attacker, defender, weapon), 0);
  } finally {
    CombatSim.rollCombat = originalRollCombat;
  }

  test.done();
};

exports.testWeaponDamageDistribution = function(test) {
  let attacker = {
    level: 80,
    accuracy: 100,
    gun_skill: 100,
  };
  let defender = {
    armor: 0,
    dodge: 100,
    def_skill: 100,
  };
  let weapon = {
    skill: 'gun_skill',
    min_damage: 100,
    max_damage: 100,
  };

  test.deepEqual(
    Array.from(CombatSim.weaponDamageDistribution(attacker, defender, weapon)),
    [ [ 0, 0.75 ], [ 100, 0.25 ] ]
  );

  attacker.accuracy = 500;
  attacker.gun_skill = 500;
  defender.armor = 280;
  weapon.min_damage = 100;
  weapon.max_damage = 102;
  test.deepEqual(
    Array.from(CombatSim.weaponDamageDistribution(attacker, defender, weapon)),
    [ [ 50, 1 / 3 ], [ 51, 2 / 3 ] ]
  );

  attacker.accuracy = 100;
  defender.dodge = 500;
  test.deepEqual(
    Array.from(CombatSim.weaponDamageDistribution(attacker, defender, weapon)),
    [ [ 0, 1 ] ]
  );

  attacker.accuracy = 500;
  defender.armor = 100000;
  weapon.min_damage = 1;
  weapon.max_damage = 1;
  test.deepEqual(
    Array.from(CombatSim.weaponDamageDistribution(attacker, defender, weapon)),
    [ [ 0, 1 ] ]
  );

  test.done();
};

exports.testWeaponDamageDistributionMatchesMonteCarlo = function(test) {
  let attacker = {
    level: 80,
    accuracy: 175,
    gun_skill: 145,
  };
  let defender = {
    armor: 237,
    dodge: 130,
    def_skill: 190,
  };
  let weapon = {
    skill: 'gun_skill',
    min_damage: 90,
    max_damage: 96,
  };
  let expected = CombatSim.weaponDamageDistribution(attacker, defender, weapon);
  testDistributionMatchesMonteCarlo(test, expected, function() {
    return CombatSim.attemptHit(attacker, defender, weapon);
  }, 123456789);

  test.done();
};

exports.testAttackDamageDistribution = function(test) {
  let attacker = {
    level: 80,
    accuracy: 100,
    gun_skill: 100,
    melee_skill: 100,
    weapon1: {
      skill: 'gun_skill',
      min_damage: 10,
      max_damage: 10,
    },
    weapon2: {
      skill: 'melee_skill',
      min_damage: 20,
      max_damage: 20,
    },
  };
  let defender = {
    armor: 0,
    dodge: 100,
    def_skill: 100,
  };

  test.deepEqual(
    Array.from(CombatSim.attackDamageDistribution(attacker, defender)),
    [ [ 0, 0.5625 ], [ 20, 0.1875 ], [ 10, 0.1875 ], [ 30, 0.0625 ] ]
  );

  test.done();
};

exports.testAttackDamageDistributionMatchesMonteCarlo = function(test) {
  let attacker = {
    level: 80,
    accuracy: 175,
    gun_skill: 145,
    melee_skill: 215,
    weapon1: {
      skill: 'gun_skill',
      min_damage: 90,
      max_damage: 96,
    },
    weapon2: {
      skill: 'melee_skill',
      min_damage: 41,
      max_damage: 45,
    },
  };
  let defender = {
    armor: 237,
    dodge: 130,
    def_skill: 190,
  };
  let expected = CombatSim.attackDamageDistribution(attacker, defender);
  testDistributionMatchesMonteCarlo(test, expected, function() {
    return CombatSim.attemptHit(attacker, defender, attacker.weapon1) +
      CombatSim.attemptHit(attacker, defender, attacker.weapon2);
  }, 987654321);

  test.done();
};

exports.testCombatOutcomeDistribution = function(test) {
  let player1 = {
    max_hp: 10,
    level: 80,
    speed: 100,
    accuracy: 500,
    dodge: 100,
    gun_skill: 500,
    def_skill: 100,
    armor: 0,
    weapon1: { skill: 'gun_skill', min_damage: 10, max_damage: 10 },
    weapon2: { skill: 'gun_skill', min_damage: 0, max_damage: 0 },
  };
  let player2 = Object.assign({}, player1, {
    weapon1: { skill: 'gun_skill', min_damage: 10, max_damage: 10 },
    weapon2: { skill: 'gun_skill', min_damage: 0, max_damage: 0 },
  });

  test.deepEqual(
    CombatSim.combatOutcomeDistribution(player1, player2),
    { player1_wins: 1, player2_wins: 0, draws: 0 }
  );

  player2.speed = 101;
  test.deepEqual(
    CombatSim.combatOutcomeDistribution(player1, player2),
    { player1_wins: 0, player2_wins: 1, draws: 0 }
  );

  player1.weapon1 = { skill: 'gun_skill', min_damage: 0, max_damage: 0 };
  player2.weapon1 = { skill: 'gun_skill', min_damage: 0, max_damage: 0 };
  test.deepEqual(
    CombatSim.combatOutcomeDistribution(player1, player2),
    { player1_wins: 0, player2_wins: 0, draws: 1 }
  );

  test.done();
};

exports.testCombatHealthLossDistribution = function(test) {
  let player1 = {
    max_hp: 10,
    level: 80,
    speed: 100,
    accuracy: 500,
    dodge: 100,
    gun_skill: 500,
    def_skill: 100,
    armor: 0,
    weapon1: { skill: 'gun_skill', min_damage: 10, max_damage: 10 },
    weapon2: { skill: 'gun_skill', min_damage: 0, max_damage: 0 },
  };
  let player2 = Object.assign({}, player1);
  let result = CombatSim.combatResultDistribution(player1, player2);

  test.equal(CombatSim.healingCost(0, 10), 7);
  test.equal(CombatSim.healingCost(0, 20), 8);
  test.equal(CombatSim.healingCost(20, 100), 13);
  test.equal(CombatSim.healingCost(20, 815), 133);
  test.equal(CombatSim.healingCost(0, 815), 141);

  test.deepEqual(result.outcome, { player1_wins: 1, player2_wins: 0, draws: 0 });
  test.deepEqual(result.player1, {
    wins: 1,
    expected_hp_remaining: 10,
    expected_hp_lost_on_win: 0,
    zero_damage_win_probability: 1,
    expected_healing_cost_on_win: 0,
    expected_healing_cost: 0,
    expected_hp_lost: 0,
  });
  test.deepEqual(result.player2, {
    wins: 0,
    expected_hp_remaining: 0,
    expected_hp_lost_on_win: null,
    zero_damage_win_probability: null,
    expected_healing_cost_on_win: null,
    expected_healing_cost: 7,
    expected_hp_lost: 10,
  });

  player2.speed = 101;
  result = CombatSim.combatResultDistribution(player1, player2);
  test.deepEqual(result.outcome, { player1_wins: 0, player2_wins: 1, draws: 0 });
  test.equal(result.player1.expected_hp_lost, 10);
  test.equal(result.player2.expected_hp_lost_on_win, 0);
  test.equal(result.player2.zero_damage_win_probability, 1);

  player2.speed = 100;
  player1.weapon1 = { skill: 'gun_skill', min_damage: 5, max_damage: 5 };
  player2.weapon1 = { skill: 'gun_skill', min_damage: 3, max_damage: 3 };
  result = CombatSim.combatResultDistribution(player1, player2);
  test.deepEqual(result.outcome, { player1_wins: 1, player2_wins: 0, draws: 0 });
  test.equal(result.player1.expected_hp_remaining, 7);
  test.equal(result.player1.expected_hp_lost, 3);
  test.equal(result.player1.expected_hp_lost_on_win, 3);
  test.equal(result.player1.zero_damage_win_probability, 0);
  test.equal(result.player1.expected_healing_cost_on_win, 1);
  test.equal(result.player1.expected_healing_cost, 1);

  let cache = CombatSim.createDefeatRoundCache();
  let first_cached_result = CombatSim.combatResultDistribution(player1, player2, cache);
  test.deepEqual(first_cached_result, result);
  test.deepEqual({ entries: cache.values.size, hits: cache.hits, misses: cache.misses }, {
    entries: 2,
    hits: 0,
    misses: 2,
  });
  let second_cached_result = CombatSim.combatResultDistribution(player1, player2, cache);
  test.deepEqual(second_cached_result, result);
  test.deepEqual({ entries: cache.values.size, hits: cache.hits, misses: cache.misses }, {
    entries: 2,
    hits: 2,
    misses: 2,
  });

  let tail_attacker = Object.assign({}, player1, {
    accuracy: 100,
    gun_skill: 100,
    weapon1: { skill: 'gun_skill', min_damage: 10, max_damage: 10 },
  });
  let exact_tail = CombatSim.defeatRoundDistribution(tail_attacker, player2);
  test.ok(exact_tail.defeat_rounds.every(function(probability) { return probability >= 0; }));
  test.ok(Math.abs(exact_tail.defeat_rounds.reduce(function(sum, probability) {
    return sum + probability;
  }, exact_tail.survives) - 1) < 1e-12);
  let truncated_tail = CombatSim.defeatRoundDistribution(
    tail_attacker,
    player2,
    CombatSim.createDefeatRoundCache(1e-6)
  );
  test.ok(truncated_tail.survives > exact_tail.survives);
  test.ok(truncated_tail.survives <= 1e-6);
  test.done();
};

exports.testCombatOutcomeDistributionMatchesMonteCarlo = function(test) {
  let player1 = {
    max_hp: 60,
    level: 80,
    speed: 110,
    accuracy: 175,
    dodge: 130,
    gun_skill: 145,
    melee_skill: 215,
    def_skill: 190,
    armor: 100,
    weapon1: { skill: 'gun_skill', min_damage: 30, max_damage: 30 },
    weapon2: { skill: 'melee_skill', min_damage: 15, max_damage: 15 },
  };
  let player2 = {
    max_hp: 65,
    level: 80,
    speed: 100,
    accuracy: 160,
    dodge: 145,
    gun_skill: 205,
    melee_skill: 155,
    def_skill: 175,
    armor: 110,
    weapon1: { skill: 'gun_skill', min_damage: 28, max_damage: 28 },
    weapon2: { skill: 'melee_skill', min_damage: 16, max_damage: 16 },
  };
  let expected = CombatSim.combatOutcomeDistribution(player1, player2);
  let sampleCount = 100000;
  let randomState = 246813579;
  let originalRandom = Math.random;
  let observed;

  Math.random = function() {
    randomState = (randomState * 16807) % 2147483647;
    return (randomState - 1) / 2147483646;
  };

  try {
    observed = CombatSim.simulateCombat(player1, player2, sampleCount);
  } finally {
    Math.random = originalRandom;
  }

  Object.keys(expected).forEach(function(outcome) {
    let observedProbability = observed[outcome] / sampleCount;
    test.ok(
      Math.abs(observedProbability - expected[outcome]) < 0.005,
      outcome + ': expected ' + expected[outcome] + ', observed ' + observedProbability
    );
  });
  test.ok(Math.abs(expected.player1_wins + expected.player2_wins + expected.draws - 1) < 1e-9);

  test.done();
};

exports.testAttackTypes = function(test) {
  let raw_stats = {
    speed: 101,
    accuracy: 101,
    dodge: 101,
  };
  let items = [ Item.none, Item.none, Item.none, Item.none, Item.none ];

  let normal = Player.generatePlayer('Normal', raw_stats, items, 'normal');
  test.equal(normal.speed, 101);
  test.equal(normal.accuracy, 101);
  test.equal(normal.dodge, 101);

  let quick = Player.generatePlayer('Quick', raw_stats, items, 'quick');
  test.equal(quick.speed, 122);
  test.equal(quick.accuracy, 91);
  test.equal(quick.dodge, 91);

  let aimed = Player.generatePlayer('Aimed', raw_stats, items, 'aimed');
  test.equal(aimed.speed, 91);
  test.equal(aimed.accuracy, 122);
  test.equal(aimed.dodge, 91);

  let cover = Player.generatePlayer('Cover', raw_stats, items, 'cover');
  test.equal(cover.speed, 91);
  test.equal(cover.accuracy, 91);
  test.equal(cover.dodge, 122);

  test.throws(function() {
    Player.generatePlayer('Unknown', raw_stats, items, 'unknown');
  }, /Unknown attack type/);

  test.done();
};

exports.testCombatProbability = function(test) {
  test.equal(CombatSim.combatProbability(100, 100), 0.5);
  test.equal(CombatSim.combatProbability(101, 101), 0.5);

  let expected = ((51 * (51 / 2)) / (151 * 76));
  test.equal(CombatSim.combatProbability(100, 200), expected);
  test.equal(CombatSim.combatProbability(200, 100), 1 - expected);

  test.equal(CombatSim.combatProbability(100, 500), 0);
  test.equal(CombatSim.combatProbability(500, 100), 1);

  test.done();
};

exports.testCombatRollUsesDocumentedProbability = function(test) {
  let originalRandom = Math.random;

  try {
    Math.random = function() { return 0.499; };
    test.equal(CombatSim.rollCombat(100, 100), true);

    Math.random = function() { return 0.5; };
    test.equal(CombatSim.rollCombat(100, 100), false);
  } finally {
    Math.random = originalRandom;
  }

  test.done();
};

exports.testCrystalSocketing = function(test) {
  let item = new Equipment({
    name:        'item',
    min_damage:  100,
    max_damage:  200,
    armor:       300,
    dodge:       400,
    accuracy:    500,
    speed:       600,
    def_skill:   700,
    melee_skill: 800,
    gun_skill:   900,
    proj_skill:  1000,
  });

  let crystal = new Equipment({
    name: 'crystal',
    mult: {
      min_damage:  1.1,
      max_damage:  1.2,
      armor:       1.3,
      dodge:       1.4,
      accuracy:    1.5,
      speed:       1.6,
      def_skill:   1.7,
      melee_skill: 1.8,
      gun_skill:   1.9,
      proj_skill:  2.0,
    },
  });

  let socketed_item = item.socket([ crystal ]);
  let expected_stats = new Equipment({
    name:        'item',
    min_damage:  110,
    max_damage:  240,
    armor:       390,
    dodge:       560,
    accuracy:    750,
    speed:       960,
    def_skill:   1190,
    melee_skill: 1440,
    gun_skill:   1710,
    proj_skill:  2000,
    crystals:    [ crystal ]
  });
  testDeepEqualWithDiff(test, socketed_item, expected_stats);

  let socketed_item_2 = item.socket([ crystal, crystal ]);
  let expected_stats_2 = new Equipment({
    name:        'item',
    min_damage:  120,
    max_damage:  280,
    armor:       480,
    dodge:       720,
    accuracy:    1000,
    speed:       1320,
    def_skill:   1680,
    melee_skill: 2080,
    gun_skill:   2520,
    proj_skill:  3000,
    crystals:    [ crystal, crystal ]
  });
  testDeepEqualWithDiff(test, socketed_item_2, expected_stats_2);

  test.done();
};

exports.testWeaponMods = function(test) {
  let upgraded = Item.BioGunMk4.applyMods([
    WeaponMod.FasterReload4,
    WeaponMod.FasterAmmo4,
  ]);

  test.equal(upgraded.min_damage, 95);
  test.equal(upgraded.max_damage, 114);
  test.equal(upgraded.accuracy, 50);
  test.deepEqual(upgraded.mods, [
    WeaponMod.FasterReload4,
    WeaponMod.FasterAmmo4,
  ]);

  test.throws(
    function() {
      Item.VoidSword.applyMods([ WeaponMod.LaserSight ]);
    },
    /Laser Sight is not compatible with Void Sword/
  );
  test.throws(
    function() {
      Item.BioGunMk4.applyMods([
        WeaponMod.FasterReload4,
        WeaponMod.EnhancedScope4,
      ]);
    },
    /Weapon mod slot 1 is already occupied/
  );
  test.throws(
    function() {
      Item.VoidBow.applyMods([
        WeaponMod.LaserSight,
        WeaponMod.PoisonedTip,
      ]);
    },
    /Void Bow supports at most 1 weapon mod/
  );

  let dagger = Item.RitualDaggerIV.applyMods([
    WeaponMod.EnhancedPoison2,
    WeaponMod.SharpenedBlade2,
  ]);
  test.equal(dagger.min_damage, 99);
  test.equal(dagger.max_damage, 123);

  test.done();
};

exports.testJsonBuild = function(test) {
  let player = Player.generateBuild(Build.DualVoidBowsWithScouts);

  test.equal(player.name, 'Dual VBows w/ Scouts');
  test.equal(player.max_hp, 350);
  test.equal(player.speed, 300);
  test.equal(player.accuracy, 188);
  test.deepEqual(player.weapon1, {
    type: 'projectile',
    skill: 'proj_skill',
    min_damage: 19,
    max_damage: 180,
  });

  let quickBuild = JSON.parse(JSON.stringify(Build.DualVoidBowsWithScouts));
  quickBuild.attack_type = 'quick';
  let quickPlayer = Player.generateBuild(quickBuild);
  test.equal(quickPlayer.speed, 360);
  test.equal(quickPlayer.accuracy, 170);

  quickBuild.level = 79;
  test.throws(function() {
    Player.generateBuild(quickBuild);
  }, /Builds require level 80/);

  let livePlayer = Player.generateBuild(Build.DualRiftsWithBiosAbyss);
  test.equal(livePlayer.max_hp, 750);
  test.equal(livePlayer.armor, 83);
  test.equal(livePlayer.speed, 256);
  test.equal(livePlayer.accuracy, 228);
  test.equal(livePlayer.dodge, 143);
  test.equal(livePlayer.gun_skill, 818);
  test.equal(livePlayer.def_skill, 778);

  test.done();
};

exports.testEquivalentBuildGrouping = function(test) {
  let original = JSON.parse(JSON.stringify(Build.CoreStaffVoidSwordWithScouts));
  let reordered = JSON.parse(JSON.stringify(original));
  let distinct = JSON.parse(JSON.stringify(original));
  let weapon1 = reordered.equipment.weapon1;
  reordered.name = 'Reordered weapons';
  reordered.equipment.weapon1 = reordered.equipment.weapon2;
  reordered.equipment.weapon2 = weapon1;
  distinct.name = 'Quick attack';
  distinct.attack_type = 'quick';

  let groups = Player.groupEquivalentBuilds([ original, reordered, distinct ]);
  let equivalent_group = groups.filter(function(group) {
    return group.builds.length === 2;
  })[0];

  test.equal(groups.length, 2);
  test.ok(equivalent_group);
  test.strictEqual(equivalent_group.builds[0], original);
  test.strictEqual(equivalent_group.builds[1], reordered);
  test.equal(
    equivalent_group.signature,
    CombatSim.combatSignature(Player.generateBuild(original))
  );
  test.equal(equivalent_group.representative.name, original.name);
  test.notEqual(
    CombatSim.combatSignature(Player.generateBuild(original)),
    CombatSim.combatSignature(Player.generateBuild(distinct))
  );

  test.done();
};

exports.testMultipleBuildCatalogs = function(test) {
  test.equal(BuildCatalogs.length, 3);
  test.equal(Object.keys(BuildCatalogs[1]).length, 15);
  test.equal(Object.keys(BuildCatalogs[2]).length, 1);
  test.equal(Object.keys(Build).length, 21);
  test.equal(Player.generateReferencePlayers(BuildCatalogs).length, 19);
  test.equal(Build.ControlledKernel.equipment.weapon1.item, 'CrystalSword');
  test.equal(Build.ControlledKernel.equipment.weapon2.item, 'CrystalSword');

  let q15_player = Player.generateBuild(Build.ShadowDojoDLGunBuild2);
  test.deepEqual(q15_player.weapon2, {
    type: 'gun',
    skill: 'gun_skill',
    min_damage: 120,
    max_damage: 138,
  });
  test.throws(function() {
    mergeBuildCatalogs([ { Duplicate: {} }, { Duplicate: {} } ]);
  }, /Duplicate build key/);

  test.done();
};

exports.testCanonicalEquipmentVariantGeneration = function(test) {
  test.deepEqual(
    BuildSearch.activeWeaponSkills([ 'projectile', 'gun', 'projectile' ]),
    [ 'gun_skill', 'proj_skill' ]
  );
  test.deepEqual(
    BuildSearch.crystalMultisets([ 'A', 'B' ], 2),
    [ [ 'A', 'A' ], [ 'A', 'B' ], [ 'B', 'B' ] ]
  );

  let variants = BuildSearch.generateItemVariantsForWeapons('RiftGun', [ 'RiftGun', 'VoidBow' ], {
    crystalKeys: [ 'PerfectGreen', 'PerfectOrange', 'PerfectYellow', 'PerfectFire' ],
    socketCapacity: 1,
  });
  let sources = variants.reduce(function(all_sources, group) {
    return all_sources.concat(group.sources);
  }, []);
  let crystal_selections = sources.map(function(source) {
    return source.crystals;
  });

  test.deepEqual(crystal_selections, [ [ 'PerfectGreen' ], [ 'PerfectFire' ] ]);
  test.equal(variants.length, 2);

  let report = BuildSearch.itemVariantReport('RiftGun', {
    activeWeaponTypes: [ 'gun', 'projectile' ],
    crystalKeys: [ 'PerfectGreen', 'PerfectOrange', 'PerfectYellow', 'PerfectFire' ],
    socketCapacity: 1,
  });
  test.deepEqual(report.counts, {
    unfiltered_ordered: 4,
    filtered_ordered: 2,
    canonical: 2,
    unique_effective: 2,
    nondominated: 2,
  });
  test.deepEqual(report.useful_crystals, [ 'PerfectGreen', 'PerfectFire' ]);
  let cached_options = {
    activeWeaponTypes: [ 'gun', 'projectile' ],
    crystalKeys: [ 'PerfectGreen', 'PerfectFire' ],
    socketCapacity: 1,
  };
  let cached_report = BuildSearch.cachedItemVariantReport('RiftGun', cached_options);
  test.strictEqual(
    BuildSearch.cachedItemVariantReport('RiftGun', cached_options),
    cached_report
  );
  test.deepEqual(cached_report, BuildSearch.itemVariantReport('RiftGun', cached_options));

  let mod_combinations = BuildSearch.modCombinations(Item.BioGunMk4);
  test.equal(mod_combinations.length, 4);
  mod_combinations.forEach(function(mods) {
    let occupied_slots = mods.map(function(key) { return WeaponMod[key].slot; });
    test.equal(mods.length, 2);
    test.equal(new Set(occupied_slots).size, occupied_slots.length);
  });

  let frontier = BuildSearch.pruneDominatedItemVariants([
    { representative: { armor: 10, speed: 5 } },
    { representative: { armor: 10, speed: 4 } },
    { representative: { armor: 9, speed: 6 } },
  ], [ 'gun' ]);
  test.deepEqual(frontier.map(function(group) { return group.representative; }), [
    { armor: 10, speed: 5 },
    { armor: 9, speed: 6 },
  ]);

  test.done();
};

exports.testSlotVariantFrontier = function(test) {
  let report = BuildSearch.slotVariantFrontier('weapons', {
    activeWeaponTypes: [ 'gun', 'projectile' ],
    weaponType: 'gun',
    itemKeys: [ 'RiftGun', 'AlienRifle', 'VoidBow' ],
    crystalKeys: [ 'PerfectGreen', 'PerfectFire' ],
    socketCapacity: 1,
  });

  test.equal(report.counts.base_items, 2);
  test.ok(report.counts.item_frontier_variants >= report.counts.unique_effective);
  test.ok(report.counts.unique_effective >= report.counts.nondominated);
  report.groups.forEach(function(group) {
    test.equal(group.representative.type, 'gun');
    group.sources.forEach(function(source) {
      test.notEqual(source.item, 'VoidBow');
    });
  });
  test.throws(function() {
    BuildSearch.slotVariantFrontier('weapons', {});
  }, /require a weapon type/);
  test.throws(function() {
    BuildSearch.slotVariantFrontier('unknown', {});
  }, /Unknown equipment slot/);

  test.done();
};

exports.testEquipmentNeighborhood = function(test) {
  let build = Build.ShadowDojoDLGunBuild3;
  let normalized = BuildSearch.normalizeEquipment(build);
  test.equal(normalized.length, 1);
  normalized.forEach(function(entry) {
    test.equal(entry.replacements.length, 3);
    test.deepEqual(entry.build.equipment.weapon2.crystals, [
      'BerserkerCrystal', 'BerserkerCrystal', 'BerserkerCrystal', 'BerserkerCrystal',
    ]);
    test.deepEqual(entry.build.equipment.misc1.crystals, [
      'GreenInferno', 'GreenInferno', 'GreenInferno', 'GreenInferno',
    ]);
    test.deepEqual(entry.build.equipment.misc2.crystals, [
      'GreenInferno', 'GreenInferno', 'GreenInferno', 'GreenInferno',
    ]);
  });
  let branching_build = Object.assign({}, build, {
    equipment: Object.assign({}, build.equipment, {
      misc1: {
        item: 'BioSpinalEnhancer',
        crystals: [ 'PerfectWater', 'PerfectWater', 'PerfectWater', 'PerfectWater' ],
      },
    }),
  });
  let branching_normalized = BuildSearch.normalizeEquipment(
    branching_build, { slots: [ 'misc1' ] }
  );
  test.equal(branching_normalized.length, 5);
  branching_normalized.forEach(function(entry) {
    test.ok(!entry.build.equipment.misc1.crystals.includes('PerfectWater'));
  });
  let concept_left = Object.assign({}, normalized[0].build, {
    equipment: Object.assign({}, normalized[0].build.equipment, {
      weapon1: {
        item: 'AlienRifle',
        crystals: [
          'AmuletCrystal', 'AmuletCrystal', 'AmuletCrystal', 'BerserkerCrystal',
        ],
      },
    }),
  });
  let concept_right = Object.assign({}, concept_left, {
    equipment: Object.assign({}, concept_left.equipment, {
      weapon1: {
        item: 'AlienRifle',
        crystals: [
          'AmuletCrystal', 'BerserkerCrystal', 'BerserkerCrystal', 'BerserkerCrystal',
        ],
      },
    }),
  });
  test.equal(
    BuildSearch.equipmentConceptSignature(concept_left),
    BuildSearch.equipmentConceptSignature(concept_right)
  );
  let distinct_concept = Object.assign({}, concept_right, {
    equipment: Object.assign({}, concept_right.equipment, {
      weapon1: {
        item: 'AlienRifle',
        crystals: [
          'BerserkerCrystal', 'BerserkerCrystal', 'BerserkerCrystal', 'BerserkerCrystal',
        ],
      },
    }),
  });
  test.notEqual(
    BuildSearch.equipmentConceptSignature(concept_left),
    BuildSearch.equipmentConceptSignature(distinct_concept)
  );
  let neighborhood = BuildSearch.equipmentNeighborhood(build, {
    slots: [ 'weapon1', 'misc1' ],
    itemKeysBySlot: {
      weapon1: [ 'RiftGun', 'AlienRifle' ],
      misc1: [ 'ScoutDrones' ],
    },
    crystalKeys: [ 'PerfectFire' ],
    socketCapacity: 1,
  });

  test.ok(neighborhood.counts.slot_variants >= neighborhood.groups.length);
  test.ok(neighborhood.groups.length > 0);
  neighborhood.groups.forEach(function(group) {
    test.ok(group.sources.length > 0);
    group.sources.forEach(function(source) {
      test.ok(source.slot === 'weapon1' || source.slot === 'misc1');
      test.ok(source.equipment.crystals.length <= 1);
    });
  });
  test.throws(function() {
    BuildSearch.equipmentNeighborhood(build, { slots: [ 'unknown' ] });
  }, /Unknown equipment slot/);

  let opponent = Player.generateBuild(build);
  let response = MatchupGame.equipmentBestResponse(
    build, [ opponent ], [ 'opponent' ], [ 1 ], {
      slots: [ 'weapon1' ],
      itemKeysBySlot: { weapon1: [ 'RiftGun', 'AlienRifle' ] },
      crystalKeys: [ 'PerfectFire' ],
      socketCapacity: 1,
      minimumSurvivalProbability: 1e-6,
    }
  );
  test.equal(response.candidate_count, response.evaluated_matchups);
  test.ok(response.finalist_count <= response.candidate_count);
  test.equal(response.exact_matchups, response.finalist_count);
  test.ok(response.best_response.weighted_score >= 0 &&
    response.best_response.weighted_score <= 1);
  test.equal(response.best_response.sources[0].slot, 'weapon1');
  let exact_neighborhood = BuildSearch.equipmentNeighborhood(build, {
    slots: [ 'weapon1' ],
    itemKeysBySlot: { weapon1: [ 'RiftGun', 'AlienRifle' ] },
    crystalKeys: [ 'PerfectFire' ],
    socketCapacity: 1,
  });
  let exhaustive_response = MatchupGame.candidateFrontiers(
    exact_neighborhood.groups, [ opponent ], [ 'opponent' ], { opponentWeights: [ 1 ] }
  );
  test.equal(response.best_response.signature, exhaustive_response.best_weighted.signature);

  let other_opponent = Player.generateBuild(Build.ShadowDojoHFCoreVoid);
  let approximate_matchup = MatchupGame.candidateMatchup(
    opponent,
    other_opponent,
    CombatSim.createDefeatRoundCache(0.1)
  );
  let exact_matchup = MatchupGame.candidateMatchup(opponent, other_opponent);
  test.ok(approximate_matchup.score_error_bound > 0);
  test.ok(Math.abs(approximate_matchup.score - exact_matchup.score) <=
    approximate_matchup.score_error_bound);
  let adaptive_response = MatchupGame.adaptiveEquipmentBestResponse(
    build, [ opponent ], [ 'opponent' ], [ 1 ], {
      slots: [ 'weapon1' ],
      itemKeysBySlot: { weapon1: [ 'RiftGun' ] },
      crystalKeys: [ 'PerfectFire' ],
      socketCapacity: 1,
      minimumSurvivalProbability: 1e-6,
      maxIterations: 3,
    }
  );
  test.ok(adaptive_response.converged);
  test.ok(adaptive_response.iterations.length <= 3);
  let response_beam = MatchupGame.equipmentResponseBeam(
    build, [ opponent ], [ 'opponent' ], [ 1 ], {
      slots: [ 'weapon1' ],
      itemKeysBySlot: { weapon1: [ 'RiftGun', 'AlienRifle' ] },
      crystalKeys: [ 'PerfectFire', 'AmuletCrystal', 'BerserkerCrystal' ],
      socketCapacity: 2,
      minimumSurvivalProbability: 1e-6,
      beamWidth: 2,
    }
  );
  test.equal(response_beam.beam.length, 2);
  test.equal(new Set(response_beam.beam.map(function(entry) {
    return entry.concept_signature;
  })).size, 2);
  test.ok(response_beam.finalist_count >= response_beam.beam.length);
  let adaptive_beam = MatchupGame.adaptiveEquipmentResponseBeam(
    build, [ opponent ], [ 'opponent' ], [ 1 ], {
      slots: [ 'weapon1' ],
      itemKeysBySlot: { weapon1: [ 'RiftGun', 'AlienRifle' ] },
      crystalKeys: [ 'PerfectFire', 'AmuletCrystal', 'BerserkerCrystal' ],
      socketCapacity: 2,
      minimumSurvivalProbability: 1e-6,
      beamWidth: 2,
    }
  );
  test.ok(adaptive_beam.converged);
  test.ok(adaptive_beam.beam.length <= 2);

  test.done();
};

exports.testStatAllocationGeneration = function(test) {
  let build = Build.ShadowDojoDLGunBuild3;
  let opponent_keys = [
    'ShadowDojoArmorStackCores',
    'ShadowDojoDLGunBuild3',
    'ShadowDojoHFCoreVoid',
    'ShadowDojoSG1SplitBombs',
  ];
  let opponents = opponent_keys.map(function(key) {
    return Player.generateBuild(Build[key]);
  });

  test.deepEqual(
    BuildSearch.initiativeSpeedPoints(build, opponents, 'normal'),
    [ 2, 3, 16, 19, 24 ]
  );

  let allocations = [];
  let count = BuildSearch.forEachStatAllocation([ 173 ], {}, function(stats) {
    allocations.push(stats);
  });
  test.equal(count, 1);
  test.deepEqual(allocations, [ { hp: 2, speed: 173, accuracy: 4, dodge: 4 } ]);

  let allocations_are_valid = true;
  count = BuildSearch.forEachStatAllocation([ 2 ], { hpPoints: [ 2 ] }, function(stats) {
    allocations_are_valid = allocations_are_valid &&
      stats.hp + stats.speed + stats.accuracy + stats.dodge === 183 &&
      stats.accuracy >= 4 && stats.dodge >= 4;
  });
  test.equal(count, 172);
  test.ok(allocations_are_valid);
  test.throws(function() {
    BuildSearch.forEachStatAllocation([ 2 ], { pointStride: 0 }, function() {});
  }, /positive integer/);

  let report = BuildSearch.statAllocationReport(
    build, opponents, [ 'normal' ], { hpPoints: [ 2 ] }
  );
  test.equal(report.length, 1);
  test.deepEqual(report[0].speed_points, [ 2, 3, 16, 19, 24 ]);
  test.ok(report[0].unique_combat_signatures <= report[0].allocations);

  let groups = BuildSearch.statAllocationGroups(
    build, opponents, [ 'normal', 'quick', 'aimed', 'cover' ], { hpPoints: [ 2 ] }
  );
  test.equal(groups.length, 3310);
  test.ok(groups.every(function(group) {
    return group.representative.max_hp === 10 && group.sources.length > 0;
  }));

  let exhaustive = MatchupGame.candidateFrontiers(groups, opponents, opponent_keys, {
    minimumSurvivalProbability: 1e-6,
  });
  let adaptive = MatchupGame.adaptiveStatFrontiers(
    build,
    opponents,
    opponent_keys,
    [ 'normal', 'quick', 'aimed', 'cover' ],
    { hpPoints: [ 2 ], minimumSurvivalProbability: 1e-6 }
  );
  let frontierSources = function(result, frontier) {
    return result[frontier].flatMap(function(candidate) {
      return candidate.sources.map(function(source) { return JSON.stringify(source); });
    }).sort();
  };
  test.deepEqual(
    frontierSources(adaptive, 'combat_frontier'),
    frontierSources(exhaustive, 'combat_frontier')
  );
  test.deepEqual(
    frontierSources(adaptive, 'combat_economy_frontier'),
    frontierSources(exhaustive, 'combat_economy_frontier')
  );
  test.ok(adaptive.search_candidate_count < groups.length);
  test.equal(adaptive.exact_finalist_count, 2);
  test.equal(adaptive.converged, true);
  test.equal(adaptive.convergence[adaptive.convergence.length - 1].added_allocations, 0);
  test.throws(function() {
    MatchupGame.adaptiveStatFrontiers(
      build, opponents, opponent_keys, [ 'normal' ], { pointStrides: [] }
    );
  }, /positive integer/);
  test.throws(function() {
    MatchupGame.adaptiveStatFrontiers(
      build, opponents, opponent_keys, [ 'normal' ], { pointStrides: [ -1 ] }
    );
  }, /positive integer/);

  let sparse_adaptive = MatchupGame.adaptiveStatFrontiers(
    build,
    opponents,
    opponent_keys,
    [ 'normal', 'quick', 'aimed', 'cover' ],
    { hpPoints: [ 2 ], pointStrides: [ 8 ], minimumSurvivalProbability: 1e-6 }
  );
  test.ok(sparse_adaptive.convergence[0].added_allocations > 0);
  test.equal(
    sparse_adaptive.convergence[sparse_adaptive.convergence.length - 1].added_allocations,
    0
  );
  test.deepEqual(
    frontierSources(sparse_adaptive, 'combat_frontier'),
    frontierSources(exhaustive, 'combat_frontier')
  );
  test.deepEqual(
    frontierSources(sparse_adaptive, 'combat_economy_frontier'),
    frontierSources(exhaustive, 'combat_economy_frontier')
  );
  test.equal(
    sparse_adaptive.search_candidate_count,
    sparse_adaptive.stages[0].candidate_count +
      sparse_adaptive.convergence.reduce(function(sum, iteration) {
        return sum + iteration.added_allocations;
      }, 0)
  );
  test.done();
};

exports.testJointEquipmentStatResponseBeam = function(test) {
  let build = Build.ControlledKernel;
  let opponent = Player.generateBuild(build);
  let response = MatchupGame.jointEquipmentStatResponseBeam(
    build,
    [ opponent ],
    [ 'ControlledKernel' ],
    [ 1 ],
    [ 'normal' ],
    {
      beamWidth: 2,
      maxIterations: 1,
      slots: [ 'weapon1' ],
      itemKeysBySlot: { weapon1: [ 'CrystalSword', 'CrystalSwordT2' ] },
      crystalKeys: [ 'PerfectFire' ],
      hpPoints: [ 70 ],
      pointStrides: [ 11 ],
      minimumSurvivalProbability: 1e-6,
    }
  );

  test.ok(response.beam.length > 0);
  test.ok(response.beam.every(function(entry) {
    return entry.build.stats.hp === 70 && entry.build.attack_type === 'normal';
  }));
  test.ok(response.beam[0].weighted_score >=
    response.equipment_response.beam[0].best_response.weighted_score);
  test.equal(response.iterations.length, 2);
  test.equal(response.iterations[1].seed_count, response.beam.length);
  test.ok(response.iterations[1].stat_search_cache_hits > 0);
  test.ok(response.iterations.every(function(iteration) {
    return iteration.equipment_combat_signature_count <= iteration.equipment_concept_count;
  }));
  test.ok(response.converged);
  test.equal(response.convergence_reason, 'repeated_beam');
  test.ok(response.timings_ms.total >= response.timings_ms.equipment);

  let bounded = MatchupGame.jointEquipmentStatResponseBeam(
    build,
    [ opponent ],
    [ 'ControlledKernel' ],
    [ 1 ],
    [ 'normal' ],
    {
      beamWidth: 2,
      jointMaxIterations: 1,
      slots: [ 'weapon1' ],
      itemKeysBySlot: { weapon1: [ 'CrystalSword', 'CrystalSwordT2' ] },
      crystalKeys: [ 'PerfectFire' ],
      hpPoints: [ 70 ],
      pointStrides: [ 11 ],
      minimumSurvivalProbability: 1e-6,
    }
  );
  test.equal(bounded.iterations.length, 1);
  test.equal(bounded.converged, false);
  test.equal(bounded.convergence_reason, 'iteration_limit');
  test.done();
};

exports.testRestrictedMatchupGame = function(test) {
  let player1 = {
    max_hp: 10,
    level: 80,
    speed: 100,
    accuracy: 500,
    dodge: 100,
    gun_skill: 500,
    def_skill: 100,
    armor: 0,
    weapon1: { skill: 'gun_skill', min_damage: 10, max_damage: 10 },
    weapon2: { skill: 'gun_skill', min_damage: 0, max_damage: 0 },
  };
  let player2 = Object.assign({}, player1, {
    weapon1: { skill: 'gun_skill', min_damage: 10, max_damage: 10 },
    weapon2: { skill: 'gun_skill', min_damage: 0, max_damage: 0 },
  });
  let matrix = MatchupGame.payoffMatrix([ player1, player2 ]);

  test.deepEqual(matrix, [ [ 0.5, 0.5 ], [ 0.5, 0.5 ] ]);
  test.deepEqual(MatchupGame.candidateMatchup(player1, player2), {
    score: 0.5,
    score_error_bound: 0,
    win_probability: 0.5,
    expected_healing_cost: 3.5,
  });

  let helpless = Object.assign({}, player1, {
    weapon1: { skill: 'gun_skill', min_damage: 0, max_damage: 0 },
    weapon2: { skill: 'gun_skill', min_damage: 0, max_damage: 0 },
  });
  let candidate_frontiers = MatchupGame.candidateFrontiers([
    { representative: helpless, sources: [ 'helpless' ] },
    { representative: player1, sources: [ 'viable' ] },
  ], [ player2 ], [ 'opponent' ]);
  test.deepEqual(candidate_frontiers.cheapest_per_win.sources, [ 'viable' ]);
  test.deepEqual(candidate_frontiers.combat_economy_frontier.map(function(candidate) {
    return candidate.sources[0];
  }), [ 'viable' ]);

  let defeat_cache = CombatSim.createDefeatRoundCache();
  let matchup_cache = { values: new Map(), hits: 0, misses: 0 };
  let incremental = MatchupGame.candidateFrontiers([
    { representative: helpless, sources: [ 'helpless' ] },
  ], [ player2 ], [ 'opponent' ], {
    defeatCache: defeat_cache,
    matchupCache: matchup_cache,
  });
  incremental = MatchupGame.candidateFrontiers([
    { representative: player1, sources: [ 'viable' ] },
  ], [ player2 ], [ 'opponent' ], {
    defeatCache: defeat_cache,
    matchupCache: matchup_cache,
    previousResult: incremental,
  });
  test.equal(incremental.candidate_count, 2);
  test.equal(incremental.evaluated_matchups, 2);
  test.deepEqual(incremental.combat_economy_frontier.map(function(candidate) {
    return candidate.sources[0];
  }), [ 'viable' ]);
  MatchupGame.candidateFrontiers([
    { representative: player1, sources: [ 'viable' ] },
  ], [ player2 ], [ 'opponent' ], {
    defeatCache: defeat_cache,
    matchupCache: matchup_cache,
  });
  test.deepEqual({
    entries: matchup_cache.values.size,
    hits: matchup_cache.hits,
    misses: matchup_cache.misses,
  }, { entries: 2, hits: 1, misses: 2 });
  let changed_opponent = Object.assign({}, player2, { dodge: player2.dodge + 1 });
  MatchupGame.candidateFrontiers([
    { representative: player1, sources: [ 'viable' ] },
  ], [ changed_opponent ], [ 'changed-opponent' ], {
    defeatCache: defeat_cache,
    matchupCache: matchup_cache,
  });
  test.deepEqual({
    entries: matchup_cache.values.size,
    hits: matchup_cache.hits,
    misses: matchup_cache.misses,
  }, { entries: 3, hits: 1, misses: 3 });

  let cyclic_matrix = [
    [ 0.5, 0, 1 ],
    [ 1, 0.5, 0 ],
    [ 0, 1, 0.5 ],
  ];
  test.deepEqual(MatchupGame.strategyScores(cyclic_matrix, [ 1 / 3, 1 / 3, 1 / 3 ]), [
    0.5, 0.5, 0.5,
  ]);
  test.equal(MatchupGame.worstCaseScore(cyclic_matrix, [ 1 / 3, 1 / 3, 1 / 3 ]), 0.5);
  test.deepEqual(MatchupGame.bestResponse(cyclic_matrix, [ 1, 0, 0 ]), {
    score: 1,
    players: [ 1 ],
  });
  test.equal(MatchupGame.exploitability(cyclic_matrix, [ 1 / 3, 1 / 3, 1 / 3 ]), 0);
  test.equal(MatchupGame.exploitability(cyclic_matrix, [ 1, 0, 0 ]), 0.5);
  test.deepEqual(MatchupGame.pureMaximin(cyclic_matrix), {
    score: 0,
    players: [ 0, 1, 2 ],
  });
  test.deepEqual(MatchupGame.mixedEquilibrium(cyclic_matrix), {
    strategy: [ 1 / 3, 1 / 3, 1 / 3 ],
    exploitability: 0,
    tolerance: 0.001,
    iterations: 1,
    converged: true,
  });

  let weighted_cyclic_matrix = [
    [ 0.5, 0.4, 0.8 ],
    [ 0.6, 0.5, 0.3 ],
    [ 0.2, 0.7, 0.5 ],
  ];
  let weighted_equilibrium = MatchupGame.mixedEquilibrium(weighted_cyclic_matrix);
  test.ok(weighted_equilibrium.converged);
  test.ok(weighted_equilibrium.exploitability <= 0.001);
  [ 2 / 6, 3 / 6, 1 / 6 ].forEach(function(expected, player) {
    test.ok(Math.abs(weighted_equilibrium.strategy[player] - expected) <= 0.01);
  });

  let pure_matrix = [
    [ 0.5, 0.7 ],
    [ 0.3, 0.5 ],
  ];
  test.deepEqual(MatchupGame.mixedEquilibrium(pure_matrix), {
    strategy: [ 1, 0 ],
    exploitability: 0,
    tolerance: 0.001,
    iterations: 0,
    converged: true,
  });

  test.done();
};

exports.testMatchupDominanceFrontier = function(test) {
  let matrix = [
    [ 0.5, 0.5, 0.8 ],
    [ 0.5, 0.5, 0.6 ],
    [ 0.2, 0.4, 0.5 ],
  ];

  test.deepEqual(MatchupGame.dominanceFrontier(matrix), {
    players: [ 0 ],
    dominated_by: [ [], [ 0 ], [ 0, 1 ] ],
  });

  let iterated_matrix = [
    [ 0.5, 0.6, 0.7 ],
    [ 0.4, 0.5, 0.8 ],
    [ 0.3, 0.2, 0.5 ],
  ];
  test.deepEqual(MatchupGame.iteratedDominanceKernel(iterated_matrix), {
    players: [ 0 ],
    rounds: [
      {
        active_players: [ 0, 1, 2 ],
        eliminated: [ { player: 2, dominated_by: [ 0, 1 ] } ],
      },
      {
        active_players: [ 0, 1 ],
        eliminated: [ { player: 1, dominated_by: [ 0 ] } ],
      },
    ],
  });
  test.done();
};

exports.testSeedBuildCatalogAnalysis = function(test) {
  let analysis = MatchupGame.analyzeBuildCatalog(BuildCatalogs[1]);

  test.equal(analysis.source_build_count, 15);
  test.ok(analysis.candidate_count <= analysis.source_build_count);
  test.deepEqual(analysis.frontier, [
    'ShadowDojoArmorStackCores',
    'ShadowDojoDLGunBuild3',
    'ShadowDojoHFCoreVoid',
    'ShadowDojoSG1SplitBombs',
  ]);
  test.deepEqual(analysis.pure_maximin, {
    score: 0.5,
    candidates: [ 'ShadowDojoDLGunBuild3' ],
  });
  test.deepEqual(analysis.strategic_kernel, [
    'ShadowDojoDLGunBuild3',
  ]);
  test.deepEqual(analysis.inferred_meta, {
    weights: [ { candidate: 'ShadowDojoDLGunBuild3', weight: 1 } ],
    exploitability: 0,
    tolerance: 0.001,
    iterations: 0,
    converged: true,
  });
  test.equal(analysis.elimination_rounds.length, 3);
  test.equal(analysis.score_matrix.length, analysis.candidate_count);
  test.deepEqual(
    analysis.matrix_order,
    analysis.candidates.map(function(candidate) { return candidate.id; })
  );
  analysis.candidates.forEach(function(candidate, player) {
    test.equal(candidate.frontier, candidate.dominated_by.length === 0);
    test.ok(candidate.worst_score <= candidate.average_score);
    test.ok(candidate.average_win_probability >= 0 && candidate.average_win_probability <= 1);
    test.ok(candidate.average_draw_rate >= 0 && candidate.average_draw_rate <= 1);
    test.ok(candidate.average_hp_lost >= 0);
    test.ok(candidate.average_hp_lost_on_win >= 0);
    test.ok(candidate.average_zero_damage_win_probability >= 0 &&
      candidate.average_zero_damage_win_probability <= 1);
    test.ok(candidate.average_healing_cost >= 0);
    test.ok(candidate.average_healing_cost_on_win >= 0);
    test.ok(candidate.healing_credits_per_win >= candidate.average_healing_cost);
    test.ok(candidate.exploitability >= 0 && candidate.exploitability <= 0.5);
    test.ok(candidate.limiting_opponents.length > 0);
    test.ok(Math.abs(
      analysis.score_matrix[player].reduce(function(sum, score) { return sum + score; }, 0) /
        analysis.candidate_count - candidate.average_score
    ) < 1e-12);
    let total_wins = analysis.win_probability_matrix[player].reduce(function(sum, wins) {
      return sum + wins;
    }, 0);
    let expected_win_healing_cost = analysis.win_healing_cost_matrix[player].reduce(
      function(sum, cost, opponent) {
        return sum + (cost * analysis.win_probability_matrix[player][opponent]);
      }, 0
    ) / total_wins;
    test.ok(Math.abs(
      candidate.average_healing_cost_on_win - expected_win_healing_cost
    ) < 1e-12);
  });

  test.done();
};

exports.testBatchedEquipmentArchiveExpansion = function(test) {
  let kernel = BuildCatalogs[2];
  let expansion = MatchupGame.expandEquipmentArchive(kernel, {
    startBuild: kernel.ControlledKernel,
    beamWidth: 2,
    batchSize: 2,
    maxIterations: 1,
    slots: [ 'weapon1' ],
    itemKeysBySlot: { weapon1: [ 'CrystalSword', 'CrystalSwordT2' ] },
    crystalKeys: [ 'PerfectFire' ],
    minimumSurvivalProbability: 0.01,
  });

  test.equal(expansion.added.length, 1);
  test.equal(expansion.added[0].build.equipment.weapon1.item, 'CrystalSwordT2');
  test.ok(expansion.added[0].score_against_equilibrium > 0.5);
  test.equal(Object.keys(expansion.catalog).length, 2);
  test.deepEqual(expansion.after.inferred_meta.weights, [
    { candidate: 'EndogenousResponse1', weight: 1 },
  ]);
  test.done();
};

exports.testEndogenousEquipmentSearchReusesMatchups = function(test) {
  let kernel = BuildCatalogs[2];
  let checkpoints = [];
  let search = MatchupGame.endogenousEquipmentSearch(kernel, {
    beamWidth: 2,
    batchSize: 2,
    maxRounds: 3,
    attackTypes: [ 'normal' ],
    hpPoints: [ 70 ],
    pointStrides: [ 11 ],
    slots: [ 'weapon1' ],
    itemKeysBySlot: { weapon1: [ 'CrystalSword', 'CrystalSwordT2' ] },
    crystalKeys: [ 'PerfectFire' ],
    minimumSurvivalProbability: 0.01,
    roundOffset: 4,
    onRound: function(checkpoint) { checkpoints.push(checkpoint); },
  });

  test.ok(search.converged);
  test.equal(search.rounds.length, 3);
  test.deepEqual(search.rounds.map(function(round) { return round.round; }), [ 5, 6, 7 ]);
  test.deepEqual(checkpoints.map(function(checkpoint) {
    return checkpoint.round.round;
  }), [ 5, 6, 7 ]);
  test.equal(checkpoints[0].converged, false);
  test.equal(checkpoints[2].converged, true);
  test.equal(search.rounds[0].added.length, 1);
  test.equal(search.rounds[1].added.length, 1);
  test.equal(search.rounds[2].added.length, 0);
  test.equal(
    search.rounds[0].added[0].concept_signature,
    search.rounds[1].added[0].concept_signature
  );
  test.notDeepEqual(search.rounds[0].added[0].build.stats, search.rounds[1].added[0].build.stats);
  test.ok(search.caches.catalog_matchups.hits > 0);
  test.ok(search.caches.stat_searches.hits > 0);
  test.equal(Object.keys(search.catalog).length, 3);
  test.done();
};

exports.testCatalogIntegration = function(test) {
  let player = Player.generatePlayer(
    'Catalog Player',
    {},
    [
      Item.DarkLegionArmor.socket([ Item.AbyssCrystal ]),
      Item.RiftGun.socket([ Item.PerfectFire ]),
      Item.CoreStaff.socket([ Item.PerfectAir ]),
      Item.BioSpinalEnhancer.socket([ Item.CorruptedPink ]),
      Item.ScoutDrones.socket([ Item.YellowInferno ]),
    ]
  );

  let expectedStats = {
    name: 'Catalog Player',
    level: 80,
    max_hp: 0,
    armor: 69,
    speed: 197,
    accuracy: 179,
    dodge: 100,
    melee_skill: 315,
    gun_skill: 265,
    proj_skill: 128,
    def_skill: 229,
    weapon1: {
      type: 'gun',
      skill: 'gun_skill',
      min_damage: 66,
      max_damage: 72,
    },
    weapon2: {
      type: 'melee',
      skill: 'melee_skill',
      min_damage: 50,
      max_damage: 60,
    },
  };

  testDeepEqualWithDiff(test, player, expectedStats);
  test.done();
};
