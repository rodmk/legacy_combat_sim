/*eslint-env node*/
'use strict';

let src = require('../combatsim');

let build = src.Build.ShadowDojoDLGunBuild3;
let opponent_keys = [
  'ShadowDojoArmorStackCores',
  'ShadowDojoDLGunBuild3',
  'ShadowDojoHFCoreVoid',
  'ShadowDojoSG1SplitBombs',
];
let opponents = opponent_keys.map(function(key) {
  return src.Player.generateBuild(src.Build[key]);
});
let attack_types = [ 'normal', 'quick', 'aimed', 'cover' ];
let all_speed_points = [];
for (let speed = 2; speed <= 173; speed++) {
  all_speed_points.push(speed);
}
let all_allocations = src.BuildSearch.statAllocationReport(
  build, opponents, attack_types
);
let minimum_hp_allocations = src.BuildSearch.statAllocationReport(
  build, opponents, attack_types, { hpPoints: [ 2 ] }
);
let summarize = function(report, options) {
  let uncompressed_per_attack_type = src.BuildSearch.forEachStatAllocation(
    all_speed_points, options, function() {}
  );
  let compressed = report.reduce(function(sum, entry) {
    return sum + entry.allocations;
  }, 0);
  return {
    uncompressed: uncompressed_per_attack_type * attack_types.length,
    compressed: compressed,
    unique_combat_signatures: report.reduce(function(sum, entry) {
      return sum + entry.unique_combat_signatures;
    }, 0),
    retained_fraction: compressed / (uncompressed_per_attack_type * attack_types.length),
  };
};

console.log(JSON.stringify({
  build: 'ShadowDojoDLGunBuild3',
  opponents: opponent_keys,
  all_summary: summarize(all_allocations, {}),
  minimum_hp_summary: summarize(minimum_hp_allocations, { hpPoints: [ 2 ] }),
  all_allocations: all_allocations,
  minimum_hp_allocations: minimum_hp_allocations,
}, null, 2));
