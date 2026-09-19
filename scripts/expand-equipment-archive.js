/*eslint-env node*/
'use strict';

let src = require('../combatsim');
let kernel = require('../data/kernel-builds.json');
let result = src.MatchupGame.expandEquipmentArchive(kernel, {
  startBuild: kernel.ControlledKernel,
  beamWidth: 8,
  batchSize: 8,
  minimumSurvivalProbability: 0.01,
});

console.log(JSON.stringify({
  initial_archive_size: Object.keys(kernel).length,
  added_count: result.added.length,
  expanded_archive_size: Object.keys(result.catalog).length,
  added: result.added,
  initial_equilibrium: result.before.inferred_meta,
  expanded_equilibrium: result.after.inferred_meta,
  search_converged: result.response.converged,
  search_iterations: result.response.iterations.length,
  timings_ms: result.timings_ms,
}, null, 2));
