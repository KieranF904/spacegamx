# Bosses' and custom enemies' moves on both sides (2026-11-05)

Decision-inputs stage 4 (docs/design/decision-inputs.md section 13, `CAPS.MOVES` 1048576). The bar (Kieran): a boss
fight costs her decisions (move, arg, seed), the pilots' inputs and control rows, and corrections only when a pilot's own
check fails. Deterministic things send no per-shot or per-hit records.

Before this, every boss and custom-enemy move ran as a server generator and sent what it did: `bossTelegraph`,
`bossBeam`, the window's opening, strike `detonation`s, launch flashes, and each straight shell as a projectile row
(and its removal). Now the moves live in common (common/src/bodies/moves/) and run on a capable client's tick layer
from their decisions; none of that is sent to it.

## What moved into common

| module | what | from |
|---|---|---|
| bodies/moves/host.ts | `MoveHost`: what a move reads (the tick, its pose before its step, a pilot's as the flight reads it, its structure, rock) and does (`fx`, `shoot`, `cap`; `work` the server's alone: damage, pulls, homing shells, mobs, a hit's own messages); `moveRng`, `moveShotSeed`, `densityCap`, `PART_STATE` | new |
| bodies/moves/staged.ts | `StagedMoves`: hold, dart, mark, land, beam, cut, glow, launch flash, parts read at the tick, personal attacks | server brains/staged.ts |
| bodies/moves/scrapMother.ts | all nine moves, harassing shots, personal attacks (rivets, mites, sludge, seeker, mark), rivets/pools/pots | server brains/scrapMother.ts |
| bodies/moves/pyreclast.ts | all ten moves, harassing sparks, personal attacks (lob, ember, flak, synapse, spark, mark), swelling/glints/pools | server brains/pyreclast.ts |
| bodies/moves/custom.ts | the custom roster's picks, steps, guns between moves (now on a grid: `gunDue`) and losses, `aheadOf` | server game/custom/moves.ts, kit.ts (deleted) |
| bodies/moves/track.ts | `StagedTrack`, `CustomTrack`: a client's tick in the server's order | new |

The brains keep the brain: the loop and its picks, rests, windows, personal rolls, harass timing, the stages'
blow-aways and deaths, the Mother's density cap over the pilots near, the Pyreclast's vents' heat and their lock.

New decisions (only to a client with the cap): MOVE [move, seed, rage], HARASS [target + 1], CAP [k, mask], WINDOW
[ticks, cap], HOLD [mode], PART [part, state], GONE [bits]; PERSONAL now carries [slot, attack, seed, target + 1, name].
`npm run wire:bump` found no wire change (the ops ride the existing decision rows), so the protocol stays 53.

## Behaviour that moved on purpose

- A move's rolls come from its MOVE's seed, not the server's stream (a dart's side, spiral, shrapnel turn, dash flips,
  lance swing, ring turn, swarm start).
