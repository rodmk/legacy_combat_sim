/*eslint-env node*/
'use strict';

let fs = require('fs');
let path = require('path');
let sqlite = require('node:sqlite');
let worker_threads = require('worker_threads');
let src = require('../combatsim');

let equilibrium_builds_path = process.env.CONFIGURATION_META_INITIAL_BUILDS ||
  path.join('data', 'meta-equilibrium-builds.json');
let seed_report_path = process.env.CONFIGURATION_META_SEED_REPORT ||
  path.join('data', 'equipment-configuration-validation.json');
let database_path = process.env.CONFIGURATION_META_DB ||
  path.join('.local', 'configuration-meta-search.sqlite');
let output_path = process.env.CONFIGURATION_META_REPORT;
let max_rounds = Number(process.env.CONFIGURATION_META_ROUNDS || 10);
let batch_size = Number(process.env.CONFIGURATION_META_BATCH_SIZE || 2);
let response_tolerance = Number(process.env.CONFIGURATION_META_TOLERANCE || 1e-3);
let screening_iterations = Number(
  process.env.CONFIGURATION_META_SCREENING_ITERATIONS || 2
);
let confirmation_iterations = Number(
  process.env.CONFIGURATION_META_CONFIRMATION_ITERATIONS || 8
);
let beam_width = Number(process.env.CONFIGURATION_META_BEAM_WIDTH || 4);
let expansion_width = Number(process.env.CONFIGURATION_META_EXPANSION_WIDTH || 1);
let worker_count = Number(process.env.CONFIGURATION_META_WORKERS || 4);
if (!Number.isInteger(worker_count) || worker_count <= 0) {
  throw new Error('Configuration meta worker count must be a positive integer.');
}

let initial_builds = JSON.parse(fs.readFileSync(equilibrium_builds_path));
let seed_report = JSON.parse(fs.readFileSync(seed_report_path));
let seed_build = Object.assign({}, seed_report.best.build, {
  name: 'ConfigurationSeed001',
  reference: false,
});
let initial_catalog = Object.assign({}, initial_builds, {
  ConfigurationSeed001: seed_build,
});
let config = JSON.stringify({
  equilibrium_builds_path: equilibrium_builds_path,
  seed_report_path: seed_report_path,
  batch_size: batch_size,
  response_tolerance: response_tolerance,
  screening_iterations: screening_iterations,
  confirmation_iterations: confirmation_iterations,
  beam_width: beam_width,
  expansion_width: expansion_width,
});

fs.mkdirSync(path.dirname(database_path), { recursive: true });
let database = new sqlite.DatabaseSync(database_path);
database.exec(
  'CREATE TABLE IF NOT EXISTS search (' +
    'id INTEGER PRIMARY KEY CHECK (id = 1), ' +
    'config_json TEXT NOT NULL, ' +
    'catalog_json TEXT NOT NULL, ' +
    'converged INTEGER NOT NULL DEFAULT 0, ' +
    'updated_at TEXT NOT NULL' +
  ');' +
  'CREATE TABLE IF NOT EXISTS round (' +
    'number INTEGER PRIMARY KEY, ' +
    'report_json TEXT NOT NULL, ' +
    'completed_at TEXT NOT NULL' +
  ');'
);
let search = database.prepare('SELECT * FROM search WHERE id = 1').get();
if (search && search.config_json !== config) {
  throw new Error('Configuration meta settings do not match the checkpoint database.');
}
if (!search) {
  database.prepare(
    'INSERT INTO search (id, config_json, catalog_json, converged, updated_at) ' +
    'VALUES (1, ?, ?, 0, ?)'
  ).run(config, JSON.stringify(initial_catalog), new Date().toISOString());
  search = database.prepare('SELECT * FROM search WHERE id = 1').get();
}
let catalog = JSON.parse(search.catalog_json);
let completed_rounds = database.prepare('SELECT COUNT(*) AS count FROM round').get().count;
let analysis_cache = { values: new Map(), hits: 0, misses: 0 };

let supportedSeeds = function(analysis, mixture) {
  let by_equipment = new Map();
  mixture.ids.forEach(function(id) {
    let build = catalog[id];
    let signature = src.BuildSearch.equipmentSignature(build.equipment);
    let weight = analysis.inferred_meta.weights.find(function(entry) {
      return entry.candidate === id;
    }).weight;
    let existing = by_equipment.get(signature);
    if (!existing || weight > existing.weight) {
      by_equipment.set(signature, { id: id, build: build, weight: weight });
    }
  });
  return Array.from(by_equipment.values());
};

let searchResponse = function(seed, catalog, support, maximum_iterations) {
  return new Promise(function(resolve, reject) {
    let worker = new worker_threads.Worker(
      path.join(__dirname, 'search-configuration-response-worker.js'),
      { workerData: {
        seed: seed,
        catalog: catalog,
        support: support,
        options: {
          beamWidth: beam_width,
          expansionWidth: expansion_width,
          jointMaxIterations: maximum_iterations,
          improvementTolerance: response_tolerance,
          minimumSurvivalProbability: 0.01,
          screeningMinimumSurvivalProbability: 0.1,
        },
      } }
    );
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', function(code) {
      if (code !== 0) {
        reject(new Error('Configuration response worker exited with code ' + code + '.'));
      }
    });
  });
};

