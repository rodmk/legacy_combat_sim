use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand, ValueEnum};
use legacy_combat_sim::analysis::analyze_build_catalog;
use legacy_combat_sim::candidate_meta::{
    endogenous_initial_ids, solve_candidate_meta, CandidateMetaOptions, CandidateMetaState,
};
use legacy_combat_sim::catalog::{bundled_data_fingerprint, BuildCatalog, Catalogs};
use legacy_combat_sim::combat;
use legacy_combat_sim::global_meta::{
    global_seeds, run_global_challenge, GlobalChallengeOptions, GlobalChallengeResult,
    GlobalScreeningCheckpoint,
};
use legacy_combat_sim::inference::{
    endogenous_equipment_search, endogenous_equipment_search_with_screening, InferenceOptions,
};
use legacy_combat_sim::model::{AttackType, BuildDefinition, CombatSignature, MatchupRole};
use legacy_combat_sim::regions::{generate_candidate_catalog, CandidateGenerationOptions};
use legacy_combat_sim::search::{
    joint_equipment_stat_response_beam, AdaptiveStatOptions, EquipmentNeighborhoodOptions,
};
use rand::rngs::SmallRng;
use rand::SeedableRng;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const CHECKPOINT_VERSION: u32 = 5;

#[derive(Debug, Parser)]
#[command(version, about)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Resolve the endogenous meta through configuration and global closure.
    ResolveMeta {
        /// Directory containing resumable stage artifacts.
        #[arg(long, default_value = ".local/rust-meta")]
        directory: PathBuf,
        /// Maximum global challenge cycles.
        #[arg(long, default_value_t = 10)]
        max_cycles: usize,
        /// Maximum parallel response searches.
        #[arg(long, default_value_t = 1)]
        workers: usize,
    },
    /// Solve an equilibrium over an endogenously generated candidate catalog.
    SolveCandidates {
        /// Generated candidate build catalog.
        #[arg(long)]
        candidate_catalog: PathBuf,
        /// Resume and update solver state at this path after every round.
        #[arg(long)]
        checkpoint: PathBuf,
        /// Maximum response-admission rounds performed by this invocation.
        #[arg(long, default_value_t = 100)]
        max_rounds: usize,
        /// Profitable responses admitted per round.
        #[arg(long, default_value_t = 2)]
        batch_size: usize,
        /// Score above 0.5 required for admission.
        #[arg(long, default_value_t = 0.001)]
        response_tolerance: f64,
        /// Maximum equilibrium mass omitted during screening.
        #[arg(long, default_value_t = 0.005)]
        opponent_pruning_tolerance: f64,
    },
    /// Generate a global candidate catalog from canonical equipment signatures.
    GenerateCandidates {
        /// Build used by the screening proxy; may be specified more than once.
        #[arg(long = "opponent-build", default_value = "CurrentDualRifts750")]
        opponent_builds: Vec<String>,
        /// Candidate-meta checkpoint whose final equilibrium conditions screening.
        #[arg(long, conflicts_with = "opponent_builds")]
        opponent_report: Option<PathBuf>,
        /// Additional JSON build catalog; may be specified more than once.
        #[arg(long = "catalog")]
        catalogs: Vec<PathBuf>,
        /// Prefix used for generated candidate identifiers.
        #[arg(long, default_value = "Region")]
        candidate_prefix: String,
        /// Global envelope-screen leaders retained per weapon profile.
        #[arg(long, default_value_t = 2_000)]
        global_shortlist_size: usize,
        /// Envelope-screen leaders retained per armor and weapon-pair bucket.
        #[arg(long, default_value_t = 2)]
        bucket_shortlist_size: usize,
        /// Configured-proxy leaders retained per weapon profile.
        #[arg(long, default_value_t = 125)]
        configured_global_size: usize,
        /// Configured-proxy leaders retained per weapon-pair bucket.
        #[arg(long, default_value_t = 1)]
        configured_bucket_size: usize,
        /// Crystal sockets filled on generated equipment.
        #[arg(long, default_value_t = 4)]
        socket_capacity: usize,
        /// Maximum equilibrium mass omitted from conditioned proxy screening.
        #[arg(long, default_value_t = 0.02)]
        opponent_pruning_tolerance: f64,
        /// Optional full generation report with scored configured finalists.
        #[arg(long)]
        report: Option<PathBuf>,
    },
    /// Analyze a named enemy set with exact combat distributions.
    Analyze {
        /// Named build set: shadow-dojo or reference.
        #[arg(long, default_value = "shadow-dojo")]
        enemy_set: String,
        /// Additional JSON build catalog; may be specified more than once.
        #[arg(long = "catalog")]
        catalogs: Vec<PathBuf>,
    },
    /// Run a build against an enemy set or selected enemies.
    Simulate {
        /// Build key from a bundled or supplied catalog.
        #[arg(long)]
        build: String,
        /// Named enemy set: shadow-dojo or reference.
        #[arg(long, conflicts_with = "enemy")]
        enemy_set: Option<String>,
        /// Enemy build key; may be specified more than once.
        #[arg(long, conflicts_with = "enemy_set")]
        enemy: Vec<String>,
        /// Additional JSON build catalog; may be specified more than once.
        #[arg(long = "catalog")]
        catalogs: Vec<PathBuf>,
        /// Number of fights per enemy.
        #[arg(long, default_value_t = 100_000)]
        fights: u64,
        /// Seed for runs reproducible with the same compiled dependency versions.
        #[arg(long)]
        seed: Option<u64>,
        /// Report format.
        #[arg(long, value_enum, default_value_t = OutputFormat::Table)]
        format: OutputFormat,
    },
    /// List available build keys.
    ListBuilds {
        /// Additional JSON build catalog; may be specified more than once.
        #[arg(long = "catalog")]
        catalogs: Vec<PathBuf>,
    },
    /// Search equipment and stat responses against an enemy set.
    Search {
        /// Seed build key from a bundled or supplied catalog.
        #[arg(long)]
        build: String,
        /// Named enemy set: shadow-dojo or reference.
        #[arg(long, default_value = "shadow-dojo")]
        enemy_set: String,
        /// Additional JSON build catalog; may be specified more than once.
        #[arg(long = "catalog")]
        catalogs: Vec<PathBuf>,
        /// Maximum distinct responses retained per pass.
        #[arg(long, default_value_t = 8)]
        beam_width: usize,
        /// Seeds expanded per pass.
        #[arg(long, default_value_t = 2)]
        expansion_width: usize,
        /// Maximum alternating equipment/stat passes.
        #[arg(long, default_value_t = 8)]
        max_iterations: usize,
        /// Crystal sockets filled on generated equipment.
        #[arg(long, default_value_t = 4)]
        socket_capacity: usize,
        /// Approximate-distribution survival threshold used for screening.
        #[arg(long, default_value_t = 0.01)]
        minimum_survival_probability: f64,
        /// Keep the five base items and weapon modifications fixed.
        #[arg(long)]
        fixed_equipment: bool,
    },
    /// Close a restricted meta by admitting profitable joint responses.
    Infer {
        /// Named initial strategy set: shadow-dojo or reference.
        #[arg(long, conflicts_with = "initial_build")]
        enemy_set: Option<String>,
        /// Initial strategy build key; may be specified more than once.
        #[arg(long, conflicts_with = "enemy_set")]
        initial_build: Vec<String>,
        /// Additional JSON build catalog; may be specified more than once.
        #[arg(long = "catalog")]
        catalogs: Vec<PathBuf>,
        /// Maximum archive-expansion rounds.
        #[arg(long, default_value_t = 16)]
        max_rounds: usize,
        /// Novel responses admitted per round.
        #[arg(long, default_value_t = 2)]
        batch_size: usize,
        /// Maximum distinct responses retained by each oracle pass.
        #[arg(long, default_value_t = 8)]
        beam_width: usize,
        /// Maximum alternating equipment/stat passes per round.
        #[arg(long, default_value_t = 8)]
        max_iterations: usize,
        /// Crystal sockets filled on generated equipment.
        #[arg(long, default_value_t = 4)]
        socket_capacity: usize,
        /// Score above 0.5 required for archive admission.
        #[arg(long, default_value_t = 0.001)]
        improvement_tolerance: f64,
        /// Resume and update inference state at this path after every round.
        #[arg(long)]
        checkpoint: Option<PathBuf>,
        /// Keep each seed's base items and weapon modifications fixed.
        #[arg(long)]
        fixed_equipment: bool,
        /// Diversified weapon-pair seeds screened globally per round.
        #[arg(long, default_value_t = 0)]
        global_seeds: usize,
        /// Maximum parallel response searches.
        #[arg(long, default_value_t = 4)]
        workers: usize,
    },
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum OutputFormat {
    Table,
    Json,
}

