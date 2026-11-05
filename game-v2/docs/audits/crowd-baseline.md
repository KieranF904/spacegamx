# Crowd baseline (2026-11-04)

The yardstick for the awareness/lockstep work (docs/design/awareness-model.md). Raw numbers: docs/audits/crowd-baseline.json.
Run it with `npm run bench:crowd` in server/ (quick, about 35 s: N 20 and 50; add `-- --full` for N 20, 50, 100, 300;
`--bulk packed` for bit-packed bulk sockets; `--out file.json`). Code: server/src/bench/crowdBench.ts and
server/src/bench/crowd/ (world.ts layouts and bot pilots, probe.ts the full client, run.ts one case and the meter).

Machine: AMD Ryzen 7 9800X3D (8 threads), Node v26.5.1. Tree: refactor/split at 78cf555 plus the bench; all caps on
(netCaps 511) as on the dev server. Measured 15 s per case after 4 s warm-up. Runs repeat exactly in what the world
does (seeded, injected clock): the byte counts, agreement figures and scene are identical run to run; only the
millisecond timings move with the machine, by a few percent (1-2 ms spikes in max).

## What it runs

- A real GameServer (`scene: sectors`), N bot pilots on real connections in one system, real ships from a pool of 8
  (sparrow-t, hammerhead, corsair, ports-gale, ports-heron, ports-wasp, ports-brawler, lancer), pirate AI packs
  (raider and skiffs) topped up as they die, everyone firing: each bot picks the nearest hostile within 6 km, holds
  1.3-1.7 km off it and fires inside 1.8 km. Pilots that die stay dead (alive counts below).
- **Layouts.** *spread*: a jittered square grid, 10 km apart (N=300: about 170 km across), a pirate pack 1.8 km from every
  fourth pilot. *ball*: everyone within 5 km, packs 3.5 km out. *boss*: 20 pilots in a ring 1.5-1.9 km round a Scrap
  Mother (N is always 20 there).
- **Four probe clients** per case (spread through the list): the client's real tick layer on a real connection
  (FakeHitsClient: replicas, hit finding, own ship, bodies), all caps (511), flown by input messages with 3 ticks of
  latency each way, carrying their hit reports and own/body checks. The other N-4 are counting sockets, **legacy** (no
  caps) in the first runs and **packed** (PACKED+COALESCE, nothing owed) in the second set. So "capable" figures are the
  four probes; "legacy" figures are the other pilots.
- **Agreement.** After every snapshot a probe compares each ship it holds on its tick layer against the server's ship
  at that snapshot's tick, exactly (x, y, vx, vy, angle, angular velocity). A difference on a snapshot that did not
  keyframe that ship is a **disagreement**. Keyframes sent for ships the probe already held are counted as
  **corrections**; `hit fixes` are the server's hitFix messages. Wrecks, debris and the rest are listed apart.
- **Bytes.** Raw is the frame bytes as sent. Wire is those bytes deflated per connection (level 4, 8 KB window, flushed per
  message) plus 66 B per WebSocket message, for the four probes and the first four sampled bulk sockets.
- **Timing.** Per tick, around `GameServer.step`: tick ms is the whole step (inputs, simulation, snapshots, flush).
  Snapshots ms is `sendSnapshots` (it contains replication ms, `Replication.forClient` summed over clients); encode+send
  is `flushOutbox` (the packed encoders and the socket sends); rebuild ms is time in `ShipBridge.rebuildNow` (inside the
  tick). Bot AI and the probes' client work are outside these.

## Server cost (legacy bulk sockets)

