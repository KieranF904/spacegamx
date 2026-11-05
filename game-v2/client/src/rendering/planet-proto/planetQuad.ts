/**
 * A planet, moon or brown dwarf as drawn in the game (docs/rendering/planet-prototypes.md): one shaderQuad with the
 * planet fragment (planetProto.ts) at the quality tier's detail, its look's uniforms and the planets' textures. Every
 * live quad follows the detail level: setPlanetDetail swaps their programs (each compiled ahead: planetPrograms).
 */
import type { GlProgram, Shader } from 'pixi.js';
import { createShaderQuad, shaderQuadProgram, type ShaderQuad, type UniformDef } from '../shaderQuad';
import { lookFor, planetFragment, planetProtoUniforms, PLANET_DETAILS, type BodyIn, type PlanetDetail } from './planetProto';
import { planetTextures } from './planetTextures';

/** The look's uniforms as shaderQuad's (floats, vec2, vec3) */
function defs(u: Record<string, number | number[]>): Record<string, UniformDef> {
  const out: Record<string, UniformDef> = {};
  for (const [k, v] of Object.entries(u)) {
    out[k] = typeof v === 'number' ? { value: v, type: 'f32' } : { value: new Float32Array(v), type: v.length === 2 ? 'vec2<f32>' : 'vec3<f32>' };
  }
  return out;
}

/** The uniforms' names and types (the same for every body), for the programs */
const SHAPE = defs(planetProtoUniforms(lookFor({ id: '', kind: 'rocky' }, 0), 'rocky', 0, 1.3));

/** The program for a detail level */
export function planetProgram(detail: PlanetDetail): GlProgram {
  return shaderQuadProgram(planetFragment(detail), SHAPE);
}
/** Every level's program (for compiling ahead: the current tier's first) */
export function planetPrograms(first: PlanetDetail = detailNow): GlProgram[] {
  return [first, ...PLANET_DETAILS.filter((d) => d !== first)].map(planetProgram);
}

let detailNow: PlanetDetail = 'fine';
const live = new Set<ShaderQuad>();

/** Draw every planet at this detail (the quality tier's planetDetail) */
export function setPlanetDetail(detail: PlanetDetail): void {
  if (detail === detailNow) return;
  detailNow = detail;
  const program = planetProgram(detail);
  for (const q of live) {
    if (q.mesh.destroyed) { live.delete(q); continue; }
    (q.mesh.shader as Shader).glProgram = program;
  }
}
export const planetDetail = (): PlanetDetail => detailNow;

/**
 * A body's quad, `extent` planet radii each way from its centre (enough for its haze and rings), `radius` its radius in
 * world units. `seed` picks its features; uTime, uLight and uLightAmt are set as it's drawn. `detail`: always this
 * level, whatever the tier (the sign-in screen's hero body is always fine); else it follows setPlanetDetail.
 */
export function planetQuad(body: BodyIn, seed: number, radius: number, extent: number, detail?: PlanetDetail): ShaderQuad {
  const { noise, crack } = planetTextures();
  const u = defs(planetProtoUniforms(lookFor(body, seed), body.kind, seed, extent));
  const quad = createShaderQuad(planetFragment(detail ?? detailNow), u, radius * extent, { uNoise: noise, uCrack: crack });
  if (detail) return quad;
  for (const q of live) if (q.mesh.destroyed) live.delete(q);
  live.add(quad);
  return quad;
}
