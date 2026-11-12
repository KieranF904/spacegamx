/**
 * @contract client.render.background
 * owns:       Renderer's backdrop pass: the sky, surface and city, terrain, the star and central bodies, ship shadows
 * needs:      Renderer (its fields, as the first argument), SkyRenderer, SurfaceRenderer, SunRenderer, Lighting; npm: pixi.js, @space-game/common
 * invariants: a system's star is its systems.json entry, else one made once per visuals object; with no systemInfo yet it draws DEFAULT_SYSTEM_VISUALS — client/src/rendering/renderer/rendererModules.test.ts
 * extend:     a new backdrop layer is a step in renderBackground
 */

import { DEFAULT_SYSTEM_VISUALS, lightSystem, type SystemVisuals } from './systemVisuals';
import { glowBall, DOT_SIZE } from '../fxTextures';
import { TerrainView } from '../TerrainView';
import { terrainFor, gunRangeFor } from '../terrainData';
import { ChamberView } from '../gunRange/ChamberView';
import { settings } from '../../settings/Settings';
import { boundKeyName } from '../../input/keybindings';
import { starOf } from '../sun/SunRenderer';
import type { StarBody } from '../sun/plasmaSun';
import { EntityType } from '@space-game/common';
import { SUN_DIR } from '../surface/SurfaceRenderer';
import { CityView } from '../surface/CityView';
import { BastionView } from '../surface/siege/BastionView';
import { skyBiome } from '../sky/skyBiome';
import type { StarSystemData } from '@space-game/common';
import type { Renderer } from '../Renderer';

export function renderBackground(rend: Renderer, delta: number): void {
  const zoom = rend.cameraZoom;
  
  // Get system visuals (data-driven from server, with Sol-like fallback)
  const systemVisuals = rend.systemVisuals.get(rend.currentSystemId) || DEFAULT_SYSTEM_VISUALS;
  
  // The sky: this system's biome (made once per system), following the camera
  let biome = rend.biomes.get(rend.currentSystemId);
  if (!biome) {
    const sys = rend.sys.data;
    const v = sys?.visuals ?? {};
    biome = skyBiome(rend.currentSystemId || 'sol', {
      biome: v.biome, sector: sys?.sector, position: sys?.position, central: sys?.centralBody?.type,
      hasNebula: v.hasNebula ?? systemVisuals.hasNebula, nebulaHue: v.nebulaHue ?? systemVisuals.nebulaHue,
      starHueShift: v.starHueShift, specialStarChance: v.specialStarChance, specialStarHue: v.specialStarHue,
    });
    rend.biomes.set(rend.currentSystemId, biome);
  }
  rend.sky.setBiome(biome);
  rend.sky.setLens(systemVisuals.centralType === 'black_hole' ? systemVisuals.centralRadius ?? 0 : 0);
  // On a planet: its ground and clouds instead of the sky, and its city
  const here = rend.sys.data;
  const surface = here?.surface ?? null;
  rend.surface.setSurface(surface, here?.id);
  setCity(rend, surface ? here! : null);
  // Its rock (built once, when you arrive)
  if (rend.terrainId !== rend.currentSystemId) {
    rend.terrainId = rend.currentSystemId;
    rend.terrainView?.destroy();
    rend.terrainView = null;
    rend.chamber?.destroy();
    rend.chamber = null;
    const t = terrainFor(rend.currentSystemId);
    if (t) { rend.terrainView = new TerrainView(t, rend.lighting, surface?.kind === 'cavern'); rend.terrainLayer.addChild(rend.terrainView.container); }
    const range = gunRangeFor(rend.currentSystemId);
    if (range) { rend.chamber = new ChamberView(range, rend.lighting, () => boundKeyName('interact', settings.data.bindings)); rend.terrainLayer.addChildAt(rend.chamber.container, 0); }
  }
  rend.terrainView?.update(Math.min(0.1, delta));
  rend.chamber?.update(rend.cameraX, rend.cameraY);
  if (rend.city?.bastion) { const vb = rend.viewBox(); rend.city.bastion.update(Math.min(0.1, delta), { night: rend.surface.night, zoom: rend.cameraZoom, angle: rend.cameraAngle, entities: rend.state.entities.ofType(EntityType.ShipBody), view: { x: rend.cameraX, y: rend.cameraY, hw: vb.hw, hh: vb.hh } }); }
  const lightKey = `${rend.currentSystemId}|${rend.systemVisuals.has(rend.currentSystemId)}`;
  if (lightKey !== rend.lightKey) {
    rend.lightKey = lightKey;
    lightSystem(rend.lighting, rend.surface, rend.sys.data, systemVisuals, biome, (d) => { rend.day = d; });
  }
  if (surface) {
    rend.sky.container.visible = false;
    const shake = rend.state.screenShake;
    rend.surface.update(Math.min(0.1, delta) * 1000, rend.cameraX, rend.cameraY, zoom,
      { x: (shake.offsetX || 0) * rend.shakeScale, y: (shake.offsetY || 0) * rend.shakeScale, rot: (shake.rotation || 0) * rend.shakeScale - rend.cameraAngle });
    drawShadows(rend, rend.day.power <= 0);
    // Night falls on the light too (headlights come on by themselves in the dark): warm through dusk, cold at night
    const n = rend.surface.night, shade = rend.surface.shade(), sun = rend.lighting.sun;
    for (let i = 0; i < 3; i++) { rend.lighting.ambient[i] = rend.day.ambient[i] * shade.ambient[i]; sun.color[i] = rend.day.sun[i] * shade.sun[i]; }
    sun.power = rend.day.power * (1 - 0.92 * n);
    rend.shadows.container.alpha = 1 - n * 0.8;
  } else {
    rend.shadows.begin();
    rend.shadows.end();
  }

  // The star (seconds: the same speed at any frame rate), at the world's origin: drawn into its own target with the
  // camera's transform, and stretched back over the screen in the background layer's frame (the world's)
  const animDelta = Math.min(0.1, delta);
  const plainSun = !systemVisuals.noCentralBody && !systemVisuals.centralType;
  rend.centralShaders.set(systemVisuals.centralType ?? null, systemVisuals.centralRadius ?? 1000, systemVisuals.centralHue ?? 30, rend.sys.data?.centralBody?.look);
  rend.centralShaders.update(animDelta);
  if (plainSun) {
    rend.sun.setStar(rend.currentSystemId, starBody(rend, systemVisuals));
    rend.worldContainer.updateLocalTransform();
    const toScreen = rend.worldContainer.localTransform;
    rend.sun.update(animDelta, toScreen, toScreen);
  } else {
    // (none here: it draws nothing, and the sky has no hole)
    rend.sun.setStar(rend.currentSystemId, null);
    rend.sun.update(animDelta, rend.worldContainer.localTransform);
  }
  // The sky after it: nothing drawn behind its disc, none at all when the disc fills the screen
  // (Indoors, in a gun range's chamber: no sky at all)
  if (rend.chamber) rend.sky.container.visible = false;
  else if (!surface) rend.sky.update(Math.min(0.1, delta) * 1000, rend.cameraX, rend.cameraY, zoom, rend.cameraAngle, rend.sun.opaqueRadius);
}

