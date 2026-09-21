# Legacy Combat Simulator

[![CI](https://github.com/rodmk/legacy_combat_sim/actions/workflows/ci.yml/badge.svg)](https://github.com/rodmk/legacy_combat_sim/actions/workflows/ci.yml)

Combat simulation and meta-inference tools for [Legacy](https://www.legacy-game.net), implemented in Rust.

## CLI

Run Monte Carlo simulations for a catalog build against the bundled Shadow Dojo enemy set:

```sh
cargo run --release -- simulate \
  --build DualVoidBowsWithScouts \
  --enemy-set shadow-dojo \
  --fights 100000 \
  --seed 42
```

Use `--format json` for machine-readable output. Select individual enemies by repeating `--enemy`, or load additional schema-compatible build catalogs by repeating `--catalog path/to/builds.json`.

List bundled builds:

```sh
cargo run -- list-builds
```

Analyze exact matchups, dominance, and the restricted equilibrium for an enemy set:

```sh
cargo run --release -- analyze --enemy-set shadow-dojo > analysis.json
```

Search equipment, allocated stats, and attack mode jointly:

```sh
cargo run --release -- search \
  --build ShadowDojoDLGunBuild3 \
  --enemy-set shadow-dojo > response.json
```

The search uses bounded approximate distributions to screen candidates and recomputes every reported beam score exactly. Search breadth is controlled with `--beam-width`, `--expansion-width`, `--max-iterations`, and `--socket-capacity`.
Use `--fixed-equipment` to optimize crystals, allocated stats, and attack mode
without replacing the five base items or their weapon modifications.

Close a restricted strategy archive by solving its equilibrium and admitting profitable novel responses:

```sh
cargo run --release -- infer \
  --enemy-set shadow-dojo \
  --checkpoint inference-state.json \
  --max-rounds 16 > inferred-meta.json
```

Each inference round records the pre-admission equilibrium, safely pruned opponent mass, response-search termination reason, and admitted builds. The final report contains the expanded build catalog and its exact restricted-game analysis.
An existing checkpoint is resumed when its settings match. Add
`--global-seeds 12` to screen all base weapon pairs, retain diversified leaders,
and run the joint response oracle from those leaders as well as every supported
equipment concept. Global screening is approximate; every promoted response and
reported score is validated exactly against the full equilibrium mixture.
Use repeated `--initial-build` options instead of `--enemy-set` to start from an
explicit strategy archive.

Run `cargo run -- <command> --help` for all options accepted by a subcommand.

## Library

The crate exposes catalog loading, build materialization, combat simulation, exact outcome distributions, game analysis, response search, and inference as typed Rust APIs. Their contracts document initiative, attack ordering, rounding, equipment, attack-mode, and randomness semantics.

Generate the API documentation with:

```sh
cargo doc --open
```

## Development

The repository requires a stable Rust toolchain. Run the same checks as CI with:

```sh
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
RUSTDOCFLAGS="-D warnings" cargo doc --no-deps
```

## License

MIT
