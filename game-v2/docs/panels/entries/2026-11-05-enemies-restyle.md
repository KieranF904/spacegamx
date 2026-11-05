---
date: "2026-11-05"
category: "enemies"
topic: "restyle"
status: "awaiting review"
files:
- "2026-11-05/enemies-restyle/helios_drone-restyle.png"
- "2026-11-05/enemies-restyle/censer-restyle.png"
- "2026-11-05/enemies-restyle/hookboat-restyle.png"
- "2026-11-05/enemies-restyle/rime_bell-restyle.png"
- "2026-11-05/enemies-restyle/scrap_crawler-restyle.png"
- "2026-11-05/enemies-restyle/maw_lurker-restyle.png"
- "2026-11-05/enemies-restyle/rivet_sower-restyle.png"
- "2026-11-05/enemies-restyle/slag_ray-restyle.png"
- "2026-11-05/enemies-restyle/clinker-restyle.png"
---
A restyle of the custom enemies after the first review. Each panel's top row is at play zoom (1): the starter ship, the grid enemy it replaced (where there is one), the old look, then the new. The bottom row is the old and new close up.

The cartoon look had one main cause. Every design is drawn big and then scaled down (0.42 to 0.8), but the renderer's seams and bevels are a fixed share of a grid cell. So on a small hull they came out 1.3 to 2.4 times too heavy. On top of that, every raised detail got a pure black lip, so stacked trim (gold strips, side plates, cells) read as inked outlines. The grid ships have no black lips at all. The fix is shared, in the kit and the renderer: each piece now carries its scale (`fine`), its seams and bevels are drawn at that size, and its outlines are a shadow of its own colour instead of black. Painted trim is also toned a quarter of the way to grey, so the brass and cream don't read as flat saturated fills. The bosses are unchanged.

The Helios Drone is also slimmer. Its chassis is about 40% narrower (2.0 grid units across, was 3.4, at the same 0.62 scale), its arm is about half as thick, and its panels sit on thin booms (1.2 grid units tall, was about 2). Its radius is 64, down from 73. The solar panels now use the stations' own solar cells: the same texture (now shared from one place), the same navy-violet cells, silver bus lines and frame, the same sheen and shine, and the same outward tilt. Silhouettes, parts and groups are unchanged on the other eight designs.
