# Client rendering audit

Scope: the in-game render path (client/src/Game.ts frame loop, rendering/, ships/, per-frame UI overlays).
Method: code reading only. Nothing was run or profiled, so every "impact" below is an estimate from the code,
not a measurement. Line numbers are as of this audit; other agents are editing, so expect drift. Paths are
relative to `game-v2/client/src/`.

## 1. How a frame is drawn

`Game.update()` (Game.ts:1221) is a Pixi ticker callback (Game.ts:743, no FPS cap, `antialias: true`,
resolution = min(2, DPR) x renderScale, Game.ts:378, 2492). Per frame:

1. Input, prediction ticks, `state.interpolate`, `shipClient.update` (Game.ts:1268-1275).
   `ShipRenderer.update()` runs inside it (ShipClient.ts:885): per modular ship it culls, builds/looks up the hull,
   writes damage rows, draws engines/turrets/wires/labels, then `ShipBatch.end()`.
2. About 15 DOM HUD `update()` calls (nav markers, people, target, ops, ping, cargo...). Writes go through
   `ui/domWrite.ts` (dedupes), which is good.
3. `Renderer.update()` (Renderer.ts:485): camera (with helm roll) -> background (sky, surface, planets, sun/glow/corona
   shader quads) -> `renderEntities` (container per entity, culled by `viewBox`) -> `AsteroidBatch.update` -> `updateEffects`
   (pooled sprites, tractor beams, gates, stations, `WeaponFx`) -> damage numbers -> minimap (20 Hz) -> `stepOverlays`
   (two full-screen 2D canvases: floating rewards, damage indicators; both skip when idle).
4. `Renderer.applyLighting()` (Renderer.ts:1808): gathers lights from all sources, merges them on a 200-unit grid
   (max 16 per mesh), and writes uniforms to every lit mesh. Lighting is **per vertex** in the vertex shader.
5. `Renderer.renderBloom()`: re-renders the glow layers (thrusters, tracers, beams, sparks) a second time into a
   quarter-size RenderTexture, blurred (BlurFilter quality 2) and added over the scene.
6. Pixi's own render: sky (half-res haze RT, redrawn only when the view moves; full-res additive star shader with a
   3x3 cell loop per layer) -> world container (rotated by -cameraAngle in helm) -> bloom sprite -> UI container.

What's batched:
- Ships: hull geometry merged into chunks of 32 (`ShipBatch`), one draw per chunk; damage is a texture, hit flash a
  uniform, so damage rebuilds nothing. Far LOD swaps whole chunk geometry.
- Asteroids: chunks of 32 (`AsteroidBatch`), one draw per chunk, LOD in shader.
- Effects: `SpritePool`s (sprites, additive or normal), `ParticleContainer` for exhaust, one shared Graphics per FX
  system (beams, boss FX, jump FX) cleared with `clearIfDrawn`.
- NOT batched: turret heads, fixed-gun barrels, wires, name labels and health bars (all per-ship Pixi objects), station
  and mob views, loot pods, gates.

## 2. Findings

Severity is my estimate of user-visible cost on a mid/weak machine in a busy scene.

