/**
 * The nests' materials: the asteroid materials' shader (rocks/RockMaterials.ts),
 * copied, so nests sit in the same light as the rocks round them: the same
 * per-vertex lighting from the Lighting's uniforms (each nest is a LitMesh),
 * the same atlas (one read per pixel), rows 0-5 the rocks' own materials
 * (their very values) and rows 6+ nest materials over the same atlas tiles.
 * On top of the rocks' shader:
 *   motion     each vertex circles the nest's centre and tumbles round its
 *              piece's centre at its own rates (aOrb, uTime): a knot swirls in one draw
 *   plating    plating materials lie in panels: seams along the plate's own
 *              axes and a slightly different tone per panel (worked out in the
 *              pixel, no texture), over a fine, faint grain instead of the
 *              rocks' pitted metal
 *   floor      a little fill light where the scene's light is weaker than
 *              NEST_FLOOR, from a fixed slant, so a nest in a dark system
 *              keeps its shape and stays readable
 *   ships      their shadows over it: soft discs, taking most of the sun and some of the sky
 *   far off    fine pieces shrink into their centres as the nest gets small on
 *              screen (NEST_LOD.fineGone..fineFull, its radius in pixels), and
 *              the relief and highlights fade by each piece's own size on screen
 *              as the rocks' do, so a distant nest is a calm lit shape
 */

import { BufferImageSource, GlProgram, Texture, UniformGroup } from 'pixi.js';
import { NEST_RADIUS } from '@space-game/common';
import { MAX_LIGHTS, SHIP_SHADE } from '../lighting/litShader';
import { rockUniforms } from '../rocks/RockMaterials';

/** On-screen sizes (pixels). light/detailFrom/detailFull: per piece, as ROCK_LOD; fineGone/fineFull: the nest's radius over which fine pieces shrink away */
export const NEST_LOD = { light: 10, detailFrom: 5, detailFull: 18, fineGone: 45, fineFull: 80 };
/** The least light a nest takes (a fill from a fixed slant makes up the rest) */
export const NEST_FLOOR = 0.3;

/** Material rows (0-5 the rocks') */
export const M = { stone: 0, metal: 1, ice: 2, crystal: 3, tar: 4, leestone: 5, plating: 6, gold: 7, scrap: 8, soot: 9, chrome: 10, knot: 11, crate: 12, blade: 13, strip: 14 } as const;

/**
 * Nest materials, as the rocks' rows:
 *  A: highlight, shininess, ice, tint by colour · B: relief, texture scale, cavity, albedo
 *  C: crevice rgb, drift · D: thin film, grazing sheen, weathering, polish varies
 *  E: atlas tile, seam darkness (0: no plating), seams per surface unit across, down (0: none down; strips)
 */
const NEST_MATS: { A: number[]; B: number[]; C: number[]; D: number[]; E: number[] }[] = [
  /* plating */ { A: [0.3, 22, 0, 0.3], B: [0.04, 3.2, 0.03, 1], C: [0.36, 0.38, 0.44, 0.15], D: [0, 0.35, 0.04, 0.3], E: [1, 0.35, 1.5, 2.3] },
  /* gold    */ { A: [0.95, 26, 0, 1], B: [0.3, 1.3, 0.2, 1], C: [0.45, 0.32, 0.12, 0.3], D: [0, 0.6, 0.03, 0.2], E: [1, 0, 0, 0] },
  /* scrap   */ { A: [0.36, 12, 0, 1], B: [0.7, 1.6, 0.25, 0.92], C: [0.82, 0.4, 0.17, 0.8], D: [0, 0.35, 0.32, 0.8], E: [1, 0, 0, 0] },
  /* soot    */ { A: [0.18, 9, 0, 0.6], B: [0.6, 1.5, 0.45, 0.85], C: [0.1, 0.085, 0.08, 0.75], D: [0, 0.2, 0.32, 0.5], E: [1, 0, 0, 0] },
  /* chrome  */ { A: [1.5, 70, 0, 0.2], B: [0.25, 1, 0.15, 1], C: [0.5, 0.5, 0.5, 0], D: [0, 0.8, 0, 0], E: [1, 0, 0, 0] },
  /* knot    */ { A: [0.5, 24, 0, 0], B: [0.75, 0.7, 0.35, 1.2], C: [0.3, 0.24, 0.42, 0.3], D: [0.4, 0.5, 0.1, 0.3], E: [3, 0, 0, 0] },
  /* crate   */ { A: [0.12, 8, 0, 0], B: [0.7, 1, 0.4, 1], C: [0.4, 0.3, 0.2, 0.45], D: [0, 0.1, 0.2, 0.4], E: [1, 0, 0, 0] },
  /* blade   */ { A: [0.8, 40, 0, 0.5], B: [0.12, 1.6, 0.1, 1], C: [0.2, 0.3, 0.5, 0.2], D: [0.15, 0.6, 0, 0], E: [1, 0, 0, 0] },
  /* strip   */ { A: [0.3, 18, 0, 0.3], B: [0.06, 3.2, 0.04, 1], C: [0.36, 0.38, 0.44, 0.15], D: [0, 0.3, 0.04, 0.3], E: [1, 0.4, 2.2, 0] },
];
const NM = 6 + NEST_MATS.length;

