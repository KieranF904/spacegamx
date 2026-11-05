# Graphics renderer audit, 2026-11-06

Question: is it worth moving off Pixi's current renderer to WebGPU, or to direct GPU code (custom WebGL2/WebGPU) for particles, bullets and ship hulls?

Short answer: not worth switching Pixi to WebGPU. Worth a staged hybrid: keep Pixi for the scene, UI and one-off effects, and move the high-count layers (particles, then bullets, then hull parts) to one instanced draw each.

## Current state

Note: this audit was done in an agent worktree whose `client/src` is older than the `refactor/split` head. I did not find `ParticlePool` or `DamageFx` there, so the notes on those two come from the task brief, not from code I read. Re-check them before acting.

- Pixi `^8.0.0` (installed 8.16.0). `Application.init` in `client/src/Game.ts` (line ~176) sets only size, `antialias: true`, `resolution: devicePixelRatio`, `autoDensity`. No `preference`, so Pixi 8 picks WebGL. WebGPU is never used today.
- Ships, projectiles, asteroids, stations: `Renderer.ts` (3127 lines) builds a `Container` per entity with `Graphics` children. Projectiles get one pooled `Graphics` each (`GraphicsPool`, `createProjectileGraphics`). Trails and glows are more Graphics, plus separate Sun/Corona/Nebula/Starfield/Glow renderers (shaders).
- `ParticleSystem.ts` (in this tree) is a CPU pool (max 2000) drawn with Canvas2D (`ctx.arc`, `globalCompositeOperation = 'lighter'`), not Pixi. Per-particle `save/translate/rotate/fill`.
- Known issues from the brief: ParticlePool hit the "more than 4 textures" limit once; shield bubbles got their own pool. Both are symptoms of the same thing: Pixi's batcher breaks on texture or blend changes, and per-object state is expensive.

## Measurements

Demo: `prototypes/gfx-bench/` (see below). Same CPU simulation in every mode, so only submission differs. Scene per tier: P additive soft particles (Sprites), B bullets (one `Graphics` each, as the game does), K hulls (a `Container` of 4 `Graphics` parts each). 1280x720, 120 frames after 40 warm-up, vsync and frame cap disabled.

Environment: headless Chrome 156 on Windows 11, NVIDIA Blackwell GPU, WebGPU available. Other agents were using the machine, so treat absolute numbers as indicative; the ratios within one run are what matter. "JS cpu ms" is the time to simulate, update scene objects and submit the frame. Because the GPU runs async and the frame cap is off, frame ms is essentially CPU-bound here: it does not capture GPU fill cost.

| P / B / K | Pixi WebGL ms (cpu) | Pixi WebGPU ms (cpu) | Direct WebGL2 ms (cpu) |
|---|---|---|---|
| 1k / 200 / 30 | 0.30 (0.17) | 1.39* (0.26) | 0.24 (0.07) |
| 10k / 1k / 100 | 1.37 (1.23) | 1.56 (1.40) | 0.26 (0.14) |
| 50k / 5k / 300 | 7.97 (7.67) | 7.90 (7.57) | 0.60 (0.54) |
| 100k / 10k / 300 | 27.8 (26.9), p95 47 | 16.4 (15.8), p95 18 | 1.14 (1.07) |

*first-tier WebGPU includes warm-up; p95 was 0.8.

Draw calls reported: Pixi 2 (both backends), direct 3. Pixi 8 batches Graphics and same-blend Sprites into very few draws, so draw call count is not the bottleneck. The cost is the per-object CPU work: scene-graph transforms, `Graphics` geometry, vertex batching. WebGL vs WebGPU in Pixi is the same within noise up to 50k objects (identical CPU path); WebGPU only pulled ahead at the extreme tier (100k particles, 10k bullets), and that tier is far beyond the game's intended scale.

Direct instanced WebGL2 is 5 to 14x less CPU at 10k to 50k particles and about 24x at 100k, with the particle/bullet/hull data written as a flat typed array and uploaded with one `bufferSubData` per layer.

Caveats: the demo hull and bullet looks are simple shapes, not the game's art, so the direct path ignores shaders, glows and trail geometry the real game has. Real hulls with many parts, gradients or per-hull shader effects will cost more in both paths.

