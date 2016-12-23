function argmin(arr, fn) {
  var min_key;
  var min_val;

  _.each(arr, function(v, k) {
    v = fn ? fn(v) : v; // apply fn if provided
    if (typeof min_val === "undefined" || v < min_val) {
      min_key = k;
      min_val = v;
    }
  });

  var results = { key: min_key, val: min_val };
  return results;
}

// =============================================================================
//                                 Combat Utils
// =============================================================================
function CombatUtils() {}

CombatUtils.chanceToHit = function(off, def) {
  var off_roll_range = (off + 1) - (off / 4);
  var def_roll_range = (def + 1) - (def / 4);
  var off_def_range = off_roll_range * def_roll_range;

  var pct;
  if (def > off) {
    var off_def_diff_range = Math.max((off + 1) - (def / 4), 0);
    pct = (0.5 * Math.pow(off_def_diff_range, 2)) / off_def_range;
  } else {
    var def_off_diff_range = Math.max((def + 1) - (off / 4), 0);
    pct = (off_def_range - (0.5 * Math.pow(def_off_diff_range, 2))) / off_def_range;
  }

  return pct;
};

CombatUtils.offFromToHit = function(def, pct) {
  var best = argmin(_.range(1, 1000), function(off) {
    return Math.abs(this.chanceToHit(off, def) - pct);
  }.bind(this));
  return best.key;
};

CombatUtils.defFromToHit = function(off, pct) {
  var best = argmin(_.range(1, 1000), function(def) {
    return Math.abs(this.chanceToHit(off, def) - pct);
  }.bind(this));
  return best.key;
};

CombatUtils.averageDamagePerRound = function(att, def, rounds) {
  var w1_damage = 0;
  var w2_damage = 0;

  for (var i = 0; i < rounds; i++) {
    w1_damage += this.attemptHit(att, def, att.weapon1);
    w2_damage += this.attemptHit(att, def, att.weapon2);
  }

  var average_damage = (w1_damage + w2_damage) / rounds;
  return average_damage;
};
