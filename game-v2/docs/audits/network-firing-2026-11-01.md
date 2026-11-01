# Network audit: what firing costs on the wire (2026-11-01)

Question (owner): download rises by about 3 while firing. Is that necessary, given guns, energy and flight are
deterministic shared code (common/src/ships/guns.ts `stepGuns`, energy.ts `powerTick`, flight.ts)?

Short answer: **the figure is about 3 KiB/s (kilobytes, not kilobits)** of *uncompressed* payload, and roughly
**three quarters of it is avoidable without giving up server authority**. The shot traffic itself is already lean
(fire events, straight-line rows without positions); the waste is in the **hit** side: every hit sends three or four
separate messages, one of them a 39-byte plain object that goes to the whole star system.

Units: the ping panel figure is `bytes / 1024 / s` labelled "KB/s" (client/src/Game.ts:913), counted from
`event.data` in client/src/network/NetworkManager.ts:85, i.e. after the browser has inflated permessage-deflate. So the
panel shows KiB/s of decoded payload; the real wire bytes are lower (deflate) plus packet overhead (below).

## 0. Method

A throwaway vitest harness (deleted afterwards) built a real `GameServer` in-process (`autoStart: false`, sockets that
only count, as server/src/bench/netBench.ts does; no ports, no browser), with `@space-game/common` aliased to
common/src. Every byte counted is the real encoder's output (`encodeServerMessage` / `serverFrame`, split with
`splitServerFrame`); snapshot parts were sized with `encodeBinary` per row. Deflate was simulated as live
(level 4, 8 KB window, frames under 96 B left raw, one stream per connection, Z_SYNC_FLUSH per frame).

Three pilots in Sol: **A** shoots, **B** watches 700 u away, **C** sits 60 km away in the same system. A target is a
pilotless Bastion dummy 900 u ahead (`spawnDummy`, HP scaled x1000 so it survives; this inflates `shipHps` values to
5 digits, see 1.3). 10 s idle, then 10 s with both triggers held. Fixed aim, ships not moved by the harness.

Caveats: bench inputs are written straight into the ECS, so the costs a real client adds by sending inputs (late
inputs forcing `selfLate` own-row resends, hash mismatches) are not exercised; they only ever add own-row resends
(52 B each). Missile and beam loadouts could not be swapped in cleanly, so their figures in 1.4 are computed from code.

## 1. What is sent

Tick 60 Hz, snapshots 20 Hz (`SNAPSHOT_RATE`, common/src/constants.ts:19; GameServer.ts:1017). A client gets at most
one frame per tick (Outbox.ts:87-99); effects in `LAZY_TYPES` (net/snapshot/constants.ts:21) wait up to 2 ticks and ride
the snapshot frame, so in practice frames/s equals snapshots/s. An idle snapshot with nothing new is not sent at all
(SnapshotBuilder.ts:609), which is why idle runs show ~11 frames/s and firing runs ~19.5.

### 1.1 Measured: Hammerhead (12 Rattler autocannons + 6 Pips, ~41 shells/s), firing at the dummy

| receiver | idle | firing | delta | firing, deflated | frames/s |
|---|---|---|---|---|---|
| A shooter | 0.65 KiB/s | **4.25 KiB/s** | **+3.6** | 1.67 KiB/s | 11 -> 19.5 |
| B observer 700 u | 0.37 | 3.93 | +3.56 | 1.33 | 11 -> 19.5 |
| C 60 km, same system | 0.18 | 2.00 | +1.8 | 0.86 | 6 -> 15 |

This is the owner's "about 3". Breakdown of A's firing second (bytes/s, count/s, average size):

| item | A shooter | B observer | C far | per item | where it comes from |
|---|---|---|---|---|---|
| `detonation` | 1607 (41/s) | 1607 | **1607** | 39 B plain object | Weapons.ts:353 `detonate`, via GameServer.ts:707 `broadcastToSystem` |
| own projectile rows `p` | 828 (33/s) | - | - | 22-25 B | SnapshotBuilder.ts:415-437, 530-533 (own shots never go as fire events, :524) |
| fire events `f` | - | 456 (41/s) | - | 10-11 B | SnapshotBuilder.ts:517-529, protocol.ts:1467 `packFire` |
| `projectileHit` | 536 (41/s) | 536 | - | 13 B | Outbox.ts:124 (broadcastNear, 48 km) |
| `damage` | 409 (41/s) | 409 | - | 9-10 B | GameServer.ts:2257-2261 (broadcastNear + source) |
| `shipHps` | 417 (14/s) | 417 | - | 30 B (inflated, see 1.3) | SnapshotBuilder.ts:287-300 |
| snapshot `removed` | 138 (41 ids/s) | 138 | **138** | ~3.3 B an id | SnapshotBuilder.ts:597-604 |
| snapshot headers | +32 | +32 | +37 | 4 B | |
| own pilot row | 26 (0.5/s) | 26 | 25 | 52 B | unchanged by firing (safety resend every 120 ticks) |

