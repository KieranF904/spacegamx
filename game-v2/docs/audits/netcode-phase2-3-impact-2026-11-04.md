# Netcode phase 2-3: measured impact (2026-11-04)

Client-detected hits (protocol 28, docs/design/confirmed-hits.md part D) and bit-packed frames with coalescing
(protocol 29, docs/design/packed-frames.md), measured on top of confirmed hits (part C,
docs/audits/confirmed-hits-impact-2026-11-04.md). Same method as the earlier impact audits: a real `GameServer`, fake
clients, seeded world, 20-second scenarios, 3 ticks of latency. Protocol is now **29**. Figures are bytes per second
received by the shooter, unless marked otherwise.

Each scenario ran under four configurations on the same tree, plus a fifth to split packing from coalescing:

| config | `CAPS` the shooter announces | what changes for it |
|---|---|---|
| legacy | 0 | everything off: the base format and the old hit messages |
| confirmed | 1 (`HITS`) | server says "shell s hit part p of ship t"; client derives damage, HP, fire, effects |
| + client-detected | 3 (`HITS` + `SELF_HITS`) | client finds most hits itself; a 1-byte hash rides its inputs; the server sends records only for the rest and corrects on a disagreement |
| + packed | 7 (`+ PACKED`) | frames go bit-packed (lossless); same frames per second |
| + packed + coalesced | 15 (`+ COALESCE`) | frames with nothing urgent wait up to 3 ticks to share a message |

The server allows all four bits (`netCaps: 15`). The observer (a second client in the same fight) stays legacy in
every run: it is the control.

## Method and definitions

- **payload**: decoded bytes of every WebSocket message the shooter received. **deflated**: the same through the
  server's permessage-deflate (level 4, 8 KB window, frames under 96 B left alone), as `SocketTransport` does.
- **frames/s**: WebSocket messages per second (what pays the headers). **msgs/s**: protocol messages inside them
  (snapshot, hits, damage, shipHps ...) per second. Before packing they are one frame per tick-frame with several messages
  in it; with packing and coalescing one frame can carry up to 4 ticks of messages.
- **wire** = payload + 66 x frames/s (IP + TCP + TLS + WS headers, paid per frame). **deflated wire** = deflated +
  66 x frames/s. The deflated wire is the closest to what a production player pays.
- **up (hash)**: client-to-server bytes of the hit reports (3 B each; they ride an input that goes anyway, or go alone
  after 6 input ticks). The rest of the upstream (inputs) is not driven by the probe; see Caveats.
- **hash disagree**: reports where the server's journal said the client's chain differed from the server's (a
  correction follows after two in a row). **corrections**: `hitFix` messages sent (and the hits they covered).
  **hpCheck mismatch**: the once-a-second HP backstop found the client's HP wrong.
- Scenarios: *idle*: the shooter parked far from anything. *Pips*: 2 Pips shooting a parked freighter. *Hammerhead*:
  12 Rattlers + 6 Pips shooting a parked freighter. *Gale*: 2 Sparks + 2 Chainsaws. *Pirates*: a Corsair against
  5-7 pirate ships, with new packs spawning. *Boss*: Scrap Mother against a Hammerhead. *Debris*: a Hammerhead against
  4 freighters that are forced to lose a part every 8 ticks, until they break up. *Beam*: a Heron (beam weapons)
  against a parked freighter. *Cruising* (extra): the Pips ship near a target, not firing.

## Summary: wire estimate (shooter, B/s, payload + 66 x frames/s)

| scenario | legacy | confirmed | + client-detected | + packed + coalesced | change |
|---|---|---|---|---|---|
| Idle | 923 | 923 | 923 | **608** | -34% |
| 2 Pips | 2,024 | 1,825 | 1,755 | **1,040** | -49% |
| Hammerhead | 4,420 | 3,758 | 3,591 | **1,961** | -56% |
| Gale | 5,633 | 4,318 | 4,088 | **2,280** | -60% |
| Pirates fight | 2,280 | 2,261 | 2,259 | **1,260** | -45% |
| Scrap Mother | 5,501 | 5,347 | 5,341 | **3,036** | -45% |
| Debris | 6,429 | 5,936 | 5,924 | **3,471** | -46% |
| Beam | 1,785 | 1,785 | 1,785 | **1,072** | -40% |
| Cruising | 1,046 | 1,046 | 1,046 | **646** | -38% |

