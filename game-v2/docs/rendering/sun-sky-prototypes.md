# Sun and sky prototypes (2026-10-31)

Prototype shaders for the star and the sky that are cheaper than today's and (for the star) look better. **Nothing in
the game uses them yet**: they live in `client/src/rendering/proto/`, the live lab page `client/sunlab.html` (dev server
only, not a build input) and the native harness `scripts/sun-sky-proto/`. Every number below was measured with that
harness on the real GPU (RTX 5070 Ti, moderngl, GPU timer queries, best of two runs of 5×10 draws) unless it says
otherwise, against the game's own shaders read from its TypeScript, set up the way `Renderer` sets them up for each
system.

There are two rounds. **Round 2** (just below) answers Kieran's review of round 1. Round 1 is kept further down as it
was.

# Round 2 (after Kieran's review)

Kieran's review:

- B and B-lite are not good replacements.
- A is a fair compromise; the current sun is higher quality.
- He wants two kinds of option, both cheaper than today: **faithful** (as close to the current look as possible) and
  **alternative** (new looks that are at least as good).
- The sky costs a lot even where the sun covers it.
- The star field should stay as good-looking as it is.

Every option is selectable in the lab (<http://localhost:5273/sunlab.html>; hold Space for the current shaders in
place). Every comparison sheet puts **current first** and labels each option **FAITHFUL** or **ALT**, with its mean
difference from current (0 to 255 a channel).

**Live cost in the lab** (bottom right, `client/sunlab/perf.ts`):

- **What it shows:**
  - A graph of the last 30 s, the sun's cost and the sky's in two plots, in ms a frame. Each has a dashed line for the
    current shader, measured the same way.
  - A labelled marker at every change: option, system, view, resolution, and holding or releasing Space.
  - A plain readout: the option, its typical ms over the last 2 s (the median), and "N× cheaper than current".
- **How it measures.** WebGL timer queries are unreliable on ANGLE, and frame time is capped by vsync, so the lab uses
  a forced sync:
  1. Read back one pixel, so the GPU is idle.
  2. Time a second read with nothing queued: the cost of the sync itself.
  3. Draw the layers K times into an offscreen target the size of the canvas, read a pixel again, and divide the
     difference by K. K adapts so each measurement is about 5 ms.
- **Load.** Four measurements a second, alternating the option and the current shader: about 2% of the GPU's time.
  "Pause measuring" stops it, and it stops while the tab is hidden.
- **Accuracy.** The browser adds a floor of about 0.04 ms a draw (the driver's submit cost, which the game pays too),
  so the cheapest options read a little high there. The harness tables below are the exact GPU numbers.

## Recommendation (round 2)

1. **Star, faithful: "A-exact at half resolution"** (`exact@0.5`). It's the game's own sun, glow and corona shaders,
   with two changes:
   - Their simplex noise is read from a baked texture of the same function.
   - They are drawn into a render target half the screen's size and stretched over it.

   It costs **7 to 13 times less than today** (4K: 0.75 to 2.15 ms → 0.11 to 0.18 ms) and compiles in 629 ms instead of
   1,821 ms. It differs from current by about 1 to 2 levels in a whole-disc view and 1 to 10 at the limb (mainly where
   the noise runs past the baked area; see below).

   If any visible difference is unacceptable, use **"current at half resolution"** (`cur@0.5`) instead. It's today's
   shader untouched, drawn at half size: 3.3 to 3.9 times cheaper, and indistinguishable (0.2 to 0.5 levels).
   `exact@0.33` goes further, 10 to 24 times cheaper, at the same difference as `exact@0.5`.
2. **Star, alternative: "plasma"**. It's a new star; judge it on looks, in the sheets, the GIFs and the lab. Run it at
   half resolution (`plasma@0.5`, 4 to 20 times cheaper than today and close to full-res plasma) and use plasma lite
   on Low. Full-res plasma is 1.3 to 8 times cheaper.
3. **Sky: sprite stars in one draw, skipped under the sun** (`one+skip`). It's faithful: the same stars as today.
   - The sun covers the screen: **0.81 ms → 0** at 4K (nothing drawn).
   - The limb is in view: 0.75 → 0.06 ms.
   - Open sky: 0.80 → 0.065 ms.

   The skip alone, on today's star shader, takes the sun-fills-the-screen case to 0 and saves about 25% at the limb.
   The "better stars" alternative (C) costs the same.
4. **Central bodies: keep their current shaders.** The texture port made the black holes and the brown dwarf slower
   (round 1), and they're cheap already. The lab and the sheets draw them with their own shaders in every option.

## The star: faithful options

| option | what it is |
|---|---|
| A `port` | Round 1's: simplex replaced by one read of a small tiling Perlin texture. A different noise, so a different pattern of the same character. |
| A-exact `exact` | `withExactNoise`: simplex replaced by one read of **the game's own simplex function baked** into a 2048² R16F texture (`bakeSimplex`, 32 texels a lattice unit over −32..32, 0.3 s to bake; mirrored outside, so it's continuous everywhere). Within the baked area the values are the procedural ones; past it (fine octaves, and offsets that grow with game time) it is the same noise mirrored, statistically identical but not the same pattern. |
| current ½ `cur@0.5` | Today's three sun layers drawn unchanged into a half-size render target (premultiplied), then stretched over the screen. The sun's finest detail is far bigger than a pixel at every zoom, and its limb is soft, so this is indistinguishable. |
| A-exact ½, ⅓ `exact@0.5`, `exact@0.33` | Both together. |

Ways to close the remaining gap, if wanted:

