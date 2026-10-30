/**
 * The planet harness's layers for a view: the game's planets (PlanetRenderer's FRAGMENT, read from its file as it is,
 * set up the way PlanetRenderer.makeBody / update set it up) and the brown dwarf (CentralBodyShaders' BROWN_DWARF),
 * against the prototypes (client/src/rendering/planet-proto). No Node APIs here: the planet lab page draws the same
 * layers. Docs: docs/rendering/planet-prototypes.md.
 */

import type { PlanetData, PlanetKind } from '@space-game/common';
import { lookFor, planetProtoDecls, planetProtoUniforms, PLANET_PROTO_FRAG, type BodyIn } from '../../client/src/rendering/planet-proto/planetProto';

export interface View { w: number; h: number; dpr: number; cam: [number, number]; zoom: number; t: number }
export interface Layer {
  name: string; program: string; uniforms: Record<string, number | number[]>; textures?: Record<string, string>;
  verts: number[]; blend: 'normal' | 'add' | 'none'; untimed?: boolean;
}
export type Programs = Record<string, { vert: string; frag: string }>;

/** The template-string constants a source file defines */
export function shaderConsts(src: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const m of src.matchAll(/(?:export )?const (\w+) = `([\s\S]*?)`;/g)) found[m[1]] = m[2];
  return found;
}

export interface Sources { planetFrag: string; dwarfFrag: string; quadVert: string; glslCommon: string }
export function sourcesFrom(text: { planet: string; central: string; quad: string }, glslCommon: string): Sources {
  const planet = shaderConsts(text.planet), central = shaderConsts(text.central), quad = shaderConsts(text.quad);
  return { planetFrag: planet.FRAGMENT, dwarfFrag: central.BROWN_DWARF, quadVert: quad.VERTEX_SHADER, glslCommon };
}

const glslType = (v: number | number[]) => (typeof v === 'number' ? 'float' : v.length === 2 ? 'vec2' : 'vec3');
const decls = (u: Record<string, number | number[]>) => Object.entries(u).map(([k, v]) => `uniform ${glslType(v)} ${k};`).join('\n');
/** A shaderQuad program as shaderQuadProgram writes it */
function quadFrag(body: string, u: Record<string, number | number[]>, common: string, defines = ''): string {
  return `#version 300 es
    precision highp float;
    in vec2 vUV;
    out vec4 fragColor;
    ${decls(u)}
    ${common}
    ${defines}
    ${body}
  `;
}
const desktop = (s: string) => s.replace(/^\s*#version 300 es/, '#version 330 core');

// ------------------------------------------------------------------ the game's planets, as PlanetRenderer sets them up
const KIND_INDEX: Record<PlanetKind, number> = { rocky: 0, desert: 1, ice: 2, gas: 3, lava: 4, ocean: 5, toxic: 6 };
const DEFAULT_HUE: Record<PlanetKind, number> = { rocky: 28, desert: 36, ice: 200, gas: 30, lava: 14, ocean: 210, toxic: 85 };
function hueToRgb(h: number, s: number, l: number): number[] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)];
}
/** PlanetRenderer.planetUniforms, mirrored (it isn't exported) */
function currentUniforms(kind: PlanetKind, hue: number, seed: number, extent: number, rings?: PlanetData['rings']): Record<string, number | number[]> {
  const atmo = kind === 'rocky' ? 0.15 : kind === 'lava' ? 0.4 : kind === 'desert' ? 0.45 : 0.8;
  const atmoHue = kind === 'ocean' ? 205 : kind === 'toxic' ? 75 : kind === 'lava' ? 20 : hue;
  return {
    uTime: 0, uKind: KIND_INDEX[kind], uHue: hue, uSeed: [seed % 97, (seed * 7) % 89], uLight: [1, 0], uLightAmt: 1,
    uPR: 1 / extent, uRingIn: rings?.inner ?? 0, uRingOut: rings?.outer ?? 0, uRingHue: rings?.hue ?? hue,
    uSpin: kind === 'gas' ? 0.02 : 0.008, uAtmo: atmo, uAtmoColor: hueToRgb(atmoHue, 0.6, 0.65),
  };
}

export function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}

/** A body to draw: a planet, one of its moons, or the brown dwarf */
export interface Body extends BodyIn {
  name: string; radius: number; seed: number; extent: number; dwarf?: boolean;
}

/** Every body a system has, as PlanetRenderer.setSystem makes them (moons: rocky and ice in turn) */
export function bodiesOf(system: any): Body[] {
  const out: Body[] = [];
  const cb = system.centralBody;
  if (cb?.type === 'brown_dwarf') out.push({ id: `${system.id}.dwarf`, name: `${system.name} (brown dwarf)`, kind: 'dwarf', hue: cb.hue ?? 14, radius: cb.radius, seed: 0, extent: 1.6, dwarf: true });
  for (const p of (system.planets ?? []) as PlanetData[]) {
    const seed = hashId(p.id);
    out.push({ id: p.id, name: p.name, kind: p.kind, hue: p.hue ?? DEFAULT_HUE[p.kind], rings: p.rings, radius: p.radius, seed, extent: Math.max(1.3, p.rings?.outer ?? 0) });
    (p.moons ?? []).forEach((m, i) => out.push({
      id: `${p.id}.moon${i}`, name: `${m.name ?? `${p.name} moon ${i + 1}`}`, kind: i % 2 ? 'ice' : 'rocky', hue: 30 + i * 140,
      radius: m.radius, seed: seed + i * 13, extent: 1.3,
    }));
  }
  return out;
}

