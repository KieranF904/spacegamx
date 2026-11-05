# Network audit: weapons traffic, the cargo-ship jitter, and lockstep (2026-11-03)

Question (owner): attacking a cargo ship looked a little jittery and the network went up to about 3 KB/s. Is there a
meaningful saving in how weapons and damage go over the wire, and is lockstep practical?

## Summary

**The jitter has two causes in the live build, plus a third that shows when parts break off.**

1. **The old per-frame easing in `ShipClient.placeReplica`** (removed by f79c82a). A freighter cruises at about
   16.5 units a tick (~990 u/s). The old code eased the drawn position 35% a frame whenever it moved more than
   4 units a frame, so the freighter was drawn **about 30 units behind where it really was**. How far behind changed
   with every frame's length, which made it wobble. Measured with uneven 60 fps frames: 28-31 units behind, the error
   moving **60-120 units a second**, and 9-12 visible hitches a second, **even with no corrections at all**. Shells
   and sparks land on the true hull, 30 units ahead of the drawn one, which looks like desync. **f79c82a fixes this:**
   the current client draws a freighter exactly (error 0 when nothing pushes it).
2. **Screen shake on every Pip or Rattler hit (not fixed).** Shells of a modelled gun broadcast a `detonation`.
   DamageFx has no branch for kind `cannon` or `autocannon`, so each hit falls through to the **missile fireball**,
   which plays `explosion_small` and calls `triggerScreenShake(6, 0.3)` within 1500 units
   (client/src/ships/DamageFx.ts:344). Two Pips on a freighter give about 8 such hits a second. Using the shake
   formula, that is a **mean camera offset of 12-17 px at 25 Hz** for as long as you fire. The whole view shakes, so
   the target appears to jitter. Bastion and Spark hits do not do this; they have their own branches or hit rarely.
3. **A freighter collides with its own debris.** When parts break off (heavy guns), the new debris starts against the
   hull and nothing exempts it (server/src/ships/bridge/flight.ts `resolveContacts`), so each tick the pair is pushed
   apart. The server's shadow then disagrees and the freighter gets a keyframe **about every snapshot** (Bastion run:
   5.2 a second; every one of 97 position divergences had debris touching the hull). Old client: these jumped ahead
   and froze. Current client: blended (mean error 0.5-1 u, a few 50 u spikes). The bytes and the pushes remain.

Ruled out: there is no hit knockback (`nudge` is used only by the Singularity's pull). Freighters don't flee; they
fly the station autopilot, which replicates cleanly. Part loss does change mass and thrust. That goes through a
rebuild, so the shadow sees the new flight signature and sends a keyframe. That works: I saw no drift between
keyframes in any run.

**Where the 3 KB/s comes from:** per-hit messages. A ship putting 25-40 shells a second into a target receives 3-5 KB/s
(the ping panel figure is decoded payload). In the Hammerhead run (4.8 KB/s), **`detonation` is 32%, the shooter's own
shell rows 21%, `damage` 17% and `projectileHit` 11%**; with part HP and removals, **weapons are about 90% of the
total**. A pilot 60 km away in the same system still receives **2.2 KB/s** of that fight. Every recommendation of the
2026-11-01 firing audit is still open (none landed). Two new costs have appeared since: `damage` amounts are now
unrounded doubles (~21 B instead of ~10), and the Spark's `ignite` is a 36 B plain object sent ~30 times a second.

**Recommendation: stay server-authoritative and do the cheap wins.**
- Drop `detonation` for plain shells, and send effects only to nearby pilots. Together that is 32% of combat traffic,
  and it also fixes the shake.
- Round `damage`, then fold hit, damage and removal into one ~7 B hit record.
- Confirm your own shots per volley instead of a 25 B row each.
- Replicate brain impulses as controls, so bosses and Scrap Mites stop needing keyframes.
- Exempt a ship from its own fresh debris.

That takes a heavy fight from ~4.8 to ~1.1 KB/s (-75%) and a two-Pip fight from ~1.25 to ~0.5 KB/s. Nobody gains
any say over hits or damage.

**Lockstep: not recommended**, in any of its forms, for this game.
- It would cut combat bandwidth to roughly 0.1-0.4 KB/s for a few pilots, but the cheap wins get most of that
  saving for a fraction of the work.
- It adds 70-250 ms of input delay to a mouse-aimed shooter, or rollback costs of 6-25 ms a frame.
- It needs every NPC brain (about 4,600 lines, server-side today) made bit-exact across V8, SpiderMonkey and
  JavaScriptCore.
- It scales worse than today's 40 km interest management once a sector has dozens of pilots.
- It hands every client the whole system's state, which is a free maphack.

The useful part of lockstep is already here: ship motion replays deterministically from controls, and shots are
rebuilt from fire events. Extend that pattern (impulses, mob motion, hit records) instead.

## 1. Measurements

### Method
- A throwaway probe built a real `GameServer` in-process (scene `sectors`, `autoStart: false`, sockets that only count),
  the same way server/src/bench/netBench.ts does. It ran with `@space-game/common` mapped to common/src: the dev
  server's common/dist is older than f79c82a.
- Three pilots in Sol: **A** shoots, **B** watches from about 1.7 km, **C** sits 60 km away in the same system.
- Every byte counted is the real encoder's output (`splitServerFrame` per message; snapshot parts sized with
  `encodeBinary` per row, and the remainder counted as header).
