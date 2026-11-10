# Networking: Crowd fallbacks, structures, cargo, debris
(Part of [networking](../networking.md); the other parts are listed there.)

### Crowd fallbacks (protocol 41, `CAPS.CROWD` 16384, docs/design/awareness-model.md 7.11)

A system over budget degrades by itself, in order: focus radius 19 -> 16 -> 13 -> 10 km, snapshot window 3 -> 6 -> 9
ticks, then time dilation (45, 30, 20, 15 ticks a second). Costs are measured per system (the tick shared by ships,
each client's share of the rounds, an own-clock pass whole), smoothed, held against 13 ms up / 6 ms down with holds and
dwells. Each change goes to the system's clients as a `crowd` message stamped with the system tick it takes effect
from (rates 30 ticks ahead). `/crowd [0-9|auto]` forces a level.
- **Server:** `net/crowd/CrowdControl.ts` (levels), `SnapshotBuilder.due()/ownRound()` (rounds per system, flushes
  per system), `FocusCells` (`focusOf`), `sim/SystemClocks.ts` (own clocks, `SimPass`), `GameServer.tick/ownPasses`
  (passes; table entries with `pass: true` run in every pass and skip other systems), `changeClock` (travel between
  clocks).
- **Client:** `GameState.onCrowd` (the clock turns at the stated tick; another system's clock is taken at once; wider
  windows add interpolation delay), `ShipClient` ghost fade by the focus radius, `ui/TimeScaleBadge.ts`. `?crowd=0|1`.
- **Bench:** `npm run bench:crowd -- --crowd --layouts ball --n 300 --secs 40` (level and base-tick time by second).
- **Tests:** `server/src/net/crowd/crowd.test.ts` (focus shrink and back, windows 6/9/3, dilation and undo, travel
  into and out of a dilated system, automatic levels without flapping; every held ship exact), `client/src/state/
  crowdClock.test.ts`.

### Structures by tick (protocol 42, `CAPS.STRUCTS` 32768, with CAUSES)
Dev builds (`?structs=0|1`). Every rebuild tick of a ship a STRUCTS client holds goes as its own `shipSync`, stamped
`at` (its rebuild tick in the ship's system clock: `ShipHost.systemTick`), in order (server ships/bridge/structLog.ts
keeps the last 8 per ship; SnapshotBuilder `nextSync`/`keptAfter`). The client keeps them by tick (ShipStore
`derivedAt`/`rebuildAt`), and ShipCauses and OwnTick read the structure a ship flew on each tick, so a window with two
rebuilds of a ship, or a contact with one rebuilt since, is worked out on its tick layer instead of keyframed
(Replication `rebuildOk`/`workable` judge against what the client keeps). A log whose tick goes backwards (a refit, a
respawn, a dilated clock) starts over. Legacy and CAUSES-only clients still get a keyframe for such windows. Costs about
1.6% raw bytes in ball 50 (one sync per rebuild tick). Tests: server/src/net/causes/causes.test.ts.

### Cargo causes (`CAPS.CARGO` 65536, with CAUSES or OWN_SIM; protocol 42, no wire change)
Dev builds (`?cargo=0|1`). A hold's mass changing (a pickup, a sale, a tow taken on) goes as an own-ship or other-ship
cause `[ago, 3, mass]` (common network/ownTick.ts `OWN_CAUSE.CARGO`) on the tick the new mass is first flown, instead of
a keyframe of the ship. Unlike the other causes it is applied BEFORE that tick's step (`cargoBefore`, through
`ShipReplicaSet` preStep hooks in ShipCauses and OwnTick); the server's shadows do the same. A change between ticks (a
message handled after `replication.endTick`) is still a divergence and a keyframe. Tests: ownSim.test.ts,
server/src/game/cargo.test.ts. Open (review, 2026-11-05): in the crowd bench's ball 50 a probe's own ship, its cargo changed on the
tick of a grinding contact, was off by one velocity step (1e-4) for 7 snapshots without a keyframe; 0 with CARGO off.

