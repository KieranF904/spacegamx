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
| Observer, in every scenario | | | unchanged | 0% | |

"Caps off" is a little above "before": the shooter's own shell rows now carry the gun that fired them (+8 B/s Pips,
+123 B/s Hammerhead, +139 B/s Gale). Everyone pays that, capable or not; the observer gets those shells as fire events,
so it pays nothing.

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
