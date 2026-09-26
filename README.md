# Legacy Combat Simulator

[![CI](https://github.com/rodmk/legacy_combat_sim/actions/workflows/ci.yml/badge.svg)](https://github.com/rodmk/legacy_combat_sim/actions/workflows/ci.yml)

Combat simulation and meta-inference tools for [Legacy](https://www.legacy-game.net), implemented in Rust.

## CLI

Run Monte Carlo simulations for a catalog build against the bundled Shadow Dojo enemy set:

```sh
cargo run --release -- simulate \
  --build CurrentBuild \
  --enemy-set shadow-dojo \
  --fights 100000 \
  --seed 42
```

Use `--format json` for machine-readable output. Select individual enemies by repeating `--enemy`, or load additional schema-compatible build catalogs by repeating `--catalog path/to/builds.json`.

List bundled builds:

```sh
cargo run -- list-builds
```

Suggest builds against the bundled sample of active players:

```sh
cargo run --release -- suggest --build CurrentBuild --workers 2 > suggestions.json
```

The command scores the current build and every observed build against the sample,
then refines a small set of distinct equipment concepts. The final scores are
exact win-plus-half-draw averages against all sampled opponents. Without observed
encounter counts, each sample has equal weight. Use `--weights weights.json` to
provide a JSON object mapping opponent build keys to relative encounter counts;
omitted opponents receive zero weight. `--search-seeds 0` reports exact scores
without refinement. By default, refinement adjusts crystals, allocated stats,
and attack mode while retaining each seed's equipment concept. `--vary-equipment`
also searches neighboring base items and weapon modifications at higher cost.
The two strongest coarse responses receive finer stat refinement by default.
Results include distinct equipment concepts, directional offense and defense
scores, per-opponent score dispersion, and leave-one-opponent-out sensitivity.

To search only builds your inventory can equip, fill in the local `inventory.json`
and run `cargo run --release -- suggest --inventory inventory.json --build CurrentBuild`.
Repeat `--enemy-set` to combine opponent sets, for example
`--enemy-set live-samples --enemy-set shadow-dojo`.
Use `--inventory-first` to screen every owned base-equipment combination before
selecting concepts for crystal and stat refinement; `--search-seeds` controls how
many concepts receive that refinement.
The file is gitignored. Each map contains catalog keys and quantities, for example:

```json
{
  "items": {"DarkLegionArmor": 1, "RiftGun": 2, "BioSpinalEnhancer": 2},
  "crystals": {"CorruptedWater": 4, "AmuletCrystal": 8, "CorruptedPink": 3, "PerfectPink": 5},
  "mods": {}
}
```

Those counts are illustrative; list everything you own before searching. Items,
crystals, and weapon mods are counted across the entire five-slot build. The
starting `--build` must be owned, while sampled opponents need not be. Inventory
search can change base items and fill fewer than four sockets when supplies are
limited. Unknown inventory keys and insufficient quantities are reported as errors.

Generate the global configured candidate catalog by screening every canonical
five-item equipment signature. The bundled entry-level Crystal Swords build is
the default proxy opponent for this discovery stage:

```sh
cargo run --release -- generate-candidates > candidate-builds.json
```

The generator preserves global leaders and equipment-family diversity across
all six weapon profiles, then specializes crystals, allocated stats, and attack
mode for the retained signatures. Its shortlist sizes and socket capacity are
configurable through command-line options.

Meta solving starts from this endogenously generated candidate catalog. The
entry-level proxy and the Shadow Dojo builds are benchmarks for discovery and
validation; neither is the strategic kernel or the initial meta archive.

Resolve the meta end to end with the native orchestration command:

```sh
cargo run --release -- resolve-meta \
  --directory .local/rust-meta \
  --workers 1 > resolved-meta.json
```

The workflow generates and solves the initial candidate pool, closes supported
equipment configurations, generates a new candidate region against the current
mixture, screens and confirms diverse global challengers, and repeats until a
global challenge admits nothing. The work directory contains atomic checkpoints
for candidate rounds, configuration rounds, promoted screening seeds, and global
cycles. Promising seeds are confirmed first; a no-admission pass confirms every
remaining seed before closure. Reusing the command resumes matching work; input
fingerprints and the settings manifest reject incompatible artifacts. Increase
`--workers` only when additional CPU and memory use is acceptable.

Solve the generated pool with an active archive seeded by one candidate from
each weapon profile:

```sh
cargo run --release -- solve-candidates \
  --candidate-catalog candidate-builds.json \
  --checkpoint candidate-meta-state.json > candidate-meta.json
```

The solver checkpoints every completed round, admits profitable candidates from
the inactive pool, and stops when no response clears the configured tolerance.

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

Explore local response closure for a selected restricted archive:

```sh
cargo run --release -- infer \
  --enemy-set shadow-dojo \
  --checkpoint inference-state.json \
  --max-rounds 16 > inferred-meta.json
```

Each inference round records the pre-admission equilibrium, safely pruned opponent mass, response-search termination reason, and admitted builds. The final report contains the expanded build catalog and its exact restricted-game analysis.
This command does not replace endogenous candidate generation when solving the
global meta. A Shadow Dojo run measures closure around that benchmark archive;
it is not a global-meta seed.
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
