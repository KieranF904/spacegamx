# Networking and protocol
How client and server talk: message types (objects over a WebSocket), the compact/binary wire encoding, the snapshot and ship-replication format, the version/hash handshake, and the transports (WebSocket, in-process). Gameplay never touches sockets; it builds `ServerMessage`s and the codec turns them into frames. Read this instead of protocol.ts (a small index now; the tables live under common/src/network/protocol/) when adding a message or a snapshot field.

This page is an index; the content is split by topic under docs/areas/networking/ (no section was dropped; each part keeps its original headings). Start with rules.md for the invariants, how to extend and the tests.

### [Files (what each owns)](networking/files.md)
- Files (what each owns)

### [Public interface: rows, motion, inputs, boss messages](networking/interface-core.md)
- Public interface
- Own pilot row (`EntityType.Player`) `data[N]` (built in SnapshotBuilder.systemRows, net/SnapshotBuilder.ts)
- Other pilots' status row (`row.other`) `data`
- Charge tells (protocol 18)
- Other entities
- Ship motion (snapshot `k`, `c`, `f`, `o`)
- CTL bits (`CTL`, common/src/ships/replica.ts)
- Binary input (11 bytes)
- Compact inputs (protocol 35, `CAPS.INPUTS` 128)
- Boss fight messages (common/src/network/bossProtocol.ts)

### [Decision inputs and bodies' moves](networking/decisions-moves.md)
- Decision inputs (protocol 36, `CAPS.BODIES` 256, docs/design/decision-inputs.md)
- Bodies' moves (`CAPS.MOVES` 1048576, with BODIES; decision-inputs stage 4, no wire change)

### [Confirmed hits, client hits, packed frames](networking/hits-packing.md)
- Confirmed hits (protocol 27, docs/design/confirmed-hits.md part C)
- Client-detected hits (protocol 28, docs/design/confirmed-hits.md part D)
- Bit-packed frames and coalescing (protocol 29, docs/design/packed-frames.md)

### [The focus grid and encode-once blocks](networking/focus-blocks.md)
- The focus grid (protocol 38, `CAPS.FOCUS` 1024, docs/design/awareness-model.md section 0)
- Encode-once blocks (protocol 37, `CAPS.BLOCKS` 512, docs/design/awareness-model.md 7.6)

### [Causes, waypoints, mob volleys, enemy pilots](networking/causes-waypoints-pilots.md)
- Other ships' causes (protocol 39, `CAPS.CAUSES` 2048, common network/causes.ts)
- Scheduled waypoints (protocol 40, `CAPS.WAYPOINTS` 4096, common guidance/)
- Mob volleys (`CAPS.LAUNCHES` 262144, with WAYPOINTS; protocol 48, no wire change)
- The enemy AI's pilots (`CAPS.PILOTS` 8192, with BODIES; protocol 40, no wire change)

### [Crowd fallbacks, structures, cargo, debris](networking/crowd-structs-cargo-debris.md)
- Crowd fallbacks (protocol 41, `CAPS.CROWD` 16384, docs/design/awareness-model.md 7.11)
- Structures by tick (protocol 42, `CAPS.STRUCTS` 32768, with CAUSES)
- Cargo causes (`CAPS.CARGO` 65536, with CAUSES or OWN_SIM; protocol 42, no wire change)
- Debris (protocol 25; CAPS.DEBRIS, protocol 44-47)

### [Boss bytes, contacts, pull fields, mine bays, clamps](networking/boss-contacts-fields.md)
- Boss bytes round (protocol 49, 2026-11-05; docs/audits/boss-bytes-2026-11-05.md)
- Contacts on the tick layer (`CAPS.CONTACTS` 2097152, with CAUSES; protocol 53, no wire change)
- Pull fields (common sim/pullFields.ts, server ships/bridge/pullFields.ts)
- Mine Bay blasts (common network/minesProtocol.ts, ships/features/minebay/blasts.ts; JSON, no wire table change)
- Docking Clamps' links (common network/clampProtocol.ts, sim/clampPair.ts; no wire table change)

### [Invariants, how to extend, tests, gotchas, related areas](networking/rules.md)
- Invariants
- How to extend
- Tests
- Gotchas
- Related areas

### [Notes (moved from DEVELOPMENT.md and the old engine-map)](networking/notes.md)
- Notes (moved from DEVELOPMENT.md and the old engine-map)