#[derive(Debug, Serialize)]
struct MatchupReport {
    enemy: String,
    enemy_name: String,
    fights: u64,
    wins: u64,
    losses: u64,
    draws: u64,
    win_rate: f64,
}

#[derive(Debug, Deserialize, Serialize)]
struct InferenceCheckpoint {
    input_fingerprint: String,
    settings: Value,
    catalog: BuildCatalog,
    rounds: Vec<Value>,
    completed_rounds: usize,
    converged: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    promoted_seeds: Option<Vec<BuildDefinition>>,
}

#[derive(Debug, Deserialize, Serialize)]
struct CandidateCheckpoint {
    input_fingerprint: String,
    settings: Value,
    state: CandidateMetaState,
}

#[derive(Debug, Deserialize, Serialize)]
struct StageMetadata {
    input_fingerprint: String,
}

#[derive(Debug, Serialize)]
struct Report {
    build: String,
    build_name: String,
    seed: u64,
    matchups: Vec<MatchupReport>,
}

#[derive(Debug, Serialize)]
struct SearchEntry {
    signature: CombatSignature,
    concept_signature: String,
    weighted_score: f64,
    build: BuildDefinition,
}

#[derive(Debug, Serialize)]
struct SearchReport {
    seed_build: String,
    enemy_set: String,
    converged: bool,
    convergence_reason: String,
    iterations: Vec<legacy_combat_sim::search::JointResponseIteration>,
    beam: Vec<SearchEntry>,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::ResolveMeta {
            directory,
            max_cycles,
            workers,
        } => {
            if workers == 0 || max_cycles == 0 {
                bail!("worker and cycle counts must be positive");
            }
            rayon::ThreadPoolBuilder::new()
                .num_threads(workers)
                .build_global()
                .context("failed to configure response-search workers")?;
            let report = resolve_meta(&directory, max_cycles)?;
            println!("{}", serde_json::to_string_pretty(&report)?);
        }
        Command::SolveCandidates {
            candidate_catalog,
            checkpoint,
            max_rounds,
            batch_size,
            response_tolerance,
            opponent_pruning_tolerance,
        } => {
            let data = fs::read_to_string(&candidate_catalog)?;
            let pool: BuildCatalog = serde_json::from_str(&data)?;
            let catalogs = load_catalogs(&[candidate_catalog])?;
            let options = CandidateMetaOptions {
                maximum_rounds: max_rounds,
                batch_size,
                response_tolerance,
                opponent_pruning_tolerance,
                ..CandidateMetaOptions::default()
            };
            let settings = candidate_settings(&options);
            let input_fingerprint = json_fingerprint(&pool)?;
            let state = if checkpoint.exists() {
                let saved: CandidateCheckpoint =
                    serde_json::from_str(&fs::read_to_string(&checkpoint)?)?;
                if saved.input_fingerprint != input_fingerprint || saved.settings != settings {
                    bail!("candidate checkpoint inputs or settings do not match");
                }
                saved.state
            } else {
                CandidateMetaState {
                    active_ids: endogenous_initial_ids(&pool),
                    rounds: Vec::new(),
                    converged: false,
                }
            };
            let result = solve_candidate_meta(&catalogs, &pool, state, &options, |state| {
                write_json_atomic(
                    &checkpoint,
                    &CandidateCheckpoint {
                        input_fingerprint: input_fingerprint.clone(),
                        settings: settings.clone(),
                        state: state.clone(),
                    },
                )?;
                if let Some(round) = state.rounds.last() {
                    eprintln!(
                        "round {}: active {}, best response {:.6}, admitted {}",
                        round.round,
                        state.active_ids.len(),
                        round.best_response_score,
                        round.additions.len()
                    );
                }
                Ok(())
            })?;
            println!("{}", serde_json::to_string_pretty(&result)?);
        }
        Command::GenerateCandidates {
            opponent_builds,
            opponent_report,
            catalogs,
            candidate_prefix,
            global_shortlist_size,
            bucket_shortlist_size,
            configured_global_size,
            configured_bucket_size,
            socket_capacity,
            opponent_pruning_tolerance,
            report,
        } => {
            let mut catalogs = load_catalogs(&catalogs)?;
            let (opponents, weights) = if let Some(path) = opponent_report {
                let report: Value = serde_json::from_str(&fs::read_to_string(&path)?)?;
                if let Some(catalog) = report.get("catalog") {
                    catalogs.add_builds(serde_json::from_value(catalog.clone())?)?;
                }
                let support = legacy_combat_sim::inference::prune_opponent_mixture(
                    &report_support(&report)?,
                    opponent_pruning_tolerance,
                )?
                .retained;
                let opponents = support
                    .iter()
                    .map(|entry| {
                        catalogs.materialize(catalogs.build(&entry.candidate)?, MatchupRole::Active)
                    })
                    .collect::<Result<Vec<_>>>()?;
                let weights = support.iter().map(|entry| entry.weight).collect();
                (opponents, weights)
            } else {
                let opponents = opponent_builds
                    .iter()
                    .map(|id| catalogs.materialize(catalogs.build(id)?, MatchupRole::Active))
                    .collect::<Result<Vec<_>>>()?;
                let weights = vec![1.0 / opponents.len() as f64; opponents.len()];
                (opponents, weights)
            };
            let result = generate_candidate_catalog(
                &catalogs,
                &opponents,
                &weights,
                &CandidateGenerationOptions {
                    candidate_prefix,
                    global_shortlist_size,
                    bucket_shortlist_size,
                    configured_global_size,
                    configured_bucket_size,
                    socket_capacity,
                },
            )?;
            eprintln!(
                "enumerated {} signatures and generated {} candidate builds",
                result.signature_count,
                result.catalog.len()
            );
            for profile in &result.profiles {
                eprintln!(
                    "{}: {} signatures -> {} envelope -> {} configured -> {} builds",
                    profile.profile,
                    profile.signatures,
                    profile.envelope_shortlist,
                    profile.configured_signatures,
                    profile.builds
                );
            }
            if let Some(path) = report {
                write_json_atomic(&path, &result)?;
            }
            println!("{}", serde_json::to_string_pretty(&result.catalog)?);
        }
        Command::Analyze {
            enemy_set,
            catalogs,
        } => {
            let catalogs = load_catalogs(&catalogs)?;
            let catalog = catalogs
                .enemy_set(&enemy_set)?
                .into_iter()
                .map(|(key, build)| (key.to_owned(), build.clone()))
                .collect::<BuildCatalog>();
            let report = analyze_build_catalog(&catalogs, &catalog)?;
            println!("{}", serde_json::to_string_pretty(&report)?);
        }
        Command::ListBuilds { catalogs } => {
            let catalogs = load_catalogs(&catalogs)?;
            for (key, _) in catalogs.builds() {
                println!("{key}");
            }
        }
        Command::Search {
            build,
            enemy_set,
            catalogs,
            beam_width,
            expansion_width,
            max_iterations,
            socket_capacity,
            minimum_survival_probability,
            fixed_equipment,
        } => {
            let catalogs = load_catalogs(&catalogs)?;
            let seed = catalogs.build(&build)?;
            let enemies = catalogs.enemy_set(&enemy_set)?;
            if enemies.is_empty() {
                bail!("enemy selection is empty");
            }
            let opponent_ids = enemies
                .iter()
                .map(|(key, _)| (*key).to_owned())
                .collect::<Vec<_>>();
            let opponents = enemies
                .iter()
                .map(|(_, enemy)| catalogs.materialize(enemy, MatchupRole::Active))
                .collect::<Result<Vec<_>>>()?;
            let response = joint_equipment_stat_response_beam(
                &catalogs,
                seed,
                &opponents,
                &opponent_ids,
                None,
                &[
                    AttackType::Normal,
                    AttackType::Quick,
                    AttackType::Aimed,
                    AttackType::Cover,
                ],
                &EquipmentNeighborhoodOptions {
                    socket_capacity,
                    fixed_equipment,
                    ..EquipmentNeighborhoodOptions::default()
                },
                &AdaptiveStatOptions {
                    minimum_survival_probability,
                    ..AdaptiveStatOptions::default()
                },
                minimum_survival_probability,
                beam_width,
                expansion_width,
                max_iterations,
                1e-3,
            )?;
            let report = SearchReport {
                seed_build: build,
                enemy_set,
                converged: response.converged,
                convergence_reason: response.convergence_reason.to_owned(),
                iterations: response.iterations,
                beam: response
                    .beam
                    .into_iter()
                    .map(|entry| SearchEntry {
                        signature: entry.signature,
                        concept_signature: entry.concept_signature,
                        weighted_score: entry.weighted_score,
                        build: entry.build,
                    })
                    .collect(),
            };
            println!("{}", serde_json::to_string_pretty(&report)?);
        }
        Command::Infer {
            enemy_set,
            initial_build,
            catalogs,
            max_rounds,
            batch_size,
            beam_width,
            max_iterations,
            socket_capacity,
            improvement_tolerance,
            checkpoint,
            fixed_equipment,
            global_seeds,
            workers,
        } => {
            if workers == 0 {
                bail!("worker count must be positive");
            }
            rayon::ThreadPoolBuilder::new()
                .num_threads(workers)
                .build_global()
                .context("failed to configure response-search workers")?;
            let catalogs = load_catalogs(&catalogs)?;
            let initial = if initial_build.is_empty() {
                catalogs
                    .enemy_set(enemy_set.as_deref().unwrap_or("shadow-dojo"))?
                    .into_iter()
                    .map(|(key, build)| (key.to_owned(), build.clone()))
                    .collect::<BuildCatalog>()
            } else {
                initial_build
                    .iter()
                    .map(|key| Ok((key.clone(), catalogs.build(key)?.clone())))
                    .collect::<Result<BuildCatalog>>()?
            };
            let options = InferenceOptions {
                maximum_rounds: max_rounds,
                batch_size,
                improvement_tolerance,
                beam_width,
                expansion_width: if fixed_equipment { 1 } else { 2 },
                joint_maximum_iterations: max_iterations,
                global_seed_count: global_seeds,
                screening_iterations: fixed_equipment.then_some(1),
                screening_promotion_score: if fixed_equipment {
                    0.505
                } else {
                    0.5 + improvement_tolerance
                },
                admission_score: if fixed_equipment {
                    0.51
                } else {
                    0.5 + improvement_tolerance
                },
                equipment: EquipmentNeighborhoodOptions {
                    socket_capacity,
                    fixed_equipment,
                    ..EquipmentNeighborhoodOptions::default()
                },
                ..InferenceOptions::default()
            };
            if let Some(path) = checkpoint {
                let result = run_checkpointed_inference(&catalogs, initial, &options, &path)?;
                println!("{}", serde_json::to_string_pretty(&result)?);
            } else {
                let result = endogenous_equipment_search(&catalogs, &initial, &options)?;
                println!("{}", serde_json::to_string_pretty(&result)?);
            }
        }
        Command::Simulate {
            build,
            enemy_set,
            enemy,
            catalogs,
            fights,
            seed,
            format,
        } => {
            if fights == 0 {
                bail!("fights must be greater than zero");
            }
            let catalogs = load_catalogs(&catalogs)?;
            let build_definition = catalogs.build(&build)?;
            let player = catalogs.materialize(build_definition, MatchupRole::Active)?;
            let enemies = if !enemy.is_empty() {
                enemy
                    .iter()
                    .map(|key| Ok((key.as_str(), catalogs.build(key)?)))
                    .collect::<Result<Vec<_>>>()?
            } else {
                catalogs.enemy_set(enemy_set.as_deref().unwrap_or("shadow-dojo"))?
            };
            if enemies.is_empty() {
                bail!("enemy selection is empty");
            }

            let seed = seed.unwrap_or_else(rand::random);
            let mut rng = SmallRng::seed_from_u64(seed);
            let mut matchups = Vec::with_capacity(enemies.len());
            for (enemy_key, enemy_build) in enemies {
                let opponent = catalogs.materialize(enemy_build, MatchupRole::Opponent)?;
                let result = combat::simulate(&player, &opponent, fights, &mut rng);
                matchups.push(MatchupReport {
                    enemy: enemy_key.to_owned(),
                    enemy_name: enemy_build.name.clone(),
                    fights,
                    wins: result.player1_wins,
                    losses: result.player2_wins,
                    draws: result.draws,
                    win_rate: result.player1_wins as f64 / fights as f64,
                });
            }
            let report = Report {
                build,
                build_name: build_definition.name.clone(),
                seed,
                matchups,
            };
            print_report(&report, format)?;
        }
    }
    Ok(())
}

