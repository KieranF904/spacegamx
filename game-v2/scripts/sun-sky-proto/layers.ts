/**
 * The layers the harness draws for a view: the game's sun, glow, corona rays and central bodies set up as
 * Renderer does for a system (Renderer.update / updateDetailStar / updateCorona, CentralBodyShaders.set), and
 * the prototypes (client/src/rendering/proto) for the same view. No Node APIs here: the game's shader sources
 * come in as `Sources` (scenes.ts reads them from the TypeScript files, as they are).
 */

import { hashString, mulberry32 } from '@space-game/common';
import { sunShaderDefs } from '../../common/src/data/definitions/SunShaderDefs';
import { plasmaLook, sunPhotoLook, withExactNoise, withTextureNoise, PLASMA_FRAG, SUN_PHOTO_FRAG, SUN_PHOTO_VERT } from '../../client/src/rendering/proto/sunProto';

export interface Sources {
  sunVert: string; sunFrag: string;
  glowVert: string; glowFrag: string;
  raysVert: string; raysFrag: string;
  quadVert: string; glslCommon: string;
  central: { BLACK_HOLE: string; PULSAR: string; BROWN_DWARF: string };
}

/** The template-string constants a source file defines (the game's shaders, read as they are) */
export function shaderConsts(src: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const m of src.matchAll(/(?:export )?const (\w+) = `([\s\S]*?)`;/g)) found[m[1]] = m[2];
  return found;
}

/** Sources from the game's files' text: SunRenderer, GlowRenderer, CoronaRaysRenderer, CentralBodyShaders, shaderQuad */
export function sourcesFrom(text: { sun: string; glow: string; rays: string; central: string; quad: string }, glslCommon: string): Sources {
  const sun = shaderConsts(text.sun), glow = shaderConsts(text.glow), rays = shaderConsts(text.rays), central = shaderConsts(text.central), quad = shaderConsts(text.quad);
  return {
    sunVert: sun.VERTEX_SHADER, sunFrag: sun.FRAGMENT_SHADER, glowVert: glow.VERTEX_SHADER, glowFrag: glow.FRAGMENT_SHADER,
    raysVert: rays.VERTEX_SHADER, raysFrag: rays.FRAGMENT_SHADER, quadVert: quad.VERTEX_SHADER, glslCommon,
    central: { BLACK_HOLE: central.BLACK_HOLE, PULSAR: central.PULSAR, BROWN_DWARF: central.BROWN_DWARF },
  };
}

/** A view of the world: CSS size, device pixels per CSS px, the camera's world point and zoom (CSS px per unit), seconds */
export interface View { w: number; h: number; dpr: number; cam: [number, number]; zoom: number; t: number }

export interface Layer {
  name: string; program: string; uniforms: Record<string, number | number[]>; textures?: Record<string, string>;
  verts: number[]; blend: 'normal' | 'add' | 'none'; target?: string; scale?: number; instances?: number; clearTarget?: boolean;
}
export type Programs = Record<string, { vert: string; frag: string }>;

export const toDesktop = (s: string) => s.replace(/^\s*#version 300 es/, '#version 330 core');

/** A world-space quad (centre, half-size) as clip-space strip vertices, with its uv rect */
export function worldQuad(v: View, cx: number, cy: number, hx: number, hy: number, uv: [number, number, number, number] = [0, 0, 1, 1]): number[] {
  const clip = (wx: number, wy: number) => [((wx - v.cam[0]) * v.zoom) / (v.w / 2), -((wy - v.cam[1]) * v.zoom) / (v.h / 2)];
  const [u0, v0, u1, v1] = uv;
  const [a, b] = clip(cx - hx, cy - hy), [c, d] = clip(cx + hx, cy + hy);
  return [a, b, u0, v0, c, b, u1, v0, a, d, u0, v1, c, d, u1, v1];
}

/** The whole screen, uv (0, 0) at its top left (the sky's quads) */
export const SCREEN = [-1, 1, 0, 0, 1, 1, 1, 0, -1, -1, 0, 1, 1, -1, 1, 1];

/** Is a world box (centre, half-size) on screen at all? (the game draws its quads regardless; the GPU clips them) */
export function onScreen(v: View, cx: number, cy: number, hx: number, hy: number): boolean {
  return Math.abs(cx - v.cam[0]) - hx < v.w / 2 / v.zoom && Math.abs(cy - v.cam[1]) - hy < v.h / 2 / v.zoom;
}

const hex = (h: string): [number, number, number] => { const v = parseInt(h.replace('#', ''), 16); return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]; };
/** Renderer.hslRgb (through hslToHex: rounded to bytes) */
function hslRgb(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => { const k = (n + h / 30) % 12; return Math.round((l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1)) * 255) / 255; };
  return [f(0), f(8), f(4)];
}

