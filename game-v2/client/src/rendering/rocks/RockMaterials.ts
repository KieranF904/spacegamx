/**
 * Asteroid materials (AsteroidBatch draws with them, close in): each kind of
 * rock looks like what it's made of. On top of today's lighting, worked out
 * per vertex exactly as litShader.ts does it, each material adds:
 *   relief      its tile of the atlas (rockTextures.ts), tilting each pixel
 *               towards or away from the light (first-order normal mapping:
 *               the light's direction in the surface's own frame, per vertex)
 *   cavity      hollows darker (in ice, lighter: cracks catch the light),
 *               drifting towards the material's crevice colour (rust in metal,
 *               dust in stone, blue-white in ice)
 *   highlight   worked out per vertex with how fast it grows as the relief
 *               tilts the surface, so the pixel only adds it: white, tinted by
 *               the rock (metal) or a thin-film shimmer (crystal, tar); its
 *               polish varies over the rock; a grazing sheen at the edge
 *   weathering  broad lighter and darker patches over the rock
 *   ice         a cold glow on the shadow side and a cold rim
 *   greyseam    veins in the atlas's alpha, on about one rock in three (not
 *               ice), lit as the rock is, glowing faintly of their own
 * Every pixel is a texture read and a handful of multiply-adds.
 *
 * By how big each rock is on screen (its radius in pixels, so a big outlier
 * keeps its detail further out than a pebble): the detail fades in from
 * ROCK_LOD.detailFrom to ROCK_LOD.detailFull (at zero this is today's
 * shader), and below ROCK_LOD.light the rock is drawn with its light mesh.
 * Each rock carries both meshes; the vertex shader drops the one not wanted,
 * so a chunk stays one draw. A chunk with no rock big enough for detail is
 * drawn with `rockLitProgram`: today's lighting, nothing more.
 */

import { BufferImageSource, GlProgram, Texture, UniformGroup } from 'pixi.js';
import type { Composition } from '@space-game/common';
import { MAX_LIGHTS, fades } from '../lighting/litShader';
import { rockAtlasData } from '../procedural';
import { ROCK_MATERIALS, ROCK_TILE, type RockMaterial } from './rockTextures';

/** On-screen radii (pixels): below `light`, a rock's light mesh; its detail fades in from `detailFrom` to `detailFull` (tunable: RenderTuningPanel). The detail stays on nearly to a speck (mipmapping smooths it as rocks shrink, and a small rock costs few pixels), the light mesh takes over early */
export const ROCK_LOD = { light: 10, detailFrom: 4, detailFull: 14 };

/** Rock types whose material isn't their main ore's */
const MATERIAL_OF_TYPE: Record<string, RockMaterial> = {
  asteroid_metal: 'stone', rock_ashback: 'stone',
  asteroid_mega: 'metal', rock_slag: 'metal',
  asteroid_crystal: 'crystal',
};
const MATERIAL_OF_ORE: Record<string, RockMaterial> = {
  ice: 'ice', aurora_rime: 'ice', hydrazine_slush: 'ice', cryo_gas: 'ice',
  crystal: 'crystal', void_opal: 'crystal',
  polymer_precursor: 'tar', leestone_ore: 'leestone',
  copper_ore: 'metal', titanium_ore: 'metal', cobalt_ore: 'metal', chromite: 'metal', platinoid_ore: 'metal', ferrite_ore: 'metal', neutronium_ore: 'metal',
};

/** What a rock is made of, to look at: its type's material, else its main ore's, else stone */
export function rockMaterial(comp?: Composition): RockMaterial {
  if (!comp) return 'stone';
  return MATERIAL_OF_TYPE[comp.type] ?? MATERIAL_OF_ORE[comp.primary] ?? 'stone';
}

/**
 * Per material, four rows:
 *  A: highlight strength, shininess, ice (shadow-side glow, cold rim), highlight tinted by the rock (metal)
 *  B: relief, texture scale (per rock size), cavity (negative: cracks catch the light), albedo
 *  C: crevice colour (rgb, times the surface's brightness), how far crevices and dark patches drift to it
 *  D: thin-film shimmer on the highlight, grazing sheen, weathering patches, how much the polish varies
 */
