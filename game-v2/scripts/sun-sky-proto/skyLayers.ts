/**
 * The sky's layers for a view: the game's (SkyRenderer: haze into a texture at hazeScale of the CSS size, stretched
 * over the screen, then six star layers, deep sky and motes added at full size), and the prototypes'
 * (client/src/rendering/proto/skyProto.ts). The camera is still (no streak); a black hole bends the sky as in the game.
 */

import { skyBiome, type SkyBiome } from '../../client/src/rendering/sky/skyBiome';
import { hazeFrag, skyVert, starsFrag } from '../../client/src/rendering/sky/skyShaders';
import { SKY_LAYERS, SKY_DEPTH, MOTE_DEPTH, SKY_TILE, skySpriteUniforms, SKY_SPRITE_VERT, SKY_SPRITE_FRAG, SKY_DEEP_VERT, SKY_DEEP_FRAG, spriteGrid, insideRingOnly, ringBox, withSunHole, sunHole, sunCovers, oneDrawGrid } from '../../client/src/rendering/proto/skyProto';
import { SCREEN, toDesktop, type Layer, type Programs, type View } from './layers';

const scaleAt = (zoom: number, depth: number) => 1 / (1 / zoom + depth);
const smooth = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** A system's biome, from its systems.json entry, as Renderer.lightSystem makes it */
export function systemBiome(sys: any): SkyBiome {
  const v = sys.visuals ?? {};
  return skyBiome(sys.id, {
    biome: v.biome, sector: sys.sector, position: sys.position, central: sys.centralBody?.type,
    hasNebula: v.hasNebula, nebulaHue: v.nebulaHue, starHueShift: v.starHueShift, specialStarChance: v.specialStarChance, specialStarHue: v.specialStarHue,
  });
}

/** The uniforms both sky shaders share (SkyRenderer.setBiome and update) */
export function fieldUniforms(b: SkyBiome, v: View, lens: number): Record<string, number | number[]> {
  const zSky = scaleAt(v.zoom, SKY_DEPTH);
  return {
    uCamera: v.cam, uRes: [v.w, v.h], uRot: [1, 0], uSky: [zSky, SKY_TILE, b.seed[0], b.seed[1]],
    uBand: [-Math.sin(b.band.angle), Math.cos(b.band.angle), b.band.offset, b.band.width], uField: [b.dust.strength, b.nebula.cover, 0, 0],
    uLens: [-v.cam[0] * v.zoom, -v.cam[1] * v.zoom, lens * 4.5 * v.zoom, lens > 0 ? 1 : 0],
  };
}

export function hazeUniforms(b: SkyBiome, v: View, lens: number): Record<string, number | number[]> {
  return {
    ...fieldUniforms(b, v, lens), uBase: b.base, uBandCore: b.band.core, uBandEdge: b.band.edge, uBandStrength: b.band.strength,
    uDustTint: b.dust.tint, uNebA: b.nebula.a, uNebB: b.nebula.b, uNebStrength: b.nebula.strength, uFilColor: b.filaments.color,
    uFilStrength: b.filaments.strength, uShell: [b.shell.x, b.shell.y, b.shell.radius, b.shell.strength], uShellColor: b.shell.color,
  };
}

/** The haze into its texture and stretched over the screen (the game's way; the cached prototype only changes how often) */
function hazeLayers(b: SkyBiome, v: View, lens: number, hazeScale: number, program = 'haze.cur', hole?: number[]): Layer[] {
  const scale = hazeScale / v.dpr;
  return [
    { name: 'haze', program: hole ? 'haze.hole' : program, uniforms: { ...hazeUniforms(b, v, lens), uSunHole: hole ?? [0, 0, 0] }, textures: { uNoise: 'skyNoise' }, verts: SCREEN, blend: 'none', target: 'haze', scale },
    { name: 'haze.blit', blit: 'haze', blitScale: scale, blend: 'none' } as unknown as Layer,
  ];
}

/** The game's sky: haze, then the star shader over the whole screen */
export function currentSkyLayers(b: SkyBiome, v: View, lens = 0, hazeScale = 0.5, layerOn = [true, true, true, true, true, true], hole?: number[]): Layer[] {
  return [
    ...hazeLayers(b, v, lens, hazeScale, 'haze.cur', hole),
    { name: 'stars', program: hole ? 'stars.hole' : 'stars.cur', uniforms: { ...currentStarUniforms(b, v, lens, layerOn), uSunHole: hole ?? [0, 0, 0] }, textures: { uNoise: 'skyNoise' }, verts: SCREEN, blend: 'add' },
  ];
}