fn load_catalogs(paths: &[PathBuf]) -> Result<Catalogs> {
    let mut catalogs = Catalogs::bundled()?;
    for path in paths {
        catalogs.add_build_catalog(path)?;
    }
    Ok(catalogs)
}

fn report_support(report: &Value) -> Result<Vec<legacy_combat_sim::analysis::StrategyWeight>> {
    let weights = report
        .get("final_equilibrium")
        .and_then(|value| value.get("weights"))
        .or_else(|| report.get("final_support"))
        .or_else(|| report.get("support"))
        .or_else(|| {
            report
                .get("rounds")?
                .as_array()?
                .last()?
                .get("equilibrium")?
                .get("weights")
        })
        .context("opponent report contains no equilibrium support")?;
    serde_json::from_value(weights.clone()).context("invalid opponent report support")
}

fn resolve_meta(directory: &Path, maximum_cycles: usize) -> Result<Value> {
    fs::create_dir_all(directory)?;
    let settings = json!({
        "version": CHECKPOINT_VERSION,
        "bundled_data_fingerprint": bundled_data_fingerprint(),
        "candidate_opponent_pruning_tolerance": 0.005,
        "configuration_opponent_pruning_tolerance": 0.005,
        "region_opponent_pruning_tolerance": 0.02,
        "candidate_global_shortlist_size": 2000,
        "candidate_bucket_shortlist_size": 2,
        "candidate_configured_global_size": 125,
        "candidate_configured_bucket_size": 1,
        "candidate_socket_capacity": 4,
        "leaders_per_profile": 3,
        "screening_iterations": 1,
        "confirmation_iterations": 16,
        "beam_width": 4,
        "expansion_width": 1,
        "screening_promotion_score": 0.505,
        "admission_score": 0.51,
        "batch_size": 2,
    });
    let settings_path = directory.join("settings.json");
    if settings_path.exists() {
        let stored: Value = serde_json::from_str(&fs::read_to_string(&settings_path)?)?;
        if stored != settings {
            bail!("resolved-meta settings do not match the existing work directory");
        }
    } else {
        write_json_atomic(&settings_path, &settings)?;
    }
    let initial_candidates_path = directory.join("initial-candidates.json");
    let initial_candidates_input = json_fingerprint(&json!({
        "stage": "initial-candidates-v1",
        "bundled_data_fingerprint": bundled_data_fingerprint(),
        "global_shortlist_size": 2000,
        "bucket_shortlist_size": 2,
        "configured_global_size": 125,
        "configured_bucket_size": 1,
        "socket_capacity": 4,
    }))?;
    let pool: BuildCatalog = if let Some(pool) =
        read_stage_artifact(&initial_candidates_path, &initial_candidates_input)?
    {
        pool
    } else {
        eprintln!("generating initial endogenous candidate pool");
        let catalogs = Catalogs::bundled()?;
        let opponent =
            catalogs.materialize(catalogs.build("CurrentDualRifts750")?, MatchupRole::Active)?;
        let generated = generate_candidate_catalog(
            &catalogs,
            &[opponent],
            &[1.0],
            &CandidateGenerationOptions::default(),
        )?;
        write_stage_artifact(
            &initial_candidates_path,
            &initial_candidates_input,
            &generated.catalog,
        )?;
        generated.catalog
    };
    let candidate_checkpoint_path = directory.join("candidate-checkpoint.json");
    let candidate_options = CandidateMetaOptions::default();
    let candidate_settings = candidate_settings(&candidate_options);
    let candidate_input_fingerprint = json_fingerprint(&pool)?;
    let candidate_state = if candidate_checkpoint_path.exists() {
        let saved: CandidateCheckpoint =
            serde_json::from_str(&fs::read_to_string(&candidate_checkpoint_path)?)?;
        if saved.input_fingerprint != candidate_input_fingerprint
            || saved.settings != candidate_settings
        {
            bail!("candidate checkpoint inputs or settings do not match");
        }
        saved.state
    } else {
        CandidateMetaState {
            active_ids: endogenous_initial_ids(&pool),
            rounds: Vec::new(),
            converged: false,
        }
    };
    let mut candidate_catalogs = Catalogs::bundled()?;
    candidate_catalogs.add_builds(pool.clone())?;
    let candidate_state = solve_candidate_meta(
        &candidate_catalogs,
        &pool,
        candidate_state,
        &candidate_options,
        |state| {
            write_json_atomic(
                &candidate_checkpoint_path,
                &CandidateCheckpoint {
                    input_fingerprint: candidate_input_fingerprint.clone(),
                    settings: candidate_settings.clone(),
                    state: state.clone(),
                },
            )?;
            if let Some(round) = state.rounds.last() {
                eprintln!(
                    "candidate round {}: active {}, best response {:.6}, admitted {}",
                    round.round,
                    state.active_ids.len(),
                    round.best_response_score,
                    round.additions.len()
                );
            }
            Ok(())
        },
    )?;
    if !candidate_state.converged {
        bail!("candidate-meta solve reached its round limit without convergence");
    }
    let initial_catalog = candidate_state
        .active_ids
        .iter()
        .map(|id| (id.clone(), pool[id].clone()))
        .collect::<BuildCatalog>();
    let configuration_options = configuration_options();
    let initial_report_path = directory.join("configuration-00.json");
    if !initial_report_path.exists() {
        eprintln!("closing initial supported equipment configurations");
        let mut catalogs = Catalogs::bundled()?;
        catalogs.add_builds(initial_catalog.clone())?;
        let report = run_checkpointed_inference(
            &catalogs,
            initial_catalog.clone(),
            &configuration_options,
            &directory.join("configuration-00-checkpoint.json"),
        )?;
        ensure_configuration_converged(&report)?;
        write_json_atomic(&initial_report_path, &report)?;
    }
    validate_inference_report(
        &initial_report_path,
        &initial_catalog,
        &configuration_options,
    )?;
    let mut current_report_path = initial_report_path;
    let mut completed = Vec::new();
    for cycle in 1..=maximum_cycles {
        eprintln!("starting global challenge cycle {cycle}");
        let current_report: Value =
            serde_json::from_str(&fs::read_to_string(&current_report_path)?)?;
        let current_catalog: BuildCatalog = serde_json::from_value(
            current_report
                .get("catalog")
                .context("configuration report has no catalog")?
                .clone(),
        )?;
        let mut catalogs = Catalogs::bundled()?;
        catalogs.add_builds(current_catalog.clone())?;
        let support = legacy_combat_sim::inference::prune_opponent_mixture(
            &report_support(&current_report)?,
            0.02,
        )?
        .retained;
        let region_input_fingerprint = json_fingerprint(&json!({
            "stage": "conditioned-region-v1",
            "catalog": &current_catalog,
            "support": &support,
        }))?;
        let generation_path = directory.join(format!("cycle-{cycle:02}-regions.json"));
        let generation: legacy_combat_sim::regions::CandidateGenerationResult =
            if let Some(generation) =
                read_stage_artifact(&generation_path, &region_input_fingerprint)?
            {
                generation
            } else {
                eprintln!("generating conditioned candidate region for cycle {cycle}");
                let opponents = support
                    .iter()
                    .map(|entry| {
                        catalogs.materialize(
                            current_catalog
                                .get(&entry.candidate)
                                .with_context(|| format!("missing support {}", entry.candidate))?,
                            MatchupRole::Active,
                        )
                    })
                    .collect::<Result<Vec<_>>>()?;
                let weights = support.iter().map(|entry| entry.weight).collect::<Vec<_>>();
                let generated = generate_candidate_catalog(
                    &catalogs,
                    &opponents,
                    &weights,
                    &CandidateGenerationOptions {
                        candidate_prefix: format!("Cycle{cycle:02}Region"),
                        ..CandidateGenerationOptions::default()
                    },
                )?;
                write_stage_artifact(&generation_path, &region_input_fingerprint, &generated)?;
                generated
            };
        let seeds = global_seeds(&generation, 3);
        let challenge_input_fingerprint = json_fingerprint(&json!({
            "stage": "global-challenge-v1",
            "catalog": &current_catalog,
            "seeds": &seeds,
            "screening_iterations": 1,
            "confirmation_iterations": 16,
            "screening_promotion_score": 0.505,
            "admission_score": 0.51,
            "batch_size": 2,
        }))?;
        let challenge_path = directory.join(format!("cycle-{cycle:02}-challenge.json"));
        let challenge: GlobalChallengeResult = if let Some(challenge) =
            read_stage_artifact(&challenge_path, &challenge_input_fingerprint)?
        {
            challenge
        } else {
            eprintln!("screening global challengers for cycle {cycle}");
            let promoted_path = directory.join(format!("cycle-{cycle:02}-promoted.json"));
            let promoted: Option<GlobalScreeningCheckpoint> =
                read_stage_artifact(&promoted_path, &challenge_input_fingerprint)?;
            let challenge = run_global_challenge(
                &catalogs,
                &current_catalog,
                &seeds,
                promoted,
                &GlobalChallengeOptions::default(),
                |checkpoint| {
                    write_stage_artifact(&promoted_path, &challenge_input_fingerprint, checkpoint)
                },
            )?;
            write_stage_artifact(&challenge_path, &challenge_input_fingerprint, &challenge)?;
            challenge
        };
        completed.push(json!({
            "cycle": cycle,
            "seed_count": challenge.seed_count,
            "promoted_seed_count": challenge.promoted_seed_count,
            "confirmed_seed_count": challenge.confirmed_seed_count,
            "admitted_count": challenge.admitted.len(),
            "globally_closed": challenge.globally_closed,
        }));
        if challenge.globally_closed {
            let mut resolved = current_report;
            resolved["global_search"] = json!({
                "completed_cycles": completed,
                "globally_closed": true,
            });
            let resolved_path = directory.join("resolved-meta.json");
            write_json_atomic(&resolved_path, &resolved)?;
            return Ok(resolved);
        }
        if challenge.admitted.is_empty() {
            bail!("global confirmation did not converge, so closure cannot be certified");
        }
        let next_report_path = directory.join(format!("configuration-{cycle:02}.json"));
        let mut next_catalog = current_catalog;
        next_catalog.extend(challenge.challenger_catalog.clone());
        if !next_report_path.exists() {
            eprintln!("closing configurations after global cycle {cycle}");
            catalogs.add_builds(challenge.challenger_catalog.clone())?;
            let report = run_checkpointed_inference(
                &catalogs,
                next_catalog.clone(),
                &configuration_options,
                &directory.join(format!("configuration-{cycle:02}-checkpoint.json")),
            )?;
            ensure_configuration_converged(&report)?;
            write_json_atomic(&next_report_path, &report)?;
        }
        validate_inference_report(&next_report_path, &next_catalog, &configuration_options)?;
        current_report_path = next_report_path;
    }
    bail!("global meta did not close within {maximum_cycles} cycles")
}

