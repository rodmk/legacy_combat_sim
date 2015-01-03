var src = require('../combatsim.js');
var CombatSim = src.CombatSim;
var Player = src.Player;
var Equipment = src.Equipment;
var Item = src.Item;

var jsondiffpatch = require('jsondiffpatch');

var testDeepEqualWithDiff = function(test, a, b) {
  test.deepEqual(a, b, 'Difference: ' + JSON.stringify(jsondiffpatch.diff(a, b)));
};

exports.testPlayerGeneration = function(test) {
  var test_player = Player.generatePlayer(
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

  var expected_stats = {
    name: 'Test Player',
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
      min_damage: 0,
      max_damage: 0,
    },
    weapon2: {
      type: 'unarmed',
      min_damage: 0,
      max_damage: 0,
    },
  };

  testDeepEqualWithDiff(test, test_player, expected_stats);

  test.done();
};

exports.testNullPlayerGeneration = function(test) {
  var test_player = Player.generatePlayer(
    'Test Player',
    { },
    [ Item.none, Item.none, Item.none, Item.none, Item.none ]
  );

  var expected_stats = {
    name: 'Test Player',
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
      min_damage: 0,
      max_damage: 0,
    },
    weapon2: {
      type: 'unarmed',
      min_damage: 0,
      max_damage: 0,
    },
  };

  testDeepEqualWithDiff(test, test_player, expected_stats);

  test.done();
};

exports.testFullyTrainedPlayerGeneration = function(test) {
  var test_player = Player.generateFullyTrainedPlayer(
    'Test Player',
    { hp: 70, speed: 10, accuracy: 53, dodge: 50 },
    [ Item.none, Item.none, Item.none, Item.none, Item.none ]
  );

  var expected_stats = {
    name: 'Test Player',
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
      min_damage: 5,
      max_damage: 5,
    },
    weapon2: {
      type: 'unarmed',
      min_damage: 5,
      max_damage: 5,
    },
  };

  testDeepEqualWithDiff(test, test_player, expected_stats);

  test.done();
};

exports.testPlayerGenerationWithItem = function(test) {
  var armor = {
    armor:       10,
    dodge:       5,
  };

  var amulet = {
    accuracy:    5,
    dodge:       5,
    def_skill:   20,
    gun_skill:   20,
    melee_skill: 20,
    proj_skill:  20
  };

  var sword = {
    type:        'melee',
    min_damage:  10,
    max_damage:  20,
    accuracy:    10,
    speed:       50,
    melee_skill: 15,
    proj_skill:  5,
    def_skill:   5
  };

  var gun = {
    type:        'gun',
    min_damage:  20,
    max_damage:  30,
    accuracy:    10,
    speed:       50,
    gun_skill:   15,
    proj_skill:  5,
    def_skill:   5
  };

  // Same weapon
  var test_player = Player.generatePlayer(
    'Test Player',
    { },
    [ armor, sword, sword, amulet, amulet ]
  );

  var expected_stats = {
    name: 'Test Player',
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
      min_damage: 10,
      max_damage: 20,
    },
    weapon2: {
      type: 'melee',
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
      min_damage: 10,
      max_damage: 20,
    },
    weapon2: {
      type: 'gun',
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
      min_damage: 15,
      max_damage: 25,
    },
    weapon2: {
      type: 'gun',
      min_damage: 25,
      max_damage: 35,
    },
  };

  testDeepEqualWithDiff(test, test_player, expected_stats);

  test.done();
};

exports.testCrystalSocketing = function(test) {
  var item = new Equipment({
    name:        'item',
    min_damage:  1,
    max_damage:  2,
    armor:       3,
    dodge:       4,
    accuracy:    5,
    speed:       6,
    def_skill:   7,
    melee_skill: 8,
    gun_skill:   9,
    proj_skill:  10,
  });

  var crystal = new Equipment({
    name:             'crystal',
    min_damage_mult:  2,
    max_damage_mult:  2,
    armor_mult:       10,
    dodge_mult:       10,
    accuracy_mult:    10,
    speed_mult:       10,
    def_skill_mult:   100,
    melee_skill_mult: 100,
    gun_skill_mult:   100,
    proj_skill_mult:  100,
  });

  var socketed_item = item.socket([ crystal ]);
  var expected_stats = {
    name:        'item',
    min_damage:  2,
    max_damage:  4,
    armor:       30,
    dodge:       40,
    accuracy:    50,
    speed:       60,
    def_skill:   700,
    melee_skill: 800,
    gun_skill:   900,
    proj_skill:  1000,
    crystals:    [ crystal ]
  };
  testDeepEqualWithDiff(test, socketed_item, expected_stats);

  var socketed_item_2 = item.socket([ crystal, crystal ]);
  var expected_stats_2 = {
    name:        'item',
    min_damage:  4,
    max_damage:  8,
    armor:       300,
    dodge:       400,
    accuracy:    500,
    speed:       600,
    def_skill:   70000,
    melee_skill: 80000,
    gun_skill:   90000,
    proj_skill:  100000,
    crystals:    [ crystal, crystal ]
  };
  testDeepEqualWithDiff(test, socketed_item_2, expected_stats_2);

  test.done();
};