Per **shot** fired: 25 B to the shooter (row), 11 B to each observer (fire event).
Per **hit**: detonation 39 + projectileHit 13 + damage 10 + removal 3.3 + its share of shipHps ~10 = **~75 B to
everyone within 48 km, and 42 B to everyone else in the system**. At 41 hits/s that is the whole problem.

Samples (wire form as JSON, from the run):
```
detonation    39 B {"type":"detonation","kind":"cannon","x":26467,"y":20942,"radius":40}
projectileHit 13 B [1,4263,26466.9,20942]
damage         9 B [0,4249,14,4241]
shipHps       24 B [4,[[4249,[[148,59986],[151,59986]]]]]
projRow       22 B [4262,48.41,0.63,1,2,26414.3,20892,4241]      (id, vx, vy, type, age, spawnX, spawnY, owner)
fireRow       14 B [4241,1,143,143,4262]                          (owner step, ticks ago, part, aimQ, id step)
removed        7 B [4263,4264]
own row       52 B [4241,1,26000,21000,0,0,0,300,300,[522240,100,900,0,0,0,1000,0,100,1,0,100,0,100,0,0,0,0,0,0],null,0]
```

### 1.2 Measured: other cases

| case | A idle -> firing | B observer | notes |
|---|---|---|---|
| default guest Sparrow (2 Pips, 8 shells/s), empty space | 0.59 -> 0.58* | 0.32 -> 0.49 | own rows 182 B/s, fire events 80 B/s |
| default guest Sparrow at the dummy | 0.62 -> 1.18 | 0.34 -> 1.10 | detonation 312, damage 168, projectileHit 104 B/s |
| Hammerhead, empty space | 0.62 -> 1.51 | 0.34 -> 1.01 | own rows 1011 B/s (41/s), removals 110 B/s |

\* the idle second included a one-off 2.7 KB `shipSync` (the dummy's blueprint).

So shots alone cost ~1 KiB/s for a heavy ship; hits cost ~2.5 KiB/s more.

### 1.3 Things that are fine already (no change needed)

- **Snapshots** are binary rows (`packSnapshot`, `encodeSnapshot` protocol.ts:1546), 4 B of header, per-row keys so
  unchanged rows are not resent; keyframe and control rows encoded once for every client.
- **Other ships' shots** go as fire events (11 B), and the client rebuilds the shells from the replicated pose
  (`rebuildVolley`; checked bit for bit in server/src/net/replication.test.ts). No per-tick projectile positions are
  sent for straight shells: x/y are dropped while on the line (SnapshotBuilder.ts:426-436).
- **Own pilot row**: resent only on a trigger or every 2 s (SnapshotBuilder.ts:535-549, `SELF_SAFETY_TICKS`
  constants.ts:6). Firing does not change its key (hp, shield, EMP, field, warmth, slowed), so charge draining while
  firing costs nothing today. Measured 0.5/s idle and firing.
- **Beams**: weapon beams are a bit in the cursor state and status row; beam damage is told every 10 ticks
  (ships/bridge/weapons.ts:385), not per tick.
- **Floats**: the codec sends decimals as integer mantissas (binaryCodec.ts `number`), 4-5 B for a position to 0.1.
  Not JSON anywhere on the hot path except the non-COMPACT messages (detonation is one).
- **Frames**: capped at one per tick and in practice one per snapshot; the lazy effects are merged (no extra frames
  observed). Each frame still costs ~70 B of TCP/IP + TLS + WS headers on the real wire (not shown in the panel):
  20 frames/s is ~1.4 KB/s of headers whether or not the payload shrinks.
- `shipHps` at 30 B is inflated by the harness (HP scaled x1000 gives 5-digit values); with normal part HP (100-500)
  expect ~18-20 B a message.

### 1.4 Computed (not measured): homing missiles and ammunition

- **Homing missiles**: a projectile row's key includes vx, vy (SnapshotBuilder.ts:435), and a turning missile is off
  its line, so it carries x, y too: ~34 B **every snapshot** (20/s) while it steers, to everyone within 12 km
  (`SNAP_PROJECTILE_RANGE`). An 8-missile Swarm volley steering for 2 s: 8 x 34 x 20 = ~5.4 KB/s while in flight.
- **Ammunition**: opening a crate sends the whole `items` and `profile`; emptying one sends `profile` again
  (server/src/game/Ammo.ts:74-91). Measured for a fresh guest: profile 260 B, items 185 B (a real account's are
  bigger: every ship record and loadout). Missile crates hold 24 rounds, so a missile battery resends the profile
  every few seconds. Ammo counts themselves are not streamed per shot (good).

## 2. What is redundant, given determinism

1. **`detonation` for ordinary shells.** `Weapons.detonate` (Weapons.ts:347-354) broadcasts for every shell that has
   extras, and every modelled or graded gun's shell has extras (Weapons.ts:116-120: only a bare default `cannon` shell
   skips them). For a shell with no splash, EMP or split it carries nothing the client lacks: the point is in the
   `projectileHit` sent the same tick, the kind is known from the shell's row or fire event, and the radius is the
   default 40. It is also a **plain object (39 B)**, not a `COMPACT` row, and goes by `broadcastToSystem`
   (GameServer.ts:707 -> Outbox.ts:107): **every pilot in the system pays for every hit, however far away** (pilot C:
   1.6 KiB/s for a fight 60 km off). Side finding: on the client, kind `cannon` falls through to the "Missile: a proper
   fireball" branch (client/src/ships/DamageFx.ts:333) with a sound and a screen shake within 1500 u, so every Rattler
   hit currently plays a small missile explosion. Probably unintended; worth a look either way.
