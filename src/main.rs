use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Result};
use clap::{Parser, Subcommand, ValueEnum};
use legacy_combat_sim::analysis::analyze_build_catalog;
use legacy_combat_sim::catalog::{BuildCatalog, Catalogs};
use legacy_combat_sim::combat;
use legacy_combat_sim::inference::{endogenous_equipment_search, InferenceOptions};
use legacy_combat_sim::model::{AttackType, BuildDefinition, CombatSignature, MatchupRole};
use legacy_combat_sim::search::{
    joint_equipment_stat_response_beam, AdaptiveStatOptions, EquipmentNeighborhoodOptions,
};
use rand::rngs::SmallRng;
use rand::SeedableRng;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Parser)]
#[command(version, about)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
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
    settings: Value,
    catalog: BuildCatalog,
    rounds: Vec<Value>,
    completed_rounds: usize,
    converged: bool,
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
        } => {
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
                joint_maximum_iterations: max_iterations,
                global_seed_count: global_seeds,
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
    let settings = json!({
        "initial_ids": initial.keys().collect::<Vec<_>>(),
        "batch_size": options.batch_size,
        "improvement_tolerance": options.improvement_tolerance,
        "opponent_pruning_tolerance": options.opponent_pruning_tolerance,
        "beam_width": options.beam_width,
        "expansion_width": options.expansion_width,
        "joint_maximum_iterations": options.joint_maximum_iterations,
        "global_seed_count": options.global_seed_count,
        "socket_capacity": options.equipment.socket_capacity,
        "fixed_equipment": options.equipment.fixed_equipment,
    });
    let mut state = if path.exists() {
        let data = fs::read_to_string(path)?;
        let state = serde_json::from_str::<InferenceCheckpoint>(&data)?;
        if state.settings != settings {
            bail!("checkpoint settings do not match the requested inference settings");
        }
        state
    } else {
        InferenceCheckpoint {
            settings,
            catalog: initial,
            rounds: Vec::new(),
            completed_rounds: 0,
            converged: false,
        }
    };
    while state.completed_rounds < options.maximum_rounds && !state.converged {
        let mut round_options = options.clone();
        round_options.maximum_rounds = 1;
        let result = endogenous_equipment_search(catalogs, &state.catalog, &round_options)?;
        let mut round = result
            .rounds
            .into_iter()
            .next()
            .ok_or_else(|| anyhow::anyhow!("inference round produced no report"))?;
        state.completed_rounds += 1;
        round.round = state.completed_rounds;
        let no_admission = round.added.is_empty();
        state.catalog = result.catalog;
        state.converged = result.converged;
        state.rounds.push(serde_json::to_value(round)?);
        let temporary = path.with_extension("tmp");
        fs::write(&temporary, serde_json::to_vec_pretty(&state)?)?;
        fs::rename(temporary, path)?;
        if no_admission {
            break;
        }
    }
    let analysis = analyze_build_catalog(catalogs, &state.catalog)?;
    Ok(json!({
        "catalog": state.catalog,
        "rounds": state.rounds,
        "converged": state.converged,
        "analysis": analysis,
    }))
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
