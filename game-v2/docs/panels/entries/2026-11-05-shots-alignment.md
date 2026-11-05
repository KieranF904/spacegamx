---
date: "2026-11-05"
category: "graphics"
topic: "shots-alignment"
status: "before/after"
files:
- "2026-11-05/shots-alignment/starter-moving-before.png"
- "2026-11-05/shots-alignment/starter-moving-after.png"
- "2026-11-05/shots-alignment/wisp-moving-before.png"
- "2026-11-05/shots-alignment/wisp-moving-after.png"
- "2026-11-05/shots-alignment/ports-gale-moving-before.png"
- "2026-11-05/shots-alignment/ports-gale-moving-after.png"
numbers: "first drawn frame, shell head vs the drawn barrel tip along its flight, lead held at 6 ticks: starter moving -108 -> 0 units; Wisp moving -80 -> 0.4; Gale moving -60 -> 0.3; turning/still within 2 units after"
---
Your own shells now leave the barrels of your ship as drawn. The ship is drawn on the predicted timeline, the lead (leadTicks) ahead of the server's tick, but its shells were drawn on the server's tick: each one came out where the ship had been that many ticks before, behind its guns when moving (lead × speed: about 100 units on a starter at cruise with a lead of 5-6). Own shells now run on the drawn ship's tick (GameState.ownDrawTick), others' on the tick interpolate placed their ships at (unchanged in practice: within about 1 unit of their barrels before and after). Live dev server, firing while flying forward, frames taken 250 ms into the burst.
