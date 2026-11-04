# Focus grid: before and after on the crowd bench (2026-11-04)

What changed: `CAPS.FOCUS` (1024, protocol 38; docs/design/awareness-model.md section 0, docs/areas/networking.md "The
focus grid"). A capable client holds the ships homed in the 8,192-unit cells within 19 km of its ship (flat), not
everything within 40 km; the ring out to 35 km comes as map-dot ghosts; a dropped cell is kept 10 s and, back in focus,
fast-forwarded from a log when its hash agrees and the log is smaller than an entry.

Runs: `npm run bench:crowd -- --n 50,100 --layouts spread,ball,cruise --secs 10`, before with `--caps 511 --bulk blocks`,
after with `--caps 2047 --bulk focus` (the 4 probes and every bulk socket holding cells; bulk sockets never answer an
offer, so their re-entries time out and enter as new). `cruise` is new: pilots on a 12 km grid flying out and back along
24 km legs. Same seed and scene both runs.

| case | tick ms before / after | snap ms before / after | capable raw B/s before / after | bulk raw B/s before / after | ships held by a probe before / after | disagreements (tick layer) |
|---|--:|--:|--:|--:|--:|--:|
| spread 50 | 2.73 / 2.58 | 0.97 / 0.94 | 6,666 / 4,080 (-39%) | 6,691 / 4,151 | 71.6 / 26.7 | 1 / 1 |
| spread 100 | 5.23 / 4.72 | 2.23 / 1.95 | 7,351 / 3,928 (-47%) | 7,729 / 4,304 | 76.9 / 26.0 | 0 / 0 |
| ball 50 | 3.95 / 4.23 | 1.45 / 1.75 | 20,060 / 21,402 (+7%) | 22,470 / 22,492 | 91.5 / 88.5 | 0 / 0 |
| ball 100 | 7.75 / 8.24 | 3.33 / 3.82 | 29,947 / 31,291 (+4%) | 32,269 / 32,291 | 157.8 / 156.9 | 0 / 0 |
| cruise 50 | 1.52 / 1.51 | 0.49 / 0.54 | 4,961 / 2,340 (-53%) | 4,909 / 2,227 | 40.4 / 15.9 | 0 / 0 |
| cruise 100 | 2.46 / 2.40 | 1.04 / 1.04 | 5,877 / 2,038 (-65%) | 6,120 / 2,341 | 39.4 / 12.5 | 0 / 0 |

Churn (server, every capable client, per second): spread 100 4.7 drops, 8.4 entries, 1.2 offers; cruise 100 27.1 drops,
81.4 entries, 4.0 offers; ball 100 4.2 drops (the ball's edge pilots), 16.4 entries. Entry keyframes per probe per second
fell in spread (1.68 -> 0.80 at 50) and stayed level elsewhere.

Reading it:
- Spread and cruise: a capable client holds a third of the ships (about the 1,800 vs 5,000 km² the decision predicted)
  and gets 40-65% fewer bytes. Agreement is unchanged: the only tick-layer disagreement is spread 50's one, before and
  after.
- Ball: everyone is in everyone's focus, so nothing is saved; the 4-7% more is the ring's ghost legs (map dots every
  second with the map shut) and the cells messages. The tick is within noise (+0.3-0.5 ms: home cells once a round).
- The dropped-cell cache rarely fires in 10 s windows: an offer needs a re-entry within 10 s. In the tests (dithering on
  the 19 km edge, out-and-back in 2.5 s) every re-entry with stepped controls was a log of 8-75 bytes in place of 40 bytes
  a ship of entries, with no entry keyframe and every replayed ship exact. Pilots whose aim moves every tick make a
  control change a tick, so their log outgrows an entry after about 1 s away and they come back as new (`refusedSize`):
  the cache pays for NPCs and steady flight, not for a pilot sweeping their aim.

Raw data: the bench JSON was kept in the session scratchpad (before.json, after.json); rerun with the commands above.