/** A system's star: its systems.json entry (its look there), else one made from what the server sent */
export function starBody(rend: Renderer, v: SystemVisuals): StarBody {
  const known = starOf(rend.currentSystemId);
  if (known) return known;
  let b = rend.starBodies.get(v);
  if (!b) rend.starBodies.set(v, (b = { radius: v.starRadius, hue: v.starHue, sunStyle: v.sunStyle, detailStar: v.detailStar, detailParams: v.detailParams, detailColors: v.detailColors }));
  return b;
}

/** Each ship's shadow on the ground, cast away from the sun */
/** `under`: underground (no sun: each falls nearly straight below its ship, darker, the glow all round softening it) */
export function drawShadows(rend: Renderer, under = false): void {
  rend.shadows.begin();
  for (const [id, r] of rend.shipRadius) {
    const e = rend.state.entities.get(id);
    if (!e) continue;
    const off = under ? 20 + r * 0.25 : 60 + r * 0.9;
    const s = rend.shadows.take(glowBall(), e.renderX + SUN_DIR[0] * off, e.renderY + SUN_DIR[1] * off, 0.5, 0.5, 0x000000, under ? 0.62 : 0.42);
    s.scale.set((r * (under ? 2.9 : 2.6)) / DOT_SIZE);
  }
  rend.shadows.end();
}

/** A surface's city (built once while you're there) and the edge of its map */
export function setCity(rend: Renderer, sys: StarSystemData | null): void {
  const id = sys?.id ?? null;
  if ((rend.city?.system ?? null) === id) return;
  rend.city?.view?.dispose();
  rend.city?.bastion?.dispose();
  rend.city = null;
  rend.surfaceEdge.clear();
  if (!sys?.surface) return;
  const s = sys.surface;
  const view = s.city ? new CityView(s.city, s.seed ?? 1, rend.lighting) : null;
  const bastion = s.bastion ? new BastionView(s.bastion, rend.lighting, { radius: s.radius, boom: (x, y, r) => rend.fx.createExplosionAt(x, y, r) }) : null;
  if (view) rend.backgroundContainer.addChild(view.container);
  if (bastion) { rend.backgroundContainer.addChild(bastion.container); rend.effectContainer.addChild(bastion.top); }
  rend.city = { system: sys.id, view, bastion };
  // The edge: a dashed ring (fly past it to climb back to orbit)
  const R = s.radius, dashes = 120;
  for (let k = 0; k < dashes; k++) {
    const a0 = (k / dashes) * Math.PI * 2, a1 = a0 + (Math.PI * 2 / dashes) * 0.55;
    rend.surfaceEdge.moveTo(Math.cos(a0) * R, Math.sin(a0) * R).arc(0, 0, R, a0, a1);
  }
  rend.surfaceEdge.stroke({ color: 0xe8f4ff, width: 40, alpha: 0.35 });
}
