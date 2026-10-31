# Networking and protocol
How client and server talk: message types (objects over a WebSocket), the compact/binary wire encoding, the snapshot and ship-replication format, the version/hash handshake, and the transports (WebSocket, in-process). Gameplay never touches sockets; it builds `ServerMessage`s and the codec turns them into frames. Read this instead of protocol.ts (1,593 lines) when adding a message or a snapshot field.

## Files (what each owns)
| path | lines | owns |
|---|---|---|
| common/src/network/protocol.ts | 1593 | `PROTOCOL_VERSION`/`PROTOCOL_WIRE_HASH` (l.34-37), core `Client*`/`Server*` interfaces and the `ClientMessage` (l.193) / `ServerMessage` (l.709) unions, `EntityState`/`EntityType` (336-366), map-dot packing (789-855), binary input codec (1169-1252), `COMPACT` table (~1307), `SNAP_FIELDS`, `wireTables()`, `packSnapshot`/`unpackSnapshot`, `encodeServerMessage`/`serverFrame`/`decodeServerFrame` (1474-1593) |
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
| server/src/GameServer.ts | | the sending side: `send/queue/flushOutbox` (~4827-4870), `systemRows` (~4987), `sendSnapshots` (~5146), `sendMapDots` (~5330); see server-core.md |

## Public interface
- Types: `ClientMessage`, `ServerMessage`, `EntityState`, `EntityType`, `ServerSnapshotMessage`, `ClientInputMessage`.
- Encoding: `encodeMessage` (client -> server; input goes binary, the rest JSON), `decodeMessage`, `encodeServerMessage`, `serverFrame(parts)`, `decodeServerFrame`, `splitServerFrame`, `packSnapshot`/`unpackSnapshot`, `wireTables()`, `COMPACT_TYPES`, `DICTIONARY`.
- Version: `PROTOCOL_VERSION` (16 at time of writing), `PROTOCOL_WIRE_HASH`, `PROTOCOL_MISMATCH_CLOSE` (4002), `PROTOCOL_MISMATCH_REASON`. The client sends `protocol` in `join`; the server echoes its own in `welcome`; a mismatch closes the socket (4002) and the client asks for a reload.
- Replication: `ShipReplicaSet`, `packKeyframe/unpackKeyframe`, `packControlRow/unpackControlRow`, `CTL` (common/src/ships/replica.ts).
- Close codes: 4001 sign-in failed (no reconnect), 4002 version mismatch (no reconnect), 1013 too many connections.

