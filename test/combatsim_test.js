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

  test.deepEqual(result.outcome, { player1_wins: 1, player2_wins: 0, draws: 0 });
  test.deepEqual(result.player1, {
    wins: 1,
    expected_hp_remaining: 10,
    expected_hp_lost_on_win: 0,
    zero_damage_win_probability: 1,
    expected_hp_lost: 0,
  });
  test.deepEqual(result.player2, {
    wins: 0,
    expected_hp_remaining: 0,
    expected_hp_lost_on_win: null,
    zero_damage_win_probability: null,
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
  test.equal(BuildCatalogs.length, 2);
  test.equal(Object.keys(BuildCatalogs[1]).length, 15);
  test.equal(Object.keys(Build).length, 20);
  test.equal(Player.generateReferencePlayers(BuildCatalogs).length, 19);

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
  test.equal(analysis.score_matrix.length, analysis.candidate_count);
  test.deepEqual(
    analysis.matrix_order,
    analysis.candidates.map(function(candidate) { return candidate.id; })
  );
  analysis.candidates.forEach(function(candidate, player) {
    test.equal(candidate.frontier, candidate.dominated_by.length === 0);
    test.ok(candidate.worst_score <= candidate.average_score);
    test.ok(candidate.average_draw_rate >= 0 && candidate.average_draw_rate <= 1);
    test.ok(candidate.average_hp_lost >= 0);
    test.ok(candidate.average_hp_lost_on_win >= 0);
    test.ok(candidate.average_zero_damage_win_probability >= 0 &&
      candidate.average_zero_damage_win_probability <= 1);
    test.ok(candidate.exploitability >= 0 && candidate.exploitability <= 0.5);
    test.ok(candidate.limiting_opponents.length > 0);
    test.ok(Math.abs(
      analysis.score_matrix[player].reduce(function(sum, score) { return sum + score; }, 0) /
        analysis.candidate_count - candidate.average_score
    ) < 1e-12);
  });

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
