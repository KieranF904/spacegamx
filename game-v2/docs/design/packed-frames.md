# Bit-packed frames and coalescing (protocol 29)

Status: **built**, behind two capability bits (`CAPS.PACKED` 4, `CAPS.COALESCE` 8), on for the dev server only
(`netCaps`; `NET_CAPS` elsewhere, 15 for everything). Clients without them, and every client on a server that doesn't
allow them, get the base format exactly as before. Read with docs/design/confirmed-hits.md (the caps, the hit
records) and docs/areas/networking.md.

## Why

After confirmed and client-detected hits, a fighting pilot's traffic was mostly snapshot rows (own shells, keyframes,
status rows) in the base binary codec (a tag byte per value, decimals as varint mantissas), and ~66 B of IP/TCP/TLS/WS
headers per WebSocket message, 15-21 messages a second. The bit-packing proof (scratchpad `net/pack/pack.ts`) took the
steady Pip fight 855 -> 390 B/s raw. This builds it into the game, plus coalescing to cut the messages.

## The format (common/src/network/packed)

- `tables.ts`: the constants (no imports; hashed into `wireTables()`), `packedCodec.ts`: the codec.
- A packed WebSocket message is `PACKED_FRAME` (0x04; base frames start 0x02), then bits: a reset bit (+ the client's
  player id), then **sub-frames**, each what one base frame would have been, each a run of 5-bit message codes (4-bit until protocol 61) and
  bodies, ended by `END` (another follows) or `LAST`.
- **Lossless.** The codec carries each message's compact row (`serverWire`) and the reader hands back
  `serverFromWire(row)`: what the base format decodes to, bit for bit (-0, NaN as null and all). Every number field has
  its decimals (the precision the server already rounds to) and a varint chunk size; a value that isn't exact there
  takes an escape (`110` + any number, `111` + any value), so nothing is ever lost, only bits spent.
- **One codec per connection, the same state on both sides**, changed only by what goes through it: each function
  writes or reads with the same code (`PackedIO`: a call writes its value or reads one back), so the two directions
  can't drift.