- "Deflated" simulates the live permessage-deflate settings (level 4, memLevel 6, 8 KB window, frames under 96 B left
  raw).
- Each scenario ran for 20 s after a 3 s warm-up, one process per scenario.
- For the jitter, a fake client fed A's frames, delayed by 3 ticks, into the real client `ShipStore` and the current
  `ShipReplicaSet`. In parallel it fed them into the pre-f79c82a `ShipReplicaSet` with the old `placeReplica` ease.
  Both drew the target at `serverTick - latency - 7.2` ticks (default 120 ms interpolation), on display frames of
  1/60 s ±20%, and were compared with the server's true position.
- Probe files: `netAudit.ts` and `netAuditOldReplica.ts`, kept in the session scratchpad
  (C:\Users\Kieran\AppData\Local\Temp\claude\c--Users-Kieran-Desktop-Spacegame\b24c970b-6148-4883-b4f6-ab3b6971e1b5\scratchpad\net\).
  They were removed from server/src/bench. To re-run, copy them back into server/src/bench and run with
  `npx tsx --tsconfig <scratch>/tsconfig.json src/bench/netAudit.ts <scenario> 20 3 out.json`, with `PARKED=1` and
  `NEAR`/`FAR` in the environment where needed.

Caveats:
- Inputs are written straight into the ECS (as netBench does), so costs a real client adds are not exercised: late
  inputs forcing own-row resends, and hash mismatches.
- The ambient world uses unseeded randomness, so 'other ships' varies run to run with which NPCs wander past.
- Chasing a ~990 u/s freighter at full thrust drains a big ship's battery and its guns barely fire. The weapon runs
  therefore use a **parked** freighter: the same `hauler` blueprint, spawned as a dummy that holds still. The
  jitter runs use the real moving traffic freighter.

### 1.1 Bytes per second received by the shooter (A), by category

