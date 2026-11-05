# Surface art pass: the ground from inside the atmosphere

Status: **in the dev client, awaiting Kieran's review, not deployed.** The old ground stays available in dev for
comparison (see "Comparing live" below).

Kieran's note: "planets like Terra Nova, when in the atmosphere, the ground is quite bland, not great designed."
Before this pass every surface was one shader with a palette per kind of world: a height field shaded by its slope,
with one detail noise. Terra Nova read as green camouflage, Glacia as grey smudge, the moons as brown blotches, and
Ashfall as a near-black smear.

## What changed

Look only. The ground's height field is the same function as before, so seas, lakes, coasts and the city sit where
they did. Nothing collides with it: a surface's solid rock is `data/terrain/` (TerrainView), which is untouched.
Clouds, CityView, BastionView, TerrainView and the cavern floor are unchanged, apart from a colour tint on the cloud
layer.

### How it's built

- `client/src/rendering/surface/surfaceLooks.ts`: each surface's look as data. There's a palette and features per kind
  of world, and overrides per surface where one should stand apart (Terra Nova, Selene, Gloam, Rimeholt, Ashfall,
  Cinderhold, Last Light, Deep Foundry). It has no Pixi dependency, so the native stills read the same numbers.
  - Colours: `deep shallow shore low high rock peak haze urban`, plus `dry soil skylight sunlight cloudTint`.
  - Features (0..1): `forest rivers fields craters relief detail cracks moisture atmosphere ripples`.