fn ensure_configuration_converged(report: &Value) -> Result<()> {
    if report.get("converged").and_then(Value::as_bool) != Some(true) {
        bail!("configuration closure reached its round limit without convergence");
    }
    Ok(())
}

fn validate_inference_report(
    path: &Path,
    initial: &BuildCatalog,
    options: &InferenceOptions,
) -> Result<()> {
    let report: Value = serde_json::from_str(&fs::read_to_string(path)?)?;
    let expected_input = json_fingerprint(initial)?;
    if report.get("input_fingerprint").and_then(Value::as_str) != Some(&expected_input)
        || report.get("settings") != Some(&inference_settings(initial, options))
    {
        bail!(
            "inference report inputs or settings do not match: {}",
            path.display()
        );
    }
    Ok(())
}

fn configuration_options() -> InferenceOptions {
    InferenceOptions {
        maximum_rounds: 100,
        batch_size: 2,
        beam_width: 4,
        expansion_width: 1,
        joint_maximum_iterations: 8,
        screening_iterations: Some(1),
        screening_promotion_score: 0.505,
        admission_score: 0.51,
        equipment: EquipmentNeighborhoodOptions {
            fixed_equipment: true,
            ..EquipmentNeighborhoodOptions::default()
        },
        ..InferenceOptions::default()
    }
}