export interface CentralBody {
  type: string; radius?: number; hue?: number; diskHue?: number; beamHue?: number;
  sunStyle?: string; sunStyleParams?: Record<string, number>; coronaStyle?: string; coronaStyleParams?: Record<string, number>;
  detailStar?: boolean; detailParams?: Record<string, number>; detailColors?: Record<string, string>;
}

function styleParams(styles: typeof sunShaderDefs.sunStyles, id: string | undefined, over?: Record<string, number>) {
  const index = Math.max(0, styles.findIndex((s) => s.id === id));
  const style = styles[index] || styles[0];
  return { index, params: style.params.map((p) => over?.[p.key] ?? p.default) };
}

const lodOf = (zoom: number) => Math.max(0, Math.min(1, (zoom - 0.1) / 1.9));

/** SunRenderer's uniforms before a system sets any (its field defaults) */
function sunDefaults(): Record<string, number | number[]> {
  return {
    uNoiseScale: 1, uCoronaSize: 2.2, uCoronaIntensity: 0.7, uAtmosphereRadii: [0.7, 2.2], uCoronaRadii: [0.6, 1.5],
    uDarkColor: [0.1, 0.02, 0], uMidColor: [0.4, 0.07, 0], uBrightColor: [1, 0.4, 0], uEdgeColor: [1, 0.67, 0.2],
    uWarpParams: [0.3, 0.5, 0.3], uFbmParams: [4, 0.15, 1], uPlasmaParams: [0.3, 3, 1], uEdgeStyle: [1, 0.03, 0.5],
    uEdgeGlow: [0.5, 0.4, 0.1], uPlasmaColor: [1, 0.6, 0.2], uCenterLight: [0, 0.3, 2], uCenterMidpoint: 0.5,
    uCenterColor: [1, 0.9, 0.7], uInsideAdjust: [0, 0, 1],
  };
}

/**
 * The game's star for `id` (a plain sun: glow, corona rays, the disc), as Renderer sets it up; its noise computed (as in
 * the game), or read from the noise texture (`port`, A) or from the baked simplex (`exact`, A-exact)
 */
