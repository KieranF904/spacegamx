# Crowd fallbacks: measurements (2026-11-05)

Design and code: docs/design/awareness-model.md section 7.11. Bench: `npm run bench:crowd -- --crowd --layouts <l>
--n <n> --secs 40 --bulk blocks` (server/, one process per case, seeded). Four probe clients with every cap (32767),
3 ticks of latency counted in their system's ticks; the rest bit-packed blocks sockets. Times are a dev machine's and
move between runs; levels and bytes are what to compare. Raw JSON for the last ball 300 run:
crowd-fallbacks-2026-11-05.json.

## Where each case settles

| case | settled level | base tick, settled (ms) | without fallbacks (ms) | tick-layer disagreements |
|---|--:|--:|--:|--:|
| ball 300 | 9 (15 ticks/s) | 13.1 | 35.6 (encode-once audit), 46-53 in this run's first second | 16 / 150,753 |
| ball 100 | 5 (window 9) | 14.4 | 9-13 at level 0, rising as hostiles pile up | 0 |
| ball 50 | 0 | 4.3 | same | 0 |
| spread 50 | 0 | 1.6 | same | 5 / 42,263 |
| spread 100 | 0 | 4.5 | same | 1 / 44,070 |

Ball 300, level and base-tick ms by second (the levels only ever go up while it's busy):

    L4:53.5 L4:26.5 L5:28.5 L6:25.1 L6:21.9 L7:25.3 L8:18.1 L8:16.7 L8:13.1 L8:13.5 L8:10.1 L8:12.6 L8:14.1 L8:15.6
    L8:15.1 L8:14.3 L8:10.9 L8:11.4 L8:13.3 L8:14.0 L8:16.6 L8:12.7 L8:12.0 L8:13.5 L9:20.6 L9:19.6 L9:11.9 L9:14.5
    L9:12.3 L9:8.5 L9:11.0 L9:14.6 L9:13.1 L9:18.7 L9:16.6 L9:12.6 L9:14.0 L9:11.8 L9:8.2 L9:13.9

## Tuning that came out of the runs

- The first budget marks (10 ms up, 4.5 down) took ball 100 to level 7 (half speed) at about 9 ms a base tick, well
  inside the budget: raised to 13 / 6.
- Level 8 (20 ticks/s) left ball 300 at 16.3 ms, on the budget line: a ninth level (15 ticks/s) was added.
- One flap (9 -> 8 -> 9) at ball 300 came from the smoothed cost dipping under the low mark between the dilated
  system's steps: going down now needs the cost under the mark for 300 base ticks running (up: over it for 30).

## Costs left

- **Spikes.** The dilated system's step lands whole in one base tick, so the base tick that carries it costs about the
  undilated tick (p95 37-68 ms, max 240-270 ms at ball 300). The mean is under budget; the frames that carry a step are
  not. Other systems' pilots feel it as a hitch every few frames.
- **Snapshots at window 9 and 15 ticks/s** are 600 ms apart in real time: other pilots' inputs relay that much later
  and the interpolation delay grows by as much. That is the price of the deepest levels.
- **Ball 100's climb** is real: its hostiles are topped up as they die and the scene grows heavier over the run.