- Bake more area (4096², 32 MB as R16F; or 16 texels a unit), or wrap the game's `uTime` so its noise offsets stay inside
  the baked square.
- Temporal reuse: the sun moves slowly, so the half-res target could be redrawn at 30 Hz with the last frame
  reprojected. Not built; the half-res cost is already small.

## The star: alternative, "plasma" (`PLASMA_FRAG`, `plasmaLook`, `plasmaDetail` in `proto/sunProto.ts`)

The star as a ball of glowing, turning plasma, in the spirit of the Sun's 304 Å imagery but in each system's own
colours.

- **Surface.** The noise is a 64³ 3D volume (`noise3Data`, 115 ms to build, 1 MB) read at points on the sphere. The ball
  really turns: features swing across the disc and over the limb, about an axis tilted toward the viewer, with no seam
  or pole. On it, domain-warped fBM plasma with bright ridged filaments and active regions.
- **Detail.** More octaves fade in as the star grows on screen (`uDetail`, up to 3), so there's detail at every zoom.
- **Shading.** A hot core, a darker, redder limb with a bright rim, and a fringe of flame tongues at the limb.
- **Corona.** Glow and straight rays that **stream outward** over time.
- **Per system:** detail stars (Sol, Cinder Reach) take their detail colours; the others take their hue. Flow stars
  warp hardest, granular ones are finer.
- **Cost.** 4 to 7 reads of the 3D texture a disc pixel (more when close), 2 to 3 a corona pixel.
- **Lite.** Plasma lite drops the warp, the fine octaves, the fringe and the fine rays.

It is deliberately not the current look (difference 5 to 7 levels on a whole disc, 25 to 80 close up). Look at
`r2-sun-*-full.png` and the GIFs first. Things to tune on review:

- The streaky foreshortening right at the limb at zoom 1.
- How bright the rim and corona are.
- How fast it turns and the corona flows (`uMotion`).

### Cost, ms per frame (sun, glow and corona together; speedup against current)

1080p is 1920×1080 at DPR 1; 4K is the same view at DPR 2. "whole" is zoom 0.04, "limb" zoom 0.15, "disc" over the disc
at zoom 0.5.

