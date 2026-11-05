# Network fixes: measured impact (2026-11-03)

The six fixes from docs/audits/network-weapons-lockstep-2026-11-03.md, measured before and after with the same probe,
the same seeded world and the same 20-second scenarios. All figures are decoded payload bytes per second received by
each pilot (what the ping panel shows, ×1024), unless marked deflated (the live permessage-deflate settings). Protocol
is now **25**.

## Summary

| scenario | shooter B/s | change | shooter deflated | observer 1.7 km away | far pilot, same system, 60 km |
|---|---|---|---|---|---|
| Idle in space (Sparrow) | 293 → **293** | 0% | 292 → 292 | 298 → 298 | 186 → 186 |
| Flying beside a moving freighter | 517 → **517** | 0% | 411 → 411 | 505 → 505 | 39 → 38 |
| 2 Pips on a moving freighter | 1377 → **992** | -28% | 793 → 758 | 1277 → 904 | 412 → 38 |
| 2 Bastions on a moving freighter | 1055 → **649** | -38% | 770 → 490 | 1055 → 516 | 72 → 38 |
| 4 Hammers on a moving freighter | 1698 → **1192** | -30% | 1137 → 894 | 1471 → 1055 | 296 → 38 |
| 2 Pips, parked freighter | 1236 → **835** | -32% | 646 → 793 | 1143 → 743 | 583 → 214 |
| Hammerhead (12 Rattlers + 6 Pips), parked freighter | 5017 → **2905** | -42% | 2097 → 1867 | 4478 → 2365 | 2192 → 448 |
| 2 Bastions, parked freighter | 537 → **478** | -11% | 460 → 425 | 495 → 436 | 221 → 200 |
| 4 Hammers, parked freighter | 1523 → **1092** | -28% | 977 → 787 | 1381 → 943 | 477 → 214 |
| Cutter beam, parked freighter | 1283 → **1151** | -10% | 982 → 944 | 1194 → 1058 | 765 → 764 |
| 2 Sparks + 2 Chainsaws, parked freighter | 5974 → **5368** | -10% | 1777 → 1758 | 5516 → 4910 | 3249 → 570 |
| Fight with 5-7 pirates (Corsair) | 1228 → **1202** | -2% | 1068 → 1062 | 1265 → 1240 | 216 → 191 |
| Scrap Mother boss (Hammerhead) | 5332 → **5237** | -2%* | 3527 → 3439 | 4293 → 3714 | 1299 → 740 |
| Ports Heron short of drive power, chasing a freighter | 4490 → **628** | **-86%** | 1048 → 455 | 1220 → 593 | 39 → 38 |
| Debris-heavy: 4 freighters broken up close together | 7578 → **3697** | **-51%** | 3913 → 2392 | 7304 → 3451 | 2351 → 623 |

\* Not a like-for-like comparison: ships now pass through debris, so the boss fight plays out differently (11 pieces of
debris against 6, more mobs). Its per-message savings are real: detonation -353 B/s, damage -213 B/s, debris keyframes
2.5/s → 0.6/s.

- **Combat costs 28-42% less** for the shooter with slug guns.
- **Pilots elsewhere in the system pay 80-90% less** for other people's fights.
- **A ports ship short of power stops costing 4 KB/s.**
- **Debris costs 88% less.**
- **The screen no longer shakes on slug hits.**
- Nothing got worse on the wire except one effect of the transport's compression threshold on small fights (see "What
  got worse").

### By category (shooter, B/s)

Columns:
- **ships**: other ships' control rows, status rows and keyframes.
- **target kf**: the target's keyframes.
- **hit+**: other hit effects (ignite).
- **part loss**: `shipHps`, rebuild syncs, `partDestroyed`.
- **debris**: syncs, rows, keyframes and `debrisSplit`.
- **header**: the snapshot header.