Payload in bytes per second (the ping panel's KB/s is this divided by 1024). Columns:
- **own row**: your pilot row.
- **other ships**: control rows, status rows and keyframes of ships other than the target.
- **target kf**: the target's keyframes.
- **mobs**: Enemy (mob) rows.
- **fire**: fire events.
- **shells**: projectile rows (yours).
- **rem**: removals.
- **det**: `detonation`.
- **dmg**: `damage`.
- **pHit**: `projectileHit`.
- **hit+**: other hit effects (`ignite`).
- **part**: part loss (`shipHps`, rebuild `shipSync`, `partDestroyed`).
- **debris**: debris syncs, rows and keyframes.
- **hdr**: snapshot header.
- **other**: everything else. In the moving runs this is mostly the freighter's 2.7 KB blueprint, sent once and
  spread over 20 s.

| scenario | A total | A deflated | own row | other ships | target kf | mobs | fire | shells | rem | det | dmg | pHit | hit+ | part | debris | hdr | other | B (observer) | C (60 km) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Idle in space (Sparrow) | **280** | 280 | 26 | 98 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 134 | 10 | 285 | 186 |
| Flying alongside a moving freighter, no fire | **517** | 411 | 35 | 155 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 155 | 158 | 505 | 39 |
| 2 Pips (Sparrow), moving freighter | **1377** | 793 | 38 | 148 | 8 | 0 | 0 | 174 | 30 | 292 | 156 | 92 | 0 | 91 | 11 | 161 | 160 | 1277 | 412 |
| 2 Pips, parked freighter | **1252** | 656 | 27 | 138 | 0 | 0 | 0 | 182 | 30 | 312 | 171 | 104 | 0 | 82 | 0 | 176 | 11 | 1186 | 583 |
| Hammerhead: 12 Rattlers + 6 Pips (light spam) | **4801** | 1960 | 30 | 135 | 29 | 0 | 0 | 1009 | 139 | 1546 | 795 | 515 | 0 | 363 | 20 | 188 | 11 | 4264 | 2192 |
| 2 Bastions (ports Monitor), heavy | **517** | 423 | 36 | 121 | 4 | 0 | 0 | 10 | 3 | 16 | 19 | 5 | 0 | 90 | 54 | 137 | 9 | 434 | 221 |
| 4 Hammers (ports Breacher), heavy | **1517** | 985 | 48 | 186 | 63 | 0 | 0 | 138 | 21 | 216 | 154 | 72 | 0 | 164 | 239 | 185 | 13 | 1295 | 468 |
| Cutter beam (ports Heron) | **662** | 504 | 87 | 91 | 11 | 0 | 0 | 0 | 0 | 0 | 40 | 0 | 0 | 132 | 133 | 126 | 26 | 566 | 765 |
| 2 Glint pulse lasers + 2 Rattlers (Kestrel) | **2070** | 887 | 30 | 100 | 0 | 0 | 0 | 144 | 60 | 667 | 379 | 222 | 0 | 279 | 0 | 159 | 10 | 2091 | 1059 |
| 2 Sparks + 2 Chainsaws (ports Gale) | **6036** | 1812 | 43 | 476 | 0 | 0 | 0 | 932 | 122 | 1353 | 877 | 451 | 1152 | 410 | 0 | 188 | 12 | 5519 | 3249 |
| Fight with 5-7 pirates and Scrap Mites (Corsair) | **1228** | 1068 | 37 | 788 | 0 | 0 | 19 | 11 | 7 | 12 | 35 | 25 | 0 | 38 | 0 | 221 | 16 | 1265 | 217 |
| Scrap Mother boss (Hammerhead, 1.3-1.7 km off) | **4702** | 3074 | 404 | 477 | 602 | 1158 | 0 | 280 | 51 | 459 | 300 | 111 | 0 | 344 | 60 | 204 | 232 | 3294 | 1287 |

Notes:
- The Corsair's (and Drum's) Rattlers never fired for a player in this harness, even standing still, while the
  Hammerhead's and Kestrel's did. Unverified (it may be the harness), but worth a quick look in game. "Light spam"
  therefore uses the Hammerhead and the Sparrow.
- The Lance (ports Lancer) dealt no damage at 450 units in the harness, so it is left out.
- The beam figure uses the Cutter, which hits through `damage` every 10 ticks; there are no per-tick beam messages.

### 1.2 What one shot and one hit cost (Hammerhead run)

| item | bytes | rate | where it comes from |
|---|---|---|---|
| own shell row (`p`) | 24.5 | 41/s | SnapshotBuilder.ts:435 (own shots always go as rows) |
| fire event to observers | 11 | 41/s | SnapshotBuilder fire rows, protocol.ts `packFire` |
| `detonation` (plain object, not COMPACT) | **39** | 40/s | Weapons.ts:353 via GameServer.ts:713 `broadcastToSystem` (whole system) |
| `damage` | **20-21** | 40/s | GameServer.ts:2282. The amount is an unrounded double, e.g. `6.5449999999999875` (about 9 B on its own) |
| `projectileHit` | 13 | 40/s | Outbox.ts:125 (`broadcastNear`, 48 km) |
| removal id | 3.4 | 41/s | SnapshotBuilder.ts:598-603. In the pilot's own system it goes to everyone, even pilots never sent that shell |
| `shipHps` | 14-20 | 6-18/s | SnapshotBuilder.ts `sendShipUpdates`, part HP to a tenth |
| `ignite` (Spark) | **36** | 32/s | Weapons.ts:257, plain object, whole system |