| star | view | current | A port | A-exact | current ½ | A-exact ½ | A-exact ⅓ | ALT plasma | ALT plasma lite | ALT plasma ½ |
|---|---|---|---|---|---|---|---|---|---|---|
| Sol | whole | 0.280 | 0.091 (3.1x) | 0.102 (2.7x) | 0.081 (3.5x) | 0.042 (6.7x) | 0.028 (9.9x) | 0.125 (2.2x) | 0.056 (5.0x) | 0.042 (6.7x) |
| Sol | limb | 0.191 | 0.064 (3.0x) | 0.075 (2.5x) | 0.059 (3.2x) | 0.029 (6.6x) | 0.018 (10.5x) | 0.087 (2.2x) | 0.035 (5.5x) | 0.032 (5.9x) |
| Sol | disc | 0.309 | 0.090 (3.4x) | 0.104 (3.0x) | 0.086 (3.6x) | 0.035 (8.7x) | 0.021 (15.0x) | 0.149 (2.1x) | 0.063 (4.9x) | 0.047 (6.5x) |
| Borealis | whole | 0.364 | 0.099 (3.7x) | 0.116 (3.1x) | 0.104 (3.5x) | 0.040 (9.2x) | 0.023 (15.6x) | 0.067 (5.5x) | 0.043 (8.6x) | 0.028 (12.9x) |
| Borealis | limb | 0.492 | 0.120 (4.1x) | 0.145 (3.4x) | 0.134 (3.7x) | 0.047 (10.6x) | 0.027 (18.5x) | 0.070 (7.1x) | 0.035 (14.0x) | 0.028 (17.6x) |
| Borealis | disc | 0.201 | 0.056 (3.6x) | 0.064 (3.1x) | 0.059 (3.4x) | 0.025 (8.0x) | 0.016 (12.5x) | 0.153 (1.3x) | 0.063 (3.2x) | 0.053 (3.8x) |
| Nebula Prime | whole | 0.458 | 0.107 (4.3x) | 0.126 (3.6x) | 0.127 (3.6x) | 0.043 (10.8x) | 0.025 (18.7x) | 0.131 (3.5x) | 0.064 (7.2x) | 0.062 (7.4x) |
| Nebula Prime | limb | 0.383 | 0.106 (3.6x) | 0.128 (3.0x) | 0.108 (3.6x) | 0.043 (9.0x) | 0.025 (15.5x) | 0.089 (4.3x) | 0.035 (11.0x) | 0.033 (11.7x) |
| Nebula Prime | disc | 0.515 | 0.107 (4.8x) | 0.128 (4.0x) | 0.139 (3.7x) | 0.042 (12.3x) | 0.024 (21.5x) | 0.184 (2.8x) | 0.063 (8.2x) | 0.110 (4.7x) |
| Cinder Reach | whole | 0.310 | 0.094 (3.3x) | 0.106 (2.9x) | 0.087 (3.6x) | 0.036 (8.6x) | 0.021 (14.5x) | 0.126 (2.5x) | 0.064 (4.8x) | 0.047 (6.6x) |
| Cinder Reach | limb | 0.201 | 0.068 (3.0x) | 0.079 (2.5x) | 0.061 (3.3x) | 0.030 (6.8x) | 0.018 (10.9x) | 0.088 (2.3x) | 0.035 (5.8x) | 0.032 (6.3x) |
| Cinder Reach | disc | 0.309 | 0.092 (3.4x) | 0.104 (3.0x) | 0.087 (3.6x) | 0.035 (8.8x) | 0.021 (15.0x) | 0.178 (1.7x) | 0.063 (4.9x) | 0.058 (5.3x) |
| Sol | whole 4K | 1.147 | 0.345 (3.3x) | 0.393 (2.9x) | 0.318 (3.6x) | 0.136 (8.5x) | 0.081 (14.1x) | 0.450 (2.5x) | 0.218 (5.3x) | 0.160 (7.2x) |
| Sol | limb 4K | 0.755 | 0.245 (3.1x) | 0.282 (2.7x) | 0.227 (3.3x) | 0.108 (7.0x) | 0.068 (11.2x) | 0.314 (2.4x) | 0.137 (5.5x) | 0.120 (6.3x) |
| Sol | disc 4K | 1.306 | 0.363 (3.6x) | 0.412 (3.2x) | 0.344 (3.8x) | 0.137 (9.5x) | 0.079 (16.5x) | 0.592 (2.2x) | 0.251 (5.2x) | 0.183 (7.2x) |
| Borealis | whole 4K | 1.455 | 0.373 (3.9x) | 0.444 (3.3x) | 0.399 (3.6x) | 0.149 (9.8x) | 0.085 (17.1x) | 0.243 (6.0x) | 0.157 (9.2x) | 0.099 (14.7x) |
| Borealis | limb 4K | 2.041 | 0.459 (4.4x) | 0.561 (3.6x) | 0.526 (3.9x) | 0.178 (11.5x) | 0.098 (20.8x) | 0.253 (8.1x) | 0.137 (14.9x) | 0.103 (19.9x) |
| Borealis | disc 4K | 0.823 | 0.218 (3.8x) | 0.254 (3.2x) | 0.234 (3.5x) | 0.097 (8.5x) | 0.061 (13.4x) | 0.597 (1.4x) | 0.252 (3.3x) | 0.186 (4.4x) |
| Nebula Prime | whole 4K | 1.892 | 0.415 (4.6x) | 0.494 (3.8x) | 0.493 (3.8x) | 0.160 (11.8x) | 0.090 (21.0x) | 0.498 (3.8x) | 0.252 (7.5x) | 0.165 (11.5x) |
| Nebula Prime | limb 4K | 1.584 | 0.404 (3.9x) | 0.482 (3.3x) | 0.417 (3.8x) | 0.161 (9.9x) | 0.091 (17.4x) | 0.312 (5.1x) | 0.138 (11.5x) | 0.122 (13.0x) |
| Nebula Prime | disc 4K | 2.146 | 0.418 (5.1x) | 0.501 (4.3x) | 0.550 (3.9x) | 0.161 (13.3x) | 0.090 (23.8x) | 0.733 (2.9x) | 0.251 (8.5x) | 0.217 (9.9x) |
| Cinder Reach | whole 4K | 1.285 | 0.368 (3.5x) | 0.417 (3.1x) | 0.345 (3.7x) | 0.139 (9.3x) | 0.080 (16.1x) | 0.491 (2.6x) | 0.253 (5.1x) | 0.159 (8.1x) |
| Cinder Reach | limb 4K | 0.787 | 0.262 (3.0x) | 0.299 (2.6x) | 0.234 (3.4x) | 0.112 (7.0x) | 0.069 (11.4x) | 0.312 (2.5x) | 0.138 (5.7x) | 0.121 (6.5x) |
| Cinder Reach | disc 4K | 1.290 | 0.363 (3.6x) | 0.411 (3.1x) | 0.344 (3.8x) | 0.137 (9.5x) | 0.079 (16.4x) | 0.700 (1.8x) | 0.251 (5.1x) | 0.211 (6.1x) |

### How far each looks from current (mean difference, 0 to 255 a channel)

"full" is the whole disc and corona, "limb" is zoom 0.15 with the sky behind, "close" is zoom 1 at the limb.

| star | view | A port | A-exact | current ½ | A-exact ½ | A-exact ⅓ | ALT plasma | ALT plasma lite | ALT plasma ½ |
|---|---|---|---|---|---|---|---|---|---|
| Sol | full | 2.8 | 2.3 | 0.3 | 2.2 | 2.2 | 7.2 | 7.2 | 7.2 |
| Sol | limb | 9.8 | 10.5 | 0.2 | 10.5 | 10.5 | 38.3 | 37.9 | 38.3 |
| Sol | close | 7.5 | 8.1 | 0.3 | 8.1 | 8.1 | 75.2 | 81.1 | 75.2 |
| Borealis | full | 3.1 | 2.2 | 0.3 | 2.3 | 2.3 | 5.2 | 5.4 | 5.1 |
| Borealis | limb | 11.3 | 6.8 | 0.4 | 6.9 | 6.9 | 26.7 | 25.3 | 26.6 |
| Borealis | close | 5.9 | 1.2 | 0.2 | 1.3 | 1.3 | 45.2 | 57.5 | 45.1 |
| Nebula Prime | full | 3.9 | 2.6 | 0.5 | 2.7 | 2.7 | 5.5 | 5.5 | 5.5 |
| Nebula Prime | limb | 9.9 | 4.7 | 0.4 | 4.7 | 4.8 | 29.9 | 34.8 | 29.8 |
| Nebula Prime | close | 3.6 | 0.9 | 0.2 | 0.9 | 0.9 | 65.5 | 51.7 | 65.4 |
| Cinder Reach | full | 1.9 | 1.7 | 0.2 | 1.7 | 1.7 | 7.3 | 8.1 | 7.3 |
| Cinder Reach | limb | 5.7 | 3.5 | 0.2 | 3.6 | 3.6 | 31.7 | 34.3 | 31.7 |
| Cinder Reach | close | 1.7 | 2.2 | 0.3 | 2.3 | 2.3 | 40.5 | 55.7 | 40.5 |

