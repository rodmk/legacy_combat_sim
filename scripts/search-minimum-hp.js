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
let started = Date.now();
let groups = src.BuildSearch.statAllocationGroups(
  build,
  opponents,
  [ 'normal', 'quick', 'aimed', 'cover' ],
  { hpPoints: [ 2 ] }
);
let result = src.MatchupGame.candidateFrontiers(groups, opponents, opponent_keys);

result.elapsed_ms = Date.now() - started;
console.log(JSON.stringify(result, null, 2));
