# Combat model

The simulator models repeated, independent fights between two fully materialized
level-80 builds. It preserves the rules and rounding behavior of the legacy
JavaScript simulator; it does not attempt to infer undocumented game behavior.

## Build materialization

A legal build allocates exactly 183 points. HP and speed require at least two
points, while accuracy and dodge require at least four. HP points grant five HP
and speed points grant five speed. Fully trained characters begin with 5 armor,
50 speed, 10 accuracy, 10 dodge, and 450 in each weapon and defense skill.
Weapons also receive the five-damage Combat Tactics bonus.

Equipment bonuses are additive. When the two weapons use different skill
families, each weapon's contribution to its own skill is doubled. This doubling
does not apply to armor or miscellaneous items.

Weapon modifications are applied to the base weapon before crystals. Within one
modifier group, each bonus is calculated from the same pre-group value, summed,
rounded up, and then added. Crystals use the same rule as a second group. A small
epsilon is subtracted before rounding so an inexact floating-point representation
of an integer does not round to the next integer.

The build's attack mode affects it only while it is the initiating build. A
defending build always uses its normal-mode speed, accuracy, and dodge:

| Mode | Speed | Accuracy | Dodge |
|---|---:|---:|---:|
| normal | 1.0 | 1.0 | 1.0 |
| quick | 1.2 | 0.9 | 0.9 |
| aimed | 0.9 | 1.2 | 0.9 |
| cover | 0.9 | 0.9 | 1.2 |

Each adjusted statistic is rounded up after multiplication, using the same
epsilon convention.

## Fight sequence

The faster player attacks first. On equal speed, the first player supplied by
the caller retains initiative. An attack attempts both weapons and applies their
combined damage. If the defender reaches zero HP, the fight ends immediately and
the defender does not counterattack. Otherwise the defender attacks with both
weapons. A fight that remains unresolved after 100 complete rounds is a draw.

Each weapon first rolls accuracy against dodge. It rolls weapon skill against
defense skill only after a successful accuracy roll. On two successes, base
damage is sampled uniformly from the inclusive weapon damage range and reduced
by armor. The two weapon rolls are independent.

The probability that offense beats defense follows the documented continuous
range formula retained in `combat_probability`. Fractional division is preserved.
Armor uses a level modifier of `min(level, 80) * 7 / 2`; final damage is rounded
to the nearest integer.

## Monte Carlo behavior

The command-line interface uses `SmallRng` and accepts an explicit seed for
repeatable runs with the same compiled dependency versions. Reproducibility is a
debugging convenience, not a stable serialized random stream across dependency
upgrades or architectures.

Each reported matchup consumes one continuing random stream. Consequently,
changing the enemy order changes the samples assigned to later matchups without
changing their underlying probability distribution. Results contain raw win,
loss, and draw counts; callers decide how to score draws or combine opponents.

The simulator is single-threaded. Matchups are independent and can be scheduled
in parallel by a future inference engine without changing combat semantics.

## Known scope

The Rust implementation currently covers build loading, role-specific
materialization, and Monte Carlo win/loss/draw simulation. Exact outcome and HP
distributions, healing costs, combat signatures, game solving, and build search
remain in the JavaScript implementation until migrated deliberately.