**Per shell that hits:** about **25 B to place it, plus 39 + 20 + 13 + 3.4 + ~6 ≈ 81 B for the hit**, sent to everyone
within 48 km. Pilots further out in the system still get the 39 + 3.4 B. At 40 hits a second that is the 3-5 KB/s.

### 1.3 Other things the runs showed
- **Heavy guns break parts off, and the debris collides with the hull it left.** In the Bastion run all 97 of the
  freighter's position divergences, and in the Hammer run 25 of 28, happened with debris touching. That costs
  keyframes for the freighter and for the debris (Hammer run: 63 + 95 B/s), plus the jitter in the summary.
- **Bosses and Scrap Mites push themselves with brain impulses** (staged.ts:144-150, scrapMother.ts:342,
  pilotless.ts:87). These aren't replicated, so the Scrap Mother gets a keyframe every snapshot: 17 a second,
  602 B/s. Each Scrap Mite gets about 3.5 a second (2.4 KB per mite over 20 s in the NPC fight). Mob rows (Enemy
  entities with a full position every snapshot) add 1.16 KB/s in the boss fight.
- **Own row under fire:** in the boss fight, the shield and HP changing resend the whole pilot row (~66 B, more on a
  ports ship) 6 times a second: 404 B/s.
- **Ports ships whose drive is short of power (dev only).** Chasing the freighter with the ports Heron, the server's
  shadow of A disagreed every tick (`Player:pos` 398 times in 20 s): `replicaStep` flies with `FULL_CHARGE`, but the
  ports core starves the engines. The result was a keyframe of A to every observer every snapshot, and **A's own row
  (about 200 B with the ports triples) resent every snapshot: 4.0 KB/s on its own**. The pilot's prediction is also
  corrected every snapshot. Fix this before ports ships go live. Options: replicate a drive-power factor in the
  control row (as `CTL.slowed` does), or put the ports drive delivery into the replica step.
- **Frames:** 12-20 a second, so the real wire also carries ~70 B of TCP/IP + TLS + WebSocket headers per frame
  (~0.8-1.4 KB/s). That isn't in the panel, and no payload change removes it.

### 1.4 Jitter, measured (freighter as drawn vs its true position, A's view)

| run | target keyframes seen | current client: mean / p95 / max error (u) | current: error movement, u/s | old client (pre-f79c82a): mean / p95 / max | old: error movement, u/s | old: hitches/s (>2 u in one frame) | shake from hit detonations |
|---|---|---|---|---|---|---|---|
| flying alongside, no fire | 0 | 0 / 0 / 0 | 0 | 30.7 / 33.3 / 35.6 | 69 | 8.8 | 0 |
| 2 Pips | 5 | 0.02 / 0 / 2.7 | 0.7 | 28.2 / 32.9 / 34.8 | 87 | 9.4 | **7.8 hits/s near you, mean 16.8 px** |
| 2 Bastions (parts lost, debris) | 104 in 8.5 s | 1.1 / 1.5 / 57 | 17 | 8.6 / 12.8 / 65 | 62 | 25 | 0.4/s, 1 px |
| 4 Hammers | 58 | 0.5 / 1.1 / 52 | 16 | 17.3 / 31.1 / 58 | 122 | 12 | 5/s, 11.8 px |
| Scrap Mother boss | 340 | 0.65 / 1.7 / 5.8 | 11 | 8.0 / 20.3 / 30 | 119 | 22 | 8.7/s, 12.2 px |

"Error movement" is the summed frame-to-frame change of (drawn - true), per second. It measures visible wobble that
the true motion doesn't explain.

So: **f79c82a removes the motion part of the freighter jitter** (from ~30 units of lag and ~9 hitches a second to
none), and the boss result confirms the blending works. **The shake is still there in the dev tree**, and so are the
debris collisions. The live build has all three.

## 2. Improvements within the current design, ranked

Savings are for the Hammerhead run (A: 4.8 KB/s) unless marked. None of these lets a client decide a hit, a shot or
damage. The server still runs everything and only stops describing what the client already knows.

