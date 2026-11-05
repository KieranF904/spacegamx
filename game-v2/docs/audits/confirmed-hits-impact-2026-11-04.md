# Confirmed hits: measured impact (2026-11-04)

Part C of docs/design/confirmed-hits.md, measured with the same probe as docs/audits/network-fixes-impact-2026-11-03.md
(a real GameServer, fake clients, the same seeded world, 20-second scenarios, 3 ticks of latency). Protocol is now
**27**. Figures are decoded payload bytes per second received by each pilot, unless marked deflated.

Each scenario ran twice on the same tree: once with no client taking confirmed hits (`CAPS=0`), once with the shooter
taking them (`CAPS=1`). The observer stayed on the old messages both times, so its column is the control: it must not
change, and it doesn't.

## Summary (the shooter)

| scenario | before part C (protocol 26) | caps off (protocol 27) | **caps on** | change vs before | deflated: before → caps on |
|---|---|---|---|---|---|
| 2 Pips, parked freighter | 835 | 843 | **639** | -23% | 793 → 598 |
| Hammerhead (12 Rattlers + 6 Pips), parked freighter | 2,905 | 3,028 | **2,362** | -19% | 1,867 → 1,569 |
| 2 Sparks + 2 Chainsaws ("Gale"), parked freighter | 3,567 | 3,706 | **2,387** | -33% | 1,667 → 1,322 |
| Fight with 5-7 pirates (Corsair) | 1,202 | 1,203 | **1,187** | -1% | 1,062 → 1,055 |
| Scrap Mother boss (Hammerhead) | 5,061 | 5,082 | **4,974** | -2% | 3,415 → 3,354 |
| Observer, in every scenario | | | unchanged (boss +8 B/s vs protocol 26) | 0% | |

"Caps off" is a little above "before": the shooter's own shell rows now carry the gun that fired them (+8 B/s Pips,
+123 B/s Hammerhead, +139 B/s Gale). Everyone pays that, capable or not; the observer gets those shells as fire events,
so it pays nothing.

## Wire estimate (shooter, with headers)

The probe counts decoded payload and a deflated total. A real WebSocket frame also pays about 66 B of headers (IP, TCP,
frame), so the wire estimate is payload + 66 x frames/s. Frames/s did not change in any scenario, so the headers are a
fixed cost, and the gain on the wire is smaller than on payload.

| scenario | frames/s | before (p26) payload / wire | caps on payload / wire | wire change | deflated wire: before → caps on |
|---|---|---|---|---|---|
| 2 Pips | 16.8 | 835 / 1,944 | 639 / 1,748 | -10% | 1,902 → 1,707 (-10%) |
| Hammerhead | 19.5 | 2,905 / 4,192 | 2,362 / 3,649 | -13% | 3,154 → 2,856 (-9%) |
| Gale | 20.0 | 3,567 / 4,887 | 2,387 / 3,707 | -24% | 2,987 → 2,642 (-12%) |
| Pirates | 20.0 | 1,202 / 2,522 | 1,187 / 2,507 | -1% | 2,382 → 2,375 (0%) |
| Scrap Mother | 21.2 | 5,061 / 6,457 | 4,974 / 6,370 | -1% | 4,811 → 4,750 (-1%) |

The headers are 1.1-1.4 KB/s of every wire figure. They are now a bigger share than the hits.

## By category (shooter, B/s)

"Hit messages" is projectileHit + damage + shells in `removed` + ignite + detonation. `shipHps` is shown apart because it
is also used for non-shell damage. "Records" is the new `hits` row plus `hpCheck`. `shells` is the shooter's own shell
rows (all shell.* rows), which grew by the gun field. Columns that did not move (own row, ships, target keyframes, mobs,
debris, header, other) are left out.

| scenario | run | shells | hit messages | shipHps | records | all part-loss rows |
|---|---|---|---|---|---|---|
| Pips | p26 | 182 | 216 | 78 | 0 | 79 |
| Pips | caps on | 190 | 3 | 10 | 78 | 11 |
| Hammerhead | p26 | 1,010 | 904 | 240 | 0 | 360 |
| Hammerhead | caps on | 1,133 | 228 | 40 | 205 | 160 |
| Gale | p26 | 932 | 1,546 | 377 | 0 | 391 |
| Gale | caps on | 1,071 | 58 | 292 | 247 | 306 |
| Pirates | p26 | 11 | 53 | 13 | 0 | 38 |
| Pirates | caps on | 11 | 34 | 5 | 10 | 30 |
| Scrap Mother | p26 | 253 | 307 | 97 | 0 | 410 |
| Scrap Mother | caps on | 273 | 171 | 68 | 54 | 381 |

The Gale's `shipHps` stays at 292 B/s because chain arcs and burns are not shell hits. Its p26 hit messages already
include the ignite (288) and detonation (416) that part A cut.

## Per landed hit

Hit traffic per landed hit = (hit messages + shipHps, or records) x 20 s / the hits the ledger counted. The fights are
seeded, so the hit count is the same with the switch off.

| scenario | hits | old way, B/hit | confirmed, B/hit | bytes per record | records/s |
|---|---|---|---|---|---|
| Pips | 184 | 32.0 | **9.9** | 7.5 | 5.7 |
| Hammerhead | 904 | 25.3 | **10.5** | 5.7 | 12.9 |
| Gale | 776 | 49.6 | **15.4** | 6.3 | 17.0 |
| Pirates | 38 | 34.7 | 25.8 | 10.7 | 0.7 |
| Scrap Mother | 255 | 31.7 | 23.0 | 5.2 | 3.9 |