function matRows() {
  const ru = rockUniforms.uniforms;
  const A = new Float32Array(NM * 4), B = new Float32Array(NM * 4), C = new Float32Array(NM * 4), D = new Float32Array(NM * 4), E = new Float32Array(NM * 4);
  A.set(ru.uMatA); B.set(ru.uMatB); C.set(ru.uMatC); D.set(ru.uMatD);
  for (let i = 0; i < 6; i++) E[i * 4] = i;
  NEST_MATS.forEach((m, j) => { const i = 6 + j; A.set(m.A, i * 4); B.set(m.B, i * 4); C.set(m.C, i * 4); D.set(m.D, i * 4); E.set(m.E, i * 4); });
  return { A, B, C, D, E };
}

const rows = matRows();
/** Shared by every nest: the materials, the zoom, the clock, the on-screen thresholds and the light floor */
export const nestUniforms = new UniformGroup({
  uMatA: { value: rows.A, type: 'vec4<f32>', size: NM },
  uMatB: { value: rows.B, type: 'vec4<f32>', size: NM },
  uMatC: { value: rows.C, type: 'vec4<f32>', size: NM },
  uMatD: { value: rows.D, type: 'vec4<f32>', size: NM },
  uMatE: { value: rows.E, type: 'vec4<f32>', size: NM },
  uZoom: { value: 1, type: 'f32' },
  uTime: { value: 0, type: 'f32' },
  /** light, detailFrom, detailFull (pixels, per piece) */
  uLod: { value: new Float32Array([NEST_LOD.light, NEST_LOD.detailFrom, NEST_LOD.detailFull, 0]), type: 'vec4<f32>' },
  /** the nest's radius (world), fine pieces gone / whole (its radius in pixels), the light floor */
  uFar: { value: new Float32Array([NEST_RADIUS, NEST_LOD.fineGone, NEST_LOD.fineFull, NEST_FLOOR]), type: 'vec4<f32>' },
});

const LIGHTS = `uniform vec3 uAmbient; uniform vec4 uSun; uniform vec3 uSunColor; uniform vec2 uSunElev; uniform float uCount;
uniform vec4 uLightPos[${MAX_LIGHTS}]; uniform vec4 uLightCol[${MAX_LIGHTS}]; uniform vec4 uLightCone[${MAX_LIGHTS}];`;

