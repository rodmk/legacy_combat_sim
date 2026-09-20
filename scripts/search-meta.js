/*eslint-env node*/
'use strict';

let fs = require('fs');
let path = require('path');
let sqlite = require('node:sqlite');
let src = require('../combatsim');
let kernel = require('../data/kernel-builds.json');

let database_path = process.env.SEARCH_DB || path.join('.local', 'meta-search.sqlite');
let requested_rounds = process.env.SEARCH_ROUNDS === undefined ?
  Infinity : Number(process.env.SEARCH_ROUNDS);
if ((!Number.isInteger(requested_rounds) || requested_rounds <= 0) &&
    requested_rounds !== Infinity) {
  throw new Error('SEARCH_ROUNDS must be a positive integer.');
}

let settings = {
  beamWidth: 8,
  batchSize: 2,
  minimumSurvivalProbability: 0.01,
  attackTypes: [ 'normal', 'quick', 'aimed', 'cover' ],
  improvementTolerance: 1e-3,
};
let config_json = JSON.stringify(settings);
fs.mkdirSync(path.dirname(database_path), { recursive: true });
let database = new sqlite.DatabaseSync(database_path);
database.exec(
  'CREATE TABLE IF NOT EXISTS search (' +
    'id INTEGER PRIMARY KEY CHECK (id = 1), ' +
    'config_json TEXT NOT NULL, ' +
    'converged INTEGER NOT NULL DEFAULT 0, ' +
    'updated_at TEXT NOT NULL' +
  ');' +
  'CREATE TABLE IF NOT EXISTS round (' +
    'number INTEGER PRIMARY KEY, ' +
    'report_json TEXT NOT NULL, ' +
    'catalog_json TEXT NOT NULL, ' +
    'completed_at TEXT NOT NULL' +
  ');'
);
let search = database.prepare('SELECT * FROM search WHERE id = 1').get();
if (search && search.config_json !== config_json) {
  throw new Error('Search settings do not match the existing checkpoint database.');
}
if (!search) {
  database.prepare(
    'INSERT INTO search (id, config_json, converged, updated_at) VALUES (1, ?, 0, ?)'
  ).run(config_json, new Date().toISOString());
  search = database.prepare('SELECT * FROM search WHERE id = 1').get();
}
let saved_rounds = database.prepare('SELECT * FROM round ORDER BY number').all();
let catalog = saved_rounds.length === 0 ? kernel :
  JSON.parse(saved_rounds[saved_rounds.length - 1].catalog_json);

if (search.converged) {
  console.log(JSON.stringify({
    database: database_path,
    converged: true,
    completed_rounds: saved_rounds.length,
    archive_size: Object.keys(catalog).length,
  }));
  database.close();
  process.exit(0);
}

let checkpoint = database.prepare(
  'INSERT INTO round (number, report_json, catalog_json, completed_at) VALUES (?, ?, ?, ?)'
);
let update_search = database.prepare(
  'UPDATE search SET converged = ?, updated_at = ? WHERE id = 1'
);
let result = src.MatchupGame.endogenousEquipmentSearch(catalog, Object.assign({}, settings, {
  maxRounds: requested_rounds,
  roundOffset: saved_rounds.length,
  onRound: function(state) {
    let now = new Date().toISOString();
    database.exec('BEGIN');
    try {
      checkpoint.run(
        state.round.round,
        JSON.stringify(state.round),
        JSON.stringify(state.catalog),
        now
      );
      update_search.run(state.converged ? 1 : 0, now);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    console.log(JSON.stringify({
      round: state.round.round,
      archive_size: Object.keys(state.catalog).length,
      added: state.round.added.map(function(entry) { return entry.id; }),
      support: state.round.equilibrium.weights,
      response_iterations: state.round.response_iterations,
      elapsed_ms: state.round.timings_ms.total,
      converged: state.converged,
    }));
  },
}));

console.log(JSON.stringify({
  database: database_path,
  converged: result.converged,
  completed_rounds: saved_rounds.length + result.rounds.length,
  archive_size: Object.keys(result.catalog).length,
  elapsed_ms: result.elapsed_ms,
}));
database.close();
