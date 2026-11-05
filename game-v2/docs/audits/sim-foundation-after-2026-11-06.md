# Sim foundation: after (2026-11-06)

The "after" numbers for the sim foundation plan, against `docs/audits/sim-foundation-baseline-2026-11-06.md`. Taken
once on Stage 3b's branch (refactor/split aa2775f, the debris fix 253ef88, Stage 3b 64f7865 and 813f2cd). Same
machine and commands as the baseline. Windows desktop, Node 26.5, with nothing else benching.

Two "before" columns are given:

- **Baseline**: the baseline doc's own numbers (refactor/split 1f4849b + Stage 0, protocol 53).
- **Pre-3b**: the same commands run on 253ef88 (Stages 1, 2 and the debris fix merged; protocol 55). This is the
  fair before for Stage 3b. The baseline bench couldn't run seven scenarios, and its crowd probes ran caps 511, not the
  full set.

## Netcode table

`cd game-v2/server && npm run bench:table` (protocol 55, caps 8388607, FakeHitsClient, 3 ticks latency each way;
wire = payload + 66 B per WebSocket message). All values are B/s except msgs/s.

| scenario | baseline payload | pre-3b payload | **after payload** | pre-3b msgs/s | **after msgs/s** | pre-3b wire | **after wire** | up (pre-3b / after) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| idle | 125 | 106 | **113** | 1.25 | **1.30** | 189 | **199** | 2 / 3 |
| cruise | 610 | 634 | **317** | 9.50 | **3.55** | 1261 | **551** | 125 / 108 |
| crowd-20 | - | 1228 | **980** | 9.63 | **8.57** | 1864 | **1545** | 139 / 137 |
| crowd-50 | - | 1209 | **958** | 9.63 | **8.00** | 1845 | **1486** | 141 / 138 |
| crowd-100 | - | 1433 | **1223** | 10.17 | **10.07** | 2104 | **1887** | 107 / 107 |
| rock-starter | 280 | 201 | **201** | 4.75 | **4.75** | 515 | **515** | 54 / 54 |
| rock-gale | 567 | 271 | **271** | 6.95 | **6.95** | 730 | **730** | 60 / 60 |
| map | 172 | 153 | **160** | 1.25 | **1.30** | 235 | **245** | 2 / 3 |
| mother | - | 1899 | **2233** | 15.15 | **15.25** | 2899 | **3239** | 618 / 620 |
| pyreclast | - | 327 | **327** | 0.75 | **0.75** | 376 | **376** | 341 / 341 |
| pirates | - | 634 | **634** | 8.35 | **8.35** | 1185 | **1185** | 683 / 683 |
| custom | - | 1180 | **1448** | 10.85 | **10.85** | 1896 | **2165** | 571 / 571 |
| reentry | 113 | 98 | **104** | 1.68 | **1.71** | 209 | **217** | 1 / 1 |

What moved:

- **cruise −50% payload, −63% messages; crowd −15 to −20%.** The server's own control rows used to go whenever the
  pilot's engines ran short of power or a boost was refused. The client now steps its stores itself, so it works out
  those bits, and the rows carry only held keys, aim and hazard bits (Replication `OWN_DERIVED_BITS`). A cruising pilot
  on boost legs was getting a control row in nearly every snapshot.
- **idle, map, reentry +6 to +7 B/s.** This is the head hash's floor: a snapshot with the head hash at least about
  once a second (`HEAD_HASH_TICKS`). It rides the frame that carries the HUD numbers, so it adds a few bytes but almost
  no messages (+0.05/s).
- **mother +18%, custom +23%.** These are corrections that the full-state hash now finds. In the Scrap Mother fight,
  something server-side keeps four of the pilot's ports and one augment buffer empty from about tick 790. The client's
  step doesn't model it. A shield taking hits from its stores is the likely cause; it isn't confirmed. Each correction
  is an own keyframe plus an `ownSync`. OwnChecks makes them at most once a second (`FIX_GAP`), so mother gets 9 in
  20 s rather than 42. Before Stage 3b the client's stores were simply wrong there and never put right.
- The rock, pirates and pyreclast rows are unchanged to the byte.

## Crowd: server tick and client CPU

`cd game-v2/server && npx tsx --tsconfig ../scripts/net/tsconfig.json src/bench/crowdBench.ts --layouts ball,cruise --out f.json`.
This is the quick mode (n 20 and 50), with bulk sockets and 4 probe clients on the full caps set (DEFAULT_CAPS) and
3 ticks latency.

The client figure is `probeClientMsPerTick`: one probe client's tick layer per tick (replicas, its own ship, hits,
contacts, bodies). It is the mean of the 4 probes.

| layout | n | server tick ms mean / p95 (pre-3b) | **after** | client ms/tick: baseline (caps 511) | pre-3b (full caps) | **after** | capable wire B/s (pre-3b / **after**) |
|---|---:|---|---|---:|---:|---:|---|
| ball | 20 | 1.37 / 3.48 | **1.50 / 4.09** | 0.237 | 0.435 | **0.450** | 2538 / **2529** |
| ball | 50 | 5.93 / 15.24 | **6.27 / 16.05** | 0.890 | 1.807 | **1.833** | 14380 / **14380** |
| cruise | 20 | 1.43 / 2.87 | **1.43 / 3.09** | 0.083 | 0.126 | **0.129** | 1881 / **1637** |
| cruise | 50 | 2.51 / 5.39 | **2.68 / 5.96** | 0.144 | 0.170 | **0.179** | 2571 / **2294** |

What moved:

- **Client CPU: +1 to +5% against pre-3b.** The probe now does what a game client does. It steps its own ship ahead
  to the current tick every tick, with the whole step (guns included), and steps it again when a snapshot moves it.
  Before, the fake client never predicted; the real client's prediction was a second step that no probe measured.
  The own ship's ahead ticks find no contact pairs, so the "pairs found once a tick" property holds.
- **The near-doubling against the baseline is the caps, not this stage.** The baseline probes ran caps 511, without
  causes, contacts, bodies or waypoints. The full set costs the same on 253ef88 as after.
- **Server tick: +0 to +9% mean, within run-to-run noise here.** The server now hashes each pilot's full state once
  per snapshot round (`SnapshotBuilder.ownNow`).
- Agreement and debris checks are identical in both runs: 0 disagreements; ball-50 has 29 other disagreements and
  21 debris offs, the same in both.

## Golden frame hash (server/src/golden/frameHash.test.ts)

The driver now sends its inputs with a target tick, as a client's do. Before, every input arrived "late", which marked
the pilot's own ship off every tick: an own row and a keyframe every round. Over all 900 ticks:

- All 9 world hashes, the probes and the faults are identical.
- WebSocket messages per pilot drop from ~311 to ~163 (−48%).
- Snapshots stay at 299-300 per pilot. Four pilots flying close with changing controls have something to say each round.

## Parity

- `server/src/golden/parity.test.ts`: server vs the client's own step, flown through `stepOwnShip` (what
  OwnTick.step runs), tick by tick, on body, charge and guns, for every script and the five firing models.
- New in the same file: a lost input's missed shots. The full-state hash finds them at the first snapshot after, and
  the server's `ownSync` (packed and unpacked as the wire carries it) puts guns and stores back exactly from there.
- `common/src/sim/a-callers.test.ts`: stepMovement, the own layer, replicaStep and stepShip agree tick by tick,
  hazards and priming in play.
- `server/src/net/own/ownSim.test.ts`: the fake client's own layer is checked against the server at every snapshot's
  head hash (full state), with 0 misses.