export function currentSunLayers(id: string, cb: CentralBody, v: View, noise: boolean | 'port' | 'exact' = false): Layer[] {
  const tag = noise === true || noise === 'port' ? 'port' : noise === 'exact' ? 'exact' : 'cur';
  const tex = tag === 'port' ? { uNoiseTex: 'sunNoise' } : tag === 'exact' ? { uSimplexTex: 'simplex' } : undefined;
  const lod = lodOf(v.zoom);
  const layers: Layer[] = [];
  const R = cb.detailStar ? cb.detailParams?.radius ?? cb.radius ?? 1000 : cb.radius ?? 1000;
  const hue = cb.detailStar ? cb.detailParams?.hue ?? cb.hue ?? 40 : cb.hue ?? 40;
  const p = cb.detailParams ?? {}, sp = cb.detailColors ?? {};

  // Glow (GlowRenderer): drawn first, behind
  const glowRadius = cb.detailStar ? p.glowRadius ?? R * 1.8 + 8000 : R * 1.8 + 8000;
  const glowIntensity = cb.detailStar ? p.glowIntensity ?? 0.6 : 0.6;
  const glowSize = cb.detailStar ? p.glowSize ?? 0.1 : 0.1;
  const half = glowRadius * 0.35;
  if (glowIntensity > 0 && onScreen(v, 0, 0, half, half)) {
    const bright = hex(sp.brightColor ?? '#ffaa22'), edge = hex(sp.edgeColor ?? '#ffdd66');
    layers.push({
      name: 'glow', program: `glow.${tag}`, blend: 'normal', textures: tex,
      verts: worldQuad(v, 0, 0, half, half, [0.325, 0.325, 0.675, 0.675]),
      uniforms: {
        uTime: v.t, uHue: hue, uIntensity: glowIntensity, uLOD: lod, uParallax: [0, 0],
        uInnerRadius: Math.min(0.95, Math.max(0, (R * (1 - Math.max(0, glowSize) * 0.5)) / Math.max(1, glowRadius))),
        uInnerColor: cb.detailStar ? bright.map((c) => Math.min(1, c * 1.1)) : [1, 0.75, 0.4],
        uOuterColor: cb.detailStar ? [edge[0] * 0.9, edge[1] * 0.85, edge[2] * 0.8] : [1, 0.6, 0.4],
      },
    });
  }

  // Corona rays (CoronaRaysRenderer, Renderer.updateCorona): one look per system, seeded by its id
  const rnd = mulberry32(hashString(`corona:${id}`));
  const rays = {
    intensity: 0.75 + rnd() * 0.3, inner: 0.96, outer: 2.2 + rnd() * 0.9, count: Math.round(7 + rnd() * 8), width: 0.05 + rnd() * 0.05,
    variation: 0.3 + rnd() * 0.3, speed: 0.25 + rnd() * 0.3, turbulence: 0.1 + rnd() * 0.25,
  };
  const rh = R * Math.max(0.02, rays.outer);
  if (onScreen(v, 0, 0, rh, rh)) {
    layers.push({
      name: 'rays', program: `rays.${tag}`, blend: 'normal', textures: tex, verts: worldQuad(v, 0, 0, rh, rh),
      uniforms: {
        uTime: v.t, uHue: hue, uIntensity: rays.intensity, uInnerRadius: rays.inner, uOuterRadius: rays.outer, uRayCount: rays.count,
        uRayWidth: rays.width, uRayVariation: rays.variation, uRaySpeed: rays.speed, uRayTurbulence: rays.turbulence,
        uBaseColor: sp.brightColor ? hex(sp.brightColor) : hslRgb(hue, 0.9, 0.62),
        uTipColor: sp.edgeColor ? hex(sp.edgeColor) : hslRgb(hue + 12, 0.85, 0.82),
      },
    });
  }

  // The disc (SunRenderer)
  const u = sunDefaults();
  let radius: number;
  if (cb.detailStar) {
    radius = 0.4;
    const s = styleParams(sunShaderDefs.sunStyles, 'brownian');
    Object.assign(u, {
      uSunStyle: s.index, uCoronaStyle: 0,
      uSunParamsA: [0.5, p.octaves ?? 5, p.lacunarity ?? 2, p.gain ?? 0.5], uSunParamsB: [0.9, p.warpAmount ?? 0.4],
      uCoronaParamsA: [1.1, 1.6, 0.9, 1.0], uCoronaParamsB: [0.25, 0.3],
      uCoronaSize: 0, uCoronaIntensity: 0,
      uWarpParams: [p.warpScale ?? 0.5, 0, p.turbulenceMix ?? 0.3], uFbmParams: [p.noiseScale ?? 4, p.animSpeed ?? 0.15, p.fbmContrast ?? 1],
      uPlasmaParams: [p.plasmaIntensity ?? 0.3, p.plasmaScale ?? 3, p.plasmaSpeed ?? 1],
      uCenterLight: [p.centerDarken ?? 0.5, p.centerHighlight ?? 0.5, p.centerFalloff ?? 1.5], uCenterMidpoint: p.centerMidpoint ?? 0.5,
      uInsideAdjust: [p.innerDarkening ?? 0, p.whiteBalance ?? 0, p.saturation ?? 1],
      uEdgeStyle: [p.edgeBrightness ?? 1, p.edgeThickness ?? 0.03, p.edgeSharpness ?? 0.5], uEdgeGlow: [p.limbDarkening ?? 0.5, 0, 0],
      uAtmosphereRadii: [0, 0], uCoronaRadii: [0, 0],
      uDarkColor: hex(sp.darkColor ?? '#1a0500'), uMidColor: hex(sp.midColor ?? '#661100'), uBrightColor: hex(sp.brightColor ?? '#ff6600'),
      uEdgeColor: hex(sp.edgeColor ?? '#ffaa33'), uPlasmaColor: hex(sp.plasmaColor ?? '#ff9933'), uCenterColor: hex(sp.centerColor ?? '#ffe6cc'),
    });
  } else {
    radius = 0.35;
    const s = styleParams(sunShaderDefs.sunStyles, cb.sunStyle, cb.sunStyleParams);
    const c = styleParams(sunShaderDefs.coronaStyles, cb.coronaStyle, cb.coronaStyleParams);
    Object.assign(u, {
      uSunStyle: s.index, uCoronaStyle: c.index,
      uSunParamsA: s.params.slice(0, 4), uSunParamsB: s.params.slice(4, 6),
      uCoronaParamsA: c.params.slice(0, 4), uCoronaParamsB: c.params.slice(4, 6),
    });
  }
  // SunRenderer.update / fitQuad: the quad reaches the disc's flares and any atmosphere and corona
  const scale = (R / (radius * 5)) * 2.5;
  const reach = Math.max(1.6, (u.uAtmosphereRadii as number[])[1], (u.uCoronaRadii as number[])[1]);
  const e = Math.min(1, radius * reach + 0.001);
  const sh = 2 * e * scale;
  if (onScreen(v, 0, 0, sh, sh)) {
    layers.push({
      name: 'disc', program: `sun.${tag}`, blend: 'normal', textures: tex,
      verts: worldQuad(v, 0, 0, sh, sh, [0.5 - e / 2, 0.5 - e / 2, 0.5 + e / 2, 0.5 + e / 2]),
      uniforms: { ...u, uTime: v.t, uHue: hue, uRadius: radius, uLOD: lod },
    });
  }
  return layers;
}