The server deflates frames, so the figure that matters in production is the deflated wire. Packed frames are already
dense in bits, so deflate has less to take out of them and the gain on that basis is smaller:

| scenario | deflated wire: legacy | confirmed | + client-detected | + packed + coalesced | change |
|---|---|---|---|---|---|
| Idle | 910 | 910 | 910 | **607** | -33% |
| 2 Pips | 1,854 | 1,707 | 1,671 | **1,040** | -44% |
| Hammerhead | 3,162 | 2,855 | 2,764 | **1,926** | -39% |
| Gale | 3,260 | 2,849 | 2,870 | **2,199** | -33% |
| Pirates fight | 2,217 | 2,206 | 2,206 | **1,264** | -43% |
| Scrap Mother | 4,297 | 4,204 | 4,199 | **2,860** | -33% |
| Debris | 4,326 | 4,036 | 4,038 | **3,230** | -25% |
| Beam | 1,599 | 1,599 | 1,599 | **1,005** | -37% |
| Cruising | 1,038 | 1,038 | 1,038 | **646** | -38% |

And the payload alone (decoded / deflated), legacy -> everything on:

| scenario | payload | change | deflated payload | change |
|---|---|---|---|---|
| Idle | 326 -> 152 | -53% | 313 -> 152 | -51% |
| 2 Pips | 1,041 -> 327 | -69% | 871 -> 327 | -62% |
| Hammerhead | 3,146 -> 961 | -69% | 1,888 -> 926 | -51% |
| Gale | 4,313 -> 1,106 | -74% | 1,940 -> 1,024 | -47% |
| Pirates fight | 960 -> 567 | -41% | 897 -> 571 | -36% |
| Scrap Mother | 4,108 -> 1,980 | -52% | 2,904 -> 1,804 | -38% |
| Debris | 5,109 -> 2,286 | -55% | 3,006 -> 2,045 | -32% |
| Beam | 768 -> 422 | -45% | 583 -> 355 | -39% |
| Cruising | 360 -> 161 | -55% | 352 -> 161 | -54% |

What each stage did:

- **Confirmed hits** (as in the earlier audit): -20% to -30% of payload where shells hit and most hits can be
  recorded (Gale -30%, Hammerhead -21%, Pips -20%), -10% in debris; nothing where hits are not shell hits (Beam, idle,
  cruising) and little where most hits still go the old way (Pirates, boss: -2% and -4%).
- **Client-detected hits**: a further -0 to -8% of payload (Pips -8%, Hammerhead -7%, Gale -8%, Pirates and boss 0%).
  The saving is the records the client now finds itself; it pays 13-30 B/s upstream for the hash reports.
- **Packed frames**: the big one, -50% to -60% of payload on the fight scenarios (Pips 769 -> 334, Hammerhead
  2,314 -> 967, Gale 2,768 -> 1,109, boss 3,949 -> 1,990, debris 4,604 -> 2,287) and -52 to -54% on idle and cruising.
  Frames per second are unchanged by it.
- **Coalescing**: payload 0 to -3%, but frames/s down by a quarter to a half where little is urgent: idle 9.1 -> 6.9,
  cruising 10.4 -> 7.3, beam 15.4 -> 9.8, Pirates 20 -> 10.5; by 10-28% in the fights where the shooter's own hits are
  urgent (Pips 14.9 -> 10.8, Hammerhead 19.4 -> 15.2, Gale 20 -> 17.8, boss 21.1 -> 16.0, debris 20 -> 17.9). At 66 B
  a frame that is 145 B/s of wire (Gale, idle) to 630 B/s (Pirates): more than the payload it saves in every scenario.

## Per scenario (shooter)

Columns as defined above. The last columns are empty (`-`) for configs that do not have the feature.

#### Idle

| config | payload | deflated | frames/s | msgs/s | wire | deflated wire | up (hash) | hash disagree / reports | corrections | hpCheck mismatch |
|---|---|---|---|---|---|---|---|---|---|---|
| legacy | 326 | 313 | 9.1 | 10.3 | 923 | 910 | - | - | - | - |
| confirmed | 326 | 313 | 9.1 | 10.3 | 923 | 910 | - | - | - | 0 |
| + client-detected | 326 | 313 | 9.1 | 10.3 | 923 | 910 | - | 0 / 0 | 0 | 0 |
| + packed | 156 | 156 | 9.1 | 10.3 | 753 | 753 | - | 0 / 0 | 0 | 0 |
| + packed + coalesced | 152 | 152 | 6.9 | 10.3 | 608 | 607 | - | 0 / 0 | 0 | 0 |