| layout | N | tick mean ms | p95 | max | budget % | snapshots ms | replication ms | encode+send ms | rebuild ms | rebuilds/s |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| spread | 20 | 1.02 | 2.3 | 17 | 6 | 0.28 | 0.03 | 0.05 | 0.07 | 15 |
| spread | 50 | 2.40 | 6.0 | 14 | 14 | 0.94 | 0.10 | 0.08 | 0.19 | 33 |
| spread | 100 | 5.24 | 12.2 | 29 | 31 | 2.53 | 0.32 | 0.12 | 0.34 | 77 |
| spread | 300 | 17.52 | 44.7 | 75 | 105 | 10.53 | 1.94 | 0.18 | 1.12 | 173 |
| ball | 20 | 0.73 | 2.0 | 5 | 4 | 0.20 | 0.02 | 0.03 | 0.03 | 13 |
| ball | 50 | 3.52 | 9.0 | 16 | 21 | 1.62 | 0.08 | 0.17 | 0.20 | 79 |
| ball | 100 | 8.76 | 25.6 | 42 | 53 | 4.88 | 0.26 | 0.30 | 0.32 | 93 |
| ball | 300 | 32.99 | 90.7 | 136 | 198 | 19.93 | 1.53 | 0.73 | 0.39 | 79 |
| boss | 20 | 1.69 | 4.7 | 20 | 10 | 0.29 | 0.03 | 0.07 | 0.53 | 29 |

Budget is the share of a 16.7 ms tick. The server is over budget at N=300 in either layout.

With the other pilots on packed frames (same world, so the same sim; only the encoding differs):

| layout | N | tick mean ms | p95 | max | budget % | snapshots ms | replication ms | encode+send ms | rebuild ms | rebuilds/s |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| spread | 20 | 1.08 | 2.6 | 8 | 7 | 0.26 | 0.03 | 0.12 | 0.07 | 15 |
| spread | 50 | 2.47 | 6.4 | 51 | 15 | 0.80 | 0.09 | 0.34 | 0.19 | 33 |
| spread | 100 | 5.35 | 14.3 | 35 | 32 | 1.97 | 0.31 | 0.96 | 0.31 | 77 |
| spread | 300 | 19.13 | 52.5 | 83 | 115 | 9.55 | 1.97 | 2.49 | 1.11 | 173 |
| ball | 20 | 0.81 | 2.3 | 19 | 5 | 0.22 | 0.02 | 0.07 | 0.04 | 13 |
| ball | 50 | 4.02 | 10.9 | 17 | 24 | 1.20 | 0.07 | 1.14 | 0.18 | 79 |
| ball | 100 | 11.18 | 31.5 | 51 | 67 | 3.75 | 0.24 | 3.91 | 0.32 | 93 |
| ball | 300 | 52.37 | 173.6 | 248 | 314 | 16.69 | 1.46 | 22.97 | 0.33 | 79 |
| boss | 20 | 1.75 | 5.1 | 17 | 10 | 0.21 | 0.02 | 0.20 | 0.53 | 29 |

## Bytes per client per second

Legacy bulk sockets against the four capable probes:

| layout | N | capable raw B/s | capable wire B/s | legacy raw B/s | legacy wire B/s | capable msgs/s | legacy msgs/s |
|---|--:|--:|--:|--:|--:|--:|--:|
| spread | 20 | 3297 | 3682 | 5505 | 5052 | 9.4 | 20.7 |
| spread | 50 | 5101 | 5342 | 7064 | 6487 | 10.6 | 22.2 |
| spread | 100 | 6823 | 6766 | 10629 | 8290 | 9.2 | 22.6 |
| spread | 300 | 6140 | 6321 | 8744 | 7795 | 9.6 | 22.8 |
| ball | 20 | 2382 | 2767 | 4171 | 3762 | 9.5 | 17.4 |
| ball | 50 | 18961 | 18016 | 31465 | 22191 | 12.3 | 24.8 |
| ball | 100 | 35643 | 32768 | 60199 | 40589 | 14.1 | 26.8 |
| ball | 300 | 83566 | 76301 | 152077 | 103934 | 14.7 | 25.6 |
| boss | 20 | 6944 | 6587 | 16227 | 10830 | 9.4 | 15.7 |

With packed bulk sockets (PACKED+COALESCE, no hit duties):

