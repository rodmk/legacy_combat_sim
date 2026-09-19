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
let minimum_survival_probability = 1e-6;
let approximate = src.MatchupGame.candidateFrontiers(groups, opponents, opponent_keys, {
  minimumSurvivalProbability: minimum_survival_probability,
});
let finalist_sources = new Set(
  approximate.combat_frontier.concat(approximate.combat_economy_frontier).flatMap(function(candidate) {
    return candidate.sources;
  })
);
let finalists = groups.filter(function(group) {
  return group.sources.some(function(source) { return finalist_sources.has(source); });
});
let result = src.MatchupGame.candidateFrontiers(finalists, opponents, opponent_keys);
let exact_finalist_matchups = result.evaluated_matchups;
let exact_defeat_cache = result.defeat_cache;

result.candidate_count = approximate.candidate_count;
result.evaluated_matchups = approximate.evaluated_matchups;
result.defeat_cache = approximate.defeat_cache;
result.minimum_survival_probability = minimum_survival_probability;
result.exact_finalist_count = finalists.length;
result.exact_finalist_matchups = exact_finalist_matchups;
result.exact_defeat_cache = exact_defeat_cache;

result.elapsed_ms = Date.now() - started;
console.log(JSON.stringify(result, null, 2));
