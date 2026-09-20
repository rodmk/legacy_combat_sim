/*eslint-env node*/
'use strict';

let childProcess = require('child_process');
let fs = require('fs');
let path = require('path');
let src = require('../combatsim');

let profiles = [
  [ 'melee', 'melee' ],
  [ 'gun', 'gun' ],
  [ 'projectile', 'projectile' ],
  [ 'melee', 'gun' ],
  [ 'melee', 'projectile' ],
  [ 'gun', 'projectile' ],
];
let profile_key = process.env.REGION_PROFILE;
let dominance_sample_count = Number(process.env.DOMINANCE_SAMPLE_COUNT || 100);
let optimization_sample_count = Number(process.env.OPTIMIZATION_SAMPLE_COUNT || 4);
let screen_promotion_count = Number(process.env.SCREEN_PROMOTION_COUNT || 2);
let second_stage_promotion_count = Number(process.env.SECOND_STAGE_PROMOTION_COUNT || 1);
let global_shortlist_size = Number(process.env.GLOBAL_SHORTLIST_SIZE || 2000);
let bucket_shortlist_size = Number(process.env.BUCKET_SHORTLIST_SIZE || 2);
let second_stage_global_size = Number(process.env.SECOND_STAGE_GLOBAL_SIZE || 125);
let second_stage_bucket_size = Number(process.env.SECOND_STAGE_BUCKET_SIZE || 1);
let opponent_catalog_path = process.env.REGION_OPPONENT_CATALOG ||
  path.join('data', 'kernel-builds.json');
let opponent_report_path = process.env.REGION_OPPONENT_REPORT;

let skill_by_type = {
  melee: 'melee_skill',
  gun: 'gun_skill',
  projectile: 'proj_skill',
};
let attack_multipliers = {
  normal: {},
  quick: { speed: 1.2, accuracy: 0.9, dodge: 0.9 },
  aimed: { speed: 0.9, accuracy: 1.2, dodge: 0.9 },
  cover: { speed: 0.9, accuracy: 0.9, dodge: 1.2 },
};
let screen_stat_templates = [
  { hp: 173, speed: 2, accuracy: 4, dodge: 4 },
  { hp: 145, speed: 2, accuracy: 4, dodge: 32 },
  { hp: 123, speed: 2, accuracy: 4, dodge: 54 },
  { hp: 101, speed: 2, accuracy: 4, dodge: 76 },
  { hp: 70, speed: 2, accuracy: 4, dodge: 107 },
  { hp: 145, speed: 2, accuracy: 32, dodge: 4 },
  { hp: 123, speed: 2, accuracy: 54, dodge: 4 },
  { hp: 101, speed: 2, accuracy: 76, dodge: 4 },
  { hp: 70, speed: 2, accuracy: 107, dodge: 4 },
  { hp: 70, speed: 37, accuracy: 38, dodge: 38 },
];

let loadOpponentMixture = function() {
  let catalog_document = JSON.parse(fs.readFileSync(opponent_catalog_path));
  let catalog = catalog_document.catalog || catalog_document;
  let support;
  if (opponent_report_path) {
    let report = JSON.parse(fs.readFileSync(opponent_report_path));
    support = report.final_support || report.support ||
      report.rounds[report.rounds.length - 1].support;
  } else {
    let ids = Object.keys(catalog).sort();
    support = ids.map(function(id) {
      return { candidate: id, weight: 1 / ids.length };
    });
  }
  return src.Player.generateBuildMixture(catalog, support);
};

