---
date: "2026-11-01"
category: "render"
topic: "shields"
files:
- "render/shields-before.png"
- "render/shields-after.png"
- "render/shields-hit-before.png"
- "render/shields-hit-after.png"
---
Your own shield in flight (Review: Heron, two Deflectors, normal zoom). Before: a filled glowing bubble over the whole hull, all the time. After: at rest only a thin rim shows (your own at 60% by default, set in Settings > Display > "Your shield at rest"); the filled bubble comes up only briefly on a hit or while the shield recharges. The second pair is under fire from spawned hostiles; god mode was on in both runs, so the shield never dropped and neither shot shows the actual hit flash (only the impact ripples on the hull). Live shots, shoot.mjs with scripts/boss-shots/hud_shields_steps.json (shots 0 and 3); the hostiles spawn at a different place each run, so the backgrounds differ.