- `client/src/rendering/surface/groundShader.ts`: the new ground. One program with a branch per kind (terran, rocky,
  ice, lava; desert and toxic take the terran path). It is drawn in layers:
  - **macro:** sea, shore, lowland, highland, rock, snow; broad wet and dry country from slow noise.
  - **mid:** each world's own features (below).
  - **fine:** trees, furrows, wind ripples, grit, crater rims. Each fades out before it would be smaller than a pixel
    or two (`resolves()`), so nothing shimmers at wide zoom.
  - **light:**
    - warm sun on slopes facing it, with shade that takes the sky's colour (cool blue on Terra Nova, near black on
      airless Selene) instead of plain black;
    - creases darkened (ambient occlusion from the height's curvature, kept gentle);
    - cloud shadows tinted by the sky;
    - haze that thickens with altitude (zoom) and at the map's edge;
    - lava glows on its own: emissive, not darkened by night or by the sun's angle, and only a little by cloud shadow.
- `surfaceShaders.ts`: split into `GROUND_HEAD` (uniforms, the cavern floor, height) and `groundFragClassic` (the old
  ground, kept for the dev toggle). The cloud shader gained `uTint`.
- `SurfaceRenderer.ts`: looks come from `lookOf()`. `setSurface(surface, id)` now takes the system id, which is the
  one-line change in `Renderer.ts`. `setClassic()` is the dev toggle.
- Asset cache: nothing new to cache. Every feature is computed in the shader from the existing sky noise texture
  (`SKY_NOISE_VERSION`, already cached), so there's no new generator or `_VERSION`.
- Shader warm-up: the new ground program sits on the stage's full-screen ground mesh, which `gameShaders()` already
  collects with `programsUnder(stage)`. No list edit was needed. The classic program exists only in dev.

### Per planet

| surface | kind | before | after |
|---|---|---|---|
| Terra Nova (`terra_nova_surface`) | terran | camouflage blotches of two greens, grey hills | patchy forests whose trees are separate lit crowns with shadows, thinning to scattered trees over meadow; dry grass patches; rivers winding through the lowland with green banks; farmland round New Meridian (fields in blocks turned their own way, crops in rows, hedgerows, roads between blocks); beaches with wet sand, surf, sandy shallows; craggy rock on the heights; blue shade and haze |
| Glacia (`glacia_surface`) | ice | grey smudge | pack ice broken into floes on the sea with open water further out; snow streaked by the wind; blue glacier ice streaked downhill; crevasse fields along the glaciers' edges; dark rock outcrops; blue shade |
| Rimeholt (`rimeholt_siege`) | ice | as Glacia | as Glacia, rougher: more rock, less sea |
| Selene (`selene_siege`) | rocky | brown blotches | airless grey regolith; craters at four sizes (bowls, lit rims, bright ejecta); darker low plains; near-black shade |
| Gloam (`gloam_siege`) | rocky | grey-brown blotches | dark violet ground under violet light; fractured by chasms with lit lips; a few craters |
| Ashfall (`ashfall_surface`) | lava | near-black smear | ash and basalt plains with old flows and ash dunes; a network of cracks, some stretches glowing and the rest cooled; small pulsing vents; shores glowing beside the lava |
| Cinderhold (`cinderhold_siege`) | lava | flat orange sea, black islands | mostly crusted over: big drifting plates with dim red seams; smoke-coloured clouds |
| Last Light (`lastlight_siege`) | lava | as Cinderhold | burning: yellow-hot open lava in winding channels, a busier crust |
| The Deep Foundry (`halcyon_foundry`) | lava | as Cinderhold | lava held under a heavy crust of drifting plates |
| The Pyreclast's Cavern | cavern | (unchanged: its floor was already designed) | unchanged |

No names or text were added anywhere, so there are no lore claims.

## Screenshots

Live game shots at 1280×800, with ships, HUD and minimap hidden and the clouds' clock and the time of day fixed, so
before and after match exactly. They are in the scratchpad
(`C:\Users\Kieran\AppData\Local\Temp\claude\c--Users-Kieran-Desktop-Spacegame\b24c970b-6148-4883-b4f6-ab3b6971e1b5\scratchpad\surface-art\shots\`)
as `<view>-before.png` and `<view>-after.png`, for these 18 views:

terra-nova-city, terra-nova-countryside, terra-nova-close, terra-nova-wide, terra-nova-coast, glacia-wide, glacia-close,
selene-bastion, selene-close, ashfall-wide, ashfall-close, cinderhold-bastion, cinderhold-close, gloam-bastion,
gloam-close, rimeholt-bastion, last-light-bastion, deep-foundry.

The positions and zooms are in `scripts/surface-art/stills.ts` (`VIEWS`).

Readability, with the player's ship shown (Terra Nova forest, the classic toggle at the same spot, Last Light's crust,
Glacia's ice): `...\surface-art\shots\read-0.png` … `read-3.png`.

The clean panels for the dev update are in `docs/panels/2026-10-31/graphics/surface-*.png` (11 topics; listed in
`docs/panels/index.md`).

Native stills of the same views, classic and new: `...\surface-art\surface-native\<view>-classic.png` and `-new.png`.

## Cost

The ground's GPU time, from the native harness (`node scripts/surface-art/run.mjs bench`; GPU timer queries, checked
against the wall clock) on an RTX 5070 Ti. The ground is drawn at half the screen's size, as in the game. Times are in
µs a frame.

| view (1920×1080) | before | after | × |
|---|---|---|---|
| terra-nova-city | 20.3 | 26.9 | 1.33 |
| terra-nova-countryside | 18.5 | 25.4 | 1.37 |
| terra-nova-close | 17.1 | 25.8 | 1.51 |
| terra-nova-wide | 22.6 | 29.7 | 1.31 |
| terra-nova-coast | 17.3 | 26.6 | 1.54 |
| glacia-wide | 20.2 | 22.9 | 1.13 |
| glacia-close | 17.1 | 19.3 | 1.13 |
| selene-bastion | 20.1 | 28.2 | 1.40 |
| selene-close | 17.3 | 26.6 | 1.54 |
| ashfall-wide | 20.6 | 24.3 | 1.18 |
| ashfall-close | 17.3 | 23.2 | 1.34 |
| cinderhold-bastion | 20.1 | 25.7 | 1.28 |
| cinderhold-close | 16.8 | 28.0 | 1.67 |
| gloam-bastion | 20.0 | 26.1 | 1.31 |
| gloam-close | 17.4 | 25.0 | 1.44 |
| rimeholt-bastion | 20.1 | 22.8 | 1.13 |
| last-light-bastion | 19.8 | 29.5 | 1.49 |
| deep-foundry | 18.6 | 29.2 | 1.57 |

- At 4K it's about 0.08 ms before and 0.11 ms after.
- The ground is 1.1× to 1.7× what it was. The extra 3 to 11 µs a frame here should stay well under a millisecond on a
  laptop iGPU (roughly 20 to 30 times slower).
- Part of the extra cost is paid for by a saving: the land's warp is now read once a pixel rather than once for each
  of its five height samples.
- Nothing changed on the CPU, and there are no new textures, no new draw calls and no new render targets.

## Comparing live (dev only)

- In the dev client's console:
  - `__game.renderer.surface.setClassic(true)` shows the old ground; `false` brings back the new one. It switches at
    once, and is remembered.
  - Or set `localStorage['sg.surfaceLook'] = 'classic'` and reload.
- In a production build the classic shader isn't built at all (`import.meta.env.DEV`).

## Tools

- `node scripts/surface-art/run.mjs stills <out dir> [new|classic|both] [view filter]`: native stills of the views
  above, drawn as SurfaceRenderer draws them, with the game's shaders, looks and noise and no browser (moderngl, as
  the native renderer).
- `node scripts/surface-art/run.mjs bench <out dir>`: GPU timings. `SURFACE_W=3840 SURFACE_H=2160` changes the
  screen size.
- `SURFACE_DEBUG='<glsl expression>'`: draws one of the shader's fields in place of the colour (for example `sun`,
  `ao*0.8`, `fract(h*30.0)`). This is how a banding problem was tracked down to the occlusion term saturating.
- Live shots go through `scripts/boss-shots/shoot.mjs`. The steps used here (guest sign-in, `/tp x y system`, camera
  target and zoom, ships/HUD/minimap hidden, clouds and time of day pinned) are in the scratchpad's
  `surface-art\gensteps.mjs`.

## Further ideas

- **Drifting cloud shadows at play zoom.** They're there, but faint under the 0.3 shadow strength. A per-surface
  strength (stronger on Terra Nova, none on Selene) would make the weather read more.
- **Water.** Shallow-water caustics, a sun glint that moves with the camera, slow foam lines along beaches, and a
  wake behind ships flying low over the sea (a ships-to-ground interaction).
- **Seasons or weather per visit:** snow cover on Terra Nova's heights, autumn forests, ash storms on Ashfall.
  These are uniforms on the same shader.
- **The city's edge:** suburbs (rows of small roofs) fading into the farmland, and roads leading out of New Meridian
  to join the field roads. CityView draws the core; the ground could carry the sprawl.
- **Props:** a cheap instanced layer for things that should stand up, such as tree shadows that lengthen at dusk,
  pylons, wrecks, Halden ruins on Glacia (lore names would need an owner in-game), steam plumes from Ashfall's vents.
- **Height-aware ship shadows:** the ships' ground shadows could offset along the sun and blur with altitude, using
  the ground's height field.
- **A second, slower parallax ground layer** at wide zoom (distant terrain under the haze) to add depth when climbing
  towards orbit.
- **Night:** city lights on Terra Nova, lava glow carrying up into the clouds' undersides, aurora over Glacia.
  Night already dims the lit ground and leaves the lava glowing, so this would build on that.
- **Desert and toxic** have no surface yet. Their paths exist (dunes; swampy forest and rivers) but are untuned.
