---
title: Mining and refining
order: 6
group: Economy
summary: Rock types, mining tools and how hard a rock is, what each ore is worth, and how refining turns ore into plate.
checked: 2026-11-04
sources: data/mining.json, data/recipes.json (refining), data/items.json, server/src/game/Mining.ts, common/src/econ/mining.ts, traces.ts, rocks.ts, items.ts, common/src/econ/quests.ts (SKILLS), server/src/game/Party.ts, data/unlocks.json
---
<!-- TODO: the "about 0.7 ore units a second" for a Mining Laser is 42 damage a second (tuning miner.dps) times yield 1.6 divided by 96 (damagePerUnit). Not measured in the game: a material's output may scale the beam's damage. -->
<!-- TODO: the Bore (steel, level 10) shares the Mining Laser's yield and hardness in data; what it does better is not confirmed beyond being a grade II tool. Described here only as a grade II miner. -->

## How mining works

Aim at an asteroid and hold fire. Ore breaks off in chunks. Fly through a chunk to scoop it into your hold. Each unit takes 1 hold space.

- **Guns** crack soft rock: hardness 1 only, and slowly.
- A **Mining Laser** (level 0) is the proper tool. If your ship has one, the **right mouse button** runs it. The left button fires your guns.
- A **Demolition Launcher** (level 8) fires charges that stick to rock and blow it open, and it cracks the hardest rock. It uses mining charges from your hold.
- A **Siphon** (level 12) drinks gas from gas pockets.

Rest your cursor on a rock to see roughly what it holds. A **Scanner** reads the exact shares and finds gem seams.

The amount of ore a hit frees is:

`ore units = damage × the tool's yield × efficiency ÷ 12`

| Tool | Yield | Hardest rock |
|---|---|---|
| Mining Laser | 1.6 | 2 |
| Demolition charge | 2.5 | 3 |
| Fixed gun | 0.06 | 1 |
| Turret | 0.04 | 1 |
| Beam laser (Glint, Cutter) | 0.275 | 2 |
| Lance, Phase, Prism | 0.06 to 0.1 | 3 |
| Siphon (gas only) | 1.4 | 1 |

A Mining Laser does 42 damage a second to rock, which is about 0.7 ore units a second at full efficiency.

If a rock is too hard for your tool the game tells you, and the ore it cannot crack stays in the rock.

### Efficiency: laser grade against system danger

A mining laser's efficiency depends on its grade against the **danger** of the system the rock is in.

| Laser grade minus system danger | −2 or less | −1 | 0 | +1 | +2 |
|---|---|---|---|---|---|
| Efficiency | 8% | 35% | 100% | 120% | 130% |

The starter Mining Laser is grade I, so it is full strength only in danger 1 systems (Sol, Ashfall). In a danger 2 system it gets 35%, and in danger 3 and up 8%. Bring a better grade: a steel **Bore** (level 10) is grade II. Guns are not affected by this.

### Skills, wingmates, XP

- The **Mining** skill (**K**) gives a chance of an extra unit with every unit mined. 1 point is worth 8%; 5 points 33%; 10 points 52%; 20 points 70%. Each point is worth 0.9 times the one before.
- Each wingmate within 3,000 units adds 8% mining yield. See [Parties and chat](/guides/parties-and-chat).
- Every unit mined gives 0.35 XP. Rocks come back 300 seconds after they break.
- Heavy loads slow you: a full 30-unit hold of ore adds about a fifth of a Sparrow T's mass.

## Rock types

There are 19 rock types. Every rock has a hardness (1 to 3) and a mix of ores. The tool must be at least as hard as the rock, and ore harder than the tool is left behind.

| Rock | Hardness | Ore mix (relative weights) |
|---|---|---|
| Chondrite | 1 | Iron 60, nickel 25, silicate 15, copper 10 |
| Ice Body | 1 | Ice 65, hydrazine slush 20, silicate 15 |
| Carbonaceous Rock | 1 | Ice 40, iron 35, silicate 20, helium-3 5 |
| Comet | 1 | Ice 80, helium-3 15 |
| Ashback Boulder | 1 | Iron 55, nickel 25, silicate 20 |
| Aurora Floe | 1 | Ice 45, aurora rime 35, silicate 20 |
| Gas Pocket | 1 | Cryo gas 65, hydrazine slush 35 (needs a Siphon) |
| Crystal Geode | 2 | Silicate 45, crystal 30, copper 20 |
| Cuprite | 2 | Copper 70, iron 20, nickel 10 |
| Rutile | 2 | Titanium 60, iron 40 |
| Slag Ball | 2 | Iron 40, ferrite 40, nickel 20 |
| Polymer Tar | 2 | Polymer precursor 70, copper 30 |
| Leestone Shard | 2 | Leestone ore 45, iron 35, ferrite 20 |
| Neutron Slug | 2 | Iron 35, titanium 35, nickel 20, ferrite 8, cobalt 6, neutronium 2, leestone ore 2 |
| Gem Seam | 3 | Crystal 60, silicate 40, plus gems |
| Chromite Nodule | 3 | Chromite 50, iron 50 |
| Cobaltite | 3 | Cobalt 70, iron 30 |
| Platinoid Shard | 3 | Platinoid 80, crystal 20 |
| Opal Husk | 3 | Crystal 70, titanium 20, void opal 10 |