- **Slots.** Entities and shells by small numbers: two tables (shells, everything else), width from the table's size
  (code 0 = a new id follows, as the step from the last new one), lowest free slot reused. A removal, an out-of-view and
  a spent shell (a hit record's `gone`) free the slot; a table past 2,048 starts afresh (reset).
- **Shells**: a fire event's shells are new by definition (the step from the last new shell: usually 1, 4 bits); a
  shell named by its owner and shot counter was considered, but the client needs the real entity ids (removals, hit
  hashes), so the first mention carries the id step and later ones the slot.
- **Implied removal**: shells hit (`projectileHit`) wait in a pending list; a removal names one by its place there
  (1 bit + a few).
- **"You" bits**: owner, target, source and shooter fields say "the receiver's own ship" in 1-2 bits.
- **Deltas and guesses**: the snapshot tick and last input from the last snapshot; status rows' and keyframes' x/y from
  that entity's last, moved on by its last velocity for the ticks since (and the angle by its turn rate), velocities and
  HP as steps; projectile rows from the same gun's last shell (owner and gun go first); fire events' part and aim from
  that owner's last; part HP from the last HP sent for that part of that ship; positions of hits, blasts, part losses
  and bumps from the last of their kind.
- **Field by field** (a field-kind table): damage, projectileHit, hpCheck, detonation, ignite, partDestroyed, contact,
  shipSync (compact form), playerState. Hand-written: snapshot, hits (records with shell and target slots), shipHps.
  **Everything else** (and any row whose shape the packing doesn't expect: negative ids, a bad entity type, a hits list
  that isn't canonical) is `LEGACY`: byte-aligned, the base codec's bytes, in the same message.
- **Losing track**: a packed message that doesn't decode (a bug, never expected) stops the reader; it skips packed
  messages until one starts afresh, and asks for that (`packedResync`, at most once a second).

## Coalescing (server/src/net/snapshot/PackedLink.ts)

Each base frame becomes a sub-frame. With `COALESCE`, a sub-frame with nothing urgent waits up to `COALESCE_TICKS`
(3, server constants.ts; sent to the client as `netCaps.hold`) for the next; they go as one message. **Urgent** (goes
at once, with whatever waits before it): any message outside the tick's stream (`CAN_WAIT`: answers to requests,
deaths, `netCaps`, `hitFix`, boss warnings...), a snapshot that corrects the client's own ship (its row or a keyframe),
damage to or from it, and the first snapshot after a hit to or from its ship (Outbox marks it from `addDamage`), so a
client finding its own hits isn't kept waiting for them. Pongs go at once and take what waits along. The client widens
its interpolation delay by the hold (GameState `coalesceMs`); the server's judging of hit reports waits as much longer.

## Measured (probe: real GameServer, fake clients, 20 s, 3 ticks latency; the shooter's B/s)

Before = protocol 28 with confirmed and client-detected hits (caps 3). Packed = caps 7, packed + coalesced = caps 15.
Wire = payload + 66 B x messages/s. Deflated = the server's permessage-deflate (level 4, window 2^13, frames >= 96 B).

| scenario | before raw / deflated, msg/s, wire | packed raw, wire | packed + coalesced raw, msg/s, wire | wire change |
|---|---|---|---|---|
| 2 Pips | 769 / 684, 14.9, 1,755 | 334, 1,320 | 327, 10.8, **1,040** | -41% |
| Hammerhead | 2,314 / 1,487, 19.4, 3,591 | 967, 2,244 | 961, 15.2, **1,961** | -45% |
| Gale (Sparks) | 2,768 / 1,550, 20.0, 4,088 | 1,109, 2,429 | 1,106, 17.8, **2,280** | -44% |
| Scrap Mother | 3,949 / 2,806, 21.1, 5,341 | 1,990, 3,382 | 1,980, 16.0, **3,036** | -43% |
| Cruising (no fight) | 360 / 352, 10.4, 1,046 | 167, 853 | 161, 7.3, **646** | -38% |

- Deflated, packed is a little smaller still (Hammerhead 926, Gale 1,024, boss 1,804 B/s): deflate finds less to do
  in bits (before, it took Hammerhead 2,314 -> 1,487).
- The observer on the base format is the control: unchanged in every run (941, 2,488, 3,717, 2,553, 356 B/s).
- Corrections, hash disagreements and hpCheck mismatches: the same with or without packing and coalescing (0-2 fixes,
  0 mismatches).
- Coalescing saves least where the pilot is hitting something: own hits are urgent (Hammerhead 306 of 312 messages
  went early: 297 of 304). An idle or watching client gets about a third fewer messages at 3 ticks; at 6 ticks (100 ms)
  the cruise went to 5.2 messages/s and 499 B/s on the wire, Pips 8.2/866 (an earlier build of the urgency rule).
- Server step: within the run-to-run noise (+0 to 0.05 ms a tick with one packed client); the codec encodes per client.

## Tests

- `common/src/network/packed/packedCodec.test.ts`: every covered message and the fallbacks against the base format,
  odd values, a 400-frame seeded run (slots reused, entities gone and back, pairs of sub-frames), resets, the reader
  on both formats, losing track and starting afresh.
- `server/src/net/snapshot/packedFrames.test.ts`: a real fight with a packed observer and a base-format observer: every
  packed message the server sends is decoded on the side and compared with the base format; both observers see the
  same damage, fires, impacts, detonations and removals and hold the server's HP; fewer, smaller messages. Switching
  packed off and on mid-fight; coalescing an idle client; a request's answer going at once.

## Left

- Lossy fields: everything is lossless today. Rows the client re-rounds anyway (keyframe velocities at 1e-4, angles at
  1e-5) could go at the client's precision, but replicas must step from the same numbers as the server's shadow, so it
  needs the replica's quantisation moved to the server first.
- `shipSync` with a blueprint, `items`, toasts, boss telegraphs go as the base format (rare; big when they come).
- Coalescing for the shooter: own hits are urgent by rule; a client that shows its own hits from its cosmetic layer
  could let them wait.
- Client -> server: compact inputs since protocol 35 (CAPS.INPUTS: 2-4 bytes, fewer of them): docs/audits/input-compaction-2026-11-04.md.

## Review fixes (2026-11-04)

- An encode that throws (a message the codec chokes on) no longer reaches the tick: PackedLink sends what it held as
  base-format frames, in order, and resets its encoder, so the next packed message starts afresh (the codec's tables
  may be half written; a client that read on from them would get wrong ids without noticing). Counted in
  `stats.failed`, logged once. Test: PackedLink.test.ts.
- Open: after a client loses track (packedResync), the messages it dropped until the reset are gone, and nothing
  re-sends the world (a missed removal leaves an entity behind). The codec is lossless and both sides run the same
  code, so this should only follow a bug; if it is ever seen, the resync should also start the client's view afresh.
- Open: the writer builds the decoded copy of every row as it writes (one function for both directions), so a packed
  client costs the server a snapshot's arrays again; and Slots finds the lowest free slot by a scan. Neither showed in
  the probe's tick times; worth measuring with many packed clients.

## Follow-ups (2026-11-04)

1. **Shells made and gone inside one coalesced message are drawn** (client only, no wire change). A coalesced
   message's sub-frames are applied in one go, with no frame drawn between them, so a shell made by one snapshot and
   removed by a later one in the same message (or spent by a confirmed hit there) was never seen by the renderers: no
   tracer, only a mark where it hit. The probe counted 4-13 a run (the client's own are covered by WeaponFx.adopt since
   88052f5; another ship's had nothing). GameState now keeps a shell removed before any frame drew it until one has
   (`madeNow` is "made since the last frame drawn", cleared in `interpolate`; `lateRemovals` wait for a frame, then go
   with the next snapshot), the rule it already had for a shell made and removed by one snapshot. An id the server
   uses again while one waits replaces it; with no frames drawn at all (a hidden tab) nothing waits more than 30
   snapshot ticks. The server sends nothing more. Test: client/src/state/lateRemovals.test.ts (real GameState and
   WeaponFx: the tracer is made; 2 of its 7 fail on the old rule).

2. **A client that finds its own hits isn't sent its hits early** (no wire change; behind `CAPS.COALESCE` with
   `HITS | SELF_HITS`). Damage to or from its ship and the first snapshot after a hit made a frame urgent, so a
   shooter's messages almost never coalesced (Hammerhead: 297 of 304 went early; Gale and debris: all). For such a
   client (`quietHits`, PackedLink.ts) none of that is urgent now, nor its own row when the row went only for its HP
   or as the periodic safety copy (`ClientConnection.selfRowQuiet`: SnapshotBuilder now tells that from a correction:
   a forced or late-input row, a new keyframe version, first sight, or a change to what its flight depends on, which
   all stay urgent, as do deaths, answers and everything outside the tick's stream). What it costs: the HP numbers of
   its hits confirm up to COALESCE_TICKS (50 ms) later. Impacts aren't affected: every drawn shell stops at the surface
   it touches as drawn, in that frame, whatever the server's hit says (docs/areas/weapons.md, "Where a shell stops";
   built right after this), so a late hit message no longer lets a shell fly on past a hull. The adopt path is unchanged (more shells now come and go inside one
   message: the client's own are adopted, others' drawn by follow-up 1). `PackedLink.stats.why` counts what made
   each early message go. Probe (caps 15, shooter): messages/s Pips 10.8 -> 8.3, Hammerhead 15.2 -> 9.8, Gale
   17.8 -> 10.1, debris 17.9 -> 10.2, boss 16.0 -> 13.7 (the boss's blows correct the pilot's ship: real
   corrections), pirates 10.5 -> 10.1, cruising 7.3 (unchanged); wire estimate Hammerhead 1,961 -> 1,595, Gale
   2,280 -> 1,756, Pips 1,040 -> 874, debris 3,471 -> 2,945 B/s. Hash disagreements, corrections and hpCheck
   mismatches unchanged. Test: packedFrames.test.ts ("the shooter finds its own hits": no hit-urgent messages, its
   sub-frames share messages, and it sees the same hits, fires, blasts and removed shells as the legacy observer).
