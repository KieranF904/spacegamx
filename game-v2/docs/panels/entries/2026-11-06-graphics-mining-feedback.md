---
date: "2026-11-06"
category: "graphics"
topic: "mining feedback"
files:
- "graphics/mining-feedback-starter-before.png"
- "graphics/mining-feedback-starter-after.png"
- "graphics/mining-feedback-starter.png"
- "graphics/mining-feedback-laser-before.png"
- "graphics/mining-feedback-laser-after.png"
- "graphics/mining-feedback-laser.png"
numbers:
- "Starter's Pips on Mk I rock: a drop every 8.15 s -> 2.61 s, 0.275 -> 0.557 ore/s, first drop 8.3 s -> 2.9 s"
- "Mk I Mining Laser on Mk I rock: a drop every 7.13 s -> 2.22 s, 0.907 -> 1.816 ore/s, first drop 7.1 s -> 2.2 s"
---
Mining pace and feedback. Drops now come about three times as often, and every rig gets twice the ore a second (damagePerUnit 74 -> 37, chunkUnits 4-9 -> 3-5). A chunk that comes due with nothing kept now waits for the next kept unit, so guns with small chunks don't skip drops. A thin gold ring around the rock you're working fills toward your next drop, flares white when the drop comes (bottom row, 5th frame), and fades after you stop (client/src/ships/MiningProgress.ts). Your working hits also make a light, throttled rock tick (no sound in the stills). Each strip is ten frames, 0.45 s apart, holding fire on a Sol Chondrite on a live dev server, guest login, zoom 1.6. Before is the old pace (data/mining.json from c407ce1) with the ring and tick switched off in the page. Starter, before: nearly 5 s of fire and no ore. After: "+1 Iron Ore", "+1 Iron Ore", "+2 Iron Ore". Mk I laser (Prospector), before: still 0 ore in the hold. After: +5 Iron Ore twice and a mixed drop, and the rock is mined out by the last frame.