/** starsFrag's uniforms (SkyRenderer.update) */
function currentStarUniforms(b: SkyBiome, v: View, lens: number, layerOn = [true, true, true, true, true, true]): Record<string, number | number[]> {
  const zSky = scaleAt(v.zoom, SKY_DEPTH);
  const stars: Record<string, number | number[]> = {
    ...fieldUniforms(b, v, lens), uTime: v.t, uStarMix: [b.stars.temperature, b.stars.brightness, b.stars.bandBoost, b.stars.spikes],
    uTint: b.stars.tint, uMoteColor: b.moteColor, uSpike: [Math.cos(b.stars.spikeAngle), Math.sin(b.stars.spikeAngle)], uStreak: [0, 0],
  };
  const dens = Math.sqrt(b.stars.density);
  SKY_LAYERS.forEach((L, i) => {
    const z = scaleAt(v.zoom, L.depth), cell = L.px / dens / scaleAt(1, L.depth), ratio = (cell * z) / (L.px / dens);
    stars[`uL${i}`] = [z, cell, Math.min(1, ratio * ratio), layerOn[i] ? smooth(0.28, 0.55, ratio) : 0];
  });
  stars.uMotes = [scaleAt(v.zoom, MOTE_DEPTH), 140 / scaleAt(1, MOTE_DEPTH), 0.32 * b.motes * smooth(0.15, 0.5, v.zoom), 0];
  stars.uDeep = [zSky, 700 / scaleAt(1, SKY_DEPTH), b.deep.galaxies, b.deep.clusters];
  return stars;
}

/**
 * The sprite prototype: each star layer an instanced draw of one quad per cell on screen (most culled in the vertex
 * shader), then the deep sky and motes as one more; `better`: prototype C's star look. `hazeEveryFrame` false is the
 * cached haze: drawn once, then only its blit each frame (the bench times the blit alone).
 */
export function spriteSkyLayers(b: SkyBiome, v: View, lens = 0, opts: { better?: boolean; haze?: 'drawn' | 'cached'; hazeScale?: number; only?: number; hole?: number[]; oneDraw?: boolean } = {}): Layer[] {
  const better = !!opts.better;
  const prog = better ? 'sprite.better' : 'sprite';
  const out: Layer[] = [];
  const hz = hazeLayers(b, v, lens, opts.hazeScale ?? 0.5, 'haze.cur', opts.hole);
  if (opts.haze === 'cached') { (hz[0] as any).name = 'haze (cached: not timed)'; (hz[0] as any).untimed = true; }
  out.push(...hz);
  const shared = { ...skySpriteUniforms(b, v, lens), uSunHole: opts.hole ?? [0, 0, 0] };
  if (opts.oneDraw) {
    const g = oneDrawGrid(b, v, lens);
    if (g) out.push({ name: 'stars (one draw)', program: better ? 'sprite1.better' : 'sprite1', uniforms: { ...shared, ...g.uniforms } as Layer['uniforms'], textures: { uNoise: 'skyNoise' }, verts: SPRITE_QUAD, blend: 'add', instances: g.count });
  }
  else SKY_LAYERS.forEach((_, i) => {
    if (opts.only !== undefined && opts.only !== i) return;
    const g = spriteGrid(b, v, i, lens);
    if (!g) return;
    out.push({ name: `stars${i}`, program: prog, uniforms: { ...shared, ...g.uniforms }, textures: { uNoise: 'skyNoise' }, verts: SPRITE_QUAD, blend: 'add', instances: g.count });
  });
  const deep = opts.only === undefined ? spriteGrid(b, v, 'deep', lens) : null;
  // Near a black hole: inside its ring, the old shader (only there)
  const ring = ringBox(v, lens);
  if (ring) {
    const [x0, y0, x1, y1] = ring;
    const cx = (x: number) => x / (v.w / 2), cy = (y: number) => -y / (v.h / 2), u = (x: number) => x / v.w + 0.5, w = (y: number) => y / v.h + 0.5;
    const verts = [cx(x0), cy(y0), u(x0), w(y0), cx(x1), cy(y0), u(x1), w(y0), cx(x0), cy(y1), u(x0), w(y1), cx(x1), cy(y1), u(x1), w(y1)];
    out.push({ name: 'stars (ring)', program: opts.hole ? 'stars.ring.hole' : 'stars.ring', uniforms: { ...currentStarUniforms(b, v, lens), uSunHole: opts.hole ?? [0, 0, 0] }, textures: { uNoise: 'skyNoise' }, verts, blend: 'add' });
  }
  if (deep) out.push({ name: 'deep+motes', program: 'deep', uniforms: { ...shared, ...deep.uniforms }, textures: { uNoise: 'skyNoise' }, verts: SPRITE_QUAD, blend: 'add', instances: deep.count });
  return out;
}