/**
 * Layers drawn into a render target `scale` the size of the screen (cleared first), then stretched over it with the
 * premultiplied blend: the star at half (or less) resolution. Its own detail is far coarser than a pixel at every zoom,
 * so the picture barely changes and the shading cost drops with the pixel count.
 */
export function atScale(layers: Layer[], scale: number, target = 'sunrt'): Layer[] {
  if (!layers.length) return layers;
  return [
    ...layers.map((l, i) => ({ ...l, target, scale, clearTarget: i === 0 })),
    { name: `${target}.blit`, blit: target, blitScale: scale, blend: 'normal' } as unknown as Layer,
  ];
}

/** Prototype B for the same star: one quad, ±reach radii (`lite`: the low tier) */
export function photoSunLayers(id: string, cb: CentralBody, v: View, lite = false): Layer[] {
  const look = sunPhotoLook(id, cb, v.t, v.zoom);
  const R = cb.detailParams?.radius ?? cb.radius ?? 1000;
  const h = R * look.reach;
  if (!onScreen(v, 0, 0, h, h)) return [];
  return [{ name: 'sun', program: lite ? 'photo.lite' : 'photo', blend: 'normal', textures: { uNoiseTex: 'sunNoise' }, verts: worldQuad(v, 0, 0, h, h), uniforms: look.uniforms }];
}

/** The plasma star (round 2's alternative) for the same star: one quad, ±reach radii (`lite`: the low tier) */
export function plasmaSunLayers(id: string, cb: CentralBody, v: View, lite = false): Layer[] {
  const R = cb.detailParams?.radius ?? cb.radius ?? 1000;
  const look = plasmaLook(id, cb, v.t, R * v.zoom);
  const h = R * look.reach;
  if (!onScreen(v, 0, 0, h, h)) return [];
  return [{ name: 'sun', program: lite ? 'plasma.lite' : 'plasma', blend: 'normal', textures: { uNoise3: 'noise3' }, verts: worldQuad(v, 0, 0, h, h), uniforms: look.uniforms }];
}

/**
 * A sun option by name: a look, then optionally `@scale` to draw it into a render target that size and stretch it.
 * Looks: cur (the game's), port (A), exact (A-exact), photo and lite (B, round 1), plasma and plasma.lite (round 2).
 */
export function sunVariantLayers(id: string, cb: CentralBody, v: View, variant: string): Layer[] {
  const [look, scale] = variant.split('@');
  const layers = look === 'cur' || look === 'port' || look === 'exact' ? currentSunLayers(id, cb, v, look === 'cur' ? false : look)
    : look.startsWith('plasma') ? plasmaSunLayers(id, cb, v, look === 'plasma.lite')
    : photoSunLayers(id, cb, v, look === 'lite');
  return scale ? atScale(layers, Number(scale)) : layers;
}