#### 2 Pips

| config | payload | deflated | frames/s | msgs/s | wire | deflated wire | up (hash) | hash disagree / reports | corrections | hpCheck mismatch |
|---|---|---|---|---|---|---|---|---|---|---|
| legacy | 1,041 | 871 | 14.9 | 35.8 | 2,024 | 1,854 | - | - | - | - |
| confirmed | 838 | 720 | 14.9 | 23.9 | 1,825 | 1,707 | - | - | - | 0 |
| + client-detected | 769 | 684 | 14.9 | 18.3 | 1,755 | 1,671 | 17 | 1 / 112 | 0 | 0 |
| + packed | 334 | 334 | 14.9 | 18.3 | 1,320 | 1,321 | 17 | 1 / 112 | 0 | 0 |
| + packed + coalesced | 327 | 327 | 10.8 | 18.3 | 1,040 | 1,040 | 17 | 1 / 112 | 0 | 0 |

#### Hammerhead

| config | payload | deflated | frames/s | msgs/s | wire | deflated wire | up (hash) | hash disagree / reports | corrections | hpCheck mismatch |
|---|---|---|---|---|---|---|---|---|---|---|
| legacy | 3,146 | 1,888 | 19.3 | 97.3 | 4,420 | 3,162 | - | - | - | - |
| confirmed | 2,484 | 1,581 | 19.3 | 57.8 | 3,758 | 2,855 | - | - | - | 0 |
| + client-detected | 2,314 | 1,487 | 19.4 | 46.5 | 3,591 | 2,764 | 28 | 2 / 187 | 1 (2 hits) | 0 |
| + packed | 967 | 950 | 19.4 | 46.5 | 2,244 | 2,227 | 28 | 2 / 187 | 1 (2 hits) | 0 |
| + packed + coalesced | 961 | 926 | 15.2 | 46.5 | 1,961 | 1,926 | 28 | 2 / 188 | 1 (2 hits) | 0 |

#### Gale

| config | payload | deflated | frames/s | msgs/s | wire | deflated wire | up (hash) | hash disagree / reports | corrections | hpCheck mismatch |
|---|---|---|---|---|---|---|---|---|---|---|
| legacy | 4,313 | 1,940 | 20 | 162 | 5,633 | 3,260 | - | - | - | - |
| confirmed | 2,998 | 1,529 | 20 | 59.5 | 4,318 | 2,849 | - | - | - | 0 |
| + client-detected | 2,768 | 1,550 | 20 | 42.9 | 4,088 | 2,870 | 30 | 4 / 198 | 2 (8 hits) | 0 |
| + packed | 1,109 | 1,081 | 20 | 42.9 | 2,429 | 2,401 | 30 | 4 / 198 | 2 (8 hits) | 0 |
| + packed + coalesced | 1,106 | 1,024 | 17.8 | 42.9 | 2,280 | 2,199 | 30 | 4 / 198 | 2 (8 hits) | 0 |

#### Pirates fight

| config | payload | deflated | frames/s | msgs/s | wire | deflated wire | up (hash) | hash disagree / reports | corrections | hpCheck mismatch |
|---|---|---|---|---|---|---|---|---|---|---|
| legacy | 960 | 897 | 20 | 28.9 | 2,280 | 2,217 | - | - | - | - |
| confirmed | 941 | 886 | 20 | 27.6 | 2,261 | 2,206 | - | - | - | 0 |
| + client-detected | 939 | 886 | 20 | 27.5 | 2,259 | 2,206 | 2 | 0 / 13 | 0 | 0 |
| + packed | 582 | 584 | 20 | 27.5 | 1,902 | 1,904 | 2 | 0 / 13 | 0 | 0 |
| + packed + coalesced | 567 | 571 | 10.5 | 27.6 | 1,260 | 1,264 | 2 | 0 / 13 | 0 | 0 |

#### Scrap Mother boss