const MAT_A: Record<RockMaterial, number[]> = { stone: [0.05, 8, 0, 0], metal: [0.42, 12, 0, 1], ice: [0.5, 16, 0.45, 0], crystal: [0.85, 34, 0.1, 0], tar: [0.4, 10, 0, 0], leestone: [0.16, 12, 0, 0] };
const MAT_B: Record<RockMaterial, number[]> = { stone: [1, 0.6, 0.5, 1], metal: [0.8, 0.9, 0.35, 0.85], ice: [0.55, 0.5, -0.5, 0.9], crystal: [1, 0.75, 0.3, 0.9], tar: [0.45, 0.45, 0.2, 0.6], leestone: [0.9, 0.7, 0.45, 1] };
const MAT_C: Record<RockMaterial, number[]> = { stone: [0.55, 0.42, 0.32, 0.35], metal: [0.8, 0.46, 0.27, 0.45], ice: [0.72, 0.95, 1.35, 0.5], crystal: [0.6, 0.8, 1.25, 0.3], tar: [0.25, 0.2, 0.17, 0.35], leestone: [0.45, 0.46, 0.58, 0.3] };
const MAT_D: Record<RockMaterial, number[]> = { stone: [0, 0, 0.18, 0], metal: [0, 0.45, 0.12, 0.7], ice: [0, 0.35, 0.08, 0.4], crystal: [0.75, 0.5, 0.06, 0.3], tar: [0.18, 0.5, 0.05, 0.3], leestone: [0, 0.1, 0.15, 0] };

const rows = (t: Record<RockMaterial, number[]>) => { const a = new Float32Array(ROCK_MATERIALS.length * 4); ROCK_MATERIALS.forEach((m, i) => a.set(t[m], i * 4)); return a; };

/** The materials' parameters, the zoom and the on-screen thresholds (one group, shared by every chunk) */
export const rockUniforms = new UniformGroup({
  uMatA: { value: rows(MAT_A), type: 'vec4<f32>', size: ROCK_MATERIALS.length },
  uMatB: { value: rows(MAT_B), type: 'vec4<f32>', size: ROCK_MATERIALS.length },
  uMatC: { value: rows(MAT_C), type: 'vec4<f32>', size: ROCK_MATERIALS.length },
  uMatD: { value: rows(MAT_D), type: 'vec4<f32>', size: ROCK_MATERIALS.length },
  uZoom: { value: 1, type: 'f32' },
  /** ROCK_LOD: light, detailFrom, detailFull (pixels) */
  uLod: { value: new Float32Array([ROCK_LOD.light, ROCK_LOD.detailFrom, ROCK_LOD.detailFull, 0]), type: 'vec4<f32>' },
});

let atlas: Texture | null = null, asked = false;
/** The relief atlas, once it's built (null until then: rocks draw today's way meanwhile) */
export function rockAtlas(): Texture | null {
  if (!asked) {
    asked = true;
    void rockAtlasData().then((data) => {
      atlas = new Texture({ source: new BufferImageSource({
        resource: data, width: ROCK_TILE * 3, height: ROCK_TILE * 2,
        // Data, not colour: alpha is its own channel, never multiplied in
        alphaMode: 'no-premultiply-alpha', addressMode: 'clamp-to-edge', scaleMode: 'linear', autoGenerateMipmaps: true,
      }) });
    });
  }
  return atlas;
}

/** Hidden slots, and the mesh this rock doesn't want at its size on screen, go nowhere (`px`: its radius in pixels) */
const PICK = `float px = aSurf.w * s * uZoom;
  if (s == 0.0 || (aMat.w > 0.5) != (px < uLod.x)) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }`;

const LIGHTS = `uniform vec3 uAmbient; uniform vec4 uSun; uniform vec3 uSunColor; uniform vec2 uSunElev; uniform float uCount;
uniform vec4 uLightPos[${MAX_LIGHTS}]; uniform vec4 uLightCol[${MAX_LIGHTS}]; uniform vec4 uLightCone[${MAX_LIGHTS}];`;