- A move's straight shell is seeded by owner, tick and place in the tick (its spread the same on both sides).
- Custom enemies' guns between moves fire on a grid (`(tick + id × 7) % every`) instead of a timer: the same rate, the
  first shot up to one interval later. This moved the custom fights a little (custom A's pulls and contacts below).
- A staged boss's home for its moves is its body's (rounded to whole units).

## How it was measured

The boss-bytes probe (the session's `br/zzProbe.god.ts`, as the pacing round ran it), copied into server/src/bench
while it ran and not committed: a real GameServer, `Math.random` seeded, 3 s warm-up, 20 s measured, 3 ticks of
latency each way, both probe pilots in god mode. Pilot A is a `FakeHitsClient` with every cap; B a legacy observer.
Every number is A's download. This round the probe's server allows every cap (`NETCAPS` 2097151: the earlier runs'
server allowed only 262143, so LAUNCHES and NOSE were off). **Before** is `refactor/split` at 024c944 exported with
`git archive`, A with caps 1048575 (all but MOVES); **after** is this branch, caps 2097151. Wire adds 66 B per WebSocket
message. The scenes are seeded and repeat exactly.

## The headline (A's download, B/s)

| scenario | payload before | after | change | WS msgs/s before | after | wire before | after | change | deflated before | after |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| Scrap Mother | 787 | 671 | -15% | 11.1 | 10.2 | 1517 | 1345 | -11% | 698 | 587 |
| Pyreclast | 769 | 644 | -16% | 10.8 | 10.2 | 1482 | 1317 | -11% | 642 | 558 |
| Brood Mother (no moves yet) | 547 | 547 | 0% | 10.1 | 10.1 | 1213 | 1213 | 0% | 493 | 493 |
| Rustjaw (AI-flown, no moves) | 672 | 672 | 0% | 9.6 | 9.6 | 1306 | 1306 | 0% | 581 | 581 |
| Custom enemies A | 544 | 524 | -4% | 10.3 | 10.7 | 1220 | 1227 | +1% | 513 | 486 |
| Custom enemies B | 686 | 594 | -13% | 11.1 | 10.0 | 1416 | 1254 | -11% | 649 | 561 |

Custom A: its moves' bytes all went (66 B/s below), but its fight moved with the guns' grid: the Hookboat's tethers
and the contacts round them rose (causes 53 → 76 B/s, the other pilot's control rows 77 → 90), so the total fell only
4% and the wire rose 1% (0.4 more messages a second).

Corrections and disagreements, after as before, in every scenario: no hit corrections (`hitFix` 0), no hit-chain
mismatches, no own-ship check off (`ownCmp.off` 0), no tick-layer drift without a keyframe (`winOffNoKf`,
`snapOffNoKf` 0), no correction keyframes (`corrKf` 0; custom B 8 before and after, the pre-existing pack contacts).
Upload unchanged (4.3 KB/s wire, the probe sends on every aim change).

## The categories that moved (A's payload, B/s)

| category | Mother before | after | Pyreclast before | after | Brood before | after | Rustjaw before | after | Custom A before | after | Custom B before | after |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| move shells as rows | 45.9 | 10.8 | 58.5 | 3.1 | 0 | 0 | 11.7 | 11.7 | 42.3 | 0 | 19.4 | 0 |
| removals | 3.9 | 1.8 | 3.6 | 1.3 | 0.4 | 0.4 | 14.8 | 14.8 | 2.7 | 0 | 2.6 | 0.8 |
| bossTelegraph | 44.6 | 5.7 | 39.8 | 4.5 | 0 | 0 | 0 | 0 | 14.0 | 0 | 52.6 | 0 |
| bossBeam | 4.0 | 0 | 3.3 | 0 | 0 | 0 | 0 | 0 | 5.2 | 0 | 0 | 0 |
| bossWindow | 5.1 | 2.5 | 5.1 | 2.5 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| detonation | 3.8 | 0 | 18.8 | 18.9 | 0 | 0 | 3.1 | 3.1 | 0.8 | 0 | 15.0 | 10.1 |
| effect (launch flashes) | 0 | 0 | 0.8 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 11.0 | 0 |
| decisions | 15.1 | 16.9 | 17.5 | 15.7 | 13.4 | 13.4 | 14.6 | 14.6 | 35.5 | 31.9 | 44.3 | 44.8 |
| projectileHit | 1.0 | 4.5 | 4.6 | 6.5 | 0 | 0 | 3.0 | 3.0 | 10.5 | 9.7 | 5.4 | 5.9 |

Decisions held flat: the new MOVE, HARASS, PART, CAP, WINDOW and HOLD records cost about as much as the seeds and
rolls that moved out of other rows (the Mother +1.8 B/s, the Pyreclast -1.8). `projectileHit` rose a little (Mother
+3.5): a move shell's hit is told the old way, and a shell the client made isn't one the packed encoder can end
implicitly. Brood Mother and Rustjaw have no moves, so they are the control (byte for byte the same).

## What is left, and why (named exceptions)

| what | where (after, B/s) | why it stays |
|---|---|---|
| A personal attack or harassing shot at another pilot: its tells and shells | Mother telegraphs 5.7 and rows 10.8, Pyreclast 4.5 and 3.1 (B is in the fight) | the pilot it's at works it out; another client would need that pilot's exact replica at the tick, which it may not hold. Its own are worked out |
| A move under way when a client began running the body | a move's worth at each sync | sat out: the server sends it the old way (BodyNet.derives: the decision after the sync) |
| The window's meter (fills, crack) and its close | 2.5 | its fill is damage taken, the server's; its opening is worked out (WINDOW) |
| Homing seekers (the Mother's seekers, the Pyreclast's swarm, a lone seeker) | in the rows above, or guide rows | their guides are the waypoint law's (CAPS.WAYPOINTS) |
| Mobs (mites, ember drones, Rivet Sower mines) | | their LAUNCH and guide rows |
| Hits of move shells | `projectileHit`, `damage`, `shipHps` | the shells carry no gun for `derive`; the hit is the server's, told; a told hit takes the nearest made shell with it |
| Strike, beam, burn and pull damage; magma splash and its look | Pyreclast detonation 18.9 (the magma shells' splash on hitting), custom B 10.1 | damage is the server's; those detonations are a shell's hit, not a move's |
| A crane's or a harpoon's strike flash; a piece's burst when shot off (Sower panniers, Darter pod) | | the hit's |
| Stage blow-aways' and death's booms, `bossBlow` | | the brain's schedule; `STAGE`/`DIE` with seeds would close it |
| The Pyreclast's stage-two vent glow | 2 messages per 10 s | its own timer since the fight began |
| Who is near for the density cap | CAP decisions when it drops a shot | the server holds every pilot |
| Part damage | PART and GONE decisions | the server's; a move reads its parts as they were on the tick |

## Correctness (the test)

server/src/net/decisions/moves.test.ts: a capable pilot (every cap) and a legacy observer in the same fight. Every
`bossTelegraph` and `bossBeam` the observer was sent is, field for field, one the pilot was sent or worked out, and
nothing the pilot worked out never was; every straight shell it made is one the server spawned, at the same tick,
place and velocity, and the server left out exactly the rows of those. Scrap Mother through her three stages (49 looks
worked out, 10 sent; 132 shells made), the Pyreclast through its three (64 and 11; 137 shells), custom enemies (96
worked out, none sent). Body checks all agree. One thing the first run caught: after the dev shed jumps a stage, the
recentring of the boss reaches the client with its keyframe, so a move on the very next tick read her where she was;
the test holds her a second after the shed (in a real fight her blow-away holds her for longer).