| config | payload | deflated | frames/s | msgs/s | wire | deflated wire | up (hash) | hash disagree / reports | corrections | hpCheck mismatch |
|---|---|---|---|---|---|---|---|---|---|---|
| legacy | 4,108 | 2,904 | 21.1 | 65 | 5,501 | 4,297 | - | - | - | - |
| confirmed | 3,954 | 2,811 | 21.1 | 56.2 | 5,347 | 4,204 | - | - | - | 0 |
| + client-detected | 3,949 | 2,806 | 21.1 | 55.8 | 5,341 | 4,199 | 13 | 0 / 89 | 0 | 0 |
| + packed | 1,990 | 1,828 | 21.1 | 55.8 | 3,382 | 3,221 | 13 | 0 / 89 | 0 | 0 |
| + packed + coalesced | 1,980 | 1,804 | 16 | 55.8 | 3,036 | 2,860 | 13 | 0 / 89 | 0 | 0 |

#### Debris

| config | payload | deflated | frames/s | msgs/s | wire | deflated wire | up (hash) | hash disagree / reports | corrections | hpCheck mismatch |
|---|---|---|---|---|---|---|---|---|---|---|
| legacy | 5,109 | 3,006 | 20 | 129.2 | 6,429 | 4,326 | - | - | - | - |
| confirmed | 4,616 | 2,716 | 20 | 99 | 5,936 | 4,036 | - | - | - | 0 |
| + client-detected | 4,604 | 2,718 | 20 | 93.3 | 5,924 | 4,038 | 28 | 26 / 177 | 13 (61 hits) | 3 |
| + packed | 2,287 | 2,049 | 20 | 93.3 | 3,607 | 3,369 | 28 | 26 / 177 | 13 (61 hits) | 3 |
| + packed + coalesced | 2,286 | 2,045 | 17.9 | 93.3 | 3,471 | 3,230 | 28 | 28 / 176 | 14 (67 hits) | 3 |

#### Beam

| config | payload | deflated | frames/s | msgs/s | wire | deflated wire | up (hash) | hash disagree / reports | corrections | hpCheck mismatch |
|---|---|---|---|---|---|---|---|---|---|---|
| legacy | 768 | 583 | 15.4 | 25 | 1,785 | 1,599 | - | - | - | - |
| confirmed | 768 | 583 | 15.4 | 25 | 1,785 | 1,599 | - | - | - | 0 |
| + client-detected | 768 | 583 | 15.4 | 25 | 1,785 | 1,599 | - | 0 / 0 | 0 | 0 |
| + packed | 430 | 361 | 15.4 | 25 | 1,447 | 1,377 | - | 0 / 0 | 0 | 0 |
| + packed + coalesced | 422 | 355 | 9.8 | 25 | 1,072 | 1,005 | - | 0 / 0 | 0 | 0 |

#### Cruising (extra)

| config | payload | deflated | frames/s | msgs/s | wire | deflated wire | up (hash) | hash disagree / reports | corrections | hpCheck mismatch |
|---|---|---|---|---|---|---|---|---|---|---|
| legacy | 360 | 352 | 10.4 | 11.2 | 1,046 | 1,038 | - | - | - | - |
| confirmed | 360 | 352 | 10.4 | 11.2 | 1,046 | 1,038 | - | - | - | 0 |
| + client-detected | 360 | 352 | 10.4 | 11.2 | 1,046 | 1,038 | - | 0 / 0 | 0 | 0 |
| + packed | 167 | 166 | 10.4 | 11.2 | 853 | 852 | - | 0 / 0 | 0 | 0 |
| + packed + coalesced | 161 | 161 | 7.3 | 11.2 | 646 | 646 | - | 0 / 0 | 0 | 0 |

Packing changes bytes, not messages: msgs/s is the same with packing on and off (the probe counts protocol messages
through the encoder), and the same message sequence decodes on the other side. Msgs/s fall at the confirmed and
client-detected steps because those stop sending `projectileHit`, `damage`, `ignite`, `detonation` and removals (Gale
162 -> 59.5 -> 42.9).

## The observer (legacy, the control)

The observer's column is identical in all five configurations, in every scenario (payload, deflated, frames/s, msgs/s
and wire all compared). A second full run of caps 0, 3 and 15 reproduced every figure above to the byte (the world and
the pilots are seeded), so the differences between configurations are not noise.