Cold compile in Chrome (fresh profile, ANGLE/D3D11), the disc program:

| current | A port | A-exact | plasma | plasma lite |
|---|---|---|---|---|
| 1,821 ms | 469 ms | 629 ms | 38 ms | 27 ms |

The half-res options compile the same programs as their full-res versions.

## The sky (round 2)

- **Skip under the sun** (`+skip`). The sun's disc is opaque within 0.95 of its radius, for today's sun and every
  option.
  - `sunCovers`: when the disc covers all four corners of the screen, the sky isn't drawn at all, not even the haze.
  - `withSunHole` (haze and star shaders): otherwise, pixels behind the disc return at once. It's one length test, and
    whole 2×2 quads and warps behind the disc skip all the work.
  - The sprites drop any star or galaxy wholly behind the disc in the vertex shader (`hidden`).
  - The pictures are identical: the difference with the star in view is 0.
- **One draw** (`SKY_ONE_DRAW`, `oneDrawGrid`): all six star layers in one instanced draw, each instance finding its
  layer from a start table. Seven draw calls become two (stars, then deep sky). That's slightly cheaper on the GPU, and
  saves Pixi's per-draw CPU cost, which the profile found the largest CPU item.
- **The look.** The sprite stars are today's stars (same hashes, same placement, same profile; difference 0.15 to 0.85
  levels, all of it individual stars whose hash rounds differently, as explained in round 1).
- **Alternative: C** ("better stars", `SKY_BETTER`) is the round-1 photographic profile (Moffat halo, colour with
  brightness, finer spikes, irregular twinkle). It's subtle, and costs the same.

| system | where | current | current +skip | sprites | sprites +skip | sprites, one draw +skip | ALT better +skip |
|---|---|---|---|---|---|---|---|
| Sol | sun fills the screen, 4K | 0.812 | 0 (not drawn) | 0.068 | 0 (not drawn) | 0 (not drawn) | 0 (not drawn) |
| Sol | limb in view, 4K | 0.747 | 0.568 | 0.069 | 0.060 | 0.057 | 0.057 |
| Sol | just off the disc, 4K | 0.773 | 0.799 | 0.069 | 0.069 | 0.067 | 0.067 |
| Sol | open sky, 4K | 0.797 | 0.855 | 0.067 | 0.067 | 0.065 | 0.065 |
| Borealis | sun fills, 4K | 0.881 | 0 (not drawn) | 0.084 | 0 (not drawn) | 0 (not drawn) | 0 (not drawn) |
| Borealis | limb, 4K | 0.850 | 0.605 | 0.083 | 0.069 | 0.066 | 0.066 |
| Nebula Prime | sun fills, 4K | 0.834 | 0 (not drawn) | 0.074 | 0 (not drawn) | 0 (not drawn) | 0 (not drawn) |
| Nebula Prime | limb, 4K | 0.806 | 0.603 | 0.074 | 0.065 | 0.062 | 0.062 |
| The Maw | open sky, 4K | 0.682 | 0.705 | 0.058 | 0.058 | 0.054 | 0.054 |
| Glasswater | open sky, 4K | 0.809 | 0.810 | 0.070 | 0.069 | 0.067 | 0.068 |
| Sol | sun fills, 1080p | 0.227 | 0 (not drawn) | 0.029 | 0 (not drawn) | 0 (not drawn) | 0 (not drawn) |
| Sol | limb, 1080p | 0.220 | 0.169 | 0.029 | 0.025 | 0.023 | 0.023 |
| Sol | open sky, 1080p | 0.226 | 0.234 | 0.028 | 0.028 | 0.026 | 0.026 |

The early-out costs a few percent where the sun isn't in view (current +skip, open sky). In the game, only bind the hole
uniform while the disc is on screen. Compile: one-draw sprites 53 ms; the hole versions of the full-screen shaders
compile as their originals do (about 520 ms for the stars).

## Adopting round 2

- **`cur@0.5` (zero look risk).** Render the sun's three layers into a `RenderTexture` half the screen's size and draw it
  as a sprite with the normal (premultiplied) blend. It's the same pattern as `SkyRenderer`'s haze: in `Renderer.update`'s
  `plainSun` branch, move `glowRenderer`, `corona` and `sunRenderer` under one container rendered into the target each
  frame. No shader changes.
- **`exact@0.5`.** As above, plus `withExactNoise(FRAGMENT_SHADER)` in `SunRenderer` and `CoronaRaysRenderer`, and a
  `uSimplexTex` resource: an R16F texture from `bakeSimplex(EXACT_SIZE, EXACT_UNITS)`, linear, clamp. Bake it in a
  worker (0.3 s), or ship it as a 2048² half-float asset (8 MB raw, compresses well).
- **Plasma.** A `Mesh` with `SUN_PHOTO_VERT`/`PLASMA_FRAG` over ±R·3, and a 3D texture resource from `noise3Data()`.
  Pixi v8 has no 3D texture source, so it needs a small custom `TextureSource` upload, or the noise packed into a 2D
  atlas of slices with a two-tap lookup. Uniforms: `plasmaLook(systemId, centralBody)` once; `uTime` and
  `uDetail = plasmaDetail(R·zoom)` each frame. Draw it at half res as above.