| # | change | saves | complexity | risk | files | wire bump |
|---|---|---|---|---|---|---|
| 1 | **No `detonation` for a shell with no splash, EMP or split** (pierce kept). The client plays the impact on `projectileHit` from the shell's look. Give `cannon`/`autocannon` a proper impact, not the missile fireball and shake. If a detonation is kept, put it in `COMPACT` (39 → ~12 B) | **1.55 KB/s (32%)** for A and B; Pip ×2: 0.31 KB/s (25%). **Also fixes the shake** | small | none for authority; visual only | server/src/game/Weapons.ts:347-354, client/src/ships/DamageFx.ts:204-345 | only if COMPACT |
| 2 | **Effects by distance, not by system.** `detonation`, `ignite`, arc hops, `effect` go via `broadcastNear` (FX_RANGE). Removals go only to clients that were sent the entity (drop the same-system shortcut at SnapshotBuilder.ts:600) | **C (far pilot): 2.2 → ~0.4 KB/s** in the Hammerhead fight, 3.2 → ~0.6 in the Spark fight. Scales with pilots × fights per system | small | none | GameServer.ts:713 (Weapons host `broadcast`), 2267 (arcHop); Weapons.ts:257, 326; SnapshotBuilder.ts:598-603 | no |
| 3 | **Round `damage.amount` to 0.1** (it is a raw double today), and sum `damage` per (target, source) per snapshot in the Outbox | 0.32 KB/s from rounding (7%), ~0.25 more from summing | trivial / small | none | GameServer.ts:2282, net/snapshot/Outbox.ts | no |
| 4 | **Hit records in the snapshot.** `[shell id step, target step, amount ×10, flags (crit, glancing, pierce, kill)]` ≈ 7 B, replacing `projectileHit` + `damage` + the removal for projectile hits. The point comes from the shell's known line (homing shells keep their x, y). Splash, beams and burns keep `damage` | ~0.85 KB/s (18%) on top of 1 and 3 | medium | low; effects already wait up to 2 ticks (LAZY_TICKS) | protocol.ts (snapshot field), SnapshotBuilder.ts, Outbox.ts, client WeaponFx / serverMessages | yes |
| 5 | **Own shots confirmed per volley**: `[ticks ago, part, id steps…]` ~5 B, instead of a 24.5 B row per shell. Rows stay for shells the client could not predict (salvo followers, homing, a ship just keyframed) | ~0.8 KB/s for the shooter (17%) | medium | medium (WeaponFx must pair predicted shells by part and tick; keep the row as fallback) | SnapshotBuilder.ts:415-437, 524-533; client/src/rendering/weapons/WeaponFx.ts | yes |
| 6 | **Replicate brain impulses as controls.** A boss's drive and a mite's dash are `PilotOrders.impulse`, applied in pilotless.ts:87 and not replicated, so each tick of pushing costs a keyframe. Add an impulse event to the control stream (direction on the 13-bit aim grid plus a magnitude index, changed only when it changes) and apply it in `replicaStep` | boss: ~0.5 KB/s of the 0.6 KB/s of keyframes (11% of the boss fight); mites ~0.1 KB/s each. **Removes the correction stutter at its cause** | medium | low: the server still decides the impulse; clients only replay it. The shadow keeps checking | server/src/ships/bridge/pilotless.ts, common/src/ships/replica.ts, common/src/network/replication.ts (`packControlRow`), server/src/net/Replication.ts | yes |
| 7 | **No collision between a ship and its own fresh debris** for ~60 ticks, or until they first separate | freighter + debris keyframes in heavy fights: ~0.1-0.4 KB/s while parts come off. **Removes the remaining freighter jitter** | small | gameplay-visible: debris no longer nudges the wreck | server/src/ships/bridge/flight.ts `resolveContacts`, rebuild.ts `spawnDebris` (tag the parent) | no |
| 8 | **Mob rows by dead reckoning**: send an Enemy (mob) row only when it is off its straight-line guess by more than N units, as `MAP_DOT_SLACK` does for map dots; otherwise drop x, y from the key | boss fight: ~0.8 of 1.16 KB/s (17%) | medium | low | SnapshotBuilder.ts:411 (mob rows) and the row key | maybe |
| 9 | **`ignite` into `COMPACT`** (or fold it into the hit record as a flag) | Spark fight: 1.15 → ~0.3 KB/s (14% of that fight) | trivial | none | protocol.ts COMPACT, Weapons.ts:257 | yes |
| 10 | **Own row under fire: a short status delta** (shield, HP, EMP) instead of the whole row when only those changed; the full row on a keyframe version or the 2 s safety | boss: ~0.3 of 0.4 KB/s | small-medium | low | SnapshotBuilder.ts:535-549 | yes |
| 11 | `shipHps` as a fraction of max (0-127, never rounded down to nothing), and at 10 Hz for ships that aren't yours | ~0.1-0.15 KB/s | small | low | SnapshotBuilder.ts `hpWire`, `sendShipUpdates` | yes |
| 12 | (dev only) **Ports ships short of drive power**: replicate a drive-power factor so the shadow and the replicas fly what the ship flies | 4 KB/s for a starved ports pilot, plus 20 keyframes/s to everyone near it | medium | low | common/src/ships/replica.ts, power/ports.ts, Replication.ts | yes |

