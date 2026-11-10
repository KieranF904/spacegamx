# Networking: The focus grid and encode-once blocks
(Part of [networking](../networking.md); the other parts are listed there.)

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

