# Planet prototypes (2026-10-31)

Prototype shaders for the planets, moons and the brown dwarf as seen from space (not the sun, and not the surface
views). **Nothing in the game uses them yet**: they live in `client/src/rendering/planet-proto/`, the live lab
`client/planetlab.html` (dev server only, not a build input) and the native harness `scripts/planet-proto/`.

Kieran's brief: "the gas giants still have a hard edge, it needs to be softened with some kind of edge effect, and
check if there's improvements that can be made to the effect itself."

## Recommendation

**Adopt the prototype, with its lite variant on the Low tier.** It fixes the hard edge on every planet that has an
atmosphere, keeps each world's colours and kind, and is cheaper than today wherever planets cover much of the screen:

- **Native** (the GPU's own cost): gas giants 2.6 to 3.0 times cheaper close up, toxic 2.3 to 2.5, desert and ocean
  1.9 to 2.4, rocky 1.4 to 1.8, ice and lava 1.0 to 1.2.
- **In the browser** (the game's real path, ANGLE on D3D11): 1.2 to 3.3 times cheaper close up, on every kind.
- **Small on screen** (whole-planet views): about the same as today, a few hundredths of a millisecond either way.

Before adopting, review the looks in the lab. In particular:

- the gas giants' cloud texture up close (it's swirly rather than finely streaked past zoom 0.5);
- the brown dwarf (softer and less contrasty than today's, which has bolder glowing cracks).

## What was wrong with the edge (the current shader)

Read straight off `PlanetRenderer.ts` and confirmed in the stills (`planet-sheet-gas.png`, the "current" limb crops):

1. **Gas giants: a hard outer line.** The haze outside the limb is computed only for `r < 1.3`, and at the giants'
   haze strength it is still visible there, so it stops dead in a sharp circle at 1.3 radii. That is the hard edge
   Kieran sees: a flat, uniform band with a crisp outside.
2. **Gas giants: a dark ring on the night side.** The disc goes nearly black at night while the haze around it keeps
   30% of its colour, so the haze reads as a separate ring.
3. **Every other world with air (ocean, ice, toxic, lava): a thin dark line between the disc and its glow.** The disc
   anti-aliases to transparent over its last 1.5% of radius while the glow only starts at `r = 1`, leaving a gap.
4. **Rings shimmer far out.** The fine ringlets are `sin(t * 340)`, far finer than a pixel at the game's widest zoom, so
   they moiré as the planet moves. The planet's shadow on the rings is a hard on/off cut.

## What the prototype does

One fragment body for every planet, moon and the brown dwarf (`PLANET_PROTO_FRAG` in `planetProto.ts`). It runs on the
same `shaderQuad` as today (the same quad, the same premultiplied output, `GLSL_COMMON` prepended) plus one texture.

### The edge (all kinds)

- **An atmosphere with thickness.** Each planet has three numbers:
  - **the limb's optical depth** (how hazy the edge is);
  - **a scale height** (how thick the air is, in planet radii);
  - **a twilight wrap** (how far round the night side the sunlight reaches the air).
- **The haze.** Outside the disc it falls off with height. Over the disc it follows the view path through the shell:
  thin face-on, as thick as the outside at the limb. So the disc's edge fades into the same haze that carries on into
  space. There is no alpha fade to nothing and no gap.
- **The disc edge.** It is at least 1.5 px wide at any zoom (from `fwidth`), and wider for gas giants, whose cloud tops
  thin over the last 1.2% of radius. Otherwise every width is in world units, so the look doesn't change with zoom.
- **The terminator.** The day/night line is a soft knee whose width follows the air's thickness: crisp on airless
  rocks, wide on giants. Light near the terminator is reddened by a per-planet sunset colour, and so is the haze there.
- **Limb darkening.** Gas giants are limb-darkened under the haze (the deck seen through more of itself toward the edge).
- **Airless worlds** (rocky, moons) keep a crisp but anti-aliased limb with almost no haze, as they should.

### Gas giants (and the toxic world's deck, and the brown dwarf)

- **Belts and zones.** Each band has its own brightness and tint (hashed per band), not a sine wave, with dark lanes
  where a pale zone meets a dark belt.
- **Jets that flow.** Each latitude moves at its own speed, alternating east and west, strongest at the equator. Two
  flow phases are cross-faded so the pattern moves steadily without ever smearing out; today's bands only sway.
- **Turbulence.** It is torn hardest along the shear lines between bands, mostly along the flow. Small pale and dark
  vortices sit on the shear lines.
- **A great storm on every giant.** It is an oval with its own colour, a pale collar and a turning spiral inside. The
  cloud spirals into it and the bands bow round it, and it drifts with its own band's jet:
  - Jovan: a red spot;
  - Cinderjack: a dark storm;
  - Boreas Major: a dark spot;
  - Ember Giant: a pale storm;
  - Opaline: a magenta storm.
- **White ovals.** A string of small ovals runs in one band (Jovan, Opaline).
- **Polar hoods.** The poles are hazier, cooler and mottled. They are read on the sphere, so there is no pinch at the pole.
- **The brown dwarf.**
  - It lights itself, with heat glowing up through the thin parts of the deck.
  - It keeps its lore scar: the fractures running out from the hot point on the equator.
  - It has an ember haze round it.

### Solid worlds

- **Relief lit by the star.** The height is read again one step toward the star, so craters, canyons, ridges and lineae
  catch light on one side and shade on the other. This shows strongly because the star is nearly edge-on.
- **Rocky (and the moons).** Highlands and dark maria, with craters at two sizes (bowl and raised rim) and bright young
  crater floors.
- **Desert.**
  - sand seas with dunes (when close);
  - dark rock in canyons cut along cell edges where the ground is low;
  - mesas;
  - frost caps.
- **Ice.** White and blue sheets with ridged lineae in the planet's own crack colour (Nereid's and Prism's blue lines
  kept), and finer cracks when close.
- **Lava.**
  - glowing rivers in a coarse crack network round dark crust plates, with fine cracks between;
  - a slow pulse;
  - the glow strongest on the night side, lighting the planet's own haze.
- **Ocean.**
  - continents and coastal shallows;
  - land coloured by latitude;
  - ice caps;
  - sun glint on open water;
  - cloud systems that drift on their own and cast shadows beside them.
- **Toxic.** A thick swirling deck under deep haze.

### Rings

- **Profile.** The radial profile comes from the noise at three scales, so its mipmaps average the fine ringlets far
  out: no moiré. The gaps stay where the game's are.
- **Transparency.** Rings are see-through where thin (opacity from optical depth), with soft inner and outer edges.
- **The planet's shadow.** It has a penumbra that widens away from the planet.
- **Clumping.** There is faint clumping along the orbit.

### Data-driven looks

`PlanetLook` (in `planetProto.ts`) is the whole look as data:

- the palette (three colours);
- the atmosphere colour and sunset colour;
- the atmosphere numbers and the limb numbers;
- the detail scale and cloud cover;
- the bands (count, turbulence, jet speed);
- the great storm (position, size, colour) and the white ovals;
- the emission colour, the spin and the rings.

Where the values come from:

- `kindLook(kind, hue, seed)` gives each kind's defaults from the planet's hue in `systems.json`, so every planet keeps
  its colour.
- `PLANET_TUNING` overrides individual planets by id (Jovan's red spot, Cinderjack's sooty wild bands, Boreas Major's
  dark spot, Ember Giant's deep reds).
- In the game, those overrides would become a `look` on the planet (and on `centralBody` for the brown dwarf).

### The noise

One tileable 64³ RGBA8 volume (`planetNoise.ts`, about 0.5 s to bake, 1 MB):

- two fbm fields (4 and 3 octaves);
- Worley F1 (craters and cells);
- Worley F2 − F1 (cracks, canyons and lineae).

It is read on the sphere (no seam, no pole pinch) or in longitude and latitude (bands and rings), and mipmapped.

A solid world uses 4 to 6 reads a pixel (2 more when close), a gas giant 4 to 5 (2 more when close), and rings 4.

**Every read uses an explicit mip level** (`textureLod`, from the pixel's footprint in planet radii). This matters a
great deal in the browser. ANGLE's HLSL backend can't keep a real branch round a `texture()` call (it needs
derivatives), so it flattens the branch. With plain `texture()` the shader paid for every kind's code, the rings and
every optional detail read on every pixel. In the browser that made the prototype only as cheap as today; with
`textureLod` it is 1.2 to 3.3 times cheaper. (Native OpenGL doesn't flatten, so the explicit levels cost a little
there on small discs; see the tables.)

### Lite (for the Low tier)

`#define PLANET_LITE`:

- one flow phase instead of two;
- no relief read;
- no fine octaves;
- no polar mottling.

It looks nearly the same from mid zoom out, and costs 10 to 30% less than the full prototype.

## Cost

### Native (moderngl on an RTX 5070 Ti, GPU timer queries)

Median of 5 runs of 10 draws each. The current shader is read from `PlanetRenderer.ts` and set up as `PlanetRenderer`
sets it up; the brown dwarf's current shader comes from `CentralBodyShaders.ts`.

The views at 1920×1080:

- **far:** zoom 0.04, the widest flight zoom;
- **mid:** the whole planet about 900 px across;
- **limb:** zoom 1 on the lit limb;
- **surface:** zoom 2 over the disc, the closest flight zoom.

Each cell is the mean over that kind's bodies, in ms per frame, with the speedup against current in brackets.

| kind | view | current | prototype | lite |
|---|---|---|---|---|
| gas (5 giants) | far | 0.043 | 0.025 (1.7×) | 0.017 (2.5×) |
| gas | mid | 0.036 | 0.023 (1.5×) | 0.016 (2.2×) |
| gas | limb | 0.193 | 0.070 (2.8×) | 0.061 (3.1×) |
| gas | surface | 0.231 | 0.077 (3.0×) | 0.069 (3.4×) |
| brown dwarf | far (fills the screen) | 0.076 | 0.082 (0.9×) | 0.048 (1.6×) |
| brown dwarf | limb | 0.104 | 0.070 (1.5×) | 0.060 (1.7×) |
| toxic | limb | 0.098 | 0.042 (2.3×) | 0.040 (2.5×) |
| toxic | surface | 0.160 | 0.064 (2.5×) | 0.059 (2.7×) |
| ocean | mid | 0.037 | 0.036 (1.0×) | 0.023 (1.6×) |
| ocean | limb | 0.107 | 0.058 (1.9×) | 0.038 (2.8×) |
| ocean | surface | 0.163 | 0.070 (2.3×) | 0.050 (3.3×) |
| desert | mid | 0.029 | 0.022 (1.3×) | 0.014 (2.2×) |
| desert | limb | 0.079 | 0.038 (2.1×) | 0.028 (2.8×) |
| desert | surface | 0.130 | 0.053 (2.4×) | 0.043 (3.0×) |
| rocky | mid | 0.023 | 0.023 (1.0×) | 0.014 (1.7×) |
| rocky | limb | 0.053 | 0.037 (1.4×) | 0.025 (2.2×) |
| rocky | surface | 0.096 | 0.055 (1.8×) | 0.040 (2.4×) |
| ice | mid | 0.015 | 0.024 (0.6×) | 0.017 (0.9×) |
| ice | limb | 0.045 | 0.044 (1.0×) | 0.032 (1.4×) |
| ice | surface | 0.072 | 0.060 (1.2×) | 0.044 (1.6×) |
| lava | mid | 0.017 | 0.029 (0.6×) | 0.020 (0.8×) |
| lava | limb | 0.044 | 0.046 (1.0×) | 0.035 (1.3×) |
| lava | surface | 0.073 | 0.061 (1.2×) | 0.046 (1.6×) |
| moons | surface | 0.048 | 0.040 (1.2×) | 0.026 (1.9×) |

At 4K the ratios are the same: Jovan's limb goes 0.743 → 0.272 ms, and Cinderjack over the disc 0.925 → 0.299 ms.

Notes on the table:

- Most "far" figures are below 0.003 ms (the planet is a few pixels across), so their ratios are noise.
- The worst cases are ice and lava as a mid-sized disc: 0.015 → 0.024 ms. That is a hundredth of a millisecond, and in
  the browser (below) these views are about even.

Every row (every body, 1080p and 4K) is in `bench.json`. Summarise it with `python sumbench.py bench.json` (both in the
scratchpad folder below).

### In the browser (the planet lab, Chrome, ANGLE on D3D11, same GPU)

Timed by the lab as the sun lab times its options: the uniforms are set once, the draw is repeated, and a forced sync
comes before and after. Each figure is the median of 2 s. The views are 1920×1080: "whole", "close" (zoom 1 on the lit
limb) and "surface" (zoom 2).

| body | view | current | prototype | lite |
|---|---|---|---|---|
| Jovan (gas, rings) | whole | 0.028 | 0.020 (1.4×) | 0.018 (2.1×) |
| Jovan | close | 0.098 | 0.040 (2.4×) | 0.033 (3.1×) |
| Jovan | surface | 0.238 | 0.073 (3.3×) | 0.065 (3.4×) |
| Ember Giant | close | 0.100 | 0.042 (2.4×) | 0.040 (2.5×) |
| Ember Giant | surface | 0.219 | 0.070 (3.1×) | 0.070 (3.5×) |
| Ashfall brown dwarf | surface | 0.108 | 0.060 (1.8×) | 0.050 (2.0×) |
| Terra Nova (ocean) | whole | 0.043 | 0.037 (1.1×) | 0.022 (1.8×) |
| Terra Nova | close | 0.092 | 0.045 (2.1×) | 0.030 (2.6×) |
| Terra Nova | surface | 0.172 | 0.063 (2.8×) | 0.050 (3.4×) |
| Vesta (rocky) | close | 0.043 | 0.028 (1.5×) | 0.018 (2.7×) |
| Vesta | surface | 0.102 | 0.053 (2.0×) | 0.035 (3.1×) |
| Nereid (ice, rings) | whole | 0.013 | 0.020 (0.6×) | 0.010 (1.0×) |
| Nereid | close | 0.040 | 0.030 (1.3×) | 0.022 (1.8×) |
| Nereid | surface | 0.078 | 0.055 (1.4×) | 0.040 (2.1×) |
| Kindle (lava) | whole | 0.020 | 0.030 (0.7×) | 0.022 (0.9×) |
| Kindle | close | 0.037 | 0.033 (1.2×) | 0.028 (1.1×) |
| Kindle | surface | 0.080 | 0.050 (1.6×) | 0.042 (1.8×) |
| Verdance (toxic) | close | 0.078 | 0.027 (2.8×) | 0.015 (4.5×) |
| Verdance | surface | 0.169 | 0.053 (3.2×) | 0.053 (3.7×) |

Caveats:

- The browser's figures under about 0.03 ms are rough: its timing floor, and a 2 s median over samples from the
  previous view.
- The brown dwarf's "close" view is mostly empty space for today's shader (0.007 ms) and so isn't comparable.

**How the browser numbers were found.**

1. The first version of the lab re-sent all 26 uniforms on every repeat, so it mostly timed ANGLE's CPU-side
   validation (about 0.1 ms a draw). It now sets them once.
2. That still left the prototype near 0.07 to 0.1 ms in every view. Plain `texture()` calls made ANGLE flatten the
   branches (see "The noise").
3. Both are fixed in the numbers above.

## The planet lab

**The sun lab now shows the planets too** (<http://localhost:5273/sunlab.html>, `docs/rendering/sun-sky-prototypes.md`,
"Running it"): the whole system as the game lays it out, the star and its sky with every planet and moon at its orbit
position, lit from the star, the planet prototype the default look (prototype lite and current selectable; Space
shows the current shaders), the same view presets about any body, and the planets' cost as a third plot in the live
graph. For example `sunlab.html?body=jovan&view=limb`, `sunlab.html?system=ashfall&view=whole` (the brown dwarf).
The planet lab below still works, for a body alone with the light's direction on a slider.

<http://localhost:5273/planetlab.html> (dev server only; nothing to start beyond Vite).

- **Pick a body:** any planet, moon or the Ashfall brown dwarf, grouped by system and labelled with kind and rings.
- **Pick a look:** prototype, prototype lite or current. **Hold Space** to see the current shader in place.
- **Views:**
  - whole;
  - the lit limb up close;
  - the limb at the terminator;
  - the widest game zoom;
  - the limb at zoom 1;
  - the surface at zoom 2;
  - beyond the game: the surface and the limb far closer, and far out at zoom 0.004.
- **The zoom slider** runs 0.002 to 40 on a log scale, with the game's 0.04 to 2 shaded. The wheel goes as far.
- **Other controls:** the sun's direction, the speed of time (to watch the jets flow and storms turn) and the resolution.
- **Live cost graph:** the shown look (solid) against the current shader (dashed) over the last 30 s, with a labelled
  marker for every change (look, body, view, resolution, Space, crossing the game's zoom limits, the sun's direction).
- **URL params:** `?body=<id>&view=<preset>&look=proto|proto.lite`, for example
  `planetlab.html?body=jovan&view=limb`. Moons are `<planet>.moon<i>`; the brown dwarf is `ashfall.dwarf`.

It draws the same layers as the native harness (`scripts/planet-proto/layers.ts`), with a small WebGL2 runner.

## The native harness

```bash
node scripts/planet-proto/run.mjs <set> <out dir>
```

The sets:

- **`verify`:** current and prototype, whole and lit limb, for one body of each kind;
- **`stills`:** comparison sheets per kind (current first; whole, lit limb and terminator limb);
- **`edges`:** the edge crops only;
- **`bench`:** every body in four views at 1080p, and one of each kind at 4K, for current, prototype and lite;
- **`gif`:** the animations;
- **`panels`:** clean before/after pictures, with nothing overlaid.

How it works:

- It reads the game's planet and brown dwarf shaders from their TypeScript each run, so it can't drift from them.
- `harness.py` is a copy of the sun prototypes' moderngl harness, kept apart so the two prototypes can change
  independently.
- The stills set the time so each giant's great storm faces the star, through `showTime` in `scenes.ts`, which mirrors
  the shader's jet.

## Images

All in `C:\Users\Kieran\AppData\Local\Temp\claude\c--Users-Kieran-Desktop-Spacegame\b24c970b-6148-4883-b4f6-ab3b6971e1b5\scratchpad\planet\`.

**Comparison sheets** (current first, then prototype; whole, the lit limb up close, the limb at the terminator up
close): `planet-sheet-<kind>.png`, where the kind is gas, dwarf, rocky, desert, ice, lava, ocean, toxic or moons.
Start with `planet-sheet-gas.png`.

**Animations** (current left, prototype right; game time sped up):

- `planet-anim-jovan-whole.gif`
- `planet-anim-jovan-storm.gif`
- `planet-anim-opaline-storm.gif`
- `planet-anim-terra_nova-whole.gif`
- `planet-anim-ashfall-dwarf-whole.gif`
- `planet-anim-kindle-limb.gif`

**Single frames:** `stills/<body>.<whole|limb|term>.<cur|proto>.png`.

**The lab:**

- `lab-jovan-limb.png` (prototype, with the live graph);
- `lab-jovan-limb-space.png` (Space held: current);
- `lab-graph.png` (markers for Space, the look and the view; zoom 6, beyond the game);
- `lab-terra-nova.png`.

**Raw data:**

- `bench.json` (native) and `sumbench.py`;
- `labbench2.log` (browser, final);
- `labbench.log` and `labbench.json` (the earlier browser runs that found the two measuring and flattening problems).

**Panels** (clean before/after, nothing overlaid): `docs/panels/2026-10-31/graphics/prototype-planets-*.png`, listed in
`docs/panels/index.md`.

## How to adopt

1. **Move the files.** Move `planet-proto/planetProto.ts` and `planetNoise.ts` into `client/src/rendering/` (or keep
   the folder). Make `PlanetRenderer`'s `FRAGMENT` the prototype's body and `planetUniforms` the prototype's
   `planetProtoUniforms(lookFor(planet, seed), kind, seed, extent)`. Every uniform is a float, vec2 or vec3 (shaderQuad's
   types).
2. **Upload the 3D noise in Pixi.**
   - Pixi 8.16 maps a `TextureSource` with `viewDimension: '3d'` to `TEXTURE_3D` (`mapViewDimensionToGlTarget`), and
     `GlTextureSystem` uses a registered uploader by `uploadMethodId`.
   - Add a small source with `uploadMethodId = 'volume3d'`, and register
     `renderer.texture._uploads.volume3d = { id: 'volume3d', upload(src, glTex, gl) { gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, 64, 64, 64, 0, gl.RGBA, gl.UNSIGNED_BYTE, src.resource); gl.generateMipmap(gl.TEXTURE_3D); } }`.
   - Give it a repeat, trilinear sampler, and pass it to the quad's `Shader` as `uNoise`. `createShaderQuad` needs an
     optional extra-resources argument.
   - This is not yet tried inside Pixi. If it fights back, pack the 64 slices into a 512×512 2D atlas and blend two
     slices in `tn()` (two reads each; the lab can time it).
3. **Bake through the asset cache.** Bake the noise with `assetKind<Uint8Array>('planetNoise3', PLANET_NOISE_VERSION)`
   in `proceduralWorker.ts` (about 0.5 s once, then cached).
4. **Low tier.** On the Low tier compile the same body with `#define PLANET_LITE` (a second program).
5. **Compile ahead.** Add both programs to `gameShaders.ts`.
6. **The brown dwarf.** Draw it with the planet program (`kind: 'dwarf'`, light amount 1, quad ±1.6 radii) in place of
   `CentralBodyShaders`' `BROWN_DWARF`. Keep the black hole and the pulsar as they are.
7. **Data.**
   - Add an optional `look?: Partial<PlanetLook>` to `PlanetData` (and to the central body) in place of
     `PLANET_TUNING`, then move those five entries into `systems.json`.
   - Moons stay rocky and ice in turn, as today.
   - Their own `look` can come later.
8. **Leave the rest.** The labels, culling and orbit code are unchanged.
9. **Before calling it done.** Check a gas giant at the widest and the closest zooms in the real game, with bloom on: the
   lit haze is bright enough to bloom a little.

## Known limits

- **Gas-giant cloud up close.** Past zoom 0.5 it is swirly rather than finely streaked: the turbulence is domain-warped
  noise, not a flow simulation. More band-aligned octaves would help, at one or two more reads.
- **The brown dwarf** is softer and less contrasty than today's. If Kieran prefers the old bold look, raise its belt
  contrast and heat in `kindLook('dwarf')`.
- **Small discs.** Natively, ice and lava cost slightly more than today as a mid-sized disc (a hundredth of a ms); in
  the browser they are about even.
- **Ring geometry.** The rings are still drawn face-on round a planet whose bands are drawn as if seen from its equator
  (as today), so the rings cast no shadow on the planet. A tilted ring would need geometry this quad doesn't have.