| layout | N | capable raw B/s | capable wire B/s | packed-bulk raw B/s | packed-bulk wire B/s | capable msgs/s | packed-bulk msgs/s |
|---|--:|--:|--:|--:|--:|--:|--:|
| spread | 20 | 3297 | 3682 | 3607 | 4103 | 9.4 | 11.0 |
| spread | 50 | 5101 | 5342 | 4896 | 5823 | 10.6 | 11.1 |
| spread | 100 | 6823 | 6766 | 7410 | 7560 | 9.2 | 11.1 |
| spread | 300 | 6140 | 6321 | 6198 | 6995 | 9.6 | 11.5 |
| ball | 20 | 2382 | 2767 | 2637 | 2917 | 9.5 | 10.3 |
| ball | 50 | 18961 | 18016 | 19770 | 18994 | 12.3 | 13.5 |
| ball | 100 | 35643 | 32768 | 36361 | 33552 | 14.1 | 14.9 |
| ball | 300 | 83566 | 76301 | 83361 | 76347 | 14.7 | 16.0 |
| boss | 20 | 6944 | 6587 | 8714 | 7993 | 9.4 | 12.1 |

## Agreement of the client tick layer

| layout | N | tick-layer checks | disagreements | wrecks/debris off | keyframes on held ships /s per client | hit fixes (server) | pilots alive | AI at end |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| spread | 20 | 43419 | 0 | 93/10106 | 21.5 | 4 | 19 | 29 |
| spread | 50 | 66850 | 10 | 0/22904 | 5.9 | 5 | 50 | 45 |
| spread | 100 | 72074 | 1 | 105/12689 | 9.4 | 3 | 99 | 76 |
| spread | 300 | 82377 | 0 | 391/12901 | 14.3 | 5 | 293 | 108 |
| ball | 20 | 27863 | 0 | 0/12881 | 12.9 | 4 | 20 | 10 |
| ball | 50 | 77454 | 0 | 90/32152 | 164.4 | 7 | 50 | 17 |
| ball | 100 | 134995 | 7 | 1989/39017 | 581.2 | 33 | 100 | 10 |
| ball | 300 | 369598 | 0 | 0/40729 | 2914.3 | 2 | 300 | 11 |
| boss | 20 | 13969 | 0 | 200/11618 | 64.3 | 0 | 11 | 10 |

"Disagreements" are on the tick layer proper (own ship, other pilots, AI, the boss), without a keyframe that snapshot.
"Wrecks/debris off" are ships the client holds that are not on the keyframe path (wreck and debris bodies): a real gap
for stage work, all in the replicas of dead ships and debris, none in live ships.

## Reading it

- **Tick cost.** Roughly linear in N in the spread layout (1.0, 2.4, 5.2, 17.5 ms), and in the ball it is
  superlinear (0.7, 3.5, 8.8, 33 ms): at N=300 the snapshot build alone is 20 ms of it. Replication (`forClient`) is small
  (1.5-2 ms at 300), so the cost is in the per-client row building and diffing around it, which is what the awareness
  model removes.
- **Encode.** Legacy encode+send is cheap (0.7 ms at ball 300); the packed encoders cost 23 ms a tick at ball 300 for 296
  clients (so the whole step is 52 ms against 33): bit-packing every byte per connection is the cost encode-once targets.
- **Rebuilds.** 0.03-1.1 ms a tick, 13-173 a second; never a bottleneck here, and the rate is the figure the batching
  decision needs (a count per ship per tick is not recorded yet).
- **Bytes.** A capable client in a 300-pilot ball gets about 84 KB/s raw (76 KB/s wire); a legacy one 152 KB/s (104
  wire). In the spread layout it stays near 6 KB/s whatever N, because the 40 km view holds only a handful. In the ball
  the growth is quadratic in egress, as the design says.
- **Corrections.** In the ball a probe is sent 165 (N=50), 581 (100) and 2,914 (300) keyframes a second for ships it
  already holds: contact pulls between crowded ships. The tick layer itself agrees (0 to 7 disagreements in
  100-370 thousand checks, none at N=300), so these are keyframes that make no difference, the cost "no disagreements
  by construction" removes. The few real disagreements (spread 50: 10; spread 100: 1; ball 100: 7) are the thing to chase.

## Known limits of the bench

- Four capable clients, not N: a capable client at N=300 in a ball would also hold 300 replicas; the bench measures four.
  The server-side cost of the other pilots as capable clients is only the packed-bulk run (frames, not their duties).
- Bots stand and fight at 1.3-1.7 km; they do not fly through the system, jump or dock, so cell-crossing churn is not in
  it yet (add a cruise layout when the focus work needs it).
- Pilots that die are not respawned, so late-run N is lower in the boss layout (14 of 20 alive).
