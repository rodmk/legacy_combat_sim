/*eslint-env node*/
'use strict';

let fs = require('fs');
let path = require('path');
let sqlite = require('node:sqlite');

let database_path = process.env.SEARCH_DB || path.join('.local', 'meta-search.sqlite');
let output_path = process.env.SEARCH_EXPORT;
let report_path = process.env.SEARCH_REPORT;
let database = new sqlite.DatabaseSync(database_path, { readOnly: true });
let search = database.prepare('SELECT * FROM search WHERE id = 1').get();
let rounds = database.prepare('SELECT * FROM round ORDER BY number').all();
if (!search || rounds.length === 0) {
  throw new Error('The search database has no completed rounds.');
}
let latest = rounds[rounds.length - 1];
let builds = JSON.parse(latest.catalog_json);
let report = {
  converged: Boolean(search.converged),
  settings: JSON.parse(search.config_json),
  rounds: rounds.map(function(round) { return JSON.parse(round.report_json); }),
};
let serialized = JSON.stringify(builds, null, 2) + '\n';
if (output_path) {
  fs.mkdirSync(path.dirname(output_path), { recursive: true });
  fs.writeFileSync(output_path, serialized);
  console.log(output_path);
} else {
  process.stdout.write(serialized);
}
if (report_path) {
  fs.mkdirSync(path.dirname(report_path), { recursive: true });
  fs.writeFileSync(report_path, JSON.stringify(report, null, 2) + '\n');
  console.log(report_path);
}
database.close();
