/*eslint-env node*/
'use strict';

let child_process = require('child_process');
let fs = require('fs');
let path = require('path');

let initial_report_path = process.env.GLOBAL_META_LOOP_INITIAL_REPORT ||
  path.join('data', 'configuration-meta.json');
let work_directory = process.env.GLOBAL_META_LOOP_DIRECTORY ||
  path.join('.local', 'global-meta-loop');
let output_path = process.env.GLOBAL_META_LOOP_REPORT;
let maximum_cycles = Number(process.env.GLOBAL_META_LOOP_CYCLES || 10);
let state_path = path.join(work_directory, 'state.json');
if (!Number.isInteger(maximum_cycles) || maximum_cycles <= 0) {
  throw new Error('Global meta loop cycle count must be a positive integer.');
}

fs.mkdirSync(work_directory, { recursive: true });
let state = fs.existsSync(state_path) ? JSON.parse(fs.readFileSync(state_path)) : {
  initial_report: initial_report_path,
  current_report: initial_report_path,
  completed_cycles: [],
  globally_closed: false,
};
if (state.initial_report !== initial_report_path) {
  throw new Error('Global meta loop initial report does not match its checkpoint.');
}

let run = function(script, environment, stdout_path) {
  return new Promise(function(resolve, reject) {
    let output = fs.openSync(stdout_path, 'w');
    let child = child_process.spawn(process.execPath, [ path.join(__dirname, script) ], {
      cwd: process.cwd(),
      env: Object.assign({}, process.env, environment),
      stdio: [ 'ignore', output, 'inherit' ],
    });
    child.once('error', function(error) {
      reject(error);
    });
    child.once('close', function(code) {
      fs.closeSync(output);
      if (code !== 0) {
        reject(new Error(script + ' exited with code ' + code + '.'));
        return;
      }
      resolve();
    });
  });
};

let completedFile = function(file) {
  return fs.existsSync(file) && fs.statSync(file).size > 0;
};

let saveState = function() {
  fs.writeFileSync(state_path, JSON.stringify(state, null, 2) + '\n');
};

let finish = function() {
  let report = JSON.parse(fs.readFileSync(state.current_report));
  let cycles = state.completed_cycles.map(function(cycle) {
    let challenge = JSON.parse(fs.readFileSync(cycle.challenge));
    let screening_scores = challenge.screening_results.flatMap(function(result) {
      return result.responses.map(function(response) { return response.score; });
    });
    return {
      cycle: cycle.cycle,
      seed_count: challenge.seed_count,
      promoted_seed_count: challenge.promoted_seed_count,
      admitted_count: cycle.admitted_count,
      best_screening_score: screening_scores.length === 0 ? null :
        Math.max.apply(null, screening_scores),
      screening_promotion_score: challenge.screening_promotion_score,
      admission_score: challenge.admission_score,
      elapsed_ms: challenge.elapsed_ms,
    };
  });
  let output = Object.assign({}, report, {
    global_search: {
      initial_report: state.initial_report,
      completed_cycles: cycles,
      globally_closed: state.globally_closed,
    },
  });
  if (output_path) {
    fs.writeFileSync(output_path, JSON.stringify(output, null, 2) + '\n');
  }
  console.log(JSON.stringify({
    report: state.current_report,
    completed_cycles: state.completed_cycles.length,
    globally_closed: state.globally_closed,
  }));
};

let runCycle = function() {
  if (state.globally_closed || state.completed_cycles.length >= maximum_cycles) {
    finish();
    return Promise.resolve();
  }
  let cycle = state.completed_cycles.length + 1;
  let prefix = path.join(work_directory, 'cycle-' + String(cycle).padStart(2, '0'));
  let regions_path = prefix + '-regions.json';
  let challenge_path = prefix + '-challenge.json';
  let challengers_path = prefix + '-challengers.json';
  let meta_path = prefix + '-meta.json';
  let database_path = prefix + '-meta.sqlite';

  let region_promise = completedFile(regions_path) ? Promise.resolve() :
    run('analyze-attainable-regions.js', {
      REGION_OPPONENT_CATALOG: state.current_report,
      REGION_OPPONENT_REPORT: state.current_report,
    }, regions_path);
  return region_promise.then(function() {
    return completedFile(challenge_path) && completedFile(challengers_path) ?
      Promise.resolve() : run('search-global-meta-challenge.js', {
        GLOBAL_CHALLENGE_META: state.current_report,
        GLOBAL_CHALLENGE_REGIONS: regions_path,
        GLOBAL_CHALLENGE_REPORT: challenge_path,
        GLOBAL_CHALLENGE_CATALOG: challengers_path,
      }, prefix + '-challenge.log');
  }).then(function() {
    let challenge = JSON.parse(fs.readFileSync(challenge_path));
    let admitted_count = Object.keys(challenge.challenger_catalog).length;
    if (admitted_count === 0) {
      state.completed_cycles.push({
        cycle: cycle,
        input_report: state.current_report,
        regions: regions_path,
        challenge: challenge_path,
        admitted_count: 0,
      });
      state.globally_closed = true;
      saveState();
      return;
    }
    let meta_promise = completedFile(meta_path) ? Promise.resolve() :
      run('search-configuration-meta.js', {
        CONFIGURATION_META_INITIAL_REPORT: state.current_report,
        CONFIGURATION_META_EXTRA_CATALOG: challengers_path,
        CONFIGURATION_META_DB: database_path,
        CONFIGURATION_META_REPORT: meta_path,
      }, prefix + '-meta.log');
    return meta_promise.then(function() {
      state.completed_cycles.push({
        cycle: cycle,
        input_report: state.current_report,
        regions: regions_path,
        challenge: challenge_path,
        admitted_count: admitted_count,
        output_report: meta_path,
      });
      state.current_report = meta_path;
      saveState();
    });
  }).then(runCycle);
};

runCycle().catch(function(error) {
  console.error(error.stack || error);
  process.exitCode = 1;
});