let searchResponses = function(seeds, catalog, support, maximum_iterations) {
  let responses = [];
  let runBatch = function(offset) {
    if (offset >= seeds.length) {
      return Promise.resolve(responses);
    }
    let batch = seeds.slice(offset, offset + worker_count);
    return Promise.all(batch.map(function(seed) {
      return searchResponse(seed, catalog, support, maximum_iterations);
    })).then(function(batch_responses) {
      responses = responses.concat.apply(responses, batch_responses);
      return runBatch(offset + worker_count);
    });
  };
  return runBatch(0);
};

let novelProfitableResponses = function(responses, active_signatures) {
  let by_signature = new Map();
  responses.forEach(function(response) {
    let signature = src.CombatSim.combatSignature(src.Player.generateBuild(response.build));
    if (response.score <= 0.5 + response_tolerance || active_signatures.has(signature)) {
      return;
    }
    let existing = by_signature.get(signature);
    if (!existing || response.score > existing.score) {
      by_signature.set(signature, response);
    }
  });
  return Array.from(by_signature.values()).sort(function(left, right) {
    return right.score - left.score;
  });
};

let finish = function() {
  let rounds = database.prepare('SELECT report_json FROM round ORDER BY number').all().map(
    function(row) { return JSON.parse(row.report_json); }
  );
  let output = {
    settings: JSON.parse(config),
    catalog: catalog,
    rounds: rounds,
    converged: Boolean(search.converged),
  };
  if (output_path) {
    fs.writeFileSync(output_path, JSON.stringify(output, null, 2) + '\n');
  }
  console.log(JSON.stringify({
    database: database_path,
    candidate_count: Object.keys(catalog).length,
    completed_rounds: rounds.length,
    converged: Boolean(search.converged),
  }));
  database.close();
};

let runRound = function(offset) {
  if (offset >= max_rounds || search.converged) {
    finish();
    return Promise.resolve();
  }
  let started = Date.now();
  let analysis = src.MatchupGame.analyzeBuildCatalog(catalog, {
    matchupCache: analysis_cache,
  });
  let retained = src.MatchupGame.pruneOpponentMixture(
    analysis.inferred_meta.weights, 5e-3
  ).retained;
  let mixture = src.Player.generateBuildMixture(catalog, retained);
  let seeds = supportedSeeds(analysis, mixture);
  return searchResponses(seeds, catalog, retained, screening_iterations).then(
    function(responses) {
      let active_signatures = new Set(Object.keys(catalog).map(function(id) {
        return src.CombatSim.combatSignature(src.Player.generateBuild(catalog[id]));
      }));
      let profitable = novelProfitableResponses(responses, active_signatures);
      let confirmation_promise = profitable.length === 0 ?
        searchResponses(seeds, catalog, retained, confirmation_iterations) :
        Promise.resolve([]);
      return confirmation_promise.then(function(confirmation) {
        if (confirmation.length > 0) {
          profitable = novelProfitableResponses(confirmation, active_signatures);
        }
        let response_index = Object.keys(catalog).reduce(function(maximum, id) {
          let match = /^ConfigurationResponse(\d+)$/.exec(id);
          return match ? Math.max(maximum, Number(match[1])) : maximum;
        }, 0);
        let additions = profitable.slice(0, batch_size).map(function(response, index) {
          let id = 'ConfigurationResponse' +
            String(response_index + index + 1).padStart(3, '0');
          catalog[id] = Object.assign({}, response.build, { name: id, reference: false });
          return { id: id, seed: response.seed, score: response.score };
        });
        let converged = additions.length === 0;
        let round = {
          round: completed_rounds + offset + 1,
          candidate_count_before: analysis.candidate_count,
          equilibrium: analysis.inferred_meta,
          support: retained,
          equipment_signatures: seeds.length,
          screening_responses: responses,
          confirmation_responses: confirmation,
          additions: additions,
          elapsed_ms: Date.now() - started,
          converged: converged,
        };
        let now = new Date().toISOString();
        database.exec('BEGIN');
        try {
          database.prepare(
            'INSERT INTO round (number, report_json, completed_at) VALUES (?, ?, ?)'
          ).run(round.round, JSON.stringify(round), now);
          database.prepare(
            'UPDATE search SET catalog_json = ?, converged = ?, updated_at = ? WHERE id = 1'
          ).run(JSON.stringify(catalog), converged ? 1 : 0, now);
          database.exec('COMMIT');
        } catch (error) {
          database.exec('ROLLBACK');
          throw error;
        }
        console.log(JSON.stringify(round));
        search.converged = converged ? 1 : 0;
        return runRound(offset + 1);
      });
    }
  );
};

runRound(0).catch(function(error) {
  database.close();
  console.error(error.stack || error);
  process.exitCode = 1;
});