const vertex = (slots: number) => `#version 300 es
in vec2 aPosition; in vec3 aNormal; in vec4 aColor; in float aSlot;
in vec4 aSurf;     // the surface's own coordinates (u, v over it from the top, ÷ size), height ÷ size, size
in vec3 aSmooth;   // the smooth normal (continuous over the facets: the relief's frame)
in vec4 aMat;      // material, the rock's own seed (0..1), greyseam (0..1), 1 on its light mesh
out vec3 vColor; out vec3 vTint; out vec3 vCx; out vec3 vCy; out vec4 vVein; out vec3 vUV; flat out vec2 vTile;
uniform mat3 uProjectionMatrix; uniform mat3 uWorldTransformMatrix; uniform mat3 uTransformMatrix;
uniform vec4 uXform[${slots}]; uniform vec4 uFade[${fades(slots)}];
uniform vec4 uMatA[${ROCK_MATERIALS.length}]; uniform vec4 uMatB[${ROCK_MATERIALS.length}]; uniform vec4 uMatC[${ROCK_MATERIALS.length}]; uniform vec4 uMatD[${ROCK_MATERIALS.length}];
uniform float uZoom; uniform vec4 uLod; ${LIGHTS}
const vec3 LUM = vec3(0.3, 0.5, 0.2);
void main() {
  int slot = int(aSlot + 0.5), mi = int(aMat.x + 0.5);
  vec4 X = uXform[slot], MA = uMatA[mi], MB = uMatB[mi], MC = uMatC[mi], MD = uMatD[mi];
  vec2 w = X.xy + vec2(X.z * aPosition.x - X.w * aPosition.y, X.w * aPosition.x + X.z * aPosition.y);
  float s = length(X.zw);
  ${PICK}
  vec2 cs = s > 0.0 ? X.zw / s : vec2(1.0, 0.0);
  vec3 n = vec3(cs.x * aNormal.x - cs.y * aNormal.y, cs.y * aNormal.x + cs.x * aNormal.y, aNormal.z);
  // today's lighting (litShader.ts), unchanged, gathering the light's overall direction and colour as it goes
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
  float fade = uFade[slot / 4][slot % 4], k = clamp((px - uLod.y) / max(uLod.z - uLod.y, 1.0), 0.0, 1.0), h = aMat.y;
  vec3 Lc = min(L, vec3(1.6)), cl = min(csum, vec3(1.6));
  float lum = dot(Lc, LUM), rim = 1.0 - clamp(n.z, 0.0, 1.0);
  // weathering: broad patches over the rock, lighter and darker, the darker drifting towards the crevice colour
  float mot = sin(aSurf.x * 1.7 + h * 9.0) * sin(aSurf.y * 1.3 + h * 4.0) + 0.5 * sin((aSurf.x + aSurf.y) * 3.1 + h * 2.0);
  vec3 albedo = aColor.rgb * mix(1.0, MB.w, k) * (1.0 + MD.z * mot * k);
  albedo = mix(albedo, MC.rgb * dot(albedo, LUM), clamp(-mot, 0.0, 1.0) * MC.w * 0.5 * k);
  vColor = albedo * mix(Lc, vec3(1.0), aColor.a) * fade;
  // ice: light scattered inside lifts the shadow side, a cold blue, and a cold rim where the surface turns away
  vColor += aColor.rgb * vec3(0.55, 0.8, 1.0) * MA.z * max(0.0, 0.7 - lum) * k * fade;
  vColor += vec3(0.6, 0.85, 1.0) * MA.z * rim * rim * (0.35 + lum * 0.5) * k * fade;
  // the surface's frame (from the smooth normal) and the texture's axes in it, turned by the rock's seed
  float ang = h * 6.2831, ca = cos(ang), sa = sin(ang);
  vec3 sN = vec3(cs.x * aSmooth.x - cs.y * aSmooth.y, cs.y * aSmooth.x + cs.x * aSmooth.y, aSmooth.z);
  vec2 ul = vec2(ca, -sa);
  vec3 U = vec3(cs.x * ul.x - cs.y * ul.y, cs.y * ul.x + cs.x * ul.y, 0.0);
  vec3 T = normalize(U - sN * dot(U, sN)), B = cross(sN, T);
  float dl = length(dsum);
  vec3 Ld = dl > 0.0001 ? dsum / dl : vec3(0.0, 0.0, 1.0);
  vec2 Lt = vec2(dot(Ld, T), dot(Ld, B));
  vec3 D = albedo * cl * (1.0 - aColor.a) * fade;
  // the highlight: the half-vector between the light and the eye (straight down), and how fast it grows as the
  // relief tilts the surface towards it, so the pixel only has to add it
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
  // crevices: drifting towards the material's crevice colour
  vTint = (vColor - MC.rgb * dot(vColor, LUM)) * MC.w * 2.0 * k;
  // greyseam: dull grey, a touch cold, lit as the rock is, glowing faintly of its own
  vVein = vec4(mix(vec3(0.56, 0.61, 0.67), aColor.rgb, 0.25) * mix(Lc, vec3(1.0), 0.3) * fade, aMat.z * k);
  vec2 lp = aSurf.xy * MB.y;
  vUV = vec3(vec2(ca * lp.x - sa * lp.y, sa * lp.x + ca * lp.y) + vec2(h * 7.0, h * 3.0), MB.z * k);
  vTile = vec2(float(mi % 3), float(mi / 3));
  gl_Position = vec4((uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix * vec3(w, 1.0)).xy, 0.0, 1.0);
}`;