let envelopePlayer = function(envelope, stats, attack_type) {
  let multiplier = attack_multipliers[attack_type];
  let player = {
    name: 'Screened ' + attack_type,
    level: 80,
    max_hp: stats.hp * 5,
    armor: 5 + envelope.maximum.armor,
    speed: 50 + (stats.speed * 5) + envelope.maximum.speed,
    accuracy: 10 + stats.accuracy + envelope.maximum.accuracy,
    dodge: 10 + stats.dodge + envelope.maximum.dodge,
    melee_skill: 450 + (envelope.maximum.melee_skill || 0),
    gun_skill: 450 + (envelope.maximum.gun_skill || 0),
    proj_skill: 450 + (envelope.maximum.proj_skill || 0),
    def_skill: 450 + envelope.maximum.def_skill,
  };
  Object.defineProperty(player, 'normal_mode_stats', {
    value: {
      speed: player.speed,
      accuracy: player.accuracy,
      dodge: player.dodge,
    },
    enumerable: false,
  });
  [ 'speed', 'accuracy', 'dodge' ].forEach(function(stat) {
    player[stat] = Math.ceil(player[stat] * (multiplier[stat] || 1));
  });
  envelope.weapons.forEach(function(weapon, index) {
    player['weapon' + (index + 1)] = {
      type: weapon.type,
      skill: skill_by_type[weapon.type],
      min_damage: 5 + weapon.maximum_min_damage,
      max_damage: 5 + weapon.maximum_damage,
    };
  });
  return player;
};

let expectedRoundDamage = function(attacker, defender) {
  return [ attacker.weapon1, attacker.weapon2 ].reduce(function(total, weapon) {
    let hit_probability = src.CombatSim.combatProbability(
      attacker.accuracy, defender.dodge
    ) * src.CombatSim.combatProbability(attacker[weapon.skill], defender.def_skill);
    let mean_damage = src.CombatSim.damageAfterArmor(
      attacker.level, defender.armor, (weapon.min_damage + weapon.max_damage) / 2
    );
    return total + (hit_probability * mean_damage);
  }, 0);
};

let proxyMatchupScore = function(player, opponent) {
  let defending_opponent = src.Player.asDefender(opponent);
  let defending_player = src.Player.asDefender(player);
  let damage = expectedRoundDamage(player, defending_opponent);
  let return_damage = expectedRoundDamage(opponent, defending_player);
  let rounds_to_win = damage > 0 ? defending_opponent.max_hp / damage : Infinity;
  let rounds_to_lose = return_damage > 0 ? defending_player.max_hp / return_damage : Infinity;
  if (rounds_to_win === Infinity && rounds_to_lose === Infinity) {
    return 0.5;
  }
  let margin = Math.log((rounds_to_lose + 0.5) / (rounds_to_win + 0.5));
  if (player.speed > defending_opponent.speed) {
    margin += 0.1;
  } else if (player.speed < defending_opponent.speed) {
    margin -= 0.1;
  }
  return 1 / (1 + Math.exp(-2 * margin));
};

let roleAveragedProxyMatchupScore = function(player, opponent) {
  return (
    proxyMatchupScore(player, opponent) +
    1 - proxyMatchupScore(opponent, player)
  ) / 2;
};

let screenScore = function(envelope, opponents, weights) {
  let best = 0;
  screen_stat_templates.forEach(function(stats) {
    Object.keys(attack_multipliers).forEach(function(attack_type) {
      let player = envelopePlayer(envelope, stats, attack_type);
      let score = opponents.reduce(function(sum, opponent, index) {
        return sum + (weights[index] * roleAveragedProxyMatchupScore(player, opponent));
      }, 0);
      best = Math.max(best, score);
    });
  });
  return best;
};

let configuredProxyScore = function(entry, opponents, weights) {
  let best = null;
  let best_by_attack_type = {};
  let specializations = src.BuildSearch.signatureSpecializations(entry);
  specializations.forEach(function(build) {
    screen_stat_templates.forEach(function(stats) {
      Object.keys(attack_multipliers).forEach(function(attack_type) {
        let candidate = Object.assign({}, build, {
          stats: stats,
          attack_type: attack_type,
        });
        let player = src.Player.generateBuild(candidate);
        let score = opponents.reduce(function(sum, opponent, index) {
          return sum + (
            weights[index] * roleAveragedProxyMatchupScore(player, opponent)
          );
        }, 0);
        if (!best || score > best.score) {
          best = { score: score, build: candidate };
        }
        if (!best_by_attack_type[attack_type] ||
            score > best_by_attack_type[attack_type].score) {
          best_by_attack_type[attack_type] = { score: score, build: candidate };
        }
      });
    });
  });
  return {
    score: best.score,
    build: best.build,
    configurations: Object.keys(best_by_attack_type).map(function(attack_type) {
      return best_by_attack_type[attack_type];
    }),
    specialization_count: specializations.length,
  };
};

