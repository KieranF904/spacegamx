# Sun and sky prototypes (2026-10-31)

Prototype shaders for the star and the sky that are cheaper than today's and (for the star) look better. **Nothing in
the game uses them yet**: they live in `client/src/rendering/proto/`, the live lab page `client/sunlab.html` (dev server
only, not a build input) and the native harness `scripts/sun-sky-proto/`. Every number below was measured with that
harness on the real GPU (RTX 5070 Ti, moderngl, GPU timer queries, best of two runs of 5×10 draws) unless it says
otherwise, against the game's own shaders read from its TypeScript, set up the way `Renderer` sets them up for each
system.

There are five rounds. **Round 5** (just below) answers Kieran's review of round 4; each round answers his review of
the one before. The older rounds are kept below as they were.

# Round 5 (after Kieran's review of round 4)

Kieran's review of round 4:

- R4 looks quite good.
- The edge effects should lie over the disc's feathered edge and break it up, so the fade never reads as a ramp; and
  nothing in the haze should end in a line.
- The lite versions aren't Low-tier candidates; propose a better Low tier. The lite versions stay in the code, the lab
  and here.
- Multicolour should come from the plasma's own structure, not be laid over it.
- The pattern should evolve over time, without speeding up the turning.

Round 5 is `#define PLASMA_R5` on top of R4 (`plasma5`, `plasma5@0.5`, `plasma5@0.33`, `plasma5.low@0.5`,
`plasma5.rainbow@0.5`, `plasma5.aurora@0.5`; `plasma5.lite` is kept).

1. **The edge.**
   - **Ragged fade:** where the disc's fade starts and ends now varies round the limb and along the radius (one read,
     only near the limb), so there's no clean ring where the disc ends.
   - **Over the fade:** the chromosphere band, the haze and the spicules lie over it. The spicules rise from inside
     the limb, over the fade, and thin out smoothly at a height that varies round it with the streamers.
   - **Sized by zoom:** the edge's noise follows the star's size on screen (`uPxR`), so its features are always tens
     of pixels apart along the limb.
   - **The haze line:** it was the band and the spicule tips all ending at one height down the whole view. The noise
     that set that height was sized for the whole star, so a zoomed-in view only ever saw one or two of its features.
     A third, short falloff now keeps the light past the fringe fading smoothly instead of levelling off. Measured
     across the crop, the drop-then-plateau is gone (`r5-edge-sol-z0.3.png`).
   - **Two artifacts on the way, both fixed:**
     - Sizing that noise from each pixel's own footprint (`fwidth`) made screen-aligned blocks, because neighbouring
       pixels' slight differences jumped the noise ring. It's now sized from a uniform.
     - A fixed radial frequency let the 64³ volume's voxels show up close. The radial frequency now follows the zoom
       too.
2. **The low tier, instead of lite.** Two proposals, both R5 with the R5 look:
   - `plasma5@0.33`: R5 at ⅓ resolution.
   - `plasma5.low@0.5`: R5 at ½ res without the bump, the spicules and the fine octaves (`#define PLASMA_LOW`). It
     keeps the warp, the two octaves, the limb by angle, the ragged edge, the band and the haze.

   On these views both cost about what lite did, and they look like R5 rather than a flatter star. The lite versions
   remain selectable (labelled "kept, not a candidate").
3. **Multicolour from the structure.** The colour of a place comes from the plasma's own fields: the warp (so colour
   regions ride the same flow), the body and filaments, and the heat. Lanes take a deeper hue than hot cores, so each
   swirl and filament carries its own colour along the flow. There's no separate hue field and no extra read (round 4's
   multicolour had one of each). Rainbow and aurora are both redone this way.
4. **Evolution.**
   - **In place:** the sampling sphere slides through the noise volume along the line of sight (the volume's own
     turned z axis), so features grow, morph and dissolve where they are instead of sliding across the ball.
   - **The warp:** it evolves on its own clock, with a slow wander independent of the turning. The turning is
     unchanged.
   - **Per star** (`evolve`, `warpEvolve`, `warpWander`; `PLASMA5_TUNING`): Cinder Reach's giant churns slowest
     (0.007), Borealis boils fastest (0.018), Sol 0.012, Nebula Prime 0.014. At these rates fine features re-form in
     roughly 10 s, and the large ones over about a minute.
   - **Cost:** none (the offset is a uniform-derived vector added to existing reads).

**Recommendation (round 5).** R5 at half resolution (`plasma5@0.5`). For Low, `plasma5.low@0.5` or `plasma5@0.33`.
Multicolour (rainbow, aurora) is a per-system option at the same cost.

### Cost, ms per frame (sun, glow and corona; speedup against current; native harness, best of two runs)

"whole" is zoom 0.04, "limb" zoom 0.15, "disc" over the disc at zoom 0.5. 1080p unless marked 4K.