// uXform[0]: where the nest is in the world (LitMesh: Lighting fills it), for the lighting; Pixi places the mesh itself
const VERT = `#version 300 es
in vec2 aPosition; in vec3 aNormal; in vec4 aColor; in float aSlot; in vec4 aSurf; in vec3 aSmooth; in vec4 aMat;
in vec4 aOrb;      // the piece's centre (xy), how fast it circles the nest's centre, how fast it tumbles round its own
out vec3 vColor; out vec3 vTint; out vec3 vCx; out vec3 vCy; out vec4 vVein; out vec3 vUV; flat out vec2 vTile; flat out vec4 vSeam; out vec2 vRel; out vec2 vSun;
uniform mat3 uProjectionMatrix; uniform mat3 uWorldTransformMatrix; uniform mat3 uTransformMatrix;
uniform vec4 uXform[2]; uniform vec4 uFade[2];
uniform vec4 uMatA[${NM}]; uniform vec4 uMatB[${NM}]; uniform vec4 uMatC[${NM}]; uniform vec4 uMatD[${NM}]; uniform vec4 uMatE[${NM}];
uniform float uZoom; uniform float uTime; uniform vec4 uLod; uniform vec4 uFar; ${LIGHTS}
const vec3 LUM = vec3(0.3, 0.5, 0.2);
const vec3 FILL = vec3(-0.42, -0.5, 0.757);
vec2 rot(vec2 p, vec2 c) { return vec2(c.x * p.x - c.y * p.y, c.y * p.x + c.x * p.y); }
void main() {
  int mi = int(aMat.x + 0.5);
  vec4 X = uXform[int(aSlot + 0.5)], MA = uMatA[mi], MB = uMatB[mi], MC = uMatC[mi], MD = uMatD[mi], ME = uMatE[mi];
  float s = length(X.zw);
  float px = aSurf.w * s * uZoom, nest = uFar.x * s * uZoom;
  // rock bodies: their full or light mesh by size; fine pieces shrink into their centres as the nest gets small
  if (s == 0.0 || (aMat.w > -0.5 && (aMat.w > 0.5) != (px < uLod.x))) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float keep = aMat.w < -1.5 ? smoothstep(uFar.y, uFar.z, nest) : 1.0;
  if (keep <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float ta = uTime * aOrb.w, oa = uTime * aOrb.z;
  vec2 tc = vec2(cos(ta), sin(ta)), oc = vec2(cos(oa), sin(oa));
  vec2 p = rot(rot(aPosition - aOrb.xy, tc) * keep + aOrb.xy, oc);
  vec2 w = X.xy + rot(p, X.zw);
  vec2 cs = rot(rot(X.zw / s, tc), oc);
  vec3 n = vec3(cs.x * aNormal.x - cs.y * aNormal.y, cs.y * aNormal.x + cs.x * aNormal.y, aNormal.z);
  // today's lighting (litShader.ts), gathering the light's overall direction and colour as it goes
  vec3 L = uAmbient;
  vec2 ds = uSun.xy - w;
  float dist = length(ds);
  vec3 sl = vec3(ds / max(dist, 1.0) * uSunElev.x, uSunElev.y);
  float sunK = uSun.w / (1.0 + dist * dist / (uSun.z * uSun.z));
  L += uSunColor * sunK * max(dot(n, sl), 0.0);
  vec3 dsum = sl * sunK, csum = uSunColor * sunK;
  for (int i = 0; i < ${MAX_LIGHTS}; i++) {
    if (float(i) >= uCount) break;
    vec4 P = uLightPos[i];
    vec2 d = P.xy - w;
    float dd = length(d);
    if (dd >= P.z) continue;
    float a = 1.0 - dd / P.z;
    a *= a;
    vec4 C = uLightCone[i];
    if (C.z > -1.5) a *= smoothstep(C.z, C.w, dot(-d / max(dd, 1.0), C.xy));
    vec3 ld = normalize(vec3(d, P.w));
    float k = uLightCol[i].a * a;
    L += uLightCol[i].rgb * (k * max(dot(n, ld), 0.0));
    dsum += ld * k; csum += uLightCol[i].rgb * k;
  }
  // the floor: what light is missing, as a fill from a fixed slant (so the nest keeps its shape in the dark)
  float lack = max(0.0, uFar.w - dot(uAmbient + csum * 0.6, LUM));
  L += vec3(lack) * (0.55 + 0.45 * max(dot(n, FILL), 0.0));
  dsum += FILL * lack * 0.6; csum += vec3(lack * 0.6);
  // the sun's share of the light here (what a ship's shadow takes)
  vSun = vec2(clamp(dot(uSunColor, LUM) * sunK * max(dot(n, sl), 0.0) / max(dot(L, LUM), 0.001), 0.0, 1.0), 1.0 - aColor.a);
  vRel = w - X.xy;
  float fade = uFade[0].x, k = clamp((px - uLod.y) / max(uLod.z - uLod.y, 1.0), 0.0, 1.0), h = aMat.y;
  vec3 Lc = min(L, vec3(1.6)), cl = min(csum, vec3(1.6));
  float lum = dot(Lc, LUM), rim = 1.0 - clamp(n.z, 0.0, 1.0);
  float mot = sin(aSurf.x * 1.7 + h * 9.0) * sin(aSurf.y * 1.3 + h * 4.0) + 0.5 * sin((aSurf.x + aSurf.y) * 3.1 + h * 2.0);
  vec3 albedo = aColor.rgb * mix(1.0, MB.w, k) * (1.0 + MD.z * mot * k);
  albedo = mix(albedo, MC.rgb * dot(albedo, LUM), clamp(-mot, 0.0, 1.0) * MC.w * 0.5 * k);
  vColor = albedo * mix(Lc, vec3(1.0), aColor.a) * fade;
  vColor += aColor.rgb * vec3(0.55, 0.8, 1.0) * MA.z * max(0.0, 0.7 - lum) * k * fade;
  vColor += vec3(0.6, 0.85, 1.0) * MA.z * rim * rim * (0.35 + lum * 0.5) * k * fade;
  // plating keeps its texture square to its edges (seams run along them); everything else turns by its seed
  float ang = ME.y > 0.0 ? 0.0 : h * 6.2831, ca = cos(ang), sa = sin(ang);
  vec3 sN = vec3(cs.x * aSmooth.x - cs.y * aSmooth.y, cs.y * aSmooth.x + cs.x * aSmooth.y, aSmooth.z);
  vec2 ul = vec2(ca, -sa);
  vec3 U = vec3(cs.x * ul.x - cs.y * ul.y, cs.y * ul.x + cs.x * ul.y, 0.0);
  vec3 T = normalize(U - sN * dot(U, sN)), B = cross(sN, T);
  float dl = length(dsum);
  vec3 Ld = dl > 0.0001 ? dsum / dl : vec3(0.0, 0.0, 1.0);
  vec2 Lt = vec2(dot(Ld, T), dot(Ld, B));
  vec3 D = albedo * cl * (1.0 - aColor.a) * fade;
  vec3 Hv = normalize(Ld + vec3(0.0, 0.0, 1.0));
  vec2 Ht = vec2(dot(Hv, T), dot(Hv, B));
  float rough = 0.55 + 0.45 * sin(aSurf.x * 2.3 + aSurf.y * 1.7 + h * 11.0) * sin(aSurf.y * 1.9 - aSurf.x * 1.1 + h * 7.0);
  float kx = k * rough * MB.x;
  float nh = clamp(dot(n, Hv), 0.0, 1.0), sp = pow(nh, MA.y), dsp = min(MA.y * sp / max(nh, 0.05), 4.0) * 1.2 * kx;
  vec3 irid = 0.5 + 0.5 * cos(6.2831 * (nh * 1.7 + rim + h + vec3(0.0, 0.33, 0.67)));
  vec3 S = mix(mix(vec3(1.0), aColor.rgb * 1.6, MA.w), irid * 1.4, MD.x) * cl * MA.x * k * (1.0 - aColor.a) * fade * mix(1.0, rough, MD.w);
  vColor += S * (sp + MD.y * rim * rim * rim);
  vCx = D * (0.6 * kx * Lt.x) + S * (dsp * Ht.x);
  vCy = D * (0.6 * kx * Lt.y) + S * (dsp * Ht.y);
  vTint = (vColor - MC.rgb * dot(vColor, LUM)) * MC.w * 2.0 * k;
  // greyseam: dull grey, a touch cold, lit as the rock is, glowing faintly of its own
  vVein = vec4(mix(vec3(0.56, 0.61, 0.67), aColor.rgb, 0.25) * mix(Lc, vec3(1.0), 0.3) * fade, aMat.z * k);
  vec2 lp = aSurf.xy * MB.y;
  vUV = vec3(vec2(ca * lp.x - sa * lp.y, sa * lp.x + ca * lp.y) + vec2(h * 7.0, h * 3.0), MB.z * k);
  vTile = vec2(mod(ME.x, 3.0), floor(ME.x / 3.0));
  // seams: darkness (faded with the detail), across and down per texture unit
  vSeam = vec4(ME.y * k * (1.0 - aColor.a), ME.z / max(MB.y, 0.01), ME.w / max(MB.y, 0.01), h * 13.0);
  gl_Position = vec4((uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix * vec3(p, 1.0)).xy, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision mediump float;
in vec3 vColor; in vec3 vTint; in vec3 vCx; in vec3 vCy; in vec4 vVein; in vec3 vUV; flat in vec2 vTile; flat in vec4 vSeam; in highp vec2 vRel; in vec2 vSun;
uniform sampler2D uDetail;
${SHIP_SHADE}
out vec4 fragColor;
void main() {
  vec2 g = vec2(1.0 / 3.0, 0.5);
  vec4 t = textureGrad(uDetail, (vTile + fract(vUV.xy)) * g, dFdx(vUV.xy) * g, dFdy(vUV.xy) * g);
  vec2 sl = t.rg * 2.0 - 1.0;
  float d = t.b - 0.5;
  vec3 c = vColor * (1.0 + d * vUV.z) + min(d, 0.0) * vTint + vCx * sl.x + vCy * sl.y;
  float shade = dot(c, vec3(0.3, 0.5, 0.2)) / max(dot(vColor, vec3(0.3, 0.5, 0.2)), 0.02);
  c = mix(c, vVein.rgb * shade, t.a * vVein.a);
  if (vSeam.x > 0.001) {
    // plating: panels with a tone each, seams between them (a fixed width on the surface, smoothed over a pixel; gone when panels are a few pixels across)
    vec2 q = vUV.xy * vSeam.yz;
    vec2 fw = fwidth(q), cell = floor(q);
    vec2 e = 0.5 - abs(fract(q) - 0.5);
    if (vSeam.z <= 0.0) { e.y = 0.5; cell.y = 0.0; }
    float seam = 1.0 - smoothstep(0.02, 0.02 + max(fw.x, fw.y) * 1.2, min(e.x, e.y));
    float vis = clamp(1.6 - max(fw.x, fw.y) * 9.0, 0.0, 1.0);
    float tone = fract(sin(dot(cell, vec2(12.9898, 78.233)) + vSeam.w) * 43758.5453);
    c *= 1.0 + vis * vSeam.x * ((tone - 0.5) * 0.22 - seam * 0.9);
  }
  c *= shipDim(vRel, vSun);
  fragColor = vec4(max(c, 0.0), 1.0);
}`;

let program: GlProgram | null = null;
export function nestProgram(): GlProgram {
  return (program ??= new GlProgram({ vertex: VERT, fragment: FRAG, name: 'nest-materials' }));
}

let flat: Texture | null = null;
/** Until the rocks' atlas is built: a flat one (no relief, no cavity, no veins) */
export function flatAtlas(): Texture {
  return (flat ??= new Texture({ source: new BufferImageSource({
    resource: new Uint8Array(new Array(4 * 4).fill(0).map((_, i) => (i % 4 === 3 ? 0 : 128))), width: 2, height: 2,
    alphaMode: 'no-premultiply-alpha', scaleMode: 'linear',
  }) }));
}

let glow: Texture | null = null;
/** A soft glow (no hard disc), white: lamps tint it */
export function glowTexture(): Texture {
  if (glow) return glow;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d')!, gr = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  for (let i = 0; i <= 10; i++) { const t = i / 10; gr.addColorStop(t, `rgba(255,255,255,${(Math.exp(-t * t * 5.5) * (1 - t)).toFixed(3)})`); }
  x.fillStyle = gr;
  x.fillRect(0, 0, 128, 128);
  return (glow = Texture.from(c));
}