| scenario | payload | deflated | frames/s | msgs/s | wire | same in all configs |
|---|---|---|---|---|---|---|
| Idle | 322 | 309 | 8.8 | 10.1 | 902 | yes |
| 2 Pips | 941 | 780 | 14.8 | 35.6 | 1,918 | yes |
| Hammerhead | 2,488 | 1,502 | 19.2 | 97.2 | 3,755 | yes |
| Gale | 3,717 | 1,644 | 20 | 162 | 5,037 | yes |
| Pirates fight | 1,000 | 926 | 20 | 28.9 | 2,320 | yes |
| Scrap Mother | 2,553 | 1,594 | 9.4 | 38.8 | 3,173 | yes |
| Debris | 4,651 | 2,598 | 20 | 129.2 | 5,971 | yes |
| Beam | 666 | 548 | 14.1 | 22.9 | 1,593 | yes |
| Cruising | 356 | 348 | 10.3 | 11 | 1,032 | yes |

A legacy client pays no more in a room with capable clients than in one without.

## Hash mismatches and corrections (client-detected hits)

Counted over the 20-second window, with everything on. A report is the client's hash going up on an input; a
disagreement is the server's journal seeing a different chain than the client's. A 1-byte hash misses one real
difference in 256 (the next report catches it), and a lone disagreement costs nothing: a correction goes out only
after two in a row.

| scenario | hits | records (told) | found by the client | reports | disagreements | per 100 reports | per 100 hits | corrections (hits covered) | hpCheck mismatches |
|---|---|---|---|---|---|---|---|---|---|
| 2 Pips | 160 | 159 | 158 | 112 | 1 | 0.9 | 0.6 | 0 | 0 |
| Hammerhead | 793 | 592 | 538 | 188 | 2 | 1.1 | 0.3 | 1 (2) | 0 |
| Gale | 694 | 676 | 672 | 198 | 4 | 2.0 | 0.6 | 2 (8) | 0 |
| Pirates fight | 51 | 19 | 6 | 13 | 0 | 0 | 0 | 0 | 0 |
| Scrap Mother | 216 | 150 | 17 | 89 | 0 | 0 | 0 | 0 | 0 |
| **Debris** | 803 | 447 | 323 | 176 | **28** | **15.9** | **3.5** | **14 (67)** | **3** |
| Idle, Beam, Cruising | 0 | | | | | | | | |

(*records* is the server's ledger count of hits it sent as records; the rest of the hits went the old way, mostly
because the target ship had rebuilt or the client never had the shell. *Found* is the client's own count of the hits it
found; the pirates and boss fights have few, since most of their hits are ones the client cannot find.)

- The shell-fight rates match part D's table (0.3-0.6 disagreements per 100 hits; the boss 0).
- **Debris is the weak case**: 16 of 100 reports disagree, 14 corrections went out covering 67 hits, the client took
  back 24 hits it had wrongly found and was missing 9 more, and the HP backstop (`hpCheck`) caught the client's HP wrong
  three times in 20 checks (each answered by a resync). With only confirmed hits (caps 1) the same fight had 0
  mismatches, so client-detected hits cost accuracy here. The cause was not investigated; the likely one is the scenario
  itself: a ship losing a part every 8 ticks and shedding debris, with the server telling the client about hits on
  ships that had just rebuilt, were keyframed or were debris (the ledger's reasons: debris 186, synced 141, keyframed
  103). The corrections and the backstop did their job, but this is the case to look at first: the left-over item
  "find hits on a rebuilt ship using the shape it had before" is the likely fix.
- Packing and coalescing do not change any of these (the rows are identical between caps 3, 7 and 15 apart from one
  more disagreement and one more correction in debris when coalescing shifted the timing by a tick or two).
- No correction in any other scenario, and 0 hpCheck mismatches outside debris.

## Server and client cost

Server `stepMs` per tick (one capable shooter plus the legacy observer), and the fake client's ms per tick:

| scenario | legacy | confirmed | + client-detected | + packed | + coalesced | client ms/tick, legacy -> full |
|---|---|---|---|---|---|---|
| Idle | 0.185 | 0.191 | 0.195 | 0.203 | 0.200 | 0.003 -> 0.005 |
| 2 Pips | 0.233 | 0.247 | 0.249 | 0.254 | 0.259 | 0.005 -> 0.029 |
| Hammerhead | 0.299 | 0.322 | 0.311 | 0.330 | 0.324 | 0.028 -> 0.066 |
| Gale | 0.272 | 0.291 | 0.297 | 0.339 | 0.311 | 0.012 -> 0.051 |
| Pirates fight | 0.263 | 0.274 | 0.291 | 0.299 | 0.291 | 0.010 -> 0.034 |
| Scrap Mother | 0.447 | 0.450 | 0.446 | 0.458 | 0.467 | 0.085 -> 0.113 |
| Debris | 0.426 | 0.468 | 0.459 | 0.488 | 0.472 | 0.069 -> 0.118 |
| Beam | 0.242 | 0.244 | 0.251 | 0.255 | 0.251 | 0.015 -> 0.018 |
| Cruising | 0.196 | 0.188 | 0.190 | 0.212 | 0.202 | 0.003 -> 0.005 |

Everything on costs the server 0.01-0.05 ms a tick with one capable client (3-15% on a 0.2-0.45 ms tick); the packed
encoder runs once per capable connection, so this grows with capable players, as the hit ledger does. Single runs, one
machine at moderate load: differences of a few hundredths of a ms are noise. The client numbers are the fake client's
(it applies and checks but draws nothing); the added client work is mostly the hit finder (SelfHits) and the packed
reader.

## Where the remaining bytes go

Everything on (caps 15), shooter, B/s of payload, from the encoder itself (bits written per section of each packed
snapshot and per message type). "Framing" is the packed frame header, end codes and padding (2-4 B a frame); the
residual is whatever the sections do not account for.

| scenario | payload | snapshot head | ship rows | shell rows | removed | keyframes | control rows | hit records | hit/damage msgs | part loss + sync | other | framing |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Idle | 152 | 28 | 17 | 0 | 0 | 44 | 30 | 0 | 1 | 4 | 14 | 15 |
| 2 Pips | 327 | 43 | 17 | 76 | 0 | 105 | 32 | 5 | 9 | 5 | 11 | 25 |
| Hammerhead | 961 | 53 | 20 | 435 | 7 | 151 | 38 | 20 | 103 | 86 | 14 | 34 |
| Gale | 1,106 | 55 | 31 | 437 | 0 | 353 | 23 | 11 | 130 | 9 | 19 | 38 |
| Pirates fight | 567 | 55 | 56 | 11 | 1 | 18 | 328 | 4 | 21 | 23 | 25 | 26 |
| Scrap Mother | 1,980 | 55 | 705 | 155 | 7 | 425 | 128 | 32 | 116 | 220 | 102 | 35 |
| Debris | 2,286 | 55 | 61 | 392 | 14 | 571 | 38 | 86 | 241 | 775 | 16 | 38 |
| Beam | 422 | 35 | 71 | 0 | 0 | 55 | 46 | 0 | 45 | 124 | 22 | 24 |
| Cruising | 161 | 31 | 17 | 0 | 0 | 48 | 34 | 0 | 1 | 2 | 11 | 16 |

("hit records" = `hits` + `hitFix` + `hpCheck`; "hit/damage msgs" = `shipHps`, `damage`, `projectileHit`,
`detonation`; "part loss + sync" = `partDestroyed`, `shipSync`, `debrisSplit`; "other" = contact, toasts, boss
telegraphs, effects, fire events, player state. Each row is one extra run with the section counters on: its payload
matches the main run to the byte.)

And the headers, which the table above leaves out. With 66 B a frame, the share of the wire estimate that is headers:

| scenario | idle | Pips | Hammerhead | Gale | Pirates | boss | debris | beam | cruising |
|---|---|---|---|---|---|---|---|---|---|
| headers B/s | 455 | 713 | 1,003 | 1,175 | 693 | 1,056 | 1,181 | 647 | 482 |
| share of wire | 75% | 69% | 51% | 52% | 55% | 35% | 34% | 61% | 75% |

Reading it:

1. **Headers now cost more than the payload** in seven of the nine scenarios (all but the boss and debris): 450-1,200
   B/s of headers against a payload of 150-1,100 B/s. Hits, damage and packing are no longer where the money is; the
   number of frames is. Two levers: the shooter's own-hit urgency (Hammerhead: 297 of its 304 messages went early; Gale
   and debris: every one) and the 3-tick window (a 6-tick window measured better for idle clients, at 50 ms more delay).