## Options

1. Stay on Pixi WebGL. Zero risk. Fine up to the several-thousand-object range (1.2 ms CPU at 10k/1k/100). The game's current ParticleSystem cap is 2000, so it is nowhere near the wall today; the limit is design (more particles/bullets in boss fights), not capacity.
2. Pixi with `preference: 'webgpu'`. One line of config, but the measurements show no gain below ~50k objects, and some risk: WebGPU still has uneven support, custom filters/shaders written in GLSL need WGSL (or Pixi falls back), and the existing Sun/Corona/Nebula shader renderers would need checking. Not recommended as a goal; revisit when Pixi's WebGPU path matures or you need compute.
3. Hybrid direct-GPU layers (recommended direction). Render particles, then bullets (and optionally hull parts) to their own WebGL2 canvas or a Pixi custom render pass using instanced quads: one draw call per layer, one buffer upload per frame. Pixi keeps everything else.
   - Particles: lowest risk, biggest win. Replaces the Canvas2D path and any Pixi particle sprites. Simple additive soft sprite shader. Effort: about 2 to 3 days including camera transform, additive blending and a texture atlas for shapes.
   - Bullets: moderate. Needs trail and glow handled as instanced quads or a trail ribbon shader; per-weapon looks via atlas or a small shape id in the instance data. About 3 to 5 days.
   - Hulls: highest effort. Composite parts per hull, damage states, tint, shields, and ship-editor parity. Only worth it if ship counts reach the hundreds. 1 to 2 weeks and a parity test plan.
   - Risk: layering/z-order against Pixi content (the glow/sun renderers, UI), resize/DPR handling, and context loss. Mitigate by drawing the direct layers into the same canvas through a Pixi custom render pipe, or by stacking a second canvas where z-order allows (particles above ships, below UI is the usual case).
4. Full custom WebGPU renderer. Not justified: large rewrite, no measured benefit over a WebGL2 instanced path for this workload.

## WebGPU browser support (as of late 2026, from general knowledge, not tested here besides Chrome)

Chrome/Edge: shipped on desktop and recent Android. Safari: shipped in recent releases (macOS/iOS 26). Firefox: shipping on Windows, partial elsewhere. Linux and older GPUs/drivers are the weak spot, and blocklists can disable it. A WebGPU-only path would need a WebGL fallback anyway, so WebGL2 stays the baseline.

## Recommendation and staged plan

Do not move the game to Pixi WebGPU. Go hybrid, staged, each stage behind a dev flag that defaults off (for example `?gfx=direct`):

1. Stage 1 (about 2 to 3 days): direct-instanced particle layer replacing Canvas2D / Pixi particle sprites, flag off by default. Compare frame time against the demo at the game's real particle counts. Raise the 2000 cap only after this lands.
2. Stage 2 (about 3 to 5 days): bullets and bullet trails as an instanced layer. Keep Pixi `Graphics` as the fallback when the flag is off.
3. Stage 3 (decide after stage 2, only if ship count demands it): instanced hull parts.
4. Meanwhile, cheap wins inside Pixi: avoid per-frame `Graphics.clear()`/redraw on entities, pool and reuse textures to stay inside batch texture limits, and use a texture atlas for effects to avoid the 4-texture batch break.
5. Re-run the bench on a mid/low-end laptop GPU and on a real browser (not headless) before committing to stage 2, since this audit ran one fast GPU in headless mode and measured CPU cost only.

## The demo

Folder `game-v2/prototypes/gfx-bench/`, plain HTML and JS, no build step. Pixi 8.16.0 is loaded from jsDelivr, so it needs internet.

- Interactive: serve the folder (for example `npx http-server prototypes/gfx-bench -p 5611`, or `python -m http.server 5611`) and open `http://localhost:5611/`. Pick the mode, set particle/bullet/hull counts, watch fps, frame ms, JS cpu ms and draw calls in the bar. "run scaling table" prints the 1k / 10k / 50k / 100k table for the chosen mode.
- Headless: `node prototypes/gfx-bench/run.mjs` runs all three modes in one Chrome on port 5611 (debug port 9333), prints JSON, then closes Chrome and the server.
