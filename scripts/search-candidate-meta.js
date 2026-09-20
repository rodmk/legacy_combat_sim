/*eslint-env node*/
'use strict';

let fs = require('fs');
let path = require('path');
let sqlite = require('node:sqlite');
let src = require('../combatsim');

let catalog_path = process.env.CANDIDATE_CATALOG ||
  path.join('data', 'meta-candidate-builds.json');
let database_path = process.env.CANDIDATE_META_DB ||
  path.join('.local', 'candidate-meta-search.sqlite');
let max_rounds = Number(process.env.CANDIDATE_META_ROUNDS || 20);
let batch_size = Number(process.env.CANDIDATE_META_BATCH_SIZE || 2);
let tolerance = Number(process.env.CANDIDATE_META_TOLERANCE || 1e-3);
let opponent_pruning_tolerance = Number(
  process.env.CANDIDATE_META_OPPONENT_PRUNING_TOLERANCE || 5e-3
);
let initial_report_path = process.env.CANDIDATE_META_INITIAL_REPORT;
let catalog = JSON.parse(fs.readFileSync(catalog_path));
let groups_by_signature = new Map();
Object.keys(catalog).sort().forEach(function(id) {
  let build = catalog[id];
  let player = src.Player.generateBuild(build);
  let signature = src.CombatSim.combatSignature(player);
  if (!groups_by_signature.has(signature)) {
    groups_by_signature.set(signature, {
      signature: signature,
      representative: player,
      sources: [],
    });
  }
  groups_by_signature.get(signature).sources.push({ id: id, build: build });
});
let groups = Array.from(groups_by_signature.values());
let group_by_id = new Map();
groups.forEach(function(group) {
  group.sources.forEach(function(source) { group_by_id.set(source.id, group); });
});
let initial_ids;
if (initial_report_path) {
  let initial_report = JSON.parse(fs.readFileSync(initial_report_path));
  initial_ids = initial_report.support.map(function(entry) { return entry.candidate; });
  initial_ids.forEach(function(id) {
    if (!catalog[id]) {
      throw new Error('Candidate catalog is missing initial strategy ' + id + '.');
    }
  });
} else {
  initial_ids = Object.keys(catalog).filter(function(id) {
    return id.endsWith('001');
  });
}
let config = JSON.stringify({
  catalog_path: catalog_path,
  candidate_count: groups.length,
  batch_size: batch_size,
  tolerance: tolerance,
  opponent_pruning_tolerance: opponent_pruning_tolerance,
  initial_report_path: initial_report_path || null,
});

fs.mkdirSync(path.dirname(database_path), { recursive: true });
let database = new sqlite.DatabaseSync(database_path);
database.exec(
  'CREATE TABLE IF NOT EXISTS search (' +
    'id INTEGER PRIMARY KEY CHECK (id = 1), ' +
    'config_json TEXT NOT NULL, ' +
    'active_ids_json TEXT NOT NULL, ' +
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
  throw new Error('Candidate meta settings do not match the checkpoint database.');
}
if (!search) {
  database.prepare(
    'INSERT INTO search (id, config_json, active_ids_json, converged, updated_at) ' +
    'VALUES (1, ?, ?, 0, ?)'
  ).run(config, JSON.stringify(initial_ids), new Date().toISOString());
  search = database.prepare('SELECT * FROM search WHERE id = 1').get();
}
let active_ids = JSON.parse(search.active_ids_json);
let completed_rounds = database.prepare('SELECT COUNT(*) AS count FROM round').get().count;
let approximate_cache = { values: new Map(), hits: 0, misses: 0 };
let exact_cache = { values: new Map(), hits: 0, misses: 0 };
let analysis_cache = { values: new Map(), hits: 0, misses: 0 };
let approximate_defeat_cache = src.CombatSim.createDefeatRoundCache(0.01);
let exact_defeat_cache = src.CombatSim.createDefeatRoundCache();

let activeCatalog = function() {
  return Object.fromEntries(active_ids.map(function(id) { return [ id, catalog[id] ]; }));
};
let candidateGroups = function() {
  let active_signatures = new Set(active_ids.map(function(id) {
    return group_by_id.get(id).signature;
  }));
  return groups.filter(function(group) { return !active_signatures.has(group.signature); });
};

for (let offset = 0; offset < max_rounds && !search.converged; offset++) {
  let started = Date.now();
  let analysis = src.MatchupGame.analyzeBuildCatalog(activeCatalog(), {
    matchupCache: analysis_cache,
  });
  let opponent_mixture = src.MatchupGame.pruneOpponentMixture(
    analysis.inferred_meta.weights, opponent_pruning_tolerance
  );
  let support = opponent_mixture.retained;
  let build_mixture = src.Player.generateBuildMixture(catalog, support);
  let opponents = build_mixture.players;
  let opponent_ids = build_mixture.ids;
  let opponent_weights = build_mixture.weights;
  let candidates = candidateGroups();
  let approximate = src.MatchupGame.candidateFrontiers(
    candidates, opponents, opponent_ids, {
      opponentWeights: opponent_weights,
      defeatCache: approximate_defeat_cache,
      matchupCache: approximate_cache,
      includeCandidates: true,
      trackFrontiers: false,
    }
  );
  let lower_bound = Math.max.apply(null, approximate.candidates.map(function(candidate) {
    return candidate.weighted_score - candidate.weighted_score_error_bound;
  }));
  let finalist_signatures = new Set(approximate.candidates.filter(function(candidate) {
    return candidate.weighted_score + candidate.weighted_score_error_bound >=
      lower_bound - 1e-12;
  }).map(function(candidate) { return candidate.signature; }));
  let finalists = candidates.filter(function(group) {
    return finalist_signatures.has(group.signature);
  });
  let exact = src.MatchupGame.candidateFrontiers(finalists, opponents, opponent_ids, {
    opponentWeights: opponent_weights,
    defeatCache: exact_defeat_cache,
    matchupCache: exact_cache,
    includeCandidates: true,
    trackFrontiers: false,
  });
  let ranked = exact.candidates.slice().sort(function(left, right) {
    return right.weighted_score - left.weighted_score;
  });
  let additions = ranked.filter(function(candidate) {
    return candidate.weighted_score > 0.5 + tolerance;
  }).slice(0, batch_size).map(function(candidate) {
    return {
      id: candidate.sources[0].id,
      score: candidate.weighted_score,
    };
  });
  additions.forEach(function(entry) { active_ids.push(entry.id); });
  let converged = additions.length === 0;
  let round = {
    round: completed_rounds + offset + 1,
    active_count_before: analysis.candidate_count,
    equilibrium: analysis.inferred_meta,
    opponent_mixture: opponent_mixture,
    pool_candidates: candidates.length,
    approximate_matchups: approximate.evaluated_matchups,
    exact_finalists: finalists.length,
    exact_matchups: exact.evaluated_matchups,
    best_response_score: ranked.length === 0 ? 0.5 : ranked[0].weighted_score,
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
      'UPDATE search SET active_ids_json = ?, converged = ?, updated_at = ? WHERE id = 1'
    ).run(JSON.stringify(active_ids), converged ? 1 : 0, now);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  console.log(JSON.stringify(round));
  search.converged = converged ? 1 : 0;
}

console.log(JSON.stringify({
  database: database_path,
  candidate_count: groups.length,
  active_count: active_ids.length,
  completed_rounds: completed_rounds +
    database.prepare('SELECT COUNT(*) AS count FROM round WHERE number > ?').get(
      completed_rounds
    ).count,
  converged: Boolean(search.converged),
}));
database.close();