The design said ~3 B a record. It is 5-8 B: a record is 3-4 integers in a JSON array, so each costs its digits plus
a comma. A bit-packed format (the separate work on the wire format) would get close to 3 B. The confirmed figure for
the Gale still carries the `shipHps` that burns and chain arcs send. In fights where many hits go the old way
(Pirates, boss) the figure sits near the old price.

## Legacy mode check (caps off)

With no capable client, players get the old messages at the same moments.

- Observer (always legacy): identical in caps off and caps on in all five scenarios (743, 2,365, 3,109, 1,240 and 3,615
  B/s; deflated 705, 1,499, 1,380, 1,099, 2,458), with the same frames/s. Against the protocol-26 run the only
  difference is the boss, +8 B/s (3,607 → 3,615, 0.2%).
- Shooter caps off against p26: Pips +8 B/s, Hammerhead +123, Gale +139, Pirates +1, boss +21. This is the gun field on
  own shell rows, the one cost a legacy player pays.
- The ledger counted 0 hits, 0 records and 0 checks in every caps-off run, so it did not run for them.
- The parity test (below) compares a capable and a legacy client message by message.

## Server and client cost

Server `stepMs` per tick, caps off → caps on (3 fake clients, one capable): Pips 0.253 → 0.266, Hammerhead 0.357 → 0.380,
Gale 0.308 → 0.342, pirates 0.310 → 0.319, boss 0.438 → 0.479. That is +0.01 to +0.04 ms a tick, from the ledger working
out each hit for each capable player. It grows with capable players x hits, so measure again in a crowded fight with many
capable players. The fake client's ms per tick, target position error, wobble and hitches are identical in both runs.

## Caveats

- One run per scenario: a seeded world, 20 s, a parked target. A few bytes per second is noise (the p26 runs were separate runs,
  so the boss shows about 10 B/s of drift between runs).
- Only the shooter is capable; the observer is the control. A fight where everyone is capable pays the ledger once per player.
- The fake client applies the records and checks HP but draws nothing. What a player sees is covered by the parity test
  and one live check on the dev server, not by these numbers.
- The wire estimate assumes 66 B a frame. Real overhead depends on the path and on whether frames coalesce.
- The Pirates and boss fights gain little: most of their hits go the old way (see the ledger), and other traffic
  (ships, mobs, target keyframes) dominates them.

## Where the bytes went (Hammerhead, shooter, B/s)

| message | caps off | caps on |
|---|---|---|
| projectileHit | 515 | 127 |
| damage | 250 | 62 |
| shipHps | 240 | 40 |
| shells in `removed` | 139 | 39 |
| `hits` records | | 196 |
| hpCheck | | 9 |
| total of these | 1,144 | 473 |

The design estimated ~1,144 → ~300 B/s for these. It came to 473 because 24% of the hits still went the old way (below).

## The ledger (records and the old way)

| scenario | hits | records | old way | why the old way | D / S / I extras | hpCheck mismatches |
|---|---|---|---|---|---|---|
| Pips | 184 | 183 | 1 | rebuilt 1 | 0 / 0 / 0 | 0 |
| Hammerhead | 904 | 687 | 217 | rebuilt 217 | 0 / 0 / 0 | 0 |
| Gale | 776 | 758 | 18 | rebuilt 18 | 0 / 0 / 0 | 0 |
| Pirates | 38 | 15 | 23 | rebuilt 23 | 0 / 0 / 0 | 0 |
| Boss | 255 | 189 | 66 | rebuilt 29, shell never seen 36, gun 1 | 12 / 0 / 0 | 0 |

- **The client's own sums were right almost every time.** `D` (the server's damage number) was needed on 12 of 1,832
  records, all in the boss fight (its stage cover and braces). No `S` (no shields in these fights) and no `I`.
- **"Rebuilt" is the main loss.** A hit on a ship that lost a part before the snapshot went out goes the old way: the
  rebuild's sync already carries the HP, so a record would count it twice. In a fight that shoots parts off quickly
  (Hammerhead, pirates) that's a quarter to a half of the hits.
- **"Shell never seen"**: a shell fired and spent between two snapshots that the client never had (its own fast
  shells point-blank, or a ship it got a keyframe for that snapshot). Mostly the boss fight.
- The Gale's `shipHps` stays high (292 B/s): its chain arcs and burns aren't shell hits, and go as before.

## Decision: what to make client-known next

No hidden input is worth sending yet: `D` showed up on under 1% of records, `S` and `I` never. The next saving is
structural, not an input:

1. **Rebuilt ships (E3).** Send the records for a ship that rebuilt in the window *before* its sync, and let the client
   apply them to the HP it had; the sync's `hpd` then corrects only what differs. That brings Hammerhead and the pirate
   fight close to the design's estimate.
2. **The gun on own rows.** 120-140 B/s in the heavy fights. Matching the pilot's own predicted shots to the server's
   ids would remove it; until then it stays.

## How to run it again

`scratchpad/net/netAuditHits.ts` (the earlier probe, with `netCaps: 1` on the server and `CAPS=0|1|all` choosing which
fake clients announce the switch) and `runhits.sh`. Copy the two .ts files into server/src/bench, run, delete them.
Results: `scratchpad/net/hits-caps0/` and `hits-caps1/`.

The parity test (`server/src/net/hits/confirmedHits.test.ts`) is the correctness side: a capable and a legacy client
in the same fight end with the same part HP after every snapshot, the same damage, fires, impacts, detonations and
removed shells, with no hpCheck mismatches. It covers Pips (parts shot off, the freighter dying), railgun pierce (two
freighters in line), railgun out of slugs (plain rounds go the old way), magma, Cinder Bloom, the Phase Cannon, a
shielded freighter, switching off and on mid-fight, and the Scrap Mother.
