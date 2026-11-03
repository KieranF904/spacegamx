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

Rendering, particles, audio, the camera and AI decisions (inputs, in lockstep terms) keep native Math.

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

Not yet: asteroid orbits (asteroid/orbit.ts: sin/cos/atan/sinh/cosh/tanh/asinh; server-told today), SimLod's far
ships (server-only), AI brains and spawning (Math.random: inputs, not simulation), the rest of GameServer/Enemies/
Operations (beams, events, spawns), client cosmetics. Debris already used detTrig (protocol 25).

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
