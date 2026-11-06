---
date: "2026-11-07"
category: "gameplay"
topic: "scrap nest roaming"
files:
- "2026-11-07/scrap-nest-roaming/nest-landing-before.png"
- "2026-11-07/scrap-nest-roaming/nest-landing-after.png"
- "2026-11-07/scrap-nest-roaming/nest-den-before.png"
- "2026-11-07/scrap-nest-roaming/nest-den-after.png"
- "2026-11-07/scrap-nest-roaming/nest-ghosts-before.png"
- "2026-11-07/scrap-nest-roaming/nest-ghosts-after.png"
numbers:
- "Share of samples pressed on the wall and not moving, pilot idle at the landing, 3 sim min: Gullet 82% -> 0%, Sorting Floor 72% -> 0%, Smelter 19% -> 0%"
- "Pilot idle in the Gullet: Gallery 64% -> 0%, Smelter 92% -> 0%, Sorting Floor 68% -> 0%"
- "Smelter ghosts in the rock: 44% -> 0%"
- "Den ships: 24 -> 38 (chambers 14 -> 22)"
---
The Scrap Mother's den packs now roam their chambers. Top-down tracks from the headless bench (`npx tsx server/src/bench/nestRoam.ts --minutes 3 --png <dir>`), coloured by heap: yellow Gullet, blue Sorting Floor, red Smelter, purple Gallery, green west face, pink north face, white Seam. Rock is the brown wall band. Before, the chamber packs patrolled round heaps piled against the walls, so most of their patrol points were in the rock. They flew straight at those points, hit the wall and stayed there: the clumps in the chamber edges. After, they patrol round each chamber's open middle (`post`), only pick points they can fly to without touching rock, and pick a new point if they're held up. The landing shot has no Gallery or north-face packs because both are out of load range from the landing.
