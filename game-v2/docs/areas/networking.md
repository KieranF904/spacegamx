# Networking and protocol
How client and server talk: message types (objects over a WebSocket), the compact/binary wire encoding, the snapshot and ship-replication format, the version/hash handshake, and the transports (WebSocket, in-process). Gameplay never touches sockets; it builds `ServerMessage`s and the codec turns them into frames. Read this instead of protocol.ts (1,585 lines) when adding a message or a snapshot field.

## Files (what each owns)
| path | lines | owns |
|---|---|---|
| common/src/network/protocol.ts | 1585 | `PROTOCOL_VERSION`/`PROTOCOL_WIRE_HASH` (l.31-33), core `Client*`/`Server*` interfaces and the `ClientMessage` (l.187) / `ServerMessage` (l.703) unions, `EntityState`/`EntityType` (330-360), map-dot packing, binary input codec (`encodeInputBinary` l.1163, `decodeInputBinary` l.1189), `COMPACT` table (just above `COMPACT_TYPES`, l.1299), `SNAP_FIELDS`, `wireTables()`, `packSnapshot`/`unpackSnapshot`, `encodeServerMessage`/`serverFrame`/`decodeServerFrame` (1469-1585) |
| common/src/network/econProtocol.ts, socialProtocol.ts, contributorProtocol.ts | 381 / 226 / 33 | message families (economy+profile+quests, party/trade/chat, contributor notes); re-exported from protocol.ts and unioned into `ClientMessage`/`ServerMessage` |
| common/src/network/binaryCodec.ts | 287 | tagged binary value format, `DICTIONARY` (fixed head here + `ids` from wire-dictionary.json), `encodeBinary`, `BinaryReader/Writer` |
| common/src/network/wire-dictionary.json | | append-only manifest of ids (models/materials/pieces) sent by index; edited by `npm run wire:sync` |
| common/src/network/wireHash.ts | ~40 | `computeWireHash()` (FNV of `wireTables()` + a sample frame); used by protocol.test.ts and the bump script; not exported from index.ts |
| common/src/network/PROTOCOL_CHANGELOG.md | | one line per version, appended by `wire:bump` |
| common/src/network/replication.ts | 270 | ship keyframe/control-row packing (`packKeyframe`, `packControlRow`), client `ShipReplicaSet` (steps every replicated ship with the shared `replicaStep`) |
| common/src/network/cursorState.ts | 86 | 13-bit aim quantisation, `packCursorWeaponState` (= pilot row `data[0]`) |
| common/src/network/stateHash.ts | 38 | `computeStateHash` (client/server desync check) |
| common/src/network/Transport.ts | 47 | `ClientTransport`, `ClientSocket`, `ClientLink`, `DisconnectInfo` |
| server/src/net/SocketTransport.ts | 191 | HTTP (/health, /auth/*) + `ws` server; per-IP cap 16 sockets, 512 KB max message, 8 MB buffered cap, permessage-deflate, bad-frame log throttle |
| server/src/net/LocalTransport.ts | 62 | in-process transport for proto mode and tests (real encode/decode, synchronous) |
| server/src/net/Replication.ts | 183 | a server shadow per ship, stepped with the controls clients know; mismatch => keyframe version bump |
| server/src/net/MessageLimits.ts | 76 | `MESSAGE_LIMITS` token buckets per message type, `MessageLimiter` |
| client/src/network/NetworkManager.ts | 158 | browser WebSocket: reconnect back-off, `decodeServerFrame`, per-message error isolation, traffic counters |
| scripts/wire/sync.mjs, bump.mjs | | the two wire tools (below) |
| server/src/net/auth.ts | 199 | join, authLogin, authRegister and the HTTP auth endpoints (`registerAuthHandlers`, `handleHttpAuth`); the guest-name rules |
| server/src/net/handlers/modules.ts, shipEdit.ts, flight.ts | 170 / 145 / 256 | the message families registered by `registerModuleHandlers` (forwards to one module), `registerShipEditHandlers` (dock, ship edit, pilot info) and `registerFlightHandlers` (input queueing, ping, stateHash and the self-hash record, interact, respawn, target, tow, mapView, trainingDrone) |
| server/src/net/dispatch.ts | 55 | the client message registry (`HandlerRegistry`, `dispatch`): pre-join gate, per-type rate limit, handler call. Handlers are registered in `GameServer.buildMessageHandlers()`, which calls the family registrars: `registerModuleHandlers` (net/handlers/modules.ts), `registerAuthHandlers` (net/auth.ts), `registerShipEditHandlers` (net/handlers/shipEdit.ts), `registerFlightHandlers` (net/handlers/flight.ts) |
| server/src/net/SnapshotBuilder.ts | 828 | the snapshot path (`SnapshotBuilder`, built once from a `SnapshotHost`): `sendSnapshots`, `systemRows` (the pilot row), `sendShipUpdates`, `rowKey`/`internKey`, `sendMapDots`, `updateShipView`, `enterSystem`, `sendPlayerState`, `sendSystemInfo`; `SnapRow`, `designHash` (`hpWire` is common hitRules.ts), the player/projectile/pod queries |
| server/src/net/snapshot/Outbox.ts, constants.ts | 177 / 27 | the sending side: `send`, `queue`, `flushOutbox`, `flushLazy` (the lazy effects), `broadcastToSystem` (an eye-and-ear effect, `LAZY_TYPES`, with a place goes `broadcastNear` instead: `fxPoint`), `broadcastNear`, `broadcastProjectileHit`, `addDamage`/`flushDamage` (damage summed per target, source and glancing till the next snapshot, to a tenth), the byte counters; the snapshot tuning (`LAZY_TYPES`/`LAZY_TICKS`, `SHIP_VIEW_IN/OUT`, `SELF_SAFETY_TICKS`, `DEBRIS_ACK_TICKS`, ranges). GameServer keeps one-line delegates (`send`, `flushOutbox`, `sendSnapshots`, ...) |
| common/src/ships/debris.ts, common/src/math/detTrig.ts | 352 / 389 | debris both sides work out alike: a split's pieces (`deriveSplit`, sheds `ShedSpec`/`packSheds`/`shedCrumble`, the grace `DEBRIS_GRACE_TICKS`/`debrisYoung`, `splitPose`, `splitRng`, `debrisSpin`, `debrisMotion`, `debrisHash`), the drift and push-only knocks (`stepDebrisWorld`, `stepDebrisBody`), the wire packing (`packIds`, `packRuns`); deterministic `dsin`/`dcos`/`dsincos`/`datan2`/`dhypot`/`dexp`/`dlog`/`dlog2`/`dpow` (only exact operations: the same bits in every engine), which flight and shells use too (docs/design/deterministic-maths.md; checked across engines by `npm run det:engines`) |
| common/src/network/cells.ts | 170 | the focus grid (protocol 38, `CAPS.FOCUS` 1024): cells, home cells, focus/ring, ghost weight, the ships-away list both ends keep (`AwayShips`, protocol 49) |
| common/src/network/hits.ts | 100 | confirmed hits on the wire: `CAPS` (the join's bit mask), `ShellHitRecord`, `packHits`/`unpackHits`, `hpChecksum` |
| server/src/net/hits/HitLedger.ts | 475 | confirmed hits, the server side: `shellHit`/`hitFx`/`end` during the tick, then per capable client `plan` (in the snapshot loop; for a client finding its own, which hits it can find: `unfindable`), `write` (after its snapshot; then `judge` its journal, a `hitFix` if need be), `check` (after its HP); `report` (a client's hit report); `endSnapshot` switches caps and tells the client (`netCaps`). `confirmedHits.test.ts` beside it is the parity test |
| client/src/ships/hits/ConfirmedHits.ts | 370 | confirmed hits, the client side: `expand` (a record into the messages the server would have sent, HP into the ship store), `check` (hpCheck), `clientCaps()` (the `?hits=0|1` and `?selfhits=0|1` switches); for client-detected hits `own` / `told` / `oldWay` / `flushPending` (a frame's hits) and `corrected` (a hitFix) |
| client/src/ships/hits/SelfHits.ts | 300 | client-detected hits (protocol 28, design part D): the tick-faithful layer (shells moved in f32 as the server moves them, cast against replicas at the collision step's tick with common `shipSegmentHit`), the hit chain (`hitHash` sum), the report for the next input, and a correction's comparison |
| server/src/net/hits/SelfHitJournal.ts | 130 | client-detected hits, the server side per client: the chain by snapshot window, reports, judging (silence is no change; a disagreement twice running is corrected), the correction to send |
| common/src/network/packed/tables.ts, packedCodec.ts | 118 / 265 | bit-packed frames (protocol 29, docs/design/packed-frames.md): `PACKED_FRAME`, the message codes and field tables (hashed into `wireTables()`); `PackedEncoder` (server, one per client), `PackedDecoder`, `ServerFrameReader` (client: base frames and packed messages, a packed one as one or more sub-frames; `needsResync`) |
| common/src/network/packed/packedIO.ts, rowsIO.ts, snapshotSections.ts | 609 / 75 / 233 | the codec's bits and per-connection state (`PackedIO`), the entity and keyframe row bodies (shared by the sections and the blocks), a snapshot's per-connection sections |
| common/src/network/packed/blocks.ts, blocksSnapshot.ts, blockPeer.ts | 388 / 276 / 72 | encode-once blocks (protocol 37, `CAPS.BLOCKS` 512): `BlockStore` (server, one, Outbox.blocks: wire ids, per-entity chains, each row's block made once), the BLOCKS snapshot (`planBlocks`, `blocksWrite`, `blocksRead`), what one connection's ends keep (`BlockPeer`) |
| server/src/net/snapshot/PackedLink.ts | 129 | a packed client's frames (`ClientConnection.packed`, made and drained by Outbox): each base frame a sub-frame, coalesced (`COALESCE_TICKS`, constants.ts) unless urgent (`urgentFor`, `wantSnapshot` after a hit to or from its ship) |
| client/src/network/netCaps.ts | 33 | what the join offers (`netCaps()`: hits caps plus `?packed=0|1`, `?coalesce=0|1`), `coalesceDelayMs` (GameState.coalesceMs, from netCaps.hold) |
| server/src/net/hits/fakeHitsClient.testkit.ts | 220 | the fake client (ShipStore, ShipReplicaSet, ConfirmedHits, SelfHits) the hit tests and the netcode probe share; `*.testkit.ts` is left out of the server build |
| common/src/bodies/ (decisions, stagedFlight, registry, hash) | ~330 | decision inputs (protocol 36, `CAPS.BODIES` 256, docs/design/decision-inputs.md): the decision records and their folding into a body's state, the staged bosses' flight as a shared body, bodies by brain id, the body check's hash |
| server/src/net/decisions/BodyNet.ts | ~155 | decision inputs, the server side: each boss's decision log, which bosses each client runs (SYNC, the decisions since its last snapshot, OFF), its body checks; `bodies.test.ts` the parity test |
| client/src/ships/bodies/BodyRunner.ts | ~165 | decision inputs, the client side: decisions folded in at their ticks, the boss's replica driven by its body (ShipReplicaSet `setDriver`), the body check |
| common/src/bodies/ (decisions, stagedFlight, registry, hash) | ~330 | decision inputs (protocol 36, `CAPS.BODIES` 256, docs/design/decision-inputs.md): the decision records and their folding into a body's state, the staged bosses' flight as a shared body, bodies by brain id, the body check's hash |
| server/src/net/decisions/BodyNet.ts | ~155 | decision inputs, the server side: each boss's decision log, which bosses each client runs (SYNC, the decisions since its last snapshot, OFF), its body checks; `bodies.test.ts` the parity test |
| client/src/ships/bodies/BodyRunner.ts | ~165 | decision inputs, the client side: decisions folded in at their ticks, the boss's replica driven by its body (ShipReplicaSet `setDriver`), the body check |
| server/src/ships/bridge/debrisNet.ts | 206 | the server's debris bookkeeping: splits clients may derive (`noteSplit`, a ship's centre of mass by rebuild count `comAt`, what ships shed this tick `sheds`), spawn checks, the shared step (`step`, ShipBridge.stepDebrisWorld), `touched` (debris moved otherwise, and what knocked into it, till the snapshot: Replication keyframes them), `told` (pieces something else changed: no longer the clients' to run), `shifted`/`recentred`/`offLegacy` (a rebuild's recentring, worked out by clients; legacy ones get keyframes), and `intangible` (ShipBridge's) |
| common/src/ships/debrisLife.ts, client/src/ships/debris/DebrisLives.ts | 45 / 154 | a piece's life after its spawn (CAPS.DEBRIS): crumble ticks fixed at the spawn (`debrisDecay`), each crumble's rebuild (`crumbleRebuild`); the client side runs the pieces it was given (`l`): structures by tick, recentring, crumble effects, splits from the pre-recentre body |

## Public interface
- Types: `ClientMessage`, `ServerMessage`, `EntityState`, `EntityType`, `ServerSnapshotMessage`, `ClientInputMessage`.
- Encoding: `encodeMessage` (client -> server; input goes binary, the rest JSON), `decodeMessage`, `encodeServerMessage`, `serverFrame(parts)`, `decodeServerFrame`, `splitServerFrame`, `packSnapshot`/`unpackSnapshot`, `wireTables()`, `COMPACT_TYPES`, `DICTIONARY`.
- Version: `PROTOCOL_VERSION` (26 at time of writing), `PROTOCOL_WIRE_HASH`, `PROTOCOL_MISMATCH_CLOSE` (4002), `PROTOCOL_MISMATCH_REASON`. The client sends `protocol` in `join`; the server echoes its own in `welcome`; a mismatch closes the socket (4002) and the client asks for a reload.
- Replication: `ShipReplicaSet`, `packKeyframe/unpackKeyframe`, `packControlRow/unpackControlRow`, `CTL` (common/src/ships/replica.ts).
- Close codes: 4001 sign-in failed (no reconnect), 4002 version mismatch (no reconnect), 1013 too many connections.

### Own pilot row (`EntityType.Player`) `data[N]` (built in SnapshotBuilder.systemRows, net/SnapshotBuilder.ts)
0 packed cursor/weapon state (aim 13b, laser hit dist 8b, left/right beam on) | 1 whole charge % | 2 cursor distance | 3 jump drive counter | 4 shield % | 5 EMP ticks left | 6 jump scale x1000 | 7 field flags (1 star ring, 2 lodestone) | 8 pool % | 9 number of charge groups | 10 lodestone prime ticks | 11 warmth % | 12 cargo mass | 13.. each charge group's % (`CHARGE_GROUPS_AT`=13, max 24; indices 6-12 are `PILOT_ROW` in ships/energy.ts; `packCharge`/`unpackCharge`, `chargeGroupsEnd`) | then, after the groups, the part features' values in features.wire.json pilotExtra order (each server feature's `wire`; read back by ships/features/strafer/strafer.ts `pilotExtras`): dodge counter, last dodge way (1..32), tow target id+1, then the weaponry extras (marked, slowed ticks left) | then the gun-state correction (protocol 18; ships/guns.ts `packGunState`, `gunStateAt`): a count, then up to 8 (part index, value) pairs for clip guns (rounds, +128 while reloading) and charge guns (charge ticks); the client takes a value only after disagreeing with it for 30 ticks running (client/src/ships/gunSync.ts). Fields after the groups shift with the group count: never read them by a fixed index. (Protocol 18 took the beam heat and overheated fields out of the row.)
### Other pilots' status row (`row.other`) `data`
0 shield % (steps of 5) | 1 EMP'd | 2 mining beam hit (tenths) | 3 weapon beam on | 4 mining beam on | 5 cursor dist/100 | 6 tow target id+1, 7 statuses (marked 1, slowed 2) (features.wire.json status). Their motion is not here (replicated, below).
### Charge tells (protocol 18)
A charge gun (Longbarrel, Blackout) starting to charge, or let go early, goes out as a fire event with no shells (as a pulse laser's pulse does), its ammo code `TELL_CHARGE_START` (255) or `TELL_CHARGE_CANCEL` (254) in `partAmmo` (part + 256 × code); the shot itself is an ordinary fire event. ShipClient.preSnapshot keeps them in `chargeTells` for the charge FX.
### Other entities
Ship body (`ShipBody`): 0 kind (1 derelict, 2 traffic, 3 hostile) | 1 shield % | 2 EMP | 3 faction idx | 4 elite 1 / boss 2 | 5 core % (0: client works it out) | 6 weapon beam on | 7 hull % (0) | 8 rating | 9 calm | 10 side (1 ward, 2 person's craft). Mob (`Enemy`): `[index in data/mobs.json]`. Projectile (own `p` rows in the snapshot): `[weaponType, tier, hue, spawnTick, spawnX, spawnY, ownerId, sizeScale, turret, endTick, gun]` (`gun`, protocol 27: the gun that fired it, packed as a fire event's part, -1 none; on the wire after ownerId). Loot pod: `[best rarity idx, kinds, count, (drift anchor tick)]`.
### Ship motion (snapshot `k`, `c`, `f`, `o`)
Keyframe row: `[id, mode, x, y, vx, vy, angle, angVel, jump, jumpScale, ctlBits, q, cargo?, station?, ox?, oy?, dodge?, dodgeDir?]` (station -1 = undocked but has dodged). Control row `[id, tb, dq, ...]` or run row `[-1-id, tb, dq, dq...]` (ids sent as deltas). Fire `[owner, ticksAgo, part, aimQ, ...shellIds]`. `o`: ships that left view.
### CTL bits (`CTL`, common/src/ships/replica.ts)
forward 1, backward 2, left 4, right 8, boost 16, helm 32, strafeLeft 64, strafeRight 128, jump 256, emp 512, hold 1024, numb 2048, slowed 4096, dodge 8192, noBoost 16384 (the stores refused a boost this step). From bit 15, 6 bits: the engines' power as (steps of 1/32 - 32), signed (flight.ts `ctlOfPower`/`powerOfCtl`; full power: nothing). A pilot's flight step quantises its power to that grid (`quantizePower`) and its replicas fly it from the bits (`stepFlight` `replay`), so a ship short of power (a ports ship starving its engines) needs no keyframes (protocol 25). From bit 21, 6 bits (`CTL.share`): what the part features' bursts got (a Burst Strafer's dodge, a Gyro's turn: `PowerResult.extra`), as (32 - steps of 1/32), the lowest of the features that asked (all full or none asked: nothing); the pilot's step quantises those shares to the same grid and replicas apply it to every feature (`ctlOfShare`/`shareOfCtl`; protocol 31). Two features short by different shares at once leave the replica off, and the shadow sends a keyframe.
### Binary input (11 bytes)
[0] type, [1-2] seq, [3-4] targetTick low16, [5] flags (fwd 1, back 2, left 4, right 8, boost 0x10, fireL 0x20, fireR 0x40), [6-7] aim q13, [8-9] cursorDist/4, [10] flags2 (strafeL 1, strafeR 2, helm 4, jump 8, hasTargetTick 0x10, dodge 0x40; 0x20 and 0x80 free since protocol 16). Byte 5's 0x80 (protocol 36): a body check follows the own check (CAPS.BODIES). The old 17-byte V1 still decodes. Then, optionally (protocol 25): debris acks, a count byte and per piece its id (LEB128 varint) and 8-bit check (`ClientInputMessage.acks`); the client sends an input when it has acks even if nothing else changed (inputSend.ts, ShipClient.takeAcks).

### Compact inputs (protocol 35, `CAPS.INPUTS` 128)
First byte `0x80 |` the groups that changed since the last input on the socket (EXTRA riders and a seq that isn't the next, TICK step, KEYS, MODES, AIM as a fine/coarse step or the 13-bit aim, DIST on a log grid), then only those: a mouse-steer tick is 2 bytes. Read only through a per-socket `InputDecoder` (SocketTransport; it reads the base layout too, so the two mix); the client's `InputEncoder` (NetworkManager) is exact, falling back to the base layout. Send rules: client app/inputCompactSend.ts (aim past 16 grid units, a settle send when the mouse stops, every changed tick while firing, the distance only while firing or riding along). In both layouts nothing is sent while berthed or dead, and a station-screen click isn't fire; the server drops inputs while berthed and starts a respawned ship neutral. `?compact=0|1`. Measured: docs/audits/input-compaction-2026-11-04.md (`npm run net:inputs`).
### Boss fight messages (common/src/network/bossProtocol.ts)
`bossLife` {boss, bodyId, state, at}: a lair boss's life (common bosses/lifecycle.ts), drawn from tick `at` (rising, sinking: client ships/bossLife.ts), resent to pilots arriving. `bossWindow` {bodyId, at, ticks, cap, fill (of 32), crack?}: a weak-point window's meter, at most every 6 ticks, `ticks` 0 closes it. `DECISION.PERSONAL` [slot, attack, seed] rides the body channel (no change to the body's flight; a build from before it, DECISION_OPS 6, drops the row). An arena's barrier is in both sides' terrain (common world/gates.ts), so collisions and shots stop at it alike; passing it is a teleport (an own-ship keyframe) for now. Dev only: `bossDevTool` / `bossDev`.

### Decision inputs (protocol 36, `CAPS.BODIES` 256, docs/design/decision-inputs.md)
With `OWN_SIM` (a body reads its own ship there): a boss with a body (common bodies/registry.ts: the Scrap Mother, the Brood Mother) is flown on the client's tick layer by the same body the server's brain flies it with. A snapshot's `decisions` (`d`, index 11; packed: `decisionsIO`, 2-3 bytes a record) are `[id, dt, op, ...args]`, dt the decision's tick less the snapshot's: SYNC (the whole state, with a keyframe), OFF, TARGET, SIDE, STAGE, WANT. A client running a boss gets no control rows of it, and a keyframe only when the server's bodied shadow (Replication `Shadow.bodied`, its own versions counting down from -1) leaves the ship, or its target's replica was off on that client this window. Its check rides inputs: base layout the first flags byte's 0x80 (3 bytes after the own check), compact `CI_EXTRA.BODY_CHECK`; off, it is synced again. Hits on a boss it runs are told (`HitLedger` 'body'; the client leaves them to the records) until bodies have their hit rules.

### Confirmed hits (protocol 27, docs/design/confirmed-hits.md part C)
A client that announces `CAPS.HITS` in `join.caps` (on by default, dev and production: common `DEFAULT_CAPS`; `?hits=0|1` switches it and is remembered) gets it if the server takes it (`GameServerOptions.netCaps`: common `DEFAULT_CAPS` in dev and production alike, `NET_CAPS` overrides; `authResult.caps` says so). For such a client a shell's hit on a ship (a straight shell from a gun: `Projectile.gun`) goes as a record in one `hits` message per snapshot, `[ds, meta, target?, part, extras?]` per hit (hits.ts), instead of the hit's `projectileHit`, its share of `damage`, its `shipHps` entry, its shell in `removed`, and the `ignite` and end `detonation` it set off. The client works those out with the shared rules (common ships/hitRules.ts `deriveShellHit`, `gunShell`) and hands them to the usual handlers, so a hit looks as it always did. The server runs the same derivation first, on the HP it has sent that client (`ClientConnection.shipHpSent`), so it knows what the client will get wrong: the record carries `D` (the damage number), `S` (a shield took some: no HP) or `I` (the fire's part) only then, and the `shipHps` after the records corrects any HP. Frame order for such a client: syncs, snapshot, `hits`, `shipHps`, `hpCheck`. A hit it can't work out (target or shooter rebuilt or not synced, a shell it never had, a dry round whose end differs) goes the old way, to it alone. `hpCheck {id, sum}` (one ship a second) and `hpResync {ids}` (client to server) catch drift. A legacy client gets exactly the old messages at the old moments (Outbox `skipCaps`). The admin's `/hits [on|off] [name]` switches a pilot at the next snapshot, or shows the counters.
### Client-detected hits (protocol 28, docs/design/confirmed-hits.md part D)
`CAPS.SELF_HITS` (2), on top of `HITS`: the client finds its shells' hits itself (client ships/hits/SelfHits.ts) as each snapshot arrives, on a tick-faithful layer: straight gun shells from fire events (rebuilt bit for bit; a shell sent as a row is rounded, so it sits out and its hits are told: `HitLedger.rowShell`, `SelfHits.row`) moved `Position += Velocity` in doubles (the server's f64) from their spawn, the window searched once the frame's told records are in (a told shell struck that on its tick and nothing else: `SelfHits.open`/`detect(told)`, ShipClient.findHits), cast with common `shipSegmentHit` against each replicated ship's state at the collision step's tick (a pilot's at k, anything else's at k - 1), who-may-hurt-whom by `sidesHurt`. It leaves to the server's records its own ship, debris, ships synced since its last snapshot or keyframed in this one, shells the snapshot removed, curving or late-arming shells, orbs and pilot-against-pilot hits (HitLedger `unfindable`, the same rules). Each hit, found or told, adds `hitHash(shell, ship, struck part)` to a chain (a sum, so order and a tick either side don't matter); when a snapshot changes it, its low byte goes up on an input (`hitReport`: flags2 0x20, 3 bytes: the byte, the tick's low 14 bits and a 2-bit correction count; rides an input that goes anyway, or goes alone after 6 input ticks). The server sends records only for what the client can't find (or would get wrong: an extra), keeps every hit in the client's journal (SelfHitJournal) and judges once the client must have answered (its ping + 12 ticks; silence is no change); a disagreement twice running gets a `hitFix {s, t, c, e, h}` (the hits since the last agreement, the server's chain, the new count): the client works out what it missed, takes back what it had wrongly, adopts the chain and reports at once. `netCaps` (plain) tells the client the caps in effect from the snapshot just sent. A frame's hits are handed out at the frame's end (`ClientTransport.onFrameEnd`). On by default (common `DEFAULT_CAPS`, dev and production); client `?selfhits=0` turns it off. `CAPS.OWN_SHOTS` (16): the pilot's own straight volleys come as fire events, and it is sent its own ship's keyframes and control rows too (Replication.forClient `own`), so it builds them from its confirmed ship, not its prediction (server net/snapshot/ownShots.ts; a window its ship is keyframed in goes as rows, told); its prediction only draws (docs/design/confirmed-hits.md F3). `CAPS.ROUGH` (32, with SELF_HITS): adaptive validation (part E): the server checks the client's chain at a level that follows its record (server net/hits/ConfirmLevel.ts: ROUGH, a report a second, after 10 s clean; NORMAL, part D; STRICT after any correction: every hit told, 2 ticks more delay), told in `netCaps.lvl` at a snapshot's end; `?rough=0|1`. `CAPS.OWN_SIM` (64, with OWN_SHOTS; protocol 34): the client steps its own tick-aligned ship itself (client ships/own/OwnTick.ts) from its own inputs at their target ticks, plus the causes a snapshot's `own` rows give (`[ago, kind, ...]`: a pull's push, a contact (the push worked out with common ships/contact.ts), a rebuild), worked out alike on both sides (common network/ownTick.ts); no control rows or keyframes of its own ship unless its inputs don't say what it flew (the window's real controls) or something it can't work out moved it (Replication `stepOwn`/`ownFor`). It checks itself with `ownCheck` on its inputs (flags2 0x80, 3 bytes: state hash 8 bits, HP hash 4, tick 12; server net/own/OwnChecks.ts: off, a keyframe of its own ship or its HP again); `?ownsim=0|1`. docs/design/confirmed-hits.md part G.

### Bit-packed frames and coalescing (protocol 29, docs/design/packed-frames.md)
`CAPS.PACKED` (4) and `CAPS.COALESCE` (8), offered like the hit caps (dev builds; `?packed=0|1`, `?coalesce=0|1`) and
taken if the server allows them (`netCaps`: common `DEFAULT_CAPS`, dev and production alike; `NET_CAPS` overrides). A packed client's frames go through
its `PackedLink`: the same messages at the same moments, each base frame a sub-frame of a `PACKED_FRAME` message, bit
packed by a per-connection `PackedEncoder` (slots for entities and shells, steps and guesses from the last values,
"you" bits, implied removal of hit shells; lossless: it decodes to exactly the base format's messages; what it doesn't
pack goes as base bytes inside). With COALESCE, a sub-frame with nothing urgent waits up to `COALESCE_TICKS` (3) for
the next; the client widens its interpolation delay by `netCaps.hold`. A packed message that doesn't decode stops the
reader until the server starts afresh (`packedResync`).

### The focus grid (protocol 38, `CAPS.FOCUS` 1024, docs/design/awareness-model.md section 0)
Dev builds (`?focus=0|1`). Shared rules in common network/cells.ts: 8,192-unit cells from the system centre, a ship's
home cell (changes 256 past the border), the focus (every cell whose nearest point is within 19 km of the client's ship,
flat, no hysteresis) and the ring (within 35 km). Server net/cells/FocusCells.ts (built by SnapshotBuilder, `focus`):
once a round the home cells and each cell's ships (systems with a capable client only); a capable client's
`shipView` is its own ship plus the ships homed in its focus cells (`view`, in place of `updateShipView`'s 40/48 km
circle). **Ships away** (net/cells/AwayNet.ts, client ships/cells/ShipMemory.ts, shared rule common cells.ts
`AwayShips`): a ship leaving its view (its cell left the focus, or it left a focus cell: one path) goes in the
snapshot's `out` as before, but both ends remember it for `AWAY_TICKS` (5 min), at most `AWAY_CAP` (256) a client,
oldest let go first, by the same rule on both sides so letting go goes unsaid. The client keeps its structure (the
ShipStore doesn't prune it) and its status row (entity); the server keeps what it sent (`shipSynced`, `shipHpSent`,
`sentNames`) and its row key (`ClientConnection.away`). A `cells` message just before the snapshot says `b` (back in
view: put the row back) then `k` (leaving: keep it). Back, it gets its keyframe (movement, full precision: `repKnown`
forgot it on leaving), its row only if the key changed (stripped of its place), part HP as `shipHps` changes and a
rebuild as a light sync, never its blueprint unless the ship was replaced by a design the client hasn't seen. Nothing
is replayed: no client catching up. A ship destroyed or gone while away goes in the snapshot's `removed`. Debris
isn't kept. A `b` for a ship the client has nothing of (cleared when the server didn't) sends `shipNeed`, which also
resends its row and name. Ghosts: with the map shut a capable client still gets `mapDots`, for ships homed in its
ring or focus cells it doesn't hold, its party and its target (`FocusCells.ghost`); the client draws them as markers
(client ships/cells/GhostLayer.ts) and fades held ships from hull to marker over 18-19 km (`ShipRenderer.ghostOf`). A
new system, a new connection or switching the cap off starts it
afresh. Tests: server/src/net/cells/focusCells.test.ts; bench: `npm run bench:crowd -- --layouts cruise --caps 2047 --bulk focus`.

### Encode-once blocks (protocol 37, `CAPS.BLOCKS` 512, docs/design/awareness-model.md 7.6)
With PACKED (dev builds; `?blocks=0|1`). A snapshot's rows about other entities (status rows, shell rows, keyframes,
control rows, fire events) are bit-packed once a snapshot in `Outbox.blocks` (a `BlockStore`) and copied bit for bit into
every such client's frame (`PK.BLOCKS`), when the snapshot is queued (`PackedLink.add` -> `PackedEncoder.prepare`), so
blocks are made in snapshot order whenever each client's frame goes. Entities are named by **per-system wire ids** (dense,
lowest free first, freed on removal: `SnapshotBuilder` tells the store; given anew on a system change), told to a
client once in the snapshot that first uses one (intros). Status rows and keyframes step from **per-entity chains** (shell
rows from their gun's): the server's chain is what every holder has of it; each block has a delta form (for clients
holding the chain's generation it was coded from) and an absolute form, and after either a holder's chain is the same
function of the row (`settle*`), so a client that missed one is back in step after the next. Per client the encoder
keeps only the wids it told and the generation it holds of each chain (`BlockPeer`, cleared by any reset). The client's
own row, removals, out-of-view, own causes and decisions stay on the connection's codec; the frames decode to exactly the
messages PK.SNAPSHOT does. Blocks frames go undeflated (`ClientSocket.send(data, { raw: true })`). SnapshotBuilder hands
every client the same row objects (the stripped status row, named rows via `derivedRow`, one fire row per event): a row
object is a block. Measured: docs/audits/encode-once-2026-11-04.md.

### Other ships' causes (protocol 39, `CAPS.CAUSES` 2048, common network/causes.ts)
With OWN_SIM (dev builds; `?causes=0|1`). What moved a ship besides its controls (a contact, a rebuild's recentring, a
pilot's pull) is noted for every ship (bridge/ownCauses.ts, each with its place in the tick's order: a contact pair
shares one) and worked out on every shadow by the clients' own function (`applyOwnCauses`; net/causes/shadowCauses.ts:
`workCauses`, `settleContacts`, `causeRecords`). A shadow has two versions from one count: `version` (moves for causes
too: everyone else's keyframes) and `cver` (CAUSES clients': only when the shadow, causes and all, left the ship; a
bodied boss the same, counting down). A CAUSES client is sent a snapshot's `causes` records (`x`, index 12; packed
`causesIO`, ships named before in the section by their place there): `[ago, 0, id, dvx, dvy]` a pull, `[ago, 1, a, b,
flags, (a's state), (b's state)]` a contact once for both ships (`PAIR` flags: pins, states, OTHER_BEFORE either
side), `[ago, 2, id]` a rebuild. A side's other goes without its state when the client's replica of it, worked to that
pair (its own causes before it in the tick: ShipCauses.midOf, the own ship's OwnTick.midOf), is the pass's
(`inStep`/`bodyStep`, judged per client after the snapshot's keyframes are known). The client (client
ships/causes/ShipCauses.ts, through `ShipReplicaSet.setCauses`: pre-cause states, a rebuild's structure split) applies
each record to the ships it holds that aren't keyframed now; hits on a ship a record names are told that window
(SelfHits.onCaused, HitLedger's keyed set); fire events are built from `preAt`. What a client can't work out (a contact
with a ship whose structure it lacks, two rebuilds in a window, a rebuild between structures it doesn't have:
`rebuildOk`) is a keyframe. The own check's state byte adds a byte over every ship it holds (`replicasByte`, server
`Replication.heldByte`); off, every ship it holds is keyframed again. Split debris waits for the snapshot's causes
(the parent's pose as the server split it: ShipCauses.beforeRebuild; client ships/debris/DebrisSplits.ts, shared with
the fakes). Tests: server/src/net/causes/causes.test.ts. Measured: docs/audits/effects-2026-11-04.md.

### Scheduled waypoints (protocol 40, `CAPS.WAYPOINTS` 4096, common guidance/)
With OWN_SIM (dev builds; `?waypoints=0|1`). Homing shells (missiles, hive seekers, salvo and boss homing volleys: any
`def.homing` that isn't `guided`) and mobs fly by one shared law, on the server and on a WAYPOINTS client's tick layer
(common guidance/waypoints.ts): a waypoint is a point on the 4-unit grid and the tick the next takes over; the planner
makes the first from the target's state, checks for a swerve every 4 ticks (staggered by id; replaced past
max(64, 0.15 × the distance left)), and queues the next min(16, L/2) ticks before the current ends, spacing L 48..4
(mobs 32..4) by the ticks to the target; the steer turns toward it (a mob: points, thrusts, sideways drift 0.86).
State is on the 1/256 grid (a mob's heading 1/65536), so a SYNC carries it exactly. The server (Weapons.home, Mobs.tick)
reads the target as it is then: a pilot after its step, anything else as it ended the tick before; the client reads
`preAt` and `at(t - 1)` alike (GuideRunner.targetAt). net/guides/GuideNet.ts keeps one log of each one's records
(sources: Weapons, Mobs) and gives a WAYPOINTS client, in snapshot field `guides` (`w`, index 13; packed as the
decisions are) `[id, dt, op, ...]`: SYNC when one comes within the projectile range (12 km), then per window MODE when
it changes (derived: it held the target, or it's its own ship, at its last snapshot and now and the target isn't
keyframed in this one; else sent), WP/NEXT in sent windows, LOST and TARGET (a mob's brain's pick) always, OFF out of
range. It gets no projectile rows of a shell it runs after the first, and a mob's row only when its HP changes; a
snapshot always goes while it runs one. The client (client ships/guides/GuideRunner.ts, shared with the fakes) steps
each to the snapshot's tick (LOST/TARGET, the queue, then the planner or the sent records, the steer, the move) and
draws it from there (`draw`: the rows it would have had). Its own check's state byte adds a byte over the ones it runs
(`GuideRunner.byte`, server `GuideNet.heldSum`); off, all are SYNCed again (`GuideNet.resync`). A told hit ends one
too (`remove`). Not on it: guided shells (they follow the owner's cursor), AI ships (control rows, already exact).
Tests: common/src/guidance/waypoints.test.ts, server/src/net/guides/guides.test.ts (scene:
server/src/bench/guides/guideScene.testkit.ts). Measured: docs/audits/waypoints-2026-11-04.md.

### Mob volleys (`CAPS.LAUNCHES` 262144, with WAYPOINTS; protocol 48, no wire change)
A volley of mobs laid at once (a Rivet Sower's mines, `Mobs.launch`) is one guide row:
`LAUNCH [turn, accel, max, arm, x, y, line, n, ring, gap, ...ids]`. The fields are:
- the mobs' guide kind, as a SYNC carries it
- the pattern round a point on the guide grid: along a q13 line `gap` apart, or in a ring of radius `gap`
- the ids in spot order, as `packIds` runs

`common/src/guidance/launch.ts` has `launchSpots`, `launchArgs` and `launchOfArgs`. The server lays the mobs with the
same `launchSpots`.

`GuideNet.launchRows` offers each volley once to each client, by sequence. A volley laid between ticks is as of a tick
the client's last snapshot may already have covered. It is offered only while every one of its mobs is still there as
laid, in the client's system and in range; otherwise each mob gets a SYNC, as for any mob. The client's `GuideRunner`
makes each mob's run from the row.

### The enemy AI's pilots (`CAPS.PILOTS` 8192, with BODIES; protocol 40, no wire change)
Dev builds (`?pilots=0|1`). Enemies.ts's think is the commander (server only: state, target, waypoint, strafe side,
aim-error seed); the rest of its flight is common bodies/aiPilot.ts, run for every AI ship on the server
(server game/brains/aiPilot.ts `AiPilots`) and, from the same decisions, on a PILOTS client's tick layer (body kind 2,
`ai`, in common bodies/registry.ts). Orders go as body wants (PATROL/RETURN/ENGAGE/FLEE, whole numbers) with TARGET,
SIDE, SYNC and OFF through BodyNet, as the staged bosses' do; a running client gets no control rows of the ship. Aim
error is re-rolled every 12 + id % 7 ticks from the order's seed; a pack's side is its centroid as it ended the last
tick, summed in id order (the client reads its replicas at t - 1); the heading is held against the last tick's
quantised aim. Its body is off while its target is a pilotless ship (wards, siege prey: rows). Bosses without a brain
(Rustjaw, Hushwing, the giants...) fly on it too. A body whose read (target or pack mate) was keyframed late, or a
pack mate it stopped reading this window that's gone, is keyed too (BodyNet `readersOf`, `dropped`).
Tests: server/src/net/decisions/pilots.test.ts, common/src/bodies/bodies.test.ts. Measured: docs/audits/decisions-2026-11-04.md.

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
When a ship's rebuild point splits it (rebuildNow: what it shed whole this tick first, `DebrisNet.sheds` from `shed`, each group with its fling, crumble time and aloof flag; then the orphan groups), a client that holds the ship gets a `debrisSplit` `[id, tick, e (piece ids, packIds), p (the orphans' parts, packRuns), l, g, s, c, h]` before the ship's own sync, and works the pieces out itself (`deriveSplit`: shed groups as given (`g`, packSheds), then the parts' joins into groups, each piece's blueprint, HP as it has them, the parent's pose at the split's tick, push, spin, fling and crumble times seeded by ship, tick and piece, deterministic trig). Its pose is the server's when the split says it (`s`: a destroyed ship, its own ship, or `c`/`h`: one rebuilt since its last sync, with that structure's centre of mass and the pieces' HP), else its replica's at the tick once the snapshot's causes and decisions are in (before a rebuild there recentred it). It adds them to its store and replicas, makes their status rows (`DEBRIS_STATUS`) and acks each with `debrisHash`. The server holds the pieces back from that client meanwhile (`ClientConnection.debrisHeld`: no sync, keyframe, row or HP); a right ack marks them sent (`SnapshotBuilder.ackDebris`); a wrong one, or none within `DEBRIS_ACK_TICKS` plus twice the ping, and they go as any ship does (a wrong one in its grace is keyframed for that client only).

Debris then drifts and knocks into other debris only (ships ignore it), push only, all pieces of a system stepped together in id order (`stepDebrisWorld`) on the server and in `ShipReplicaSet` (`stepDebrisTo`, through the client's `DebrisWorld`: each piece's shape from the structure it flew that tick). A piece in its grace (`DEBRIS_GRACE_TICKS`, 90 ticks from its spawn tick, `debrisYoung`; a sent piece's sync says `born` and `aloof`) takes force only from its break-up: it neither knocks nor is knocked (shots still hit it). Every part's crumble tick is fixed at its spawn (common ships/debrisLife.ts `debrisDecay`, a parent's for its parts, a shed's own). `CAPS.DEBRIS` (131072, protocol 44): a split marked `l` is the client's to run (client ships/debris/DebrisLives.ts): it works out each crumble's rebuild at its tick (`crumbleRebuild`: structure by tick, what's left recentred in place, the crumble effect shown, what broke off from its pre-recentre body when the server's split names it), so nothing of the piece is sent but its removal (`ClientConnection.debrisLive`: no sync, HP, crumble `partDestroyed` or keyframe) until something else touches it (a shot, fire, a tow: `DebrisNet.told`, and a sync, after which it is told). A client keeping structures by tick (`CAPS.STRUCTS`) recentres a sent piece from its syncs (`DebrisSplits.after`, `rebuildAt`); Replication's `dver` is their keyframe version (not bumped by debris rebuilds); a legacy client gets a keyframe of a recentred piece and of what's near it or knocked it (`DebrisNet.offLegacy`). A piece moved by anything else (a tow), and whatever knocked into it or is within reach before the snapshot, is keyframed (`DebrisNet.touched`, Replication `Drift:moved`); so is a piece knocked by one a client doesn't step (out of view, or not had yet). Damage and removal stay server-told. Measured in docs/audits/debris-2026-11-05.md.

### Boss bytes round (protocol 49, 2026-11-05; docs/audits/boss-bytes-2026-11-05.md)
- **Own row with OWN_SIM**: the client's own row goes by its own keyframe version (`Replication.ownVersionOf`), so a
  contact or pull its tick layer worked out is no correction; with no row, its drawn prediction follows the tick layer
  at the snapshot's tick (`ShipClient.ownTickPose`, `GameState.followOwnTick`: pose put there, inputs since replayed).
- **Own contacts with a run boss** go without the boss's state when its bodied shadow is what the client has
  (`shadowCauses` `bodyPreStep`, `Replication.ownFor`).
- **Hits on its own ship** are found by an OWN_SIM client like any other (`SelfHits.ownExact`; `HitLedger` 'self' only
  without OWN_SIM).
- **`shipSync.dmg`**: a ship's shells' damage multiplier (a boss's `damage` and rage), on a new ship's sync when it
  isn't 1 and on any sync after it changed; client `ShipState.dmg`, `gunShell` scales the strength by it; the server
  derives with the one it sent (`shipSynced.dmg`), a stale one goes as the record's damage.
- **`DECISION.STATUS` [emp, slowed]** (op 7): an AI ship EMP'd or slowed, told to its body when what it had stops
  being what the ship has (`AiPilots.fly`); the body flies `CTL.emp`/`CTL.slowed` from it (`bodyStatusBits`). A SYNC
  clears it (BodyNet sends a STATUS after a SYNC while one is under way).

## Invariants
- Any change to the wire tables needs `PROTOCOL_VERSION` + `PROTOCOL_WIRE_HASH` updated (protocol.test.ts fails otherwise, on purpose). JSON-only messages not in `COMPACT` do not change the hash.
- The dictionary is append-only (indices are the wire format).
- `COMPACT` field order is the wire format; a message with an unlisted field falls back to a plain object (nothing lost). New rows are appended, so existing codes stay put.
- `COMPACT_HOOKS` (protocol.ts, next to `COMPACT`): a per-type `pack`/`unpack` pair that changes values on the way in and out, so handlers see the message they always did. `detonation` sends `kind` as an index into `FX_KINDS` (common/src/network/fxKinds.ts, append only, hashed into `wireTables()`; an unlisted kind goes as its string); `intercept` sends `down` as 0/1.
- Protocol 27: confirmed hits (`hits`, `hpCheck` in `COMPACT`; `join.caps`; `hpResync`; the projectile row's `gun`). A client's caps change only at a snapshot's end (`HitLedger.endSnapshot`), so no hit is told both ways.
- Protocol 29: bit-packed frames (`packedTables()` in `wireTables()`: any change to tables.ts is a wire change, bump).
  The codec's state is per connection on both sides and changes only with what goes through it: a reset (the
  pilot's ship changed, a table full, `packedResync`, a new link) starts both afresh. A packed message must decode to
  exactly what the base format decodes to (packedCodec.test.ts and the server's parity test check it).
- Protocol 28: client-detected hits (`hitFix` in `COMPACT`, the input's `hitReport` tail before any debris acks, `netCaps`). A rule for what the client finds itself must be the same on both sides (`HitLedger.unfindable` and `SelfHits.detect`), or the chains part and the server corrects.
- Protocol 26 moved `ignite`, `detonation`, `intercept`, `bossTelegraph`, `pong`, `bossBeam`, `bossCharge`, `bossBlow` into `COMPACT`. `asteroidSeed` sends `ids` and `indices` as `[start, count, ...]` runs (`packRanges`/`unpackRanges`, network/ranges.ts; unpacked in client/src/app/serverMessages.ts).
- The server never trusts a client message: validate shape, clamp, ignore junk. Before join only `join, ping, authLogin, authRegister` are accepted (`PRE_JOIN` in net/dispatch.ts).
- Inputs are queued (cap `MAX_INPUTS_PER_TICK`=16 a tick) and applied at the tick boundary.
- Row values are quantised the same on both sides (`quantizeShipValue`) so prediction replays match.
- Tick 60 Hz, snapshots 20 Hz (`SNAPSHOT_RATE`, common/src/constants.ts). `LAZY_TYPES` effects may wait `LAZY_TICKS` (2) to ride the next frame.
- common never imports client or server code.

## How to extend
1. **Add a client message**: interface in the right family file (core: protocol.ts), add it to that family's client union; register a handler in the right family registrar (net/handlers/modules.ts for a plain forward to a module; net/auth.ts; net/handlers/shipEdit.ts; net/handlers/flight.ts), or `t.on('type', ...)` in `GameServer.buildMessageHandlers()` for the few left there (see net/dispatch.ts), that delegates to a module (no logic in the handler); validate fields; if costly or broadcast, add a `MESSAGE_LIMITS` entry. The client sends with `network.send`. No bump (JSON, not in COMPACT).
2. **Add a server message**: interface + union entry; handle it in the `HANDLERS` table of client/src/app/serverMessages.ts (one entry per type; `serverMessages.test.ts` checks it against server/src/golden/serverMessages.json), or in `ShipClient.handleMessage` for ship messages, or a UI's `onMessage`. If it fires several times a second add it to `COMPACT` (bump). Eye-and-ear-only effects: add to `LAZY_TYPES` (net/snapshot/constants.ts).
3. **Add a pilot-row field**: append at the END of the right `data` array in `systemRows` (never insert; the group tail already shifts), read it client side (ship state / ShipClient), update the lists above and the comment in net/SnapshotBuilder.ts (`systemRows`), then bump (old clients mis-read it). The row key (`rowKey`/`internKey`) decides when a row is resent.
4. **Add a control bit / input flag**: next power of two in `CTL` + `controlBits`/`flightControls` (replica.ts); for input add a bit in `encodeInputBinary`/`decodeInputBinary` (flags2 is full: needs a longer input form). Bump.
5. **Add a part/material/piece id**: `npm run wire:sync` (appends ids from data/ships to wire-dictionary.json; `--skip` keeps them off the wire), then `npm run wire:bump "reason"`.
6. **Add a keyframe field**: append to the optional tail of `packKeyframe`, keep earlier indices, update `unpackKeyframe` and `cloneBody`. Bump.
7. **The bump**: `npm run wire:bump "what changed"` from game-v2/. It rebuilds common, recomputes the hash, and if it differs from the pin increments `PROTOCOL_VERSION`, writes the new `PROTOCOL_WIRE_HASH` and appends a line to PROTOCOL_CHANGELOG.md. It does nothing if the hash already matches, and needs a reason otherwise. The failing test prints the same instruction. (These files had just landed when this was written; if `scripts/wire/` is missing, edit the two constants in protocol.ts by hand and add a changelog line.)

## Tests
- `npx vitest run common/src/network` : codec round trips, snapshot frames, control rows, wire-hash pin (`computeWireHash` covers the tables, a sample frame and input, and since protocol 16 the `CTL` bits, a keyframe's optional tail and `CHARGE_GROUPS_AT`).
- `npx vitest run common/src/network/packed` : packed frames against the base format (every covered message, odd values, a long seeded run, resets, the reader).
- `npx vitest run server/src/net/snapshot` : packed frames on a real fight (every packed message decoded on the side and compared; a packed and a base-format observer see the same; switching off and on; coalescing).
- `npx vitest run server/src/net` : replication/keyframes (`replication.test.ts`), lodestones, ship view, socket limits (`socketTransport.test.ts`), confirmed hits parity (`hits/confirmedHits.test.ts`: a capable and a legacy client in the same fight end with the same HP, damage, fires and removals).
- `npx vitest run server/src/proto server/src/game/robustness.test.ts` : transport and hostile input.
- `npx vitest run common/src/guidance server/src/net/guides` : homing shells and mobs on the tick layer (CAPS.WAYPOINTS): derived, sent, the switch, a drift caught, legacy rows; a volley of mines as LAUNCH rows (CAPS.LAUNCHES).
- Bandwidth bench: `cd server && npm run bench:net` (server/src/bench/netBench.ts).
- `npx vitest run server/src/net/cells client/src/ships/cells common/src/network/cells.test.ts` : the focus grid and ships away (leaving and coming back after 2.5 s and 40 s with only what changed, HP changed and a ship destroyed while away, let go by age, the 19 km edge, cell borders, jumps, a new system; both ends' lists agree).
- `npx vitest run server/src/net/causes server/src/net/own server/src/net/decisions server/src/net/debris server/src/net/crowd` : causes, the own ship, bodies and AI pilots, debris lives, crowd fallbacks; every held ship exact at every snapshot.
- Crowd bench: `cd server && npm run bench:crowd -- --full --bulk focus --caps 245759` (every cap but CROWD), `--crowd` for the fallbacks. A caps matrix (each bit off in turn, `--case ball:50 --caps N`) is how the review checked each bit restores the old path; numbers in docs/audits/netcode-all-2026-11.md.

## Gotchas
- The lockstep caps depend on each other: OWN_SIM needs OWN_SHOTS; BODIES, CAUSES, WAYPOINTS and CARGO need OWN_SIM; PILOTS needs BODIES and CAUSES; STRUCTS needs CAUSES; LAUNCHES needs WAYPOINTS; BLOCKS needs PACKED. Use the `*For(caps)` helpers (`causesFor`, `pilotsFor`, `structsFor`...), never a bare bit test. The table is in docs/design/awareness-model.md section 12.
- The crowd bench's server allows every cap but CROWD unless `--crowd` (before the review it allowed only 16383, so STRUCTS, CARGO and DEBRIS were silently off in plain runs).
- Changing a wire table without a bump makes every cached client mis-decode silently. Do not repin the hash alone; use `wire:bump`.
- Pilot-row groups shift later fields; Strafer/Tow extras were appended after them for that reason.
- The binary codec must decode to what JSON would: no Maps, class instances, `undefined` holes or NaN in a message.
- A projectile's x/y is omitted when it is on the straight line from the muzzle; a new projectile kind that curves must send them (`onLine` in systemRows).
- A Node `Buffer` shares one ArrayBuffer: respect `byteOffset`/`byteLength` when decoding.
- Rate limits skip admins; `input` has its own cap.
- Tests that read a tick's effects must call `flushLazy()` (lazy effects wait).
- A test that looks at what a coalescing client holds must let its link drain first (`conn.packed.drain(tick)`): the last tick or two may still be waiting.
- `flushLazy()` sends the damage sums to every client, confirmed-hits clients included: a test with a capable client should let the snapshots go instead, or its numbers count twice.

## Related areas
server-core (message dispatch, send/flush, snapshots), flight (`FlightBody`, prediction, `replicaStep`), energy (`packCharge` in the pilot row), weapons (projectile rows, fire events), ui-hud-input (client handlers), web-accounts (lobby handshake, close codes), economy-quests (econProtocol bodies), ops-tools (netBench, monitor). Docs: docs/areas/<slug>.md.

## Notes (moved from DEVELOPMENT.md and the old engine-map)
- **Protocol changes (the rule)**: the wire format is pinned: `protocol.test.ts` hashes the wire tables (`COMPACT`, `SNAP_FIELDS`, the dictionary, the binary input layout) and fails until the pin is updated. Adding a model, material or piece to `data/ships` makes `wireDictionary.test.ts` fail until you run `npm run wire:sync` (appends the new ids to the append-only `common/src/network/wire-dictionary.json`; never reorder or edit it by hand). After any wire change run `npm run wire:bump "what changed"`: it rebuilds common, increments `PROTOCOL_VERSION`, writes `PROTOCOL_WIRE_HASH` and appends a line to `common/src/network/PROTOCOL_CHANGELOG.md`; it does nothing if the hash already matches, so a second run is harmless. Part ids you do not want on the wire go in the manifest's `"skip"` list (`wire:sync --skip`).
- **Design**: everything the simulation does with a ship is deterministic (the shared flight step, rounded each tick to `SHIP_PRECISION`), so clients are sent only what they cannot work out. Other ships: `replicaStep` (`common/src/ships/replica.ts`) is one tick of a ship as the server moves it when nothing interferes; `ShipBridge.replicaCtl` records the controls each body flew with (aim on the 13-bit cursor grid); `server/src/net/Replication.ts` keeps a shadow of every ship and compares after each tick: while they agree clients get only control changes (`snapshot.ctl`: `[id, ticksAgo, bits, q, ...]`); when they do not (collision, blast, EMP, out of boost, rebuild changing flight, docking) the next snapshot carries a keyframe (`snapshot.ships`). A keyframe version per ship; clients new to a ship or behind get one. Client: `ShipReplicaSet` (`common/src/network/replication.ts`) steps each ship from keyframe + controls, rewinding if a control arrives late; `ShipClient.placeReplica` places it. A keyframe that moves a ship off the path it was drawn on (a boss's drive or dash impulses, which aren't replicated, bring one most snapshots) is blended in for drawing only (`ShipReplicaSet.pose`, `fixWeight`): the old path is stepped on to the keyframe's tick, then the drawn path bends onto the keyframe by its tick (or, if it came late, eases out over 8 ticks after); 400 units or more snaps. `at` stays exact. `server/src/net/replication.test.ts` checks a client rebuilds every ship bit for bit. Shadows are not stepped in systems no client is in.
- **Prediction clock**: the client steps its ship once per tick number (`GameState.predictedTick`, `ticksDue`), ahead of the server's tick by the trip plus a jitter margin (`leadTicks`) so an input stamped tick + input delay arrives in time. The server tick is estimated by smoothing the offset between its tick and our clock (`getEstimatedServerTick`), not the tick itself (smoothing a value that climbs 60 a second trails it and made inputs late); it snaps when more than 20 ticks off. The ship is drawn between its last two steps, half a tick back. State hashes for ticks the server has not reached are held (`aheadHashes`).
- **Your own ship**: predicted from your inputs, resent only when the prediction would be wrong: an input that reached the server after its target tick, a new keyframe version, a status change (shield, EMP, marked, slowed), a state-hash mismatch (server keeps 3 s of per-tick hashes), or every 2 s. Boost regeneration is predicted too. A client that sends hashes then goes quiet for 3 s lets go of its controls.
- **Messages that repeat are sent once (protocol 26 work)**: `people` once at login (People.shown de-dupes the rest), `items` only when the message changed (`Session.itemsKey`, Pilots.sendItems), `party` only when the JSON changed (Party.sent, members' x and y in 1 km steps, hull in 5% steps; the leave messages clear the key), `ops` only when the view changed (Operations.shown holds the last JSON). All are full-state messages, so skipping an identical copy changes nothing on the client.
- **View range**: a client follows only ships within 40 km (lets go past 48 km), plus its party and target; the furthest flight zoom shows ~24 km. `SnapshotBuilder.updateShipView` (net/SnapshotBuilder.ts) keeps each client's `shipView`. Outside it: no keyframes, control/status rows, structure or HP; leaving goes in `snapshot.out` (blueprint kept); returning gets its keyframe and status row (plus a `shipSync` without the blueprint if rebuilt meanwhile). Combat effects (`damage`, `projectileHit`, `partDestroyed`, `contact`, and every `LAZY_TYPES` effect broadcast to a system that has a place: `detonation`, `ignite`, `stationFire`) go only to clients within 48 km (`broadcastNear`; damage always reaches whoever dealt it). `damage` is summed per target, source and glancing till the next snapshot and sent to a tenth. Removals go only to clients that were sent the entity (or made it: debris). A plain slug's hit (no splash, EMP, split, pierce, fire, chain, pull, hold or fuse: `Weapons.bursts`) sends no `detonation`: WeaponFx draws its impact from `projectileHit`. A shell striking a rock sends no `effect` (the client draws the rock's sparks where its drawn shell meets the drawn rock: ShipClient `struckFx` from `WeaponFx.onStruck`) and, to a client finding its own hits (`CAPS.SELF_HITS`), no `projectileHit` either: its drawn shell stops at the rock and the snapshot's `removed` ends it on the tick layer (SelfHits sits that window out; HitLedger tells any hit in it). A stuck mining charge blowing still sends both (GameServer `hurtAsteroid`; docs/audits/rock-bytes-2026-11-05.md).
- **Projectiles**: shots from a replicated ship go as fire events (`snapshot.fire`: owner, ticks ago, weapon part, aim in 1/4096 rad, shell ids); the client rebuilds the shells from the replicated pose and blueprint (`rebuildVolley` in `launch.ts`; the server spawns through the same `launchShot`, randomness seeded by tick and shell id) within 0.01 unit. Sent as a row once: its own shots (predicted), homing missiles (again when their course changes), shots from a ship it is only now getting a keyframe for, shells from out-of-view ships within 12 km. Pods go once as a drift anchor (`podDrift`) and again only when moved. Effects wait up to 2 ticks to ride with the next frame (`Outbox.lazy`, net/snapshot/Outbox.ts). Status rows leave out position; ship bodies' core/hull % are derived on the client from part HP (`ShipClient.fillHull`); rebuild syncs carry only part HP the client lacks (`hpd`); part HP changes go together in one `shipHps` per snapshot, to a tenth. `shipSync` sends the blueprint the first time a client sees a ship; designs go once per client, others by hash (`shipSync.design`; `shipNeed` to re-ask).
- **Wire format**: snapshots are rows of values (`packSnapshot`/`unpackSnapshot`); everything owed in a tick goes in one frame (`{type:'batch', m:[...]}`, except pongs); frames are binary (`binaryCodec.ts`: `SERVER_FRAME` + each message in a small tagged format: small ints in a byte, varints, decimals as integer mantissas, lengths in the tag; decodes to what JSON would; `encodeServerMessage` encodes once for every client, `serverFrame`, `decodeServerFrame`). Frequent messages go compact `[code, ...values]` (`COMPACT` in protocol.ts; an unknown field falls back to a plain object). Projectile rows `p` have no position while on the straight line from the muzzle; a shell that ends at a chosen point (a mortar, an aim burst) carries its end tick (`data[9]`, sent as ticks after the snapshot's, before x and y). Control rows are stepwise (`packControlRow`). Common strings go by number (`DICTIONARY`). permessage-deflate on top (`SocketTransport`: level 4, 8 KB window, frames under 96 bytes left alone); the ping panel's down figure is before compression. Inputs: 11-byte binary (2-4 bytes compact, CAPS.INPUTS), only on change, aim as 13 bits, target tick as its low 16 bits (`unwrapTick16`), applied in target-tick order; at most 16 inputs a tick, scheduled no more than 64 ticks ahead, 32 waiting. Removals go only to clients in that system or sent the entity.
- **Measure**: `npm run bench:net` in `server/` (4 pilots in a running fight; `--spread`, `--gap N`, `--sample`). A 4-pilot fight went from ~116 KB/s per pilot (JSON) to ~1.3 KB/s (~1 KB/s deflated).
- **Plain messages**: `intercept` is sent as a plain object, not in the wire tables. `join` carries `protocol`: a mismatch closes with 4002 and the client asks for a reload. Only `join`, `ping` and sign-in are accepted before joining.