fn candidate_settings(options: &CandidateMetaOptions) -> Value {
    json!({
        "version": CHECKPOINT_VERSION,
        "bundled_data_fingerprint": bundled_data_fingerprint(),
        "batch_size": options.batch_size,
        "response_tolerance": options.response_tolerance,
        "opponent_pruning_tolerance": options.opponent_pruning_tolerance,
        "minimum_survival_probability": options.minimum_survival_probability,
    })
}

fn inference_settings(initial: &BuildCatalog, options: &InferenceOptions) -> Value {
    json!({
        "version": CHECKPOINT_VERSION,
        "bundled_data_fingerprint": bundled_data_fingerprint(),
        "initial_ids": initial.keys().collect::<Vec<_>>(),
        "batch_size": options.batch_size,
        "improvement_tolerance": options.improvement_tolerance,
        "opponent_pruning_tolerance": options.opponent_pruning_tolerance,
        "beam_width": options.beam_width,
        "expansion_width": options.expansion_width,
        "joint_maximum_iterations": options.joint_maximum_iterations,
        "screening_iterations": options.screening_iterations,
        "screening_promotion_score": options.screening_promotion_score,
        "admission_score": options.admission_score,
        "equipment_screening_minimum_survival_probability": options.equipment_screening_minimum_survival_probability,
        "stat_minimum_survival_probability": options.stats.minimum_survival_probability,
        "global_seed_count": options.global_seed_count,
        "socket_capacity": options.equipment.socket_capacity,
        "fixed_equipment": options.equipment.fixed_equipment,
    })
}

