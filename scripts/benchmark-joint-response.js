/*eslint-env node*/
'use strict';

let src = require('../combatsim');
let build = src.Build.ControlledKernel;
let opponent = src.Player.generateBuild(build);
let widths = [ 8 ];

let results = widths.map(function(width) {
  src.BuildSearch.itemVariantReportCache.clear();
  let response = src.MatchupGame.jointEquipmentStatResponseBeam(
    build,
    [ opponent ],
    [ 'ControlledKernel' ],
    [ 1 ],
    [ 'normal', 'quick', 'aimed', 'cover' ],
    {
      beamWidth: width,
      minimumSurvivalProbability: 1e-6,
    }
  );
  return {
    beam_width: width,
    returned_responses: response.beam.length,
    iterations: response.iterations.length,
    converged: response.converged,
    convergence_reason: response.convergence_reason,
    timings_ms: response.timings_ms,
    equipment_best_score: response.equipment_response.beam[0].best_response.weighted_score,
    joint_best_score: response.beam[0].weighted_score,
    joint_best_stats: response.beam[0].build.stats,
    joint_best_attack_type: response.beam[0].build.attack_type,
    stat_candidates: response.beam.reduce(function(sum, entry) {
      return sum + entry.stat_search.search_candidate_count;
    }, 0),
    exact_stat_finalists: response.beam.reduce(function(sum, entry) {
      return sum + entry.stat_search.exact_finalist_count;
    }, 0),
    passes: response.iterations.map(function(iteration) {
      return {
        iteration: iteration.iteration,
        equipment_candidates: iteration.equipment_candidate_count,
        equipment_finalists: iteration.equipment_finalist_count,
        equipment_concepts: iteration.equipment_concept_count,
        equipment_combat_signatures: iteration.equipment_combat_signature_count,
        stat_cache_hits: iteration.stat_search_cache_hits,
        stat_cache_misses: iteration.stat_search_cache_misses,
        stat_candidates: iteration.stat_candidate_count,
        exact_stat_finalists: iteration.exact_stat_finalist_count,
        improvement: iteration.improvement,
        timings_ms: iteration.timings_ms,
      };
    }),
  };
});

console.log(JSON.stringify(results, null, 2));