/** CentralBodyShaders for a black hole, pulsar or brown dwarf (`port`: noise from the texture) */
export function centralLayers(cb: CentralBody, v: View, port = false): Layer[] {
  const r = cb.radius ?? 1000;
  const tex = port ? { uNoiseTex: 'sunNoise' } : undefined;
  const tag = port ? 'port' : 'cur';
  let half: number, uniforms: Record<string, number | number[]>, prog: string;
  if (cb.type === 'black_hole') { half = r * 6; prog = 'BLACK_HOLE'; uniforms = { uTime: v.t, uDiskHue: cb.diskHue ?? 30 }; }
  else if (cb.type === 'brown_dwarf') { half = r * 1.6; prog = 'BROWN_DWARF'; uniforms = { uTime: v.t, uHue: cb.hue ?? 14 }; }
  else { half = Math.max(24000, r * 60); prog = 'PULSAR'; uniforms = { uTime: v.t, uBeamHue: cb.beamHue ?? 190, uSpin: 0.7, uCore: Math.max(0.004, r / Math.max(24000, r * 60)) }; }
  if (!onScreen(v, 0, 0, half, half)) return [];
  return [{ name: prog.toLowerCase(), program: `${prog}.${tag}`, blend: 'normal', textures: tex, verts: worldQuad(v, 0, 0, half, half), uniforms }];
}

/** createShaderQuad's fragment for a body, with its uniforms declared */
function centralFrag(src: Sources, name: keyof Sources['central'], port: boolean): string {
  const decls: Record<string, string> = {
    BLACK_HOLE: 'uniform float uTime; uniform float uDiskHue;',
    BROWN_DWARF: 'uniform float uTime; uniform float uHue;',
    PULSAR: 'uniform float uTime; uniform float uBeamHue; uniform float uSpin; uniform float uCore;',
  };
  const common = port ? withTextureNoise(src.glslCommon) : src.glslCommon;
  return `#version 300 es\nprecision highp float;\nin vec2 vUV;\nout vec4 fragColor;\n${decls[name]}\n${common}\n${src.central[name]}`;
}

/** Every sun program, desktop GLSL */
export function sunPrograms(src: Sources, desktop = true): Programs {
  const out: Programs = {
    'sun.cur': { vert: src.sunVert, frag: src.sunFrag },
    'sun.port': { vert: src.sunVert, frag: withTextureNoise(src.sunFrag) },
    'glow.cur': { vert: src.glowVert, frag: src.glowFrag },
    // (the glow's own noise is a cheap value noise, left as it is)
    'glow.port': { vert: src.glowVert, frag: src.glowFrag },
    'sun.exact': { vert: src.sunVert, frag: withExactNoise(src.sunFrag) },
    'glow.exact': { vert: src.glowVert, frag: src.glowFrag },
    'rays.exact': { vert: src.raysVert, frag: withExactNoise(src.raysFrag) },
    'rays.cur': { vert: src.raysVert, frag: src.raysFrag },
    'rays.port': { vert: src.raysVert, frag: withTextureNoise(src.raysFrag) },
    photo: { vert: SUN_PHOTO_VERT, frag: SUN_PHOTO_FRAG },
    plasma: { vert: SUN_PHOTO_VERT, frag: PLASMA_FRAG },
    'plasma.lite': { vert: SUN_PHOTO_VERT, frag: PLASMA_FRAG.replace('#version 300 es', '#version 300 es\n  #define PLASMA_LITE 1') },
    'photo.lite': { vert: SUN_PHOTO_VERT, frag: SUN_PHOTO_FRAG.replace('#version 300 es', '#version 300 es\n  #define SUN_PHOTO_LITE 1') },
  };
  for (const n of ['BLACK_HOLE', 'PULSAR', 'BROWN_DWARF'] as const) {
    out[`${n}.cur`] = { vert: src.quadVert, frag: centralFrag(src, n, false) };
    out[`${n}.port`] = { vert: src.quadVert, frag: centralFrag(src, n, true) };
  }
  if (desktop) for (const k of Object.keys(out)) out[k] = { vert: toDesktop(out[k].vert), frag: toDesktop(out[k].frag) };
  return out;
}
