---
date: "2026-11-04"
category: "graphics"
topic: "asteroids"
files:
- "asteroids/close-rock-before.png"
- "asteroids/close-rock-after.png"
- "asteroids/close-rock.png"
- "asteroids/dense-belt-before.png"
- "asteroids/dense-belt-after.png"
- "asteroids/dense-belt.png"
- "asteroids/rich-ore-before.png"
- "asteroids/rich-ore-after.png"
- "asteroids/rich-ore.png"
- "asteroids/glasswater-before.png"
- "asteroids/glasswater-after.png"
- "asteroids/glasswater.png"
- "asteroids/close-ice-before.png"
- "asteroids/close-ice-after.png"
- "asteroids/close-ice.png"
numbers: "GPU (RTX 5070 Ti, 8x MSAA, median of 15 alternating rounds): dense belt 0.168 -> 0.167 ms, 9 draws both; close rock filling 2560x1600 x30: 0.722 -> 0.720 ms; ore rock x30: 0.727 -> 0.699 ms; ice rock x30: 0.808 -> 0.796 ms; belt x10 with 4 lights: 2.56 -> 2.55 ms. CPU build of 310 rocks: 7.5 -> 7.2 ms"
status: "awaiting review"
---
Asteroids, same cost or less. Left: as they were; right: each rock its own shade of its ore's colour (lighter or darker, warmer or cooler, from its id), hollows in its close-in shape a little darker and ridges a little lighter (baked into the vertices), crater lips that take the rock's colour and lean with the surface so the bowls sink in rather than sit on top as flat heptagons, a faint cool fill on the side away from the sun so a rock's shape still reads in shadow, and sparse glints on metal and crystal rocks once they're big on screen. The shader skips the ice, shimmer, glint and greyseam terms on rocks that don't have them, which pays for the new ones. Drawn by the rock harness (scripts/rock-proto, `node scripts/rock-proto/run.mjs stills|bench|cpu`): the game's own drawAsteroid and rock shaders, before (scripts/rock-proto/baseline) and after, same camera and Sol or Glasswater light. Gem seams (separate Pixi graphics) are not drawn in the harness. Rock shapes and collision are unchanged.
