/*eslint-env node*/
'use strict';

let worker_threads = require('worker_threads');
let src = require('../combatsim');

let input = worker_threads.workerData;
let started = Date.now();
let mixture = src.Player.generateBuildMixture(input.catalog, input.support);
let response = src.MatchupGame.fixedEquipmentConfigurationResponse(
  input.seed.build,
  mixture.players,
  mixture.ids,
  mixture.weights,
  [ 'normal', 'quick', 'aimed', 'cover' ],
  input.options
);
let elapsed_ms = Date.now() - started;
worker_threads.parentPort.postMessage(response.beam.map(function(entry, index) {
  return {
    seed: input.seed.id,
    rank: index + 1,
    score: entry.weighted_score,
    build: entry.build,
    converged: response.converged,
    convergence_reason: response.convergence_reason,
    iterations: response.iterations.length,
    timings_ms: response.timings_ms,
    elapsed_ms: elapsed_ms,
  };
}));
