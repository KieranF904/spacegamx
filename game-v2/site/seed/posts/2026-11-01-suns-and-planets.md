---
title: Suns and planets
tags: [graphics]
status: published
slug: suns-and-planets
date: 2026-11-01
summary: Stars and planets are drawn in a new way. Before and after shots from the game, side by side.
cover: ../../../docs/panels/site-posts/jovan-before-after.jpg
---

Stars and planets are now drawn with a new method. Each picture below is a before and after pair: the old look on the left, the new look on the right, taken in the live game from the same spot and zoom. In the star shots the heads-up display and chat are visible because they were on screen at the time.

## Stars

Stars used to be a flat disc with a blurred edge. They are now a moving plasma surface with a ragged, glowing rim, drawn at half resolution so they cost less to render. The sky behind them now draws its stars as small sprites.

### Sol

![Sol's edge from close by, before (left) and after (right)](../../../docs/panels/site-posts/sol-sun-before-after.jpg)

*Before / after.* Before, Sol's edge is a smooth orange disc with a soft blur and long pale streaks of haze across the sky to its left. After, the surface shows fine bright filaments and darker gaps, the edge is uneven, and a lighter glow fades out over the sky. In the benchmark harness the sun's cost per frame at 1080p went from 0.19 ms to 0.048 ms.

### Nebula Prime

![Nebula Prime's star at its edge, before (left) and after (right)](../../../docs/panels/site-posts/nebula-prime-sun-before-after.jpg)

*Before / after.* Before, Nebula Prime's star is a pale pink disc with a hard edge and a visible horizontal band across it. After, the edge is a column of pink and white plasma that thins out into streaks and blends into the nebula behind it. The sun's cost per frame went from 0.39 ms to 0.042 ms.

### Borealis

![Borealis' star at its edge, before (left) and after (right)](../../../docs/panels/site-posts/borealis-sun-before-after.jpg)

*Before / after.* Before, Borealis' star is a smooth pale cyan disc with a visible seam near the top of the edge. After, it is blue with bright turbulent streaks running across the surface and a darker blue at the rim. The sun's cost per frame went from 0.49 ms to 0.036 ms.

## Planets

Planets are drawn as lit spheres with their own surface detail, an atmosphere or heat glow at the edge, and shading that follows the direction of the star. In the pairs below the planet and the camera sit in slightly different places, because the two shots were taken in the live game at different moments.

### Jovan

![Jovan with its rings, before (left) and after (right)](../../../docs/panels/site-posts/jovan-before-after.jpg)

*Before / after.* Before, Jovan has wide brown and cream bands with a small swirl near the upper right edge and thin, faint rings. After, the bands are narrower and look like flowing, folded clouds, a large red storm sits on the right side, the rings are wider and let the planet show through, and the edge has a soft glow. Planets cost about the same from far away and up to three times less up close.

### Terra Nova

![Terra Nova, before (left) and after (right)](../../../docs/panels/site-posts/terra-nova-before-after.jpg)

*Before / after.* Before, Terra Nova has flat yellow-green patches on blue sea, a pale band across the top and a hard straight line where day ends and night begins. After, the continents have coastlines and varied ground colour, white ice covers the top, clouds drift over the surface, and the day side fades into the dark side through a soft twilight edge.

### A lava world

![Kindle, a lava world, before (left) and after (right)](../../../docs/panels/site-posts/lava-world-before-after.jpg)

*Before / after.* Before, Kindle is a dark ball with smooth orange loops that look like contour lines. After, the surface is made of dark crust plates with rough edges, and the glowing orange rivers run in the cracks between them.

### A brown dwarf

![Ashfall's brown dwarf, before (left) and after (right)](../../../docs/panels/site-posts/brown-dwarf-before-after.jpg)

*Before / after.* Before, Ashfall's brown dwarf is a set of broad, smooth dark and light stripes. After, the stripes are broken into swirls and eddies, the whole surface glows orange from heat, and the rim has a thin bright halo. The branching bright scar across the middle is in both.