**After 1-5 the Hammerhead fight goes from ~4.8 to ~1.1 KB/s raw (-75%).** The Pip pair goes from ~1.25 to ~0.5 KB/s.
What remains is the floor: snapshot headers ~0.18, other ships' control and status rows ~0.14, and part HP. Pilots
elsewhere in the system pay almost nothing for other people's fights. The boss fight drops a further ~1.5 KB/s with 6,
8 and 10.

Ideas from the brief that are **not worth it**:
- **Rebuilding shells from (tick, part, seed)** is already done for other ships (`rebuildVolley`, fire events at
  11 B). Only the shooter's own rows are left (item 5).
- **Deterministic shell ids** (owner + per-owner sequence) would save ~1 B a shell after item 5. Low value; it
  touches every projectile lookup.
- **Fire bits in the control row with every client running `stepGuns` for other ships**: observers would need each
  ship's energy, clip and ammo state, and a desync shows phantom fire. Fire events are the right trade.
- **Clients deriving hits themselves** (no hit messages): see hybrid lockstep (3.3). It saves only ~7 B a hit beyond
  item 4 and needs a correction path for every miss-predicted hit.

## 3. Lockstep

### 3.1 What would have to be deterministic, and how far common/ is

Everything that affects state would have to give the same bits on Node (V8), Chrome (V8, possibly a different libm
build), Firefox (SpiderMonkey, fdlibm) and Safari (JavaScriptCore, platform libm). See
docs/audits/js-math-determinism-2026-11-01.md.

| piece | where today | state |
|---|---|---|
| Ship flight | common/src/ships/flight.ts, physics.ts, replica.ts | Shared and quantised each tick (`SHIP_PRECISION`). It uses Math.sin/cos/atan2/hypot (9 calls in flight.ts). It is already relied on for replication: server.Node vs browser equality is tested only in Node (`server/src/net/replication.test.ts`). |
| Guns, launch, shells | common/src/ships/guns.ts, launch.ts, shot.ts | Shared and seeded by tick and shell id (`rebuildVolley`). Uses sin/cos (4-5 calls each). |
| Energy | energy.ts, power/ports.ts | Shared. `ports.ts` has no transcendentals. |
| Collisions between ships | server/src/ships/bridge/flight.ts `resolveContacts` | **Server only.** Sorting, polygon tests, impulses. |
| Hits, damage, part loss, rebuild, debris | server/src/ships/bridge/damage.ts, weapons.ts, rebuild.ts; server/src/game/Weapons.ts | **Server only** (rebuild itself is shared). Debris uses `seededRng`. |
| NPC AI: Enemies, Bosses, brains, Mobs | server/src/game (Enemies 1,300+ lines, brains ~4,600 lines with Bosses and Mobs) | **Server only.** About 460 sin/cos/atan2/hypot calls across server/src/game and server/src/ships, and 16 `Math.random`. |
| World: asteroids, mining, loot, hazards, traffic, SystemMemory | server/src/game, common/src/data | Server only. AsteroidRegistry uses `Math.random` (6). |
| RNG | common/src/ships/rng.ts (`seededRng`) | Good where used; many server streams use per-module `this.rng`. |
| Entity ids | bitecs, ids reused | Not deterministic across a late joiner unless the whole allocator is replicated. |
| Map/Set order | insertion order | Fine if insertion order is; delete-and-reinsert moves keys. |

