#![warn(missing_docs)]

//! Reusable combat rules and catalog loading for the Legacy combat simulator.
//!
//! The crate separates JSON-backed build materialization from combat execution.
//! [`catalog::Catalogs`] turns build definitions into role-specific [`model::Player`]
//! values; [`combat::simulate`] runs those values through the Monte Carlo model.
//!
//! ```
//! use legacy_combat_sim::catalog::Catalogs;
//! use legacy_combat_sim::combat;
//! use rand::rngs::SmallRng;
//! use rand::SeedableRng;
//!
//! # fn main() -> anyhow::Result<()> {
//! let catalogs = Catalogs::bundled()?;
//! let matchup = catalogs.materialize_matchup(
//!     catalogs.build("DualVoidBowsWithScouts")?,
//!     catalogs.build("ShadowDojoDLGunBuild2")?,
//! )?;
//! let mut rng = SmallRng::seed_from_u64(42);
//! let result = combat::simulate(&matchup.active, &matchup.opponent, 100_000, &mut rng);
//! assert_eq!(result.player1_wins + result.player2_wins + result.draws, 100_000);
//! # Ok(())
//! # }
//! ```

/// JSON catalog loading and build materialization.
pub mod catalog;
/// Monte Carlo combat rules and probability helpers.
pub mod combat;
/// Shared domain types used by catalogs and simulation.
pub mod model;