/** The sprites' quad: each instance's corners, 0..1 in both attributes (skySprites reads (aPosition + aUV) / 2) */
const SPRITE_QUAD = [0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 0, 1, 1, 1, 1, 1];

export function skyPrograms(desktop = true): Programs {
  const better = (s: string) => s.replace('#version 300 es', '#version 300 es\n#define SKY_BETTER 1');
  const p: Programs = {
    'haze.cur': { vert: skyVert, frag: hazeFrag },
    
    'stars.cur': { vert: skyVert, frag: starsFrag },
    'stars.ring': { vert: skyVert, frag: insideRingOnly(starsFrag) },
    'haze.hole': { vert: skyVert, frag: withSunHole(hazeFrag) },
    'stars.hole': { vert: skyVert, frag: withSunHole(starsFrag) },
    'stars.ring.hole': { vert: skyVert, frag: withSunHole(insideRingOnly(starsFrag)) },
    sprite1: { vert: SKY_SPRITE_VERT.replace('#version 300 es', '#version 300 es\n#define SKY_ONE_DRAW 1'), frag: SKY_SPRITE_FRAG },
    'sprite1.better': { vert: better(SKY_SPRITE_VERT).replace('#version 300 es', '#version 300 es\n#define SKY_ONE_DRAW 1'), frag: better(SKY_SPRITE_FRAG) },
    sprite: { vert: SKY_SPRITE_VERT, frag: SKY_SPRITE_FRAG },
    'sprite.better': { vert: better(SKY_SPRITE_VERT), frag: better(SKY_SPRITE_FRAG) },
    deep: { vert: SKY_DEEP_VERT, frag: SKY_DEEP_FRAG },
  };
  if (desktop) for (const k of Object.keys(p)) p[k] = { vert: toDesktop(p[k].vert), frag: toDesktop(p[k].frag) };
  return p;
}

/** The star's opaque radius, as a share of its radius: inside it nothing behind the disc shows (the game's sun, and both prototypes) */
export const OPAQUE = 0.95;

/** Round 2's sky options, each by name: the faithful ones first, then the alternative look */
export const SKY_OPTIONS = ['cur', 'cur+skip', 'sprite', 'sprite+skip', 'one+skip', 'better+skip'] as const;
export const SKY_LABEL: Record<string, string> = {
  cur: 'current', 'cur+skip': 'FAITHFUL: current, skipped under the sun', sprite: 'FAITHFUL: sprite stars (B)',
  'sprite+skip': 'FAITHFUL: sprite stars, skipped under the sun', 'one+skip': 'FAITHFUL: sprite stars in one draw, skipped under the sun',
  'better+skip': 'ALT: better stars (C), skipped under the sun',
};

/**
 * A sky option for a view. "+skip": nothing at all when the star's disc (`starRadius`, 0 for none) covers the
 * screen, and otherwise no work behind it (the shaders' early out, the sprites' cull).
 */
export function skyOption(option: string, b: SkyBiome, v: View, lens: number, starRadius: number): Layer[] {
  const skip = option.endsWith('+skip') && starRadius > 0;
  if (skip && sunCovers(v, starRadius * OPAQUE)) return [];
  const hole = skip ? sunHole(v, starRadius * OPAQUE) : undefined;
  const base = option.replace('+skip', '');
  if (base === 'cur') return currentSkyLayers(b, v, lens, 0.5, undefined, hole);
  return spriteSkyLayers(b, v, lens, { hole, better: base === 'better', oneDraw: base === 'one' || base === 'better' });
}