let relaxedPlayers = function(envelope) {
  return Object.keys(attack_multipliers).map(function(attack_type) {
    let player = envelopePlayer(envelope, {
      hp: 173,
      speed: 173,
      accuracy: 175,
      dodge: 175,
    }, attack_type);
    player.name = 'Relaxed ' + attack_type;
    return { attack_type: attack_type, player: player };
  });
};

let weightedScore = function(player, opponents, weights, cache) {
  return opponents.reduce(function(score, opponent, index) {
    return score + weights[index] * src.MatchupGame.roleAveragedCandidateMatchup(
      player, opponent, cache
    ).score;
  }, 0);
};

let relaxedBound = function(envelope, opponents, weights) {
  let cache = src.CombatSim.createDefeatRoundCache();
  return relaxedPlayers(envelope).reduce(function(best, entry) {
    return Math.max(best, weightedScore(entry.player, opponents, weights, cache));
  }, 0);
};

let optimizeSignature = function(entry, opponents, opponent_ids, weights) {
  let specializations = src.BuildSearch.signatureSpecializations(entry);
  let best = null;
  let stat_candidates = 0;
  let exact_finalists = 0;
  let started = Date.now();
  specializations.forEach(function(build) {
    let result = src.MatchupGame.adaptiveStatFrontiers(
      build,
      opponents,
      opponent_ids,
      [ 'normal', 'quick', 'aimed', 'cover' ],
      {
        opponentWeights: weights,
        pointStrides: [ 22 ],
        convergeStats: false,
        weightedBestOnly: true,
        minimumSurvivalProbability: 0.01,
      }
    );
    stat_candidates += result.search_candidate_count;
    exact_finalists += result.exact_finalist_count;
    if (!best || result.best_weighted.weighted_score > best.score) {
      best = {
        score: result.best_weighted.weighted_score,
        build: Object.assign({}, build, {
          stats: result.best_weighted.sources[0].stats,
          attack_type: result.best_weighted.sources[0].attack_type,
        }),
      };
    }
  });
  return {
    specialization_count: specializations.length,
    score: best.score,
    build: best.build,
    stat_candidates: stat_candidates,
    exact_finalists: exact_finalists,
    elapsed_ms: Date.now() - started,
  };
};

