/*eslint-env node*/
'use strict';

let fs = require('fs');
let path = require('path');
let worker_threads = require('worker_threads');
let src = require('../combatsim');

let meta_path = process.env.GLOBAL_CHALLENGE_META ||
  path.join('data', 'configuration-meta.json');
let region_report_path = process.env.GLOBAL_CHALLENGE_REGIONS;
if (!region_report_path) {
  throw new Error('GLOBAL_CHALLENGE_REGIONS is required.');
}
let output_path = process.env.GLOBAL_CHALLENGE_REPORT;
let catalog_output_path = process.env.GLOBAL_CHALLENGE_CATALOG;
let source_report_path = process.env.GLOBAL_CHALLENGE_SOURCE_REPORT;
let leaders_per_profile = Number(process.env.GLOBAL_CHALLENGE_LEADERS || 1);
let batch_size = Number(process.env.GLOBAL_CHALLENGE_BATCH_SIZE || 2);
let worker_count = Number(process.env.GLOBAL_CHALLENGE_WORKERS || 4);
let maximum_iterations = Number(process.env.GLOBAL_CHALLENGE_ITERATIONS || 8);
let tolerance = Number(process.env.GLOBAL_CHALLENGE_TOLERANCE || 1e-3);

let meta = JSON.parse(fs.readFileSync(meta_path));
let region_report = JSON.parse(fs.readFileSync(region_report_path));
let support = meta.final_support || meta.rounds[meta.rounds.length - 1].support;
let seeds_by_equipment = new Map();
region_report.profiles.forEach(function(profile) {
  profile.configured_proxy_screen.leaders.slice(0, leaders_per_profile).forEach(
    function(leader, index) {
      let signature = src.BuildSearch.equipmentSignature(leader.build.equipment);
      if (!seeds_by_equipment.has(signature)) {
        seeds_by_equipment.set(signature, {
          id: 'Global' + profile.profile.split('+').map(function(type) {
            return type[0].toUpperCase() + type.slice(1);
          }).join('') + String(index + 1).padStart(2, '0'),
          build: leader.build,
          profile: profile.profile,
          proxy_score: leader.score,
        });
      }
    }
  );
});
let seeds = Array.from(seeds_by_equipment.values());

let searchSeed = function(seed) {
  return new Promise(function(resolve, reject) {
    let worker = new worker_threads.Worker(
      path.join(__dirname, 'search-configuration-response-worker.js'),
      { workerData: {
        seed: seed,
        catalog: meta.catalog,
        support: support,
        options: {
          beamWidth: 4,
          expansionWidth: 1,
          jointMaxIterations: maximum_iterations,
          improvementTolerance: tolerance,
          minimumSurvivalProbability: 0.01,
          screeningMinimumSurvivalProbability: 0.1,
        },
      } }
    );
    worker.once('message', function(responses) {
      resolve({ seed: seed, responses: responses });
    });
    worker.once('error', reject);
    worker.once('exit', function(code) {
      if (code !== 0) {
        reject(new Error('Global challenge worker exited with code ' + code + '.'));
      }
    });
  });
};

let searchSeeds = function(offset, results) {
  if (offset >= seeds.length) {
    return Promise.resolve(results);
  }
  let batch = seeds.slice(offset, offset + worker_count);
  return Promise.all(batch.map(searchSeed)).then(function(batch_results) {
    return searchSeeds(offset + worker_count, results.concat(batch_results));
  });
};

let started = Date.now();
let source_report = source_report_path ? JSON.parse(fs.readFileSync(source_report_path)) : null;
let results_promise = source_report ? Promise.resolve(source_report.results) : searchSeeds(0, []);
results_promise.then(function(results) {
  let active_signatures = new Set(Object.keys(meta.catalog).map(function(id) {
    return src.CombatSim.combatSignature(src.Player.generateBuild(meta.catalog[id]));
  }));
  let responses_by_signature = new Map();
  results.forEach(function(result) {
    result.responses.forEach(function(response) {
      let signature = src.CombatSim.combatSignature(src.Player.generateBuild(response.build));
      if (active_signatures.has(signature)) {
        return;
      }
      let existing = responses_by_signature.get(signature);
      let candidate = Object.assign({}, response, {
        profile: result.seed.profile,
        proxy_score: result.seed.proxy_score,
      });
      if (!existing || candidate.score > existing.score) {
        responses_by_signature.set(signature, candidate);
      }
    });
  });
  let ranked = Array.from(responses_by_signature.values()).sort(function(left, right) {
    return right.score - left.score;
  });
  let profitable = ranked.filter(function(response) {
    return response.score > 0.5 + tolerance;
  });
  let profitable_by_equipment = new Map();
  profitable.forEach(function(response) {
    let signature = src.BuildSearch.equipmentSignature(response.build.equipment);
    if (!profitable_by_equipment.has(signature)) {
      profitable_by_equipment.set(signature, response);
    }
  });
  let admitted = Array.from(profitable_by_equipment.values()).slice(0, batch_size);
  let challenger_catalog = {};
  admitted.forEach(function(response, index) {
    let id = 'GlobalChallenge' + String(index + 1).padStart(3, '0');
    challenger_catalog[id] = Object.assign({}, response.build, {
      name: id,
      reference: false,
    });
    response.id = id;
  });
  let output = {
    meta: meta_path,
    regions: region_report_path,
    support: support,
    seed_count: seeds.length,
    seeds: seeds,
    results: results,
    profitable: profitable,
    admitted: admitted,
    challenger_catalog: challenger_catalog,
    elapsed_ms: source_report ? source_report.elapsed_ms : Date.now() - started,
  };
  if (output_path) {
    fs.writeFileSync(output_path, JSON.stringify(output, null, 2) + '\n');
  }
  if (catalog_output_path) {
    fs.writeFileSync(
      catalog_output_path, JSON.stringify(challenger_catalog, null, 2) + '\n'
    );
  }
  console.log(JSON.stringify({
    seed_count: seeds.length,
    profitable_count: profitable.length,
    admitted_count: Object.keys(challenger_catalog).length,
    best_score: ranked.length === 0 ? null : ranked[0].score,
    elapsed_ms: output.elapsed_ms,
  }));
}).catch(function(error) {
  console.error(error.stack || error);
  process.exitCode = 1;
});