- **Sky.**
  - Do as round 1's step 4, but with one mesh for the six layers (`SKY_ONE_DRAW`, `oneDrawGrid`).
  - Each frame compute `sunCovers(view, R·OPAQUE)`. While it's true, hide `SkyRenderer.container` and skip its update;
    the sun covers it.
  - Otherwise pass `uSunHole = sunHole(view, R·OPAQUE)` to the sky's shaders while the disc is on screen.
  - The skip also works on today's shaders without sprites (`withSunHole(hazeFrag | starsFrag)`).

## Images (round 2)

All in `C:\Users\Kieran\AppData\Local\Temp\claude\c--Users-Kieran-Desktop-Spacegame\b24c970b-6148-4883-b4f6-ab3b6971e1b5\scratchpad\proto\`.

- **Sun sheets** (current first, then FAITHFUL, then ALT): `r2-sun-<star>-<full|limb|close>.png` for sol, borealis,
  nebula_prime and cinder_reach. Start with `r2-sun-sol-full.png`.
- **Sun animations** (limb at zoom 0.3, 15 s of game time at 3×; current, A-exact, current ½, A-exact ½, plasma,
  plasma lite): `r2-anim-sun-sol.gif`, `r2-anim-sun-borealis.gif`, `r2-anim-sun-nebula_prime.gif`,
  `r2-anim-sun-cinder_reach.gif`.
- **Sky sheets** (current first, then each option; with the sun in view, and open sky):
  - `r2-sky-<sol|borealis|nebula_prime|cinder_reach>-limb.png`
  - `r2-sky-<sol|borealis|nebula_prime|cinder_reach|glasswater|the_maw>-sky.png`
- **The lab in Chrome:** `lab-r2-sol-plasma.png`, `lab-r2-nebula-exact-half.png`.
- **Raw data:** `bench2.final.json` (timings), `r2-diffs.json` (differences), `compile-times-r2.json`.

To reproduce, run `node scripts/sun-sky-proto/run.mjs <set> <out dir>` with one of these sets:

- `v2`: a quick look;
- `stills2`: the sheets;
- `bench2`: timings, about 15 s of GPU;
- `gif2`: the animations.

# Round 1

## Recommendation (round 1, superseded by round 2: B and B-lite were judged not good enough)

1. **Star: adopt B ("photosphere")**, with B-lite on the Medium and Low tiers. It is **6 to 32 times cheaper on the GPU**
   than the current sun, glow and corona together wherever the disc is on screen (4 to 9 times with only the corona
   showing), at 1080p and 4K, for every star. It **compiles in 41 ms instead
   of 1,959 ms**, which takes about 3.9 s off a cold first visit: the profile counted 4.0 s for the two compiles of
   the sun shader (login backdrop and game). It also looks more like a star at every zoom: granulation, limb
   darkening, a crisp limb with a chromosphere, spots, prominences and a streamered corona with fine plumes.
   Each system keeps its colours and character.
2. **Sky stars: adopt B (sprite stars)**. It is the same star field (same hashes, same placement, same profile) drawn as
   instanced sprites instead of a full-screen pass: **9 to 21 times cheaper at 4K** (0.6 to 1.3 ms down to 0.06 to
   0.075 ms) and compiles in 126 ms instead of 473 ms. C (the "better look" star profile) costs the same; it's a taste
   call. Keep the haze as it is: it is already half-res and costs 0.006 ms plus a 0.03 ms blit.
3. **Delete GlowRenderer.** It draws nothing for any star in the game (see Findings).
4. If B is too big a change for one go, **A ("port")** is a drop-in step: the current sun and corona shaders with their
   simplex noise read from a texture. It is 3 to 5 times cheaper, compiles in 495 ms instead of 1,959 ms and looks the
   same. Only the shader source and one texture change.

## What is expensive today

The profile (`docs/audits/profile-2026-10-31.md` §3) found the sky's star layers the largest GPU item at 4K (about
1.3 ms) and the sun quads next (about 0.6 ms). It also found the sun shader's compile the largest load-time stall.
The harness agrees and breaks it down:

- **The sun disc** (`SunRenderer`) is one 34.5 KB shader with all three styles in it. The flow and granular styles
  (Nebula Prime, Borealis) run about 70 to 80 simplex evaluations a pixel at full LOD: four domain-warped fBMs of up to
  10 octaves, granulation, curl flow. The corona branch runs its own fractal over 0.6 to 1.5 radii. The detail
  style (Sol, Cinder Reach) runs about 18, plus a sine plasma and trig. A simplex call is roughly 50 ALU ops, so that
  is about 1,000 to 4,000 ops a pixel. Near a star the quad covers the whole screen at every zoom: even at the widest
  zoom (0.04) the smallest sun is 560 px in radius.
- **Corona rays** (`CoronaRaysRenderer`): 5 simplex calls, an atan and an HSL conversion per pixel over a quad of
  2.2 to 3.1 radii, the largest of the three. All 5 noise values depend only on the angle.
- **Star layers** (`skyShaders.ts` `starsFrag`): every pixel reads the sky fields (2 texture reads), then looks for a
  star in up to 4 cells (9 at worst) in each of six layers, with hashes, exps and the spike branch. About 400 to
  900 ops a pixel, over the whole screen, every frame.

Per-layer split, 4K: Borealis at the limb, `disc` 1.77 ms + `rays` 0.27 ms; Nebula Prime over its disc, `disc` 3.13 ms;
Sol's sky at zoom 1, `stars` 0.86 ms.

## The star

### A: port (`withTextureNoise` in `proto/sunProto.ts`)

This rewrites a game shader's `snoise` (or GLSL_COMMON's value `noise`) into one `textureLod` of a baked tiling noise
texture (`proto/protoNoise.ts`: 512² RGBA, made on the CPU in about 60 ms, with the same 0.47 standard deviation as
simplex). The octave loops, warps and colours stay as they are. Reads use LOD 0, so they're legal in any branch or loop,
and the picture keeps the procedural version's character (aliasing included).

- Sun and corona rays: **3 to 5.7 times cheaper**; disc compile 1,959 → 495 ms, rays 75 → 28 ms.
- Black holes and the brown dwarf: **slower** (0.4 to 0.9 times). Their value noise is a cheap sin-hash, and high
  octaves read at LOD 0 thrash the texture cache. Don't port those. The pulsar is 2.6 to 5 times faster ported, but it
  only costs 0.06 ms at 1080p anyway.

### B: photosphere (`SUN_PHOTO_FRAG`, `sunPhotoLook`, `sunPhotoLevel`, `sunPhotoFine`)

One quad, ±3.2 radii, replaces the glow, the corona rays and the disc (three quads today).

- **Surface.** Worley granules baked into the texture (bright domed cells, dark lanes), two seeds cross-faded on a
  per-place clock so cells come and go ("boil"); the cross-fade keeps its contrast. Two sizes of cell are shown at
  once, chosen from the zoom (`uLevel`), each 4.2 times the last: cells are always 10 px and up, from the widest zoom
  to zoom 2. So there's real detail close in, and no shimmer far out (mipmapped `textureGrad`, derivatives taken
  before any branch).
- **On top of the cells:** mottling at two scales (supergranules, active regions), faculae near the limb, and ragged
  spots with penumbra and umbra on yellow-orange stars.
- **Sphere and colour.** Features crowd toward the limb (an arc-length mapping) and the ball turns slowly about the
  pole. Power-law limb darkening; brightness is mapped through a five-colour ramp, so the limb goes deep and red and
  the hottest granules near the centre go white-hot.
- **Limb and corona.** A crisp, anti-aliased limb with a thin chromosphere line. The corona and streamers come from
  rings through the noise: a function of angle only, with no atan and nothing to wrap. Fine straight plumes, about
  30 px apart at any zoom (`uFine`). Fibrous prominences rise off a few sites round the limb.
- **Per star:** the palette comes from the system's own detail colours (Sol, Cinder Reach) or its hue. Flow stars
  swirl (Nebula Prime), granular ones are fine and contrasty (Borealis). The spots, prominences, streamers and seed
  come from the system id.
- **Cost:** about 5 texture reads and roughly 90 ALU ops a disc pixel, 4 reads and roughly 50 ops a corona pixel.
  7.5 KB of source.
- **B-lite** (`#define SUN_PHOTO_LITE`) drops the flow and mottle read, the spots, one corona read, the plumes and the
  prominences: 3 reads on the disc, 2 on the corona.

