/*eslint-env node*/
'use strict';

let src = require('../combatsim');
let kernel = require('../data/kernel-builds.json');
let result = src.MatchupGame.endogenousEquipmentSearch(kernel, {
  beamWidth: 8,
  batchSize: 8,
  maxRounds: Number(process.env.SEARCH_ROUNDS || 2),
  minimumSurvivalProbability: 0.01,
});

console.log(JSON.stringify({
  initial_archive_size: Object.keys(kernel).length,
  expanded_archive_size: Object.keys(result.catalog).length,
  converged: result.converged,
  rounds: result.rounds,
  caches: result.caches,
  elapsed_ms: result.elapsed_ms,
}, null, 2));