fn json_fingerprint<T: Serialize + ?Sized>(value: &T) -> Result<String> {
    let digest = Sha256::digest(serde_json::to_vec(value)?);
    Ok(format!("{digest:x}"))
}

fn write_json_atomic<T: Serialize + ?Sized>(path: &Path, value: &T) -> Result<()> {
    let temporary = path.with_extension("tmp");
    fs::write(&temporary, serde_json::to_vec_pretty(value)?)?;
    fs::rename(temporary, path)?;
    Ok(())
}

fn read_stage_artifact<T: DeserializeOwned>(
    path: &Path,
    input_fingerprint: &str,
) -> Result<Option<T>> {
    if !path.exists() {
        return Ok(None);
    }
    let metadata_path = path.with_extension("meta.json");
    let metadata: StageMetadata = serde_json::from_str(
        &fs::read_to_string(&metadata_path)
            .with_context(|| format!("missing metadata for {}", path.display()))?,
    )?;
    if metadata.input_fingerprint != input_fingerprint {
        bail!("stage artifact inputs do not match: {}", path.display());
    }
    Ok(Some(serde_json::from_str(&fs::read_to_string(path)?)?))
}

fn write_stage_artifact<T: Serialize + ?Sized>(
    path: &Path,
    input_fingerprint: &str,
    value: &T,
) -> Result<()> {
    write_json_atomic(path, value)?;
    write_json_atomic(
        &path.with_extension("meta.json"),
        &StageMetadata {
            input_fingerprint: input_fingerprint.to_owned(),
        },
    )
}

