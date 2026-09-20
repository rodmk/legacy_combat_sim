/*eslint-env node*/
'use strict';

let fs = require('fs');
let src = require('../combatsim');

let builds = require('../data/meta-equilibrium-builds.json');
let report = require('../data/meta-equilibrium.json');
let requested_seed = process.env.META_VALIDATION_SEED;
let beam_width = Number(process.env.META_VALIDATION_BEAM_WIDTH || 8);
let expansion_width = Number(process.env.META_VALIDATION_EXPANSION_WIDTH || 2);
let maximum_iterations = process.env.META_VALIDATION_MAX_ITERATIONS === undefined ?
  Infinity : Number(process.env.META_VALIDATION_MAX_ITERATIONS);
let seeds = requested_seed ? [ requested_seed ] : report.support.map(function(entry) {
  return entry.candidate;
});
let opponent_mixture = src.Player.generateBuildMixture(builds, report.support);
let opponents = opponent_mixture.players;
let opponent_ids = opponent_mixture.ids;
let opponent_weights = opponent_mixture.weights;
let results = seeds.map(function(seed) {
  if (!builds[seed]) {
    throw new Error('Unknown validation seed: ' + seed);
  }
  let started = Date.now();
  let response = src.MatchupGame.jointEquipmentStatResponseBeam(
    builds[seed],
    opponents,
    opponent_ids,
    opponent_weights,
    [ 'normal', 'quick', 'aimed', 'cover' ],
    {
      beamWidth: beam_width,
      expansionWidth: expansion_width,
      jointMaxIterations: maximum_iterations,
      improvementTolerance: 1e-3,
      minimumSurvivalProbability: 0.01,
      screeningMinimumSurvivalProbability: 0.1,
    }
  );
  return {
    seed: seed,
    score: response.beam[0].weighted_score,
    build: response.beam[0].build,
    converged: response.converged,
    convergence_reason: response.convergence_reason,
    iterations: response.iterations.length,
    timings_ms: response.timings_ms,
    elapsed_ms: Date.now() - started,
  };
});
let output = {
  equilibrium: report.support,
  results: results,
  best: results.slice().sort(function(left, right) { return right.score - left.score; })[0],
};
let output_path = process.env.META_VALIDATION_REPORT;
if (output_path) {
  fs.writeFileSync(output_path, JSON.stringify(output, null, 2) + '\n');
}
console.log(JSON.stringify(output, null, 2));