**Cost against the current star** (ms per frame, sun + glow + corona; 1080p is 1920×1080 at DPR 1, 4K is the same view
at DPR 2):

| star | view | current 1080p | A | B | B-lite | current 4K | A | B | B-lite |
|---|---|---|---|---|---|---|---|---|---|
| Sol | whole (zoom 0.04) | 0.282 | 0.091 | 0.032 | 0.023 | 1.260 | 0.422 | 0.123 | 0.093 |
| Sol | limb (0.15) | 0.194 | 0.065 | 0.027 | 0.021 | 0.888 | 0.245 | 0.106 | 0.082 |
| Sol | over the disc (0.5) | 0.311 | 0.092 | 0.032 | 0.025 | 1.669 | 0.536 | 0.132 | 0.099 |
| Borealis | whole | 0.366 | 0.100 | 0.029 | 0.022 | 2.493 | 0.465 | 0.109 | 0.085 |
| Borealis | limb | 0.489 | 0.121 | 0.026 | 0.021 | 2.051 | 0.460 | 0.103 | 0.082 |
| Borealis | disc | 0.202 | 0.056 | 0.032 | 0.025 | 0.808 | 0.220 | 0.128 | 0.097 |
| Nebula Prime | whole | 0.461 | 0.108 | 0.034 | 0.025 | 1.836 | 0.534 | 0.129 | 0.096 |
| Nebula Prime | limb | 0.385 | 0.106 | 0.028 | 0.021 | 1.767 | 0.496 | 0.111 | 0.082 |
| Nebula Prime | disc | 0.614 | 0.108 | 0.041 | 0.025 | 3.197 | 0.639 | 0.149 | 0.099 |
| Cinder Reach | whole | 0.385 | 0.095 | 0.032 | 0.025 | 2.121 | 0.551 | 0.124 | 0.096 |
| Cinder Reach | limb | 0.202 | 0.069 | 0.029 | 0.021 | 1.303 | 0.262 | 0.115 | 0.082 |
| Cinder Reach | disc | 0.438 | 0.092 | 0.032 | 0.025 | 1.246 | 0.365 | 0.149 | 0.099 |
| any | corona only (0.3) | 0.09 to 0.19 | 0.03 to 0.06 | 0.021 | 0.018 | | | | |