| star | view | current | R4 plasma ½ | R5 plasma | R5 plasma ½ | R5 plasma ⅓ (Low?) | R5 low ½ (Low?) | R5 rainbow ½ |
|---|---|---|---|---|---|---|---|---|
| Sol | whole | 0.281 | 0.066 (4.3x) | 0.175 (1.6x) | 0.062 (4.6x) | 0.035 (8.0x) | 0.046 (6.2x) | 0.062 (4.5x) |
| Sol | limb | 0.191 | 0.042 (4.6x) | 0.111 (1.7x) | 0.039 (4.9x) | 0.023 (8.2x) | 0.025 (7.7x) | 0.040 (4.8x) |
| Sol | disc | 0.307 | 0.062 (5.0x) | 0.186 (1.6x) | 0.057 (5.4x) | 0.032 (9.5x) | 0.032 (9.5x) | 0.058 (5.3x) |
| Borealis | whole | 0.364 | 0.043 (8.5x) | 0.101 (3.6x) | 0.043 (8.5x) | 0.025 (14.6x) | 0.033 (11.2x) | 0.043 (8.5x) |
| Borealis | limb | 0.491 | 0.037 (13.2x) | 0.093 (5.3x) | 0.035 (14.1x) | 0.022 (22.6x) | 0.026 (19.1x) | 0.036 (13.7x) |
| Borealis | disc | 0.202 | 0.067 (3.0x) | 0.204 (1.0x) | 0.062 (3.2x) | 0.035 (5.7x) | 0.033 (6.1x) | 0.063 (3.2x) |
| Nebula Prime | whole | 0.461 | 0.089 (5.1x) | 0.192 (2.4x) | 0.084 (5.5x) | 0.051 (9.1x) | 0.059 (7.8x) | 0.084 (5.5x) |
| Nebula Prime | limb | 0.385 | 0.043 (9.0x) | 0.112 (3.4x) | 0.040 (9.7x) | 0.024 (16.2x) | 0.025 (15.4x) | 0.041 (9.4x) |
| Nebula Prime | disc | 0.518 | 0.088 (5.9x) | 0.234 (2.2x) | 0.084 (6.2x) | 0.036 (14.5x) | 0.033 (15.9x) | 0.084 (6.2x) |
| Cinder Reach | whole | 0.312 | 0.089 (3.5x) | 0.240 (1.3x) | 0.086 (3.7x) | 0.044 (7.1x) | 0.036 (8.7x) | 0.085 (3.7x) |
| Cinder Reach | limb | 0.202 | 0.043 (4.7x) | 0.112 (1.8x) | 0.040 (5.1x) | 0.024 (8.4x) | 0.025 (8.0x) | 0.041 (4.9x) |
| Cinder Reach | disc | 0.311 | 0.070 (4.4x) | 0.216 (1.4x) | 0.067 (4.6x) | 0.046 (6.8x) | 0.032 (9.7x) | 0.068 (4.6x) |
| Sol | whole 4K | 1.126 | 0.229 (4.9x) | 0.643 (1.8x) | 0.210 (5.3x) | 0.117 (9.6x) | 0.134 (8.4x) | 0.213 (5.3x) |
| Sol | limb 4K | 0.755 | 0.155 (4.9x) | 0.406 (1.9x) | 0.145 (5.2x) | 0.084 (9.0x) | 0.092 (8.2x) | 0.148 (5.1x) |
| Sol | disc 4K | 1.246 | 0.236 (5.3x) | 0.708 (1.8x) | 0.221 (5.6x) | 0.121 (10.3x) | 0.126 (9.9x) | 0.224 (5.6x) |
| Borealis | whole 4K | 1.430 | 0.143 (10.0x) | 0.350 (4.1x) | 0.135 (10.6x) | 0.082 (17.5x) | 0.112 (12.7x) | 0.139 (10.3x) |
| Borealis | limb 4K | 1.979 | 0.135 (14.7x) | 0.347 (5.7x) | 0.126 (15.7x) | 0.077 (25.6x) | 0.093 (21.2x) | 0.131 (15.2x) |
| Borealis | disc 4K | 0.807 | 0.252 (3.2x) | 0.726 (1.1x) | 0.239 (3.4x) | 0.121 (6.7x) | 0.127 (6.3x) | 0.241 (3.3x) |
| Nebula Prime | whole 4K | 1.835 | 0.244 (7.5x) | 0.722 (2.5x) | 0.228 (8.0x) | 0.185 (9.9x) | 0.139 (13.2x) | 0.229 (8.0x) |
| Nebula Prime | limb 4K | 1.525 | 0.156 (9.8x) | 0.410 (3.7x) | 0.146 (10.4x) | 0.086 (17.7x) | 0.092 (16.5x) | 0.150 (10.2x) |
| Nebula Prime | disc 4K | 2.077 | 0.283 (7.3x) | 0.921 (2.3x) | 0.271 (7.7x) | 0.139 (15.0x) | 0.128 (16.3x) | 0.272 (7.6x) |
| Cinder Reach | whole 4K | 1.249 | 0.289 (4.3x) | 0.626 (2.0x) | 0.283 (4.4x) | 0.116 (10.8x) | 0.131 (9.5x) | 0.282 (4.4x) |
| Cinder Reach | limb 4K | 0.790 | 0.156 (5.1x) | 0.413 (1.9x) | 0.146 (5.4x) | 0.085 (9.3x) | 0.093 (8.5x) | 0.149 (5.3x) |
| Cinder Reach | disc 4K | 1.246 | 0.265 (4.7x) | 0.861 (1.4x) | 0.252 (4.9x) | 0.139 (9.0x) | 0.126 (9.9x) | 0.254 (4.9x) |

