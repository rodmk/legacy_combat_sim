/*eslint-env node*/
'use strict';

let src = require('../combatsim');
let build = src.Build.ControlledKernel;
let opponent = src.Player.generateBuild(build);
let widths = [ 8 ];
let tolerances = (process.env.SEARCH_TOLERANCES || '0.001').split(',').map(Number);
let progressive_combat_fidelity = process.env.PROGRESSIVE_COMBAT_FIDELITY !== 'false';
let expansion_width = Number(process.env.EXPANSION_WIDTH || 2);

let results = widths.flatMap(function(width) {
  return tolerances.map(function(tolerance) {
    src.BuildSearch.itemVariantReportCache.clear();
    let response = src.MatchupGame.jointEquipmentStatResponseBeam(
    build,
    [ opponent ],
    [ 'ControlledKernel' ],
    [ 1 ],
    [ 'normal', 'quick', 'aimed', 'cover' ],
      {
        beamWidth: width,
        expansionWidth: expansion_width,
        improvementTolerance: tolerance,
        minimumSurvivalProbability: 1e-6,
        progressiveCombatFidelity: progressive_combat_fidelity,
      }
  );
    return {
      beam_width: width,
      expansion_width: expansion_width,
      improvement_tolerance: tolerance,
      progressive_combat_fidelity: progressive_combat_fidelity,
      returned_responses: response.beam.length,
      iterations: response.iterations.length,
      converged: response.converged,
      convergence_reason: response.convergence_reason,
      timings_ms: response.timings_ms,
      equipment_best_score: response.equipment_response.beam[0].best_response.weighted_score,
      joint_best_score: response.beam[0].weighted_score,
      joint_best_stats: response.beam[0].build.stats,
      joint_best_attack_type: response.beam[0].build.attack_type,
      joint_best_equipment: response.beam[0].build.equipment,
      stat_candidates: response.beam.reduce(function(sum, entry) {
        return sum + entry.stat_search.search_candidate_count;
      }, 0),
      exact_stat_finalists: response.beam.reduce(function(sum, entry) {
        return sum + entry.stat_search.exact_finalist_count;
      }, 0),
      passes: response.iterations.map(function(iteration) {
        return {
          iteration: iteration.iteration,
          stat_fidelity: iteration.stat_fidelity,
          expanded_seeds: iteration.expanded_seed_count,
          equipment_candidates: iteration.equipment_candidate_count,
          equipment_finalists: iteration.equipment_finalist_count,
          equipment_concepts: iteration.equipment_concept_count,
          equipment_combat_signatures: iteration.equipment_combat_signature_count,
          stat_candidates: iteration.stat_candidate_count,
          exact_stat_finalists: iteration.exact_stat_finalist_count,
          improvement: iteration.improvement,
          timings_ms: iteration.timings_ms,
          equipment_profile_ms: iteration.equipment_profile_ms,
          stat_profile_ms: iteration.stat_profile_ms,
        };
      }),
    };
  });
});

console.log(JSON.stringify(results, null, 2));
