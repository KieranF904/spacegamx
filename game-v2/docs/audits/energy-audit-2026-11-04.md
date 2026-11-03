# Energy audit, 2026-11-04

What the energy system does today, measured, and what was changed. The live game runs the **pool and banks**
(common/src/ships/circuits.ts, energy.ts) for every library, player and enemy design; the **ports core**
(common/src/ships/power/ports.ts) runs only the dev ports ships (`power: 'ports'`), and the touch-routed power core
(power/layout, tick) runs nothing yet. This audit is about the pool and banks unless it says otherwise.

How the numbers were made: every library blueprint rebuilt and run through the real `powerTick`, 60 ticks a second,
from full: guns asking their flat-out draw (`gunDrawFlatOut`, as the hangar's load test does), engines cruising or
boosting. "Full power" is the time to the first tick anything gets less than it asked (`BROWNOUT`, 0.995); "avg" is
the mean share over the last 20 s of a 90 s run (60 s for boosting). The scripts were throwaway (session scratchpad);
scripts/ship-energy.ts covers the enemy designs, and none of them is short.

## How it works (checked against the code)

| Step | What happens | Where |
|---|---|---|
| Generation | Generators make `produce` x cells (x their health). Steady loads (shields, scanners, jump coils, gyros) take theirs at the rebuild, by priority; what is left is `spare` | rebuild.ts section 4 |
| Storage | The **pool** is the core's 240 plus every Battery and Heavy Bank on a powered network; it gives at most 720/s (the core) plus each battery's discharge. **Banks**: touching Capacitors, touching Drive Cells, each giving at most its own rate, only to what it touches | circuits.ts |
| Output | spare + the pool's rate while it holds charge | energy.ts powerTick |
| Order | 1. engines (Drive Cell banks, then the spare stream, then the pool); 2. guns, beams, miners, Tow Beam, Burst Strafer (their banks, then what is left, shared equally); 3. what's left of the stream refills the pool and refilling banks, emptiest first; 4. Pulse Dynamos, 10/s into each bank they touch | energy.ts powerTick |
| Regen timing | Every tick, no delay after use. Refill time is (stores) / (spare), so a big pool on small generation is slow | |
| Shields | A steady load: paid from generation at the rebuild, never from the pool. Their refill (`shieldRegen` a cell after `shieldDelay` unhit) costs nothing more | rebuild.ts section 7 |
| Boost | Engines draw x (1 + 2.2 x boostDrain). Possible while the pool or a Drive Cell bank holds any charge at all | energy.ts powerTick |
| At zero | Engines get their share of the Output (thrust scales by it); a cycle or clip gun reloads at its share, a charge gun charges at it, a beam burns that share of the ticks; mining stops below 0.1%; boost stops while nothing is stored | guns.ts, flight.ts, energy.ts payMining |
| Prediction | `powerTick` runs inside `stepFlight` on the server, in the pilot's prediction and for replicas; the charge rides the pilot row as a percent per group | flight.ts, energy.ts packCharge |

## Library ships (after this change)

| Ship | gen | spare | pool (rate/s) | engines cruise / boost | guns flat out | firing, cruising | boosting: full power, then avg | boosting and firing: guns avg (min) | refill from the boost |
|---|---|---|---|---|---|---|---|---|---|
| Sparrow T | 70 | 70 | 240 (720) | 18 / 58 | 16 | sustained | sustained | 100% | — |
| Prospector | 70 | 70 | 240 (720) | 18 / 58 | 16 | sustained | sustained | 100% | — |
| Arrow | 124 | 124 | 240 (720) | 40 / 110 | 16 | sustained | sustained | 100% | — |
| Drum | 124 | 124 | 240 (720) | 58 / 168 | 24 | sustained | 5.5 s, then 96% | 50% (0%) | 1.9 s |
| Bulwark | 70 | 70 | 240 (720) | 49 / 139 | 32 | 21.9 s, then guns 66% | 3.5 s, then 83% | 66% (0%) | 3.4 s |
| Corsair | 248 | 248 | 240 (720) | 80 / 221 | 96 | sustained | sustained | 77% (32%) | — |
| Lancer Frigate | 768 | 768 | 3,840 (1,920) | 690 / 2,208 | 104 | sustained (store 41% at 90 s) | 2.7 s, then 69% | 75% (0%) | 5.0 s |
| Ceres Hauler | 508 | 508 | 640 (1,920) | 452 / 1,411 | 0 | sustained | 0.7 s, then 70% | 100% | 1.3 s |
| Ark Tender | 508 | 508 | 640 (1,920) | 452 / 1,411 | 0 | sustained | 0.7 s, then 70% | 100% | 1.3 s |
| Galleon | 960 | 960 | 2,040 (1,320) | 676 / 2,128 | 192 | sustained | 1.8 s, then 79% | 50% (0%) | 2.1 s |
| Bastion Dreadnought | 1,152 | 1,152 | 3,840 (1,920) | 756 / 2,349 | 224 | sustained | 3.2 s, then 83% | 50% (0%) | 3.3 s |
| Hammerhead Carrier | 1,152 | 1,152 | 3,840 (1,920) | 788 / 2,486 | 192 | sustained | 2.9 s, then 80% | 50% (0%) | 3.3 s |

Bastion and Bastion Dreadnought are the same design. "Refill" is idle, from where boosting left the stores.

What it says:
- **Guns are cheap; engines are what drains a ship.** Every library ship sustains its guns while cruising except the
  **Bulwark** (70 generation against 49 engines + 32 guns: full power 22 s, then guns at 66%) and the **Lancer**
  (26/s short, about 2.5 min from full). Most guns draw 8-17 E/s against generators of 35/s a cell.
- **Boost is free on small ships and a blip on big ones.** The Sparrow T, Prospector, Arrow and Corsair boost forever
  (their boost draw is under their spare). The haulers (Ceres Hauler, Ark Tender) get 0.7 s; the capital ships 1.8-3.2 s.
- **Boosting while firing starves the guns on any ship whose store runs dry.** Engines are served first, and a boost
  needs only some stored charge, so on an empty store each tick's trickle re-arms the boost, the engines take the whole
  Output, and the guns get nothing that tick. The guns end up at about half rate (Drum, Galleon, Bastion, Hammerhead:
  50%, minimum 0%). The hangar already warned "Boosting while firing: unbanked guns get 0%"; the HUD said nothing.
- **The Galleon's Output is 40/s short of boosting with every gun firing** (2,128 + 192 against 960 + 1,320): its guns
  dip to about 98% from the first tick of a boost. Small; left alone.
- The starter's own test (circuits.test.ts) requires the Sparrow T never to brown out in the scripted fight, so the
  starter boosting for free is a design rule, not a bug.

## Weapons: draw in the pool system

| Weapon | Mk | lvl | model | draw flat out (E/s) | E a shot | DPS | DPS per E/s | copies a Sparrow T sustains | copies a Corsair sustains | flag |
|---|---|---|---|---|---|---|---|---|---|---|
| Pip | 1 | 0 | cycle | 8 | 2 | 56 | 7 | 6.5 | 21.0 |  |
| Hammer | 1 | 6 | cycle | 10 | 7 | 68.6 | 6.9 | 5.2 | 16.8 |  |
| Twinlink | 2 | 12 | clip | 7.7 | 1.5 | 61.9 | 8 | 6.8 | 21.8 |  |
| Longbarrel | 3 | 20 | charge | 10.3 | 36 | 48.6 | 4.7 | 5.0 | 16.3 |  |
| Bastion | 4 | 30 | clip | 16.7 | 30 | 100 | 6 | 3.1 | 10.1 |  |
| Rattler | 1 | 3 | cycle | 12 | 1.4 | 42.9 | 3.6 | 4.3 | 14.0 |  |
| Chainsaw | 2 | 14 | cycle | 22.4 | 1.4 | 80 | 3.6 | 2.3 | 7.5 |  |
| Stinger | 3 | 24 | clip | 7.4 | 1.7 | 35.6 | 4.8 | 7.0 | 22.7 |  |
| Burst | 1 | 4 | ammo | 0 | 5.7 | 25.8 | — | free | free | free (ammo crates; plain rounds when out) |
| Cloudmaker | 2 | 16 | clip | 6.7 | 7.5 | 24.8 | 3.7 | 7.8 | 25.1 |  |
| Lobber | 1 | 7 | ammo | 0 | 15 | 28 | — | free | free | free (ammo crates; plain rounds when out) |
| Quake | 3 | 24 | ammo | 0 | 30 | 42.5 | — | free | free | free (ammo crates; plain rounds when out) |
| Glint | 1 | 9 | cycle | 15 | 27 | 53.3 | 3.6 | 3.5 | 11.2 |  |
| Cutter | 2 | 18 | beam | 32 | 0.5 | 150 | 4.7 | 1.6 | 5.2 |  |
| Searchlight | 3 | 26 | beam | 15 | 0.3 | 25 | 1.7 | 3.5 | 11.2 |  |
| Strobe | 1 | 10 | cycle | 12 | 6 | 54 | 4.5 | 4.3 | 14.0 |  |
| Overpulse | 3 | 25 | clip | 13.3 | 3 | 40 | 3 | 3.9 | 12.6 |  |
| Dart | 1 | 11 | ammo | 0 | 14.4 | 28 | — | free | free | free (ammo crates; plain rounds when out) |
| Swarm | 3 | 21 | ammo | 0 | 14.6 | 36.3 | — | free | free | free (ammo crates; plain rounds when out) |
| Hammerhead | 4 | 33 | ammo | 0 | 51.3 | 44.1 | — | free | free | free (ammo crates; plain rounds when out) |
| Needle | 2 | 13 | ammo | 0 | 55 | 49.6 | — | free | free | free (ammo crates; plain rounds when out) |
| Coilgun | 3 | 22 | cycle | 15.6 | 14 | 88.9 | 5.7 | 3.3 | 10.8 |  |
| Spear | 4 | 28 | cycle | 63.2 | 120 | 84.2 | 1.3 | 0.8 | 2.7 | one can't be sustained on a starter; 4x its tier peers' draw |
| Hush | 2 | 15 | cycle | 9.3 | 25 | 1.1 | 0.1 | 5.6 | 18.1 | utility/effect: DPS is not its job |
| Blackout | 4 | 35 | charge | 16.4 | 90 | 0.5 | 0 | 3.2 | 10.2 | utility/effect: DPS is not its job |
| Spark | 2 | 17 | cycle | 18 | 13.5 | 38.5 | 2.1 | 2.9 | 9.3 |  |
| Tesla | 4 | 29 | beam | 30 | 0.5 | 70 | 2.3 | 1.7 | 5.6 |  |
| Eel | 2 | 19 | ammo | 0 | 96 | 117 | — | free | free | free (ammo crates; plain rounds when out) |
| Leviathan | 5 | 38 | ammo | 0 | 172.8 | 229.3 | — | free | free | free (ammo crates; plain rounds when out) |
| Lance | 4 | 32 | beam | 90 | 1.5 | 210 | 2.3 | 0.6 | 1.9 | one can't be sustained on a starter |
| Rustjaw's Hive | 4 | 12 | clip | 8 | 6 | 22.9 | 2.9 | 6.5 | 21.0 |  |
| Frostbite Lance | 4 | 12 | beam | 24 | 0.4 | 95 | 4 | 2.2 | 7.0 |  |
| Cinder Bloom | 4 | 22 | cycle | 11.7 | 14 | 13.3 | 1.1 | 4.4 | 14.4 |  |
| Prism Splitter | 4 | 10 | cycle | 10 | 16 | 13.8 | 1.4 | 5.2 | 16.8 |  |
| Phase Cannon | 4 | 26 | cycle | 13.6 | 30 | 31.8 | 2.3 | 3.8 | 12.4 |  |
| Singularity Launcher | 4 | 30 | cycle | 30 | 210 | 12 | 0.4 | 1.7 | 5.6 | utility/effect: DPS is not its job |
| Demolition Launcher | 1 | 8 | ammo | 0 | 16 | 450 | — | free | free | free (ammo crates; plain rounds when out) |
| Rail Driver | 4 | 29 | clip | 19.2 | 8 | 96 | 5 | 2.7 | 8.8 |  |
| Repair Beam | 2 | 17 | beam | 28 | 0.5 | 0 | 0 | 1.9 | 6.0 | utility/effect: DPS is not its job |
| Point Defence Turret | 1 | 10 | auto | 10 | 2 | 0 | 0 | 5.2 | 16.8 | utility/effect: DPS is not its job |
| Slurry Cannon | 3 | 18 | cycle | 36 | 25.2 | 68.6 | 1.9 | 1.4 | 4.7 | ports-only (needs a feed) |

"Copies a ship sustains": its spare power after cruising engines (Sparrow T 52/s, Corsair 168/s) over one gun's
flat-out draw. "E a shot" is a round's share of the reload for clip guns and a tick's for beams. DPS is `baseWeaponDps` x strength at its own grade, before armour; EMP, support and point defence do
their work some other way. Every energy weapon's numbers match its description ("120 E a shot", "32 E a second").

- **Free**: the ten ammunition guns (Burst, Lobber, Quake, Dart, Swarm, Hammerhead, Needle, Eel, Leviathan,
  Demolition Launcher) draw nothing in either power system; out of crates they fire plain rounds, still free. Their
  data `demand` (44/s for a Needle) was shown as "Power draw" on cards and tooltips and counted in the rating's weapon
  draw: fixed (below).
- **Can't be sustained on a starter**: the Spear (63 E/s) and the Lance (90 E/s). Every weapon is sustainable singly
  on a Corsair-sized ship.
- **Spear**: 63 E/s for 84 DPS, against its Mk IV peers the Bastion (17 E/s, 100 DPS) and Rail Driver (19 E/s, 96 DPS)
  and the Mk III Coilgun (16 E/s, 89 DPS). Its description promises 120 E a shot and three ships pierced, so this is
  deliberate; flagged, not changed.

## Stores, generators, engines, shields

| Part | Mk | level | cells | makes E/s | holds | gives /s | a cell |
|---|---|---|---|---|---|---|---|
| Cell Reactor | I | 0 | 1 | 35 | | | 35/s |
| Isotope Pile | I | 9 | 0.79 | 14 | | | 18/s (tough, never explodes) |
| Fusion Plant | II | 18 | 4 | 192 | | | 48/s |
| Overclock Reactor | III | 24 | 2 | 124 | | | 62/s |
| Battery | I | 0 | 1 | | 200 | 600 | 200 |
| Capacitor (bank) | I | 7 | 1 | | 160 | 2,000 | 160 |
| Drive Cell (bank) | I | 10 | 1 | | 320 | 1,400 | 320 |
| Heavy Bank | III | 20 | 4 | | 1,200 -> **1,800** | 600 | 300 -> **450** |
| Pulse Dynamo | II | 18 | 1 | 10 into each bank it touches | | | |

| Engine | Mk | cells | draw E/s | thrust per E/s | boost x | boosting E/s |
|---|---|---|---|---|---|---|
| Ion Drive | I | 1 | 9 | 0.25 | 2 | 29 |
| Vernier | I | 0.5 | 2 | 0.30 | none | 2 |
| Afterburner | I | 1 | 8 | 0.20 | 3.6 | 61 |
| Torch | I | 2 | 68 | 0.12 | none | 68 |
| Plasma Drive | II | 2 | 40 | 0.16 | 1.8 | 110 |
| Drift Sail | III | 0.79 | 2.4 | 0.30 | 1.3 | 5 |
| Fusion Torch | IV | 4 | 112 | 0.13 | 1.7 | 358 |
| Reaction Thruster | II | 1 | 4 | 0.25 | none | 4 |

| Shield | Mk | level | cells | draw E/s | holds a cell | refill a cell | after |
|---|---|---|---|---|---|---|---|
| Deflector | I | 11 | 1 | 16 | 40 | 8/s | 3 s |
| Flicker Screen | II | 19 | 0.79 | 5 | 20 | 20/s | 1 s |
| Flash Screen | II | 13 | 1 | 16 | 36 | none: whole 4 s after it breaks, or at once from a Capacitor bank | |
| Bulwark Projector | III | 27 | 4 | 77 | 45 -> **60** | 5/s | 4 s |

Engines and generators climb sensibly by tier and trade-off. Two parts did not:
- **Heavy Bank** (Mk III, 2.5 points a cell) held 300 a cell: less than a Mk I Drive Cell (320) and only 1.5x a Mk I
  Battery, at a quarter of the Battery's discharge. "Holds a lot" wasn't true.
- **Bulwark Projector** (Mk III, "a deep shield that soaks an alpha strike") held 45 a cell against the Mk I
  Deflector's 40, with a slower refill (5 against 8), a longer wait (4 s against 3 s), a higher draw (19 against 16 a
  cell) and 2.5x the build points. Four Deflectors in the same space beat it at everything but 12% of capacity.

