/*eslint-env node*/
'use strict';

let fs = require('fs');
let path = require('path');
let src = require('../combatsim');

let equilibrium_builds_path = process.env.CONFIGURATION_EQUILIBRIUM_BUILDS ||
  path.join('data', 'meta-equilibrium-builds.json');
let equilibrium_report_path = process.env.CONFIGURATION_EQUILIBRIUM_REPORT ||
  path.join('data', 'meta-equilibrium.json');
let seed_catalog_path = process.env.CONFIGURATION_SEED_CATALOG;
let validation_report_path = process.env.CONFIGURATION_VALIDATION_REPORT;
let requested_ids = process.env.CONFIGURATION_SEED_IDS;
let beam_width = Number(process.env.CONFIGURATION_BEAM_WIDTH || 4);
let expansion_width = Number(process.env.CONFIGURATION_EXPANSION_WIDTH || 2);
let maximum_iterations = Number(process.env.CONFIGURATION_MAX_ITERATIONS || 4);
let output_path = process.env.CONFIGURATION_REPORT;

let equilibrium_builds = JSON.parse(fs.readFileSync(equilibrium_builds_path));
let equilibrium_report = JSON.parse(fs.readFileSync(equilibrium_report_path));
let mixture = src.Player.generateBuildMixture(
  equilibrium_builds, equilibrium_report.support
);
let seeds;
if (validation_report_path) {
  let validation = JSON.parse(fs.readFileSync(validation_report_path));
  seeds = [ [ validation.best.seed, validation.best.build ] ];
} else {
  let seed_catalog = JSON.parse(fs.readFileSync(
    seed_catalog_path || equilibrium_builds_path
  ));
  let ids = requested_ids ? requested_ids.split(',') : Object.keys(seed_catalog).sort();
  seeds = ids.map(function(id) {
    if (!seed_catalog[id]) {
      throw new Error('Unknown configuration seed: ' + id + '.');
    }
    return [ id, seed_catalog[id] ];
  });
}

let results = seeds.map(function(seed) {
  let started = Date.now();
  let response = src.MatchupGame.fixedEquipmentConfigurationResponse(
    seed[1],
    mixture.players,
    mixture.ids,
    mixture.weights,
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
    seed: seed[0],
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
  equilibrium: equilibrium_report.support,
  results: results,
  best: results.slice().sort(function(left, right) { return right.score - left.score; })[0],
};
if (output_path) {
  fs.writeFileSync(output_path, JSON.stringify(output, null, 2) + '\n');
}
console.log(JSON.stringify(output, null, 2));
