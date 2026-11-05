# The netcode run, before and after (2026-11-05)

What the whole lockstep and awareness run (commits `78cf555` to the review, on `refactor/split`) changed, measured on
the same machine with the same seeded scenes. The design is docs/design/awareness-model.md (section 12 lists what was
built and what wasn't); the wire is docs/areas/networking.md. Every new behaviour is behind a caps bit; a client without
one gets the path it had before.

## How it was measured

- **Crowd bench** (`cd server && npm run bench:crowd -- --full ...`): a real server, N bot pilots fighting real ships
  and pirate packs, four probe clients running the client's real tick layer with 3 ticks of latency. 15 s per case.
  The scene is seeded, so bytes and agreement repeat exactly; only the millisecond timings move between runs.
  - **Before:** today's code, every pilot on the old path: probes with caps 511 (everything up to BODIES), the
    others legacy sockets.
  - **After:** every pilot on the new path: probes with every cap but CROWD (245759), the others on packed, blocks
    and focus.
  - The world moved during the run (the AI is flown differently, rebuilds are batched, debris lives longer), so the
    first baseline (docs/audits/crowd-baseline.md, 2026-11-04) isn't the same scene any more: its ball 20 sent 2.4 KB/s
    where today's code on the old caps sends 6.0 KB/s. "Before" here is the old caps on today's world, so only the
    netcode differs. The first baseline's figures are close to it everywhere else.
- **Scenario probes** (scratchpad probe, 20 s each): one pilot in a fixed fight. "Before" is the Effects stage's
  baseline (caps 511); "after" is every cap.

## The headline

| | Before | After |
|---|--:|--:|
| Corrections per second (300-pilot ball, per client) | 2,980 | 3 |
| Corrections per second (100-pilot ball) | 498 | 3.5 |
| Download, 300-pilot ball, capable client | 89.7 KB/s | 66.8 KB/s |
| Download, 300-pilot ball, everyone else | 159.6 KB/s | 91.2 KB/s |
| Download, 100 pilots spread out | 6.9 KB/s | 3.3 KB/s |
| Ships each client simulates, 100 spread out | 80 | 26 |
| Server tick, 300-pilot ball | 41 ms | 22 ms with crowd fallbacks (50 ms without) |
| Tick-layer disagreements, every case | 1 | 7 (one own-ship episode, see risks) |

A **correction** is the server sending a keyframe of a ship the client already holds, because the client got it wrong
or the server couldn't prove it got it right. Before, nearly all of them changed nothing; now the client works out
contacts, rebuilds, AI flight, homing shells, debris and cargo itself and the server only says what caused them.

## Crowd bench

### Corrections (keyframes of ships a client already holds, per second per client)

| Case | Before | After |
|---|--:|--:|
| Spread, 20 pilots | 5.4 | 0.30 |
| Spread, 50 | 10.1 | 0.82 |
| Spread, 100 | 13.5 | 0.58 |
| Spread, 300 | 6.6 | 0.15 |
| Ball, 20 | 55.7 | 0.13 |
| Ball, 50 | 134 | 4.5 |
| Ball, 100 | 498 | 3.5 |
| Ball, 300 | 2,980 | 3.0 |
| Boss (Scrap Mother), 20 | 103 | 1.0 |

### Download per client (raw bytes per second)

| Case | Capable before | Capable after | Others before | Others after |
|---|--:|--:|--:|--:|
| Spread, 20 | 1,987 | 1,218 | 3,626 | 2,026 |
| Spread, 50 | 5,339 | 2,873 | 7,285 | 3,464 |
| Spread, 100 | 6,884 | 3,317 | 10,230 | 4,066 |
| Spread, 300 | 5,430 | 2,215 | 8,289 | 3,413 |
| Ball, 20 | 6,039 | 5,678 | 10,024 | 6,590 |
| Ball, 50 | 18,201 | 17,603 | 29,945 | 20,294 |
| Ball, 100 | 30,704 | 26,296 | 51,435 | 32,729 |
| Ball, 300 | 89,689 | 66,822 | 159,563 | 91,229 |
| Boss, 20 | 9,186 | 7,452 | 25,153 | 13,433 |

Messages per second for the other pilots fell from 19-27 to 11-16 (coalescing). Wire bytes follow raw closely: blocks
frames go undeflated, which costs 11-16% on the wire and saves the server about 10 ms of compression a tick at ball 300.

### Server tick (ms, mean; budget 16.7)

| Case | Before | After | After, crowd fallbacks on |
|---|--:|--:|--:|
| Spread, 100 | 4.8 | 4.9 | 4.9 (level 0) |
| Spread, 300 | 16.2 | 15.5 | 11.5 (settles at level 4, 9.3 ms) |
| Ball, 50 | 3.4 | 4.2 | – |
| Ball, 100 | 7.3 | 9.3 | 9.2 (level 0) |
| Ball, 300 | 41.3 | 50.5 | 22.1 (settles at level 9, 15.3 ms; p95 124 ms) |

The new path costs the server more than the old legacy one in a ball (blocks, cells and cause records are worked out
for everyone), and about the same as the old packed path did (52 ms at ball 300 in the first baseline). The crowd
fallbacks (smaller focus, wider snapshot window, then a slower clock in that system only) are what keep a 300-pilot
ball inside the budget.

### Agreement (the client's tick layer against the server's ship, exactly, every snapshot)

| Case | Checks after | Disagreements before | After | Wrecks/debris off, before | After |
|---|--:|--:|--:|--:|--:|
| Spread, 100 | 24,894 | 0 | 0 | 640 / 17,236 | 3 / 6,115 |
| Spread, 300 | 19,249 | 0 | 0 | 498 / 14,078 | 0 / 3,228 |
| Ball, 50 | 79,287 | 0 | 7 | 207 / 30,629 | 27 / 29,715 |
| Ball, 100 | 136,771 | 0 | 0 | 190 / 48,877 | 30 / 47,666 |
| Ball, 300 | 367,304 | 0 | 0 | 220 / 42,881 | 23 / 42,443 |
| Boss, 20 | 17,366 | 1 | 0 | 89 / 11,769 | 10 / 11,326 |

Before, the old path had few disagreements because it keyframed almost everything (the corrections above). After, the
client works almost everything out and still agrees. Fewer checks in the spread layout is the focus grid: a client
holds a third of the ships.

### Each caps bit off in turn (ball 50 and spread 50, 8 s, the review's matrix)

Every bit off on its own leaves zero tick-layer disagreements, so each one switched off restores a working old path.
The one combination that didn't (PILOTS without CAUSES: 12 AI ticks off in ball 50) was fixed in the review: PILOTS
now needs CAUSES. What each bit is worth, ball 50 corrections per second with every cap but that one:

| Bit off | Ball 50 | Spread 50 |
|---|--:|--:|
| none (every cap) | 3.7 | 1.3 |
| OWN_SIM (and everything that needs it) | 96 | 4.6 |
| CAUSES | 98 (116 before the review's fix) | 10.1 (before the fix) |
| STRUCTS | 8.5 | 2.5 |
| CARGO | 6.2 | 1.5 |
| PILOTS | 1.0 | 0.2 |
| BLOCKS, FOCUS, WAYPOINTS, DEBRIS | 3.7 | 1.3-2.5 |

PILOTS off has fewer corrections (an AI body is re-keyed when a ship it reads is), at 1.5% (ball) to 14% (spread) more
bytes. FOCUS changes nothing in a ball (everyone is inside 19 km); in spread 50 it holds 37,861 checks' worth of ships
without it against 14,002 with it, for 6.2 against 4.0 KB/s.

## Scenario probes (one pilot, 20 s, raw bytes per second and corrections)

| Scene | Bytes before | Bytes after | Corrections before | After |
|---|--:|--:|--:|--:|
| Scrap Mother fight | 1,837 | 1,426 | 356 | 2 |
| Debris pile | 2,007 | 1,120 | 839 | 0 |
| Pirate fight (npcfight) | 640 | 417 | 55 | 1 |
| Pips | 357 | 184 | 178 | 0 |
| Gale (spark) | 856 | 633 | 587 | 0 |
| Rustjaw and escorts | – | 833 | – | 0 |
| Heavy hauler | – | 169 | – | 0 |

The debris pile also went from 5,185 ticks off without a keyframe to 0. From the stage audits: a missile barrage with
its target in view 2,168 to 657 B/s (waypoints-2026-11-04.md), mobs 1,544 to 479, a docked pilot 406 to 88 B/s with
385 corrections to 0 (Iterate round 1), the Scrap Mother's own keyframes 316 to 5 (decisions-2026-11-04.md).

## Open risks

- **Ball 50, own ship with CARGO:** one episode of 7 snapshots where a probe's own ship is off by one velocity step
  (1e-4) without a keyframe. It needs a cargo change on the same tick as a grinding contact; with CARGO off it's 0.
  Position stays equal, so the own check doesn't see it until it drifts. Not chased.
- **Ball 300 with crowd fallbacks:** 8 disagreements at one snapshot and 25.9 corrections a second, a timing-dependent
  cluster of grinding ships in the dilated system, caught by the held check, which then re-keys everything.
- **Ball 300 without the fallbacks** is 50 ms a tick on the new path. The per-client snapshot walk (phase 2 of the
  plan) is not built.
- **The first baseline's scene is not today's.** Compare with "before" in this file, not with crowd-baseline.md.

Raw results: netcode-all-2026-11-before.json, -after.json and -crowd.json (crowd bench `--out`).
