# Networking: Invariants, how to extend, tests, gotchas, related areas
(Part of [networking](../networking.md); the other parts are listed there.)

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