const fragment = `#version 300 es
precision mediump float;
in vec3 vColor; in vec3 vTint; in vec3 vCx; in vec3 vCy; in vec4 vVein; in vec3 vUV; flat in vec2 vTile;
uniform sampler2D uDetail;
out vec4 fragColor;
void main() {
  // the material's tile of the atlas (gradients from the unwrapped coordinates, so no seams in the mip choice)
  vec2 g = vec2(1.0 / 3.0, 0.5);
  vec4 t = textureGrad(uDetail, (vTile + fract(vUV.xy)) * g, dFdx(vUV.xy) * g, dFdy(vUV.xy) * g);
  vec2 sl = t.rg * 2.0 - 1.0;
  float d = t.b - 0.5;
  vec3 c = vColor * (1.0 + d * vUV.z) + min(d, 0.0) * vTint + vCx * sl.x + vCy * sl.y;
  // greyseam, shaded by the same relief
  float shade = dot(c, vec3(0.3, 0.5, 0.2)) / max(dot(vColor, vec3(0.3, 0.5, 0.2)), 0.02);
  c = mix(c, vVein.rgb * shade, t.a * vVein.a);
  fragColor = vec4(max(c, 0.0), 1.0);
}`;

/** Today's lighting (litShader.ts) for a chunk with no rock near enough for detail, with the same pick of mesh */
const litVertex = (slots: number) => `#version 300 es
in vec2 aPosition; in vec3 aNormal; in vec4 aColor; in float aSlot; in vec4 aSurf; in vec4 aMat;
out vec4 vColor;
uniform mat3 uProjectionMatrix; uniform mat3 uWorldTransformMatrix; uniform mat3 uTransformMatrix;
uniform vec4 uXform[${slots}]; uniform vec4 uFade[${fades(slots)}];
uniform float uZoom; uniform vec4 uLod; ${LIGHTS}
void main() {
  int slot = int(aSlot + 0.5);
  vec4 X = uXform[slot];
  vec2 w = X.xy + vec2(X.z * aPosition.x - X.w * aPosition.y, X.w * aPosition.x + X.z * aPosition.y);
  float s = length(X.zw);
  ${PICK}
  vec2 cs = X.zw / s;
  vec3 n = vec3(cs.x * aNormal.x - cs.y * aNormal.y, cs.y * aNormal.x + cs.x * aNormal.y, aNormal.z);
  vec3 L = uAmbient;
  vec2 ds = uSun.xy - w;
  float dist = length(ds);
  vec3 sl = vec3(ds / max(dist, 1.0) * uSunElev.x, uSunElev.y);
  L += uSunColor * (uSun.w / (1.0 + dist * dist / (uSun.z * uSun.z))) * max(dot(n, sl), 0.0);
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
    L += uLightCol[i].rgb * (uLightCol[i].a * a * max(dot(n, normalize(vec3(d, P.w))), 0.0));
  }
  vColor = vec4(aColor.rgb * mix(min(L, vec3(1.6)), vec3(1.0), aColor.a), 1.0) * uFade[slot / 4][slot % 4];
  gl_Position = vec4((uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix * vec3(w, 1.0)).xy, 0.0, 1.0);
}`;
const litFragment = `#version 300 es
precision mediump float;
in vec4 vColor;
out vec4 fragColor;
void main() { fragColor = vColor; }`;

const litPrograms = new Map<number, GlProgram>();
/** Today's lighting for chunks of `slots` rocks, each drawn with the mesh that suits its size on screen */
export function rockLitProgram(slots: number): GlProgram {
  let p = litPrograms.get(slots);
  if (!p) litPrograms.set(slots, (p = new GlProgram({ vertex: litVertex(slots), fragment: litFragment, name: `rock-lit-${slots}` })));
  return p;
}

const programs = new Map<number, GlProgram>();
/** The materials' program for chunks of `slots` rocks */
export function rockProgram(slots: number): GlProgram {
  let p = programs.get(slots);
  if (!p) programs.set(slots, (p = new GlProgram({ vertex: vertex(slots), fragment, name: `rock-materials-${slots}` })));
  return p;
}
