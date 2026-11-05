# Sim foundation baseline (2026-11-06)

The "before" numbers for the sim foundation plan (one deterministic stepper, PT/ST prediction). Taken once, on
`refactor/split` at 1f4849b plus the Stage 0 contracts (common/src/sim: no caller is rewired, so nothing measured
here runs through them). Windows desktop, Node 26.5, nothing else benching. The Stage 3 "after" run repeats exactly
these commands.

## Netcode table

`cd game-v2/server && npm run bench:table` (protocol 53, caps 4194303, FakeHitsClient, 3 ticks latency each way;
wire = payload + 66 B a WebSocket message).

| scenario | payload B/s | WS msgs/s | wire B/s | up B/s | notes |
|---|---:|---:|---:|---:|---|
| idle | 125 | 1.75 | 241 | 3 | |
| cruise | 610 | 9.55 | 1240 | 125 | |
| rock-starter | 280 | 6.40 | 702 | 59 | firing 100% of ticks |
| rock-gale | 567 | 9.90 | 1220 | 62 | firing 100% of ticks |
| map | 172 | 1.75 | 287 | 3 | |
| reentry | 113 | 2.10 | 252 | 1 | 24 re-entries |
| crowd-20, crowd-50, crowd-100 | - | - | - | - | failed: `no blueprint lancer` |
| mother, pyreclast | - | - | - | - | failed: `no blueprint hammerhead` |
| pirates, custom | - | - | - | - | failed: `no blueprint corsair` |

Seven scenarios don't run on this tree: netTable.ts places pilots in blueprints (lancer, hammerhead, corsair) that
the ports-core library no longer has under `data/ships/blueprints/` (only `fixtures/corsair.json` is left). The
bench needs its blueprint names updated before Stage 3's "after" run; until then the six rows above are the
comparable ones. (Not fixed here: Stage 0 measures, it doesn't change the bench.)

## Crowd: server tick and client CPU

`cd game-v2/server && npx tsx src/bench/crowdBench.ts --layouts ball,cruise` (quick: n 20 and 50, ~10 s measured
each; 4 probe clients with caps 511, latency 3 ticks; bulk sockets legacy).

The client figure is `probeClientMsPerTick`: what one probe client's tick layer (replicas, own tick, hits, contacts)
costs a tick, the mean of the 4 probes. `client debris` is its debris world alone.

| layout | n | server tick ms (mean / p95 / max) | client ms/tick | client debris ms/tick | cap wire B/s | kf corr/s | disagree |
|---|---:|---|---:|---:|---:|---:|---:|
| ball | 20 | 1.02 / 2.63 / 4.5 | 0.237 | 0.017 | 2483 | 16.90 | 0 |
| ball | 50 | 3.54 / 7.88 / 12.2 | 0.890 | 0.075 | 13629 | 87.10 | 0 |
| cruise | 20 | 1.11 / 2.09 / 13.8 | 0.083 | 0.004 | 2295 | 17.10 | 0 |
| cruise | 50 | 1.88 / 3.94 / 6.9 | 0.144 | 0.003 | 3156 | 10.07 | 0 |

The ball's client cost grows faster than its ship count (20 -> 50 ships: 3.8x for 2.5x the ships); the cruise's
doesn't (1.7x). Stage 1C's cached contact pairs are aimed at the ball's figure.

## Parity goldens

- `common/src/ships/golden/flightTraces.test.ts` (the pinned pilot traces, 10 tests): green, unchanged.
- `server/src/golden/parity.test.ts` (server vs ShipClient.predict vs replicaStep, keyframe ticks pinned in
  parity.golden.json; 48 tests, ~68 s): green, unchanged.
- `common/src/ships/features/*/contract.test.ts` (stepShipPhysics vs replicaStep per feature): green.
- New: `common/src/sim/sim.test.ts` flies every golden script through the Stage 0 `stepShip` adapter and lands on
  the pinned trace and charge hashes, and passes the PT/ST determinism harness on each and on a 240-tick crowd.
