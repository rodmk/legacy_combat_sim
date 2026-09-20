use std::path::PathBuf;

use anyhow::{bail, Result};
use clap::{Parser, Subcommand, ValueEnum};
use legacy_combat_sim::catalog::Catalogs;
use legacy_combat_sim::combat;
use legacy_combat_sim::model::CombatRole;
use rand::rngs::SmallRng;
use rand::SeedableRng;
use serde::Serialize;

#[derive(Debug, Parser)]
#[command(version, about)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
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
        /// Seed for reproducible simulations.
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

#[derive(Debug, Serialize)]
struct Report {
    build: String,
    build_name: String,
    seed: u64,
    matchups: Vec<MatchupReport>,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::ListBuilds { catalogs } => {
            let catalogs = load_catalogs(&catalogs)?;
            for key in catalogs.build_keys() {
                println!("{key}");
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
            let player = catalogs.materialize(build_definition, CombatRole::Attacker)?;
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
                let opponent = catalogs.materialize(enemy_build, CombatRole::Defender)?;
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
