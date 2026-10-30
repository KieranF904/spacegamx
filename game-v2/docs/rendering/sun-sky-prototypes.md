# Sun and sky prototypes (2026-10-31)

Prototype shaders for the star and the sky that are cheaper than today's and (for the star) look better. **Nothing in
the game uses them yet**: they live in `client/src/rendering/proto/`, the live lab page `client/sunlab.html` (dev server
only, not a build input) and the native harness `scripts/sun-sky-proto/`. Every number below was measured with that
harness on the real GPU (RTX 5070 Ti, moderngl, GPU timer queries, best of two runs of 5×10 draws) unless it says
otherwise, against the game's own shaders read from its TypeScript, set up the way `Renderer` sets them up for each
system.

## Recommendation

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
