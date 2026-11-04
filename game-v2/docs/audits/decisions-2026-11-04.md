# Decisions stage: the enemy AI's pilots, and the boss bodies' gap (2026-11-04)

Built: decision-inputs build stage 7 (the regular AI as commander + shared pilot body, `CAPS.PILOTS` 8192), which also
flies every boss without a brain (docs/design/decision-inputs.md 6.4's flight). Not built: stages 3-6 and 8 (novas,
blinks and phases as decisions; the Scrap Mother's moves; Pyreclast; moves as explicit steps; mob LAUNCH). See
decision-inputs.md section 12.

## The boss bodies' gap (-6..-8% measured vs -26% designed): closed

The stage-2 probe measured bodies alone. Of the Scrap Mother's 194 keyframes left with bodies on, 188 were her bodied
shadow leaving her ship for contacts with the pilot's hull and her sheds' recentring, 35 more the target's replica being
off (`targetKeyed`). The Effects stage (`CAPS.CAUSES`) made contacts and rebuild recentring causes on the tick layer, so
the bodied shadow now follows her through them. Re-measured on today's tree (the session scratchpad's
`net/decide/probe.ts`, the effects/waypoints probe with every cap, a Hammerhead against the Scrap Mother 20 s, 3 ticks
each way, the shooter's bytes):

| | caps 7935 (all but BODIES) | caps 8191 (with BODIES) | |
|---|--:|--:|--:|
| payload B/s | 1,958 | 1,457 | -25.6% |
| wire B/s (payload + 66 a message) | 2,836 | 2,319 | -18.2% |
| keyframes of her it already held (20 s) | 316 | 5 | |
| her body checks (off) | | 40 (0) | |

Payload is at the design's -26%. Wire is at -18% because the message count didn't fall (13.1 a second; 134 urgent in
20 s: 93 own-row corrections, 38 telegraphs): the design's wire figure assumed stage 4 (telegraphs from the body, never
urgent; pulls predicted). That is the remaining gap, and it is stage 4's.

## The enemy AI's pilots

Probe npcfight (two pirate packs and top-ups against the pilot, 20 s), the shooter's bytes:

| | caps 8191 | caps 16383 (PILOTS) | |
|---|--:|--:|--:|
| payload B/s | 1,069 | 763 | -29% |
| wire B/s | 1,749 | 1,433 | -18% |
| decisions | | 149 in 20 s (74 rows to the shooter) | |
| body checks (off) | | 40 (0) | |
| corrections a second | 0.05 | 0.2 | |

(The 8191 figure is higher than the Effects-stage baseline, 734, because the AI's behaviour moved on purpose: seeded aim
error, quantised orders; the fight plays out differently. Both columns are the same new scene.)
Rustjaw (AI-flown boss): 856 -> 817 B/s (-4.5%), 39 checks agreeing.

Crowd bench (`npm run bench:crowd -- --case <c> --caps <c> --bulk blocks`, probes' raw B/s, 10 s):

| case | caps 8191 | caps 16383 | AI disagreements (16383) | corrections/s per probe |
|---|--:|--:|--:|--|
| ball 50 | 18,573 | 18,300 (-1.5%) | 0 of 13,500 | 6.75 -> 9.75 |
| spread 100 | 4,301 | 3,805 (-11.5%) | 1 of 6,781 | 0.48 -> 2.75 |
| boss 20 | 9,325 | 9,305 | 0 of 2,720 | 3.9 -> 3.9 |

Tick time is unchanged (ball 50: 3.98 -> 4.02 ms).

Decision rate: aim error re-rolled at every think was 257 of 318 decisions in the parity test; seeded from the order it
fell to 92 (4 ships, 20 s).

## Fixed along the way

- An own keyframe decided inside `Replication.forClient` (a contact with a ship the client lacked) came after BodyNet's
  target re-key: a boss reading the own ship was one tick off at that snapshot (Hushwing test). `BodyNet.readersOf` +
  `Replication.keyNow` key it.
- In a crowd, a pack mate shot down left the client's pilot blind for the ticks it still read it (its replica removed
  with the snapshot): 70 AI disagreements in ball 50. BodyNet keeps what each body stopped reading and keys the reader
  when that ship is gone or not held.

## Known gaps

- Corrections per probe rise in crowds (re-keys of pilots whose target or mate was keyed): ball 9.75/s against 6.75.
- One AI tick off in spread 100 (no keyframe), not yet chased.
- An attempt to re-step bodies from the earliest tick any ship's path changed (late control rows) made things worse
  (stale history before the window); reverted.
- AI ships fighting a pilotless target (wards, siege prey) and siege turrets/roles, station defence and traffic stay on
  rows (stage 7's second half).