fn run_checkpointed_inference(
    catalogs: &Catalogs,
    initial: BuildCatalog,
    options: &InferenceOptions,
    path: &Path,
) -> Result<Value> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)?;
    }
    let input_fingerprint = json_fingerprint(&initial)?;
    let settings = inference_settings(&initial, options);
    let mut state = if path.exists() {
        let data = fs::read_to_string(path)?;
        let state = serde_json::from_str::<InferenceCheckpoint>(&data)?;
        if state.settings != settings || state.input_fingerprint != input_fingerprint {
            bail!("checkpoint inputs or settings do not match the requested inference run");
        }
        state
    } else {
        InferenceCheckpoint {
            input_fingerprint: input_fingerprint.clone(),
            settings,
            catalog: initial,
            rounds: Vec::new(),
            completed_rounds: 0,
            converged: false,
            promoted_seeds: None,
        }
    };
    while state.completed_rounds < options.maximum_rounds && !state.converged {
        let mut round_options = options.clone();
        round_options.maximum_rounds = 1;
        let promoted_seeds = state.promoted_seeds.take();
        let result = endogenous_equipment_search_with_screening(
            catalogs,
            &state.catalog,
            &round_options,
            promoted_seeds,
            |_, promoted| {
                let pending = InferenceCheckpoint {
                    input_fingerprint: state.input_fingerprint.clone(),
                    settings: state.settings.clone(),
                    catalog: state.catalog.clone(),
                    rounds: state.rounds.clone(),
                    completed_rounds: state.completed_rounds,
                    converged: state.converged,
                    promoted_seeds: Some(promoted.to_vec()),
                };
                write_inference_checkpoint(path, &pending)?;
                eprintln!(
                    "configuration round {}: promoted {} screening seeds",
                    state.completed_rounds + 1,
                    promoted.len()
                );
                Ok(())
            },
        )?;
        let mut round = result
            .rounds
            .into_iter()
            .next()
            .ok_or_else(|| anyhow::anyhow!("inference round produced no report"))?;
        state.completed_rounds += 1;
        round.round = state.completed_rounds;
        let added_count = round.added.len();
        let no_admission = round.added.is_empty();
        state.catalog = result.catalog;
        state.converged = result.converged;
        state.promoted_seeds = None;
        state.rounds.push(serde_json::to_value(round)?);
        write_inference_checkpoint(path, &state)?;
        eprintln!(
            "configuration round {}: catalog {}, admitted {}",
            state.completed_rounds,
            state.catalog.len(),
            added_count
        );
        if no_admission {
            break;
        }
    }
    let analysis = analyze_build_catalog(catalogs, &state.catalog)?;
    let final_support = prune_report_support(
        &analysis.inferred_meta.weights,
        options.opponent_pruning_tolerance,
    )?;
    Ok(json!({
        "input_fingerprint": state.input_fingerprint,
        "settings": state.settings,
        "catalog": state.catalog,
        "rounds": state.rounds,
        "converged": state.converged,
        "final_equilibrium": analysis.inferred_meta.clone(),
        "final_support": final_support,
        "analysis": analysis,
    }))
}

