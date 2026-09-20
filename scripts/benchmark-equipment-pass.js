/*eslint-env node*/
'use strict';

let path = require('path');
let sqlite = require('node:sqlite');
let src = require('../combatsim');

let database_path = process.env.SEARCH_DB || path.join('.local', 'meta-search.sqlite');
let progressive = process.env.PROGRESSIVE_COMBAT_FIDELITY !== 'false';
let screening_survival_probability = Number(
  process.env.SCREENING_MINIMUM_SURVIVAL_PROBABILITY || 0.1
);
let screening_beam_width = Number(process.env.SCREENING_BEAM_WIDTH || 16);
let database = new sqlite.DatabaseSync(database_path, { readOnly: true });
let latest = database.prepare(
  'SELECT catalog_json FROM round ORDER BY number DESC LIMIT 1'
).get();
database.close();
if (!latest) {
  throw new Error('The search database has no completed rounds.');
}

let catalog = JSON.parse(latest.catalog_json);
let analysis = src.MatchupGame.analyzeBuildCatalog(catalog);
let full_equilibrium = analysis.inferred_meta.weights;
let opponent_mixture = src.MatchupGame.pruneOpponentMixture(
  full_equilibrium,
  Number(process.env.OPPONENT_PRUNING_TOLERANCE || 0)
);
let equilibrium = opponent_mixture.retained;
let opponents = equilibrium.map(function(entry) {
  return src.Player.generateBuild(catalog[entry.candidate]);
});
let opponent_ids = equilibrium.map(function(entry) { return entry.candidate; });
let opponent_weights = equilibrium.map(function(entry) { return entry.weight; });
let starting_entry = equilibrium.slice().sort(function(left, right) {
  return right.weight - left.weight;
})[0];
let options = {
  beamWidth: 8,
  minimumSurvivalProbability: 0.01,
};
if (progressive) {
  options.screeningMinimumSurvivalProbability = screening_survival_probability;
  options.screeningBeamWidth = screening_beam_width;
}

let started = Date.now();
let response = src.MatchupGame.equipmentResponseBeam(
  catalog[starting_entry.candidate],
  opponents,
  opponent_ids,
  opponent_weights,
  options
);
let elapsed_ms = Date.now() - started;

console.log(JSON.stringify({
  progressive_combat_fidelity: progressive,
  screening_minimum_survival_probability: screening_survival_probability,
  screening_beam_width: screening_beam_width,
  starting_build: starting_entry.candidate,
  opponent_count: opponents.length,
  dropped_opponents: opponent_mixture.dropped,
  maximum_score_error: opponent_mixture.maximum_score_error,
  opponent_weights: equilibrium,
  candidate_count: response.candidate_count,
  finalist_count: response.finalist_count,
  screening_matchups: response.screening_matchups,
  validation_matchups: response.validation_matchups,
  exact_matchups: response.exact_matchups,
  elapsed_ms: elapsed_ms,
  timings_ms: response.timings_ms,
  best_signature: response.beam[0].best_response.signature,
  best_score: response.beam[0].best_response.weighted_score,
  best_build: response.beam[0].best_response.sources[0].build,
  beam: response.beam.map(function(entry) {
    return {
      concept_signature: entry.concept_signature,
      signature: entry.best_response.signature,
      score: entry.best_response.weighted_score,
    };
  }),
}, null, 2));
