# Graphics renderer audit, 2026-11-06

Question: is it worth moving off Pixi's current renderer to WebGPU, or to direct GPU code (custom WebGL2/WebGPU) for particles, bullets and ship hulls?

Short answer: no to both, for now. The game already does most of what a direct-GPU rewrite would do (pooled particle containers, chunked hull meshes placed in the shader). A direct instanced path is still 2.5 to 4x less CPU in the bench, but the saving is a fraction of a millisecond at the object counts the game actually draws. Profile the real game before spending any effort here.

(An earlier version of this audit was written against an old base commit and compared against per-object Graphics. That comparison is kept below as "old pattern", but it is not what the game does.)

## Current state (refactor/split head)

- Pixi 8.16.0. `Game.ts` `init()`: `new Application().init({... antialias: PROFILES[tier].msaa, resolution: renderResolution(), autoDensity, eventFeatures off})`. No `preference`, so Pixi picks WebGL. MSAA comes from the quality profile.
- Effects and tracers: `rendering/particlePool.ts`. One `ParticleContainer` per pool (`isRenderGroup`), `Particle` objects reused (`begin/take/end`, spares kept up to 4096), all properties dynamic, one draw for the whole pool. Because Pixi particles share one texture, it swaps in its own GLSL shader that picks one of up to 4 textures per particle (index carried in the u coordinate). The "more than 4 textures" error is that limit. A second shader draws rings and discs per pixel. `spritePool.ts` is the older sprite version with trimming. Shield bubbles got their own pool for the same texture-count reason. `weapons/WeaponFx.ts`, `fxTextures.ts`, `ships/DamageFx.ts` and the thruster/beam effects feed these pools. `rendering/gfx.ts` (`clearIfDrawn`) avoids rebuilding empty Graphics.
- Ship hulls: `rendering/lighting/ShipBatch.ts`. Up to 32 hulls (`PER_CHUNK`) share one merged mesh and one draw; each hull is placed by the vertex shader from a `uXform` uniform array, lit per vertex, damage in a small per-chunk texture. Nearby ships share a chunk, off-screen chunks are skipped, far chunks use a simplified hull, geometry rebuilds are rate-limited. Asteroids use the same scheme (`AsteroidBatch`). Hulls are built in a worker.
- Bloom: `rendering/Bloom.ts`. The glow layers are replayed into a quarter-size render texture, blurred there, and added over the scene. About one sixteenth of the pixels, so cheap.
- All of the above uses custom GLSL `GlProgram`s (`particlePool`, `ShipBatch`, `litShader`, sun/corona/nebula/starfield, bloom blur). Nothing here is WebGPU-ready without a WGSL port of each.

## Measurements

Demo: `prototypes/gfx-bench/`. Same CPU simulation in every mode, so only submission differs. Scene: P additive soft particles, B bullets, K hulls of 4 parts. 1280x720, 120 frames after 40 warm-up, vsync and frame cap off, headless Chrome 156 on Windows 11 with an NVIDIA Blackwell GPU. Other agents were using the machine, so read the ratios within the run, not the absolute numbers. The GPU runs async and the cap is off, so these are essentially CPU costs; GPU fill cost is not captured (and bloom, lighting and MSAA are not in the demo).

