/*eslint-env node*/
'use strict';

let childProcess = require('child_process');
let src = require('../combatsim');

let profiles = [
  [ 'melee', 'melee' ],
  [ 'gun', 'gun' ],
  [ 'projectile', 'projectile' ],
  [ 'melee', 'gun' ],
  [ 'melee', 'projectile' ],
  [ 'gun', 'projectile' ],
];
let profile_key = process.env.CENSUS_PROFILE;

let memory = function() {
  let usage = process.memoryUsage();
  return {
    heap_used_mb: Math.round(usage.heapUsed / 1048576),
    rss_mb: Math.round(usage.rss / 1048576),
  };
};

let strongestEffect = function(groups) {
  let score = function(group) {
    return group.effect.stats.reduce(function(sum, stat) {
      return sum + stat[1];
    }, 0) + group.effect.weapons.reduce(function(sum, weapon) {
      return sum + weapon[1] + weapon[2];
    }, 0);
  };
  return groups.reduce(function(best, group) {
    return !best || score(group) > score(best) ? group : best;
  }, null);
};

let summarizePairReport = function(report) {
  return {
    inputs: report.inputs,
    counts: report.counts,
    elapsed_ms: report.elapsed_ms,
  };
};

let conditionalStatExperiment = function(profile, weapons, miscs, armor) {
  let weapon_group = strongestEffect(weapons.nondominated_groups);
  let misc_group = strongestEffect(miscs.nondominated_groups);
  let armor_group = strongestEffect(armor.nondominated_groups);
  let build = src.BuildSearch.buildFromPackage(
    'Census ' + profile.join('+'),
    weapon_group,
    misc_group,
    armor_group,
    src.Build.ControlledKernel.stats
  );
  let opponent_ids = [
    'ShadowDojoDLGunBuild3',
    'ShadowDojoHFCoreVoid',
    'ShadowDojoSG1SplitBombs',
  ];
  let opponents = opponent_ids.map(function(id) {
    return src.Player.generateBuild(src.Build[id]);
  });
  let weights = opponents.map(function() { return 1 / opponents.length; });
  let player = src.Player.generateBuild(build);
  let fixed = src.MatchupGame.candidateFrontiers([ {
    signature: src.CombatSim.combatSignature(player),
    representative: player,
    sources: [ { stats: build.stats, attack_type: build.attack_type } ],
  } ], opponents, opponent_ids, {
    opponentWeights: weights,
    includeCandidates: true,
    trackFrontiers: false,
  }).best_weighted;
  let optimized = src.MatchupGame.adaptiveStatFrontiers(
    build,
    opponents,
    opponent_ids,
    [ 'normal', 'quick', 'aimed', 'cover' ],
    {
      opponentWeights: weights,
      pointStrides: [ 11 ],
      convergeStats: false,
      weightedBestOnly: true,
      minimumSurvivalProbability: 0.01,
    }
  );
  return {
    profile: profile.join('+'),
    equipment: build.equipment,
    fixed: {
      stats: build.stats,
      attack_type: build.attack_type,
      exact_score: fixed.weighted_score,
    },
    conditionally_optimized: {
      stats: optimized.best_weighted.sources[0].stats,
      attack_type: optimized.best_weighted.sources[0].attack_type,
      exact_score: optimized.best_weighted.weighted_score,
      approximate_score: optimized.approximate_best_weighted_score,
      approximate_error_bound: optimized.approximate_best_weighted_error_bound,
      exact_rescore_delta: optimized.best_weighted.weighted_score -
        optimized.approximate_best_weighted_score,
      search_candidate_count: optimized.search_candidate_count,
      exact_finalist_count: optimized.exact_finalist_count,
      elapsed_ms: optimized.timings_ms.total,
    },
    score_improvement: optimized.best_weighted.weighted_score - fixed.weighted_score,
  };
};