### Own pilot row (`EntityType.Player`) `data[N]` (built in GameServer.systemRows, ~l.5005-5035)
0 packed cursor/weapon state (aim 13b, laser hit dist 8b, left/right beam on) | 1 whole charge % | 2 cursor distance | 3 jump drive counter | 4 shield % | 5 EMP ticks left | 6 beam heat % | 7 overheated 0/1 | 8 jump scale x1000 | 9 field flags (1 star ring, 2 lodestone) | 10 core store % | 11 number of store groups | 12 lodestone prime ticks | 13 warmth % | 14 cargo mass | 15.. each store group's charge % (`CHARGE_GROUPS_AT`=15, max 24; `packCharge`/`unpackCharge` in ships/energy.ts) | then, after the groups (ships/strafer.ts `pilotExtras`): dodge counter, last dodge's way (1..32), tow target id+1 (`towing.wireOf`). Fields after the groups shift with the group count: never read them by a fixed index.
### Other pilots' status row (`row.other`) `data`
0 shield % (steps of 5) | 1 EMP'd | 2 heat (tenths) | 3 overheated | 4 mining beam hit (tenths) | 5 weapon beam on | 6 mining beam on | 7 cursor dist/100 | 8 tow target id+1. Their motion is not here (replicated, below).
### Other entities
Ship body (`ShipBody`): 0 kind (1 derelict, 2 traffic, 3 hostile) | 1 shield % | 2 EMP | 3 faction idx | 4 elite 1 / boss 2 | 5 core % (0: client works it out) | 6 weapon beam on | 7 hull % (0) | 8 rating | 9 calm | 10 side (1 ward, 2 person's craft). Mob (`Enemy`): `[index in data/mobs.json]`. Projectile (own `p` rows in the snapshot): `[weaponType, tier, hue, spawnTick, spawnX, spawnY, ownerId, sizeScale, turret]`. Loot pod: `[best rarity idx, kinds, count, (drift anchor tick)]`.
### Ship motion (snapshot `k`, `c`, `f`, `o`)
Keyframe row: `[id, mode, x, y, vx, vy, angle, angVel, jump, jumpScale, ctlBits, q, cargo?, station?, ox?, oy?, dodge?, dodgeDir?]` (station -1 = undocked but has dodged). Control row `[id, tb, dq, ...]` or run row `[-1-id, tb, dq, dq...]` (ids sent as deltas). Fire `[owner, ticksAgo, part, aimQ, ...shellIds]`. `o`: ships that left view.
### CTL bits (`CTL`, common/src/ships/replica.ts)
forward 1, backward 2, left 4, right 8, boost 16, helm 32, strafeLeft 64, strafeRight 128, jump 256, emp 512, hold 1024, numb 2048, dodge 8192 (4096 and 16384 free since protocol 16).
### Binary input (11 bytes)
[0] type, [1-2] seq, [3-4] targetTick low16, [5] flags (fwd 1, back 2, left 4, right 8, boost 0x10, fireL 0x20, fireR 0x40), [6-7] aim q13, [8-9] cursorDist/4, [10] flags2 (strafeL 1, strafeR 2, helm 4, jump 8, hasTargetTick 0x10, dodge 0x40; 0x20 and 0x80 free since protocol 16). The old 17-byte V1 still decodes.

## Invariants
- Any change to the wire tables needs `PROTOCOL_VERSION` + `PROTOCOL_WIRE_HASH` updated (protocol.test.ts fails otherwise, on purpose). JSON-only messages not in `COMPACT` do not change the hash.
- The dictionary is append-only (indices are the wire format).
- `COMPACT` field order is the wire format; a message with an unlisted field falls back to a plain object (nothing lost).
- The server never trusts a client message: validate shape, clamp, ignore junk. Before join only `join, ping, authLogin, authRegister` are accepted (`PRE_JOIN`, GameServer.ts ~l.416).
- Inputs are queued (cap `MAX_INPUTS_PER_TICK`=16 a tick) and applied at the tick boundary.
- Row values are quantised the same on both sides (`quantizeShipValue`) so prediction replays match.
- Tick 60 Hz, snapshots 20 Hz (`SNAPSHOT_RATE`, common/src/constants.ts). `LAZY_TYPES` effects may wait `LAZY_TICKS` (2) to ride the next frame.
- common never imports client or server code.

## How to extend
1. **Add a client message**: interface in the right family file (core: protocol.ts), add it to that family's client union; add a `case` in `GameServer.handleMessage` (~l.2909-3225) that delegates to a module (no logic in the switch); validate fields; if costly or broadcast, add a `MESSAGE_LIMITS` entry. The client sends with `network.send`. No bump (JSON, not in COMPACT).
2. **Add a server message**: interface + union entry; handle it in client `Game.handleServerMessage` (client/src/Game.ts ~l.1722, one big switch) or a UI's `onMessage`. If it fires several times a second add it to `COMPACT` (bump). Eye-and-ear-only effects: add to `LAZY_TYPES` (GameServer.ts ~l.561).
3. **Add a pilot-row field**: append at the END of the right `data` array in `systemRows` (never insert; the group tail already shifts), read it client side (ship state / ShipClient), update the lists above and the comment in GameServer, then bump (old clients mis-read it). The row key (`rowKey`/`internKey`) decides when a row is resent.
4. **Add a control bit / input flag**: next power of two in `CTL` + `controlBits`/`flightControls` (replica.ts); for input add a bit in `encodeInputBinary`/`decodeInputBinary` (flags2 is full: needs a longer input form). Bump.
5. **Add a part/material/piece id**: `npm run wire:sync` (appends ids from data/ships to wire-dictionary.json; `--skip` keeps them off the wire), then `npm run wire:bump "reason"`.
6. **Add a keyframe field**: append to the optional tail of `packKeyframe`, keep earlier indices, update `unpackKeyframe` and `cloneBody`. Bump.
7. **The bump**: `npm run wire:bump "what changed"` from game-v2/. It rebuilds common, recomputes the hash, and if it differs from the pin increments `PROTOCOL_VERSION`, writes the new `PROTOCOL_WIRE_HASH` and appends a line to PROTOCOL_CHANGELOG.md. It does nothing if the hash already matches, and needs a reason otherwise. The failing test prints the same instruction. (These files had just landed when this was written; if `scripts/wire/` is missing, edit the two constants in protocol.ts by hand and add a changelog line.)

## Tests
- `npx vitest run common/src/network` : codec round trips, snapshot frames, control rows, wire-hash pin (`computeWireHash` covers the tables, a sample frame and input, and since protocol 16 the `CTL` bits, a keyframe's optional tail and `CHARGE_GROUPS_AT`).
- `npx vitest run server/src/net` : replication/keyframes (`replication.test.ts`), lodestones, ship view, socket limits (`socketTransport.test.ts`).
- `npx vitest run server/src/proto server/src/game/robustness.test.ts` : transport and hostile input.
- Bandwidth bench: `cd server && npm run bench:net` (server/src/bench/netBench.ts).

## Gotchas
- Changing a wire table without a bump makes every cached client mis-decode silently. Do not repin the hash alone; use `wire:bump`.
- Pilot-row groups shift later fields; Strafer/Tow extras were appended after them for that reason.
- The binary codec must decode to what JSON would: no Maps, class instances, `undefined` holes or NaN in a message.
- A projectile's x/y is omitted when it is on the straight line from the muzzle; a new projectile kind that curves must send them (`onLine` in systemRows).
- A Node `Buffer` shares one ArrayBuffer: respect `byteOffset`/`byteLength` when decoding.
- Rate limits skip admins; `input` has its own cap.
- Tests that read a tick's effects must call `flushLazy()` (lazy effects wait).

## Related areas
server-core (handleMessage, send/flush, snapshots), flight (`FlightBody`, prediction, `replicaStep`), energy (`packCharge` in the pilot row), weapons (projectile rows, fire events), ui-hud-input (client handlers), web-accounts (lobby handshake, close codes), economy-quests (econProtocol bodies), ops-tools (netBench, monitor). Docs: docs/areas/<slug>.md.

## Notes (moved from DEVELOPMENT.md and the old engine-map)
- **Protocol changes (the rule)**: the wire format is pinned: `protocol.test.ts` hashes the wire tables (`COMPACT`, `SNAP_FIELDS`, the dictionary, the binary input layout) and fails until the pin is updated. Adding a model, material or piece to `data/ships` makes `wireDictionary.test.ts` fail until you run `npm run wire:sync` (appends the new ids to the append-only `common/src/network/wire-dictionary.json`; never reorder or edit it by hand). After any wire change run `npm run wire:bump "what changed"`: it rebuilds common, increments `PROTOCOL_VERSION`, writes `PROTOCOL_WIRE_HASH` and appends a line to `common/src/network/PROTOCOL_CHANGELOG.md`; it does nothing if the hash already matches, so a second run is harmless. Part ids you do not want on the wire go in the manifest's `"skip"` list (`wire:sync --skip`).
- **Design**: everything the simulation does with a ship is deterministic (the shared flight step, rounded each tick to `SHIP_PRECISION`), so clients are sent only what they cannot work out. Other ships: `replicaStep` (`common/src/ships/replica.ts`) is one tick of a ship as the server moves it when nothing interferes; `ShipBridge.replicaCtl` records the controls each body flew with (aim on the 13-bit cursor grid); `server/src/net/Replication.ts` keeps a shadow of every ship and compares after each tick: while they agree clients get only control changes (`snapshot.ctl`: `[id, ticksAgo, bits, q, ...]`); when they do not (collision, blast, EMP, out of boost, rebuild changing flight, docking) the next snapshot carries a keyframe (`snapshot.ships`). A keyframe version per ship; clients new to a ship or behind get one. Client: `ShipReplicaSet` (`common/src/network/replication.ts`) steps each ship from keyframe + controls, rewinding if a control arrives late; `ShipClient.placeReplica` places it. `server/src/net/replication.test.ts` checks a client rebuilds every ship bit for bit. Shadows are not stepped in systems no client is in.
- **Prediction clock**: the client steps its ship once per tick number (`GameState.predictedTick`, `ticksDue`), ahead of the server's tick by the trip plus a jitter margin (`leadTicks`) so an input stamped tick + input delay arrives in time. The server tick is estimated by smoothing the offset between its tick and our clock (`getEstimatedServerTick`), not the tick itself (smoothing a value that climbs 60 a second trails it and made inputs late); it snaps when more than 20 ticks off. The ship is drawn between its last two steps, half a tick back. State hashes for ticks the server has not reached are held (`aheadHashes`).
- **Your own ship**: predicted from your inputs, resent only when the prediction would be wrong: an input that reached the server after its target tick, a new keyframe version, a status change (shield, EMP, beam heat), a state-hash mismatch (server keeps 3 s of per-tick hashes), or every 2 s. Boost regeneration is predicted too. A client that sends hashes then goes quiet for 3 s lets go of its controls.
- **View range**: a client follows only ships within 40 km (lets go past 48 km), plus its party and target; the furthest flight zoom shows ~24 km. `GameServer.updateShipView` keeps each client's `shipView`. Outside it: no keyframes, control/status rows, structure or HP; leaving goes in `snapshot.out` (blueprint kept); returning gets its keyframe and status row (plus a `shipSync` without the blueprint if rebuilt meanwhile). Combat effects (`damage`, `projectileHit`, `partDestroyed`, `contact`) go only to clients within 48 km (`broadcastNear`; damage always reaches whoever dealt it).
- **Projectiles**: shots from a replicated ship go as fire events (`snapshot.fire`: owner, ticks ago, weapon part, aim in 1/4096 rad, shell ids); the client rebuilds the shells from the replicated pose and blueprint (`rebuildVolley` in `launch.ts`; the server spawns through the same `launchShot`, randomness seeded by tick and shell id) within 0.01 unit. Sent as a row once: its own shots (predicted), homing missiles (again when their course changes), shots from a ship it is only now getting a keyframe for, shells from out-of-view ships within 12 km. Pods go once as a drift anchor (`podDrift`) and again only when moved. Effects wait up to 2 ticks to ride with the next frame (`GameServer.lazy`). Status rows leave out position; ship bodies' core/hull % are derived on the client from part HP (`ShipClient.fillHull`); rebuild syncs carry only part HP the client lacks (`hpd`); part HP changes go together in one `shipHps` per snapshot, to a tenth. `shipSync` sends the blueprint the first time a client sees a ship; designs go once per client, others by hash (`shipSync.design`; `shipNeed` to re-ask).
- **Wire format**: snapshots are rows of values (`packSnapshot`/`unpackSnapshot`); everything owed in a tick goes in one frame (`{type:'batch', m:[...]}`, except pongs); frames are binary (`binaryCodec.ts`: `SERVER_FRAME` + each message in a small tagged format: small ints in a byte, varints, decimals as integer mantissas, lengths in the tag; decodes to what JSON would; `encodeServerMessage` encodes once for every client, `serverFrame`, `decodeServerFrame`). Frequent messages go compact `[code, ...values]` (`COMPACT` in protocol.ts; an unknown field falls back to a plain object). Projectile rows `p` have no position while on the straight line from the muzzle. Control rows are stepwise (`packControlRow`). Common strings go by number (`DICTIONARY`). permessage-deflate on top (`SocketTransport`: level 4, 8 KB window, frames under 96 bytes left alone); the ping panel's down figure is before compression. Inputs: 11-byte binary, only on change, aim as 13 bits, target tick as its low 16 bits (`unwrapTick16`), applied in target-tick order; at most 16 inputs a tick, scheduled no more than 64 ticks ahead, 32 waiting. Removals go only to clients in that system or sent the entity.
- **Measure**: `npm run bench:net` in `server/` (4 pilots in a running fight; `--spread`, `--gap N`, `--sample`). A 4-pilot fight went from ~116 KB/s per pilot (JSON) to ~1.3 KB/s (~1 KB/s deflated).
- **Plain messages**: `intercept` is sent as a plain object, not in the wire tables. `join` carries `protocol`: a mismatch closes with 4002 and the client asks for a reload. Only `join`, `ping` and sign-in are accepted before joining.