if (profile_key) {
  let profile = profile_key.split('+');
  let space = src.BuildSearch.equipmentSignatureSpace(profile[0], profile[1]);
  let dominance_entries = src.BuildSearch.sampleEquipmentSignatures(
    profile[0], profile[1], dominance_sample_count
  );
  let envelope_started = Date.now();
  let envelopes = dominance_entries.map(function(entry) {
    return src.BuildSearch.signatureEffectEnvelope(entry);
  });
  let strict_dominance = [];
  envelopes.forEach(function(left, left_index) {
    envelopes.forEach(function(right, right_index) {
      if (left_index !== right_index && src.BuildSearch.envelopeDominates(left, right)) {
        strict_dominance.push({ dominator: left_index, dominated: right_index });
      }
    });
  });
  let dominance_elapsed_ms = Date.now() - envelope_started;
  let opponent_mixture = loadOpponentMixture();
  let opponent_ids = opponent_mixture.ids;
  let opponents = opponent_mixture.players;
  let weights = opponent_mixture.weights;
  let screening_started = Date.now();
  let screened = [];
  let buckets = new Map();
  src.BuildSearch.forEachEquipmentSignature(profile[0], profile[1], function(entry) {
    let envelope = src.BuildSearch.signatureEffectEnvelope(entry);
    let result = {
      signature: entry.signature,
      index: entry.index,
      score: screenScore(envelope, opponents, weights),
    };
    screened.push(result);
    let weapon_items = [
      entry.equipment.weapon1.item,
      entry.equipment.weapon2.item,
    ].sort();
    let bucket_key = JSON.stringify([ entry.equipment.armor.item, weapon_items ]);
    if (!buckets.has(bucket_key)) {
      buckets.set(bucket_key, []);
    }
    let bucket = buckets.get(bucket_key);
    bucket.push(result);
    bucket.sort(function(left, right) { return right.score - left.score; });
    if (bucket.length > bucket_shortlist_size) {
      bucket.pop();
    }
  });
  screened.sort(function(left, right) { return right.score - left.score; });
  let shortlist = new Set(screened.slice(0, global_shortlist_size).map(function(entry) {
    return entry.signature;
  }));
  buckets.forEach(function(bucket) {
    bucket.forEach(function(entry) { shortlist.add(entry.signature); });
  });
  let screen_by_signature = new Map(screened.map(function(entry, rank) {
    return [ entry.signature, { score: entry.score, rank: rank + 1 } ];
  }));
  let screening_elapsed_ms = Date.now() - screening_started;
  let second_stage_started = Date.now();
  let second_stage_screened = [];
  src.BuildSearch.forEachEquipmentSignature(profile[0], profile[1], function(entry) {
    if (!shortlist.has(entry.signature)) {
      return;
    }
    let result = configuredProxyScore(entry, opponents, weights);
    second_stage_screened.push({
      signature: entry.signature,
      equipment: entry.equipment,
      score: result.score,
      build: result.build,
      configurations: result.configurations,
      specialization_count: result.specialization_count,
    });
  });
  second_stage_screened.sort(function(left, right) { return right.score - left.score; });
  let second_stage_shortlist = new Set(second_stage_screened.slice(
    0, second_stage_global_size
  ).map(function(entry) { return entry.signature; }));
  let second_stage_buckets = new Map();
  second_stage_screened.forEach(function(entry) {
    let weapon_items = [
      entry.equipment.weapon1.item,
      entry.equipment.weapon2.item,
    ].sort();
    let bucket_key = JSON.stringify(weapon_items);
    if (!second_stage_buckets.has(bucket_key)) {
      second_stage_buckets.set(bucket_key, []);
    }
    let bucket = second_stage_buckets.get(bucket_key);
    bucket.push(entry);
    bucket.sort(function(left, right) { return right.score - left.score; });
    if (bucket.length > second_stage_bucket_size) {
      bucket.pop();
    }
  });
  second_stage_buckets.forEach(function(bucket) {
    bucket.forEach(function(entry) { second_stage_shortlist.add(entry.signature); });
  });
  let second_stage_finalists = second_stage_screened.filter(function(entry) {
    return second_stage_shortlist.has(entry.signature);
  });
  let second_stage_elapsed_ms = Date.now() - second_stage_started;
  let validation_entries = src.BuildSearch.sampleEquipmentSignatures(
    profile[0], profile[1], optimization_sample_count
  );
  let validation_signatures = new Set(validation_entries.map(function(entry) {
    return entry.signature;
  }));
  let promoted_signatures = new Set(screened.slice(0, screen_promotion_count).map(
    function(entry) { return entry.signature; }
  ));
  let second_stage_promoted_signatures = new Set(second_stage_screened.slice(
    0, second_stage_promotion_count
  ).map(function(entry) { return entry.signature; }));
  let promoted_entries = [];
  src.BuildSearch.forEachEquipmentSignature(profile[0], profile[1], function(entry) {
    if ((promoted_signatures.has(entry.signature) ||
        second_stage_promoted_signatures.has(entry.signature)) &&
        !validation_signatures.has(entry.signature)) {
      promoted_entries.push(entry);
    }
  });
  let optimization_entries = validation_entries.concat(promoted_entries);
  let optimized = optimization_entries.map(function(entry) {
    let envelope = src.BuildSearch.signatureEffectEnvelope(entry);
    let actual = optimizeSignature(entry, opponents, opponent_ids, weights);
    let screen = screen_by_signature.get(entry.signature);
    return {
      signature: entry.signature,
      equipment: entry.equipment,
      selection: validation_signatures.has(entry.signature) ? 'validation' :
        (second_stage_promoted_signatures.has(entry.signature) ?
          'configured_proxy_promoted' : 'envelope_promoted'),
      screen_score: screen.score,
      screen_rank: screen.rank,
      shortlisted: shortlist.has(entry.signature),
      configured_proxy_shortlisted: second_stage_shortlist.has(entry.signature),
      relaxed_upper_bound: relaxedBound(envelope, opponents, weights),
      configured_search: actual,
    };
  });
  let incumbent = Math.max.apply(null, optimized.map(function(entry) {
    return entry.configured_search.score;
  }));
  let configured_order = optimized.slice().sort(function(left, right) {
    return right.configured_search.score - left.configured_search.score;
  });
  let validation_order = configured_order.filter(function(entry) {
    return entry.selection === 'validation';
  });
  let promoted_order = configured_order.filter(function(entry) {
    return entry.selection === 'envelope_promoted';
  });
  let second_stage_promoted_order = configured_order.filter(function(entry) {
    return entry.selection === 'configured_proxy_promoted';
  });
  console.log(JSON.stringify({
    profile: profile_key,
    opponent_mixture: opponent_ids.map(function(id, index) {
      return { candidate: id, weight: weights[index] };
    }),
    signature_space: {
      weapon_descriptors: [ space.left_weapons.length, space.right_weapons.length ],
      weapon_pairs: space.weapon_pair_count,
      misc_pairs: space.misc_pair_count,
      armors: space.armor_count,
      signatures: space.signature_count,
    },
    strict_region_dominance: {
      sample_count: dominance_entries.length,
      dominated_count: new Set(strict_dominance.map(function(pair) {
        return pair.dominated;
      })).size,
      relations: strict_dominance,
      elapsed_ms: dominance_elapsed_ms,
    },
    opponent_conditioned_relaxation: {
      incumbent_configured_score: incumbent,
      prunable_count: optimized.filter(function(entry) {
        return entry.relaxed_upper_bound < incumbent - 1e-12;
      }).length,
      bound_violations: optimized.filter(function(entry) {
        return entry.relaxed_upper_bound + 1e-12 < entry.configured_search.score;
      }).length,
      mean_bound_slack: optimized.reduce(function(sum, entry) {
        return sum + entry.relaxed_upper_bound - entry.configured_search.score;
      }, 0) / optimized.length,
      candidates: optimized,
    },
    global_screen: {
      signature_count: screened.length,
      shortlist_count: shortlist.size,
      global_shortlist_size: global_shortlist_size,
      bucket_shortlist_size: bucket_shortlist_size,
      bucket_count: buckets.size,
      elapsed_ms: screening_elapsed_ms,
      configured_evaluation_count: optimized.length,
      validation_sample_count: validation_order.length,
      promoted_count: promoted_order.length,
      validation_shortlist_recall: validation_order.filter(function(entry) {
        return entry.shortlisted;
      }).length / validation_order.length,
      validation_winner_retained: validation_order[0].shortlisted,
      validation_top_half_recall: validation_order.slice(
        0, Math.ceil(validation_order.length / 2)
      ).filter(function(entry) { return entry.shortlisted; }).length /
        Math.ceil(validation_order.length / 2),
      best_validation_score: validation_order[0].configured_search.score,
      best_promoted_score: promoted_order.length === 0 ? null :
        promoted_order[0].configured_search.score,
      promoted_beat_validation: promoted_order.length > 0 &&
        promoted_order[0].configured_search.score >=
        validation_order[0].configured_search.score,
    },
    configured_proxy_screen: {
      input_count: second_stage_screened.length,
      shortlist_count: second_stage_shortlist.size,
      global_shortlist_size: second_stage_global_size,
      bucket_shortlist_size: second_stage_bucket_size,
      weapon_pair_bucket_count: second_stage_buckets.size,
      elapsed_ms: second_stage_elapsed_ms,
      promoted_count: second_stage_promoted_order.length,
      validation_shortlist_recall: validation_order.filter(function(entry) {
        return entry.configured_proxy_shortlisted;
      }).length / validation_order.length,
      best_promoted_exact_score: second_stage_promoted_order.length === 0 ? null :
        second_stage_promoted_order[0].configured_search.score,
      promoted_beat_envelope_promoted: second_stage_promoted_order.length > 0 &&
        promoted_order.length > 0 &&
        second_stage_promoted_order[0].configured_search.score >=
          promoted_order[0].configured_search.score,
      leaders: second_stage_screened.slice(0, 5),
      finalists: second_stage_finalists,
    },
  }));
} else {
  let started = Date.now();
  let worker_count = Number(process.env.REGION_WORKERS || 4);
  if (!Number.isInteger(worker_count) || worker_count <= 0) {
    throw new Error('Region worker count must be a positive integer.');
  }
  let runProfile = function(profile) {
    return new Promise(function(resolve, reject) {
      let child = childProcess.spawn(process.execPath, [ __filename ], {
        cwd: process.cwd(),
        env: Object.assign({}, process.env, { REGION_PROFILE: profile.join('+') }),
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', function(chunk) { stdout += chunk; });
      child.stderr.on('data', function(chunk) { stderr += chunk; });
      child.on('error', reject);
      child.on('close', function(code) {
        if (code !== 0) {
          reject(new Error(stderr || 'Region worker failed for ' + profile.join('+')));
          return;
        }
        resolve(JSON.parse(stdout));
      });
    });
  };
  let runProfiles = function(offset, results) {
    if (offset >= profiles.length) {
      return Promise.resolve(results);
    }
    let batch = profiles.slice(offset, offset + worker_count);
    return Promise.all(batch.map(runProfile)).then(function(batch_results) {
      return runProfiles(offset + worker_count, results.concat(batch_results));
    });
  };
  runProfiles(0, []).then(function(results) {
    console.log(JSON.stringify({
      generated_at: new Date().toISOString(),
      opponent_catalog: opponent_catalog_path,
      opponent_report: opponent_report_path || null,
      opponent_mixture: results[0].opponent_mixture,
      profiles: results,
      totals: {
        signatures: results.reduce(function(sum, result) {
          return sum + result.signature_space.signatures;
        }, 0),
        strict_sampled_dominated: results.reduce(function(sum, result) {
          return sum + result.strict_region_dominance.dominated_count;
        }, 0),
        relaxed_sampled_prunable: results.reduce(function(sum, result) {
          return sum + result.opponent_conditioned_relaxation.prunable_count;
        }, 0),
        bound_violations: results.reduce(function(sum, result) {
          return sum + result.opponent_conditioned_relaxation.bound_violations;
        }, 0),
        shortlisted_signatures: results.reduce(function(sum, result) {
          return sum + result.global_screen.shortlist_count;
        }, 0),
        screening_elapsed_ms: results.reduce(function(sum, result) {
          return sum + result.global_screen.elapsed_ms;
        }, 0),
        shortlist_fraction: results.reduce(function(sum, result) {
          return sum + result.global_screen.shortlist_count;
        }, 0) / results.reduce(function(sum, result) {
          return sum + result.signature_space.signatures;
        }, 0),
        configured_proxy_shortlisted_signatures: results.reduce(function(sum, result) {
          return sum + result.configured_proxy_screen.shortlist_count;
        }, 0),
        configured_proxy_elapsed_ms: results.reduce(function(sum, result) {
          return sum + result.configured_proxy_screen.elapsed_ms;
        }, 0),
        profiles_where_configured_proxy_beat_envelope_proxy: results.filter(
        function(result) {
          return result.configured_proxy_screen.promoted_beat_envelope_promoted;
        }
      ).length,
        validation_winners_retained: results.filter(function(result) {
          return result.global_screen.validation_winner_retained;
        }).length,
        profiles_where_promoted_beat_validation: results.filter(function(result) {
          return result.global_screen.promoted_beat_validation;
        }).length,
        mean_validation_shortlist_recall: results.reduce(function(sum, result) {
          return sum + result.global_screen.validation_shortlist_recall;
        }, 0) / results.length,
      },
      elapsed_ms: Date.now() - started,
    }, null, 2));
  }).catch(function(error) {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
}
