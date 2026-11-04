# Deterministic maths for flight and shells (lockstep step 5, 2026-11-04)

Goal: the server (Node/V8) and every client engine compute the same bits for everything that moves ships and shells, so
more of the simulation can be worked out client-side (hybrid lockstep: docs/design/netcode-lockstep.md) and a 1-byte
hash per tick is enough to catch a drift.

## The rule

`+ - * /`, `Math.sqrt`, `abs`, `min`, `max`, `floor`, `ceil`, `round`, `trunc`, `sign`, `fround`, `imul` are exact by
the spec. The transcendentals (`Math.sin`, `cos`, `tan`, `atan`, `atan2`, `exp`, `log`, `log2`, `pow`, `**`, `hypot`,
`cbrt`, the hyperbolics) are "implementation-approximated" and do differ: Chrome 156 and Node 26 already disagree on
`sin`, `cos`, `atan2`, `exp` and `log` (the harness below). On the deterministic path they go through
`common/src/math/detTrig.ts` instead: `dsin`, `dcos`, `dsincos`, `datan`, `datan2`, `dhypot`, `dexp`, `dlog`, `dlog2`,
`dpow`, written with only exact operations (fdlibm's kernels; pow as 2^(k·y)·e^(y·ln m) with the rounding of the
exponent carried; whole powers by multiplication). Within an ulp of Math for sin/cos/atan2/exp/log, one or two for
log2/pow at the game's exponents (common/src/math/detTrig.test.ts). Allocation-free. A hot path with a fixed whole
exponent multiplies it out (`ratedFade`: r²·r²·r²; gravity: m·m).

Since 2026-11-04 (stage "all simulation maths"): every transcendental in common/ and in the server's simulation goes
through detTrig, and Math.random is gone from both (below). Only the client's rendering, particles, audio, camera and
UI keep native Math.

## The guard