Counted: common/src (non-test) has 37 sin, 34 cos, 14 atan2, 4 atan, 40 hypot, 17 pow, 2 log and 6 Math.random; the
server sim has ~460 more. The server is ~31,500 lines of non-test TypeScript and common ~27,000.

**Work:**
1. A deterministic math module (sin, cos, atan2, hypot via sqrt, pow by multiplication), a lint ban, and replacing
   ~600 call sites.
2. Moving collisions, damage and part loss, debris, every NPC brain, Mobs, Weapons, hazards, loot and asteroid
   motion into common, with seeded per-system RNG streams.
3. Deterministic entity ids.
4. A whole-world state hash, desync detection and a full-state resync protocol.
5. Cross-engine golden-vector CI: Node plus three browser engines plus real Safari/iOS.

**Estimate: several months**, and it permanently constrains how every new feature is written.

One thing to fix even without lockstep: **replica motion already assumes cross-engine equality.** The server's shadow
runs in Node; Firefox and Safari clients may differ in the last bit of sin or cos. Per-tick quantisation hides almost
all of that, but a replica that drifts is never corrected until the next keyframe, and no client checks. Run the
determinism harness on `replicaStep` in Firefox and Safari, or fold a hash of one or two replicas into the existing
`stateHash` the client already sends.

### 3.2 Input delay

Tick 16.7 ms. Pure lockstep through the server, which is the only practical topology for browsers: your input has to
reach the server and come back before anyone, including you, simulates it. Input delay ≈ RTT + a jitter buffer of
1-2 ticks + up to 1 tick of alignment.

| RTT | delay you feel |
|---|---|
| 40 ms (same region) | ~70-90 ms |
| 100 ms | ~130-150 ms |
| 200 ms (e.g. Australia to US/EU) | ~230-250 ms |

Today: **0 ms** for your own ship and your own shots (predicted). Only hit confirmation waits for the round trip.

What that does to these controls:
- **Mouse steer with fixed guns (gimbal ±13.5° on the Lance):** aiming means turning the ship. 100+ ms between the
  mouse and the nose feels heavy, and overshoot gets worse. This is the worst case.
- **Turrets following the cursor:** the shot goes where the cursor was 100-250 ms ago. A freighter at ~990 u/s has
  moved 100-250 units by then, longer than a small ship.
- **Thrust and strafe/dodge:** a 100 ms late dodge is a missed dodge (Burst Strafer).

Hiding it means predicting your own ship and shots locally, which brings back the correction machinery that exists
today.

### 3.3 Variants and expected bandwidth

