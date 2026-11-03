# Netcode dual mode: running snapshots and lockstep side by side (2026-11-03)

Question (owner): is it practical to put a protocol wrapper around the networking, so the game has two systems: the
current snapshot replication and the lockstep design? I'm not sure I want to commit to lockstep yet. If we do, it will
need refinement and testing before it can replace the current system, which works but costs more. Which architecture
changes would make that possible, or move us toward lockstep before we commit?

Research only. No code was changed. Inputs: docs/areas/networking.md, docs/design/netcode-lockstep.md (the lab spec),
docs/audits/network-weapons-lockstep-2026-11-03.md (the network audit), docs/audits/js-math-determinism-2026-11-01.md,
the server's net/, ships/ and game/ code, the client's Game.ts, GameState.ts, ShipClient.ts and serverMessages.ts, and
the lab in prototypes/netcode-lab/.

## Summary and recommendation

**Two modes are practical, but not as a wrapper around the transport.** The modes differ in what the client
*simulates*, not in how bytes are encoded. The switch has to sit in one specific layer: below gameplay (the sim and
what it reports happened) and above the transport (`Transport.ts`, `SocketTransport`, `LocalTransport` are shared and
stay as they are). Today that layer is `SnapshotBuilder` + `Outbox` + `Replication` on the server, and `GameState.applySnapshot` + the `ShipClient` replication hooks on the client.

**The current system is already half lockstep.** Ship motion is relayed controls, stepped the same way on both
sides by the shared `replicaStep`. Divergence is caught by a server-side shadow and fixed with a keyframe
(server/src/net/Replication.ts). Shots are fire events that every client rebuilds deterministically (`rebuildVolley`).
The lockstep design keeps that pattern and pushes it further in three ways:
- it covers hits, damage, loot and AI;
- divergence is caught by client reports and hashes, not by a server shadow;
- ids are per-client slots.

So the two modes are not two separate systems. They are two settings of one model: **for each entity and each
client, either the server describes what happened, or the client works it out and the server checks it.**

**Per-client mixing on one server works.** The lab already does it: one deterministic authoritative world, and each
client is served by its own mode (`prototypes/netcode-lab/labserver.js:241`). The condition is that every system a
lockstep client simulates must also be deterministic and shared on the server. Snapshot clients don't care whether it
is. So making the server sim deterministic piece by piece costs the snapshot clients nothing, and each piece can be
turned on for some clients and not others.

**Recommendation:**
1. **Don't build the full dual-mode layer now.** Port the lab's lockstep client and server only after hits and damage
   run in shared deterministic code. Until then a lockstep client would have nothing to simulate beyond what
   replication already does.
2. **Do the compatibility refactors first** (section 4). Each one pays for itself in the current system: the
   bandwidth wins from the network audit, reproducible tests, fewer bug classes, and a smaller GameServer. The top five:
   1. one sim-event model;
   2. RNG keyed by (tick, entity, purpose);
   3. the cross-engine determinism harness plus deterministic maths on the code paths both sides already share;
   4. one per-client interest set;
   5. AI orders and impulses replicated as controls.

   Together they are about **5-7 weeks of focused work**.
3. **Grow lockstep as islands inside the current protocol, each behind a per-client capability bit.** Debris (in
   flight now) comes first, then shell hits, then damage, then NPC motion. Every island can be compared side by side on
   one server with the lab's metrics, and switched off per client if it misbehaves.
4. **Build the two-mode layer** (`ClientSync` on the server, `WorldSync` on the client) only when the islands cover
   shells, hits and damage. Run it on the dev server, compare it against snapshots, and switch over only when the
   criteria in section 5.6 are met.
5. **Time-box the dual running.** If lockstep doesn't meet the criteria within an agreed window, delete the lockstep
   path and keep the refactors.

Two facts limit the upside, and they should be on the table before committing:
- **Lockstep can never fully replace the snapshot path in this game.** Clients see ships out to 40 km (`SHIP_VIEW_IN`,
  server/src/net/snapshot/constants.ts:15), and the lab simulates a 1.5 km awareness. The far view will always be
  replicated the current way. "Switching over" therefore means the inner radius changes mode; the outer view does not.
- **On WebSocket the lab's bandwidth win mostly disappears once headers are counted:**
  - lockstep: 6.7 KB/s with headers, against 9.0 KB/s for the lab's current style;
  - lockstep sends 64 messages a second against 24;
  - the game today sends 12-20 frames a second (network audit 1.3).

  The win only comes back by coalescing ticks per message or by moving to datagrams. Measure that in the real game
  before treating bandwidth as the reason to switch.

## 1. How the two designs line up

| concern | current (live code) | lockstep design (lab) | gap |
|---|---|---|---|
| input timing | Tick-stamped already: `targetTick`, low 16 bits on the wire, scheduled per client (server/src/net/handlers/flight.ts:95-113). A late input is applied **at once** and flags `selfLate` (flight.ts:108-111). The lead comes from ping (client/src/state/GameState.ts:506-509) | A late input is used on the **next** tick and the client is told (`LATE`). The lead is tuned from the server's smallest-lead report in each pong (labserver.js:149-160) | small |
| own ship | predicted from inputs and re-simulated after a snapshot (GameState.reconcilePlayer, :864); 1 Hz own-ship hash (client/src/Game.ts:1098-1117) against 3 s of server hashes (flight.ts:72-87) | predicted, re-simulated from the last confirmed tick; hashes of every tracked entity every 2 s | small |
| other ships' motion | **relayed controls + shared `replicaStep`**, checked by a server shadow, keyframed when they differ (server/src/net/Replication.ts:78-130) | relayed inputs + shared sim, checked by client reports and hashes, corrected by entry snapshots | **same idea**; the checking is on the other side |
| AI ships | the brain runs on the server; its controls go out as control rows (the same path as players) | the brain runs on the client inside the radius; a pulled-in AI is a "puppet" whose brain output is relayed | the puppet **is** today's path |
| shots | fire events, rebuilt by every client (`rebuildVolley`, client/src/ships/ShipClient.ts:346); own shots as rows | every copy simulates every shell | close |
| hits, damage, part loss, debris | server only (server/src/ships/bridge/damage.ts, GameServer.ts collisionSystem :3659); sent per hit as `damage`, `projectileHit`, `partDestroyed`, `detonation` | simulated by every copy; the client reports a 2-3 byte hash per event | **large** |
| randomness | per-module streams shared across the whole server (`mulberry32(0x5eed)` Enemies.ts:344, Events.ts:193, Bosses.ts:171, BrainHost `rng`), plus `Math.random` in about 25 places | one stream per entity, kept in its state | medium |
| ids | bitecs entity numbers, reused (see the comment at GameServer.ts:2287) | per-client slots (varint, quarantined); shells are (shooter slot, shot number); rocks by seed index | medium-large |
| interest | ships within 40/48 km plus party and target (SnapshotBuilder.updateShipView :722); shells and mobs within 12 km; pods within 3 km; effects within 48 km (`broadcastNear`); some messages go to the whole system | awareness of 1.5/1.7 km plus one hop of interactions (pull-in) | medium (a different job, see 3.5) |
| maths | transcendental `Math` calls everywhere: common 148, server/game 385, server/ships 72, GameServer 48 (non-test) | Q16 fixed point, sine table, no `Math` transcendentals | large |