if (profile_key) {
  let profile = profile_key.split('+');
  let maximum_comparisons = Number(process.env.MAX_DOMINANCE_COMPARISONS || 5000000);
  let options = { maximumDominanceComparisons: maximum_comparisons };
  let started = Date.now();
  let weapons = src.BuildSearch.weaponPairReport(profile[0], profile[1], options);
  let after_weapons = memory();
  let miscs = src.BuildSearch.miscPairReport(
    Array.from(new Set(profile)).sort(), options
  );
  let after_miscs = memory();
  let armor = src.BuildSearch.armorVariantReport(
    Array.from(new Set(profile)).sort(), options
  );
  let after_armor = memory();
  let package_count = weapons.nondominated_groups.length *
    miscs.nondominated_groups.length * armor.nondominated_groups.length;
  let reachability = null;
  if (profile_key === 'gun+gun') {
    reachability = src.BuildSearch.coordinatedWeaponPair(
      'AlienRifle', 'DoubleBarrelSniperRifle'
    );
  }
  let experiment = conditionalStatExperiment(profile, weapons, miscs, armor);
  let final_memory = memory();
  console.log(JSON.stringify({
    profile: profile_key,
    weapon_pairs: summarizePairReport(weapons),
    misc_pairs: summarizePairReport(miscs),
    armor: {
      counts: armor.counts,
    },
    package_join: {
      retained_cross_product: package_count,
      materialized: false,
    },
    coordinated_reachability: reachability && {
      items: reachability.source.map(function(source) { return source.item; }),
      signature: reachability.signature,
    },
    conditional_stat_experiment: experiment,
    memory: {
      after_weapons: after_weapons,
      after_miscs: after_miscs,
      after_armor: after_armor,
      final: final_memory,
      peak_observed_rss_mb: Math.max(
        after_weapons.rss_mb,
        after_miscs.rss_mb,
        after_armor.rss_mb,
        final_memory.rss_mb
      ),
    },
    elapsed_ms: Date.now() - started,
  }));
} else {
  let started = Date.now();
  let results = profiles.map(function(profile) {
    let result = childProcess.spawnSync(process.execPath, [
      '--max-old-space-size=4096', __filename,
    ], {
      cwd: process.cwd(),
      env: Object.assign({}, process.env, { CENSUS_PROFILE: profile.join('+') }),
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
    if (result.status !== 0) {
      throw new Error(result.stderr || 'Census worker failed for ' + profile.join('+'));
    }
    return JSON.parse(result.stdout);
  });
  let fixed_order = results.slice().sort(function(left, right) {
    return right.conditional_stat_experiment.fixed.exact_score -
      left.conditional_stat_experiment.fixed.exact_score;
  }).map(function(result) { return result.profile; });
  let optimized_order = results.slice().sort(function(left, right) {
    return right.conditional_stat_experiment.conditionally_optimized.exact_score -
      left.conditional_stat_experiment.conditionally_optimized.exact_score;
  }).map(function(result) { return result.profile; });
  let rescore_deltas = results.map(function(result) {
    return Math.abs(
      result.conditional_stat_experiment.conditionally_optimized.exact_rescore_delta
    );
  });
  console.log(JSON.stringify({
    generated_at: new Date().toISOString(),
    profiles: results,
    conditional_stat_summary: {
      fixed_ranking: fixed_order,
      optimized_ranking: optimized_order,
      ranking_changed: JSON.stringify(fixed_order) !== JSON.stringify(optimized_order),
      packages_improved: results.filter(function(result) {
        return result.conditional_stat_experiment.score_improvement > 1e-12;
      }).length,
      maximum_absolute_exact_rescore_delta: Math.max.apply(null, rescore_deltas),
      all_exact_rescores_within_reported_bounds: results.every(function(result) {
        let optimized = result.conditional_stat_experiment.conditionally_optimized;
        return Math.abs(optimized.exact_rescore_delta) <=
          optimized.approximate_error_bound + 1e-12;
      }),
    },
    elapsed_ms: Date.now() - started,
  }, null, 2));
}