| scenario | own row | ships | target kf | mobs | shells | removed | detonation | damage | projectileHit | hit+ | part loss | debris | header | other |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| idle | 26 | 110 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 134 | 10 |
| near | 35 | 155 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 155 | 158 |
| 2 Pips, moving | 38 → 35 | 148 | 8 | 0 | 174 | 30 | **292 → 0** | **156 → 82** | 92 | 0 | 91 → 90 | 11 → 1 | 161 → 158 | 160 → 159 |
| 2 Bastions, moving | 48 → 51 | 125 → 131 | **166 → 9** | 0 | 15 | 4 | 24 | 28 → 10 | 5 → 4 | 0 | 79 → 76 | **386 → 14** | 144 → 142 | 19 → 157† |
| 4 Hammers, moving | **155 → 63** | 191 → 180 | 45 → 43 | 0 | 135 | 21 | 198 → 105 | 128 → 57 | 59 | 0 | 143 → 146 | **242 → 13** | 198 → 186 | 164 → 167 |
| 2 Pips, parked | 27 | 137 | 0 | 0 | 182 | 30 | **312 → 0** | 170 → 82 | 104 | 0 | 79 | 0 | 168 | 10 |
| Hammerhead, parked | 30 | 356 | 29 → 26 | 0 | 1009 | 139 | **1546 → 0** | **794 → 250** | 515 | 0 | 361 → 360 | 20 → 3 | 188 → 187 | 9 |
| 2 Bastions, parked | 36 | 134 | 4 | 0 | 10 | 3 | 16 | 19 → 8 | 5 | 0 | 70 | 54 → 6 | 161 → 162 | 9 |
| 4 Hammers, parked | 48 | 186 | 63 → 37 | 0 | 143 → 138 | 22 → 21 | 224 → 109 | 157 → 53 | 75 → 72 | 0 | 166 → 167 | **236 → 58** | 176 | 11 |
| Cutter, parked | 88 | 655 | 12 | 0 | 0 | 0 | 0 | 38 → 25 | 0 | 0 | 132 → 136 | 133 → 8 | 181 → 183 | 25 |
| Spark + Chainsaw | 43 | 439 | 0 | 0 | 932 | 122 | 1353 | **876 → 269** | 451 | 1152 | 391 | 0 | 185 | 11 |
| NPC fight | 37 | 788 | 0 | 0 | 11 | 7 → 6 | 12 → 0 | 35 → 22 | 25 | 0 | 38 | 0 | 221 | 16 |
| boss | 443 → 473 | 892 → 864 | 618 → 582 | 1197 → 1586 | 284 → 253 | 52 → 43 | 478 → 125 | 332 → 119 | 116 → 100 | 0 | 320 → 410 | 122 → 223 | 206 → 207 | 251 → 228 |
| ports chase | **3906 → 97** | 192 → 173 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 211 → 180 | 162 |
| debris-heavy | 106 → 50 | 854 → 647 | 97 → 47 | 0 | 771 → 757 | 140 → 107 | **1529 → 0** | 725 → 388 | 510 → 515 | 0 | 733 → 732 | **1889 → 232** | 195 → 194 | 11 → 9 |

† In the Bastion run the freighter dies at 8.6 s, slightly later than before; its 2.7 KB blueprint is now counted in
"other" (sent once) instead of earlier in the run.

## Per-fix attribution

Each fix touches its own categories, so each is credited by the bytes it removed there, from the same seeded runs
(before → after). As a cross-check, fixes 1-4 were also measured on their own, at a stage before fixes 5 and 6 (an
unseeded pair of runs). They agree to within a few bytes wherever the scenario doesn't depend on the ambient world.