**The whole sun in view** (the Sol panel's framing; the sun is small on screen there, so everything is cheap):

| option | 1080p | 4K |
|---|---|---|
| current | 0.034 ms | 0.131 ms |
| R5 ½ | 0.015 ms | 0.058 ms |
| R5 ⅓ | 0.011 ms | 0.043 ms |
| R5 low ½ | 0.014 ms | 0.052 ms |

`r5-panel-sol-perf.png` has every option.

**Live graph** (the lab, Sol at the limb, 1600×900; current 0.125 to 0.143 ms):

| option | live cost |
|---|---|
| R4 ½ | 0.045 ms (2.9×) |
| R5 ½ | 0.060 ms (2.4×) |
| R5 ⅓ | 0.040 ms (3.1×) |
| R5 low ½ | 0.035 ms (3.6×) |
| R5 rainbow ½ | 0.048 ms (2.8×) |

The browser adds a floor of about 0.04 ms a draw, so these read a little high.

**Cold compile** (Chrome, fresh profile):

| shader | compile |
|---|---|
| current sun | 1,833 ms |
| R4 | 110 ms |
| R5 | 123 ms |
| R5 low | 100 ms |
| R5 lite | 99 ms |

### Images (round 5)

All in `C:\Users\Kieran\AppData\Local\Temp\claude\c--Users-Kieran-Desktop-Spacegame\b24c970b-6148-4883-b4f6-ab3b6971e1b5\scratchpad\proto\`.

- **The Sol panels** (the whole sun, the same framing and exposure in every tile; the original first):
  - `r5-panel-sol.png`;
  - `r5-panel-sol-perf.png`, with each option's cost for that view at 1080p and 4K, its speedup against current,
    compile time and resolution.
- **Sun sheets** (current first, R4 ½ for reference, then R5 full, ½, ⅓, low ½, rainbow ½, aurora ½):
  `r5-sun-<sol|borealis|nebula_prime|cinder_reach>-<full|limb|close>.png`.
- **The edge up close** (current, R4 ½, R5 ½, R5 low ½): `r5-edge-<star>-z0.3.png` and `r5-edge-<star>-z1.png`.
- **Animations:** a minute of game time at about 6× (60 frames a second apart): current, R4 ½, R5 ½, R5 rainbow ½
  side by side, so the evolution shows against R4. `r5-anim-sun-<star>.gif`.
- **The lab:** `lab-r5-graph.png`.
- **Raw data:** `bench5.final.json`, `panel5.results.json`, `compile-times-r5.json`.

To reproduce, run `node scripts/sun-sky-proto/run.mjs <set> <out dir>`, where the set is `v5`, `stills5`, `gif5`,
`bench5` or `panel5`. Then run `python scripts/sun-sky-proto/panel5perf.py <out dir> <panel5 results...>` for the
performance panel.

# Round 4 (after Kieran's review of round 3)

Kieran's review of round 3:

- The plasma is very promising.
- The limb should blend into the atmosphere instead of being a disc with an alpha fade.
- Colour and contrast are too uniform across the face: they should change with the viewing angle, like a real sphere.
- Everything should be per-star data.
- Fix plasma lite's four-lobed corona on Cinder Reach.
- Keep rainbow saturated up close.
- Give the lab a much wider zoom range.

Round 4 is `#define PLASMA_R4` in `PLASMA_FRAG`, so round 3's plasma is unchanged and shown beside it for reference. The
variants are `plasma4`, `plasma4@0.5`, `plasma4.lite`, `plasma4.rainbow@0.5` and `plasma4.aurora@0.5`.

1. **The face by viewing angle.** Everything is driven by μ, the cosine of the view angle (1 face-on, 0 at the limb):
   - **Limb darkening:** how dark the edge gets, and the curve's power.
   - **Colour:** toward the limb it deepens to a per-star limb colour (deeper, redder for Sol, magenta for Nebula
     Prime, deep blue for Borealis, near-black red for Cinder Reach).
   - **Contrast:** the cells and filaments flatten toward the limb, down to a per-star share.
   - **Bump:** a fake normal from the noise. The plasma's height is compared a step along a fixed light, one more
     read, so ridges catch light on one side and shade on the other. It's strongest at grazing angles, so the surface
     has relief where it's seen edge-on.
   - The squash of the pattern toward the limb is kept.
2. **The edge into the atmosphere.**
   - **Chromosphere:** a thin, hotter, tinted band straddling the limb (per-star colour and width), so the surface
     runs into the atmosphere.
   - **Haze:** light scattered over the limb from inside, and a wide halo outside.
   - **Spicules:** tongues of gas off the limb that shade from the chromosphere's colour into the corona's.
   - **The disc's soft fade:** its width is now a share of the radius but at most 60 px, and the band's at most
     20 px. Zoomed in on a big star they were hundreds of px of haze, which round 3's plasma still is at zoom 1.
3. **Per-star data** (`PlasmaParams`; in the game, `centralBody.plasma` in systems.json):
   - **The limb:** `limbDarkening`, `limbPower`, `limbContrast`, `limbTint`, `limbTintStrength`, `bump`.
   - **The edge:** `rim`, `rimColor`, `rimWidth`, `halo`, `spicules`.
   - **Tuning:** `PLASMA4_TUNING` in `scripts/sun-sky-proto/layers.ts` has values for Sol, Borealis, Nebula Prime and
     Cinder Reach. Cinder Reach is the deep red giant: strongly limb-darkened, low contrast at the limb, a thick,
     hazy, extended atmosphere.
   - **Defaults:** they come from each star's own palette.
   - **Multicolour:** the multicolour looks use the same limb and edge.
4. **Fixes.**
   - **Lite's corona** reads the fine rays too (one more read in the corona only), and the broad streamers ring is
     1.8 times wider, so no star gets a two- or four-lobed corona.
   - **Rainbow** stays saturated where it's bright, instead of fading to pastel and white.
5. **The lab's zoom.** It runs 0.005 to 20 (the game allows 0.04 to 2):
   - A zoom slider (logarithmic) has the game's range shaded on its track, and the value is shown, in amber when
     beyond the game.
   - The wheel goes as far.
   - New presets: "surface up close" (zoom 8), "the limb up close" (zoom 6) and "far out" (zoom 0.008).
   - The live graph marks each zoom change, and crossing the game's limits.
   - **At the extremes:**
     - The plasma's fine detail octaves stop at 3 (the surface just gets softer past about zoom 4 on these stars).
     - The sprite sky stays bounded: far layers fade out as before, and the near cells only get bigger.
     - The measurement repeats adapt as before.

**Recommendation (round 4).** Plasma R4 at half resolution (`plasma4@0.5`), with plasma R4 lite on Low. It's 3 to
15 times cheaper than today (4K: 0.8 to 2.2 ms → 0.13 to 0.29 ms). Round 4 costs about 25% more than round 3 for the
bump read and the edge. **Don't use R4 at full res:** it is only 0.8 to 5x cheaper, and over the disc on Borealis it
costs what current does.

### Cost, ms per frame (sun, glow and corona; speedup against current; native harness, best of two runs)

"whole" is zoom 0.04, "limb" zoom 0.15, "disc" over the disc at zoom 0.5. 1080p unless marked 4K.

| star | view | current | R3 plasma ½ | R4 plasma | R4 plasma ½ | R4 plasma lite | R4 rainbow ½ |
|---|---|---|---|---|---|---|---|
| Sol | whole | 0.282 | 0.054 (5.2x) | 0.189 (1.5x) | 0.066 (4.3x) | 0.067 (4.2x) | 0.070 (4.0x) |
| Sol | limb | 0.194 | 0.033 (5.9x) | 0.121 (1.6x) | 0.042 (4.6x) | 0.040 (4.8x) | 0.046 (4.2x) |
| Sol | disc | 0.311 | 0.050 (6.2x) | 0.202 (1.5x) | 0.062 (5.0x) | 0.065 (4.8x) | 0.069 (4.5x) |
| Borealis | whole | 0.367 | 0.033 (11.3x) | 0.109 (3.4x) | 0.044 (8.4x) | 0.059 (6.2x) | 0.047 (7.8x) |
| Borealis | limb | 0.494 | 0.029 (17.0x) | 0.101 (4.9x) | 0.037 (13.2x) | 0.042 (11.8x) | 0.042 (11.9x) |
| Borealis | disc | 0.202 | 0.067 (3.0x) | 0.246 (0.8x) | 0.068 (3.0x) | 0.066 (3.1x) | 0.074 (2.7x) |
| Nebula Prime | whole | 0.462 | 0.077 (6.0x) | 0.206 (2.2x) | 0.092 (5.0x) | 0.069 (6.6x) | 0.095 (4.8x) |
| Nebula Prime | limb | 0.385 | 0.033 (11.7x) | 0.122 (3.1x) | 0.043 (9.0x) | 0.041 (9.4x) | 0.047 (8.2x) |
| Nebula Prime | disc | 0.521 | 0.079 (6.6x) | 0.250 (2.1x) | 0.091 (5.7x) | 0.066 (8.0x) | 0.094 (5.5x) |
| Cinder Reach | whole | 0.312 | 0.083 (3.8x) | 0.244 (1.3x) | 0.093 (3.4x) | 0.068 (4.6x) | 0.086 (3.7x) |
| Cinder Reach | limb | 0.203 | 0.033 (6.2x) | 0.122 (1.7x) | 0.043 (4.7x) | 0.042 (4.9x) | 0.047 (4.3x) |
| Cinder Reach | disc | 0.313 | 0.058 (5.4x) | 0.231 (1.4x) | 0.070 (4.4x) | 0.065 (4.8x) | 0.078 (4.0x) |
| Sol | whole 4K | 1.210 | 0.203 (6.0x) | 0.730 (1.7x) | 0.228 (5.3x) | 0.259 (4.7x) | 0.244 (5.0x) |
| Sol | limb 4K | 0.804 | 0.123 (6.5x) | 0.422 (1.9x) | 0.155 (5.2x) | 0.158 (5.1x) | 0.171 (4.7x) |
| Sol | disc 4K | 1.357 | 0.192 (7.1x) | 0.806 (1.7x) | 0.236 (5.7x) | 0.258 (5.3x) | 0.265 (5.1x) |
| Borealis | whole 4K | 1.511 | 0.110 (13.8x) | 0.377 (4.0x) | 0.143 (10.5x) | 0.194 (7.8x) | 0.162 (9.3x) |
| Borealis | limb 4K | 2.074 | 0.107 (19.5x) | 0.384 (5.4x) | 0.135 (15.4x) | 0.159 (13.1x) | 0.150 (13.8x) |
| Borealis | disc 4K | 0.837 | 0.218 (3.8x) | 0.808 (1.0x) | 0.254 (3.3x) | 0.260 (3.2x) | 0.280 (3.0x) |
| Nebula Prime | whole 4K | 1.967 | 0.226 (8.7x) | 0.787 (2.5x) | 0.246 (8.0x) | 0.266 (7.4x) | 0.263 (7.5x) |
| Nebula Prime | limb 4K | 1.616 | 0.124 (13.0x) | 0.456 (3.5x) | 0.156 (10.4x) | 0.158 (10.2x) | 0.171 (9.4x) |
| Nebula Prime | disc 4K | 2.191 | 0.246 (8.9x) | 1.075 (2.0x) | 0.284 (7.7x) | 0.258 (8.5x) | 0.310 (7.1x) |
| Cinder Reach | whole 4K | 1.328 | 0.286 (4.6x) | 0.696 (1.9x) | 0.290 (4.6x) | 0.264 (5.0x) | 0.284 (4.7x) |
| Cinder Reach | limb 4K | 0.790 | 0.123 (6.4x) | 0.427 (1.8x) | 0.156 (5.1x) | 0.161 (4.9x) | 0.172 (4.6x) |
| Cinder Reach | disc 4K | 1.314 | 0.217 (6.1x) | 0.960 (1.4x) | 0.265 (5.0x) | 0.258 (5.1x) | 0.293 (4.5x) |

The lab's live graph (Sol at the limb, 1600×900; current 0.127 to 0.148 ms) shows the same steps:

| option | live cost |
|---|---|
| round 3 plasma ½ | 0.050 ms (2.9×) |
| R4 plasma ½ | 0.048 ms (2.8×) |
| R4 lite | 0.033 ms (4.2×) |
| R4 rainbow ½ | 0.055 ms (2.3×) |

Beyond the game's zoom:

| view | zoom | sun | sky |
|---|---|---|---|
| surface up close | 8 | 0.052 ms (4.9×) | skipped under the disc |
| the limb up close | 6 | 0.080 ms (2.3×) | |
| far out | 0.008 | 0.035 ms | 0.063 ms |

The browser adds a floor of about 0.04 ms a draw, so these read a little high.

### Images (round 4)

All in `C:\Users\Kieran\AppData\Local\Temp\claude\c--Users-Kieran-Desktop-Spacegame\b24c970b-6148-4883-b4f6-ab3b6971e1b5\scratchpad\proto\`.

- **Sun sheets** (current first, round 3's plasma ½ for reference, then round 4: full, ½, lite, rainbow ½,
  aurora ½, and round 3's rainbow for comparison): `r4-sun-<sol|borealis|nebula_prime|cinder_reach>-<full|limb|close>.png`.
- **The edge up close** (current, round 3, round 4 ½, round 4 lite, at the limb):
  `r4-edge-<star>-z0.3.png` and `r4-edge-<star>-z1.png`. Start with `r4-edge-sol-z0.3.png`,
  `r4-edge-nebula_prime-z1.png` and `r4-edge-borealis-z0.3.png`.
- **Animations** (limb at zoom 0.3, 15 s of game time at 3×; current, round 3 ½, round 4 ½, round 4 lite,
  rainbow ½, aurora ½): `r4-anim-sun-<star>.gif`.
- **The lab:** `lab-r4-graph.png` (the live graph through round 3 and round 4 options), `lab-r4-surface-z8.png`
  (beyond the game's zoom).
- **Raw data:** `bench4.final.json`.

To reproduce, run `node scripts/sun-sky-proto/run.mjs <set> <out dir>`, where the set is `v4`, `stills4`, `gif4` or
`bench4`.

# Round 3 (after Kieran's review of round 2)

Kieran's review of round 2:

- The plasma star is very promising, but:
  - its swirls were much larger than the current sun's features;
  - its edge was hard;
  - its middle a little too bright;
  - the Cinder Reach sun didn't read right.
- Try a multicolour look.
- Fix the jagged edge in the half-res options.
- Revisit B with much bigger cells.

What changed:

1. **Feature scale.** Plasma's swirls and filaments are now about the size of the current sun's own fBM features, three
   times finer than round 2 (`uSurf.x` 9.5; flow stars 8, granular 12). Compare `r3-sun-*-full.png` and `-limb.png`.
2. **Soft edge.** The disc fades out over its last 2.5% of radius into a glow that rises through the same band, like
   the current sun's 0.97 to 1.0 fade; detail stars use 80% of their own `edgeThickness`. The flame fringe fades in
   across it too, so nothing draws a line. The limb is still crisp-ish at the widest zoom, and soft close up.
3. **Brightness and colour.**
   - The core glow is lower (detail stars 0.55, was 0.8).
   - A per-star **heat** comes from the brightness of the system's own middle colour, so a dark palette burns dark.
     **Cinder Reach** (the red giant, which Kieran meant by "cinder") now reads as a deep red giant, close to current,
     instead of bright orange. Sol is orange-gold with a warm middle.
   - The blue and pink stars (Borealis, Nebula Prime) keep a near-white hot middle, a touch under the game's.
   - All of it is data: `centralBody.plasma` in systems.json can set `scale`, `warp`, `contrast`, `core`, `heat` and
     `softEdge` per star (`PlasmaParams` in `proto/sunProto.ts`).
4. **Multicolour (per star: `centralBody.plasma.iridescence`).**
   - One more slow field on the ball, a few regions across it, pushed by the warp, picks each place's colour. Colours
     swirl round each other with the flow, and drift slowly.
   - The modes are `rainbow`, or `tints` with two or three colours. Brightness and the white-hot peaks are kept, and
     the corona is tinted the same way.
   - Two examples run on every star in the sheets: **rainbow**, and **aurora** (teal, violet and pink;
     `PLASMA_EXAMPLES` in `scripts/sun-sky-proto/layers.ts`).
   - The cost is one more 3D read per disc pixel: within a few percent of plain plasma.
5. **The jagged edge in "current, half res" isn't the half-res target. It's a bug in the game's sun shader**, visible
   at full res too (`edge/sol.cur.png`).
   - The detail style's rim highlight is `smoothstep(1.0 - edgeThickness, 0.97, sunT)`. With Sol's `edgeThickness`
     of 0.03 both edges are 0.97: undefined in GLSL, a hard step in practice (the disc's brightness jumps 309 → 441 in
     one pixel). Cinder Reach (0.05) doesn't hit it.
   - `withEdgeFix` gives the ramp a width. All the faithful options now use it, and "current (edge fixed) ½"
     (`fix@0.5`) is today's shader with only that fix.
   - For the game, the one-line fix is in `SunRenderer.ts`'s fragment shader:
     `smoothstep(min(brightEdgeStart, 0.955), 0.97, sunT)`.
   - The half-res path itself was fine: linear filtering, premultiplied (`edge/` crops: full and half res show the
     same step; the fixed ones are smooth).
6. **B2, the photosphere with big cells** (`photo2`, `lite2`). Round 1's B with granules 500 world units across
   (was 60), and the smallest cell shown 48 px on screen (was 10), so the cells read at play zooms. It's the
   cheapest star of all (6.5 to 25 times cheaper than current).

**Recommendation (round 3).** Plasma at half resolution (`plasma@0.5`) as the new look, with plasma lite on Low, and
multicolour as a per-system option where it fits the setting. It's 3 to 19 times cheaper than today (4K: 0.8 to
2.1 ms → 0.11 to 0.29 ms), and compiles in about 40 ms instead of 1.8 s. If the look should stay the game's, use
A-exact ½ (`exact@0.5`), with the edge fix.

### Cost, ms per frame (sun, glow and corona; speedup against current; native harness, best of two runs)

"whole" is zoom 0.04, "limb" zoom 0.15, "disc" over the disc at zoom 0.5. 1080p unless marked 4K.

| star | view | current | ALT plasma | ALT plasma lite | ALT plasma ½ | ALT rainbow ½ | ALT aurora ½ | ALT B2 | ALT B2-lite | FAITHFUL A-exact ½ | FAITHFUL current (edge fixed) ½ |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Sol | whole | 0.281 | 0.163 (1.7x) | 0.064 (4.4x) | 0.053 (5.3x) | 0.057 (4.9x) | 0.057 (4.9x) | 0.030 (9.2x) | 0.022 (12.5x) | 0.042 (6.7x) | 0.081 (3.5x) |
| Sol | limb | 0.191 | 0.088 (2.2x) | 0.037 (5.2x) | 0.032 (6.0x) | 0.035 (5.4x) | 0.035 (5.4x) | 0.026 (7.2x) | 0.020 (9.4x) | 0.029 (6.6x) | 0.059 (3.2x) |
| Sol | disc | 0.308 | 0.155 (2.0x) | 0.063 (4.9x) | 0.050 (6.2x) | 0.057 (5.4x) | 0.057 (5.4x) | 0.031 (10.1x) | 0.024 (13.1x) | 0.036 (8.6x) | 0.086 (3.6x) |
| Borealis | whole | 0.364 | 0.076 (4.8x) | 0.062 (5.9x) | 0.032 (11.4x) | 0.035 (10.4x) | 0.035 (10.4x) | 0.028 (13.0x) | 0.021 (17.2x) | 0.040 (9.2x) | 0.104 (3.5x) |
| Borealis | limb | 0.492 | 0.073 (6.8x) | 0.038 (12.9x) | 0.029 (17.0x) | 0.032 (15.2x) | 0.033 (15.1x) | 0.026 (18.9x) | 0.021 (23.8x) | 0.047 (10.6x) | 0.134 (3.7x) |
| Borealis | disc | 0.201 | 0.177 (1.1x) | 0.064 (3.1x) | 0.064 (3.1x) | 0.061 (3.3x) | 0.061 (3.3x) | 0.031 (6.5x) | 0.024 (8.5x) | 0.025 (8.0x) | 0.059 (3.4x) |
| Nebula Prime | whole | 0.460 | 0.185 (2.5x) | 0.068 (6.7x) | 0.076 (6.0x) | 0.076 (6.1x) | 0.076 (6.0x) | 0.043 (10.7x) | 0.024 (19.2x) | 0.043 (10.8x) | 0.127 (3.6x) |
| Nebula Prime | limb | 0.385 | 0.090 (4.3x) | 0.037 (10.4x) | 0.033 (11.7x) | 0.036 (10.7x) | 0.036 (10.7x) | 0.033 (11.8x) | 0.021 (18.8x) | 0.043 (9.0x) | 0.108 (3.6x) |
| Nebula Prime | disc | 0.518 | 0.206 (2.5x) | 0.064 (8.1x) | 0.079 (6.5x) | 0.081 (6.4x) | 0.080 (6.5x) | 0.045 (11.6x) | 0.024 (21.7x) | 0.042 (12.4x) | 0.139 (3.7x) |
| Cinder Reach | whole | 0.312 | 0.242 (1.3x) | 0.066 (4.7x) | 0.082 (3.8x) | 0.080 (3.9x) | 0.080 (3.9x) | 0.030 (10.2x) | 0.024 (13.3x) | 0.036 (8.6x) | 0.087 (3.6x) |
| Cinder Reach | limb | 0.202 | 0.089 (2.3x) | 0.037 (5.4x) | 0.033 (6.2x) | 0.036 (5.6x) | 0.036 (5.5x) | 0.028 (7.1x) | 0.021 (9.7x) | 0.030 (6.8x) | 0.061 (3.3x) |
| Cinder Reach | disc | 0.311 | 0.182 (1.7x) | 0.064 (4.9x) | 0.058 (5.4x) | 0.064 (4.9x) | 0.064 (4.8x) | 0.031 (10.0x) | 0.024 (13.0x) | 0.035 (8.8x) | 0.087 (3.6x) |
| Sol | whole 4K | 1.125 | 0.548 (2.1x) | 0.231 (4.9x) | 0.200 (5.6x) | 0.201 (5.6x) | 0.201 (5.6x) | 0.118 (9.5x) | 0.089 (12.7x) | 0.137 (8.2x) | 0.318 (3.5x) |
| Sol | limb 4K | 0.755 | 0.324 (2.3x) | 0.143 (5.3x) | 0.122 (6.2x) | 0.135 (5.6x) | 0.135 (5.6x) | 0.104 (7.3x) | 0.080 (9.4x) | 0.108 (7.0x) | 0.227 (3.3x) |
| Sol | disc 4K | 1.241 | 0.587 (2.1x) | 0.254 (4.9x) | 0.192 (6.5x) | 0.218 (5.7x) | 0.218 (5.7x) | 0.124 (10.0x) | 0.093 (13.4x) | 0.138 (9.0x) | 0.344 (3.6x) |
| Borealis | whole 4K | 1.424 | 0.260 (5.5x) | 0.181 (7.9x) | 0.109 (13.1x) | 0.124 (11.5x) | 0.125 (11.4x) | 0.106 (13.4x) | 0.082 (17.3x) | 0.149 (9.5x) | 0.398 (3.6x) |
| Borealis | limb 4K | 1.971 | 0.269 (7.3x) | 0.144 (13.7x) | 0.106 (18.6x) | 0.119 (16.6x) | 0.119 (16.6x) | 0.101 (19.5x) | 0.080 (24.6x) | 0.178 (11.1x) | 0.524 (3.8x) |
| Borealis | disc 4K | 0.804 | 0.601 (1.3x) | 0.255 (3.1x) | 0.216 (3.7x) | 0.233 (3.5x) | 0.233 (3.5x) | 0.122 (6.6x) | 0.092 (8.7x) | 0.097 (8.3x) | 0.235 (3.4x) |
| Nebula Prime | whole 4K | 1.833 | 0.652 (2.8x) | 0.259 (7.1x) | 0.225 (8.2x) | 0.222 (8.3x) | 0.223 (8.2x) | 0.128 (14.4x) | 0.092 (19.9x) | 0.160 (11.5x) | 0.492 (3.7x) |
| Nebula Prime | limb 4K | 1.520 | 0.329 (4.6x) | 0.143 (10.6x) | 0.123 (12.4x) | 0.136 (11.2x) | 0.137 (11.1x) | 0.114 (13.3x) | 0.081 (18.8x) | 0.161 (9.4x) | 0.415 (3.7x) |
| Nebula Prime | disc 4K | 2.067 | 0.819 (2.5x) | 0.263 (7.9x) | 0.242 (8.5x) | 0.261 (7.9x) | 0.262 (7.9x) | 0.144 (14.3x) | 0.093 (22.2x) | 0.161 (12.8x) | 0.551 (3.8x) |
| Cinder Reach | whole 4K | 1.249 | 0.502 (2.5x) | 0.259 (4.8x) | 0.285 (4.4x) | 0.271 (4.6x) | 0.272 (4.6x) | 0.119 (10.5x) | 0.092 (13.6x) | 0.139 (9.0x) | 0.346 (3.6x) |
| Cinder Reach | limb 4K | 0.789 | 0.330 (2.4x) | 0.145 (5.4x) | 0.123 (6.4x) | 0.136 (5.8x) | 0.137 (5.8x) | 0.113 (7.0x) | 0.081 (9.7x) | 0.112 (7.0x) | 0.234 (3.4x) |
| Cinder Reach | disc 4K | 1.243 | 0.725 (1.7x) | 0.254 (4.9x) | 0.217 (5.7x) | 0.244 (5.1x) | 0.244 (5.1x) | 0.143 (8.7x) | 0.094 (13.2x) | 0.138 (9.0x) | 0.345 (3.6x) |

The lab's live graph agrees on the steps: Cinder Reach limb, 1600×900, current 0.133 to 0.143 ms. It measured:

| option | live cost |
|---|---|
| plasma ½ | 0.040 ms (3.6×) |
| plasma lite | 0.035 ms (4.0×) |
| aurora ½ | 0.047 ms (2.9×) |
| B2 | 0.025 ms (5.6×) |
| current (edge fixed) ½ | 0.065 ms (2.2×) |

The browser adds a floor of about 0.04 ms a draw, so the cheapest options read a little high there.

### How far each looks from current (mean difference, 0 to 255 a channel)

These are new looks, so the alternatives' numbers say how different they are, not how good. The faithful columns
should be small.

| star | view | ALT plasma | ALT plasma lite | ALT plasma ½ | ALT rainbow ½ | ALT aurora ½ | ALT B2 | ALT B2-lite | FAITHFUL A-exact ½ | FAITHFUL current (edge fixed) ½ |
|---|---|---|---|---|---|---|---|---|---|---|
| Sol | full | 5.7 | 5.8 | 5.7 | 8.9 | 11.2 | 8.1 | 7.8 | 2.2 | 0.3 |
| Sol | limb | 37.3 | 37.4 | 37.3 | 57.1 | 69.3 | 31.3 | 27.2 | 11.4 | 1.3 |
| Sol | close | 63.0 | 52.5 | 63.1 | 83.3 | 87.9 | 63.5 | 62.4 | 8.6 | 0.8 |
| Borealis | full | 5.1 | 5.3 | 5.0 | 7.2 | 5.9 | 5.5 | 5.3 | 2.3 | 0.3 |
| Borealis | limb | 27.1 | 24.7 | 26.9 | 40.1 | 35.1 | 32.5 | 29.4 | 6.9 | 0.4 |
| Borealis | close | 52.6 | 58.5 | 52.5 | 51.9 | 50.0 | 71.9 | 84.3 | 1.3 | 0.2 |
| Nebula Prime | full | 5.3 | 5.3 | 5.2 | 7.2 | 7.8 | 5.7 | 5.6 | 2.7 | 0.5 |
| Nebula Prime | limb | 27.9 | 27.3 | 27.8 | 34.3 | 36.9 | 33.7 | 32.1 | 4.7 | 0.4 |
| Nebula Prime | close | 66.5 | 72.9 | 66.4 | 62.5 | 67.5 | 85.5 | 112.8 | 0.9 | 0.2 |
| Cinder Reach | full | 4.3 | 4.5 | 4.2 | 6.2 | 7.2 | 7.8 | 7.0 | 1.7 | 0.2 |
| Cinder Reach | limb | 35.4 | 38.5 | 35.5 | 46.9 | 53.6 | 38.9 | 21.7 | 3.6 | 0.2 |
| Cinder Reach | close | 43.4 | 30.3 | 43.4 | 46.6 | 46.8 | 45.8 | 37.1 | 2.3 | 0.3 |

### Images (round 3)

All in `C:\Users\Kieran\AppData\Local\Temp\claude\c--Users-Kieran-Desktop-Spacegame\b24c970b-6148-4883-b4f6-ab3b6971e1b5\scratchpad\proto\`.

- **Sun sheets** (current first, then the plasma alternative, its multicolour examples, B2, then the two closest
  faithful options): `r3-sun-<sol|borealis|nebula_prime|cinder_reach>-<full|limb|close>.png`. Start with
  `r3-sun-cinder_reach-full.png` and `r3-sun-sol-limb.png`.
- **Sun animations** (limb at zoom 0.3, 15 s of game time at 3×; current, plasma ½, plasma lite, rainbow ½,
  aurora ½, A-exact ½): `r3-anim-sun-<star>.gif`.
- **The edge bug:** `edge/sol.cur.png`, `edge/sol.cur@0.5.png`, `edge/sol.fix@0.5.png`, `edge/sol.exact@0.5.png`
  (1600×900, the limb at zoom 0.15).
- **The lab:**
  - `lab-r3-cinder-graph.png`: the live graph through six options on Cinder Reach;
  - `lab-r3-nebula-rainbow.png`;
  - `lab-r3-sol-plasma.png`.
- **Raw data:** `bench3.final.json`, `stills3.results.json`.

To reproduce, run `node scripts/sun-sky-proto/run.mjs <set> <out dir>`, where the set is `stills3`, `gif3`, `bench3`
or `edge`. Every option is in the lab's Sun menu.

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
