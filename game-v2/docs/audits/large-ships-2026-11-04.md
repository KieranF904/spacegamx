# Large ships: is a 500-part ship practical? (2026-11-04)

Today a blueprint can have at most 255 parts (`maxParts` in data/ships/tuning.json), and every uid must be 0..255. The biggest
existing designs are the Heart of the Maw (245 parts), the Hammerhead (211) and the Bastion (210). This audit covers
three things:

- every place in the code that assumes a part fits in a byte;
- what a 500-part ship and a 1,000-part ship cost, measured;
- what changes in play at that size.

**Verdict: 500 parts is practical.** It needs four small fixes to hard limits (an afternoon), one protocol bump, and a
decision about build points. Server, network and client costs at 500 are about 2 to 2.5 times the 250-part costs, and a
fight with four of them stays well inside the tick budget. 1,000 parts is **not** practical as the code stands. The
rebuild is superlinear (17 ms per part loss, so a tick blown on every loss), and four of them in a fight average a 15.7 ms
tick with 40% of ticks over budget. Getting there needs the coarser model in section 5.

## How it was measured

- **Test designs** (throwaway, in the session scratchpad `bigship/designs/`, never committed):
  - **A**: the Bastion Dreadnought (pool power) tiled 3×2, other copies' cores made hull, 1×1 hull filling the gaps. It is
    then cut to the first N parts reached from the core, breadth first, so it is always one connected ship with
    uids 0..N-1.
  - **B**: the dev `ports-gale` (ports power) tiled 7×4 the same way, with hull ribs so the irregular outlines join.
  - Sizes: A250, A500, A1000; B210, B250, B500, B1000. A210 is the real Bastion and H211 the real Hammerhead.
  - The cut leaves 5 to 78 thrusters or guns with `facingBlocked`. That doesn't matter for cost. The uid/maxParts checks
    were bypassed in the probes only (a copy of the tuning with `maxParts: 100000`, and `spawnDummy` / `respawnInPlace`
    don't validate). No game code was changed.
- **Per-ship costs** (`bench1.ts`): real `createShipState`, `rebuildShip`, `powerTick`, `shipSegmentHit`, `nearestParts`
  and `deriveSplit`, and `encodeServerMessage` for wire sizes. The rebuild breakdown comes from a sampling CPU profile.
- **Fight** (`bench2.ts`, a full GameServer with netCaps 15):
  - Four copies of the design spawned as pirates (their own AI, they fire back), against four pilots firing at them,
    kept alive. 20 simulated seconds after a 2 s warm-up.
  - One pilot is a `FakeHitsClient` on CAPS 15 (packed frames, confirmed hits, self-found hits); one is a plain socket
    (the base format), with its bytes counted by message type.
  - The tick was timed part by part, as profileBench does.
- **Pilot's own row** (`bench4.ts`): a pilot flying the design against a pirate pack.
- **Client hulls** (`zzBigHull.test.ts`): copied into client/src/ships only while it ran, then deleted. It runs the real
  `buildHull`, `runHullJob` (the hull worker) and `ShipBatch` with pixi's GL program mocked, as hullPerf.test.ts does.
- **Stills**: through the native render service, by POSTing the blueprint; the service was stopped after. No browser was used.
- One machine (Kieran's desktop), one run each. Read the numbers as ratios, not budgets.

## 1. Hard limits: everything that assumes a part fits in a byte

"Index" is a part's place in `blueprint.parts`, which is what every runtime message carries. "uid" is the stable id kept
in saved designs and the hangar. Both are capped at 255 today, because a design can't have more parts than uids.

| # | Where | What it assumes | What breaks above 255 | Change needed |
|---|---|---|---|---|
| 1 | data/ships/tuning.json:5 `maxParts: 255`; checked at common/src/ships/blueprint.ts:179 | 255 parts | validation fails (`tooManyParts`) | raise it (512, or 1024) |
| 2 | common/src/ships/blueprint.ts:184 | uid 0..255 | `badUid` on every part past 255 | `p.uid > tuning.maxParts * 4` (or any 16-bit bound) |
| 3 | common/src/ships/blueprint.ts:336-340 `nextFreeUid` | loops to 255 | the hangar can't place a 256th part (-1) | loop to the new bound |
| 4 | common/src/ships/migrate.ts:145 `freeUid` | loops to 255 | a migrated design with more than 255 parts loses parts to `refund` | the same bound |
| 5 | server/src/net/handlers/shipEdit.ts:77 `clientBlueprint` (and the comment at GameServer.ts:1403-1406) | `parts.length > 256` is junk | every client design over 256 is refused ("not a blueprint") before validation | `> tuning.maxParts` |
| 6 | client/src/ships/HangarUI.ts:486 | "blueprint is full (255 parts)" text | wrong message | read the bound |
| 7 | client/src/rendering/lighting/ShipBatch.ts:45 `SHIP_MAX_PARTS = 256`, the damage texture's width (lines 410, 466-468, 627); the hull shader's `texelFetch(uDamage, ivec2(aPart, slot))` (lines 170-180); also scripts/native-render/scene.ts:91 | a part index < 256 | **parts 256 and up are not drawn.** `setDamage` drops them, and their texel is out of range, so `here < 0.5` culls their vertices. Rendered: A500 draws only its first 256 parts' hull, with the rest's gun barrels floating in space; A1000 shows one Bastion-sized hull ringed by loose barrels (bigship/out/render_A500.png, render_A1000.png) | `SHIP_MAX_PARTS` to 512 or 1024 (a chunk's texture goes from 32 KB to 64 or 128 KB) |
| 8 | **The gun code `part + 256 × ammo + 65536 × aug`**: server/src/net/SnapshotBuilder.ts:540-541 (fire events), server/src/ships/bridge/weapons.ts:231 (shell row `gun`), common/src/ecs/components.ts:147, common/src/ships/hitRules.ts:316-321 (`gunShell`: `part = gun % 256`), client/src/ships/ShipClient.ts:503, server/src/net/hits/fakeHitsClient.testkit.ts:199 | a gun's part index < 256 | A gun at index 300 decodes as part 44 with ammo + 1. Clients draw muzzle flashes and charge tells on the wrong gun, read the wrong ammo (and can misread a gun's code as a `TELL_CHARGE_*` code), and fall out of confirmed hits. **Measured:** the hit ledger's `gun` fallback goes from 5-6 (A210/A250) to 469 (A500) and 1,926 (A1000) in 20 s; self-hit corrections (hitFix) from 1 to 37 and 58 | Reorder to `part × 512 + ammo × 2 + aug` (ammo < 256). This is a wire change: `npm run wire:bump`. The packed codec's guard `gun < 2**20` (packedCodec.ts:131) needs `2**22` at 4,096 parts |
| 9 | Client keys `owner × 256 + part`: ShipClient.ts:506-527, 1113 (charge tells and their sounds); gunFeel.ts:23, 77 (others' clip counts); MiningBeamFx.ts:172, 232, 297, 301 and LanceFx.ts:86 (beam and Lance state) | part < 256 | Ship N's part 256+k shares a key with ship N+1's part k. Effects, sounds and clip counts cross between ships | `owner × 4096 + part` (or nested maps) |
| 10 | common/src/network/packed/packedCodec.ts:558, 574 (`[part, hp]` pairs: `p[0] < 4096`, key `ship × 4096 + part`) | part < 4096 | nothing until 4,096: above it the pairs go as "any" (bigger, still correct) | none for 500 or 1,000 |
| 11 | common/src/ships/debris.ts:283 `unpackRuns(…, max = 4096)` | part < 4096 | nothing until 4,096 | none |
| 12 | common/src/ships/grid.ts:187, 194 (join keys `i × 65536 + j`) | part < 65536 | nothing | none |

Checked and fine at any size:

- **Wire encodings that carry part indices** are varints in the base codec (binaryCodec.ts: 1 byte to 127, 2 bytes to
  16,383) and chunked varints in the packed codec. This covers COMPACT rows, `hits.ts` records (`part`, `ignite`),
  `shipHps` / `hpd`, `partDestroyed`, `shipSync.detached` / `ghosts`, `debrisSplit` (packRuns) and fire events.
  `hpChecksum` is mod 65,536 with weight i + 1, which is fine.
- **Typed arrays indexed by part**: power/layout.ts, power/ports.ts and energy.ts scratch are all sized n. Uint8Array
  holds roles, flags and saturation, never indices. Int16 `closed` holds ticks.
- **Saved designs and profiles**: common/src/econ/profile.ts:77-80 keeps HP by uid in a Record; server/src/profile has
  no part caps. A design is about 100 B a part as JSON (50 KB at 500, 100 KB at 1,000). That is far under the 512 KB
  client message cap (server/src/net/SocketTransport.ts:23) and fine for profiles (10 design slots + 5 hangar slots).
- **Client input** carries no part indices.
- **Shipgen**: scripts/shipgen/core (grid.ts:423, mirror.ts:38, 107, partlist.ts:227, 263) renumbers uids 0..n-1 and
  leaves the limit to `validateBlueprint` (check.ts). There is no cap of its own.

## 2. Cost at 500 and 1,000 parts

### Per ship (one thread)

| Design | Parts | Create ms | Full rebuild ms | Rebuild after a part loss ms | of which turret windows ms | Joins ms | Energy layout ms | powerTick µs | Hit test µs/shell | Splash µs |
|---|---|---|---|---|---|---|---|---|---|---|
| A210 Bastion | 210 | 2.0 | 1.87 | 1.66 | 0.84 | 0.11 | <0.1 (pool) | 0.17 | 1.2 | 1.6 |
| H211 Hammerhead | 211 | 1.5 | 1.47 | 1.48 | 0.81 | 0.19 | <0.1 | 0.16 | 1.6 | 1.9 |
| M245 Maw titan | 245 | 1.3 | 1.19 | 1.10 | — | 0.57 | <0.1 | 0.13 | 1.6 | 1.9 |
| A250 | 250 | 2.2 | 1.72 | 1.75 | 0.81 | 0.15 | 0.09 | 0.18 | 1.6 | 2.1 |
| **A500** | 500 | 4.2 | **3.66** | 4.1 | 1.47 | 0.36 | <0.1 | 0.26 | **3.1** | 4.2 |
| **A1000** | 1000 | 17.2 | **17.1** | 15.7 | **11.4** | 1.25 | <0.1 | 0.28 | **5.5** | 6.5 |
| B210 (ports) | 210 | 1.7 | 1.46 | 1.31 | 0.63 | 0.06 | 0.15 (ports) | 1.63 | 2.0 | 3.4 |
| B250 (ports) | 250 | 1.6 | 1.53 | 1.63 | 0.75 | 0.14 | 0.14 | 1.85 | 2.1 | 3.8 |
| **B500 (ports)** | 500 | 4.6 | **5.18** | 4.3 | 2.77 | 0.29 | 0.24 | 3.22 | 3.2 | 6.9 |
| **B1000 (ports)** | 1000 | 13.0 | **12.7** | 13.8 | **8.8** | 0.86 | 0.64 | 6.05 | 5.1 | 10.8 |

How to read the table:

- **A rebuild after a part loss is a full rebuild.** Splits and reconnects cost no more. Pieces that break off cost one
  `createShipState` each, proportional to the piece: 0.03-0.05 ms for the pieces measured.
- **Superlinear: the turret windows** (`computeTurretWindow`, common/src/ships/turret.ts:36, called per turret from
  rebuild.ts:502). Each turret casts its fan of rays against every other part, so the cost is turrets × parts × rays,
  and the turret count grows with the ship. It is 45% of the A210 rebuild and 67% of the A1000 one (0.84 → 1.47 →
  11.4 ms). The rest of the rebuild is about linear.
- `computeJoins` and `placeGeometry` are redone on every rebuild, though both depend only on the design (1.25 ms at
  1,000). That is cheap to cache per blueprint.
- **Energy:**
  - The pool and banks' layout and `powerTick` are flat.
  - The ports core is linear: 6 µs a tick at 1,000, which is nothing next to the rebuild.
  - The pilot's own ports row (sparse, only parts not full) averaged 2-34 B a snapshot, with a maximum of 852 B in one
    snapshot at B1000.
- **Hit tests** (`castParts`) are linear in parts: every part's box is tested for a shell that enters the ship's circle.
  At 5.5 µs a shell they are still cheap.

### A fight: four of them, AI-flown, against four pilots, 20 s

| Design | Parts lost | Tick mean ms | p95 | p99 | Worst | Ticks over 16.7 ms (of 1,200) | Rebuilds/s (all bodies) | ms each | Rebuild ms/tick | ShipBridge.tick µs | Contacts µs | segmentHit µs | collisionSystem µs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A210 | 14 | 1.65 | 3.15 | 4.14 | 6.5 | 0 | 20.9 | 0.51 | 0.18 | 673 | 54 | 27 | 262 |
| A250 | 35 | 1.71 | 3.76 | 5.40 | 17.6 | 1 | 19.3 | 0.95 | 0.31 | 827 | 66 | 27 | 210 |
| **A500** | 58 | **2.58** | 6.56 | 9.93 | 27.0 | 3 | 32.4 | 1.59 | 0.86 | 1,463 | 112 | 60 | 338 |
| **A1000** | 402 | **15.65** | 35.1 | 46.2 | 51.2 | **480** | 88.3 | 8.4 | **12.4** | 13,588 | 319 | 444 | 965 |
| B210 | 188 | 1.58 | 3.49 | 4.64 | 7.2 | 0 | 23.4 | 0.92 | 0.36 | 855 | 48 | 18 | 135 |
| **B500** | 583 | **2.92** | 9.0 | 13.2 | 18.9 | 3 | 32.6 | 2.54 | 1.39 | 2,059 | 83 | 34 | 163 |
| **B1000** | 2,177 | **5.26** | 21.2 | 28.8 | 73.7 | 76 | 25.8 | 8.0 | 3.45 | 4,274 | 87 | 61 | 210 |

- At 500 the mean tick rises about 1.5× over 250. p95 and p99 roughly double, but they stay under budget. The few
  over-budget ticks are rebuild bursts, when several parts die in one tick.
- At 1,000 the rebuild alone eats 12.4 ms of every tick, because big ships rebuild often: more of them is hit, and more
  of what's hit is guns that die. The tick is gone.
- The AI brains (80 µs) don't scale with parts. Their guns do: `fireWeapons` goes 158 → 173 → 292 µs for 22 → 35 → 93
  guns.

### Network

| Design | First sight: shipSync with blueprint + HP | Same design seen before (hash + HP) | Rebuild sync (1 part) | Rebuild sync, n/4 detached | shipHps (5 parts) | Blueprint JSON |
|---|---|---|---|---|---|---|
| A210 | 6,882 B | 423 B | 28 B | 71 B | 37 B | 20.9 KB |
| A250 | 8,179 | 485 | 28 | 81 | 37 | 24.8 KB |
| **A500** | **16,498** | 899 | 28 | 266 | 39 | 49.8 KB |
| **A1000** | **33,251** | 1,813 | 28 | 642 | 43 | 99.8 KB |

These sizes are linear: about 33 B a part for the design, 1.8 B a part for the HP list. A boss with scaled HP sends
`maxHp` as well, roughly the same again as the HP list. The rebuild sync re-sends the whole `detached` list every time,
so late in a fight it grows with the ship. It could go as runs (packRuns), as `debrisSplit` already does.

In the fight, bytes per second to one pilot:

| Design | Base format total | of which snapshot | projectileHit | damage | shipHps | shipSync rebuilds | shipSync designs (debris) | partDestroyed | Packed (CAPS 15) total | Hit-ledger `gun` fallbacks | hitFix sent |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A210 | 6,011 | 3,129 | 1,134 | 646 | 523 | 514 | 0 | 33 | 2,455 | 5 | 1 |
| A250 | 6,891 | 4,172 | 1,013 | 613 | 510 | 466 | 0 | 61 | 2,807 | 6 | 1 |
| **A500** | **9,098** | 5,314 | 1,342 | 827 | 575 | 790 | 4 | 103 | **4,704** | **469** | **37** |
| **A1000** | **22,943** | 11,639 | 4,430 | 2,293 | 1,079 | 2,727 | 101 | 547 | **11,749** | **1,926** | **58** |
| B210 | 6,790 | 2,599 | 846 | 713 | 910 | 817 | 104 | 186 | 2,789 | 4 | 0 |
| B500 | 10,634 | 3,729 | 937 | 804 | 1,204 | 1,677 | 1,114 | 275 | 4,880 | 112 | 2 |
| B1000 | 11,038 | 3,153 | 915 | 705 | 862 | 1,255 | 3,198 | 461 | 5,926 | 79 | 1 |

- **Snapshots and keyframes** grow with the guns (fire events, shells), not with the parts. A ship's keyframe row is its
  pose, the same size at any part count.
- **The packed frames stay about half the base format** at every size.
- The jump at 500 in `gun` fallbacks and hitFix is limit 8 above, not size: guns past index 255 can't be worked out by
  the client.
- **Confirmed hits are also lost to rebuilds.** The ledger's `rebuilt` fallback (a hit on a ship rebuilt since) was 631
  (A210), 1,081 (A500) and 4,374 (A1000) in 20 s. A big ship that rebuilds every few ticks pushes most hits on it back
  to the legacy messages.
- **Debris designs** (`shipSync.design` for each new piece, its blueprint in full) reach 1-3 KB/s at B500-B1000, where
  big chunks break off.

### Client draw

| Design | Hull build ms (worker) | Worker job after a part loss ms (cold / warm) | Vertices close / far | Own chunk (one draw)? | setDamage µs |
|---|---|---|---|---|---|
| A210 | 10.4 | 12.7 / 10.2 | 10,236 / 1,356 | yes (≥ SOLO_VERTS 8,000) | 1.3 |
| A250 | 12.3 | 16.5 / 12.4 | 11,120 / 1,528 | yes | 1.6 |
| **A500** | **22.7** | 28.2 / 23.3 | 19,776 / 2,875 | yes | 2.0 |
| **A1000** | **48.9** | 74.5 / 51.1 | 44,342 / 6,042 | yes | 6.6 |
| B500 | 24.2 | 31.0 / 25.2 | 19,339 / 2,806 | yes | 1.4 |
| B1000 | 53.8 | 71.1 / 50.6 | 37,962 / 5,571 | yes | 8.0 |

- **Hulls** are linear, and the build runs in the hull worker. ShipRenderer builds a big hull (60+ parts) at most every
  200 ms. At 500 the worker spends about 25 ms of each 200 ms window on one ship that is losing parts. At 1,000 it is
  50-75 ms, so four such ships keep the worker saturated.
- **Main thread**: setting a new hull and drawing a frame took 0.08 ms at 500 and 0.19 ms at 1,000. A big ship is
  always a solo chunk, so a part loss copies only its own vertices.
- **Lighting** is a fixed 16-light shader (litShader.ts MAX_LIGHTS).
- **The shield** is one bubble sprite (plus a rim) per ship, sized to the radius. `shieldLookOf` is cached per rebuild.
  Neither scales with parts.
- **Not measured: GPU time.** That needs a browser. Vertex count doubles from 250 to 500, and is fill-bound when zoomed in.

## 3. Gameplay and handling

| Design | Span (cells) | Radius (world) | Mass | Inertia | Forward accel (thrust/mass) | Angular accel (torque/inertia) | Jump ratio | Rating | Build points | validateBlueprint ms |
|---|---|---|---|---|---|---|---|---|---|---|
| Sparrow-T | 6×4 | 72 | 14 | 1.8e4 | 0.333 | 2.6e-2 | 2.95 | 10 | 14 | 0.03 |
| A210 Bastion | 18×36 | 482 | 537 | 3.4e7 | 0.180 | 1.44e-3 | 0.08 | 261 | 601 | 1.5 |
| M245 Maw titan | 54×42 | 666 | 2,679 | 5.3e8 | 0.018 | 1.4e-5 | 0.03 | 3,653 | 6,388 | 2.1 |
| A500 | 54×54 | 667 | 1,128 | 1.7e8 | 0.234 | 2.04e-3 | 0.04 | 494 | 1,356 | 5.1 |
| A1000 | 56×71 | 957 | 2,328 | 6.7e8 | 0.125 | 7.4e-4 | 0.02 | 1,073 | 2,602 | 21.8 |
| B500 | 36×26 | 443 | 521 | 3.2e7 | 0.134 | 1.67e-3 | 0.08 | 252 | 612 | 3.0 |
| B1000 | 53×27 | 663 | 1,045 | 1.4e8 | 0.147 | 1.19e-3 | 0.04 | 489 | 1,213 | 10.4 |

- **Flight.** Mass, thrust and torque all add up per part, so a big ship handles as well as its engines.
  - Inertia grows with mass × radius² (about n² for a round ship: ×20 from A210 to A1000). Torque grows with thrusters
    × lever arm. Angular acceleration therefore drifts down slowly: A1000 turns 180° in about 2.2 s, against 1.6 s for
    the Bastion.
  - The fixed core gyro (216) stops mattering. Nothing needs retuning for 500.
  - The jump ratio (coil capacity over hull cells) collapses with size, so every big design sits at the drive's floor of
    30,000 range and a 1,500-tick cooldown, unless it carries many jump coils. That is probably intended, but players
    will notice.
- **Collisions.** Ship-to-ship contacts take per-part pieces, and only those near the other body for ships over 40
  parts (server/src/ships/bridge/flight.ts:429, BIG_BODY). Cost rose 54 → 112 → 319 µs/tick in the fight. Shells
  against the ship are the linear `castParts` above. Ships don't collide with stations.
- **Docking.** Range is measured from the ship's centre (Docking.stationInRange, at least 800 units), so a big ship can
  still dock. But a 667-radius ship "riding inside" a 150-200-radius outpost will look wrong, and docked visuals may want
  a size rule. Hangar ghost building (econ/hangar.ts) works by uid and has no limit, but fabricating 500 parts is an
  economy question.
- **Build points are the real player gate.** data/unlocks.json `complexity` reaches 455 at level 90. The Bastion
  already costs 601, A500 1,356 and A1000 2,602. Unless that table changes, 500-part player ships exist only in free
  build, the dev server, or as NPCs and bosses. Raising `maxParts` alone changes nothing for players.
- **Camera.** Flight zoom goes down to 0.04 (InputManager.ts:33), so a 1,900-unit-wide ship is 76 px. That's fine.
- **Debris.** Debris comes off as connected groups. Each group is a new debris design, and its blueprint goes in full to
  everyone near (the debris `shipSync.design` bytes above). A big ship shedding a big chunk sends that chunk's design,
  33 B a part. The client works pieces out itself (debrisSplit), so only the confirmation is small.
- **AI as a boss.** The pirate AI flew and fought the 500- and 1,000-part ships with no change, and its brain cost
  doesn't depend on parts.
  - Boss designs are `rigid` (rebuild.ts AS_BUILT caches the whole-hull stats). A rigid design's rebuild still runs the
    turret windows every time.
  - Bosses turn at `bossMaxAngularSpeed` 0.04, which suits this size.
  - Escorts and lair radii use the ship's radius (Bosses.ts:223, 352, 392), so they scale on their own.
- **Hangar editor at this size.**
  - `validateBlueprint` runs on every edit: 5 ms at 500, which is fine; 22 ms at 1,000, which is noticeable.
  - Fit-to-view stops at 12 px a cell (HangarUI.ts:820), so a ship over about 80 cells across can't be seen whole. 500
    parts is 54 cells and fits; 1,000 is 71 cells, a squeeze.
  - The canvas redraws every part, the power report and the ghost list. These were not measured, but they are linear.
  - The parts counter (`parts n / maxParts`) and the "full" message read the cap.

## 4. Verdict: 500 is practical. What must change, cheapest first

1. **Uid and part caps.** Five one-line changes: tuning.json `maxParts`, blueprint.ts:184 badUid, `nextFreeUid`,
   migrate.ts `freeUid`, shipEdit.ts:77. Fix the hangar's "full" message too.
2. **`SHIP_MAX_PARTS` to 512** (ShipBatch.ts:45, and so native-render). Without it, half of a 500-part ship isn't drawn.
   One constant, plus 32 KB more texture per chunk.
3. **The client's `owner × 256 + part` keys** (ShipClient, gunFeel, MiningBeamFx and LanceFx). A find-and-replace.
4. **The gun code** (`part + 256 × ammo + 65536 × aug`, six places). Reorder it so the part has room, then run
   `npm run wire:bump`. This is the one protocol change. Without it, guns past index 255 misfire on clients and fall out
   of confirmed and self-found hits (measured above).
5. **Build points** (a design call, not code). Decide whether 500-part player ships are meant to be reachable. If they
   are, data/unlocks.json `complexity` has to grow about 3×.
6. **Optional at 500, needed beyond it: turret windows.** Cache each turret's window across rebuilds, and recompute only
   turrets whose ray fan the lost part's circle touches (a lost part can only open a window). Or cast against a coarse
   cell grid instead of every part. This takes 1.5-2.8 ms off a 3.7-5.2 ms rebuild at 500, and 9-11 ms off 13-17 ms at
   1,000.
7. **Cheap and worth doing anyway.**
   - Cache `placeGeometry` and `computeJoins` per blueprint. Only `alive` filters joins, so they need not be redone on
     every rebuild.
   - Send `shipSync.detached` as runs.

With 1-4 done, a 500-part ship costs about 2.1× a 250-part ship per rebuild and per hit, 2× on the wire at first sight,
and 1.5× on the mean fight tick.

## 5. Going to 1,000+: where a coarser model is needed

Per-part costs are linear and fine at 1,000 (hit tests 5.5 µs, a 33 KB design message, 44k vertices). What breaks is
that **every part loss rebuilds the whole ship, and big ships lose parts constantly**: 88 rebuilds a second across four
A1000s, at 8-17 ms each. Everything downstream inherits that rebuild: confirmed hits fall back on `rebuilt`, rebuild
syncs go out, and the hull worker rebuilds the hull.

- **Sections.** Split a big design into sections of about 32-64 parts: a section is a connected group of parts, made once
  per design.
  - **Rebuild per section.** Structure, turret windows and the energy layout get recomputed only for the sections a loss
    touches, and connectivity is solved over the section graph. This turns 17 ms into a section's worth (about 1 ms).
  - **Throttle.** Coalesce part losses on a big ship to at most one rebuild every few ticks. A ship 2,000 units across
    won't feel 50 ms of lag on a far section's guns.
  - **Damage messages per section.** `shipHps` / `hpd` as (section, changed mask, HP run) and `hpCheck` per section.
    Confirmed-hit records stay valid across rebuilds of *other* sections, so a hit on the bow survives the stern losing a
    gun (today any rebuild voids them: the `rebuilt` fallback).
  - **Hull per section** in the hull worker. A part loss rebuilds one section's geometry (about 2-3k vertices), not
    44k, and ShipBatch can address sections as sub-ranges of the ship's chunk.
- **Hit tests.** A per-design cell grid (or BVH) in place of the linear `castParts` / `nearestParts` loop. This is not
  needed until several thousand parts, but it's cheap once sections exist.
- **The design message.** At 33 B a part, a 2,000-part design is 66 KB on first sight to every client in view. It can be
  cached on the client by hash across sessions, or sent compressed as it is mostly repeated parts.
- **The editor.** At 1,000+, editing needs a zoom below 12 px a cell, section-level validation (only the edited area),
  and probably copy and mirror of whole sections.

## Probe files (session scratchpad, not committed)

All of these are in `C:/Users/Kieran/AppData/Local/Temp/claude/c--Users-Kieran-Desktop-Spacegame/b24c970b-6148-4883-b4f6-ab3b6971e1b5/scratchpad/bigship/`:

- `gen.ts`: the designs, written to `designs/`.
- `bench1.ts`: per-ship costs.
- `bench2.ts`: the fight (`matrix.sh` runs it over the designs; results in `out/fight_*.json`).
- `bench3.ts`: handling and validation.
- `bench4.ts`: the pilot's own row.
- `zzBigHull.test.ts`: client hulls.
- `out/render_A500.png`, `out/render_A1000.png`: the missing hulls past part 255.
- `run.sh`: runs any of them through tsx from server/, with a tsconfig mapping `@space-game/common` and `@srv/*`.