## What the pilot is told

| Where | Before | Problem | Now |
|---|---|---|---|
| ENERGY gauge (bottom right) | a blue bar, no number | sits empty while engines and guns are starved; nothing says so | turns red, flashes and reads LOW POWER while anything is short (held 0.5 s) |
| Ship panel (top left) | core HP and the schematic | the status record already worked out generation, draw, net rate and time to empty; nothing showed them | a line under the schematic: ENERGY %, the measured rate, then what is short, empty in, full in, or the spare power |
| Bank bars | a bar per bank, flashing when what it feeds is short | fine | unchanged |
| Hangar POWER | generation, steady, spare, store, Output, flat-out draws, the boost-and-fire warning, banks | fine | unchanged |
| Hangar ENERGY | Store and Output (repeats of POWER), then "brownout at 1.8 s · down to 36%" | repeated rows; no recovery time | "full power 2.7 s, then 38%"; a new **Refills** row (idle, from every store empty) |
| Part cards, tooltips, fabricator | "Power draw 44/s" on a Needle | ammunition guns draw nothing | no draw row on ammunition guns |
| Tutorial | "boosting, guns and shields all draw on it" | shields never draw on the pool | boosting and firing draw on it when the generators can't keep up; LOW POWER explained |
| Field guide, Energy | the W wire tool, Auto-wire and wire costs | the wire tool was retired (220e47d) | wires laid by the ship itself; the new HUD line and hangar rows explained |