## 2. Seam map

### 2.1 Seams that already exist

These are places where "what happened" is already apart from "what to send". The dual layer would build on them.

| seam | where | why it helps |
|---|---|---|
| **ShipHost event callbacks** | server/src/ships/bridge/core.ts:18-140: `notifyDamage`, `notifyProjectileHit`, `notifyPartDestroyed` (a typed `PartDestroyedEvent`), `notifyContact`, `onShipDestroyed`, `arcHop`, `intercept`, `onHeal` | The ship sim already reports events, not messages. GameServer turns them into messages in one block (GameServer.ts:2264-2312). This is the natural start of a shared event model. |
| **fire records** | `ShipBridge.fired` (server/src/ships/ShipBridge.ts:51-52), filled by bridge/weapons.ts, drained by SnapshotBuilder (:523) | A sim-side event list that the snapshot path turns into wire rows. It is the same shape as the lab's `fireLog`. |
| **pending removals** | `pendingRemovedEntities`, read once per snapshot (SnapshotBuilder.ts:597-603) | despawn events, already separate from sending |
| **per-client send loop** | `SnapshotBuilder.sendSnapshots` (:476-640) keeps all its per-client state on `ClientConnection` (repKnown, shipView, shipSynced, knownEntities...) | The body of that loop *is* a snapshot strategy. Pulling it into a `SnapshotSync` per client is mostly a move. |
| **tick table** | server/src/tickOrder.ts and `buildTickSystems` (GameServer.ts:3318-3384) | A lockstep record step ("log this tick's inputs, events and hashes") is one more entry after `replication.endTick`, the same as `recordSelfHashes`. |
| **client replication hooks** | `GameState.preSnapshot`, `onReplication`, `replicaPose` (GameState.ts:248-252), wired in Game.ts:276-281 | The client already lets one module (ShipClient) decide how other ships are placed. A `WorldSync` would own these hooks. |
| **a second world-sync already exists: proto mode** | `ProtoHooks.afterInterpolate` writes in-process sim state straight into `GameState` (Game.ts:87-96); prediction off (Game.ts:243); replication hooks skipped (Game.ts:277) | Precedent: renderers and UI already work from a `GameState` filled by something other than snapshots. |
| **brain output is input-shaped** | `PilotOrders` (core.ts, after :140): controls, firing, aim, aimDist, impulse | Matches the lab's "AI brains output on the wire's grid", except for `impulse` (network audit item 6). |
| **seeded child randomness** | debris `seededRng(hashInts(parentEid, tick, k))` (rebuild.ts:411), bullets `hashString('bullet:'+tick+':'+eid)` (GameServer.ts:3483), shots `shotSeed` (common/src/ships/rng.ts) | The keyed-RNG pattern is already used in the places that replicate best. |
| **shared hit maths** | common/src/ships/collide.ts (`castParts`, `nearestParts`), common/src/ships/damage.ts (penetration, resistances) | The hit tests and damage formulas are already shared. Applying the damage (bridge/damage.ts `hurt`, `splashAt`, `applyBlast`, `partDeaths`) is not. |
| **ShipBridge has no server dependencies** | server/src/ships/ShipBridge.ts and bridge/*.ts import only `@space-game/common`, bitecs and their own features; the one `fs` import is in a test (bridge/imports.test.ts); features/types.ts and tow/Towing.ts take `LootPods` as a type only | About 3,100 lines of ship sim could move to common with a host interface. |

### 2.2 Where game code is coupled to the snapshot protocol

| coupling | where | what it means for two modes |
|---|---|---|
| **Gameplay builds `ServerMessage`s directly** | `Weapons.ts` builds `ignite`/`detonation` through `host.broadcast` (:257, 263, 326, 353), wired to `broadcastToSystem` (GameServer.ts:713); the boss brains build `bossTelegraph`, `bossBeam`, `detonation`, `ignite`, `thermal`, `bossBlow` through `BrainHost.send` (pyreclast.ts 18 sites, scrapMother.ts 11, staged.ts 5; kit.ts:21); `death` (GameServer.ts:3803, 3840); `effect` (about 10 sites in GameServer) | A lockstep client simulating that boss or shell must make these itself, and a snapshot client must be sent them. Today the decision is made inside the sim. These should become sim events (refactor R1). |
| **Effects are driven by per-hit messages** | client: `damage` → damage numbers, hit flash, HUD indicator, stats (client/src/app/serverMessages.ts `damage`, about :205); `projectileHit` stops the tracer and throws sparks; `partDestroyed`, `contact`, `detonation`, `ignite`, `intercept` → DamageFx (ShipClient.handleMessage :765-866) | In lockstep these come from the local sim. FX need to take one event type from either source (3.4). |
| **Client code reads snapshot rows by index** | 22 client files index `entity.data[...]` or `status[...]` (GameState.ts 24 sites, Renderer.ts 11, ShipRenderer.ts 10, ShipClient.ts 10, WeaponFx.ts 7, SystemMapUI.ts 6, Game.ts 5, ...). The pilot row layout (networking.md "Own pilot row") and the ShipBody row (`data[5]` core %, `[7]` hull %, filled by ShipClient.fillHull :375) | Renderers depend on the *wire layout*, not on a state type. A lockstep `WorldSync` would have to fake these arrays (as `placeReplica` already does for other pilots, ShipClient.ts:411-419) or the reads would need a typed view. Faking is cheaper; a typed view is cleaner. |
| **Client entity map keyed by server entity id** | `GameState.entities: EntityMap<number, InterpolatedEntity>` (GameState.ts:187); 35 client files read `state.entities` | Lockstep slots are per-client wire ids, so the client still needs one stable id per entity. Keep the map keyed by a uid the sync layer resolves. |
| **Projectiles live as entities with server ids** | removed through `snapshot.removed`; rebuilt shells take the server's shell ids from fire events (ShipClient.preSnapshot :305-389); rows for your own shots | In lockstep, shells are named (shooter, shot number). An id scheme derived from the shooter (R5) serves both. |
| **Own-ship correction tied to the pilot row** | `reconcilePlayer` reads the pilot row (charge groups, gun state, features' extras); `selfKey`/`selfVersion` decide resends (SnapshotBuilder.ts:535-549) | A lockstep entry or correction snapshot would carry the same state in another form. Both should come from one state schema (R10). |
| **Byte accounting by message type** | `Outbox.bytesByType` (Outbox.ts:31, 64, 104); the admin dashboard and `bench:net` read it | A lockstep bundle is one message type. It needs categories (the lab's: inputs, entries, corrections, ticks, ...). |
| **Wire pins** | `computeWireHash` covers the COMPACT tables, a sample frame, CTL, the keyframe tail, `PILOT_ROW`, `PORTS_SLOT_LAYOUT`, the gun-state layout (common/src/network/wireHash.ts:24-52) | Lockstep records need their own pinned layouts. See risk 2. |
| **Interest is spread over five mechanisms** | `updateShipView` (SnapshotBuilder.ts:722-737), `SNAP_PROJECTILE_RANGE` / `SNAP_POD_RANGE` (constants.ts:8-9), `broadcastNear` with `FX_RANGE` (Outbox.ts:129-139), `broadcastToSystem` (Outbox.ts:107-121), and the removal rule (SnapshotBuilder.ts:597-603) | Lockstep's awareness-with-pull-in has to fit beside these, or replace the inner part of them. One interest object per client makes that possible (R8). |
| **Collisions and projectile motion live in GameServer** | `projectileSystem` (GameServer.ts:3522), `collisionSystem` (:3659), asteroid hits, `shotWall`, stuck shots | These can't be shared until they leave the 4,331-line GameServer (R9). |
| **Server-only side effects inside sim callbacks** | `spendAmmo` (ammunition from the pilot's stores), `partLost` (gems), `payRebuild`, `payRepair`, `canDamage` (PvP zones), `invulnerable` (admin god mode, docked) (GameServer.ts:2275-2330) | A client can't evaluate these. In lockstep they would arrive as inputs or flags (for example a dry-ammo bit in the fire event, which already exists as `dry`). Each host callback needs to be classed as pure (can move to common) or authority-only (its result is replicated). |

### 2.3 The work in flight and how it fits

Another agent is changing the current netcode:
- no detonation for plain shells;
- effects sent by distance;
- damage rounding;
- ships ignoring debris;
- the ports `replicaStep` fix;
- **debris lockstep**: client-derived debris spawns confirmed upward, deterministic trig for debris only, and shared
  debris–debris contacts.

These touch Weapons.ts, Outbox.ts, SnapshotBuilder.ts, the GameServer notify block, bridge/flight.ts
`resolveContacts`, bridge/rebuild.ts `spawnDebris` and common/src/ships/replica.ts. Treat all of them as moving until
it lands; R1 and R8 below should start after it.

Debris lockstep is the first island of the hybrid described here, and it hits each of the general problems at small
scale:
- **ids**: the client-derived debris needs the server's entity id (R5);
- **maths**: it introduces the first deterministic trig (R3);
- **shared code**: debris contacts move from the server into shared code (R9);
- **checking**: the server has to check what clients derived, which is a confirmation path.

The deterministic trig it adds should go in a module everything can use (for example common/src/math/det.ts), not
stay private to debris. If the old debris replication can stay reachable behind a per-client switch, it becomes the
first island that can be compared side by side (stage 2).

## 3. Interface sketch

### 3.1 Where the switch sits

```
 gameplay (sim systems, brains, bridge)          <- shared by both modes; reports SimEvents, never ServerMessages
 ─────────────────────────────────────
 SimCore (common)  +  SimEvent log per tick      <- what happened
 ─────────────────────────────────────
 per-client sync strategy (server/src/net/sync)  <- what to send: SnapshotSync | LockstepSync
 per-client world sync (client/src/net/sync)     <- what to simulate: SnapshotWorld | LockstepWorld
 ─────────────────────────────────────
 codec + transport (common/network, SocketTransport, LocalTransport)   <- unchanged
```

### 3.2 Shared: the sim core and the events

```ts
// common/src/sim/events.ts: one event model for both modes
export type Uid = number;                  // stable per entity (R5), not a bitecs slot
export type SimEvent =
  | { k: 'hit'; tick: number; target: Uid; source: Uid; shot?: number; part: number; amount: number; hpAfter: number; flags: number }
  | { k: 'partLost'; tick: number; body: Uid; part: number; how: 'blast' | 'break' | 'crumble'; x: number; y: number; vx: number; vy: number; size: number }
  | { k: 'kill'; tick: number; target: Uid; by: Uid }
  | { k: 'spawn'; tick: number; uid: Uid; kind: 'shell' | 'debris' | 'loot' | 'ship'; parent?: Uid }
  | { k: 'despawn'; tick: number; uid: Uid; why: number }
  | { k: 'contact'; tick: number; a: Uid; b: Uid; x: number; y: number; nx: number; ny: number; speed: number }
  | { k: 'fx'; tick: number; kind: string; at: Uid | [number, number]; data?: number[] };   // telegraphs, detonations, ignite
export interface SimEventSink { push(e: SimEvent): void }

// common/src/sim/core.ts: what both the server and a lockstep client step
export interface SimCore {
  step(tick: number, inputs: ReadonlyMap<Uid, InputFrame>, events: SimEventSink): void;
  enter(blob: EntityBlob, tick: number): void;   // an entry or correction snapshot
  exit(uid: Uid): void;
  serialize(uid: Uid): EntityBlob;               // one state schema gives entries, keyframes and hashes (R10)
  hash8(uid: Uid): number;
}
```

`SimEvent` is what the lab already does: `W.events` with `k: 'hit' | 'pick'` (prototypes/netcode-lab/world.js:267-282)
feeds both the current-style hit list and the lockstep report hashes (`eventHash8`, world.js:337). The server's
`SimCore` is the real one; a lockstep client runs the same code on its aware subset.

### 3.3 Server: one sync object per client

```ts
// server/src/net/sync/ClientSync.ts
export interface TickRecord {                  // built once per tick, read by every client's sync
  tick: number;
  inputs: ReadonlyMap<Uid, { input: InputFrame; changed: boolean; seq?: number }>;   // players and AI orders
  events: readonly SimEvent[];
  fired: readonly FireRecord[];
}
export interface ClientSync {
  readonly mode: 'snapshot' | 'lockstep';
  readonly interest: InterestSet;              // R8: view tier, simulated tier, effect radius
  onTick(rec: TickRecord): void;               // lockstep: write this tick's bundle; snapshot: queue events by interest
  onSnapshot(rows: SystemRows): void;          // snapshot: today's SnapshotBuilder per-client body; lockstep: the far tier
  onUp?(msg: ClientSyncUp): void;              // lockstep: ack, event reports, hashes
}
```

`SnapshotSync` is today's per-client loop body (SnapshotBuilder.ts:490-635) plus its share of Outbox's broadcasts.
`LockstepSync` is the lab's `bundle`/`checkReports`/`detect` (labserver.js:354-545) on game entities.
`ClientConnection` gets a `sync: ClientSync` and keeps only connection state.

### 3.4 Client: one world sync

```ts
// client/src/net/sync/WorldSync.ts
export interface WorldSync {
  handle(msg: ServerMessage): boolean;         // snapshot | bundle (+ shipSync etc. in both)
  frame(now: number): void;                    // snapshot: prediction ticks; lockstep: confirmed + predicted advance
  place(renderTick: number, entities: EntityMap): void;   // fills InterpolatedEntity (and the data[] rows renderers read)
  readonly events: { on(fn: (e: SimEvent) => void): void };   // DamageFx, WeaponFx, HUD, audio subscribe here
}
```

`SnapshotWorld` turns `damage`, `projectileHit`, `partDestroyed`, `contact`, `detonation` and `death` into `SimEvent`s,
then hands them to the same subscribers. FX code stops caring where an event came from. That one change is worth doing
in snapshot mode alone: it makes the effects testable without a server, and it lets the audit's compact hit record
(item 4) change the wire without touching FX.

### 3.5 Sync tiers per entity: the key idea

A single per-client mode is not enough. Each client should sort the entities it knows into tiers:

| tier | what the client does | what is sent | today |
|---|---|---|---|
| **S, simulated** (lockstep) | runs the full shared sim (flight, guns, hits, damage, brains once in common) | changed inputs, entries, corrections; the client reports events and hashes | nothing yet (debris is the first) |
| **R, replicated** | steps motion from controls (`replicaStep`), rebuilds shots from fire events; told about hits | control rows, keyframes, fire events, hit and damage events | every ship within 40 km |
| **D, dead-reckoned** | straight-line or orbit guess | a row when it changes or drifts | shells and mobs within 12 km, pods within 3 km, map dots |

Snapshot mode is "tier S is empty". Lockstep mode is "tier S = awareness plus pull-in, tier R = the rest of the
40 km view". Islands (stage 3) widen what tier S covers, one system at a time. Seen this way, the dual-mode layer is
the tier policy plus the two kinds of tier-S plumbing (bundles and reports), not a second netcode.

### 3.6 Mixing modes on one server: what works and what breaks

| area | works? | what has to be true |
|---|---|---|
| authority | yes | The server stays authoritative for everyone and never applies a client's event (lab rule). Client modes can't change the outcome: a CI test should check that the server's world hash is the same whatever modes the clients use. |
| server determinism | only for tier-S systems | Whatever lockstep clients simulate must be deterministic on the server too. Snapshot clients don't care, so it can be done piece by piece. |
| AI brains | yes, as puppets | Until the brains are in common, AI ships stay tier R for lockstep clients. That is the lab's "puppet", and it is today's control-row path. Better once orders include impulses (R7). |
| events | yes, with the event model | The server must send `damage`/`projectileHit`/... only to clients that hold the entity in tier R, and log the events lockstep clients are expected to report. `broadcastNear` has to ask each client's interest set instead of using a fixed radius. |
| interest management | yes, if unified | Tier S (awareness, pull-in, stickiness) and tier R (view with hysteresis, party, target) come from one per-client `InterestSet`. Today they are separate checks. |
| SimLod (server/src/ships/SimLod.ts) | yes | A dormant ship wakes before a client can see it (`PROMOTE_RADIUS` > `SHIP_VIEW_OUT`), so tier S, which is smaller, only ever holds live ships. |
| ids | needs R5 for children | Slots are per client anyway. But spawned children (shells, debris, loot) need ids both sides can derive, or a confirmation, which debris lockstep is building. |
| randomness | needs R2 | A client holding part of the world can't replay a module-wide stream (`Enemies.rng`, `Bosses.rng`, BrainHost `rng()`). |
| admin actions | needs a hook | A teleport, spawn or god mode outside the sim must cause a correction for lockstep holders (today: a keyframe version bump). Route admin changes through a sim event or a "dirty" mark. |
| own ship | yes | Both modes predict it the same way. Only the correction message differs. |
| bandwidth fairness | watch | Lockstep clients get other players' inputs at full precision (an aim-assist leak that snapshot clients don't have). This matters only on PvP servers. |

### 3.7 What the layer costs

Assuming the refactors in section 4 are done:

| piece | effort | risk |
|---|---|---|
| `ClientSync` split: move the SnapshotBuilder per-client body into `SnapshotSync`, interest into `InterestSet` | 1 week | low if it is a pure move (frameHash.golden.json must stay identical) |
| `WorldSync` split on the client: `GameState.applySnapshot` + the ShipClient hooks into `SnapshotWorld`; FX onto `SimEvent` | 1.5-2 weeks | medium: 35 files read `state.entities`, 22 read `data[]` |
| `LockstepSync` on the server: port the lab's awareness, pull-in graph, slots, quarantine, bundles, report checks and corrections (labserver.js:295-545, about 250 lines) to game entities | 2-3 weeks | medium |
| `LockstepWorld` on the client: confirmed and predicted world copies, rollback, catch-up (labclient.js:141-415). The game's entity state (parts, ports, guns, features) is far heavier to clone than the lab's | 3-4 weeks | **high**: client CPU (risk 8) |
| tier-S coverage: everything a lockstep client simulates must be in `SimCore` (stages 3a-3e) | most of the work | high |

**The dual-mode plumbing alone is about 2-2.5 months. The simulation it needs is extra.** Full lockstep, with AI
brains in common, is 5-8 months, which matches the network audit's "several months".

## 4. Compatibility refactors, ranked

Ranked by (value to the current system + progress toward lockstep) against effort and risk. "Pure move" means the
golden frame hash (server/src/golden/frameHash.golden.json) must not change. "Numeric" means it changes the goldens
once, on purpose (frameHash, parity.golden.json, common/src/ships/golden/flightTraces.golden.json).

| # | refactor | value now | toward lockstep | effort | risk | files |
|---|---|---|---|---|---|---|
| **R1** | **One sim-event model.** Sim code pushes `SimEvent`s into a per-tick log. One `EventReplicator` in server/net decides who gets what, how it is packed, distance and coalescing. Move the direct `ServerMessage` builders (Weapons `host.broadcast`, BrainHost `send`, `death`, combat `effect`) behind it. The ShipHost notify callbacks become thin adapters that push events | Bandwidth: one place for the audit's items 1-4 (no detonation for plain shells, effects by distance, damage summed per target per snapshot, the 7-byte hit record). Bugs: one rule for "who hears this". Tests: assert on events, not bytes | **high**: lockstep reports hash exactly these events, and `GONE`/"unseen" are decided from them | 1-1.5 weeks (about 60 call sites) | low-medium: pure move first, packing changes later with a wire bump | server/src/GameServer.ts:2264-2312, 3803, 3840, effect sites; server/src/game/Weapons.ts:257-353; server/src/game/brains/kit.ts:21, pyreclast.ts, scrapMother.ts, staged.ts; server/src/net/snapshot/Outbox.ts; new common/src/sim/events.ts |
| **R2** | **RNG keyed by (tick, entity, purpose).** `rngFor(tick, uid, PURPOSE)` built on `hashInts`/`seededRng` (common/src/ships/rng.ts). Replace the module streams (Enemies.ts:344, Events.ts:193, Bosses.ts:171 and BrainHost `rng` :270, GameServer.ts:1404) and `Math.random` in the sim (Sieges ×11, GameServer :1082, 1352, 1840, 1978, 3024, LootPods :100, Arenas, Surfaces, AsteroidRegistry ×6, the respawn rally handlers/flight.ts:233) | Reproducible fights and bugs. Bench runs become comparable (the audit's runs varied because "the ambient world uses unseeded randomness"). The frameHash test no longer needs to monkeypatch `Math.random`. One pack's spawn no longer changes another pack's dice | **required**: a partial-world client can only replay per-entity streams | 3-5 days | low; numeric (goldens once); balance unchanged statistically | the files listed; a lint rule banning `Math.random` in server/src/game, server/src/ships and common/src/ships |
| **R3** | **Cross-engine determinism harness, and a replica hash in `stateHash`.** Golden vectors for `replicaStep`, `rebuildVolley` and the shared flight step, run in Node, Chromium, Firefox and WebKit (js-math-determinism §5). Fold one or two replica hashes into the 1 Hz `stateHash` the client already sends | Closes a real blind spot today: replicas assume Node and every browser agree on `sin`/`cos`, and nobody checks (network audit 3.1). A drifting replica is never corrected until its next keyframe | **gate**: it is the switch-over test | 2-4 days | none to the game. Follow the one-headless-browser-at-a-time rule | common/src/ships/replica.ts, launch.ts, common/src/network/stateHash.ts, client/src/Game.ts:1098-1117, server/src/net/handlers/flight.ts:58-70 |
| **R4** | **Deterministic maths for the shared paths, one island at a time.** A common/src/math/det.ts (sin, cos, atan2, hypot through sqrt; js-math-determinism §3), started by the debris work. Then flight.ts and replica.ts (9 calls), then launch.ts, shot.ts, guns.ts and turret.ts, then collide.ts. Lint-ban the transcendental `Math` calls in common/src/ships | Replicas and rebuilt shells become exact on Firefox and Safari, so fewer keyframes and fewer phantom misses there | **required** for anything in tier S | flight and shots: 1 week; all of common (148 sites): 2 weeks | medium: numeric (parity and flight goldens regenerate); benchmark before and after | common/src/ships/*.ts; new common/src/math/det.ts |
| **R5** | **One per-client `InterestSet`.** Built once per tick per client: the ship view with hysteresis, party, target (SnapshotBuilder.ts:722-737), shell, mob and pod ranges, effect radius, system-wide broadcasts, the removal rule. Outbox's `broadcastNear` and `broadcastToSystem` ask it. Leave room for a pull-in hook | Removals go only to clients that were sent the entity (audit item 2). Effects by distance in one place. Testable without a socket. Cheaper (`broadcastNear` today runs a `Math.hypot` per client per message, Outbox.ts:135) | **high**: awareness and pull-in become a tier inside it | 1 week | low-medium; start after the in-flight Outbox and SnapshotBuilder changes land | server/src/net/SnapshotBuilder.ts, server/src/net/snapshot/Outbox.ts, constants.ts, ClientConnection.ts (`shipView`, `knownEntities`) |
| **R6** | **AI orders on the wire grid, and impulses replicated as controls.** `PilotOrders.impulse` (bosses' drives, mites' dashes; pilotless.ts:87) goes into the control stream and `replicaStep` (audit item 6). Brain aim and distance are quantised on the input grid. A fixed think rate staggered by uid (Enemies already does 12 + eid%7 ticks, Enemies.ts:1095) | Boss keyframes from 17 a second to almost none (about 0.5 KB/s in the boss fight). Removes correction stutter at its cause | **high**: AI ships become clean puppets; later the brain output and the relayed input are identical | 1 week | low; wire bump | server/src/ships/bridge/pilotless.ts, common/src/ships/replica.ts, common/src/network/replication.ts, server/src/net/Replication.ts, server/src/game/Enemies.ts |
| **R7** | **Tidy tick-stamped inputs.** A late input is used on the next tick, not mid-stream at once (flight.ts:108-111). The server reports the smallest input lead in each pong. The client tunes its lead from that, not from ping (GameState.ts:506) | Fewer late inputs, so fewer own-row resends (`selfLate`) and fewer own-ship corrections | medium: same clock as the lab | 2-3 days | low-medium: prediction-sensitive (see the warning at the top of flight.ts) | server/src/net/handlers/flight.ts, client/src/state/GameState.ts, protocol `pong` |
| **R8** | **Stable ids for spawned children.** Shells = (owner uid, shot counter), debris = (parent, tick, k) (already its seed, rebuild.ts:411), loot = (source, tick, k). Keep a uid ↔ eid map on the server; at first only fire events and debris use it. Later every entity gets a uid that bitecs reuse can't touch | Removes the "entity number reused" bug class (GameServer.ts:2287 has to work around it). Fire events can drop shell ids. Client-derived debris needs no id confirmation | **required** for tier S | narrow version: 1 week; all entities: 2-3 weeks | medium-high: touches every projectile lookup and the client's `entities` keys | server/src/game/Weapons.ts, ships/bridge/weapons.ts, rebuild.ts, GameServer.ts, SnapshotBuilder.ts, client ShipClient.preSnapshot, GameState |
| **R9** | **Move the ship sim and collisions into common.** ShipBridge + bridge/* (about 3,100 lines; only common and bitecs imports) and the projectile, collision and asteroid-hit systems out of GameServer.ts (:3522, :3659) into common/src/sim behind a host interface. Classify each host callback as pure or authority-only (2.2) | GameServer shrinks (modular-layout standard). The client can run the same hit tests for impact timing and anchoring. Unit tests without a whole server | **prerequisite** for hits and damage in tier S | 2-4 weeks | medium; must be a pure move (frameHash identical) | server/src/ships/**, server/src/GameServer.ts, the server/src/golden/shipBridgeApi.json pin |
| **R10** | **One state schema per sim entity.** One declaration per component gives the keyframe row, the entry snapshot, the 8-bit hash and the correction. This generalises `packKeyframe`/`cloneBody` and the pilot row's feature extras (features.wire.json) | New ship fields stop needing hand edits in three places (keyframe, pilot row, hash) | **high**: lockstep entries and hashes come from the same declaration | 2 weeks | medium; wire bump | common/src/network/replication.ts, common/src/ships/replica.ts, energy.ts `PILOT_ROW`, features registry |
| R11 | Brains into common (Enemies 1,407, Bosses 550, brains about 2,050 lines; 385 transcendental calls in server/src/game) | little | needed only for AI inside tier S | 6-10 weeks | high | server/src/game/** |

**Top five, in order:**
1. **R1**, the sim-event model (1-1.5 weeks): the bandwidth fixes the audit asks for land here anyway.
2. **R2**, keyed RNG (3-5 days): small, and makes every later comparison reproducible.
3. **R3 + R4**, the harness plus deterministic maths for flight and shots (about 2 weeks): fixes a live blind spot and
   is the switch-over gate.
4. **R5**, the interest set (1 week): one place for "who gets what", which lockstep awareness then slots into.
5. **R6**, AI orders and impulses as controls (1 week): a bandwidth and jitter win now, and it makes AI ships clean
   puppets.

Do R7 (inputs) alongside any of them. R8-R10 come in stage 3, when the first island needs them. R11 only if lockstep
is adopted.

## 5. A staged path

Each stage ships on its own and leaves the current system working.

### Stage 0: in flight now (no new work)
- **What it is:** the cheap wins plus debris lockstep.
- **Value:** the shake is gone, and about 40% of combat traffic.
- **Ask before it lands:** keep the old debris path reachable per client, so it becomes the first island to compare
  (stage 2).

### Stage 1: compatibility refactors (about 5-7 weeks in total, any order within the constraints)
- **What it is:** R1, R2, R3 + R4 (flight and shots), R5, R6, R7.
- **Order constraints:** R1 and R5 after the in-flight work; R2 before any numeric golden regeneration (so it happens
  once); R3 before R4 (so the harness shows the gain).
- **Value:** the audit's items 1-6 land on clean seams, fights are reproducible, replicas are checked across engines,
  and GameServer is smaller.
- **Exit:** goldens regenerated at most once per numeric refactor; netBench numbers recorded before and after.

### Stage 2: capability bits and the metrics to compare with (about 1 week)
- **Capability bits:** a per-client `caps` bitfield in `join`. It is a JSON field, so no wire bump
  (common/src/network/protocol.ts:160). It is stored on `ClientConnection`. A dev setting turns it on, and only the dev
  server accepts it (as with guest admin). One bit per island: `DEBRIS`, `HITS`, `DAMAGE`, `NPC_SIM`.
- **Metrics:** the lab's categories in `Outbox` (inputs, entries, corrections, ticks, events, rows, header), plus
  per-client desync counters by reason (mismatch, missing, spurious, hash, unseen), correction latency, late inputs,
  and the client's sim ms per frame. Show them in the admin panel and the ping panel.
- **Probe:** a headless probe like the lab's `server/probe.js`. Two scripted clients, one with the caps and one
  without, fly the same script against a real `GameServer` and print both. The 2026-11-03 audit's probe (in the
  scratchpad) already builds the in-process server.
- **Value:** the current system gets per-category byte counts too, which the audit had to build by hand.

### Stage 3: lockstep islands, inside the snapshot protocol

Each island is behind its own capability bit and is checked with the stage 2 probe on the dev server.

| island | client does | server does | needs | effort | value without full lockstep |
|---|---|---|---|---|---|
| **3a debris** (in flight) | derives debris spawns, simulates debris and debris contacts | confirms ids, keyframes only on disagreement | R4 (det trig for debris), R8 (narrow) | in flight | fewer debris keyframes, less freighter jitter |
| **3b shell hits** | runs `castParts` for rebuilt shells against replicated ships, draws impacts at once, reports an event hash per hit | sends a hit record only when the client lacks the shooter or the target (lab `GONE` and "unseen"), or on a report mismatch | R1, R4 (shots, collide), R8 (shell ids), R9 (collisions part) | 2-3 weeks | impacts drawn without waiting for a message. Bandwidth gain over the audit's item 4 is small (about 7 B a hit, audit 2), so **do this only if heading for lockstep** |
| **3c damage and part loss** | applies damage with the shared `hurt`/`splashAt`/`partDeaths`, rebuilds after part loss, reports | sends `shipHps` and `partDestroyed` only on mismatch or to tier-R clients | R9 (bridge damage in common), R10 | 3-4 weeks | HP and part loss in step with impacts |
| **3d NPC motion** | AI ships as puppets with impulses (R6). Later, simple brains (drones, traffic) run in common | relays orders | R6; R11 for brains | puppets: done by R6; simple brains: 2-3 weeks | already in stage 1 |
| **3e rocks** | asteroids already come from a seed (`asteroidSeed`, GameState.handleAsteroidSeed); add the lab's override table for damaged and destroyed rocks | overrides on entry, destructions as ids | R1 | 1 week | fewer asteroid HP and removal messages |

### Stage 4: the two-mode layer behind a flag (about 8-12 weeks)
- **What it is:** the `ClientSync` and `WorldSync` splits (pure moves first). Then `LockstepSync` and `LockstepWorld`
  ported from the lab, with tier S covering the islands above and tier R everything else.
- **Where it runs:** dev server only.
- **Exit:** the server's world hash doesn't depend on client modes (CI); the snapshot-mode frameHash is unchanged;
  the lockstep-mode golden is pinned.

### Stage 5: side by side, measured (2 weeks of tooling, then as long as it takes)
- **Probe:** the stage 2 probe and the lab's `probe.js` script against the dev server on the VPS, with added latency
  of 10, 60 and 137 ms.
- **Scenarios:** the audit's set (idle, 2 Pips, Hammerhead light spam, Bastions, Spark/Chainsaw, pirate fight,
  Scrap Mother).
- **Real play:** players opt in on the dev server, with Firefox and Safari players asked for specifically.
- **Report:** a table in the same form as netcode-lockstep.md "Measured", but from the game.

### 5.6 Switch-over criteria (all must hold)

| criterion | threshold |
|---|---|
| determinism | The golden-vector harness is bit-exact for 10,000 ticks of every tier-S system on Node, Chrome, Firefox, Safari macOS, iOS Safari and Android Chrome. In the field, `hash` desyncs (drift not explained by unseen hits) below 1 per player-hour, and no entity that desyncs again and again |
| corrections | All corrections in heavy fights at or below the lab's level (about 1 a second at the edge of a fight). p95 from event to corrected screen under 250 ms at 137 ms RTT |
| bandwidth | **Wire bytes with headers** at least 30% below snapshot mode in the heavy-fight scenarios, and no worse idle or in travel. If headers erase the gain (as in the lab), coalescing has to be in place and measured first |
| feel | Own ship and own shots at 0 ms (as today). Other ships' drawn error no worse than the audit's 1.4 table today (mean under 1 unit, p95 under 2 units, no new hitches). Input-to-screen delay measured with the lab's `DelayMeter` |
| client CPU | Lockstep sim plus re-simulation p95 under 2 ms a frame on the low-end reference machine (2.5-4× slower JS than the dev desktop; profile-2026-10-31). Busiest-fight frame still inside 16.7 ms |
| server CPU | Awareness, pull-in, bundles and report checks for the target population add under 1 ms a tick (the tick is 1-2 ms today) |
| coverage | Every gameplay system either runs in tier S or is explicitly tier R for lockstep clients. Nothing works only in snapshot mode |
| tools | Admin panel, monitor, netBench, the goldens and proto mode all work with lockstep clients |

If these don't hold by the agreed date, delete stage 4's lockstep half and keep everything else.

## 6. Risks and deal-breakers

| # | risk | why it matters | containment |
|---|---|---|---|
| 1 | **Double maintenance** | Every new feature needs a snapshot wire form (pilot row, status row, COMPACT entry, bump) **and** a lockstep form (deterministic code in common, a state schema entry, hash coverage). That is the real cost of two modes, and it lasts as long as both exist | Feature code writes only to `SimCore` and `SimEvent`. Wire forms come from the state schema (R10), so a feature declares its state once. A CI parity test runs one scenario with mixed client modes and checks the server's outcome is identical. Time-box the dual running |
| 2 | **Protocol hashing** | `computeWireHash` pins COMPACT, the sample frame, CTL, `PILOT_ROW`, `PORTS_SLOT_LAYOUT` and the gun state (wireHash.ts:24-52). Lockstep records and entry blobs need pins too. Otherwise every lab-style tweak either goes unpinned (silent mis-decode) or bumps `PROTOCOL_VERSION` for everyone (forced reloads) | One `PROTOCOL_VERSION` for both modes (every client carries both codecs). Add a `LOCKSTEP_LAYOUT` (record ids and the entry schema, including the ports slot layout the entry blob carries) to `computeWireHash`, so lockstep changes are bumps, made on purpose with `wire:bump`. While lockstep is dev-only, batch its changes into few bumps. The dictionary stays append-only and shared |
| 3 | **Golden tests** | frameHash pins every raw frame per pilot. parity.golden.json pins the server, client and replica runs. tickOrder.json pins the tick table. serverMessages.json lists the client's handled types. shipBridgeApi.json pins the bridge API. Numeric refactors (R2, R4) and moves (R9) all touch them | One rule: a pure move keeps every golden identical; a numeric change regenerates them once, in its own commit, with a reason. Snapshot mode stays the default, so frameHash keeps meaning "the live protocol". Add a separate lockstep frameHash when stage 4 lands. The lockstep record step is one deliberate tickOrder.json change |
| 4 | **Admin and dev tools assume snapshots** | `Outbox.bytesByType` counts by message type; the admin panel, `bench:net` and the VPS monitor read snapshot traffic. Admin actions (teleport, spawn, god mode, AdminTools.ts) change state outside the sim, which lockstep clients can't see. `replay.ts` and proto mode (Game.ts:87-96, 243, 277) are a third sync style | Byte categories (stage 2) replace type-only counts. Admin changes go through a "dirty" mark that causes a correction (lockstep) or a keyframe bump (snapshot), the same as a collision today. Proto mode stays as it is: it reads the in-process sim and is neither mode |
| 5 | **Server-only callbacks inside the sim** | `spendAmmo`, `partLost`, `payRebuild`, `payRepair`, `canDamage`, `invulnerable` (GameServer.ts:2275-2330) depend on economy, accounts and admin state the client lacks | Classify each ShipHost callback during R9. Results that change the sim (dry ammo, invulnerability, PvP permission) travel as flags on inputs or fire events (`dry` already does). Pure-economy effects stay server-only and never touch sim state |
| 6 | **The view is far bigger than awareness** | 40 km of visible ships against 1.5 km of affordable simulation. Tier R (today's replication) never goes away | Accept it: "switch-over" means tier S grows, not that snapshots are deleted. That is also why per-entity tiers are the right abstraction rather than a global mode |
| 7 | **Headers erase the bandwidth win on WebSocket** | Lab: 64 messages a second against 24, and with headers the two styles cost about the same (netcode-lockstep.md, Measured) | Coalesce 2-3 ticks per message (adds 17-33 ms to other players' confirmed inputs, not to your own ship). WebTransport datagrams would be a separate project. Measure in stage 5 before treating bandwidth as the motive |
| 8 | **Client CPU for re-simulation** | The lab re-simulates 3-13 ticks of the displayed world on every bundle. The game's per-ship step (parts, ports energy, guns, features) is far heavier than the lab's, and low-end machines already approach budget in the busiest fight (profile-2026-10-31: 10-17 ms a frame estimated) | Re-simulate only your own ship and what it interacts with in the unconfirmed window (shells you fired, ships within contact range); show everything else at its confirmed tick, as tier R does today. Measure against the CPU criterion in 5.6 |
| 9 | **Cross-engine maths** | Transcendentals differ between V8, SpiderMonkey and JSC, and between versions (js-math-determinism §1b). Today's replicas are already exposed | R3 + R4 before any tier S. The harness runs in CI, and weekly on browser betas |
| 10 | **Information exposure** | Lockstep clients get other players' exact inputs and, inside awareness, brain state and HP | Acceptable for PvE. On PvP servers, keep players as tier R for each other if aim assistance becomes a concern |
| 11 | **Collision with the in-flight work** | The other agent is editing Weapons.ts, Outbox.ts, SnapshotBuilder.ts, the GameServer notify block, bridge/flight.ts, bridge/rebuild.ts and replica.ts | Start R1, R5 and R9 only after it lands. R2, R3 and R7 touch other files and can start now |

**Deal-breakers?** None outright. The two things that could make a dual-mode layer a bad idea are:
- running both modes open-ended (risk 1);
- committing before stage 5 shows a real-wire bandwidth win (risk 7).

Both are handled by the order above: the refactors are worth doing whatever the outcome, and the expensive
two-mode layer only gets built when the islands already prove the simulation side.

## 7. Anchors

- server/src/net/SnapshotBuilder.ts:476-640 (`sendSnapshots`, the per-client loop), :516 (`replication.forClient`),
  :523 (fire events), :535-549 (own row), :597-603 (removals), :722-737 (`updateShipView`)
- server/src/net/Replication.ts:78-130 (`endTick`, the shadows), :160-182 (`forClient`)
- server/src/net/snapshot/Outbox.ts:54-139 (send, lazy, `broadcastToSystem`, `broadcastNear`); constants.ts:6-25
- server/src/net/handlers/flight.ts:22-23 (input limits), :58-87 (state hashes), :95-113 (scheduling, late inputs),
  :116-134 (applying input)
- server/src/net/ClientConnection.ts (per-client sync state); server/src/net/ServerCtx.ts
- server/src/GameServer.ts:3179-3233 (game loop; `step()` at :1018 for transports and tests), :3241-3268 (`drainInputQueue`), :3318-3384 (tick table),
  :2264-2330 (ShipHost wiring: notifyDamage, notifyPartDestroyed, notifyContact, intercept, spendAmmo, canDamage),
  :713 (Weapons `broadcast`), :3522 (`projectileSystem`), :3659 (`collisionSystem`), :3803 and :3840 (`death`)
- server/src/ships/bridge/core.ts:18-140 (`ShipHost`, `PartDestroyedEvent`, `PilotOrders`); rebuild.ts:405-434
  (`spawnDebris`, keyed RNG); server/src/ships/ShipBridge.ts:51 (`fired`)
- server/src/game/Weapons.ts:257, 263, 326, 353; server/src/game/brains/kit.ts:15-30 (`BrainHost.send`, `rng`);
  Enemies.ts:344, 1094-1095; Bosses.ts:171, 270; Events.ts:193
- common/src/ships/rng.ts (`hashInts`, `seededRng`, `shotSeed`); common/src/ships/collide.ts; common/src/ships/damage.ts
- common/src/network/wireHash.ts:24-52; protocol.ts:160 (`join`), :1333 (`COMPACT`)
- client/src/state/GameState.ts:187 (`EntityMap`), :248-252 (replication hooks), :506-531 (lead, target tick),
  :601-718 (`applySnapshot`), :864 (`reconcilePlayer`)
- client/src/ships/ShipClient.ts:305-389 (`preSnapshot`), :391-420 (`onReplication`, `placeReplica`), :765-866
  (`handleMessage`)
- client/src/Game.ts:87-96 (`ProtoHooks`), :243, :276-281 (hooks wired), :975-1006 (frame: prediction, interpolate),
  :1098-1117 (state hash)
- client/src/app/serverMessages.ts (`damage`, `death`, `projectileHit`, the `TABLE`)
- server/src/golden/frameHash.test.ts, parity.test.ts, tickOrder.json, serverMessages.json, shipBridgeApi.json
- prototypes/netcode-lab/labserver.js:87-101 (`hello`, the mode per client), :149-160 (`queueInput`, LATE),
  :192-252 (`tick`, the mode dispatch at :241), :295 (`graph`), :354-545 (`bundle`, `checkReports`, `detect`),
  :547 (current-style `snapshot`); labclient.js:83-140 (`BaseClient`), :141 (`LsClient`), :416 (`CurClient`);
  world.js:229-337 (`step`, events, hashes)
