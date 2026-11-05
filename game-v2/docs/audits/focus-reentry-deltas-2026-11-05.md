# Focus re-entry deltas: before and after on the crowd bench (2026-11-05)

What changed (protocol 49, `CAPS.FOCUS`; docs/areas/networking.md "The focus grid"): the dropped-cell cache (a 10 s
hold, a hash round trip, a control log the client fast-forwarded, a 600-tick replay cap) and the forget path for a
ship leaving the focus are gone. There is now one path for both. A ship leaving a pilot's view is remembered at both
ends for 5 minutes, at most 256 a client (common network/cells.ts `AwayShips`, the same rule at both ends). The client
keeps its structure and status row (client ships/cells/ShipMemory.ts). The server keeps what it last sent of it
(server net/cells/AwayNet.ts). When the ship comes back the client gets its keyframe (movement, full precision) and only
what changed while it was away: its row if the key changed, part HP changes, a light sync for a rebuild, and a design
sync only if the ship was replaced. Nothing is replayed. A ship destroyed while away is told by id in the snapshot's
removals.

The cell hash round trip is gone, not kept as an optional check. The keyframe on re-entry carries the real state, so
nothing on the tick layer depends on what the client kept: its replica starts from the keyframe. A client that has
lost a kept ship answers `b` with `shipNeed`, which resends the ship's sync, name and row. That covers the one thing a
hash would catch.

## Runs

`cd server && npx tsx src/bench/crowdBench.ts --case cruise:100 --caps 2047 --bulk focus --secs 20` (4 probes), and
the same with `--secs 60 --probes 8`. Cruise has 100 pilots on a 12 km grid, flying out and back along 24 km legs.
"Before" is c172094 (refactor/split), run from an exported copy of the tree. Both runs use the same seed and scene, and
both carry the same probe instrumentation, added for this audit (bench/crowd/probe.ts `reentry`):

- A **re-entry** is a ship back on a probe's tick layer that the probe had held before during the run. In the old path
  this also covers ships put back from a log (`attach`).
- **Bytes** are measured per message with the plain codec, the same measure the bench's `subTypesBps` uses. They show
  shares, not the bit-packed wire. They count the `cells` messages (both leaving and coming back), the re-entering
  ships' syncs, and their status rows and keyframes in that snapshot (the snapshot with and without them). The old
  path's `cellCache` answers going up are counted too.
- **Client CPU** is the time of each re-entering ship's first replica step after it comes back. In the old path that
  step is the log's fast-forward; in the new one it starts from the keyframe. It also covers the probe's whole client
  time per tick.

## Numbers

60 s, 8 probes (385 / 384 re-entries):

| | before | after |
|---|--:|--:|
| bytes per re-entry | 477 | 269 (-44%) |
| - syncs | 293 | 148 |
| -- of which design syncs (ship replaced while away, see below) | 293 | 145 |
| - status rows | 88 | 12 |
| - keyframe | 77 | 77 |
| - `cells` messages (leave + back) | 15.7 | 31.6 |
| - `cellCache` up | 3.4 | 0 |
| re-entry bytes per probe per second | 382 | 215 |
| first step after re-entry: mean / max | 0.35 us / 0.071 ms | 0.14 us / 0.001 ms |
| probe client ms per tick (all of it) | 0.042 | 0.036 |
| capable raw / wire B/s | 2,484 / 3,185 | 2,408 / 3,122 |
| server tick / snapshot ms | 2.72 / 1.23 | 2.62 / 1.16 |
| tick-layer disagreements / checked | 0 / 127,876 | 0 / 127,709 |

20 s, 4 probes (59 / 59 re-entries): 363 -> 211 bytes per re-entry (-42%). Syncs went from 184 to 83 (82 of those
design syncs), rows from 87 to 21, the keyframe stayed at 76 and cells went from 13.5 to 31.7. Per probe that is 268
-> 156 B/s. The first step was 0.20 -> 0.18 us mean. Disagreements were 0 / 19,004 before and 0 / 19,016 after.

Old-path counters, 60 s: 267 offers, 1 log (1 ship, a 309-tick replay) and 270 refused (245 too late: the bulk sockets
never answer; 16 too big; 9 with nothing). The other 4,437 re-entries came as new.
New-path counters, 60 s: 3,973 kept, 3,724 back, 4 forgotten (debris or never synced), 21 removed while away, 0 let go,
0 missed (no `shipNeed`).

## Reading it

- **Bytes.** A ship coming back now costs its keyframe (77 B on this measure), its row only if it changed (12 B
  averaged) and its share of the `cells` lists (about 32 B, both leaving and coming back). The full sync (about 150 B
  of part HP, maxima and detached parts each time) and the full status row with its place no longer go.
- **Design syncs in the "after" column are a bench artefact.** The scene replaces every pilot's ShipState at tick 20
  (scene setup, `spawnOn`), after the probes have synced the join-time ones and while most of those ships are already
  out of view. A replaced ship correctly gets a design sync on its first return; the blueprint goes by its hash. Leave
  those out and a steady-state re-entry is about 124 B here (keyframe 77, cells 32, row 12, light syncs 3), against
  477 B before: -74%. In play, a ship is replaced on a respawn or a refit.
- **Client CPU.** The old fast-forward almost never ran in cruise: a dropped cell rarely comes back inside 10 s with a
  log smaller than an entry. So the CPU it saves here is small: one 309-tick catch-up, the 0.071 ms worst first step.
  What the change removes is the possibility of that burst. A re-entry is now always a keyframe and costs the same as
  any ship's first step (0.14 us mean, 0.001 ms max). The probe's whole client time per tick is within noise (0.042 ->
  0.036 ms).
- **Re-entries that pay off.** The old path paid off only for re-entries within 10 s whose log stayed small. In cruise
  that was 1 in 385. The new path pays off for every re-entry within 5 minutes.
- **The `cells` lists cost more than before.** Every leaving ship is now named once (`k`) and every returning one once
  (`b`). Before, only dropped cells were named. That is about 16 B more per re-entry on this measure (a few bytes
  bit-packed). A possible follow-up: make `k` implicit (the client keeps every `out` id that isn't listed as
  forgotten) and send only the rare exceptions.
- **Agreement unchanged.** No tick-layer disagreements in either run, and none in the tests: the ships come back after
  2.5 s and 40 s with every cap, HP changed while away, destroyed while away, let go by age, dithering on the 19 km
  edge, and crossing cell borders.

Raw output: the bench's CROWDJSON lines were kept in the session scratchpad (before20/after20/before60/after60). Rerun
with the commands above. "Before" needs the c172094 tree with this commit's bench/crowd/probe.ts `reentry` counters
(plus the `attach` and `cellCache` hooks, which the new code doesn't have).
