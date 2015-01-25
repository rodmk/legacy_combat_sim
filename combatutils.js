function optimizeWinRate(player2) {
  var MAX_STATS = 171; // 3 base + 158 from leveling + 10 from 'Versatility' ability
  var hp_points = 48;
  var speed_points = 0;
  var remaining_points = MAX_STATS - hp_points - speed_points;

  for (var i = 0; i < remaining_points; i++) {
    var accuracy = i;
    var dodge = remaining_points - i;
    var player1 = generatePlayer('test dummy' + ' ' + i, generateFullyTrainedStats(48, 0, dodge, accuracy), [ titan_guard, rift_gun, scythe, prime_amulet, prime_amulet ]);
    displayWinrate(player1, player2);
  }
}

// =========================== Combat Percentages ==============================
function combat_pct(off, def) {
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
}

function off_from_pct(def, pct) {
  var best = argmin(_.range(1, 1000), function(off) {
    return Math.abs(combat_pct(off, def) - pct);
  });
  return best.key;
}

function def_from_pct(off, pct) {
  var best = argmin(_.range(1, 1000), function(def) {
    return Math.abs(combat_pct(off, def) - pct);
  });
  return best.key;
}

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


function logStatRatioStats() {
  var pct = 0;
  var prev_pct = 0;
  for (var i = 0; i <= 200; i += 5) {
    prev_pct = pct;
    pct = combat_pct(i, 100);
    var ratio = i/100;

    console.log(
      'Stat ratio: ' + parseFloat(ratio).toFixed(2) + ' ' +
      'Chance to hit: ' + parseFloat(pct).toFixed(3) + ' ' +
      'Marginal difference: ' + parseFloat(pct - prev_pct).toFixed(3)
    );
  }
}