2. **Projectile removals.** A shell that hit was announced by `projectileHit` (and the client already tracks pierce,
   WeaponFx `pierceLeft`); a shell that expired did so at a tick the client can work out (spawn tick + life; ends are
   already sent as `endTick`). Yet each goes again as an id in `snapshot.removed`. Worse, removals in the player's
   system go to every client whether or not it was ever sent that entity (SnapshotBuilder.ts:600: the
   `!prevStates.has` test is only applied to other systems), so pilot C got 41 ids/s for shells it never saw.
3. **The shooter's own shells as full rows.** The client already fired them itself (ShipClient.predictGuns, WeaponFx
   "predicted" shells) from the same barrel on the same tick; the 22-25 B row exists only to tell it each shell's
   server entity id (so `projectileHit`/removal can find it) and to confirm it was fired. A fire-event-like
   confirmation (`[ticks ago, part, id step...]`, ~5 B) does that; spawn x/y, velocity, owner, type are all known.
4. **Three messages per hit.** `projectileHit` (id + x + y), `damage` (target, amount, source) and `detonation` each
   carry their own header, ids and position for the same event. One hit record could carry it all: the position is on
   the shell's known line (spawn + velocity x age), so a one-byte sub-tick fraction, or nothing, replaces 8 B of
   coordinates.
5. **Per-hit damage numbers to third parties.** `damage` goes to everyone within 48 km (FX_RANGE, constants.ts:25)
   for every hit, ~2 per target per frame at this fire rate. Summing per (target, source) per frame halves it;
   limiting the floating numbers to the shooter, the target and pilots on screen (~24 km) trims more.
6. **Part HP to a tenth** (`hpWire`, SnapshotBuilder.ts:73-76) for what the client uses only for damage visuals and
   hull %: a byte of "fraction of max" (0-127, keeping "never rounded down to nothing") would do.
7. **Homing missile rows every snapshot** (1.4): a dead-reckoning threshold (send when the client's straight-line guess
   is off by more than N units, as `MAP_DOT_SLACK` does for map dots) would cut most of them.
8. **Whole profile/items per crate** (1.4): a small `ammo` delta (`[kind, item, rounds left]`) would do.

Not redundant: fire events to observers (they carry the server's decision that a gun fired, which depends on energy,
clip and ammo state observers do not have), and the 2 s own-row safety resend (cheap insurance).

## 3. Optimisations, ranked