| fix | what changed | saved (shooter unless said) | evidence |
|---|---|---|---|
| **1. No detonation for plain slugs** | `Weapons.bursts`: a shell with no splash, EMP, split, pierce, fire, chain, pull, hold or fuse sends no `detonation`; clients draw its impact from `projectileHit` (WeaponFx). DamageFx: slug detonations (only from bursting ammunition now) get a small puff, not the missile fireball, sound and shake; a Prism's shards keep their look from `projectileHit` (`PLAIN_HIT_LOOKS`) | Hammerhead 1,546 B/s (31% of its total); Pips 292-312 (23-25%); Hammers 93-115; debris-heavy 1,529; boss 353. Spark and Bastion: none (their shells burst or chain) | detonation column; stage-1 cross-check: identical figures |
| **2. Effects by distance; removals only to who had them** | Outbox: any eye-and-ear effect (`LAZY_TYPES`) broadcast to a system that has a place goes to clients within 48 km (`fxPoint`: its x, y or its entity's); removals only to clients that were sent the entity (or made it: debris) | Far pilot: Hammerhead fight 2,192 → 448 (-80%), Spark fight 3,249 → 570 (-82%), debris-heavy 2,351 → 623, Pips (moving) 412 → 38. Its removals: 139 → 0 B/s in the Hammerhead fight | far pilot column |
| **3. Damage summed per target and source per snapshot, to 0.1** | Outbox `addDamage`/`flushDamage`: one number per (target, source, glancing) per snapshot, rounded | Hammerhead 794 → 250 (-544, -69%); Spark 876 → 269 (-607); Pips 170 → 82; debris-heavy 725 → 388 | damage column |
| **4. Ships ignore debris** | `resolveContacts` leaves debris out (boss sheds are intangible scenery, not obstacles: nothing relied on them) | Freighter keyframes while parts come off: 5.2/s → 0.3/s (166 → 9 B/s) with Bastions. Fix 4 alone cut that run's debris traffic 386 → 77 B/s (debris no longer pushed by the hull); fix 6 took it to 14 | target kf column; stage-1 cross-check: target kf -157, debris -309 |
| **5. Ports (and pool) ships short of drive power** | The pilot's flight step rounds what the engines got to 1/32 (`quantizePower`) and puts it, with a refused boost, in the replicated control bits (CTL.noBoost; 6 bits from bit 15). Replicas, and the server's shadow, fly it from the bits | Own row 20/s → 0.5/s (3,906 → 97 B/s); total 4,490 → 628 (-86%). The ports Breacher chasing a freighter: own row 155 → 63. Parity golden: the `drive-bank-boost` replica went from 64 re-keyframed ticks to none | own row column; server/src/golden/parity.golden.json |
| **6. Debris worked out by clients** | See "Debris" below | Debris traffic: debris-heavy 1,889 → 232 B/s (-88%); 4 Hammers 236 → 58; Cutter 133 → 8; Bastions (moving) 386 → 14. Debris keyframes 41/s → 2.9/s. Cost: acks upstream 8 B/s at most, on inputs already being sent | debris column; 84 of 84 acks right in the debris-heavy run (0 wrong, 0 late) |

### Debris (fix 6), how it works now
- **Split.** When a part's loss splits a ship, a client that has the ship as it was gets `debrisSplit [ship, tick, piece
  ids, parts that left]`, about 20 bytes (measured: 19.5 on average). "As it was" means the centre of mass of its copy matches the split's
  (`DebrisNet.comAt`). It works the pieces out with the server's own steps (common `deriveSplit`): blueprint, HP, its
  pose from the replica at that tick, seeded push and spin, deterministic trig.
- **Confirm.** The client acks each piece with an 8-bit check on its next input (a tail on the binary input). Until
  then the server sends that client nothing for the piece. A wrong check, or no check within 30 ticks plus twice the
  ping, and the piece goes as before.
- **Drift and knock.** Debris drifts and knocks only into other debris, push only, all pieces stepped together in id
  order, the same code on both sides (`stepDebrisWorld`).
- **Keyframes.** A piece is keyframed if something else moved it (a rebuild's shift, a blast, a tow), and so is every
  piece that knocked into it before the snapshot. The same happens when it knocked into a piece some client isn't
  stepping.
- **Still server-told.** Shots on debris, crumbling, destruction and removal.
- **Not derived.** Boss sheds (the brain picks the groups; they're scenery) and splits of your own ship go as before.

## Jitter, keyframes, shake

| scenario | target keyframes/s | debris keyframes/s | target drawn error mean / max (u) | debris drawn error mean / p95 (u) | camera shake while firing, old client → now |
|---|---|---|---|---|---|
| 2 Pips, moving | 0.3 → 0.3 | 0.2 → 0 | 0.02 / 2.7 → 0.02 / 2.7 | 1.83 / 29.3 → 0 / 0 | **16.8 px → 0** |
| 2 Bastions, moving | **5.2 → 0.3** | **10.3 → 0.2** | 1.08 / 56.7 → 1.11 / 52.6 | 0.25 / 0.27 → 0 / 0 | 0 |
| 4 Hammers, moving | 1.4 → 1.4 | 4.6 → 0.1 | 0.23 / 21.7 → 0.25 / 39.8 | 0.43 / 2.41 → 0 / 0 | **12.0 px → 0** |
| 2 Pips, parked | 0 | 0 | 0 | - | **17.7 px → 0** |
| Hammerhead, parked | 1.1 → 1.1 | 0.3 → 0 | 0.07 / 2.9 → 0.07 / 2.9 | 0.05 / 0.08 → 0 / 0 | **21.3 px → 0** |
| 4 Hammers, parked | 2.4 → 1.5 | 2.7 → 0.6 | 0.74 / 100 → 0.77 / 100 | 0.01 / 0 → 0.12 / 0.09 | **10.7 px → 0** |
| Spark + Chainsaw | 0 | 0 | 0 | - | **21.6 px → 0** |
| boss | 17.5 → 16.5 | 2.5 → 0.6 | 0.56 / 5.4 → 0.53 / 5.4 | 0.28 / 0.59 → 0 / 0 | 10.8 px → 0 |
| ports chase | own row 20/s → 0.5/s | - | 0 | - | 0 |
| debris-heavy | 3.5 → 1.8 | **41 → 2.9** | 0.78 / 110 → 0.78 / 110 | 0.03 / 0.06 → 0.49 / 0.26 | **21.9 px → 0** |

Notes:
- **Drawn error.** This is the target as drawn (the current client, with f79c82a's blending) against the server's true
  position, on uneven 60 fps frames with 3 ticks of latency. The fixes don't change how the target is drawn; they
  change how often it is corrected. The worst case (the freighter colliding with its own debris) is now rare: 0.3
  keyframes a second, not 5.2.
- **Shake.** This is the mean camera offset from DamageFx's shake formula, from every slug hit within 1,500 units.
  Before, about 8 hits a second (2 Pips) or 40 (Hammerhead) each shook the screen as a missile would. Now none do.
- **Debris drawn error.** This is the client's debris against the server's. It is exact in the moving-hammer run. In
  the debris-heavy run it is exact except for the 1-8 ticks between a server-only event (a piece shot, crumbling,
  caught in a blast) and its keyframe; that is the 0.49 mean. Before, every knock cost a keyframe (41 a second), so
  clients were corrected constantly at a price of 1.9 KB/s.

## CPU

| scenario | server tick ms | ship contacts ms | debris world ms (new) | fake client ms per tick |
|---|---|---|---|---|
| idle | 0.226 → 0.222 | 0.013 → 0.013 | 0.002 | 0.002 → 0.002 |
| Hammerhead, parked | 0.372 → 0.338 | 0.022 → 0.018 | 0.003 | 0.035 → 0.034 |
| boss | 0.515 → 0.469 | 0.040 → 0.038 | 0.008 | 0.085 → 0.065 |
| debris-heavy | 0.499 → 0.465 | **0.070 → 0.034** | 0.019 | 0.076 → 0.080 |

- **Server.** Debris left the ship contact pairs, so contacts halved in the debris-heavy run. The new debris step costs
  0.002-0.022 ms a tick.
- **Client.** The fake client (store, replicas with the debris world, derivation, drawing) costs 0.004 ms more per tick
  in the debris-heavy run.
- **Determinism harness.** 24 pieces with 21,021 knocks over 1,200 ticks ran in 0.82 s in Node, 0.92 s in Chrome and
  1.25 s in Firefox: about 0.7-1 ms per tick for a dense pile of 24.
- (A single desktop machine in all cases; the server's step includes the whole sectors world.)

## Determinism check

- **What ran.** One esbuild bundle in Node 26.5.1, headless Chrome 156 and headless Firefox 142 (Playwright build
  1495, unzipped by hand: Playwright's own installer fails on Node 26).
- **What it does:**
  - 200,000 inputs through `dsin`, `dcos`, `datan2` and `dhypot`;
  - 40 seeded splits of freighters and Hammerheads (some losing their core), derived with `deriveSplit`;
  - 1,200 ticks of `stepDebrisWorld` with a gravity well.
- Every value is hashed bit for bit (FNV over the float64 bytes).

| hash | Node 26 | Chrome 156 | Firefox 142 |
|---|---|---|---|
| deterministic trig (200k inputs) | d56ef701 | d56ef701 | d56ef701 |
| spawns (24 pieces from 40 splits) | 4778df22 | 4778df22 | 4778df22 |
| debris world (1,200 ticks, 21,021 knocks) | 2e316848 | 2e316848 | 2e316848 |
| control: native Math.sin/cos/atan2/hypot on the same inputs | 2c020e30 | **32b14faa** | **3482d04e** |

The shared debris sim is bit-identical in all three. The control row shows why it had to be: native `Math` differs
between all three, **including Node and Chrome, both V8**. One consequence beyond debris: today's ship replication
(`replicaStep`, flight.ts) uses native `Math.sin/cos/atan2/hypot`. The server's shadow (Node) and a Chrome or Firefox
client can disagree in the last bit. Per-tick rounding hides almost all of it, but nothing catches the rest. Porting
flight.ts to detTrig is the next step if that ever shows up. (Harness:
C:\Users\Kieran\AppData\Local\Temp\claude\c--Users-Kieran-Desktop-Spacegame\b24c970b-6148-4883-b4f6-ab3b6971e1b5\scratchpad\det\detEntry.ts,
runChrome.mjs, pw2\runFirefox.cjs.)

## What got worse, or didn't pan out

- **Deflated bytes rose for small fights.** The Pip pair on a parked freighter: raw -32%, but deflated 646 → 793 B/s.
  Without detonations many frames drop under SocketTransport's 96-byte `threshold` and go uncompressed. The panel
  (raw) is down, the real wire slightly up for that case. Lowering `threshold` to about 32 is a one-line change worth
  measuring (not done here). Bigger fights are down deflated too (Hammerhead 2,097 → 1,867).
- **Boss fight: no clear total change.** Ships passing through debris changed how the fight played (more mobs: +389 B/s
  of mob rows; part loss +90). The detonation and damage savings (-566 B/s) are real. The boss's own keyframes
  (17/s, brain impulses) are untouched: that was improvement 6 of the earlier audit, not in this batch.
- **Debris drawn error in the debris-heavy run** is higher on average (0.03 → 0.49 u, p95 0.06 → 0.26). Clients now
  simulate the knocks instead of being re-sent every knocked piece, so they are wrong for a few ticks after each
  server-only event (see "Jitter"). That is the trade the spec asked for ("drifting a little is acceptable"), at 12%
  of the bytes.
- **Debris despawn is still told by the server** (a removal id, 3 bytes). Deriving it from `despawnTick` isn't simple:
  a Tow Beam holding a piece extends it.
- **Not derived:** boss sheds (brain-chosen groups) and splits of the client's own ship; they go as before.
- **Spark:** its `ignite` (36-byte plain object, 32/s, 1,152 B/s) and its arc detonations (it chains, so it bursts)
  are untouched for the shooter. Only far pilots stopped getting them.
- **A Burst Strafer short of power** (`strafer-energy-short`) still re-keyframes. The dodge draws its own power share,
  which fix 5 doesn't replicate.
- **Visible changes:**
  - damage numbers are one per target and source per 50 ms instead of one per hit;
  - station shots reach only pilots within 48 km (a test assumed system-wide: updated);
  - engine power rounds to 1/32 (the `drive-bank-boost` flight trace moved about 1 unit over 590 ticks);
  - ships no longer bump into debris.
- **Bugs found and fixed while measuring:**
  - a ship blown apart lost its split record before the snapshot told it;
  - debris shadows started as the wrong mode, so each new piece cost a keyframe;
  - the client kept a stale tick after a rewind;
  - a keyframe's own tick has to be stepped again.

  These were found by comparing the client's debris with the server's tick by tick.

## Changed files (uncommitted, in commit-sized chunks)

Some files carry more than one fix (Outbox.ts: 2 and 3; SnapshotBuilder.ts: 2 and 6; server bridge flight.ts: 4, 5
and 6; ShipClient.ts: 1 and 6; GameServer.ts: 3 and 6), so the chunks share them.

1. **Plain slugs** (fix 1): server/src/game/Weapons.ts (`bursts`), client/src/ships/DamageFx.ts (`KINETIC_KINDS`,
   `PLAIN_HIT_LOOKS`), client/src/ships/ShipClient.ts (shard look on `projectileHit`).
2. **Effects by distance, removals** (fix 2): server/src/net/snapshot/Outbox.ts (`fxPoint`),
   server/src/net/SnapshotBuilder.ts (removal rule), server/src/game/enemies.test.ts (pilot moved near the station).
3. **Damage summed** (fix 3): server/src/net/snapshot/Outbox.ts (`addDamage`, `flushDamage`, `flushLazy`),
   server/src/GameServer.ts (`notifyDamage`, `sendSnapshots`).
4. **Ships ignore debris** (fix 4): server/src/ships/bridge/flight.ts (`resolveContacts`).
5. **Power on the wire** (fix 5):
   - common/src/ships/flight.ts (`quantizePower`, `ctlOfPower`, `powerOfCtl`, `replay`), physics.ts, replica.ts
     (`CTL.noBoost`);
   - server/src/ships/bridge/flight.ts (`stepMovement`);
   - server/src/golden/parity.test.ts (records the power bits), common/src/ships/golden/testData.ts.
6. **Debris** (fix 6):
   - new: common/src/math/detTrig.ts, common/src/ships/debris.ts, common/src/ships/debris.test.ts,
     server/src/ships/bridge/debrisNet.ts;
   - common: common/src/index.ts, common/src/ships/index.ts, common/src/ships/geometry.ts (`convexPenetration` uses
     sqrt), common/src/network/protocol.ts (`ServerDebrisSplitMessage`, input ack tail), common/src/network/replication.ts
     (the debris world in `ShipReplicaSet`);
   - server: server/src/ships/ShipBridge.ts, server/src/ships/bridge/rebuild.ts, server/src/ships/bridge/flight.ts (tick),
     server/src/net/Replication.ts, server/src/net/SnapshotBuilder.ts (`holdDebris`, `ackDebris`),
     server/src/net/ClientConnection.ts, server/src/net/ServerCtx.ts, server/src/net/handlers/flight.ts,
     server/src/net/snapshot/constants.ts (`DEBRIS_ACK_TICKS`), server/src/GameServer.ts (connection fields);
   - client: client/src/ships/ShipClient.ts (`onDebrisSplit`, `takeAcks`, `debrisShape`), client/src/app/inputSend.ts,
     client/src/app/serverMessages.test.ts.
7. **Protocol and docs:** common/src/network/protocol.ts (`PROTOCOL_VERSION` 25, `PROTOCOL_WIRE_HASH` 1525a8b1, via
   `npm run wire:bump`), common/src/network/PROTOCOL_CHANGELOG.md, docs/areas/networking.md, this report.

**Goldens updated on purpose:**
- common/src/ships/golden/flightTraces.golden.json (`drive-bank-boost`: power on the 1/32 grid);
- server/src/golden/parity.golden.json (`drive-bank-boost` replica: 64 re-keyframed ticks → none; its server trace);
- server/src/golden/shipBridgeApi.json (+ `debrisNet`, `stepDebrisWorld`);
- server/src/golden/frameHash.golden.json (the bytes on the wire changed).

**Tests:** all 2,238 pass, plus 5 new ones in debris.test.ts. Typecheck is clean for server and client.

**Dev server:** common was rebuilt; the running `tsx watch` server reloaded itself and accepts protocol 25 (checked
with a join). No manual restart was needed.

## Method

- **Probe.** A real `GameServer` in process with three pilots: shooter A, observer B at about 1.7 km, and C 60 km away
  in the same system.
  - Every byte is the real encoder's output.
  - Each pilot has a fake client: the real `ShipStore` and `ShipReplicaSet`, with debris derived by the same
    `deriveSplit`. Its acks reach the server 3 ticks after its frames arrive.
  - `Math.random` is seeded, so a scenario repeats byte for byte (checked).
  - 20 s per scenario after a 3 s warm-up.
- **Before.** A `git archive` of HEAD (the tree before any change), run from the scratchpad. Shake before was measured
  with the old DamageFx model (`OLDFX=1`).
- **After.** The working tree.
- **Files.** Probe and runner: C:\Users\Kieran\AppData\Local\Temp\claude\c--Users-Kieran-Desktop-Spacegame\b24c970b-6148-4883-b4f6-ab3b6971e1b5\scratchpad\net\
  (netAudit.ts and netAuditOldReplica.ts, copied into server/src/bench to run; runall.sh; cmp.cjs; report.cjs). Result
  folders before2 (baseline), after, stage1 and before (fixes 1-4 cross-check, unseeded), before2fx (baseline shake).
  The probe was removed from server/src/bench.
- **Caveats:**
  - Inputs are written into the ECS (as netBench does), except the debris acks, which go through the server's real
    `ackDebris`.
  - Two scenarios fight random NPCs; seeding makes them repeat, but the boss run's fight changes once ships ignore
    debris.
  - The Corsair's Rattlers and the Lance still don't fire in the harness (as in the first audit), so the NPC fight
    uses a Corsair that mostly takes hits.