fn prune_report_support(
    weights: &[legacy_combat_sim::analysis::StrategyWeight],
    tolerance: f64,
) -> Result<Vec<legacy_combat_sim::analysis::StrategyWeight>> {
    Ok(legacy_combat_sim::inference::prune_opponent_mixture(weights, tolerance)?.retained)
}

fn write_inference_checkpoint(path: &Path, state: &InferenceCheckpoint) -> Result<()> {
    let temporary = path.with_extension("tmp");
    fs::write(&temporary, serde_json::to_vec_pretty(state)?)?;
    fs::rename(temporary, path)?;
    Ok(())
}

fn print_report(report: &Report, format: OutputFormat) -> Result<()> {
    match format {
        OutputFormat::Json => println!("{}", serde_json::to_string_pretty(report)?),
        OutputFormat::Table => {
            println!("{} ({})", report.build_name, report.build);
            println!("seed: {}", report.seed);
            println!(
                "{:<34} {:>9} {:>9} {:>9} {:>9}",
                "enemy", "win", "loss", "draw", "win rate"
            );
            for matchup in &report.matchups {
                println!(
                    "{:<34} {:>9} {:>9} {:>9} {:>8.2}%",
                    matchup.enemy,
                    matchup.wins,
                    matchup.losses,
                    matchup.draws,
                    matchup.win_rate * 100.0
                );
            }
        }
    }
    Ok(())
}
