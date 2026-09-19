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