Modes:
- (a) Pixi WebGL as the game does it: two `ParticleContainer`s (particles, bullets) with reused `Particle`s, hulls as 32-per-chunk merged meshes placed by a `uXform` uniform array. Simplification: Pixi's default particle shader with one texture, not the game's 4-texture shader (same per-particle CPU work).
- (b) Pixi WebGPU preference: same particle containers. The game's custom GLSL can't run on WebGPU, so hulls fall back to a Container of Graphics parts (slower than (a)'s hulls; an unfair comparison on the hull part only, which is the point: it shows the porting cost).
- (c) Direct WebGL2: one instanced draw each for particles, bullets and hull parts (hull parts = K x 4 instances).
- old pattern: per-object Graphics for bullets and Container-of-Graphics hulls, plain Sprites for particles.

CPU ms per frame (frame ms in brackets; p95 not shown):

| P / B / K | (a) Pixi WebGL, game pattern | (b) Pixi WebGPU | (c) Direct WebGL2 | old pattern |
|---|---|---|---|---|
| 1k / 200 / 30 | 0.10 (0.31) | 0.16 (0.91) | 0.04 (0.24) | 0.20 (0.35) |
| 10k / 1k / 100 | 0.35 (0.73) | 0.71 (1.40) | 0.13 (0.31) | 1.23 (1.40) |
| 50k / 5k / 300 | 1.56 (2.77) | 8.22 (9.62) | 0.50 (0.68) | 7.67 (7.99) |
| 100k / 10k / 300 | 4.28 (6.54) | 13.7 (17.9), p95 37.6 | 0.96 (1.13) | 26.8 (27.7), p95 47.5 |

Draw calls: (a) 3 to 12 (chunks of 32 hulls, 2 particle layers), (b) 3, (c) 3, old pattern 2 (Pixi batches Graphics well; draw count was never the cost).

Reading it:
- The game's pattern is already 3 to 6x cheaper than the old per-object pattern at 10k to 100k objects.
- Direct instanced is a further 2.7x (10k), 3.1x (50k), 4.5x (100k) cheaper than (a) in CPU. In absolute terms: 0.2 ms saved at 10k particles, about 1 ms at 50k, 3.3 ms at 100k.
- The game's pool spare cap is 4096 and a busy scene is hundreds to low thousands of particles. At that scale the saving from going direct is well under 0.1 ms per frame. It does not pay today.
- Pixi WebGPU is slower than WebGL in the same scene here (mostly the hull fallback, but particle-only parts also trail at 50k), and needs every custom shader ported. No case for it.

## Options

1. Stay on Pixi WebGL with the current pools and ShipBatch (recommended). Zero risk, and the measured headroom is large: (a) draws 10k particles + 1k bullets + 100 hulls in 0.35 ms CPU.
2. Pixi WebGPU. One config line, but `particlePool`, `ShipBatch`, `litShader`, the sky shaders and Bloom are GLSL `GlProgram`s and would need WGSL ports and a visual parity pass. Measured: no benefit. Revisit only if Pixi's WebGPU path overtakes WebGL or compute is wanted.
3. Direct instanced layers for particles/bullets (hulls already are chunked-instanced in effect). 2 to 5 days for particles with layering against the bloom pass, the lighting and UI, resize/DPR, and context loss to handle. Gain: roughly 0.1 to 3 ms CPU depending on scale. Only worth it if profiling the real game shows particles/bullets submission as a top cost at a target count well beyond today's, for example 20k+ simultaneous effect particles.
4. Full custom WebGPU renderer: not justified.

## WebGPU browser support (general knowledge, only Chrome tested here)

Chrome/Edge: shipped on desktop and recent Android. Safari: shipped in recent releases. Firefox: shipping on Windows, partial elsewhere. Linux and older GPUs are the weak spot, and driver blocklists apply. A WebGL fallback would be needed anyway, so WebGL2 stays the baseline.

## Recommendation and plan

1. Stay on Pixi WebGL. Do not enable WebGPU.
2. Before any renderer work, profile the real game in a busy fight (browser performance trace) and see where frame time goes: scene-graph and Graphics rebuilds for non-pooled effects, lighting uniform uploads, MSAA/bloom fill, or server-driven entity work. The bench says particle/bullet submission is not where the CPU goes at today's counts.
3. If a profile does show effects submission as the hot spot, the cheaper step is inside the current design: move more effects from Graphics/Sprites into `ParticlePool`, and keep pools below the 4-texture limit with an atlas.
4. Only if counts need to grow by roughly 10x: build a direct instanced particle layer behind a dev flag that defaults off, and re-run this bench on a laptop-class GPU in a real browser first.

## The demo

Folder `game-v2/prototypes/gfx-bench/`, plain HTML and JS, no build step. Pixi 8.16.0 loads from jsDelivr, so it needs internet.

- Interactive: serve the folder (`python -m http.server 5611` from inside it) and open `http://localhost:5611/`. Pick the mode, set counts, watch fps, frame ms, JS cpu ms and draw calls. "run scaling table" prints the 1k / 10k / 50k / 100k table for the chosen mode.
- Headless: `node prototypes/gfx-bench/run.mjs [chromePath] [modes]` (modes: `pixi-webgl,pixi-webgpu,direct,pixi-graphics`). Starts one Chrome (debug port 9333) and a server on port 5611, prints JSON, closes both. Running all four modes in one go can exceed ten minutes because the old pattern is slow at 100k; run them separately as was done here.