Figures are per client. Inputs on change are about 11 B each. Continuous mouse aim gives roughly 60-80 B/s per pilot
(today's control rows for one pilot measure about that). A tick bundle header is ~4 B at 20 Hz.

| variant | what each client runs | down-bandwidth | feel | verdict |
|---|---|---|---|---|
| **Pure lockstep** (no prediction) | Everything, every system entity, every brain | ~0.1 KB/s + 70 B/s per other pilot: **~0.3 KB/s for 4 pilots, ~3.5 KB/s for 50 in a sector** (no interest management possible) | 70-250 ms delay on everything | No |
| **Lockstep + local cosmetic prediction** | As above, plus your own ship drawn ahead | as above | Own ship responsive, but shots spawn from the lockstep pose, behind the drawn ship; hits land late. Mismatches need the correction code we already have | No: today's design with more work |
| **Rollback (GGPO-style)** | Everything, re-simulated over the rollback window each time an input arrives late | as pure lockstep, plus hashes | 0 delay; mispredictions snap other ships | No: server tick is 1-2 ms on desktop Node (docs/audits/profile-2026-10-31.md). 6-12 ticks of rollback is 6-25 ms a frame on a desktop browser, more on laptops and phones, and with many pilots some input is late almost every frame |
| **Hybrid: authoritative world, deterministic shells and damage** | Today's replication, plus clients compute hits and damage from fire events and exact replicas | ~0.4-0.6 KB/s for the Hammerhead fight | As today | Not worth it over items 1-5 (~1.1 KB/s): the extra ~0.5 KB/s costs a hit-prediction path that must be right whenever a target is between keyframes (debris, impulses, collisions), with corrections when it isn't |
| **Today + items 1-8** | Today's replication | ~1.1 KB/s heavy fight, ~0.5 light, ~0.3 idle | As today | **Yes** |

### 3.4 The rest

- **Late join and system jumps:** lockstep needs the whole system's state on arrival: every body's blueprint
  (the freighter's alone is 2.7 KB), HP, positions, projectiles, every brain's internal state, RNG states, asteroids,
  loot and the id allocator. Expect tens to hundreds of KB, at every jump and every resync. Today a client gets only
  what's within 40 km, and designs by hash.
- **Desyncs:** you need a per-tick hash of the whole world (today's `stateHash` covers your own ship), and a full
  resync each time one is found. With transcendentals across three engines, resyncs would not be rare until the math
  module is done and tested on real devices.
- **MMO scale:** lockstep makes every client simulate and receive inputs for every pilot and NPC in the system,
  including those 60 km away. Today's 40 km ship view and 48 km effect range (with item 2 fixed) let a crowded sector
  scale with what's near you. Cutting the world into small lockstep cells brings back handover and interest
  management, the hard parts.
- **NPC and boss AI on every client:** all brains run on every client. That is ~4,600 lines of brains plus Enemies and
  Mobs, a bullet-hell boss among them (docs/audits/boss-bullet-hell.md), and it costs each client CPU proportional to
  the system rather than to the view.
- **Cheating:** full state on every client is a free maphack: every ship, cargo, HP and boss phase in the system.
  Relayed inputs still stop speed hacks. Aimbots are possible in either design. Today clients see only what's in view.
  Hiding other pilots' exact energy and damage is a small anti-cheat gain of the current design.

## 4. Recommendation and order of work

1. Items 1, 2, 3 and 9 together: under a day, no gameplay change apart from the impact look. This removes the shake
   and 40% or more of combat traffic. Decide what a Pip or Rattler hit should look like (DamageFx needs a `cannon`
   and `autocannon` impact, not the missile fireball).
2. Item 7 (own-debris collisions). It is a small gameplay change and removes the last freighter jitter.
3. Items 4 and 5 together in one protocol bump, with WeaponFx matching tests. Combat then reaches ~1 KB/s.
4. Item 6 (impulses as controls), then 8 and 10, for boss fights.
5. Item 12 before ports ships go to production.
6. Separately: run the determinism harness on `replicaStep` in Firefox and Safari. Replication already depends on it.

Lockstep: park it. The bandwidth it would save is mostly reachable with 1-5, and its costs (input delay, AI ported and
made bit-exact, late join, MMO scale, maphack) are permanent.

## 5. Anchors
- server/src/game/Weapons.ts:85-121 (spawn, extras), 257 (ignite), 326 (arc), 347-354 (`detonate`)
- server/src/GameServer.ts:713 (Weapons host `broadcast` = `broadcastToSystem`), 715 (`nudge`), 2267 (arcHop),
  2282 (`damage`)
- server/src/net/snapshot/Outbox.ts:107-139
- server/src/net/SnapshotBuilder.ts:74 (`hpWire`), 255-300 (`sendShipUpdates`), 411 (mob rows),
  415-437 (projectile rows), 535-549 (own row), 598-603 (removals)
- server/src/net/Replication.ts (shadows, reasons)
- server/src/ships/bridge/pilotless.ts:47-102 (autopilot, impulse); server/src/ships/bridge/flight.ts:382-485
  (`resolveContacts`); server/src/ships/bridge/rebuild.ts:404-433 (`spawnDebris`)
- server/src/game/brains/staged.ts:144-150, scrapMother.ts:342 (drive impulses)
- common/src/ships/replica.ts, common/src/network/replication.ts (f79c82a blending)
- common/src/ships/state.ts:153-171 (HP bands → rebuild); common/src/network/protocol.ts:1333 (COMPACT)
- client/src/ships/ShipClient.ts:398 (`placeReplica`), client/src/ships/DamageFx.ts:204-345 (detonation branches,
  shake at 344), client/src/state/GameState.ts:144-148, 1260-1273 (shake)
- Earlier audit: docs/audits/network-firing-2026-11-01.md (same per-hit findings, none applied yet)
