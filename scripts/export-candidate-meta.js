/*eslint-env node*/
'use strict';

let fs = require('fs');
let path = require('path');
let sqlite = require('node:sqlite');

let database_path = process.env.CANDIDATE_META_DB ||
  path.join('.local', 'candidate-meta-search.sqlite');
let catalog_path = process.env.CANDIDATE_CATALOG ||
  path.join('data', 'meta-candidate-builds.json');
let builds_path = process.env.CANDIDATE_META_BUILDS ||
  path.join('data', 'meta-equilibrium-builds.json');
let report_path = process.env.CANDIDATE_META_REPORT ||
  path.join('data', 'meta-equilibrium.json');
let database = new sqlite.DatabaseSync(database_path, { readOnly: true });
let search = database.prepare('SELECT * FROM search WHERE id = 1').get();
let rounds = database.prepare('SELECT * FROM round ORDER BY number').all();
if (!search || rounds.length === 0) {
  throw new Error('The candidate meta database has no completed rounds.');
}
let catalog = JSON.parse(fs.readFileSync(catalog_path));
let latest = JSON.parse(rounds[rounds.length - 1].report_json);
let support = latest.opponent_mixture.retained;
let builds = Object.fromEntries(support.map(function(entry) {
  return [ entry.candidate, catalog[entry.candidate] ];
}));
let report = {
  source_build_count: Object.keys(catalog).length,
  unique_combat_candidate_count: JSON.parse(search.config_json).candidate_count,
  active_archive_count: JSON.parse(search.active_ids_json).length,
  completed_rounds: rounds.length,
  converged: Boolean(search.converged),
  response_tolerance: JSON.parse(search.config_json).tolerance,
  support: support,
  dropped_weight: latest.opponent_mixture.dropped_weight,
  best_response_score: latest.best_response_score,
  conservative_exploitability_bound: Math.max(
    0,
    latest.best_response_score - 0.5 + latest.opponent_mixture.maximum_score_error
  ),
};
fs.writeFileSync(builds_path, JSON.stringify(builds, null, 2) + '\n');
fs.writeFileSync(report_path, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ builds: builds_path, report: report_path }));
database.close();