### Debris (protocol 25; CAPS.DEBRIS, protocol 44-47)
When a ship's rebuild point splits it (rebuildNow: what it shed whole this tick first, `DebrisNet.sheds` from `shed`, each group with its fling, crumble time and aloof flag; then the orphan groups), a client that holds the ship gets a `debrisSplit` `[id, tick, e (piece ids, packIds), p (the orphans' parts, packRuns), l, g, s, c, h]` before the ship's own sync, and works the pieces out itself (`deriveSplit`: shed groups as given (`g`, packSheds), then the parts' joins into groups, each piece's blueprint, HP as it has them, the parent's pose at the split's tick, push, spin, fling and crumble times seeded by ship, tick and piece, deterministic trig). Its pose is the server's when the split says it (`s`: a destroyed ship, its own ship, or `c`/`h`: one rebuilt since its last sync, with that structure's centre of mass and the pieces' HP), else its replica's at the tick once the snapshot's causes and decisions are in (before a rebuild there recentred it). It adds them to its store and replicas, makes their status rows (`DEBRIS_STATUS`) and acks each with `debrisHash`. The server holds the pieces back from that client meanwhile (`ClientConnection.debrisHeld`: no sync, keyframe, row or HP); a right ack marks them sent (`SnapshotBuilder.ackDebris`); a wrong one, or none within `DEBRIS_ACK_TICKS` plus twice the ping, and they go as any ship does (a wrong one in its grace is keyframed for that client only). A round that tells a split always sends that client a snapshot (`holdDebris` says so), even with nothing else to send: the client works the split out once that snapshot's causes are in, so without one its acks went late. A split still waiting when its pieces come in full (their hold ran out: a sync, or the snapshot's keyframe) leaves those pieces as sent (`DebrisSplits.flush`).

Debris then drifts and knocks into other debris only (ships ignore it), push only, all pieces of a system stepped together in id order (`stepDebrisWorld`) on the server and in `ShipReplicaSet` (`stepDebrisTo`, through the client's `DebrisWorld`: each piece's shape from the structure it flew that tick). A piece in its grace (`DEBRIS_GRACE_TICKS`, 90 ticks from its spawn tick, `debrisYoung`; a sent piece's sync says `born` and `aloof`) takes force only from its break-up: it neither knocks nor is knocked (shots still hit it). Every part's crumble tick is fixed at its spawn (common ships/debrisLife.ts `debrisDecay`, a parent's for its parts, a shed's own). `CAPS.DEBRIS` (131072, protocol 44): a split marked `l` is the client's to run (client ships/debris/DebrisLives.ts): it works out each crumble's rebuild at its tick (`crumbleRebuild`: structure by tick, what's left recentred in place, the crumble effect shown, what broke off from its pre-recentre body when the server's split names it), so nothing of the piece is sent but its removal (`ClientConnection.debrisLive`: no sync, HP, crumble `partDestroyed` or keyframe) until something else touches it (a shot, fire, a tow: `DebrisNet.told`, and a sync, after which it is told). A client keeps structures by tick (`CAPS.STRUCTS`) and recentres a sent piece from its syncs (`DebrisSplits.after`, `rebuildAt`); Replication's `dver` is the debris keyframe version (not bumped by debris rebuilds). A piece moved by anything else (a tow), and whatever knocked into it or is within reach before the snapshot, is keyframed (`DebrisNet.touched`, Replication `Drift:moved`); so is a piece knocked by one a client doesn't step (out of view, or not had yet). Damage and removal stay server-told; a removed piece it runs knocks in its world up to the snapshot's tick before it goes (`ShipReplicaSet.remove(id, tick)`, `DebrisWorld.runs`: it knows its end), as a quiet window can be long. Measured in docs/audits/debris-2026-11-05.md.

