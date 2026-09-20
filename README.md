Legacy Combat Simulator
=======================

[![CI](https://github.com/rodmk/legacy_combat_sim/actions/workflows/ci.yml/badge.svg)](https://github.com/rodmk/legacy_combat_sim/actions/workflows/ci.yml)

Combat simulator for Legacy (http://www.legacy-game.net).

Weapon Mods
===========

Weapon mods enforce their compatible weapons and upgrade slots when applied:

```js
const { Item, WeaponMod } = require('./combatsim');

const bioGun = Item.BioGunMk4.applyMods([
  WeaponMod.FasterReload4,
  WeaponMod.FasterAmmo4,
]);
```

Builds
======

Complete stat allocations and loadouts are split across schema-compatible JSON catalogs. `Build` merges the configured catalogs for direct lookup:

```js
const { Build, Player } = require('./combatsim');

const player = Player.generateBuild(Build.DualVoidBowsWithScouts);
```

`BuildCatalogs` preserves the individual catalogs, and callers can supply any catalog list when generating an opponent set:

```js
const { BuildCatalogs, Player, mergeBuildCatalogs } = require('./combatsim');

const builds = mergeBuildCatalogs(BuildCatalogs);
const opponents = Player.generateReferencePlayers(BuildCatalogs);
```

Seed frontier analysis
======================

Analyze the imported game-simulator builds with exact, initiative-neutral matchups:

```sh
yarn analyze:seed > seed-analysis.json
```

The report groups combat-equivalent builds, identifies the initial matchup-vector frontier, iteratively removes dominated strategies to a stable strategic kernel, and identifies pure maximin candidates. It includes each elimination round, scores, draw rates, exploitability, limiting opponents, HP loss, healing cost, credits per win, and the restricted matchup matrices. Overall expected HP loss treats defeat as zero remaining HP; separate win metrics report expected HP and credits spent conditional on winning. Healing cost is modeled as the missing HP divided by six and rounded to the nearest credit, with a five-credit premium when reviving from zero HP.

Inspect the legal stat-allocation space for the seed-kernel loadout with speed compressed to initiative thresholds:

```sh
yarn analyze:allocations > allocation-analysis.json
```

Run the minimum-HP allocation search for the seed-kernel loadout:

```sh
yarn search:min-hp > minimum-hp-search.json
```

The broad search stops propagating combat tails below one-in-a-million probability. It then evaluates the surviving combat and economy frontier candidates exactly.

Search unrestricted legal stat allocations for the same loadout with 11, 5, 2, and 1-point grids:

```sh
yarn search:stats > stat-search.json
```

Each refinement explores the neighborhoods of the preceding combat and economy frontiers. One-point expansion continues until no unseen frontier neighbors remain, and the final frontier candidates are evaluated exactly.

Search-space census
===================

Measure canonical weapon pairs, skill-conditioned misc pairs, armor variants, and their symbolic package cross-products without materializing the complete package space:

```sh
yarn --silent analyze:search-space > search-space-census.json
```

The report separates raw combinations, combat-equivalent effects, and variants removed by proven componentwise dominance. Dominance scans have an explicit comparison budget and report whether they completed; unexamined variants are retained conservatively. Each weapon profile also compares a fixed stat allocation with coarse conditional stat and attack optimization followed by exact finalist evaluation.

Treat the five base equipment items and weapon mods as a signature, with crystals, allocated stats, and attack type inside its attainable specialization region:

```sh
yarn --silent analyze:regions > attainable-regions.json
```

The report counts the complete equipment-signature space, samples strict region-envelope dominance, and compares a safe opponent-conditioned relaxation with configured crystal and stat specialization. The relaxation combines independently attainable maxima, so its score is an upper bound rather than a legal build. It first scores every signature with a cheap matchup proxy and retains both global leaders and leaders within armor-and-weapon diversity buckets. A second proxy pass evaluates legal directional crystal loadouts jointly with representative stat allocations and attack types, retaining global leaders plus one representative from each weapon-pair family. Conditioned proxy screens drop at most 2% opponent weight by default; promoted signatures are configured against the more precise meta support. Promoted signatures are then configured with the more expensive search and compared with control samples; this measures screening yield, not exhaustive recall.

Export the second-stage finalists and solve their restricted game with a checkpointed best-response search:

```sh
REGION_REPORT=attainable-regions.json yarn --silent export:region-candidates > data/meta-candidate-builds.json
yarn --silent search:candidate-meta
yarn --silent export:candidate-meta
META_VALIDATION_MAX_ITERATIONS=2 yarn --silent validate:candidate-meta
```

The candidate search starts with one leader from each weapon profile, solves the exact game over the active archive, and evaluates the remaining pool against the inferred opponent mixture. Approximate combat bounds select a small set of exact finalists each round. Build matchups average both roles: a build attacks with its selected mode and defends with normal-mode speed, accuracy, and dodge. `Player.generateBuildMatchup` materializes the directional roles for stat-based callers, and `CombatSim.simulateBuildCombat` supplies the same role-aware materialization to Monte Carlo simulation while `CombatSim.simulateCombat` remains a low-level stat interface.

When a conditioned global screen expands the catalog, `CANDIDATE_META_INITIAL_REPORT` starts the next restricted solve from the preceding equilibrium support. Zero-weight archive members remain in the candidate pool and can re-enter if the new mixture makes them a best response.

The independent validation search starts from equilibrium builds but may move outside the fixed candidate archive. A high validation score means the restricted equilibrium is not a credible global meta, even if its archived best-response loop converged.

`search:equipment-configurations` holds each seed's five items and weapon mods fixed while jointly optimizing crystals, stats, and attack mode against the current role-averaged equilibrium. Supply a seed catalog with `CONFIGURATION_SEED_CATALOG`, optionally restrict it with `CONFIGURATION_SEED_IDS`, or use a validation result as the seed with `CONFIGURATION_VALIDATION_REPORT`.

`search:configuration-meta` closes that oracle over the restricted meta. It checkpoints the strategy catalog and each completed round in SQLite, solves the current equilibrium, and screens every equipment signature carrying retained equilibrium weight with one coarse joint-search iteration. Signatures scoring above `0.505` receive full confirmation, and up to two novel configurations confirmed above `0.51` are admitted. A round with no confirmed admission is practical convergence; its strongest rejected response is retained as residual exploitability. Independent equipment signatures run in a bounded worker pool; set `CONFIGURATION_META_WORKERS` to tune its size. Set `CONFIGURATION_META_DB` to resume a run and `CONFIGURATION_META_REPORT` to export its catalog and round history.

The archived configuration-meta run converged after 16 rounds with 27 strategies; its final confirmation covered three supported equipment signatures and admitted no novel response above `0.501`. The report is stored in `data/configuration-meta.json`. On the benchmark machine, parallel signature search reduced that final confirmation round from 242.3 seconds to 129.7 seconds.

Challenge a configuration meta with unconstrained equipment discovery, then fully configure the strongest differentiated package from each weapon profile:

```sh
REGION_OPPONENT_CATALOG=data/configuration-meta.json \
REGION_OPPONENT_REPORT=data/configuration-meta.json \
yarn --silent analyze:regions > global-regions.json

GLOBAL_CHALLENGE_REGIONS=global-regions.json \
GLOBAL_CHALLENGE_REPORT=global-challenge.json \
GLOBAL_CHALLENGE_CATALOG=global-challengers.json \
yarn --silent search:global-meta-challenge
```

The global challenge jointly configures three leaders per weapon profile by default, preferring distinct weapon pairs before filling the remaining places by score. It admits at most two profitable responses with distinct five-item equipment signatures. Continue the equilibrium from the preceding artifact by passing its challenger catalog to the configuration-meta search:

```sh
CONFIGURATION_META_INITIAL_REPORT=data/configuration-meta.json \
CONFIGURATION_META_EXTRA_CATALOG=global-challengers.json \
CONFIGURATION_META_DB=.local/global-meta-v2.sqlite \
CONFIGURATION_META_REPORT=global-meta-v2.json \
yarn --silent search:configuration-meta
```

`data/global-meta-challenge.json` records the first global challenge. Its strongest response scores `0.55838`, and `data/global-meta-v2.json` records the resulting 39-strategy equilibrium after five response rounds plus a practical-convergence screen. A fresh global closure cycle then screened three weapon-pair-diverse leaders from every profile against that final mixture. None cleared the `0.505` confirmation threshold; the strongest screened response scored `0.46860`.

Local configuration closure can change the equilibrium enough to make a previously screened equipment family profitable. `search:global-meta-loop` therefore alternates a complete conditioned equipment screen, diversified global challenge, and local configuration closure until a fresh global challenge admits nothing. Each cycle is checkpointed beneath `GLOBAL_META_LOOP_DIRECTORY`; `GLOBAL_META_LOOP_INITIAL_REPORT` selects the starting meta and `GLOBAL_META_LOOP_REPORT` exports the final catalog together with its global-closure history. A configuration-meta report's `converged` field describes only local closure. The loop's `global_search.globally_closed` field records the stronger stopping condition.

The global region screen defaults to the controlled entry-level kernel. Set `REGION_OPPONENT_CATALOG` and `REGION_OPPONENT_REPORT` to condition it on a current equilibrium instead. The report must contain a `support` array of candidate IDs and weights, and the catalog supplies those builds. `REGION_BASE_CATALOG` preserves the existing strategy archive when exporting the newly conditioned candidates, while `REGION_CANDIDATE_PREFIX` gives each expansion distinct IDs. Repeating this screen after each restricted-game solve makes candidate discovery depend on the emerging meta rather than the reference-build fixtures.

Development
===========

Install dependencies with `yarn install`. Run linting, tests, catalog schema
validation, and static type checks with `yarn verify`. The same checks run
before each commit and in CI.

License
=======

The MIT License (MIT)

Copyright (c) 2014 Rodrigo Muñoz

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
