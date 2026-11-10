# Networking and protocol
How client and server talk: message types (objects over a WebSocket), the compact/binary wire encoding, the snapshot and ship-replication format, the version/hash handshake, and the transports (WebSocket, in-process). Gameplay never touches sockets; it builds `ServerMessage`s and the codec turns them into frames. Read this instead of protocol.ts (1,585 lines) when adding a message or a snapshot field.

## Files (what each owns)
| path | lines | owns |
|---|---|---|
| common/src/network/protocol.ts | 1585 | `PROTOCOL_VERSION`/`PROTOCOL_WIRE_HASH` (l.31-33), core `Client*`/`Server*` interfaces and the `ClientMessage` (l.187) / `ServerMessage` (l.703) unions, `EntityState`/`EntityType` (330-360), map-dot packing, binary input codec (`encodeInputBinary` l.1163, `decodeInputBinary` l.1189), `COMPACT` table (just above `COMPACT_TYPES`, l.1299), `SNAP_FIELDS`, `wireTables()`, `packSnapshot`/`unpackSnapshot`, `encodeServerMessage`/`serverFrame`/`decodeServerFrame` (1469-1585) |
| common/src/network/econProtocol.ts, socialProtocol.ts, contributorProtocol.ts, friendsProtocol.ts | 381 / 230 / 33 / 50 | message families (economy+profile+quests, party/trade/chat, contributor notes; friends, status and private messages, re-exported and unioned through socialProtocol.ts); re-exported from protocol.ts and unioned into `ClientMessage`/`ServerMessage`. JSON only, not in the wire tables |
| common/src/network/binaryCodec.ts | 287 | tagged binary value format, `DICTIONARY` (fixed head here + `ids` from wire-dictionary.json), `encodeBinary`, `BinaryReader/Writer` |
| common/src/network/wire-dictionary.json | | append-only manifest of ids (models/materials/pieces) sent by index; edited by `npm run wire:sync` |
| common/src/network/wireHash.ts | ~40 | `computeWireHash()` (FNV of `wireTables()` + a sample frame); used by protocol.test.ts and the bump script; not exported from index.ts |
| common/src/network/PROTOCOL_CHANGELOG.md | | one line per version, appended by `wire:bump` |
| common/src/network/replication.ts | 270 | ship keyframe/control-row packing (`packKeyframe`, `packControlRow`), client `ShipReplicaSet` (steps every replicated ship with the shared `replicaStep`) |
| common/src/network/cursorState.ts | 86 | 13-bit aim quantisation, `packCursorWeaponState` (= pilot row `data[0]`) |
| common/src/network/stateHash.ts | 38 | `computeStateHash` (client/server desync check) |
| common/src/network/Transport.ts | 47 | `ClientTransport`, `ClientSocket`, `ClientLink`, `DisconnectInfo` |
| server/src/net/SocketTransport.ts | 191 | HTTP (/health) + `ws` server; per-IP cap 16 sockets, 512 KB max message, 8 MB buffered cap, permessage-deflate, bad-frame log throttle |
| server/src/net/LocalTransport.ts | 62 | in-process transport for proto mode and tests (real encode/decode, synchronous) |
| server/src/net/Replication.ts | 183 | a server shadow per ship, stepped with the controls clients know; mismatch => keyframe version bump |
| server/src/net/MessageLimits.ts | 76 | `MESSAGE_LIMITS` token buckets per message type, `MessageLimiter` |
| client/src/network/NetworkManager.ts | 158 | browser WebSocket: reconnect back-off, `decodeServerFrame`, per-message error isolation, traffic counters |
| scripts/wire/sync.mjs, bump.mjs | | the two wire tools (below) |
| server/src/net/auth.ts | 199 | join (`registerAuthHandlers`); the guest-name rules |
| server/src/net/handlers/modules.ts, shipEdit.ts, flight.ts | 170 / 145 / 256 | the message families registered by `registerModuleHandlers` (forwards to one module), `registerShipEditHandlers` (dock, ship edit, pilot info) and `registerFlightHandlers` (input queueing, ping, stateHash and the self-hash record, interact, respawn, target, tow, mapView, trainingDrone) |
| server/src/net/dispatch.ts | 55 | the client message registry (`HandlerRegistry`, `dispatch`): pre-join gate, per-type rate limit, handler call. Handlers are registered in `GameServer.buildMessageHandlers()`, which calls the family registrars: `registerModuleHandlers` (net/handlers/modules.ts), `registerAuthHandlers` (net/auth.ts), `registerShipEditHandlers` (net/handlers/shipEdit.ts), `registerFlightHandlers` (net/handlers/flight.ts) |
| server/src/net/SnapshotBuilder.ts | 828 | the snapshot path (`SnapshotBuilder`, built once from a `SnapshotHost`): `sendSnapshots`, `systemRows` (the pilot row), `sendShipUpdates`, `rowKey`/`internKey`, `sendMapDots`, `updateShipView`, `enterSystem`, `sendPlayerState`, `sendSystemInfo`; `SnapRow`, `designHash` (`hpWire` is common hitRules.ts), the player/projectile/pod queries |
| server/src/net/snapshot/Outbox.ts, constants.ts | 177 / 27 | the sending side: `send`, `queue`, `flushOutbox`, `flushLazy` (the lazy effects), `broadcastToSystem` (an eye-and-ear effect, `LAZY_TYPES`, with a place goes `broadcastNear` instead: `fxPoint`), `broadcastNear`, `broadcastProjectileHit`, `addDamage`/`flushDamage` (damage summed per target, source and glancing till the next snapshot, to a tenth), the byte counters; the snapshot tuning (`LAZY_TYPES`/`LAZY_TICKS`, `SHIP_VIEW_OUT` (= `FX_RANGE`), `COALESCE_TICKS`, `DEBRIS_ACK_TICKS`, ranges). A joined client's messages all go through its `PackedLink`; base-format frames only before the join (sign-in answers). `flushDamage` hands the sums to `HitLedger.write` (`heldDamage`): nothing is broadcast. GameServer keeps one-line delegates (`send`, `flushOutbox`, `sendSnapshots`, ...) |
| common/src/ships/debris.ts, common/src/math/detTrig.ts | 352 / 389 | debris both sides work out alike: a split's pieces (`deriveSplit`, sheds `ShedSpec`/`packSheds`/`shedCrumble`, the grace `DEBRIS_GRACE_TICKS`/`debrisYoung`, `splitPose`, `splitRng`, `debrisSpin`, `debrisMotion`, `debrisHash`), the drift and push-only knocks (`stepDebrisWorld`, `stepDebrisBody`), the wire packing (`packIds`, `packRuns`); deterministic `dsin`/`dcos`/`dsincos`/`datan2`/`dhypot`/`dexp`/`dlog`/`dlog2`/`dpow` (only exact operations: the same bits in every engine), which flight and shells use too (docs/design/deterministic-maths.md; checked across engines by `npm run det:engines`) |
| common/src/network/cells.ts | 170 | the focus grid (protocol 38, `CAPS.FOCUS` 1024): cells, home cells, focus/ring, ghost weight, the ships-away list both ends keep (`AwayShips`, protocol 49) |
| common/src/network/hits.ts | 100 | confirmed hits on the wire: `CAPS` (the join's bit mask, every bit required: `DEFAULT_CAPS`, `fullCaps`), `ShellHitRecord`, `packHits`/`unpackHits`, `hpChecksum` |
| server/src/net/hits/HitLedger.ts | 475 | confirmed hits, the server side: `shellHit`/`hitFx`/`end` during the tick, then per client `plan` (in the snapshot loop; for a client finding its own, which hits it can find: `unfindable`), `write` (after its snapshot: its damage share, the records, the hits gone the old way; then `judge` its journal, a `hitFix` if need be), `check` (after its HP); `report` (a client's hit report); `endSnapshot` starts a newly joined client (`ClientConnection.started`: its own hit finding from there) and tells it (`netCaps`), and applies level changes. `confirmedHits.test.ts` beside it is the parity test |
| client/src/ships/hits/ConfirmedHits.ts | 370 | confirmed hits, the client side: `expand` (a record into the messages the server would have sent, HP into the ship store), `check` (hpCheck), `clientCaps()` (the `?hits=0|1` and `?selfhits=0|1` switches); for client-detected hits `own` / `told` / `oldWay` / `flushPending` (a frame's hits) and `corrected` (a hitFix) |
| client/src/ships/hits/SelfHits.ts | 300 | client-detected hits (protocol 28, design part D): the tick-faithful layer (shells moved in f32 as the server moves them, cast against replicas at the collision step's tick with common `shipSegmentHit`), the hit chain (`hitHash` sum), the report for the next input, and a correction's comparison |
| server/src/net/hits/SelfHitJournal.ts | 130 | client-detected hits, the server side per client: the chain by snapshot window, reports, judging (silence is no change; a disagreement twice running is corrected), the correction to send |
| common/src/network/packed/tables.ts, packedCodec.ts | 118 / 265 | bit-packed frames (protocol 29, docs/design/packed-frames.md): `PACKED_FRAME`, the message codes and field tables (hashed into `wireTables()`); `PackedEncoder` (server, one per client), `PackedDecoder`, `ServerFrameReader` (client: base frames and packed messages, a packed one as one or more sub-frames; `needsResync`) |
| common/src/network/packed/packedIO.ts, rowsIO.ts, snapshotSections.ts | 609 / 75 / 233 | the codec's bits and per-connection state (`PackedIO`), the entity and keyframe row bodies (shared by the sections and the blocks), a snapshot's per-connection sections |
| common/src/network/packed/blocks.ts, blocksSnapshot.ts, blockPeer.ts | 388 / 276 / 72 | encode-once blocks (protocol 37, `CAPS.BLOCKS` 512): `BlockStore` (server, one, Outbox.blocks: wire ids, per-entity chains, each row's block made once), the BLOCKS snapshot (`planBlocks`, `blocksWrite`, `blocksRead`), what one connection's ends keep (`BlockPeer`) |
| server/src/net/snapshot/PackedLink.ts | 129 | a packed client's frames (`ClientConnection.packed`, made and drained by Outbox): each base frame a sub-frame, coalesced (`COALESCE_TICKS`, constants.ts) unless urgent (`urgentFor`, `wantSnapshot` after a hit to or from its ship) |
| client/src/network/netCaps.ts | ~15 | `coalesceDelayMs(hold, lvl)` (GameState.coalesceMs, from netCaps.hold and the confirmation level). The join offers `DEFAULT_CAPS` (Game.ts); there are no per-cap switches |
| server/src/net/hits/fakeHitsClient.testkit.ts | 220 | the fake client (ShipStore, ShipReplicaSet, ConfirmedHits, SelfHits) the hit tests and the netcode probe share; `*.testkit.ts` is left out of the server build |
| common/src/bodies/ (decisions, stagedFlight, registry, hash) | ~330 | decision inputs (protocol 36, `CAPS.BODIES` 256, docs/design/decision-inputs.md): the decision records and their folding into a body's state, the staged bosses' flight as a shared body, bodies by brain id, the body check's hash |
| server/src/net/decisions/BodyNet.ts | ~155 | decision inputs, the server side: each boss's decision log, which bosses each client runs (SYNC, the decisions since its last snapshot, OFF), its body checks; `bodies.test.ts` the parity test |
| client/src/ships/bodies/BodyRunner.ts | ~165 | decision inputs, the client side: decisions folded in at their ticks, the boss's replica driven by its body (ShipReplicaSet `setDriver`), the body check |
| common/src/bodies/ (decisions, stagedFlight, registry, hash) | ~330 | decision inputs (protocol 36, `CAPS.BODIES` 256, docs/design/decision-inputs.md): the decision records and their folding into a body's state, the staged bosses' flight as a shared body, bodies by brain id, the body check's hash |
| server/src/net/decisions/BodyNet.ts | ~155 | decision inputs, the server side: each boss's decision log, which bosses each client runs (SYNC, the decisions since its last snapshot, OFF), its body checks; `bodies.test.ts` the parity test |
| client/src/ships/bodies/BodyRunner.ts | ~165 | decision inputs, the client side: decisions folded in at their ticks, the boss's replica driven by its body (ShipReplicaSet `setDriver`), the body check |
| server/src/ships/bridge/debrisNet.ts | 206 | the server's debris bookkeeping: splits clients may derive (`noteSplit`, a ship's centre of mass by rebuild count `comAt`, what ships shed this tick `sheds`), spawn checks, the shared step (`step`, ShipBridge.stepDebrisWorld), `touched` (debris moved otherwise, and what knocked into it, till the snapshot: Replication keyframes them), `told` (pieces something else changed: no longer the clients' to run), `shifted` (a crumble's recentring, worked out by clients), and `intangible` (ShipBridge's) |
| common/src/ships/contactPass.ts, client/src/ships/causes/ContactWorld.ts | ~70 / ~270 | contacts on the tick layer (CAPS.CONTACTS): the pass's candidate pairs and order (`contactCandidates`, by id), shared with the server's pass; the client's per-tick pairs among the ships it holds in step, merged into each ship's causes by their place in the pass |
| server/src/net/causes/contactLog.ts, contactsFor.ts | ~60 / ~110 | contacts on the tick layer, the server side: each tick's pass as a client needs it (`ContactLog`, noted by `resolveContacts`), and per client and window which contacts it finds itself and which ships it must leave out (`contactWindow`, Replication `found`) |
| common/src/ships/debrisLife.ts, client/src/ships/debris/DebrisLives.ts | 45 / 154 | a piece's life after its spawn (CAPS.DEBRIS): crumble ticks fixed at the spawn (`debrisDecay`), each crumble's rebuild (`crumbleRebuild`); the client side runs the pieces it was given (`l`): structures by tick, recentring, crumble effects, splits from the pre-recentre body |
| client/src/predict/ (ptst.ts, contacts.ts, shipKinds.ts, world.ts, modes.ts, Prediction.ts; ptKinds.ts, worldKinds.ts, aheadReads.ts, late.ts, kinds/ from track C) | ~430 / ~170 / ~80 / ~120 / ~130 / ~90 | the prediction of other ships (C3, the default in every build): the PT/ST layer (`PtStLayer`: PT ring, ST check by hash, one re-step per miss, the touch register, the ease, `PtTrack` plug-ins), the PT contact pass (`RealContacts`: the server's pass on predicted ticks; `CircleContacts` for fake tests), the ship kinds and the level of detail (`PT_KINDS`, `registerPtKind`, `PT_TUNING`), the adapter over the tick layer (`ReplicaPtWorld` over a `PtHost`: the game or the crowd probe), the mode registry (A/B/C1/C2/C3, `DEFAULT_MODE`) and the controller Game.ts makes (`Prediction`, installs the mode's `GameState.drawMode` hook and, in C2/C3, the world's PT kinds: `Prediction.kinds`) |
| common/src/sim/otherGuns.ts, server/src/net/guns/GunNet.ts, client/src/ships/guns/OtherGuns.ts, client/src/predict/kinds/shellsKind.ts | ~330 / ~330 / ~270 / ~170 | other ships' guns stepped from their inputs: the lane steps (`lanePilot`, `lanePilotless`, `lanePd`, `laneRemap`), the records a fire row carries (`laneRecords`, `firedRec`, `sameRecs`, `laneFireRow`), the shells' names (`otherShotWireOf`), `gunSync` (`packGunSync`: the lane state as one sparse list) and gun rows (`packGunRow`, the snapshot's `gun`); the server's lane per ship (diff against the real ship's records, state hash, versions, which clients step which ships: `forClient`); the client's lanes on the tick layer (ShipReplicaSet side steps) and the fire rows it builds at each snapshot (`confirm`), their shells' expiry; the PT timeline's `shells` kind |

## Public interface
- Types: `ClientMessage`, `ServerMessage`, `EntityState`, `EntityType`, `ServerSnapshotMessage`, `ClientInputMessage`.
- Encoding: `encodeMessage` (client -> server; input goes binary, the rest JSON), `decodeMessage`, `encodeServerMessage`, `serverFrame(parts)`, `decodeServerFrame`, `splitServerFrame`, `packSnapshot`/`unpackSnapshot`, `wireTables()`, `COMPACT_TYPES`, `DICTIONARY`.
- Version: `PROTOCOL_VERSION` (26 at time of writing), `PROTOCOL_WIRE_HASH`, `PROTOCOL_MISMATCH_CLOSE` (4002), `PROTOCOL_MISMATCH_REASON`. The client sends `protocol` in `join`; the server echoes its own in `welcome`; a mismatch closes the socket (4002) and the client asks for a reload.
- Replication: `ShipReplicaSet`, `packKeyframe/unpackKeyframe`, `packControlRow/unpackControlRow`, `CTL` (common/src/ships/replica.ts).
- Close codes: 4001 sign-in failed (no reconnect), 4002 version mismatch (no reconnect), 1013 too many connections.

### Own pilot row (`EntityType.Player`) `data[N]` (built in SnapshotBuilder.systemRows, net/SnapshotBuilder.ts)
0 packed cursor/weapon state (aim 13b, laser hit dist 8b, left/right beam on) | 1 whole charge % | 2 cursor distance | 3 jump drive counter | 4 shield % | 5 EMP ticks left | 6 jump scale x1000 | 7 field flags (1 star ring, 2 lodestone) | 8 pool % | 9 number of charge groups | 10 lodestone prime ticks | 11 warmth % | 12 cargo mass | 13.. each charge group's % (`CHARGE_GROUPS_AT`=13, max 24; indices 6-12 are `PILOT_ROW` in ships/energy.ts; `packCharge`/`unpackCharge`, `chargeGroupsEnd`) | then, after the groups, the part features' values in features.wire.json pilotExtra order (each server feature's `wire`; read back by ships/features/strafer/strafer.ts `pilotExtras`): dodge counter, last dodge way (1..32), tow target id+1, then the weaponry extras (marked, slowed ticks left) | then the gun-state correction (protocol 18; ships/guns.ts `packGunState`, `gunStateAt`): a count, then up to 8 (part index, value) pairs for clip guns (rounds, +128 while reloading) and charge guns (charge ticks); the client no longer reads it (Stage 3b: its gun state is stepped whole and put right by an `ownSync`); dropping it is a protocol bump. Fields after the groups shift with the group count: never read them by a fixed index. (Protocol 18 took the beam heat and overheated fields out of the row.)
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
[0] type, [1-2] seq, [3-4] targetTick low16, [5] flags (fwd 1, back 2, left 4, right 8, boost 0x10, fireL 0x20, fireR 0x40), [6-7] aim q13, [8-9] cursorDist/4, [10] flags2 (strafeL 1, strafeR 2, helm 4, jump 8, hasTargetTick 0x10, dodge 0x40; 0x20 and 0x80 free since protocol 16). Byte 5's 0x80 (protocol 36): a body check follows the own check (CAPS.BODIES). The old 17-byte V1 still decodes. Type 0x04 (protocol 64): the same 11 bytes, then the weapon groups selection byte at [11] (`weaponGroups`, sent only on the input it changes on), then the riders; compact inputs carry it as `CI_EXTRA.GROUPS` (docs/design/groups-mines-docking.md). Then, optionally (protocol 25): debris acks, a count byte and per piece its id (LEB128 varint) and 8-bit check (`ClientInputMessage.acks`); the client sends an input when it has acks even if nothing else changed (inputSend.ts, ShipClient.takeAcks).

### Compact inputs (protocol 35, `CAPS.INPUTS` 128)
First byte `0x80 |` the groups that changed since the last input on the socket (EXTRA riders and a seq that isn't the next, TICK step, KEYS, MODES, AIM as a fine/coarse step or the 13-bit aim, DIST on a log grid), then only those: a mouse-steer tick is 2 bytes. Read only through a per-socket `InputDecoder` (SocketTransport; it reads the base layout too, so the two mix); the client's `InputEncoder` (NetworkManager) is exact, falling back to the base layout. Send rules: client app/inputCompactSend.ts (aim past 16 grid units, a settle send when the mouse stops, every changed tick while firing, the distance only while firing or riding along). In both layouts nothing is sent while berthed or dead, and a station-screen click isn't fire; the server drops inputs while berthed and starts a respawned ship neutral. `?compact=0|1`. Measured: docs/audits/input-compaction-2026-11-04.md (`npm run net:inputs`).
### Boss fight messages (common/src/network/bossProtocol.ts)
`bossLife` {boss, bodyId, state, at}: a lair boss's life (common bosses/lifecycle.ts), drawn from tick `at` (rising, sinking: client ships/bossLife.ts), resent to pilots arriving. `bossWindow` {bodyId, at, ticks, cap, fill (of 32), crack?}: a weak-point window's meter, at most every 6 ticks, `ticks` 0 closes it. `DECISION.PERSONAL` [slot, attack, seed] rides the body channel (no change to the body's flight; a build from before it, DECISION_OPS 6, drops the row). An arena's barrier is in both sides' terrain (common world/gates.ts), so collisions and shots stop at it alike; passing it is a teleport (an own-ship keyframe) for now. Dev only: `bossDevTool` / `bossDev`.

### Decision inputs (protocol 36, `CAPS.BODIES` 256, docs/design/decision-inputs.md)
With `OWN_SIM` (a body reads its own ship there): a boss with a body (common bodies/registry.ts: the Scrap Mother, the Brood Mother) is flown on the client's tick layer by the same body the server's brain flies it with. A snapshot's `decisions` (`d`, index 11; packed: `decisionsIO`, 2-3 bytes a record) are `[id, dt, op, ...args]`, dt the decision's tick less the snapshot's: SYNC (the whole state, with a keyframe), OFF, TARGET, SIDE, STAGE, WANT. A client running a boss gets no control rows of it, and a keyframe only when the server's bodied shadow (Replication `Shadow.bodied`, its own versions counting down from -1) leaves the ship, or its target's replica was off on that client this window. Its check rides inputs: base layout the first flags byte's 0x80 (3 bytes after the own check), compact `CI_EXTRA.BODY_CHECK`; off, it is synced again. Hits on a boss it runs are told (`HitLedger` 'body'; the client leaves them to the records) until bodies have their hit rules.

### Bodies' moves (`CAPS.MOVES` 1048576, with BODIES; decision-inputs stage 4, no wire change)
The staged bosses' moves (the Scrap Mother's, the Pyreclast's) and the custom enemies' moves and guns live in common
bodies/moves/ (generators and steps over a `MoveHost`), run once on the server for real and on every client's tick
layer from decisions (client ships/bodies/MoveRunner.ts; common `StagedTrack`, `CustomTrack`), each tick of a snapshot's
window once, after the bodies were stepped again. New ops ride the same `d` rows, only to such a client (`MOVE_OPS`):
MOVE [move, seed, rage], HARASS [target + 1], CAP [k, mask] (the density cap read every pilot near), WINDOW [ticks,
cap], HOLD [mode] (a stagger or the dev tools hold its moves; a stage beaten stops them), PART [part, state] (a staged
boss's part gone or wrecked on the tick: part damage is the server's), GONE [bits] (a custom enemy's pieces); PERSONAL
carries [slot, attack, seed, target + 1, name]. A custom enemy's move already rides its order. Such a client is sent no
`bossTelegraph`, `bossBeam`, strike `detonation`, launch `effect`, window opening, or row (nor removal) of a move's
straight shell (seeded `m<owner>:<tick>:<n>`, so its spread is the same; drawn with an id of the client's own) for a
move decided after it began running the body (`BodyNet.derives`: a personal attack or a harassing shot only for its own
pilot). The server's GameServer.moveFx / moveShot do the leaving out. Their hits are told the old way (projectileHit
takes the nearest such shell with it). docs/audits/boss-moves-shared-2026-11-05.md.

### Confirmed hits (protocol 27, docs/design/confirmed-hits.md part C)
Every client (`CAPS.HITS` is part of the required set). A shell's hit on a ship (a straight shell from a gun: `Projectile.gun`) goes as a record in one `hits` message per snapshot, `[ds, meta, target?, part, extras?]` per hit (hits.ts), instead of the hit's `projectileHit`, its share of `damage`, its `shipHps` entry, its shell in `removed`, and the `ignite` and end `detonation` it set off. The client works those out with the shared rules (common ships/hitRules.ts `deriveShellHit`, `gunShell`) and hands them to the usual handlers, so a hit looks as it always did. The server runs the same derivation first, on the HP it has sent that client (`ClientConnection.shipHpSent`), so it knows what the client will get wrong: the record carries `D` (the damage number), `S` (a shield took some: no HP) or `I` (the fire's part) only then, and the `shipHps` after the records corrects any HP. Frame order for such a client: syncs, snapshot, `hits`, `shipHps`, `hpCheck`. A hit it can't work out (target or shooter rebuilt or not synced, a shell it never had, a dry round whose end differs) goes the old way, to it alone (its `projectileHit`, its damage share and effects: `HitLedger.write`). Damage from anything else (beams, blasts, contacts) goes the same way: each client's share of the snapshot's sums after its records. `hpCheck {id, sum}` (one ship a second) and `hpResync {ids}` (client to server) catch drift. The admin's `/hits` shows the counters (there is no switch).
### Client-detected hits (protocol 28, docs/design/confirmed-hits.md part D)
`CAPS.SELF_HITS` (2), on top of `HITS`: the client finds its shells' hits itself (client ships/hits/SelfHits.ts) as each snapshot arrives, on a tick-faithful layer: straight gun shells from fire events (rebuilt bit for bit; a shell sent as a row is rounded, so it sits out and its hits are told: `HitLedger.rowShell`, `SelfHits.row`) moved `Position += Velocity` in doubles (the server's f64) from their spawn, the window searched once the frame's told records are in (a told shell struck that on its tick and nothing else: `SelfHits.open`/`detect(told)`, ShipClient.findHits), cast with common `shipSegmentHit` against each replicated ship's state at the collision step's tick (a pilot's at k, anything else's at k - 1), who-may-hurt-whom by `sidesHurt`. It leaves to the server's records its own ship, debris, ships synced since its last snapshot or keyframed in this one, shells the snapshot removed, curving or late-arming shells, orbs and pilot-against-pilot hits (HitLedger `unfindable`, the same rules). Each hit, found or told, adds `hitHash(shell, ship, struck part)` to a chain (a sum, so order and a tick either side don't matter); when a snapshot changes it, its low byte goes up on an input (`hitReport`: flags2 0x20, 3 bytes: the byte, the tick's low 14 bits and a 2-bit correction count; rides an input that goes anyway, or goes alone after 6 input ticks). The server sends records only for what the client can't find (or would get wrong: an extra), keeps every hit in the client's journal (SelfHitJournal) and judges once the client must have answered (its ping + 12 ticks; silence is no change); a disagreement twice running gets a `hitFix {s, t, c, e, h}` (the hits since the last agreement, the server's chain, the new count): the client works out what it missed, takes back what it had wrongly, adopts the chain and reports at once. `netCaps {hold, lvl?}` (plain) goes once after a client's first snapshot (its finding starts there, both sides: `HitLedger.endSnapshot`, `ShipClient.onNetCaps`), and again when its level changes. A frame's hits are handed out at the frame's end (`ClientTransport.onFrameEnd`). `CAPS.OWN_SHOTS` (16): the pilot's own straight volleys come as fire events, and it is sent its own ship's keyframes and control rows too (Replication.forClient `own`), so it builds them from its confirmed ship, not its prediction (server net/snapshot/ownShots.ts; a window its ship is keyframed in goes as rows, told); its prediction only draws (docs/design/confirmed-hits.md F3). `CAPS.ROUGH` (32, with SELF_HITS): adaptive validation (part E): the server checks the client's chain at a level that follows its record (server net/hits/ConfirmLevel.ts: ROUGH, a report a second, after 10 s clean; NORMAL, part D; STRICT after any correction: every hit told, 2 ticks more delay), told in `netCaps.lvl` at a snapshot's end. `CAPS.OWN_SIM` (64, with OWN_SHOTS; protocol 34): the client steps its own tick-aligned ship itself (client ships/own/OwnTick.ts) from its own inputs at their target ticks, plus the causes a snapshot's `own` rows give (`[ago, kind, ...]`: a pull's push where it can't work the pull out itself (Pull fields, below: its step takes the told pulls), a contact (the push worked out with common ships/contact.ts), a rebuild), worked out alike on both sides (common network/ownTick.ts); no control rows or keyframes of its own ship unless its inputs don't say what it flew (the window's real controls) or something it can't work out moved it (Replication `stepOwn`/`ownFor`). It checks itself with `ownCheck` on its inputs (flags2 0x80, 3 bytes: state hash 8 bits, HP hash 4, tick 12; server net/own/OwnChecks.ts: off, a keyframe of its own ship or its HP again). Its own row goes only to correct it or with a status change: no periodic safety copy (the snapshot's head hash `hh` replaced it, sim/headHash.ts). Its own straight shells it builds from its own gun step and names by shot id (`CAPS.SHOT_IDS`: no own fire records, rows or end-of-life removals; server net/snapshot/ownShots.ts `OwnShotLog`). docs/design/confirmed-hits.md part G.

### Bit-packed frames and coalescing (protocol 29, docs/design/packed-frames.md)
`CAPS.PACKED` (4) and `CAPS.COALESCE` (8), every joined client (made at its join, Outbox.packedOf). A client's frames go through
its `PackedLink`: the same messages at the same moments, each base frame a sub-frame of a `PACKED_FRAME` message, bit
packed by a per-connection `PackedEncoder` (slots for entities and shells, steps and guesses from the last values,
"you" bits, implied removal of hit shells; lossless: it decodes to exactly the base format's messages; what it doesn't
pack goes as base bytes inside (`PackedEncoder.bitsByType` counts the bits by message type, `type(plain)` for those;
the crowd bench prints them: docs/audits/bitpack-2026-11-06.md); an encode that fails sends that flush as base frames, `PackedLink.emitBase`, which the client reads as ever). With COALESCE, a sub-frame with nothing urgent waits up to `COALESCE_TICKS` (3) for
the next; the client widens its interpolation delay by `netCaps.hold`. A packed message that doesn't decode stops the
reader until the server starts afresh (`packedResync`).

### The focus grid (protocol 38, `CAPS.FOCUS` 1024, docs/design/awareness-model.md section 0)
Dev builds (`?focus=0|1`). Shared rules in common network/cells.ts: 8,192-unit cells from the system centre, a ship's
home cell (changes 256 past the border), the focus (every cell whose nearest point is within 19 km of the client's ship,
flat, no hysteresis) and the ring (within 35 km). Server net/cells/FocusCells.ts (built by SnapshotBuilder, `focus`):
once a round the home cells and each cell's ships (systems with a client only); a client's
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
resends its row and name. (Hostile populations' ghosts, packs nobody's near, cost nothing here: `pops` alive bits, places worked out
by the client, world-sim guide.) Ghosts: with the map shut a client still gets `mapDots`, for ships homed in its
ring or focus cells it doesn't hold, its party and its target (`FocusCells.ghost`); the client draws them as markers
(client ships/cells/GhostLayer.ts) and fades held ships from hull to marker over 18-19 km (`ShipRenderer.ghostOf`). A
new system or a new connection starts it afresh. There is no view circle any more (the 40 km `updateShipView` went with the legacy path). Tests: server/src/net/cells/focusCells.test.ts; bench: `npm run bench:crowd -- --layouts cruise`.

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
pilot's pull: a pull field's goes only to a client that can't work it out, see Pull fields) is noted for every ship (bridge/ownCauses.ts, each with its place in the tick's order: a contact pair
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
quantised aim. It leads by its main gun's real round (2026-11-07, common bodies/aiLead.ts: the commander's
`aiLoadout` picks the gun with the most damage a second, its launch speed, and a homing or guided shell's acceleration
to its top speed; three whole numbers in an ENGAGE or HAUL order at places 8-10, mates from 11; an order without them
leads as if at 45 u/tick, at most 40 ticks either way). Its body is off while its target is a pilotless ship (wards, siege prey: rows). Bosses without a brain
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
When a ship's rebuild point splits it (rebuildNow: what it shed whole this tick first, `DebrisNet.sheds` from `shed`, each group with its fling, crumble time and aloof flag; then the orphan groups), a client that holds the ship gets a `debrisSplit` `[id, tick, e (piece ids, packIds), p (the orphans' parts, packRuns), l, g, s, c, h]` before the ship's own sync, and works the pieces out itself (`deriveSplit`: shed groups as given (`g`, packSheds), then the parts' joins into groups, each piece's blueprint, HP as it has them, the parent's pose at the split's tick, push, spin, fling and crumble times seeded by ship, tick and piece, deterministic trig). Its pose is the server's when the split says it (`s`: a destroyed ship, its own ship, or `c`/`h`: one rebuilt since its last sync, with that structure's centre of mass and the pieces' HP), else its replica's at the tick once the snapshot's causes and decisions are in (before a rebuild there recentred it). It adds them to its store and replicas, makes their status rows (`DEBRIS_STATUS`) and acks each with `debrisHash`. The server holds the pieces back from that client meanwhile (`ClientConnection.debrisHeld`: no sync, keyframe, row or HP); a right ack marks them sent (`SnapshotBuilder.ackDebris`); a wrong one, or none within `DEBRIS_ACK_TICKS` plus twice the ping, and they go as any ship does (a wrong one in its grace is keyframed for that client only). A round that tells a split always sends that client a snapshot (`holdDebris` says so), even with nothing else to send: the client works the split out once that snapshot's causes are in, so without one its acks went late. A split still waiting when its pieces come in full (their hold ran out: a sync, or the snapshot's keyframe) leaves those pieces as sent (`DebrisSplits.flush`).

Debris then drifts and knocks into other debris only (ships ignore it), push only, all pieces of a system stepped together in id order (`stepDebrisWorld`) on the server and in `ShipReplicaSet` (`stepDebrisTo`, through the client's `DebrisWorld`: each piece's shape from the structure it flew that tick). A piece in its grace (`DEBRIS_GRACE_TICKS`, 90 ticks from its spawn tick, `debrisYoung`; a sent piece's sync says `born` and `aloof`) takes force only from its break-up: it neither knocks nor is knocked (shots still hit it). Every part's crumble tick is fixed at its spawn (common ships/debrisLife.ts `debrisDecay`, a parent's for its parts, a shed's own). `CAPS.DEBRIS` (131072, protocol 44): a split marked `l` is the client's to run (client ships/debris/DebrisLives.ts): it works out each crumble's rebuild at its tick (`crumbleRebuild`: structure by tick, what's left recentred in place, the crumble effect shown, what broke off from its pre-recentre body when the server's split names it), so nothing of the piece is sent but its removal (`ClientConnection.debrisLive`: no sync, HP, crumble `partDestroyed` or keyframe) until something else touches it (a shot, fire, a tow: `DebrisNet.told`, and a sync, after which it is told). A client keeps structures by tick (`CAPS.STRUCTS`) and recentres a sent piece from its syncs (`DebrisSplits.after`, `rebuildAt`); Replication's `dver` is the debris keyframe version (not bumped by debris rebuilds). A piece moved by anything else (a tow), and whatever knocked into it or is within reach before the snapshot, is keyframed (`DebrisNet.touched`, Replication `Drift:moved`); so is a piece knocked by one a client doesn't step (out of view, or not had yet). Damage and removal stay server-told; a removed piece it runs knocks in its world up to the snapshot's tick before it goes (`ShipReplicaSet.remove(id, tick)`, `DebrisWorld.runs`: it knows its end), as a quiet window can be long. Measured in docs/audits/debris-2026-11-05.md.

### Boss bytes round (protocol 49, 2026-11-05; docs/audits/boss-bytes-2026-11-05.md)
- **Own row with OWN_SIM**: the client's own row goes by its own keyframe version (`Replication.ownVersionOf`), so a
  contact or pull its tick layer worked out is no correction. (Stage 3b: there is no separate prediction any more; the
  own ship is drawn from its tick layer, below.)
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

### Contacts on the tick layer (`CAPS.CONTACTS` 2097152, with CAUSES; protocol 53, no wire change)
Dev builds (`?contacts=0|1`; on by default). The server's contact pass takes its pairs by id (lower first) from one
shared sweep (common ships/contactPass.ts `contactCandidates`: bounding circles padded by `CONTACT_MARGIN`, from the
bodies before the pass). A CONTACTS client runs the same sweep on its tick layer (client ships/causes/ContactWorld.ts):
on each tick, over the ships it held before the snapshot's window and holds in step through it (no keyframe in it, not
gone or out of view, ships, not docked, not mid-jump, structure that tick known), from each one's step at that tick
(`ShipReplicaSet.preAt`, now a step worked out once, `stepPre`, with no causes). Each candidate becomes a row on both
ships (`CONTACT_FLAG.CHECK`: the pass's centre-distance test first) placed among their told causes by its place in the
pass (`CAUSE_PLACE`, `pairPlace`, `placeRows`: pulls before the pass, pairs by ids, rebuilds after), and is worked out
by `applyOwnCauses` as told ones are (ShipCauses `rowsAt`, OwnTick `rowsAt`/`midAt`). Such a pair goes as no record, no
own row and no `contact` sparks (the client draws its own: `contactFxDue`, the pass's threshold and cooldown); its ships'
hits are told that window as for a told cause (`SelfHits.onTouched`, Replication `out.caused`). A tick's pairs are worked
out once (memo) and again when any ship in them is stepped again from that tick (`ReplicaRewinds`: rewinds, keyframes,
late control rows, removal), every ship that took part stepped again; a window's ticks are final once its snapshot is in.
The server works out the same set per client and window (server net/causes/contactsFor.ts `contactWindow`, over the
pass log `ContactLog`, Replication `found`), and tells the client to leave out (a CONTACT record naming one ship twice,
`isLeftOut`) a ship it can't vouch for: out of the pass but not docked, pinned with a candidate among them, its structure
that tick not one the client has, or pulled after the pass began. A snapshot always goes when a pair was found in its
window. Sparks of pairs it doesn't find go with its snapshot (`Replication.contactFxFor`; everyone else gets them at
once). Tests: server/src/net/causes/causes.test.ts. Measured: docs/audits/contacts-tick-layer-2026-11-05.md. Left: contact
damage (HP isn't worked out on clients yet: group D), contacts with rocks (none are simulated).

### Pull fields (common sim/pullFields.ts, server ships/bridge/pullFields.ts)
Every pull on a pilot's ship is part of that ship's step, on every end. The decision to pull is a **field**, sent
once. The force is worked out each tick by the same function on both ends.

- **Declared a tick ahead.** A move says "I pull on the next tick" (`MoveWork.pull`, `CustomWork.pull`; a parked
  collapsing star in `Weapons.tick`). The server's `PullDeclarer` keeps a field open while the declaration stays the
  same. A field not declared again ends before the next pilot step (`settle`, in `playerMovementSystem`).
- **Five shapes.** CONE (the Scrap Mother's haul), LANE (her intake), POINT (a Scrap Crawler's magnet, on its target),
  REEL (a Hookboat's tether, on what it struck) and STAR (a fixed point, its owner skipped). The record is
  `[id, from, kind, t0, t1 (-1 open), target (-1 every pilot), skip, ...args]`. It goes in a plain `pulls` message just
  before the snapshot, when the field opens and again if it ends early (`r: 1`: a new system, forget the old). The
  connection keeps `pullsTold`.
- **The force: `fieldPull`.** It reads the puller as it ended tick t - 1 and the pilot after its motion on tick t
  (velocity too). The server's `stepMovement` passes `env.pulls` (`ServerPulls.source`, the puller's `Position` as the
  tick begins). A client's `ShipReplicaSet` passes its own source into every pilot step: `replicaStep` (now with the
  ship's id), the own ship's `OwnTick.step`, and `stepAlone` (the PT layer). That source reads the puller from the
  ring at t - 1.
- **Stepped again with the puller.** A puller stepped again from tick t makes the ships its fields pull be stepped
  again from t + 1. Its poses are kept as read, so a removed boss still pulled before it went. A window an earlier
  snapshot closed is final (`pullsFinal`).
- **One arithmetic.** Every pull on a pilot is `addPull` (the PULL grid, then the velocity back on its grid). It is
  applied after the motion and before every cause, in puller-id order. Shadows apply pull rows right after their
  replica step, before `pre`, so contacts and bodies read the pulled ship on both ends.
- **Told only where it can't be worked out.** Pulls still go as `PULL` rows in these cases, each tick whole
  (`untoldPulls`):
  - a pull that is the server's alone (a Grapple gem's moving shell; a pull on an AI ship is a push, keyframed as
    before);
  - a tick whose puller the client can't have as the server had it: not held before this snapshot, out of view, a
    shadow of it unlike the pose the pulls read (`notePullers`), causes it can't work out, or keyframed now. The
    client's step then takes the told rows in place of the fields' (`OwnTimeline.pulls`, `ReplicaCauses.pulls`);
  - a zero row where such a field could have pulled the ship and the server had no pull.

  Each tick is judged once (`pullsJudged`). Only pilots are pulled this way.

Tests: server/src/net/causes/pullFields.test.ts. It covers the haul and intake, the reel and magnet, pullers shoved on
the server alone, and a star. Both pilots and every body are exact at every snapshot. Measured:
docs/audits/sim-foundation-after-2026-11-06.md, "Pull fields".

### Mine Bay blasts (common network/minesProtocol.ts, ships/features/minebay/blasts.ts; JSON, no wire table change)

A drop is one record (`minesLaid`); blasts (stage M2, docs/design/groups-mines-docking.md 2.4) are found by each client
on its tick layer when the pilotless ship that set the mine off is exact there: client SelfHits calls its host's
`window(from, to, ships)` with the same targets its shell search uses, and the Mine Bay feature searches them
(`findMineBlasts`). The server keeps each tick's touches (server ships/features/minebay/Minefield.ts) and settles them
per pilot as its snapshot window closes: the SnapshotBuilder calls the part features' `onSnapshot(pilot, {from, to,
finds, exact})` just before the snapshot (`finds`: `HitLedger.searches` and a window of at most `SEARCH_WINDOW_MAX`;
`exact`: held and `HitLedger.poseExact` with the window's told ships). A blast the client finds goes unsaid; the rest go
as `minesGone` before the snapshot (a dead or departed pilot's at once); a blast it would find that never happened gets
`minesKept` (the mine is told only, for that client, from then on). A rule for what the client finds must be the same
on both sides (`poseExact` and SelfHits' targets), or blasts are missed or drawn wrongly: there is no chain for mines.

### Docking Clamps' links (common network/clampProtocol.ts, sim/clampPair.ts; no wire table change)

Two pilots' ships locked by Docking Clamps (docs/design/groups-mines-docking.md 3) are decision records, plain JSON:
`clampLink {tick, leader, follower, lc, fc, offset}` (a lock, a swap of who steers, a rebuild's fresh offset: the pair's
new record ends the old at its tick) and `clampBreak {tick, a, b, why, push?}` (`tick` the first tick each flies alone;
an undock's `push` on the leader, the follower's the reverse), to every pilot in the pair's system, and each open link
again to a pilot who comes there (Clamps.ts `tellLink`, every 30 ticks for newcomers only). `clampAsk {from, what, until}`
goes to the other pilot while a press waits. Up: `clampDock {with, clamp, theirs}`, `clampSwap`, `clampUndock`
(MessageLimits: 240 a minute each).

From the records every end steps the pair alike (the step's clamp source, `SimEnv.clamp` / `ReplicaEnv.clamp`): the
leader as the pair (the joined structure, its CTL power bits carrying the pair's engine share), the follower placed on
the leader as it ended the tick (`placeFollower`). No positions are sent for the follower and no input is delayed: the
client's ShipReplicaSet holds the links (`noteClampLink`, `noteClampBreak`, `clamps`), steps a follower's leader first
(`leaderFirst`: the steppers' scratch isn't re-entrant) and steps a follower again whenever its leader is
(`dropped`); the server's Replication shadow of a follower is the real ship while linked (`clampFollower`: never keyed
for it), the leader's shadows step the pair (`envOf`). A leader's own client flies the pair on its own engines' share:
when the follower's was lower the server sends it a keyframe of its own ship (`ClampTable.limited`). A contact on either
ship (the server's `foldClampContacts`) moves the leader off its shadows: a keyframe, the follower placed from it.
The linked pair is left out of the contact pass (`ContactEntry.link`, both ends).

Tests: common/src/sim/clampPair.test.ts (the joined flight on the three steppers), common/src/network/clampReplicas.test.ts
(the replica set), server/src/golden/clampParity.test.ts (600 ticks on a real server, the steering pilot, the other pilot
and a third client; no follower keyframes; the breaks).

## Invariants
- Any change to the wire tables needs `PROTOCOL_VERSION` + `PROTOCOL_WIRE_HASH` updated (protocol.test.ts fails otherwise, on purpose). JSON-only messages not in `COMPACT` do not change the hash.
- The dictionary is append-only (indices are the wire format).
- `COMPACT` field order is the wire format; a message with an unlisted field falls back to a plain object (nothing lost). New rows are appended, so existing codes stay put.
- `COMPACT_HOOKS` (protocol.ts, next to `COMPACT`): a per-type `pack`/`unpack` pair that changes values on the way in and out, so handlers see the message they always did. `detonation` sends `kind` as an index into `FX_KINDS` (common/src/network/fxKinds.ts, append only, hashed into `wireTables()`; an unlisted kind goes as its string); `intercept` sends `down` as 0/1.
- Protocol 27: confirmed hits (`hits`, `hpCheck` in `COMPACT`; `join.caps`; `hpResync`; the projectile row's `gun`). A client's own hit finding starts only at a snapshot's end (`HitLedger.endSnapshot`), so no hit is told both ways.
- Every client runs the full caps set (sim foundation stage 2): a join that states its protocol or caps without every bit of `DEFAULT_CAPS` is closed with the protocol mismatch (4002, net/auth.ts). A join that states neither (tests, benches, bots in-process) gets the full set. There are no caps-off branches on either side: don't add one; a new cap goes into `DEFAULT_CAPS` with a protocol bump. `netCaps` and `authResult` are plain objects outside the wire tables: changing them doesn't move the wire hash, so `wire:bump` won't bump the version for it.
- Protocol 29: bit-packed frames (`packedTables()` in `wireTables()`: any change to tables.ts is a wire change, bump).
  The codec's state is per connection on both sides and changes only with what goes through it: a reset (the
  pilot's ship changed, a table full, `packedResync`, a new link) starts both afresh. A packed message must decode to
  exactly what the base format decodes to (packedCodec.test.ts and the server's parity test check it).
- Protocol 61 (bit-pack audit, docs/audits/bitpack-2026-11-06.md): message codes are 5 bits (`PK_BITS`); the gun rows
  ride in the snapshot (`gun`, compact field `g`, packed field mask 15 bits, BLOCKS gun blocks); `gunSync` and `pulls`
  joined `COMPACT` (appended) and, with `mapDots`, `debrisSplit`, `bossBeam`, `bossTelegraph` and `bossBlow`, are
  packed field by field (`PACKED_FIELDS`; the `r` kind: a flat list in rows, each value stepped from its column's last);
  `shipSync` gained `maxHp` in `COMPACT` (a fresh sync went plain for it). A message still plain shows as `type(plain)`
  in the crowd bench's packed table.
- Protocol 28: client-detected hits (`hitFix` in `COMPACT`, the input's `hitReport` tail before any debris acks, `netCaps`). A rule for what the client finds itself must be the same on both sides (`HitLedger.unfindable` and `SelfHits.detect`), or the chains part and the server corrects.
- Protocol 26 moved `ignite`, `detonation`, `intercept`, `bossTelegraph`, `pong`, `bossBeam`, `bossCharge`, `bossBlow` into `COMPACT`. `asteroidSeed` sends `ids` and `indices` as `[start, count, ...]` runs (`packRanges`/`unpackRanges`, network/ranges.ts; unpacked in client/src/app/serverMessages.ts).
- The server never trusts a client message: validate shape, clamp, ignore junk. Before join only `join, ping` are accepted (`PRE_JOIN` in net/dispatch.ts).
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
- `npx vitest run server/src/net/snapshot` : packed frames on a real fight (every packed message decoded on the side and compared, the bytes against what the base format would have cost; what each client is shown is the server's fight; coalescing).
- `npx vitest run server/src/net` : replication/keyframes (`replication.test.ts`), lodestones, ship view, socket limits (`socketTransport.test.ts`), confirmed hits (`hits/confirmedHits.test.ts`, `selfHits.test.ts`: every client's HP, damage, fires, impacts, detonations and removals against the server's own record of the fight, `hits/serverTruth.testkit.ts`; the fight is server/src/testkits/hitsFight.testkit.ts). Test clients are full caps: `hits/fakeHitsClient.testkit.ts`; a cross-check compares with the server's ground truth, never with another client.
- `npx vitest run server/src/createLocalServer.test.ts server/src/game/robustness.test.ts` : transport and hostile input.
- `npx vitest run common/src/guidance server/src/net/guides` : homing shells and mobs on the tick layer (CAPS.WAYPOINTS): derived, sent, a drift caught; a volley of mines as LAUNCH rows (CAPS.LAUNCHES), counted against the server's own launches.
- Bandwidth benches: `cd server && npm run bench:crowd` or `bench:table` (server/src/bench/crowdBench.ts, netTable.ts).
- `npx vitest run server/src/net/cells client/src/ships/cells common/src/network/cells.test.ts` : the focus grid and ships away (leaving and coming back after 2.5 s and 40 s with only what changed, HP changed and a ship destroyed while away, let go by age, the 19 km edge, cell borders, jumps, a new system; both ends' lists agree).
- `npx vitest run server/src/net/causes server/src/net/own server/src/net/decisions server/src/net/debris server/src/net/crowd` : causes, the own ship, bodies and AI pilots, debris lives, crowd fallbacks; every held ship exact at every snapshot. causes.test.ts also runs a client finding its own contact pairs (CAPS.CONTACTS).
- `npx vitest run server/src/net/decisions/moves.test.ts` : bodies' moves on the client (CAPS.MOVES): every telegraph and beam a pilot was sent or worked out is one the server put out, every shell it made one the server spawned (Scrap Mother, Pyreclast, custom enemies).
- Crowd bench: `cd server && npm run bench:crowd -- --full` (every client full caps, as in production), `--crowd` for the fallbacks. Numbers before stage 2 (a caps matrix, each bit off in turn) are in docs/audits/netcode-all-2026-11.md; there are no caps to switch now.

## Gotchas
- Every cap is on for every client: the `*For(caps)` helpers, `conn.caps`, `GameServerOptions.netCaps`/`NET_CAPS` and the client's `?flag=0|1` switches are gone (stage 2). The dependency table in docs/design/awareness-model.md section 12 is history.
- Crowd fallbacks are a server option (`GameServerOptions.crowd`, on in index.ts; off in tests and benches unless asked: they're measured from wall-clock tick cost).
- Changing a wire table without a bump makes every cached client mis-decode silently. Do not repin the hash alone; use `wire:bump`.
- Pilot-row groups shift later fields; Strafer/Tow extras were appended after them for that reason.
- The binary codec must decode to what JSON would: no Maps, class instances, `undefined` holes or NaN in a message.
- A projectile's x/y is omitted when it is on the straight line from the muzzle; a new projectile kind that curves must send them (`onLine` in systemRows).
- A Node `Buffer` shares one ArrayBuffer: respect `byteOffset`/`byteLength` when decoding.
- Rate limits skip admins; `input` has its own cap.
- Tests that read a tick's effects must call `flushLazy()` (lazy effects wait).
- A test that looks at what a coalescing client holds must let its link drain first (`conn.packed.drain(tick)`): the last tick or two may still be waiting.
- `flushLazy()` sends waiting effects only; damage goes with the snapshots (each client's share after its hit records), so a test reading `damage` lets a snapshot go.

## Related areas
server-core (message dispatch, send/flush, snapshots), flight (`FlightBody`, prediction, `replicaStep`), energy (`packCharge` in the pilot row), weapons (projectile rows, fire events), ui-hud-input (client handlers), web-accounts (lobby handshake, close codes), economy-quests (econProtocol bodies), ops-tools (netBench, monitor). Docs: docs/areas/<slug>.md.

## Notes (moved from DEVELOPMENT.md and the old engine-map)
- **Protocol changes (the rule)**: the wire format is pinned: `protocol.test.ts` hashes the wire tables (`COMPACT`, `SNAP_FIELDS`, the dictionary, the binary input layout) and fails until the pin is updated. Adding a model, material or piece to `data/ships` makes `wireDictionary.test.ts` fail until you run `npm run wire:sync` (appends the new ids to the append-only `common/src/network/wire-dictionary.json`; never reorder or edit it by hand). After any wire change run `npm run wire:bump "what changed"`: it rebuilds common, increments `PROTOCOL_VERSION`, writes `PROTOCOL_WIRE_HASH` and appends a line to `common/src/network/PROTOCOL_CHANGELOG.md`; it does nothing if the hash already matches, so a second run is harmless. Part ids you do not want on the wire go in the manifest's `"skip"` list (`wire:sync --skip`).
- **Design**: everything the simulation does with a ship is deterministic (the shared flight step, rounded each tick to `SHIP_PRECISION`), so clients are sent only what they cannot work out. Other ships: `replicaStep` (`common/src/ships/replica.ts`) is one tick of a ship as the server moves it when nothing interferes; `ShipBridge.replicaCtl` records the controls each body flew with (aim on the 13-bit cursor grid); `server/src/net/Replication.ts` keeps a shadow of every ship and compares after each tick: while they agree clients get only control changes (`snapshot.ctl`: `[id, ticksAgo, bits, q, ...]`); when they do not (collision, blast, EMP, out of boost, rebuild changing flight, docking) the next snapshot carries a keyframe (`snapshot.ships`). A keyframe version per ship; clients new to a ship or behind get one. Client: `ShipReplicaSet` (`common/src/network/replication.ts`) steps each ship from keyframe + controls, rewinding if a control arrives late; `ShipClient.placeReplica` places it. A keyframe that moves a ship off the path it was drawn on (a boss's drive or dash impulses, which aren't replicated, bring one most snapshots) is blended in for drawing only (`ShipReplicaSet.pose`, `fixWeight`): the old path is stepped on to the keyframe's tick, then the drawn path bends onto the keyframe by its tick (or, if it came late, eases out over 8 ticks after); 400 units or more snaps. `at` stays exact. A rewind (a body's SYNC or its runner's per-snapshot restep, a late control row, a cause) never reaches back past the keyframe: the ticks before it are the path it was drawn on, kept for the blend. Wiped, they were drawn at the keyframe, and a body-run ship keyed again (its SYNC, its target keyed) jumped ahead to it and stood there for the interpolation delay (the Helios Drones' "snap into a fixed place", 2026-11-05). A ship drawn before its first state (just come into view) is drawn coming in along its velocity from that state, at most 20 ticks back, not standing at it. `server/src/net/replication.test.ts` checks a client rebuilds every ship bit for bit. Shadows are not stepped in systems no client is in.
- **Prediction clock**: the client steps its ship once per tick number (`GameState.predictedTick`, `ticksDue`), ahead of the server's tick by the trip plus a jitter margin (`leadTicks`) so an input stamped tick + input delay arrives in time. The server tick is estimated by smoothing the offset between its tick and our clock (`getEstimatedServerTick`), not the tick itself (smoothing a value that climbs 60 a second trails it and made inputs late); it snaps when more than 20 ticks off. The ship is drawn between its last two steps, half a tick back. State hashes for ticks the server has not reached are held (`aheadHashes`).
- **The held aim angle (common sim/aimHold.ts)**: a pilot's aim goes in its control rows only when it changes what
  the ship does. Its ship still flies its raw aim every tick, on the server and on its own client; beside it the step
  works out whether the aim it was last applied at (`SimInput.heldQ`: `ShipState.aimQ` on the server, the ring's
  previous q on its client) would have done exactly the same: the flight (ships/flight.ts `stepFlight`,
  `FlightResult.aimHeld`: the same spin out of steerSpin and the torque caps, the same jump counter, no burn starting
  along the aim; at the helm the aim steers nothing) and the guns (ships/guns.ts `stepGuns`, `GunOrders.heldAim`,
  `GunStep.aimHeld`: every aimed gun's offset and readiness alike on a tick the trigger is down, held or let go, a
  semi-automatic click waits or anything fires; idle, a turret's look is drawing only), and not mining (its beams are
  drawn along the cursor state, the replica's aim). Both the same, its applied aim (`ctl.q`, what the shadow, every
  replica and gun lane fly, and what the own-state hash hashes) stays the held one; else it's the raw one. So a ship
  flown on its applied aims goes exactly where it went on its raw ones, and a row gets a new aim only when that
  changes. The server works it out across stepMovement (the flight's half: `replicaCtl` keeps `q` applied, `rawQ`,
  `heldQ`) and fireWeapons (the guns' half); its client in `stepOwnShip` (heldQ from OwnTimeline.step); everyone else
  takes the applied aim as sent. Replication's own-exception check compares the client's inputs with the raw aim.
  Tests: common sim/aimHold.test.ts (raw, rule and a copy on the applied aims alike bit for bit), server
  net/own/ownSim.test.ts. Bench line: crowdBench "pilots' aims" (`ShipBridge.stats.aimHold`).
- **Your own ship, drawn from its tick layer (sim foundation Stage 3b)**: one step a tick, the whole one. OwnTick's
  step (client ships/own/OwnTick.ts, through ShipReplicaSet's `OwnTimeline.step`) runs common sim/ownStep.ts
  `stepOwnShip` (the one stepper, guns in the step: the server's stepMovement + fireWeapons on the same cores) on its
  full state: pose from the replica ring, stores, guns, hazards and priming (`OwnExtras`) kept by tick. GameState steps
  it to the prediction's tick each tick (`ownStep` = ShipClient.ownStepTo) and draws it at `ownDrawTick` from the ring
  (`ownPose`: ShipReplicaSet.pose; an own keyframe or a re-step eases out from where it was drawn). What its guns did on
  a tick is drawn once, as the prediction reaches it (OwnTick.takeEvents -> ShipClient.presentOwn: shells, pulses,
  beams, gun sounds, the HUD's gun state); its own shells on the tick layer are built from the events as a snapshot
  confirms them (OwnTick.takeConfirmed -> OwnShells). Past the newest snapshot it finds no contact pairs (the snapshot's
  window finds them once). Its aim goes on the grid the server flies (sim/ownStep.ts `pilotAimQ`); the server's
  control rows carry only what it can't work out (held keys, aim, hazard bits: not its engines' power, Replication
  `OWN_DERIVED_BITS`). The head hash and its own check's state byte hash that full state (sim/headHash.ts
  `ownStateHash`); off, the server sends its own keyframe and an `ownSync` (the extras, exact, just before the
  snapshot: SnapshotBuilder, net/own/OwnChecks.ts rekey), also with every own row that goes as a fix (first sight, a late
  input, a new keyframe version, a hazard change). A window its ship was keyframed or ownSynced in has its own shells'
  hits told (`conn.ownWindow`, OwnShells `keyed`). Every client holding its own ship gets a snapshot at least about once
  a second for the head hash, in the HUD numbers' round (`HEAD_HASH_TICKS`). Parity: server/src/golden/parity.test.ts
  (server vs the own step, the correction), common/src/sim/a-callers.test.ts, server/src/net/own/ownSim.test.ts.
- **Other ships: the PT/ST layer (prediction C3, the default since the C3 rollout)**: every ship the client holds on
  its tick layer is predicted to your own predicted tick and drawn where your shells meet it. Code: client/src/predict/.
  - *PT*: each ship stepped once a tick, to `GameState.predictedTick`, in the layer's own StateRing, by its kind
    (predict/shipKinds.ts `PT_KINDS`, first claim wins): `ai` (BodyRunner.ahead: AI pilots, custom enemies) read off the
    replica layer stepped ahead on its decisions, never pushed in PT; `pilot` (replica mode Player) and `rows`
    (dummies, haulers, anything on control rows) on held last input (common CtlChangeInputs 'assumed', stepped with
    `ShipReplicaSet.stepAlone` = replicaStep). Then the tick's contact pass over the PT states plus your own ship as a
    fixed body (it pushes, PT never moves it): predict/contacts.ts `RealContacts`, the server's resolveContacts
    (contactPairs through a ContactPairCache, pairs in the pass's order, contactPieces/contactPair, big bodies' near
    pieces, every pushed body rounded): with the same states before it, the same states after
    (server/src/net/causes/ptContacts.test.ts: perfect inputs, a grinding pack, 0 of 2880 ship-ticks off; 2708 off
    without the pass). Each tick's pairs are found once; a re-step finds the ticks it steps again (dropFrom).
  - *ST*: the replica layer at the confirmed tick (`GameState.serverTick`). Confirmed ticks keep their own pairs,
    found once a tick by ContactWorld (CAPS.CONTACTS); PT never feeds the tick layer. ContactWorld finds no pairs past
    the newest snapshot (a ship stepped there, an AI stepped ahead for PT, is stepped again from the window at the next
    snapshot's begin): before the C3 rollout every AI stepped ahead found pairs on unfinished ticks, stepping every
    held ship there (crowd ball 100: probe tick layer 9.9 -> 2.8 ms a tick, PT 3.4 -> 0.7 ms).
  - *Check*: each time the confirmed tick C moves, every ship's `shipHash(ST(C))` against the PT(C) it recorded. A
    match costs nothing. A miss re-steps that ship once from ST(C) to the PT head; the touch register (the PT steps'
    contact events in (C, head]) adds every ship it touched, and a ship the re-stepped path newly reaches joins at that
    tick. The drawn pose eases from the old PT to the new over 150 ms (`lerpMs`); a correction of 400 units or more
    (`PT_SNAP_DIST`: a respawn, a teleport, a blink) snaps.
  - *Coming and going*: the layer's ship list is re-read on every advance and confirm (`ReplicaPtWorld.ships`: held,
    flown, with structure, not your own, not a boss whose hits are told). A ship new to it (into view or a focus cell,
    a late joiner, back from away with its keyframe, a respawn under a new id) starts from its ST at the confirmed tick
    and is stepped alone to the head; one gone from the list (out of view, removed, docked, debris) drops its PT. A
    confirmed tick that falls far behind the layer's (a reconnect) starts the layer over.
  - *Level of detail*: ships further than `PT_TUNING.reach` (6 km) from your ship at the confirmed tick stay on the
    plain view (interpolated at the render tick, the replica layer's pose); one on PT leaves past 1.15 x that; at most
    `PT_TUNING.maxShips` (48) on PT, nearest first (one already on PT counts 1.15 x nearer); a ship going onto PT or off
    it eases between its interpolated and PT poses over 250 ms (modes.ts `PT_SWITCH_MS`). Cost: crowd bench `--pt-reach 1e9` lifts it (numbers in the C3
    rollout section of the sim-foundation plan; the probe reports "probe PT").
  - *Drawing*: the hook (`GameState.drawMode`, state/drawMode.ts) is the only thing in the hot paths: `frame` checks
    and advances the layer before ships are placed, `placed` puts a PT ship at its PT pose (plus the ease) at
    ownDraw - its kind's `drawBack` (a pilot 0.5 tick behind your shells, anyone else AHEAD_BACK: where the collision
    step meets it, sim/timeline.ts hitStateTick), and `shot` draws that ship's shells on the same tick (WeaponFx
    timeline), yours at your own draw tick. Bosses (told hits) are drawn by the replica layer at their PT tick (its own pose eases their rewrites; the bodies kind's ease isn't added on top), homing shells and mobs by the guides kind (`entity`); debris and ships out of reach keep the render tick.
  - *Plugging in* (the other tracks: pulls, other ships' shells, mobs and boss attacks, own-shot hit matching): the
    world's kinds are a `PtKinds` registry (predict/ptKinds.ts, order ships 0, bodies 10, guides 20, moves 30; the
    game's set in worldKinds.ts, the PT/ST layer joining as `ShipsKind`); a new kind of thing adds a `PtKind` there.
    Past the confirmed tick other ships are read through `AheadReads`, never the replica layer. A new kind of ship
    registers with `registerPtKind` (its claim, step, pushable, drawBack); anything else on the predicted
    timeline that must hear the ships layer's own re-steps adds a `PtTrack` (`PtStLayer.addTrack`: told `stepped(t, layer, group)` after each tick's ships and
    contacts, `restepped(c, ids)` after a re-step, `reset()`), and keeps its own state, hash and ease. Contacts stay
    the world's (`PtStWorld.contacts`).
  - *Modes*: C3 is `DEFAULT_MODE` (predict/modes.ts), installed by `Prediction` in Game.ts whenever prediction is on
    (not proto), in dev and production builds. A (interpolated), B (prediction off), C1 (AI ahead) and C2 (no touch
    register) are dev-only alternatives, switched live from F7 (docs/areas/ops-tools.md "Prediction modes").
  - *Not predicted (open)*: your own ship's contacts past the newest snapshot (OwnTick finds none there; it pushes PT
    ships as a fixed body), contact damage and the rebuild it brings (a hard ram is a correction), AI pushed by a
    contact (its PT is its decided path), pinned structures (no pinned flag on the client: pushed as anything else).
  - Tests: client/src/predict/ptst.test.ts (fake transport: no re-step when matching; one re-step per mispredict;
    C3's touched ship re-stepped at the same confirm, C2's a confirm later; the ease; snap; entering, leaving and
    coming back; tracks), modes.test.ts, server/src/net/causes/ptContacts.test.ts (the pass against the server's).
- **The PT timeline's kinds (C3, the default, and C2; track C)**: `client/src/predict/ptKinds.ts` is the contract for anything stepped ahead of the confirmed tick to the own predicted tick (`PtKind`: `advance(to)` steps and records by tick, `confirm(c)` holds what was recorded at c against ST and re-steps once on a miss, `pose`/`eased` the drawn place; `PtKinds` confirms every kind in `order`, then advances them all). Kinds (`client/src/predict/worldKinds.ts`, installed by Prediction.ts in C2/C3): ships (the PT/ST layer, predict/ptst.ts), bodies (bosses), guides (homing shells, mobs), moves (bodies' moves: looks and straight shells; MoveRunner `from`/`only` forks, `takeTimed`). Hooks they use: `GameState.drawMode` (`entity`, `ahead`), `ShipClient.ptMoves` / `show` / `forkMoves` / `bodyHost.ahead`, `GuideRunner.fork` / `stepFork`, `WeaponFx.predict` (returns an id) / `retract`. Past the confirmed tick other ships are read through `predict/aheadReads.ts`: reading the replica layer itself there (preAt of another pilot) steps it ahead, and something kept from those steps was read by ST later (a mob's ST went off the server's in ptWorld.test.ts; the likely cause, ContactWorld finding pairs for ticks past the snapshot, is gone since the C3 rollout: no pairs there, and ships stepped there are stepped again from the window at the next snapshot). Tests: server/src/net/decisions/ptWorld.test.ts.
- **Other ships' guns, stepped from their inputs (after the C3 rollout)**: another pilot's or an AI pilot's gunfire is
  worked out on each client from the controls it already holds, as its own is; the server sends no fire record of it.
  Code: common/src/sim/otherGuns.ts (the shared lane steps and wire forms), server/src/net/guns/GunNet.ts, client
  src/ships/guns/OtherGuns.ts, client src/predict/kinds/shellsKind.ts.
  - *Controls*: a pilot's held keys and aim are its control rows; its triggers and cursor distance (the input's 4-unit
    grid) are gun rows, the snapshot's `gun` field (protocol 61; `packGunRow`: [id, bits × 8 + ago, distance step, ...],
    a run form like the control rows'; until then a plain `gunCtl` message just before the snapshot). The client takes
    them before the rest of the snapshot (serverMessages `snapshot`, `OtherGuns.onGunCtl`). Each row is made once a
    round (GunNet) and goes as an encode-once block (`BlockStore.gunRow`, rowsIO `gunRowBody`, `PK_GUN`); a snapshot
    carrying any is urgent, as the gunCtl message was (PackedLink `urgentFor`: 'gunRows'). They go when they change,
    and only to clients stepping that ship.
    The distance goes exactly only where a lane needs it (GunNet `ctlTick`): on the tick a trigger changes, while
    one is held, and `SEMI_BUFFER` (5) ticks after a release (a semi-automatic click still fires). Held, "exactly" is
    as the guns stepped on it: a pilot's guns hold their distance (`ShipState.heldDist`, in the gun state, the lane's
    gunSync and the ownSync) and take the cursor's only on a gun's due ticks, its fire tick (before it steps, so the
    shot is exact) and halfway to its next (common ships/guns.ts `distDue`, a pure function of the gun state: the
    server's real ship, its lanes, other clients' lanes and the pilot's own prediction all hold the same one; several
    guns: the union of their ticks; a beam: every tick). So a held cursor goes about twice a fire interval, only when
    that changes it (crowd bench: exact updates 7.2 -> 4.3 a pilot a second at ball 20, 13.2 -> 6.8 at ball 50; gunCtl
    1332 -> 1055 B/s, 5903 -> 3993 B/s). The server's lane steps on the controls as sent, as its clients' do. With no trigger held
    a turret points straight at the aim and carries nothing (the turret rule, docs/areas/weapons.md), so there the
    distance goes roughly (`idleDue`): when the change since the last sent would turn some gun's line to the aim point
    (from a turret's pivot, a fixed gun's muzzle) by `IDLE_TURN` (0.5°) at `IDLE_MIN_GAP` (15 ticks, 250 ms) since,
    proportionally less the longer since (0.5° × 15 / ticks: a small change waits longer, a big one goes at 250 ms),
    and any change at all at `IDLE_MAX_GAP` (180 ticks, 3 s); unchanged, nothing. A pilot holding its cursor on a
    moving target now sends about 0.25-0.4 idle updates a second instead of 10-16 (crowd bench). Every lane steps on
    what was sent (held between); what that changes from the real ship, an idle turret's aim, is left out of the lane
    hash (as is the held distance while idle). For drawing, `OtherGuns.distAt` eases between two idle updates
    (ShipClient.placeReplica's cursor distance, in place of the status row's hundreds, for a ship whose lane it steps).
    The status row's hundreds (the fallback for a client not stepping that lane) move by the idle rule, firing or not
    (GunNet `GunLane.rough`, SnapshotBuilder `roughCursor`: idle, what the lanes were sent; held, the cursor's when the
    turn is due), not every time the cursor crosses a hundred (an unarmed pilot, with no lane: the cursor's).
    Measured in docs/audits/bitpack-2026-11-06.md.
    An AI pilot's trigger, lead and distance are its body's (common bodies/aiPilot.ts: the trigger rule `aiFires` moved
    there from Enemies.ts, its target's size read where each end has its structure, `lobs` in the ENGAGE order's
    hitBy field), so a client flying its body (CAPS.PILOTS) fires it too: nothing goes for them.
  - *The lane*: each such ship's gun state and stores (the own ship's `OwnExtras` form), stepped beside its replica
    every tick (ShipReplicaSet side steps): a pilot's stores through the accounted flight from its replica at t - 1
    (stepOwnShip, the guns left out), then its guns (stepShipGuns) at its replica after t's step, before t's causes;
    an AI pilot's battery as the server's pilotless step runs it (powerTick, no thrust), then its guns. A rebuild between
    two ticks moves the stores onto the new structure (`laneRemap`, as the server's rebuild does). What a lane fired on a
    tick becomes the records a fire row carries (`laneRecords`: straight volleys, pulses, charge tells, beam pieces,
    mining pulses), built into shells at the snapshot that confirms the tick (`OtherGuns.confirm`, onto `snapshot.fire`
    before ShipClient.preSnapshot builds it), each named by its shot id (`otherShotWireOf`: above every 31-bit id, under
    the packed codec's 2^48). They end on their own at their life's end; a removal the server still sends (a rock, a
    point-defence intercept) and its hit records name them so (HitLedger `shellName`: `SnapshotBuilder.otherShotLog`).
  - *The server's lane* (GunNet): the same step per ship, from the real ship's pose (what its clients' replicas hold
    while in step) and the replicated controls. Each tick, what it fired against what the real ship fired (its fire
    records, `firedRec`/`sameRecs`): a tick they differ on is told, its fire records sent as before (an ammunition round,
    a sheltered pilot, a bot aiming off the input grid); one where the lane fired and the real ship didn't gets a
    TELL_NONE record. A told tick replaces the client's own records of that ship and tick. At each snapshot round the
    lane's state hash (`laneHash`: stores and gun state, point defence's aim, every gun's aim while no trigger is held, and the towed entity left out) is held to
    the real ship's; off (a shield drawing on the stores), it's put back to the real ship's, a new version, at most once
    per `GUN_FIX_GAP` (60 ticks). A respawn starts a lane again; docked, a pilot has none.
  - *Which clients step which ships* (`GunNet.forClient`): a ship it holds, within `GUN_REACH` (8 km) of its own (kept to
    `GUN_KEEP`, 10 km), lately firing or its trigger held (`GUN_ACTIVE`, 600 ticks); an AI pilot only while it flies its
    body. Then it gets a `gunSync` (plain, before the snapshot: the lane state as one sparse list, `packGunSync`), again
    only for a new lane version (its hash drifted from the real ship's, a respawn); an empty one drops the lane (gone
    far). A keyframe of the ship doesn't resend its lane: an empty `keep` gunSync says where that round's told span
    starts (its volleys go as rows), and the lane steps on from the state it had at the keyframe's tick (OtherGuns
    `stash`; the pose its guns fired from in that window wasn't the server's, so a drift shows in the hash and is resynced). Until then, and for the span of the round a gunSync goes in (`w`: the ticks
    before it were decided in rounds that sent the client nothing, and it works them out from the lane it had: the
    client installs a gunSync at its snapshot, `carry`), its fire records go as before. The first volley after a quiet
    spell is told and its gunSync goes with it; cruising crowds get none.
  - *Point defence* fires at threats only the server sees (features/support/pointDefence.ts). Its aim isn't stepped by a
    lane and isn't hashed; each shot is a TELL_PD fire record to the clients stepping that ship, which put it into the
    lane (`lanePd`: its cooldown restarts, so the power its reload draws stays the server's) and step again from it.
    Its intercepts are drawn from the `intercept` message as before.
  - *Not derived (told as before)*: rows-flown AI (an AI fighting a ward, a pinned or boss-brained pilot: its lead isn't
    on the wire; quantising it would change how AI ships fire), bosses' guns (their brains decide), shells that aren't
    straight (homing, lobbed, arming, aim bursts: rows as before), ammunition rounds, a window a ship was keyframed in.
  - *On the PT timeline* (C3): the `shells` kind (predict/kinds/shellsKind.ts, order 40) draws each ship's volleys on the
    tick they're fired, at the ship's PT pose (WeaponFx.predict; the snapshot's built shell, the same shot, takes it over:
    WeaponFx.claim). An AI pilot's lane is the tick layer's own, stepped ahead with its body; another pilot's is stepped
    on PT from the tick layer's lane at the confirmed tick on its last known gun controls (held), checked by hash at
    each confirm. A tick whose records or firing pose change (a re-step, a trigger let go, a decision) has what it drew
    taken back and redrawn; at each confirm, what it drew of the ticks now final is held to the tick layer's lane.
  - Tests: server/src/net/guns/otherGuns.test.ts (another pilot through every firing model, an AI pack, point defence:
    each built shell the server's exactly, each lane's hash the server's lane's at the same tick, no told hit missed),
    otherGunsPt.test.ts (fake transport, LAT 4: other pilots' and AI shells drawn on their fire tick ahead of the
    snapshot, exactly the server's).
- **Your own ship (before Stage 3b)**: predicted from your inputs, resent only when the prediction would be wrong: an input that reached the server after its target tick, a new keyframe version, a status change (shield, EMP, marked, slowed), a state-hash mismatch (server keeps 3 s of per-tick hashes), (no periodic copy: the snapshot's head hash `hh`). Boost regeneration is predicted too. A client that sends hashes then goes quiet for 3 s lets go of its controls.
- **Messages that repeat are sent once (protocol 26 work)**: `people` once at login (People.shown de-dupes the rest), `items` only when the message changed (`Session.itemsKey`, Pilots.sendItems), `party` only when the JSON changed (Party.sent, members' x and y in 1 km steps, hull in 5% steps; the leave messages clear the key), `ops` only when the view changed (Operations.shown holds the last JSON). All are full-state messages, so skipping an identical copy changes nothing on the client.
- **View range**: a client holds the ships homed in its focus cells (the focus grid, net/cells/FocusCells.ts; the 40 km circle is gone); the furthest flight zoom shows ~24 km. `FocusCells.view` keeps each client's `shipView`. Outside it: no keyframes, control/status rows, structure or HP; leaving goes in `snapshot.out` (blueprint kept); returning gets its keyframe and status row (plus a `shipSync` without the blueprint if rebuilt meanwhile). Combat effects (`damage`, `projectileHit`, `partDestroyed`, `contact`, and every `LAZY_TYPES` effect broadcast to a system that has a place: `detonation`, `ignite`, `stationFire`) go only to clients within 48 km (`broadcastNear`; damage always reaches whoever dealt it). `damage` is summed per target, source and glancing till the next snapshot and sent to a tenth. Removals go only to clients that were sent the entity (or made it: debris). A plain slug's hit (no splash, EMP, split, pierce, fire, chain, pull, hold or fuse: `Weapons.bursts`) sends no `detonation`: WeaponFx draws its impact from `projectileHit`. A shell striking a rock sends no `effect` (the client draws the rock's sparks where its drawn shell meets the drawn rock: ShipClient `struckFx` from `WeaponFx.onStruck`) and no `projectileHit` either (every client finds its own hits): its drawn shell stops at the rock and the snapshot's `removed` ends it on the tick layer (SelfHits sits that window out; HitLedger tells any hit in it). A stuck mining charge blowing still sends both (GameServer `hurtAsteroid`; docs/audits/rock-bytes-2026-11-05.md).
- **Projectiles**: another pilot's or an AI pilot's straight shells aren't sent at all where its client steps that ship's guns (below: "Other ships' guns"); otherwise shots from a replicated ship go as fire events (`snapshot.fire`: owner, ticks ago, weapon part, aim in 1/4096 rad, shell ids); the client rebuilds the shells from the replicated pose and blueprint (`rebuildVolley` in `launch.ts`; the server spawns through the same `launchShot`, randomness seeded by tick and shell id) within 0.01 unit. Sent as a row once: its own shots (predicted), homing missiles (again when their course changes), shots from a ship it is only now getting a keyframe for, shells from out-of-view ships within 12 km. Pods go once as a drift anchor (`podDrift`) and again only when moved. Effects wait up to 2 ticks to ride with the next frame (`Outbox.lazy`, net/snapshot/Outbox.ts). Status rows leave out position; ship bodies' core/hull % are derived on the client from part HP (`ShipClient.fillHull`); rebuild syncs carry only part HP the client lacks (`hpd`); part HP changes go together in one `shipHps` per snapshot, to a tenth. `shipSync` sends the blueprint the first time a client sees a ship; designs go once per client, others by hash (`shipSync.design`; `shipNeed` to re-ask).
- **Wire format**: snapshots are rows of values (`packSnapshot`/`unpackSnapshot`); everything owed in a tick goes in one frame (`{type:'batch', m:[...]}`, except pongs); frames are binary (`binaryCodec.ts`: `SERVER_FRAME` + each message in a small tagged format: small ints in a byte, varints, decimals as integer mantissas, lengths in the tag; decodes to what JSON would; `encodeServerMessage` encodes once for every client, `serverFrame`, `decodeServerFrame`). Frequent messages go compact `[code, ...values]` (`COMPACT` in protocol.ts; an unknown field falls back to a plain object). Projectile rows `p` have no position while on the straight line from the muzzle; a shell that ends at a chosen point (a mortar, an aim burst) carries its end tick (`data[9]`, sent as ticks after the snapshot's, before x and y). Control rows are stepwise (`packControlRow`: a row's first aim as the step from the one the client has, each later one as the change in step from the one before; packed with each field by its own chunk, `PK_CONTROL` [tb 4, ticks ago 3, first step 2, change 1], no per-value tag, rowsIO `controlValuesIO`: crowd bench probes' snapshot.c ball 20 954 -> 727 B/s, ball 50 3769 -> 3078 with the held aim angle). Common strings go by number (`DICTIONARY`). permessage-deflate on top (`SocketTransport`: level 4, 8 KB window, frames under 96 bytes left alone); the ping panel's down figure is before compression. Inputs: 11-byte binary (2-4 bytes compact, CAPS.INPUTS), only on change, aim as 13 bits, target tick as its low 16 bits (`unwrapTick16`), applied in target-tick order; at most 16 inputs a tick, scheduled no more than 64 ticks ahead, 32 waiting. Removals go only to clients in that system or sent the entity.
- **Measure**: `npm run bench:net` in `server/` (4 pilots in a running fight; `--spread`, `--gap N`, `--sample`). A 4-pilot fight went from ~116 KB/s per pilot (JSON) to ~1.3 KB/s (~1 KB/s deflated).
- **Plain messages**: `intercept` is sent as a plain object, not in the wire tables. `join` carries `protocol` and `caps`: a mismatch, or caps short of the full set, closes with 4002 and the client asks for a reload. Only `join`, `ping` and sign-in are accepted before joining.