Ore hardness: titanium, crystal, ferrite and leestone ore are 2; cobalt, neutronium, chromite, platinoid and void opal are 3; everything else is 1.

About one belt rock in 130 is an **outlier**, 3.5 to 4.5 times the normal size, mined down through four stages. They are four times as common in the Ashfall Drift.

### Where to find them

Each belt has its own mix. A system's danger also boosts the richer ores:

| System danger | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|
| Titanium | ×1 | ×1 | ×1.4 | ×1.7 | ×2.2 | ×1 | ×1 |
| Cobalt | ×1 | ×1 | ×1 | ×1.6 | ×2.5 | ×3.5 | ×5 |
| Neutronium | none | none | none | ×0.3 | ×0.6 | ×2.5 | ×4 |
| Gem seam chance | 5% | 8% | 10% | 12% | 15% | 18% | 24% |

Neutronium ore, the stuff of Mk V plate, only drops in danger 4 and above.

| Belt | Main rocks |
|---|---|
| Sol | Chondrite, ice, carbonaceous, a few crystal geodes and comets |
| Ashfall Drift | Chondrite, ice, carbonaceous, Ashback boulders, cuprite |
| Borealis | Ice, carbonaceous, comets, gas pockets, Aurora floes |
| Glasswater | Crystal, ice, cuprite, comets, gem seams |
| Nebula Prime | Cuprite, chondrite, rutile, polymer tar, crystal, gas pockets |
| Cinder Reach | Chondrite, rutile, slag, cobaltite, chromite |
| The Maw | Slag, neutron slugs, opal husks, Leestone shards |
| Void Sector | Neutron slugs, cobaltite, platinoid, opal husks, chromite |

## What ore is worth

Stations buy at 60% of an item's base value (before demand and saturation: see [Trade, jobs and credits](/guides/trade-jobs-and-credits)).

| Ore | Base value | Ore | Base value |
|---|---|---|---|
| Iron | 2 | Chromite | 16 |
| Silicate | 2 | Cobalt | 18 |
| Ice | 2 | Leestone ore | 22 |
| Nickel | 3 | Crystal | 25 |
| Hydrazine slush | 4 | Platinoid | 30 |
| Copper | 6 | Neutronium | 34 |
| Ferrite | 8 | Helium-3 | 40 |
| Polymer precursor | 9 | Ruby | 60 |
| Titanium | 10 | Sapphire | 70 |
| Cryo gas | 14 | Emerald | 120 |
| Aurora rime | 14 | Void opal | 220 |

Gems come from gem seams: each unit has a 30% chance of being a gem, and a seam needs a tool hard enough for the gem.

## Refining

Ore is useless in a hull until it is refined. Dock at a station with a **refinery** and put a batch in the queue. Refining takes time, carries on while you are away, and finished batches go to your storage. You have **8 queue slots**.

| Plate | Inputs | Time per batch | Needs |
|---|---|---|---|
| Alloy plate | 2 iron ore, 1 nickel ore | 2 s | |
| Composite sheet | 2 silicate, 1 ice | 2 s | |
| Copper wire (makes 2) | 1 copper ore | 1 s | |
| Steel plate | 4 iron ore, 2 nickel ore | 4 s | |
| Titanium plate | 4 titanium ore, 1 nickel ore | 8 s | |
| Crystal lens | 1 crystal, 2 silicate | 5 s | |
| Cobalt alloy | 5 cobalt ore, 3 nickel ore | 15 s | |
| Neutronium plate | 6 neutronium ore, 3 cobalt ore | 30 s | |
| Coolant | 2 ice | 2 s | |
| Propellant | 2 hydrazine slush | 3 s | |
| Insulated polymer | 3 polymer precursor, 1 copper wire | 6 s | Level 10 |
| Ferrite plate | 4 ferrite ore, 1 iron ore | 8 s | Level 30 |
| Leestone | 4 leestone ore | 10 s | |
| Leestone plate | 2 leestone, 1 steel plate | 15 s | Level 12 |

Which stations have a refinery is in [Stations and services](/guides/stations-and-services). Hull, armour and cargo holds are built straight from plate in the hangar, and a part's recipe lists the plate it needs. Storage is shared between every station.

### Rare traces

Four rare materials never drop from rocks. They come out of their **carrier ore** at the refinery, in small amounts that depend on the danger of the system the ore was mined in.

| Trace | Comes from | Per 100 units refined, danger 3 / 4 / 5 |
|---|---|---|
| Aurum | Copper ore, platinoid ore | 0.6 / 1.2 / 2 |
| Voidglass | Crystal | 0.4 / 0.9 / 1.5 (three times in gem seams) |
| Pale iridium | Ice, slush, polymer precursor, helium-3 | 0.05 / 0.5 / 1.2 |
| Singularity dust | Neutronium, cobalt, titanium from neutron slugs only | none / 0.1 / 0.5 |

Aurum, voidglass and iridium are refined into ingots and panes used for gems and some advanced parts. A comet passes Sol and Borealis for 2 hours every 3 days, and while it does its rocks carry traces at the danger 4 rate.
