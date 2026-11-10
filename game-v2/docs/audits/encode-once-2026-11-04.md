# Encode once: before and after (2026-11-04)

What `CAPS.BLOCKS` (512, protocol 37; docs/areas/networking/focus-blocks.md "Encode-once blocks", docs/design/awareness-model.md 7.6)
changes on the crowd bench (docs/audits/crowd-baseline.md). Raw numbers: encode-once-packed-2026-11-04.json (before:
bulk sockets on PACKED|COALESCE, probes on caps 511) and encode-once-blocks-2026-11-04.json (after: bulk sockets on
PACKED|COALESCE|BLOCKS, probes on 1023). Same seeded worlds, so the same sims: the agreement figures are identical
case by case. `npm run bench:crowd -- --full --bulk blocks --caps 1023` in server/.

## Server cost (ms per tick) and bytes per client per second

| layout | N | tick ms before | after | snapshots ms before / after | encode+send ms before / after | deflate ms saved (est.) | bulk raw B/s before / after | bulk wire B/s before / after | disagreements |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| spread | 20 | 1.01 | 0.96 | 0.23 / 0.25 | 0.11 / 0.06 | 0.16 | 3607 / 3837 | 4103 / 4553 | 0 / 0 |
| spread | 50 | 2.41 | 2.22 | 0.73 / 0.78 | 0.33 / 0.19 | 0.49 | 4896 / 5196 | 5823 / 6755 | 10 / 10 |
| spread | 100 | 5.29 | 4.85 | 1.99 / 2.07 | 0.94 / 0.48 | 1.22 | 7410 / 7871 | 7560 / 8760 | 1 / 1 |
| spread | 300 | 17.92 | 16.91 | 9.03 / 9.34 | 2.34 / 1.36 | 5.50 | 6198 / 6413 | 6995 / 7807 | 0 / 0 |
| ball | 20 | 0.72 | 0.70 | 0.17 / 0.18 | 0.07 / 0.04 | 0.08 | 2637 / 2799 | 2917 / 3376 | 0 / 0 |
| ball | 50 | 3.90 | 3.33 | 1.17 / 1.29 | 1.09 / 0.49 | 0.78 | 19770 / 21056 | 18994 / 22077 | 0 / 0 |
| ball | 100 | 10.56 | 8.32 | 3.38 / 3.57 | 3.94 / 1.61 | 2.61 | 36361 / 37875 | 33552 / 38892 | 7 / 7 |
| ball | 300 | 48.22 | 35.60 | 15.33 / 17.02 | 21.70 / 7.54 | 10.25 | 83361 / 85226 | 76347 / 86365 | 0 / 0 |
| boss | 20 | 1.62 | 1.58 | 0.20 / 0.23 | 0.18 / 0.11 | 0.16 | 8714 / 9012 | 7993 / 9141 | 0 / 0 |

- **Tick.** Ball 300: 48.2 to 35.6 ms (-26%); ball 100: 10.6 to 8.3 (-21%). Encode+send at ball 300: 21.7 to 7.5 ms.
  Snapshots ms rises a little (+0.1 to +1.7) because the blocks are made there, when each snapshot is queued.
- **Deflate.** The bench's sockets are fake, so the old path's per-socket permessage-deflate never showed in its tick.
  "Deflate ms saved" is the deflate the bench itself does on sampled frames, timed and scaled to all bulk clients (an
  upper bound: async zlib, threadpool). Blocks frames go undeflated, so on a real server that is CPU off the box too.
- **Bytes.** Raw: +3 to +7% (wire ids vs small per-connection slot tables, an absolute bit per chained block, intros).
  Wire: +11 to +16%, because blocks frames aren't deflated any more (the design's default, open question 10). Within
  the phase's 10% on raw bytes; the wire cost is the trade for the deflate CPU. If Kieran wants the bytes back,
  sending blocks frames deflated again is one line (PackedLink.emit).
- **Agreement.** Identical before and after: every tick-layer check and disagreement is the same case by case.

## What is per client now

Per BLOCKS client the encoder keeps the wids it was told and the chain generation it holds per entity and per gun
(`BlockPeer`). Each status row, shell row, keyframe, control row and fire event is bit-packed once a snapshot for every
client (`BlockStore`). The client's own row, removals, out-of-view, own causes and decisions still go through the
connection's codec, and so do the other messages (effects, shipHps, shipSync, hits).

## Probes (netAuditBodies, 20 s, 3 ticks latency)

| scene | shooter raw B/s 383 / 895 (with BLOCKS) | hit disagreements | own checks off | own tick-layer off | boss tick-layer off |
|---|--:|--:|--:|--:|--:|
| boss | 1837 / 1919 (+4.5%) | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| npcfight | 640 / 691 (+8%) | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |

## Known gaps (next)

- The snapshot walk is still per client × system rows (`lastEntityStates` keys, `shipSynced` / `shipHpSent`, HitLedger's
  plan): 17 ms at ball 300. Cells (phase 4) make that per client × focus cells.
- Shells are still named by entity id (absolute in fire blocks), not (owner, shot counter).
- Effects (damage, projectileHit, detonation, partDestroyed, contact), shipHps, shipSync and hits records are still
  encoded per connection. In the bench the bulk clients get the effects (no HITS); capable clients get records instead.
- Planning per client (sorting its control rows and fire events, block lookups) is about 1.3 s of a 51 s profile at ball 300.