Savings are for the measured Hammerhead-at-target second (A's firing delta was +3.6 KiB/s raw).

### Cheap wins (days, not weeks; no change to who decides anything)

| # | change | saves | risk | effort | wire bump |
|---|---|---|---|---|---|
| 1 | Detonations by `broadcastNear` (FX_RANGE) instead of to the whole system: Weapons' host `broadcast` (GameServer.ts:707) gets the msg's x/y | **1.6 KiB/s for every pilot >48 km away** in a system with a fight (scales with players x fights) | none | 1 line + test | no |
| 2 | No `detonation` for a shell with no splash/EMP/split (pierce hits keep theirs): the client plays the impact on `projectileHit` from the shell's kind (it has `shellLooks`/WeaponFx shots). Or at least add `detonation` to `COMPACT` (39 -> ~13 B) | **1.57 KiB/s** for A and B (44% of the firing delta); COMPACT alone ~1.0 KiB/s | low (visual only; decide what a Rattler hit should look like, section 2 item 1) | small: Weapons.ts:347-354 + DamageFx call | COMPACT: yes; skip-only: no |
| 3 | Removals: never send a removal id the client was not sent (fix the same-system shortcut at SnapshotBuilder.ts:600 for projectile rows); then let `projectileHit` imply removal and let the client expire shells at end of life | 138 B/s each (C: all of it) | low; keep a client-side lifetime backstop for missed paths | small | no |
| 4 | Own shots: a confirmation per volley (`[ticks ago, part, id steps]`, ~5 B) instead of a 22-25 B row; rows stay for shells the client could not predict (salvo followers, homing, a ship it has just been given a keyframe for) | **~0.65-0.8 KiB/s** for the shooter | medium (WeaponFx must match by part and tick; fall back to rows) | medium | yes |
| 5 | Sum `damage` per (target, source) per frame in the Outbox before flushing; numbers only to source, target and pilots within screen range | ~0.2-0.3 KiB/s | low (merged numbers look slightly different) | small | no |
| 6 | Crate opened/emptied: a 3-field `ammo` message, not `profile` + `items` | 0.1-0.5 KiB/s for ammo guns | low | small | no (new message) |
| 7 | `shipHps` as fraction of max (0-127), and at 10 Hz for ships that are not yours | ~0.15-0.25 KiB/s | low | small | yes |

After 1-5: A's firing delta goes from ~3.6 to ~1.0 KiB/s raw; pilots far off pay nothing for others' fights.

### Protocol redesigns (weeks; only if 1-5 are not enough)

| # | change | saves | risk |
|---|---|---|---|
| A | **Hit records in the snapshot**: `snapshot.h` rows `[shell id step, target step, amount, flags (crit, glancing, pierce, kill), sub-tick]`, ~6-7 B, replacing `projectileHit` + `damage` (+ the removal) for projectile hits; position from the shell's line. Splash, beams and burns keep `damage` | ~0.8 KiB/s on top of 1-5 (hit cost 65 B -> ~7 B) | medium: homing shells need their point sent; effects can arrive up to 2 ticks later than now (they already wait, LAZY_TICKS) |
| B | **Deterministic shell ids**: ids as (owner, per-owner sequence) instead of global entity ids, so no id ever needs sending: own-shot confirmations become a count, fire events lose their id steps | ~1 B a shell per receiver | medium-high: every projectile lookup changes |
| C | Missile dead reckoning or deterministic homing (target pose is replicated) | most of 1.4's ~5 KB/s per volley | medium: homing must be bit-identical, or tolerate a slack |
| D | Fire bit in the replicated control row and clients run `stepGuns` for other ships | the fire events (11 B a shot) | **high, not recommended**: observers would need each ship's energy, clip and ammo state; a desync shows phantom or missing fire. Fire events are already the right trade |

### Server authority

Nothing above lets a client decide a hit, damage, a shot or a charge: the server still runs everything and the
messages only stop describing what the client can already work out. Two things would break it and should not be
done: letting the shooter's client report hits or damage ("client-side hit detection"), or trusting a client's
energy/ammo state to allow a shot. Note also #5 and the energy plan below reduce what third parties learn (other
pilots' exact damage and energy), which is a small anti-cheat gain.

## 4. Energy per part: how to replicate it cheaply

Today: the own pilot row carries the whole charge, the pool and up to 24 groups in hundredths of a percent
(energy.ts:71-105 `PILOT_ROW`, `packCharge`; SnapshotBuilder.ts:329-360), and the gun-state correction
(guns.ts:159 `packGunState`), but the row's resend key (SnapshotBuilder.ts:539) leaves charge out, so draining while
firing costs nothing; the client runs the same `powerTick`, snaps to the server's values whenever an own row arrives
and replays its pending inputs (client/src/state/GameState.ts:905-912). Guns use a patient correction
(client/src/ships/gunSync.ts, `GUN_STATE_PATIENCE` = 30 ticks, guns.ts:133).

The coming per-part state is about one value per energy part: a Hammerhead has 18 weapons + 12 engines + 8 power
parts = 38 values (more with conduits). Sizes in this codec: an int under 128 is 1 B; 128 and over 3 B; a decimal
like 87.35 is 4 B. So a naive full vector is 38 x 3-4 = **~110-150 B**. The trap: if it goes in the own row and the
row's key (SnapshotBuilder.ts:539) or a status row's key includes it, the row goes **every snapshot** while anything
fires or thrusts: 150 B x 20 = **3 KB/s, doubling the firing cost**. Recommendation:

1. **Derive, do not stream.** Per-part energy is a pure function of things the client already has (blueprint and
   topology, part HP alive/dead, its own inputs, its own gun events, EMP ticks, field/lodestone flags, warmth). Let
   the shared `powerTick` run per part on the client, as charge does now. Send nothing per tick.
2. **Make the state exact so a correction is exact.** Store per-part energy as integers (fixed point, e.g. milli-E or
   1/100 E) in the shared code, as flight rounds to `SHIP_PRECISION` each tick. Then a snap from the server is
   bit-exact, replays agree, and a hash is meaningful. (Today's hundredths-of-a-percent snap is already lossy.)
3. **Checksum, not data.** Fold an energy digest (FNV over the per-part integers and the gun state) into the existing
   `stateHash` (common/src/network/stateHash.ts; sent once a second from client/src/Game.ts:1085-1100, checked in
   server/src/net/handlers/flight.ts:59-89 against 3 s of per-tick hashes). A mismatch sets `forceSnapshot`, which
   sends the correction. Cost: 0 extra bytes down while in step.
4. **Event triggers.** Send the full vector, once, when the server knows the client cannot have predicted it on the
   right tick: a part destroyed/rebuilt/detached (`ship.rebuilds` changes), EMP, an energy-draining hit (siphon),
   hazards; the same idea as the keyframe version for flight. Do not add the vector to the row's resend key.
5. **Encode the correction compactly.** Its own field at the END of the own row (after the gun state; never in the
   middle, networking.md "Add a pilot-row field") or a separate compact message `[tick, ...]`: a "full" bitmask (one
   7-bit int a byte, so 6 B for 38 parts), then only the non-full parts' values quantised to 0-127 of capacity
   (1 B each) if (2) is not done, or as exact integers if it is. Typical: 6 + ~10 x 1-3 B = **15-35 B a correction**,
   at the 0.5 Hz safety rate ~10-20 B/s.
6. **Patient adoption**, as gunSync does: take the server's value only after disagreeing for ~30 ticks, and apply the
   delta (server - mine at T) to the present so the client's own spending since T is kept.
7. **Pilot only.** Other players never need per-part energy (if a visual tell is wanted, e.g. a browned-out ship, one
   bit in the status row's `statuses`). Sending it to them would also leak when an enemy is dry.
8. **Replace, don't add.** The per-part vector makes data[1] (gauge), [8] (pool) and the groups derivable on the
   client; drop them from the row when it lands, and fold `packGunState` into the same vector (the design's "buffer"
   is the clip and charge state).

Expected cost of per-part energy with 1-8: about 0 B/s while in step, ~10-20 B/s of safety corrections, a 15-35 B
burst after a part is lost. Versus the naive per-snapshot vector: ~3 KB/s.

## 5. Anchors used

server/src/net/SnapshotBuilder.ts:312-450 (systemRows), 476-645 (sendSnapshots; fire 517-529, own row 535-549,
removals 597-604); server/src/net/snapshot/Outbox.ts:62-139; server/src/net/snapshot/constants.ts:6,21-25;
server/src/game/Weapons.ts:116-120, 247-268, 347-354; server/src/GameServer.ts:707, 2257-2262; server/src/ships/bridge/weapons.ts:184,196,226,385;
server/src/game/Ammo.ts:58-91; common/src/network/protocol.ts:1327 (COMPACT), 1403 (packProjectile), 1467 (packFire),
1546 (encodeSnapshot); common/src/network/binaryCodec.ts (number encoding); common/src/ships/energy.ts:71-105;
common/src/ships/guns.ts:133,154-169; common/src/network/stateHash.ts; server/src/net/handlers/flight.ts:59-89;
client/src/Game.ts:913, 1085-1100; client/src/network/NetworkManager.ts:85; client/src/state/GameState.ts:905-912;
client/src/ships/gunSync.ts; client/src/ships/ShipClient.ts:770-815; client/src/ships/DamageFx.ts:203,333;
client/src/rendering/weapons/WeaponFx.ts (predicted shells, CONFIRM_TICKS).
Re-measure with `npm run bench:net` (server/) after changes; its `snap.*` breakdown shows the same categories.