2. **Shell rows are 40-45% of a heavy shooter's payload** (Hammerhead 435, Gale 437 B/s): the shooter's own shell rows
   (rounded spawn and velocity) that the client cannot yet derive exactly. This is the "make the client's own shells
   exact" item; the same item removes most of the remaining disagreements.
3. **Keyframes** are the next block: 150-570 B/s in a fight (Gale 353, debris 571, boss 425), and 44-48 B/s when
   nothing is happening (idle, cruising), from ships the server shadow disagrees with and from first sight of a ship.
   Keyframe values are lossless today (velocities at 1e-4, angles at 1e-5), which is finer than the client needs
   (the "lossy fields" item in docs/design/packed-frames.md).
4. **Control rows** dominate the pirates fight (328 of 567 B/s): the AI ships' stepwise controls, many ships each
   changing controls often. Idle and cruising pay 30 B/s of them for the same reason.
5. **Part loss and rebuilds** dominate debris (775 of 2,286 B/s, of which `shipSync` is 600) and are 220 of the boss
   fight and 124 of the beam (`shipSync` 116). The syncs after a part loss are a candidate for deriving on the client from
   the part loss it was told of (not designed yet).
6. **Boss ship rows** (705 B/s, 36% of its payload) are the largest block of that fight: the boss's own rows and what
   it spawns (not split further). The boss is keyframed nearly every snapshot (keyframes 425 B/s more), and
   "replicate boss motion" is the item that targets both.
7. **Hits themselves** are small now: records 5-86 B/s (debris the high end); with the damage and impact messages,
   up to 240 B/s. What remains of `shipHps`/`damage`/`projectileHit` is the hits the client cannot find (rebuilt ships,
   chain arcs, burns, beams) and the old-way fallbacks.
8. **Idle floor**: 152 B/s payload (head 28, keyframes 44, control rows 30, ship rows 17), at 6.9 frames/s. Per player
   in a quiet system that is 150 B/s of payload and 450 B/s of headers.

## Caveats

- One run per configuration and scenario: a seeded world, 20 s, parked targets (a moving target and a crowd of capable
  shooters are not measured). The re-run of three configurations reproduced every figure, which shows determinism, not
  coverage.
- **Upstream is not measured.** The probe drives the shooter's controls directly, so the client-to-server inputs (11-14
  B each, only on change, each paying its own 66 B of headers) are not in these figures; only the hash reports are. In
  a real session upstream may be a large part of the headers a player pays.
- **Absolute figures differ from the earlier audits** (docs/audits/confirmed-hits-impact-2026-11-04.md has Pips at 639
  for confirmed hits and 843 off; here 838 and 1,041). This probe has a different client (the fake hits client used by
  the tests), a different pilot timing and no third far client; running the old probe on this tree today still gives
  843 for Pips with everything off. The two sets are consistent inside themselves; compare columns within this
  document. Part D's table (Pips 838 -> 769, Hammerhead 2,484 -> 2,314, Gale 2,998 -> 2,768, boss 3,954 -> 3,949) and the
  packed-frames table match this probe exactly.
- The deflated figures use the same deflater settings as the server on a per-frame basis (a sync flush after each
  frame); a real connection's window carries across frames the same way, so it should agree, but it has not been
  checked against a live socket.
- The 66 B header figure assumes one TCP segment per frame and no coalescing by the network path.
- The beam scenario's damage is not a shell hit, so none of the hit work applies to it; its gain is all packing.
- The fake client applies and checks hits but draws nothing. What a player sees is covered by the parity tests
  (server/src/net/hits/confirmedHits.test.ts, server/src/net/snapshot/packedFrames.test.ts) and not by these numbers.

## How to run it again

The probe is `net/phase23/netAuditPhase.ts` in the session scratchpad (a copy of the packed-frames probe with the extra
scenarios idle, Pirates, debris and beam, a protocol-message counter, and an optional section breakdown with `BREAK=1`),
driven by `net/phase23/run.sh` (`CAPSLIST="0 1 3 7 15"`, `SCEN=...`, `TAG=...`). It copies the probe into
`server/src/bench` as `zzNetAuditPhase.ts`, runs each scenario with `tsx`, and deletes the copy; a run of all nine
scenarios in five configurations takes about three minutes. Results: `net/phase23/out/` (the main set),
`out_2/` (the repeat) and `out_brk/` (the section breakdown), tables generated by `net/phase23/gen.cjs`.