Cold compile in Chrome (ANGLE/D3D11, fresh profile; the lab's `?compile` mode):

| program | current | A | B | B-lite |
|---|---|---|---|---|
| disc | 1,959 ms | 495 ms | 41 ms | 29 ms |
| rays | 75 ms | 28 ms | (one shader) | |
| glow | 23 ms | | (one shader) | |

These are 5070 Ti numbers. A weak integrated GPU has roughly 1/50 to 1/100 of the shader throughput. By that ratio,
which is not a measurement, the current star's 0.2 to 0.6 ms at 1080p becomes 10 to 60 ms there, and B's 0.03 ms
becomes 1.5 to 3 ms.

**Look notes.** B is a deliberate change of look. It's closer to solar imagery: crisp limb, granules, plumes. Each
system stays recognisable: Sol orange-gold, Cinder Reach a red giant with spots, Borealis blue-white, Nebula Prime
pink and swirled. Things to tune once Kieran has seen it:

- B is brighter than today's Sol and Cinder Reach discs.
- The flow style's swirl is subtler than today's at the limb zoom.
- The prominences could be bolder.

All of it is uniforms in `sunPhotoLook`, and the lab shows the effect live.

### Central bodies

Black holes, the brown dwarf and the pulsar keep their own shaders. They are already cheap: 0.015 to 0.08 ms at 1080p,
0.05 to 0.44 ms at 4K. The texture port only helps the pulsar. Images:
`compare-central-*.png`.

## The sky

### B: sprite stars (`proto/skyProto.ts`)

Each star layer is one instanced draw: one quad per cell that could light the screen. The vertex shader does, once per
star, what `starsFrag` did per pixel: the cell's hashes (is there a star, where, how bright, what colour), the crowding
and dust from the sky fields, the twinkle and the fade. Cells without a star collapse their quad before any pixel
runs. The fragment shader only draws the star's profile (and spikes) for the pixels near it. Deep sky (galaxies,
globular clusters) and the motes are one more instanced draw. The cost now follows the number of stars on screen, not
the number of pixels.

- **Black holes.** A sprite is placed where the lens shows its star (the outer image) and its quad is stretched by the
  magnification, so arcs near the ring look as before. Inside the Einstein ring, every pixel shows a second image from
  sky anywhere at all, which sprites can't reach. There, `insideRingOnly(starsFrag)` (the game's shader, masked to the
  ring) draws on a quad round the ring. Near a black hole, when the whole screen is inside the ring (at The Maw that's
  most of the flying), the sky costs what it does today. Everywhere else it's the sprite cost.
- **Parity.** The images match the game's except for individual stars where the cell hash rounds differently.
  `hash()` does `fract(p*443.9)` at p around 300, about 1/64 resolution in fp32, so whether the compiler fuses a
  multiply-add changes a star. The field is statistically identical (the per-layer diff is symmetric:
  `run.mjs parity`). The current shader already differs this way between GPU vendors. Black-hole skies are
  pixel-identical.

| sky (4K) | zoom 0.04 | 0.3 | 1 | 2 |
|---|---|---|---|---|
| Sol, current → sprites | 0.70 → 0.059 | 0.98 → 0.063 | 0.90 → 0.062 | 1.28 → 0.060 |
| Nebula Prime | 0.98 → 0.064 | 0.81 → 0.069 | 0.83 → 0.067 | 0.81 → 0.066 |
| Borealis | 0.64 → 0.069 | 0.84 → 0.075 | 0.86 → 0.075 | 0.85 → 0.072 |
| Glasswater | 0.58 → 0.059 | 0.78 → 0.064 | 0.81 → 0.062 | 0.80 → 0.060 |
| Void Sector (black hole, ring off screen except at 0.04) | 0.51 → 0.111 | 0.71 → 0.050 | 0.75 → 0.050 | 0.70 → 0.046 |
| The Maw (same) | 0.54 → 0.227 | 0.82 → 0.054 | 0.90 → 0.051 | 0.92 → 0.050 |

These figures include the haze (0.006 ms) and its blit (0.033 ms), which are the same in both. At 1080p it's
0.18 to 0.25 ms → 0.015 to 0.033 ms. Compile: stars 473 ms → sprite 53 ms + deep sky 73 ms (the ring program, 577 ms,
is only needed in black-hole systems and can be compiled when one is entered).

### C: sprite stars, better look (`#define SKY_BETTER`)

Same sprites and same cost, with these changes:

- A photographic profile: a sharp core in a soft Moffat-like halo whose wings are windowed to nothing at the reach, so
  bright stars glow without a hard edge.
- Colour that comes through as stars brighten (faint ones read white, as to the eye).
- Finer, longer diffraction spikes.
- A less regular twinkle.

Subtle in stills (`compare-sky-*.png`, third panel). Because sprites cost per star, a denser or richer field is now
affordable if wanted.

## Findings along the way

- **GlowRenderer draws nothing** for any star in `systems.json`. Its inner cut-out, `starRadius × 0.95 / glowRadius`,
  is 0.40 to 0.47, and its span (`glowSpan`) is 0.35, so every fragment returns at once. A glow-only render is all
  zero for Sol, Borealis, Nebula Prime and Cinder Reach. It still costs a quad, uniforms each frame and a 23 ms compile.
- **The current Sol and Cinder Reach limbs are soft.** The detail style fades its edge from 0.97 to 1.002 radii, about
  600 px wide at zoom 1 (`compare-sun-sol-close.png`), so the disc looks about 3% smaller than its radius.
- **In-browser timer queries are unreliable here**, as the profile found: ANGLE/D3D11 counts CPU submission gaps. The
  lab shows them, but they are indicative only; the native harness numbers are the ones to trust.

## How to switch the game over

None of this is wired in. A suggested order:

