/*eslint-env node*/
'use strict';

let src = require('../combatsim.js');
let Player = src.Player;
let Equipment = src.Equipment;
let Item = src.Item;
let WeaponMod = src.WeaponMod;
let Build = src.Build;
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
    faster.speed = slower.speed;
    CombatSim.simulateCombat(slower, faster, 4);
    test.deepEqual(attackers, [ slower, slower, faster, faster ]);
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