Panels: docs/panels/2026-11-04/ui/energy-hud and hangar-energy-rows.

## Changes

Fixes (shared code, so the server, the pilot's prediction and the hangar agree):
- `rebuild.ts`: `EnergyInfo.weaponDraw` is each gun's `gunDrawFlatOut` (by firing model: an ammunition gun 0, a
  spinning gun spun up), not its raw `demand`. It feeds the rating's sustain term and the hangar summary; ratings move
  only for ships short of power with ammunition or spin guns (none in the library; review-heron's draw 79 -> 0).
- `partStats.ts`: an ammunition gun has no `draw`.

Data (scripts/econ/models.mjs, regenerated):

| Part | Field | Old | New | Why |
|---|---|---|---|---|
| Heavy Bank | store a cell | 300 | 450 | A Mk III "deep" battery held less than a Mk I Drive Cell. Now 2.25x a Battery a cell, still a quarter its rate and dearer per point (180 E a point against the Battery's 200). Library ships with Heavy Banks boost longer: Lancer 1.9 -> 2.7 s, Bastion 2.2 -> 3.2 s, Hammerhead 2.0 -> 2.9 s, Galleon 1.2 -> 1.8 s; the Lancer refills from empty in 5.0 s (was 3.4) |
| Bulwark Projector | shield a cell | 45 | 60 | Its whole point is depth, and it was 12% deeper than a Mk I Deflector while worse at everything else. Now 1.5x; refill, delay and draw unchanged. 180 -> 240 for the part |

Nothing in the goldens moves (the flight and server goldens use the Sparrow T, the Corsair and test ships). Text
snapshots updated for the intended changes: ammunition guns' draw rows, the Heavy Bank and Bulwark Projector numbers,
the library summaries' stores, the dev ships' weapon draws.

## Proportional sharing (2026-11-04)

Kieran: "they should be prioritized basically by their proportional draw; if a thruster asks for 10, weapons asks for
20, weapons will get 2/3rds of the draw ... if you have a capacitor feeding your thrusters that draws at 30, the
thrusters would prioritize 3/5ths of the energy". Built in energy.ts `powerTick` (circuits.ts gives each bank its
`intake`):

1. Engines, guns, beams, miners and part features draw on the banks they touch first, as before.
2. What each still wants, and each bank not full that can refill (a member on a powered network) for
   `min(intake, room)`, asks the Output (spare + the pool's rate while it holds charge). Within the Output everyone gets
   its ask; past it each gets Output × ask / all asked. Spare pays first, then the pool.
3. The spare left refills the pool; then Pulse Dynamos. No more engines first, no more emptiest-first refill.

Choices where the words didn't map one to one:
- **A bank and what it feeds bid separately, and add up.** While the bank holds charge, its parts draw on it and ask
  the Output nothing, so the bank's intake is the side's whole ask: Kieran's 30 against 20 gives 3/5 exactly. A dry
  bank feeds nothing, so its parts ask for themselves as well (10 + 30 against 20: 2/3).
- **A bank feeding several kinds** (a Drive Cell under an engine and a Burst Strafer; a Capacitor under guns and a
  miner) asks once, for its intake; what it feeds shares it by what each asks, like everything else.
- **A bank's charge rate is the part's `intake`** (models.mjs: the routing core's Takes): Capacitor 40/s a cell, Drive
  Cell 80/s (absent: a quarter of its discharge). Before, banks refilled from leftover spare without a limit.
- **Banks refill from the pool too**, because the Output includes it. Energy moves from the pool into the banks while
  they're not full, so unbanked parts run short sooner after a bank has been used hard (below).
- Within one feed group, engines and guns get one share, so `Charge.eng[f]` and `.gun[f]` are equal whenever both ask.
  A boost still re-arms on any stored charge (decision 1's latch wasn't asked for), so on an empty store the ticks
  still alternate boost and cruise; what changes is that the guns get their share on both.

Library ships, before (engines first) and after. Same method as above (guns at `gunDrawFlatOut`; firing 90 s, average
over the last 20; boosting 60 s, average over the last 20; minimums over the whole run). No library ship has a bank, so
cruising, boosting alone and refill don't move; only the rows where engines and guns both ask do.

| Ship | firing, cruising: before | after | boosting and firing, guns avg (min): before | after | engines avg (min): before | after |
|---|---|---|---|---|---|---|
| Sparrow T, Prospector, Arrow | sustained | sustained | 100% | 100% | 100% | 100% |
| Drum | sustained | sustained | 50% (0%) | 93% (86%) | 99% (99%) | 93% (86%) |
| Bulwark | 21.9 s, then guns 66%, engines 100% | 21.9 s, then guns 86%, engines 86% | 66% (0%) | 86% (56%) | 100% (68%) | 86% (56%) |
| Corsair | sustained | sustained | 77% (32%) | 93% (79%) | 100% (100%) | 93% (79%) |
| Lancer Frigate | sustained | sustained | 75% (0%) | 97% (50%) | 100% (53%) | 97% (50%) |
| Galleon | sustained | sustained | 50% (0%) | 73% (45%) | 75% (49%) | 73% (45%) |
| Bastion Dreadnought | sustained | sustained | 50% (0%) | 76% (49%) | 78% (54%) | 76% (49%) |
| Hammerhead Carrier | sustained | sustained | 50% (0%) | 75% (49%) | 77% (46%) | 75% (49%) |
| Ceres Hauler, Ark Tender | no guns | | | | | |

Boosting alone (unchanged): Drum 5.4 s then 96%, Bulwark 3.5 s then 83%, Lancer 2.7 s then 69%, Galleon 1.7 s then
79%, Bastion 3.2 s then 83%, Hammerhead 2.9 s then 80%, haulers 0.7 s then 70%; refills as in the first table.

- **The empty-store boost no longer starves the guns** (decision 1): the guns' minimum goes from 0% to 45-86%, their
  average from 50% to 73-93%. The engines pay for it: their share is the guns' share now, 2 to 14 points under what
  engines first gave them (the Lancer's from 100% to 97%, the Drum's from 99% to 93%, the Bulwark's from 100% to 86%).
- **The Bulwark** firing while cruising now browns out engines and guns together at 86% instead of guns alone at 66%.

Guns with and without banks: circuits.test's ship (a Cell Reactor's 35/s, two Ion Drives boosting 58/s, two Pips 8/s
each), boosting and firing for 20 s from an empty pool, with Capacitors on the right Pip:

| Capacitors on the right Pip | left Pip (unbanked) avg (min) before | after | right Pip before | after | engines before | after | bank at the end before | after |
|---|---|---|---|---|---|---|---|---|
| 0 | 50% (0%) | 74% (49%) | 50% (0%) | 74% (49%) | 81% (63%) | 74% (49%) | | |
| 1 | 50% (0%) | 85% (49%) | 100% | 100% | 88% (77%) | 85% (49%) | 0% | 100% |
| 2 | 50% (0%) | 85% (49%) | 100% | 100% | 88% (77%) | 85% (49%) | 50% | 100% |

The banked Pip keeps full rate either way; what changes is the bank: it used to run dry (refilled only by spare
nobody else wanted), and now asks for its 40/s and holds full. Kieran's examples as numbers are in circuits.test
("energy: proportional sharing").

Goldens moved by this alone (checked by running them with the old energy.ts: all passed): flightTraces
`drive-bank-boost` (the Drive Cell refills from the pool as it drains, so the pool runs dry sooner and the bank lasts
the script) and `strafer-every-way` (the test-strafer's two Drive Cell banks refill from the pool while it dodges, the
pool runs dry about halfway and the unbanked engines run short: its replica now re-keyframes, so the scenario says
`replicaDiverges: true`); parity.golden for both; frameHash (the strafer pilot, from tick 400).

## For Kieran to decide

1. **Boosting on an empty store starves the guns** (half rate, nothing on alternate ticks) on every ship whose store
   runs dry. Options: let a boost run only on stored charge plus what's spare after the guns (cruise first, then guns,
   then the boost: stateless, but it changes the "engines first" rule in rework-2026-11 section 2.2); or latch the boost
   off when the store empties until the key is let go or the store refills to some level (a replicated flag and a
   protocol bump). Left as is; the HUD now says it.
   **Answered by proportional sharing** (section above): the guns get their share every tick. The boost still re-arms
   on each tick's trickle; a latch would stop that, if wanted.
2. **Boost length by size**: endless on the Sparrow T, Prospector, Arrow and Corsair; 0.7 s on the haulers. More
   batteries on the Ceres Hauler and Ark Tender plans, or a lower `boostDraw`, would even it out.
3. **The Bulwark plan** browns out while cruising and firing (22 s, then guns at 66%): one more Cell Reactor fixes it.
4. **Ammunition guns are free** of energy forever, crates or not (plain rounds when out). Intended?
5. **Spear** draws 4x its Mk IV peers for less DPS (its description promises it). Keep?
6. `tuning.json shield.maxPerArea` (40) is validated but read by nothing.