1. **Glow.** Remove `GlowRenderer` from `Renderer` (and from `sandbox.ts` if wanted). No visual change.
2. **Star (B).**
   - Add a `SunPhotoRenderer` beside `SunRenderer`: one Pixi `Mesh` with `SUN_PHOTO_VERT`/`SUN_PHOTO_FRAG`, its quad
     ±R·`reach`, and a `uNoiseTex` resource made like `skyNoiseTexture()` from `sunNoiseData()` (`BufferImageSource`,
     repeat, linear, mipmaps, `alphaMode: 'no-premultiply-alpha'`).
   - Uniforms: `sunPhotoLook(systemId, centralBody)` once per system; each frame `uTime`,
     `uLevel = sunPhotoLevel(zoom)` and `uFine[0] = sunPhotoFine(R, zoom)`. For a detail star, `centralBody` is the
     whole system entry's `centralBody`, `detailColors` included.
   - In `Renderer.update` (the `plainSun` branch, about lines 812 to 845): when the setting is on, show it and hide
     the sun, glow and corona.
   - Hide it when the ±R·3.2 box is off screen.
   - Do the same for the login backdrop (`LoginUI` makes its own `SunRenderer`; that compile alone holds up the
     login screen for about 1.9 s).
3. **Tiers.** Add `sun: 'photo' | 'photoLite'` to `settings/quality.ts` (High → photo, Medium and Low → photoLite).
   Prepend `#define SUN_PHOTO_LITE 1` after the version line for the lite program.
4. **Sky (B).**
   - In `SkyRenderer`, replace `starMesh` with six instanced meshes (`SKY_SPRITE_VERT`/`SKY_SPRITE_FRAG`) and one for
     deep sky and motes (`SKY_DEEP_*`). Use a 4-vertex triangle-strip geometry with `instanceCount` set each frame from
     `spriteGrid(biome, view, layer, lens)` (an off layer simply isn't drawn, which keeps the `starLayers` quality
     flags working). Uniforms come from `skySpriteUniforms`.
   - The vertex shader writes clip space itself, so mark the meshes `cullable = false`.
   - In black-hole systems add a mesh with `insideRingOnly(starsFrag)` on the `ringBox` quad, shown only while the
     ring is on screen.
   - The haze is unchanged.
5. **A only, as a stopgap instead of 2.** In `SunRenderer` and `CoronaRaysRenderer`, wrap `FRAGMENT_SHADER` in
   `withTextureNoise(...)` and add the `uNoiseTex` resource.

**LOD to pair with B.** The star needs no geometric LOD in flight: the disc is always at least 560 px in radius, and a
single quad is cheap. Its detail LOD is built in:

- `uLevel` picks the cell size from the zoom.
- Mipmapped `textureGrad` keeps far views calm.
- `uFine` keeps the plumes a constant spacing on screen.

What's left is the tier switch (B / B-lite) and skipping the draw when off screen. If the star is ever drawn tiny (a
map or minimap), use B-lite with a high `uLevel`. Below about 8 px radius, use a glow sprite instead.

## Running it

- **Live lab:** <http://localhost:5273/sunlab.html> with the Vite dev server up. Pick a system, sun variant, sky
  variant and view; drag to pan, wheel to zoom; hold Space to see the current shaders in place. `?compile` measures
  cold compile times (use a fresh browser profile).
- **Native harness:** `node scripts/sun-sky-proto/run.mjs <set> <out dir>`, where the set is one of:
  - `verify`: quick looks and the glow check;
  - `bench`: timings;
  - `stills`: comparison sheets;
  - `gif`: animations;
  - `parity`: sky stars layer by layer.

  It writes `<set>.results.json`. Needs `pip install moderngl pillow numpy`. A full bench is about 10 s of GPU time.

## Images

All in `C:\Users\Kieran\AppData\Local\Temp\claude\c--Users-Kieran-Desktop-Spacegame\b24c970b-6148-4883-b4f6-ab3b6971e1b5\scratchpad\proto\`.
Each sun sheet is 2×2: current, A, B, B-lite.

- Whole disc:
  - `...\proto\compare-sun-sol-full.png`
  - `...\proto\compare-sun-borealis-full.png`
  - `...\proto\compare-sun-nebula_prime-full.png`
  - `...\proto\compare-sun-cinder_reach-full.png`
- Limb at zoom 0.15, over each system's sky: `...\proto\compare-sun-<star>-limb.png`
- Close at zoom 1: `...\proto\compare-sun-<star>-close.png`
- Animated limb (15 s of game time at 3×; current, A, B side by side): `...\proto\anim-sun-<star>.gif` for sol,
  borealis, nebula_prime, cinder_reach
- Central bodies (current, A): `...\proto\compare-central-<ashfall|void_sector|the_maw|glasswater>.png`
- Skies (current, B sprites, C better): `...\proto\compare-sky-<system>-z<0.3|1.5>.png` for sol, borealis,
  nebula_prime, ashfall, the_maw, void_sector, glasswater, cinder_reach
- The lab in Chrome: `...\proto\lab-sol-limb.png`
- Single frames: `...\proto\stills\`; raw timings: `...\proto\bench.final.json`; compile times: `...\proto\compile-times.json`

## Files

- `client/src/rendering/proto/protoNoise.ts`: the baked noise texture (pure data).
- `client/src/rendering/proto/sunProto.ts`: A (`withTextureNoise`), B (`SUN_PHOTO_*`, `sunPhotoLook`, `sunPhotoLevel`,
  `sunPhotoFine`).
- `client/src/rendering/proto/skyProto.ts`: sprite stars, deep sky, `spriteGrid`, `skyBox`, `ringBox`,
  `insideRingOnly`.
- `client/sunlab.html`, `client/sunlab/sunlab.ts`: the lab (dev only).
- `scripts/sun-sky-proto/`:
  - `layers.ts`, `skyLayers.ts`: the game's set-up and the prototypes', per view;
  - `scenes.ts`, `run.mjs`: jobs and runner;
  - `harness.py`: the moderngl renderer and timer.