`common/src/math/simMaths.test.ts` parses (TypeScript's parser, no type check) every non-test file in common/src,
server/src/game, server/src/ships, server/src/GameServer.ts, server/src/tickOrder.ts and server/src/net/handlers, and
fails on `Math.sin` ... `Math.atanh`, `Math.pow`, `Math.hypot`, `Math.cbrt`, `Math.random` (called or passed on),
`Math[...]`, `const { sin } = Math`, and `**` / `**=` except `2 ** <a whole literal>` (a power of two: exact
everywhere; the codecs' constants). Its allowlist (`ALLOW`, file -> why) is empty and should stay short: pure
rendering only. Benches, tests and the client aren't checked.

## Randomness

`common/src/math/rng.ts`: `hashInts`, `hashString`, `mulberry32` (32-bit state, the same sequence however long it runs;
`seededRng` is the same one, the name ships/ uses), `tickRng(...keys)` (a generator for one thing on one tick: system,
entity, tick, salt) and `hashUnit(...keys)` (one draw, nothing kept). ships/rng.ts and asteroid/polygon.ts re-export
them. What both sides work out draws from seeds both know: shells (`shotSeed`), debris splits (`splitRng`), rock
shapes, spins and belt rocks (polygon.ts, generation.ts), pod drift has none.

Math.random as it was on simulation paths, and what it is now:

| where | what it decided | now | who decides |
|---|---|---|---|
| common data/registries/AsteroidRegistry.ts (calculateResources, pickRandomForField, generateSize) | rock yields, kind, size (unused: generation.ts seeds its own) | an `rng` argument | caller |
| server GameServer.ts starterSpot, three pack spawns, the people's chatter (`PeopleHost.random`) | where a new pilot starts, which group spawns | `GameServer.rng` (mulberry32) | server only |
| server game/sieges plan.ts, Sieges.ts | a night's roster, its fronts' sides and jitter, the stream share, objective kinds, spots and times, where a pilot lands | `Run.rng`, seeded by the siege's key, instance and opening tick; `wavePlan`'s default is `mulberry32(wave)` | server only |
| server game/Surfaces.ts | where a raid comes from | `Surfaces.rng` | server only |
| server game/Arenas.ts | where a pilot comes into an arena | `Arenas.rng` | server only |
| server game/LootPods.ts scatter | a pod's push (clients get its drift anchor) | `LootPods.rng` | server only |
| server game/StationServices.ts | whether a gem cut fails | `StationServices.rng` | server only |
| server net/handlers/flight.ts rally | where beside a party member | `hashUnit(pilot, tick, salt)` | server only |

Already seeded and server-only (untouched): Bosses.ts and Enemies.ts (`mulberry32`, also the brains' `host.rng()`:
pyreclast, staged, scrapMother), GameServer's bullet-hell patterns (seeded by tick and entity). These are the boss and
AI decisions the next stage turns into decision inputs (a small value the server sends at fixed ticks that both sides
then act on deterministically). Left as Math.random, not simulation: net/auth.ts (a guest's name), benches, the
client.

## What was routed (2026-11-04)

common (flight, prediction, replicas, shell spawn, hit geometry):
- ships/flight.ts: gravity, jump range and cooldown, solar ring, local/world turns, the engines' rated fade, the jump
  burn's heading, thrust direction, drift.
- ships/shot.ts, launch.ts, guns.ts, turret.ts: muzzle and turret aim, spread, shell velocity, size and rate by size.
- ships/grades.ts, rebuild.ts, energy.ts, catalog.ts, geometry.ts, grid.ts, collide.ts, hitRules.ts, hazards.ts,
  pulse.ts, farRoute.ts, load.ts, physics.ts: derived stats that feed flight (thrust, mass curve), part shapes and
  radii, mount directions, collision and cover distances.
- ships/features: weaponry `steerToward` (guided shells), strafer (dodge ways), tow (pull).
- asteroid/polygon.ts: rock outlines shells hit.

server (shells and ship motion it runs): game/Weapons.ts (homing, guide, pull, shards), the cannon spawn in
GameServer.ts, ships/bridge/weapons.ts, flight.ts, damage.ts, pilotless.ts, sync.ts, features/support/pointDefence.ts.

Then (2026-11-04, the rest): everything else in common/ (asteroid/orbit.ts with new dsinh, dcosh, dtanh, dasinh,
dlog1p; generation.ts's belt rocks; world/planets.ts, pockets.ts, contributorNotes.ts; regions, terrain, starfield,
replication's distances; econ's levels, items, quests (whole and fractional powers by dpow); constants.ts `podDrift`;
partStats sizes; the codecs' variable powers of two now `1 << c` and a running multiplier), and the server's whole
simulation: AsteroidOrbits.ts, SimLod.ts (far ships), the AI brains (pyreclast, staged, scrapMother, kit), Bosses,
Enemies, Mobs, Roaming, Operations, Events, Surfaces, sieges, Mining, Warmth, LootPods, Derelicts, WeaponsRange,
Pilots and the rest of GameServer, ShipBridge and features (tow, repair beam), net/handlers/flight.ts, the
snapshot's interest distances (Outbox, SnapshotBuilder). Done by a TypeScript-AST rewrite (Math.f( -> df(, imports
merged), then by hand for powers and randomness. The orbit solver takes sin and cos of E in one reduction
(dsincos); calcOrbitState is the allocation-free one's copy (one implementation).

Left on native Math, and why: the client's drawing, particles, audio, camera, input and UI (the autopilot only makes
inputs); benches and tests; detTrig itself (exact operations only). Angles past about 1e6 rad (none on these paths)
reduce less accurately, but still alike everywhere.

Cost: server tick bench (`npx tsx src/bench/tickBench.ts --seconds 120`, 10 pilots, 3 runs each) mean 0.40 ms before
and 0.40-0.41 after, p50 0.30 / 0.31, p95 0.81-0.83 / 0.80-0.84; `--scenario spread` mean 0.17 / 0.17-0.18, distant
tier 11-12 / 11-15 µs a tick (noise). An orbit alone costs 0.22 µs instead of 0.17 µs (1500 orbits × 600 ticks), but
the server works orbits out only when something asks (AsteroidOrbits' timetable), so the tick doesn't feel it.

Goldens: only frameHash moved (its streams and world hashes from tick 300 on: asteroids' params and orbits, AI and
spawn positions, the server's own generators drawing where Math.random's stub drew). flightTraces, parity and
hitRules didn't. Checked on a copy of HEAD with only this change applied (another agent's work in progress was in the
tree): HEAD passed the old pins, HEAD plus this failed only frameHash; the new pins were made there.

## Checking it: npm run det:engines

`scripts/det/engines.mjs` bundles `scripts/det/scenario.ts` (six ships of different builds flying seeded inputs with
the real energy, their guns firing, shells moving, every third homing, hits on ship parts through the client's
confirmed-hits rule with rebuilds, hits on spinning asteroids; the whole state hashed every tick) with esbuild, ship
data inlined, and runs the same file in Node, headless Chrome (scripts/render/cdp.mjs) and headless Firefox when
Playwright's build is installed (nothing is downloaded). It prints per engine whether all ticks match Node's (or the
first that doesn't), and whether detTrig's primitives and native Math's agree. `--native` is the control: detTrig
swapped back to native Math in the bundle. `--ticks N`, `--no-chrome`, `--no-firefox`, `--keep`.

First run (Windows, 1200 ticks, 1184 shots, 609 ship hits, 157 rebuilds, 2 jumps):

| | Node 26.5.1 | HeadlessChrome 156 | Firefox |
|---|---|---|---|
| detTrig (the game now) | reference | all 1200 ticks match | Playwright's firefox-1495 folder has no firefox.exe (incomplete install): not run |
| control: native Math | reference | 1199 of 1200 differ, from tick 2 | |
| native Math primitives | | sin, cos, atan2, exp, log differ | |

Goldens: flightTraces and parity didn't move (the per-tick rounding to SHIP_PRECISION hides last-bit changes there);
frameHash and the hit-rules golden did. With native Math swapped back in for every new detTrig use (a vitest alias, not
committed) all four pass on the old pins, so those shifts come only from the trig values; they were regenerated.

Review fix (2026-11-04): lodestones' orbits (jumpFields.ts lodestonePosition) still used Math.cos/sin through
planetPosition, and replicas and the pilot's prediction fly by their jump fields. They now use dcos/dsin (rounded to
whole units as before; planetPosition itself, for drawing and the server's planets, is unchanged). frameHash fails the
same way with and without this change (its stream hashes, from the protocol bumps), so no golden moved.

Debris and orbits (2026-11-04, the rest): the scenario now also sheds debris every 150 ticks (a ship's parts in
groups through `deriveSplit`, as a client works a split out) and steps every piece with `stepDebrisWorld` under a
gravity well; and works out 240 seeded orbits of every kind (`calcOrbitStateRaw`, at each tick and at a tick hours
into a run), new belt rocks (`makeAsteroidParams`, a stationary ring with a lane), planets, a moon and a comet
(planetPosition is deterministic now too), and a pod's drift. The primitive check has sinh, cosh, tanh and asinh.

| 1200 ticks; 121 debris pieces, 7010 knocks | Node 26.5.1 | HeadlessChrome 156 |
|---|---|---|
| detTrig (the game now) | reference | all 1200 ticks match |
| control: native Math | reference | 1200 of 1200 differ, from tick 1 (the orbits) |
| native Math primitives | | sin, cos, atan2, exp, log, sinh, cosh, tanh, asinh differ |
