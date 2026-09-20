/*eslint-env node*/
'use strict';

let src = require('../combatsim');
let build = src.Build.ControlledKernel;
let opponent = src.Player.generateBuild(build);
let widths = [ 1, 2, 4, 8 ];

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
      maxIterations: 1,
      minimumSurvivalProbability: 1e-6,
    }
  );
  return {
    beam_width: width,
    returned_responses: response.beam.length,
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
  };
});

console.log(JSON.stringify(results, null, 2));