| # | Sev | Where | What | Impact | Fix | Effort |
|---|-----|-------|------|--------|-----|--------|
| 1 | high | ships/ShipRenderer.ts:593-612, 779-808, ships/gunDecor.ts:573 | Turret heads and fixed-gun barrels are rebuilt **per ship, per rebuild**: `turretHead()` (uncached) is called per turret per ship, then 2-3 fresh `Graphics` (metal, lit, crack-with-texture-fill) per turret/barrel, plus `removeChildren().destroy()` on the old ones. Runs when a ship first comes into view and on every `ship.rebuilds` change (any part shot off). | CPU: a fleet of 40 identical NPCs x 4 turrets = ~480 Graphics built (poly tessellation + GraphicsContext) on entering view; a hitch per part break. GPU: one batch element per Graphics. Memory: a context per Graphics. | Cache `turretHead(fn,len,size)` and `gunGraphics` as a shared `GraphicsContext` per (design, weapon) and make each ship `new Graphics(sharedContext)`. Only the crack overlay needs to be per ship, and it can be created lazily when `crackShow(tf)>0`. | M |
| 2 | high | ships/ShipRenderer.ts:430-433 + ships/hullBuild.ts:45 | `buildHull` for every non-rigid ship runs **on the main thread** (the worker only handles `isRigid`, line 566/583). Player ships and NPCs rebuild on each part loss because `hullKey` includes the alive bitstring (558). `markPart` does `hullMat.push(...array)` per vertex and `engineDiscs.some(...)` per new vertex (hullBuild.ts:116). | CPU: tens of ms hitches when a big ship takes a part loss or a new design enters view; LRU only keeps 6 keys per blueprint (HULLS_KEPT, line 159). | Route all hull builds through `HullWorker` (already written, wire format exists), keep the old hull drawing until the new one arrives (ShipBatch already supports this via `built[]`). Cheap pre-step: fill typed arrays instead of `push(...spread)`. | M |
| 3 | high | ui/ComponentGuideUI.ts:153-158, 214-223, ui/componentSprites.ts:41-75 | Component Guide re-renders the **whole tab via innerHTML** on every `pilot.onChange` while open, and each row embeds its sprite as a `data:` URL string (`out.toDataURL()`). First open draws every sprite synchronously on the main thread (canvas draw + `getImageData` full scan in `bounds()` + PNG encode). | CPU: first open = N x (~5-20 ms) in one frame; every cargo/xp change then parses a multi-hundred-KB HTML string and re-decodes images. | Convert sprites to blobs (`canvas.toBlob` + `URL.createObjectURL`, cached) or keep the `<img>` elements and patch only changed rows; draw sprites lazily/idle for visible rows (IntersectionObserver). `bounds()` can use the geometry bbox you already computed instead of `getImageData`. | M |
| 4 | high | Game.ts:378 (no `eventFeatures`), no `eventMode` anywhere | Pixi's EventSystem is left on, but nothing in the client uses Pixi pointer events (grep for `.on('pointer`, `eventMode` finds nothing). With default `passive` containers, Pixi still hit-tests down the display tree on pointer move, and this game moves the cursor constantly (it is the aim). | CPU per pointermove: a walk of every Container/Graphics/Text (thousands in a busy scene). Needs a profile to confirm size, but removing it costs nothing. | `app.init({ eventFeatures: { move:false, globalMove:false, click:false, wheel:false } })`, or `stage.eventMode='none'` plus `interactiveChildren=false` on worldContainer. | S |
| 5 | high | ShipBatch.ts:559-580, 354-370 | A chunk rebuild merges **every** hull in it (up to 32), for **both** full and far geometry, and re-uploads both buffers, whenever any one ship in the chunk spawns, despawns or changes structure. A boss (100k verts) in a chunk is re-copied and re-uploaded when a small ship beside it dies. `mergeInto` also allocates new Float32Arrays per attribute (12) per call. | CPU + GPU upload spikes of a few MB, capped at 2 chunks/frame. | Give rigid/boss hulls their own single-slot chunk (never merged with others). Only rebuild `geoFar` lazily when the chunk first needs far (it is drawn only when the biggest ship is under 22px). Reuse preallocated typed arrays (grow-only) instead of allocating. | M |
| 6 | med | Game.ts:1337-1345, ships/HangarUI.ts:162-163, ui/GameMenuUI | The world is only skipped when the system map covers it (`systemMapUI.covers()`). With the Hangar open (fixed, inset 0, background alpha 0.97) or the main menu open the full scene still runs: lighting, bloom, sky, ship updates. | Whole frame cost spent behind a ~opaque overlay, plus the hangar's own previews. On a weak GPU this halves hangar FPS. | Treat hangar (and any opaque-ish window) as "covered": set `stage.visible=false`, skip `renderBloom`/`applyLighting`, and throttle `Renderer.update` to ~10 Hz. Keep the ticker alive for audio and net. | S |
| 7 | med | Game.ts:378-380 | `antialias: true` (MSAA on the main canvas) combined with resolution up to DPR 2. The only quality knob is `renderScale` (0.5-1, GameMenuUI.ts:433). There is no FPS cap and no auto-scaling (ticker is uncapped, 144/240 Hz monitors run the whole pipeline at that rate). | GPU: MSAA x4 at 4x pixel count is the largest single multiplier on integrated GPUs. | Add a quality tier: antialias off by default or a setting (needs re-init, so read before `init`), `ticker.maxFPS` option (60/120/uncapped), and a dynamic-resolution loop that drops `renderScale` when the 1 s frame average is bad (hook already exists via `applySettings` -> `onResize`). | M |
| 8 | med | rendering/lighting/AsteroidBatch.ts:50, 69, 87 | Asteroids join `find(c => c.ids.length < 32)` (no spatial grouping, unlike ShipBatch), so each chunk holds rocks from all over the system and is lit for the whole screen (no `area`). `remove()` splices `ids`, so slots renumber, and the chunk geometry is rebuilt with `RockGeometry.append` (push-based, no packed typed arrays). Only 2 rebuilds/frame. | CPU on mass spawn/despawn; the shifted slots look wrong until the chunk is rebuilt (see bug B1). | Reuse the ShipBatch approach: free slot = -1 (don't splice), nearest-chunk placement, packed per-rock typed arrays, `area` for light picking. | M |
| 9 | med | Renderer.ts:960, 1027, 558 | Allocations in `renderEntities` hot loop: `new Set` of alive ids every frame, a closure `at` per entity per frame (1027), `viewBox()` returns a new object on each call (called by `renderEntities` and per ship in `inView`). | GC churn: a few hundred small objects per frame at 1000+ entities. | Use a frame-stamp number on each entity view instead of the Set; compute `c/sn` once and inline `at`; cache the view box once per frame. | S |
| 10 | med | rendering/lighting/Lighting.ts:30, 132-144 | `Lighting.point()` calls `rgbOf()` (allocates a 3-array) and `Object.assign` with an object literal for every light every frame (weapon flashes, shots, engines, lamps, loot, stations). | GC churn proportional to light count (tens to hundreds per frame in fights). | Write fields directly onto the pooled light, take a packed 0xRRGGBB and split channels into the pooled object. | S |
| 11 | med | Renderer.ts:958-1080, WeaponFx.ts:168, Renderer.ts:1873, 1924, Lighting `frame` | The full `state.entities` map is walked several times a frame (renderEntities, WeaponFx for projectiles, collectLights, drawShadows, minimap at 20 Hz, Game/TargetUI etc.). Ship-radius loops (`shipRadius`) include off-screen ships. | CPU O(N) x ~5 per frame; with 1000+ asteroids it is the dominant JS cost after hulls. | Keep per-type indexes in GameState (`projectiles`, `ships`, `asteroids` sets) updated on add/remove; skip off-screen ships in `drawShadows`/`L.shadow`. | M |
| 12 | med | ShipRenderer.ts:451, 472-490 | One `Text` (resolution 2, own canvas texture) plus one `Graphics` bar per labelled ship. Each distinct texture is a batch candidate break (Pixi batches up to ~16 textures, past which the batch splits); boss style has a dropShadow, which makes a larger texture. | Draw calls: roughly 1-2 per labelled ship on screen. | Use a `BitmapText` with a pre-installed font for ship labels (like DamageNumbers, Renderer.ts:1415), or pool/cache texts by (name,style); draw bars as sprites with a shared 1x1 texture scaled instead of Graphics. | M |
| 13 | med | ShipRenderer.ts:704-709, 734-760 | Wires: per ship two Graphics, the glow one `blendMode='add'`. Under `overLayer` each ship therefore inserts two blend switches (normal -> add -> normal) into the batch stream. Wires are built for NPC ships too (only skipped if `cs*zoom < 5px`). Stroke tessellation with round caps; `layWires` traces the path twice for the lit pass. | Draw calls +2-4 per ship with wires when zoomed in; CPU hitch on wire state change. | Only draw wires for the player's ship (and the hangar). If kept for others, put all glow Graphics into one additive layer container so the blend change happens once. | S |
| 14 | med | rendering/Bloom.ts:48-60 | Bloom re-renders each glow source with its own `renderer.render({target})` call (one RT bind and flush per source), then a two-pass blur. No dirty check: runs every frame while anything glows (almost always, thrusters). | GPU: several extra passes per frame; at 0.25 scale it is cheap but the pass count (not the pixel count) is the cost on weak drivers. | Parent all glow layers under one container and render once; optionally render bloom at 30 Hz or at 0.2 scale on low tier. | S |
| 15 | med | rendering/GlowRenderer.ts:101-118, SunRenderer.ts (fitQuad exists at ~1079) | The glow quad is much larger than the visible glow (comment at line 101), so most fragments early-out after running the vertex stage and interpolation, but when the camera is near the star the quad covers the full screen and does 6+ noise evaluations per pixel at full DPR. Sun/glow/corona mesh state is updated every frame even when the star is far off-screen. | GPU in the home-system: a full-screen noise pass. | Port `fitQuad`'s trimming to GlowRenderer; skip `update()` and set `visible=false` when the star's disc+glow box is off-screen; render glow at half-res into a RT like the haze. | M |
| 16 | med | rendering/sky/skyShaders.ts:190-192 (+ SkyRenderer.ts) | Star layer shader: 3x3 neighbour-cell loop per layer (about 5 layers) = ~45 cell hashes per pixel at full resolution, `precision highp`, additive over the whole screen every frame. | GPU: a fixed full-screen cost regardless of what's on screen; scales with DPR^2. | Quality tier: fewer layers / 2x2 neighbourhood on low tier; or render the farthest layers into the half-res haze RT; both are already parameterised by LAYERS. | M |
| 17 | low | ShipBatch.ts:195-199 (vertex shader), 129-132 | Per-vertex lighting loops over up to 16 lights for every vertex of every shown slot, and the hurt/crack fragment code uses 5-8 noise calls per pixel when `vHurt > 0.02` (ShipBatch.ts:290+). Mount bases add ~40 verts per weapon (`ngon` 12-14 sides with bevel; partDecor.ts:296-322), also in `geoFull` for every ship that mounts them. The far LOD removes bevels, which is the right call. | GPU vertex cost grows with weapon count; fragment cost only on damaged hulls. Acceptable today. | Cap the per-vertex loop to `min(uCount, 8)` on low tier; reduce `ngon` sides (14 -> 10) for small mounts; consider a mid LOD (bevels off, decor on) between 22px and ~60px. | M |
| 18 | low | ShipBatch.ts:581-589 | Every frame, for every chunk: `hullAtlas()` call, `uTime` write, bounding-box loop over all 32 slots, `Float32Array` uniform upload. Damage texture is re-uploaded whole (32 KB) on any change in any slot. | CPU: small but constant; fine until chunk count grows. | Early out when nothing moved; upload dirty rows only (`texSubImage2D`-style via `source.update` with a smaller texture per slot group). | S |
| 19 | low | ShipRenderer.ts:436, 819-826 | `setDamage` loops all parts of every on-screen ship every frame with `Math.round`/divides; turret `metal.tint` / `lit.tint` recomputed (several `mix`/`hurt`/`shade` calls) and assigned every frame per turret. Each tint assignment marks the Graphics for re-batching. | CPU: O(ships x parts + turrets) per frame; wasteful when nothing changed. | Version-stamp `ship.hp` (a `damageVersion` incremented by the sync layer) and skip `setDamage` when unchanged; only set `tint` when the computed colour differs from the last. | S |
| 20 | low | ui/NavMarkersUI.ts:152-171 | `update()` allocates `hud` array, `evs`, three `.map`s, spreads, a `.sort` and a `.slice` every frame, even when the marker list hasn't changed. `getBoundingClientRect` is throttled (good). | GC churn, a few hundred bytes/frame. | Rebuild the list on a 100 ms timer and only transform positions per frame. | S |
| 21 | low | WeaponFx.ts:166, 381 | `new Set()` per frame in `update`, and `[...this.shots.values()]` per frame in `draw`. | GC churn. | Reuse a member Set (clear) and iterate the Map directly. | S |
| 22 | low | ShipRenderer.ts:563 | `private builder = new HullWorker()` per ShipRenderer; no `terminate()` on dispose (no `destroy()` method on ShipRenderer at all). Fine while ShipRenderer lives for the app, but a leak if it is ever recreated (login/logout, reconnect). | One module worker per instance. | Add `destroy()` that terminates the worker and `lighting.remove`s all meshes. | S |
| 23 | low | rendering/Renderer.ts:1243-1256, 1954-2060 | Minimap redraws a `Graphics` (clear + hundreds of circle fills for all in-range entities) at 20 Hz; `[...nests, ...wayIns]` spread each time. | CPU: modest, GPU tessellation churn. | Draw via a pooled `Sprite` per dot (dot texture) or a single `ParticleContainer`; 10 Hz is plenty. | S |
| 24 | low | rendering/MobView.ts:54-66 | Legacy `Enemy` mobs redraw two Graphics (`glow`, `flame`) every frame each (`clear()` + 5 fills). | CPU/GPU re-tessellation per mob per frame. | Pre-baked sprite textures with scale/alpha animation, as ThrusterFx does. | S |
| 25 | low | ships/hullLook.ts:88-108, ships/hullTextures.ts:406 | The hull atlas is 1024 x 1536 RGBA with auto mipmaps (about 8 MB on the GPU), regenerated every page load in a worker (24 tiles of 256^2 with a 25-tap blur per texel). Memory is fine; startup does ~40 M ops in the worker each session. | Startup time (off-thread), 8 MB VRAM. | Cache the generated bytes in IndexedDB keyed by a content hash; consider BC/ASTC compression or 128px tiles on low tier. | S-M |

## 3. Quick wins (do these first)

1. **#4 Disable Pixi's EventSystem** (`eventFeatures` off). One line, nothing depends on it. Re-verify the DOM overlays still receive input (they are DOM, not Pixi).
2. **#6 Stop drawing the world under the Hangar/menu** (treat as `covered`). Biggest FPS-in-hangar gain for ~5 lines.
3. **#9, #10, #21 Remove per-frame allocations** in `renderEntities`, `Lighting.point`, `WeaponFx.update`. Mechanical.
4. **#13 Restrict wires to the local ship** (or one additive layer) to remove per-ship blend switches.
5. **#14 Render bloom sources once** by parenting the glow layers under one container.
6. **#19 Dirty-check `setDamage` and turret tints.**
7. **#7 Add an FPS cap setting and an antialias toggle** (needs a restart for AA; the FPS cap is live).
8. **#1 Cache `turretHead` results** (even without sharing contexts, this removes the repeated design work).

## 4. Bigger refactors worth considering

- **Shared GraphicsContext / instanced turret and barrel rendering** (#1). Longer term, draw turret heads as a second lit
  mesh batch (a `TurretBatch` in the same style as `ShipBatch`, one slot per turret with a rotation uniform). This removes
  the largest per-ship Pixi object count and lets turrets take real lighting.
- **All hull building in the worker** (#2), with the old hull kept until the new one lands. Pairs with persisting built
  hull buffers per design (the wire format already exists in `hullWire.ts`).
- **ShipBatch chunk policy** (#5): separate chunks for rigid/boss hulls, lazy `geoFar`, grow-only merge buffers,
  per-slot (not per-chunk) re-upload through `bufferSubData`.
- **AsteroidBatch parity with ShipBatch** (#8).
- **Entity indexes in GameState** (#11): one pass to partition entities into typed lists, shared by every system.
- **A real quality system.** Today there is one `renderScale` slider and bloom/lighting booleans. Introduce tiers (Low /
  Medium / High) driving: antialias, DPR cap, star layers, glow resolution, bloom on/off and scale, max lights per vertex,
  FPS cap, wire/turret detail, and an auto-tier that watches frame time. The pieces are all parameterised already.
- **Sprite-baked name labels** (#12): one shared glyph atlas for all ship labels and bars.

## 5. Possible bugs found along the way

- **B1 AsteroidBatch slot shift** (rendering/lighting/AsteroidBatch.ts:69 + 77-100). `remove()` splices `ids`, shifting every later rock's slot, but the chunk geometry is rebuilt only for the first 2 dirty chunks per frame. A chunk still waiting for its rebuild is drawn with new slot indices against old geometry, so rocks can be drawn at the wrong rock's transform for a frame or more (mass despawn on system change, or a large rock field being mined out). ShipBatch avoids this by freeing slots (-1) and using `built[]`. Fix: same approach.
- **B2 Death screen rebuilt on resize resets its fade** (`Renderer.onResize`, Renderer.ts ~1960; `buildDeathScreen` starts at alpha 0, `updateScreen` re-eases it from `deathAt` so the effect is a brief re-fade, not a permanent flash). `onResize` destroys and rebuilds the overlay, which starts with `alpha = 0`; the comment above says it "keeps its place in its fade" but nothing carries the alpha across, so a window resize while dead briefly flashes back toward the world (minor).
- **B3 Stale comment/constant mismatch in sky** (sky/SkyRenderer.ts:22 vs the file header). `HAZE_SCALE = 1/2` but the header says "a third of the screen's size". Harmless, but the haze budget is 2.25x what the header claims.
- **B4 HullWorker never terminated** (ShipRenderer.ts:563; see #22).
- **B5 Culling grows in helm mode, as designed, but is unmeasured** (cameraView.ts `viewHalfExtents`, used by `Renderer.viewBox`, ShipRenderer culling and nameplate culling). At a 45 degree roll the axis-aligned box is ~1.4x on each axis (about 2x entity area on a 16:9 view). Correct, not a bug; it does double the number of ships that do hull/engine/gun work in helm mode. A rotated-rectangle test (project onto the view axes) would cut this back for free.

## 6. Things that are already good (keep)

- Ship hulls and rocks as chunked, slot-placed meshes with damage as a texture (zero rebuilds on hit).
- Off-screen ship early-out with a light margin (ShipRenderer.ts:415) and the `built[]` guard against drawing stale slots.
- Sky haze at reduced resolution and only redrawn when the view moves; bloom at a quarter size, skipped when nothing glows.
- `domWrite` dedup, `clearIfDrawn` for shared FX Graphics, `SpritePool`/`ParticleContainer` for effects, throttled layout reads in NavMarkersUI, hull atlas generated in a worker, hidden `stage` under the system map.

## 7. Status (31 October 2026, CPU pass after `profile-2026-10-31.md`)

Fixed earlier (per the profile): 1, 2, 3, 4, 6, 7, 8, 9, 10, 13, 14 (partly: see below), 21, 22.

**Still open:** 5 (ShipBatch chunk policy), 11 (shared entity partition), 12 (ship labels as BitmapText), 17, 18, 19, 20
(NavMarkers rebuilt every frame), 23 (minimap Graphics), 24 (MobView Graphics redrawn), and bloom still issues one
`renderer.render` per glow source (14).

**Done in this pass (effects, profile item #2):**
- The big effect pools (WeaponFx tracers/flashes/sparks and gun smoke, DamageFx sparks/fire/shields and smoke) are
  `ParticlePool`s (`rendering/particlePool.ts`): one ParticleContainer each, drawn in take order, with a copy of Pixi's
  particle shader that picks one of up to four textures per particle the way Pixi's sprite batcher does. Busy-fight
  census: 2,600 to 4,400 display objects become 1,200 to 1,650 (the effects container 1,800 to 3,500 become 400 to 850).
- `SpritePool` (the small pools left) is its own render group, hides rather than destroys, trims its surplus every 4 s,
  skips unchanged tints (Pixi parses a colour on every set) and takes the rotation in `take()` (no rotation set twice).
- Things that made Pixi rebuild the **whole stage's** draw list every frame (any `visible`/`renderable` change, any child
  added or removed, and any Graphics redrawn marks its render group): off-screen ships' parts shown then hidden each frame
  and zoomed-out barrels likewise (ShipRenderer), every undamaged ship's health bar on then off (renderEntities), an empty
  view made and dropped per projectile, damage numbers added and removed in the effects layer, station nav lights
  blinking by `visible`, BossFx/MiningBeamFx Graphics being render-group roots, DamageFx's per-frame Graphics and chunk
  fills, WeaponFx's EMP crackle. Each is fixed (set once a frame, own small render group, alpha, pooled chunk bodies with
  one shared GraphicsContext); in a fight the stage now rebuilds rarely instead of ~once a frame.
- Visual check: same frame drawn both ways, seeded: 2,000 to 8,000 pixels of 1.3 M differ, almost all by 1 to 4 levels
  along thin tracer edges (float rounding of vertex positions; MSAA coverage). No visible change.

**Found: a Pixi 8 behaviour that shapes the current look.** A render group's own `blendMode` is not passed to its
children, and `renderer.render({ container })` turns a container into a render group. So once the bloom has drawn it,
WeaponFx's glow pool (`blendMode = 'add'` on the container) has been drawing its tracers, flashes and sparks with
**normal** blending in the main pass. That's how the game looks now and it is kept (`ParticlePool('normal')`, commented
in WeaponFx.ts). Making them additive is a one-word change and a brighter look: a design call. `SpritePool` now sets the
blend per sprite so this can't happen to it.

**Measured, not worth it:** making `worldContainer` a render group (camera moves as one matrix) saved nothing measurable
in fights (the cost moves to `updateRenderGroupTransforms`) and shifts thin edges by float rounding, so it was dropped.
Parking unused pool sprites at alpha 0 instead of hiding them was slower (they stay in the batches).