/** A world-space quad (centre, half-size) as clip-space strip vertices */
export function worldQuad(v: View, cx: number, cy: number, h: number): number[] {
  const clip = (wx: number, wy: number) => [((wx - v.cam[0]) * v.zoom) / (v.w / 2), -((wy - v.cam[1]) * v.zoom) / (v.h / 2)];
  const [a, b] = clip(cx - h, cy - h), [c, d] = clip(cx + h, cy + h);
  return [a, b, 0, 0, c, b, 1, 0, a, d, 0, 1, c, d, 1, 1];
}

/** Black hole and pulsar systems dim the planets' light (PlanetRenderer.setSystem) */
export const lightAmtOf = (centralType?: string) => (centralType === 'black_hole' ? 0.55 : centralType === 'pulsar' ? 0.75 : 1);

/**
 * The variants: `cur` (the game's), `proto` (the prototype), `proto.lite` (its low tier: one flow phase, no relief,
 * no fine octave)
 */
export type Variant = 'cur' | 'proto' | 'proto.lite';
export const VARIANT_LABEL: Record<Variant, string> = { cur: 'current', proto: 'prototype', 'proto.lite': 'prototype lite' };

/** Where a body sits and where its light comes from (a unit vector toward the star, world space, y down) */
export interface Placement { x: number; y: number; light: [number, number]; lightAmt: number }

export function bodyLayer(b: Body, variant: Variant, v: View, at: Placement): Layer {
  const half = b.radius * b.extent;
  const verts = worldQuad(v, at.x, at.y, half);
  if (b.dwarf) {
    if (variant === 'cur') return { name: 'dwarf', program: 'dwarf.cur', blend: 'normal', verts, uniforms: { uTime: v.t, uHue: b.hue ?? 14 } };
  } else if (variant === 'cur') {
    const u = currentUniforms(b.kind as PlanetKind, b.hue!, b.seed, b.extent, b.rings);
    return { name: 'planet', program: 'planet.cur', blend: 'normal', verts, uniforms: { ...u, uTime: v.t, uLight: at.light, uLightAmt: at.lightAmt } };
  }
  const u = planetProtoUniforms(lookFor(b, b.seed), b.kind, b.seed, b.extent);
  return {
    name: 'planet', program: variant === 'proto.lite' ? 'planet.lite' : 'planet.proto', blend: 'normal', verts, textures: { uNoise: 'planetNoise' },
    uniforms: { ...u, uTime: v.t, uLight: at.light, uLightAmt: b.dwarf ? 1 : at.lightAmt },
  };
}

/** The prototype's uniforms (names and types) for the declarations */
const PROTO_U = planetProtoUniforms(lookFor({ id: 'x', kind: 'rocky' }, 0), 'rocky', 0, 1.3);

/** A plain sky behind (not timed): faint stars and a little nebula, so the edge is seen against something */
const BACKDROP = `
  void main() {
    vec2 q = vUV * uRes / 3.0 + uCam;
    vec2 i = floor(q);
    float h = hash(i);
    vec2 f = fract(q) - 0.5 - (vec2(hash(i + 7.1), hash(i + 3.3)) - 0.5) * 0.6;
    float star = step(0.985, h) * smoothstep(0.35, 0.0, length(f)) * (0.35 + 0.65 * hash(i + 1.7));
    float neb = fbm(vUV * uRes / 900.0 + uCam / 300.0);
    vec3 c = vec3(0.012, 0.014, 0.03) + vec3(0.05, 0.04, 0.09) * smoothstep(0.45, 0.85, neb) + vec3(0.85, 0.9, 1.0) * star;
    fragColor = vec4(c, 1.0);
  }
`;
export function backdropLayer(v: View): Layer {
  return {
    name: 'backdrop', program: 'backdrop', blend: 'none', untimed: true, verts: [-1, 1, 0, 0, 1, 1, 1, 0, -1, -1, 0, 1, 1, -1, 1, 1],
    uniforms: { uRes: [v.w * v.dpr, v.h * v.dpr], uCam: [(v.cam[0] * v.zoom * 0.02) % 1000, (v.cam[1] * v.zoom * 0.02) % 1000] },
  };
}

/** Every program (desktop GLSL for the native harness, ES for the browser) */
export function planetPrograms(src: Sources, forDesktop: boolean): Programs {
  const fix = forDesktop ? desktop : (s: string) => s;
  const curU = currentUniforms('rocky', 0, 0, 1.3);
  const vert = fix(src.quadVert);
  return {
    'planet.cur': { vert, frag: fix(quadFrag(src.planetFrag, curU, src.glslCommon)) },
    'dwarf.cur': { vert, frag: fix(quadFrag(src.dwarfFrag, { uTime: 0, uHue: 0 }, src.glslCommon)) },
    'planet.proto': { vert, frag: fix(quadFrag(PLANET_PROTO_FRAG, PROTO_U, src.glslCommon)) },
    'planet.lite': { vert, frag: fix(quadFrag(PLANET_PROTO_FRAG, PROTO_U, src.glslCommon, '#define PLANET_LITE')) },
    backdrop: { vert, frag: fix(quadFrag(BACKDROP, { uRes: [0, 0], uCam: [0, 0] }, src.glslCommon)) },
  };
}

export { planetProtoDecls };
