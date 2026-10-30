/**
 * Station materials: the shader a station's baked pieces (stationBake.ts) are
 * drawn with. Today's lighting per vertex, exactly (litShader.ts, the same
 * lights from Lighting through the lit mesh's `litUniforms`), with on top:
 *   exposure  every light scaled by the vertex's openness towards it
 *   shadow    the sun's share past the layers above (baked), ambient occlusion
 *   facing    the baked lean added to the normal
 *   spill     baked light from windows, beacons and glowing parts
 *   panels    the hull atlas (stationTextures.ts), first-order normal mapping:
 *             the light's direction in the surface's frame per vertex, so the
 *             pixel only adds the slope times it
 *   windows   strips from the atlas's alpha where the window discs sat
 *   metal     a linearised highlight, sheen and cool rim; dark-space
 *             reflections (near-black, a faint haze, the star's glint)
 *   ships     their shadows over it: soft discs, taking most of the sun and some of the sky
 *   character per design: refinery soot, furnace pulse and amber vents;
 *             shipyard hazard gantries; bastion armour and scorching; citadel
 *             polish; blue-violet solar tiles (amber on the refinery); cyan
 *             power cores; glass domes shaded on their own
 * Detail and vent glow fade as a hull tile gets small on screen. Every pixel
 * is one texture read and a handful of multiply-adds.
 */

import { BufferImageSource, GlProgram, Texture, type UniformData } from 'pixi.js';
import { MAX_LIGHTS, SHIP_SHADE, fades } from '../lighting/litShader';
import { stationAtlasData } from '../procedural';
import { K, NK, T } from './stationBake';
import { STATION_ATLAS_H, STATION_ATLAS_W } from './stationTextures';

/** Per kind, A: highlight strength, shininess, window glow (negative: paint in the alpha, darkening), relief; B: tile, windowed, rim, glow pulse */
const BASE: [number[], number[]][] = [
  [[0.30, 16, 0, 1], [T.PLATE, 0, 1, 0]],
  [[0.30, 16, 0.95, 0.8], [T.WIN2, 1, 1, 0]],
  [[0.30, 16, 0.95, 0.8], [T.WIN1, 1, 1, 0]],
  [[0.22, 12, 0, 0.9], [T.MACH, 0, 1, 0]],
  [[0.16, 9, 0, 1], [T.ARMOUR, 0, 0.8, 0]],
  [[0.55, 40, 0, 0.7], [T.SOLAR, 0, 0.5, 0]],
  [[0.28, 14, -0.62, 0.8], [T.HAZARD, 0, 1, 0]],
  [[0.35, 18, 0, 0.25], [T.SMOOTH, 0, 1, 0]],
  [[0.35, 18, 0, 0.5], [T.SMOOTH, 0, 1, 0]],
  [[0, 1, 0, 0], [T.SMOOTH, 0, 0, 0]],
  [[0.12, 8, 0, 0.8], [T.MACH, 0, 0.6, 0]],
  [[0.18, 10, 0, 0.6], [T.PLATE, 0, 0.8, 0]],
  [[0, 1, 0, 0], [T.SMOOTH, 0, 0, 0]],
  // vented machinery, power cores, reactor discs
  [[0.12, 8, 0, 0.8], [T.MACH, 0, 0.6, 0]],
  [[0.12, 8, 0, 0.8], [T.MACH, 0, 0.6, 0]],
  [[0.12, 8, 0, 0.8], [T.MACH, 0, 0.6, 0]],
  // glass dome (shaded on its own)
  [[0.5, 40, 0, 0], [T.SMOOTH, 0, 1, 0]],
];

/** A design's A and B rows */
function matTable(design: string): { a: Float32Array; b: Float32Array } {
  const rows = BASE.map(([a, b]) => [a.slice(), b.slice()]);
  const m = (k: number, f: (a: number[], b: number[]) => void) => f(rows[k][0], rows[k][1]);
  if (design === 'citadel') for (const k of [K.HULL, K.WIN1, K.WIN2, K.TANK, K.STRUT]) m(k, (a, b) => { a[0] *= 1.9; a[1] *= 1.7; b[2] *= 1.3; });
  if (design === 'observatory') m(K.DISH, (a) => { a[0] = 1.1; a[1] = 34; });
  if (design === 'shipyard') m(K.HAZARD, (a) => { a[0] = 0.75; a[1] = 26; });
  if (design === 'bastion') m(K.ARMOUR, (a) => { a[3] = 1.5; a[0] = 0.2; a[1] = 11; });
  if (design === 'refinery') m(K.EMIS, (_a, b) => { b[3] = 0.4; });
  return { a: new Float32Array(rows.flatMap((r) => r[0])), b: new Float32Array(rows.flatMap((r) => r[1])) };
}

/** Material character, per kind: metalness, environment reflection, glow (1 amber vents, 2 cyan core, 3 reactor disc), its tile then (-1: the same) */
function matC(design: string): Float32Array {
  const m = [[0.5, 1, 0, T.GRAIN], [0.5, 1, 0, -1], [0.5, 1, 0, -1], [0.7, 1, 0, -1], [0.25, 0.8, 0, -1], [0, 0, 0, -1], [0.15, 1, 0, -1], [0.95, 1.4, 0, -1],
    [0.7, 1, 0, -1], [0, 0, 0, -1], [0.45, 1, 0, -1], [0.1, 0.6, 0, -1], [0, 0, 0, -1], [0.5, 1, 1, -1], [0.4, 1, 2, T.HEX], [0.3, 1, 3, -1], [0.2, 1, 0, -1]];
  const set = (ks: number[], metal: number, env: number) => { for (const k of ks) { m[k][0] = metal; m[k][1] = env; } };
  if (design === 'citadel') set([K.HULL, K.WIN1, K.WIN2, K.TANK, K.STRUT], 0.75, 1.3);
  if (design === 'observatory') set([K.DISH], 0.95, 1.9);
  if (design === 'shipyard') { set([K.HAZARD], 0.08, 0.6); set([K.DARK], 0.8, 1.2); }
  if (design === 'bastion') { set([K.ARMOUR], 0.2, 0.6); set([K.STRUT, K.DARK], 0.75, 1.1); }
  if (design === 'refinery') set([K.STRUT], 0.75, 1.1);
  return new Float32Array(m.flat());
}

const GRIME: Record<string, number[]> = { refinery: [0.24, 0.2, 0.17], bastion: [0.34, 0.27, 0.22] };

/** A station's own uniforms: its design's materials, and its clock, pulse, size and hull tile size */
export function stationUniforms(design: string, R: number, tileW: number): Record<string, UniformData> {
  const t = matTable(design);
  return {
    uMatA: { value: t.a, type: 'vec4<f32>', size: NK },
    uMatB: { value: t.b, type: 'vec4<f32>', size: NK },
    uMatC: { value: matC(design), type: 'vec4<f32>', size: NK },
    uGrime: { value: new Float32Array(GRIME[design] ?? [1, 1, 1]), type: 'vec3<f32>' },
    /** time (s), glow pulse (0..1), 1 / R, hull tile size (world units) */
    uParams: { value: new Float32Array([0, 0.7, 1 / R, tileW]), type: 'vec4<f32>' },
  };
}

const LIGHTU = `uniform vec3 uAmbient; uniform vec4 uSun; uniform vec3 uSunColor; uniform vec2 uSunElev; uniform float uCount;
uniform vec4 uLightPos[${MAX_LIGHTS}]; uniform vec4 uLightCol[${MAX_LIGHTS}]; uniform vec4 uLightCone[${MAX_LIGHTS}];`;

/** (A lit mesh holding one object has two slots: see LitMesh) */
const SLOTS = 2;

const vertex = `#version 300 es
in vec2 aPosition; in vec3 aNormal; in vec4 aColor; in vec3 aExpo; in vec4 aMat; in vec2 aUV; in vec2 aWin; in vec3 aShadow; in vec3 aBend; in vec3 aSpill;
out vec3 vColor; out vec3 vCx; out vec3 vCy; out vec2 vUV; out vec3 vEmis; out float vCav; out float vGrime; flat out vec3 vTile; out vec2 vRel; out vec2 vSun;
uniform mat3 uProjectionMatrix; uniform mat3 uWorldTransformMatrix; uniform mat3 uTransformMatrix;
uniform vec4 uXform[${SLOTS}]; uniform vec4 uFade[${fades(SLOTS)}];
uniform vec4 uMatA[${NK}]; uniform vec4 uMatB[${NK}]; uniform vec4 uMatC[${NK}]; uniform vec4 uParams; ${LIGHTU}
vec2 cs;
vec2 toLocal(vec2 l) { return vec2(cs.x * l.x + cs.y * l.y, -cs.y * l.x + cs.x * l.y); }
// a light's share by the vertex's openness towards it
float expo(vec3 ld) {
  vec2 l = ld.xy; float hz = length(l);
  if (hz < 0.0001) return 1.0;
  vec2 ll = toLocal(l) / hz;
  return mix(1.0, mix(0.4, 1.0, clamp(aExpo.x + aExpo.y * ll.x + aExpo.z * ll.y, 0.0, 1.0)), hz);
}
// the sun's share past the layers above (baked: mean, cos, sin over 16 ways), never below 0.3
float shade(vec3 ld) {
  vec2 l = ld.xy; float hz = length(l);
  if (hz < 0.0001) return 1.0;
  vec2 ll = toLocal(l) / hz;
  return mix(0.3, 1.0, clamp(aShadow.x + aShadow.y * ll.x + aShadow.z * ll.y, 0.0, 1.0));
}
void main() {
  int mk = int(aMat.x + 0.5);
  vec4 X = uXform[0], MA = uMatA[mk], MB = uMatB[mk], MC = uMatC[mk];
  bool win = MB.y > 0.5;
  bool solar = mk == ${K.SOLAR};
  vec2 w = X.xy + vec2(X.z * aPosition.x - X.w * aPosition.y, X.w * aPosition.x + X.z * aPosition.y);
  float s = length(X.zw);
  cs = s > 0.0 ? X.zw / s : vec2(1.0, 0.0);
  vec3 n = vec3(cs.x * aNormal.x - cs.y * aNormal.y, cs.y * aNormal.x + cs.x * aNormal.y, aNormal.z);
  // facing: the baked lean (solar arrays: tilted outward)
  vec2 bw = vec2(cs.x * aBend.x - cs.y * aBend.y, cs.y * aBend.x + cs.x * aBend.y);
  n = normalize(n + vec3(bw * 2.2, 0.0));
  float m = MC.x;
  vec3 col = solar ? mix(vec3(0.13, 0.15, 0.42), vec3(0.36, 0.14, 0.04), aMat.z) : aColor.rgb;
  vec3 body = col * mix(1.0, 0.55, m);
  float ao = aBend.z;
  vec3 L = uAmbient * (0.7 + 0.3 * clamp(aExpo.x * 1.4, 0.0, 1.0)) * ao;
  vec2 ds = uSun.xy - w;
  float dist = length(ds);
  vec3 sl = vec3(ds / max(dist, 1.0) * uSunElev.x, uSunElev.y);
  float sunK = uSun.w / (1.0 + dist * dist / (uSun.z * uSun.z)) * expo(sl) * shade(sl) * mix(1.0, ao, 0.85);
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
    float k = uLightCol[i].a * a * expo(ld);
    L += uLightCol[i].rgb * (k * max(dot(n, ld), 0.0));
    dsum += ld * k; csum += uLightCol[i].rgb * k;
  }
  float fade = uFade[0].x;
  // the sun's share of the light here (what a ship's shadow takes)
  vec3 LUMV = vec3(0.3, 0.5, 0.2);
  vSun = vec2(clamp(dot(uSunColor, LUMV) * sunK * max(dot(n, sl), 0.0) / max(dot(L, LUMV), 0.001), 0.0, 1.0), 1.0 - aColor.a);
  vRel = w - X.xy;
  vec3 Lc = min(L, vec3(1.6)), cl = min(csum, vec3(1.6));
  float lit = 1.0 - aColor.a;
  vColor = body * mix(Lc, vec3(1.0), aColor.a) * fade;
  vColor *= 1.0 + MB.w * uParams.y * aColor.a;
  // baked light from the windows, beacons and glowing parts nearby
  vColor += col * aSpill * fade * lit;
  // metal reflects dark space: near-black with a faint haze, and the star's own glint, by where the leaning surface faces
  vec3 Rv = vec3(2.0 * n.z * n.xy, 2.0 * n.z * n.z - 1.0);
  vec3 Rn = normalize(Rv);
  float star = max(dot(Rn, sl), 0.0);
  vec3 env = vec3(0.006, 0.007, 0.011) + uAmbient * 0.12 * (0.6 + 0.4 * Rn.z) + uSunColor * (pow(star, 10.0) * 1.1 + pow(star, 3.0) * 0.12);
  vColor += env * mix(vec3(1.0), col * 1.5, 0.6) * m * 0.5 * MC.y * fade * lit;
  float rim = 1.0 - clamp(n.z, 0.0, 1.0);
  vColor += col * vec3(0.55, 0.65, 0.85) * rim * rim * 1.4 * MB.z * (1.0 + 0.6 * m) * clamp(aExpo.x * 1.5, 0.0, 1.0) * fade * lit;
  vec3 Tv = vec3(cs, 0.0), Bv = vec3(-cs.y, cs.x, 0.0);
  float dl = length(dsum);
  vec3 Ld = dl > 0.0001 ? dsum / dl : vec3(0.0, 0.0, 1.0);
  vec2 Lt = vec2(dot(Ld, Tv), dot(Ld, Bv));
  vec3 D = body * cl * lit * fade;
  // detail and vent glow fade as a hull tile gets small on screen (its size in pixels)
  mat3 M = uWorldTransformMatrix * uTransformMatrix;
  float tilePx = uParams.w * length(M[0].xy);
  float detail = clamp((tilePx - 14.0) / 20.0, 0.0, 1.0), small = clamp((tilePx - 18.0) / 20.0, 0.0, 1.0);
  float kx = MA.w * detail;
  vec3 Hv = normalize(Ld + vec3(0.0, 0.0, 1.0));
  vec2 Ht = vec2(dot(Hv, Tv), dot(Hv, Bv));
  float shin = (solar ? 7.0 : MA.y) * (1.0 + m), nh = clamp(dot(n, Hv), 0.0, 1.0), sp = pow(nh, shin), dsp = min(shin * sp / max(nh, 0.05), 4.0) * kx;
  // solar: a broad anti-reflective sheen, blue-white with a thin-film shift
  vec3 irid = 0.5 + 0.5 * cos(6.2831 * (nh * 1.7 + rim + vec3(0.0, 0.33, 0.67)));
  vec3 tint = solar ? mix(mix(vec3(0.42, 0.6, 1.0), irid, 0.3), mix(vec3(1.0, 0.8, 0.5), irid, 0.22), aMat.z) : mix(vec3(1.0), col * 1.5, mix(0.5, 0.85, m));
  vec3 S = tint * cl * (solar ? 0.9 : MA.x * mix(1.0, 1.5, m)) * lit * fade;
  vColor += S * sp;
  vCx = D * (0.7 * kx * Lt.x) + S * (dsp * Ht.x);
  vCy = D * (0.7 * kx * Lt.y) + S * (dsp * Ht.y);
  vCav = 0.9 * kx;
  vEmis = MA.z > 0.0 ? (win ? mix(vec3(1.0, 0.84, 0.56), vec3(0.8, 0.92, 1.0), aMat.z) * MA.z * fade : vec3(0.0)) : vColor * MA.z;
  // solar: silver bus lines and frame, lit as the array is (and a navy floor: an array facing away still reads as cells)
  if (solar) { vEmis = mix(vec3(0.36, 0.39, 0.45), vec3(0.46, 0.39, 0.28), aMat.z) * (dot(Lc, vec3(0.33)) * 0.8 + 0.08) * mix(0.35, 1.0, detail) * fade + S * sp * 0.5; vColor += mix(vec3(0.025, 0.035, 0.1), vec3(0.07, 0.03, 0.01), aMat.z) * fade; }
  // glows of their own, lighting nothing: a slow pulse running across the station
  float pulse = 0.7 + 0.3 * sin(uParams.x * 1.7 - dot(aPosition, vec2(1.0, 0.6)) * 2.5 * uParams.z);
  if (MC.z > 0.5 && MC.z < 1.5) vEmis = vec3(1.0, 0.5, 0.18) * 0.9 * pulse * small * fade;
  if (MC.z > 1.5 && MC.z < 2.5) { vEmis = vec3(0.4, 0.85, 1.0) * 0.6 * pulse * small * fade; vColor += vec3(0.4, 0.85, 1.0) * 0.03 * pulse * fade; }
  float flick = 0.85 + 0.15 * sin(uParams.x * 9.0 + aPosition.x * 0.05) * sin(uParams.x * 5.3 + aPosition.y * 0.04);
  if (MC.z > 2.5) vColor += vec3(0.3, 0.6, 1.0) * 0.3 * flick * fade;
  vGrime = aMat.y;
  // a glass dome: a deep teal interior, darker at the centre and glowing softly from within; the star's tight
  // highlight and a broad streak by its domed normal; a brighter rim
  if (mk == ${K.DOME}) {
    float q = aMat.y, pv = aMat.z;
    vec3 Hs = normalize(sl + vec3(0.0, 0.0, 1.0));
    float nd = clamp(dot(n, Hs), 0.0, 1.0), sv = sunK / max(uSun.w, 0.001);
    vec3 deep = mix(vec3(0.01, 0.045, 0.06), vec3(0.03, 0.17, 0.2), q * q) * (0.72 + 0.56 * pv);
    vec3 dc = deep * (0.4 + 0.6 * Lc) + vec3(0.07, 0.42, 0.46) * (0.1 + 0.32 * q * q) * pulse;
    dc += uSunColor * (pow(nd, 90.0) * 1.9 + pow(nd, 9.0) * 0.22 * (0.35 + 1.3 * pv)) * sv;
    dc += mix(vec3(0.35, 0.6, 0.7), uSunColor, 0.3) * pow(q, 5.0) * 0.4;
    vColor = dc * fade; vSun = vec2(clamp(sv, 0.0, 1.0), 0.7); vCx = vec3(0.0); vCy = vec3(0.0); vCav = 0.0; vEmis = vec3(0.0); vGrime = 0.0;
  }
  float tile = win ? MB.x : (MB.y > 0.5 ? 0.0 : MB.x);
  if (solar) tile = ${T.SOLAR2}.0; else if (MC.w >= 0.0 && !win) tile = MC.w;
  vTile = vec3(mod(tile, 4.0), floor(tile / 4.0), win ? 1.0 : 0.0);
  vUV = win ? aWin : aUV;
  gl_Position = vec4((uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
}`;

const fragment = `#version 300 es
precision mediump float;
in vec3 vColor; in vec3 vCx; in vec3 vCy; in vec2 vUV; in vec3 vEmis; in float vCav; in float vGrime; flat in vec3 vTile; in highp vec2 vRel; in vec2 vSun;
uniform sampler2D uDetail; uniform vec3 uGrime;
${SHIP_SHADE}
out vec4 fragColor;
void main() {
  vec2 g = vec2(0.25, 1.0 / 3.0);
  vec2 f = vec2(fract(vUV.x), vTile.z > 0.5 ? clamp(vUV.y, 0.0, 1.0) : fract(vUV.y)) * (254.0 / 256.0) + 1.0 / 256.0;
  vec4 t = textureGrad(uDetail, (vTile.xy + f) * g, dFdx(vUV) * g, dFdy(vUV) * g);
  vec2 sl = t.rg * 2.0 - 1.0;
  vec3 c = vColor * (1.0 + (t.b - 0.5) * vCav) + vCx * sl.x + vCy * sl.y;
  c *= mix(vec3(1.0), uGrime, clamp(vGrime * (1.0 + (0.5 - t.b) * 3.0), 0.0, 1.0));
  c *= shipDim(vRel, vSun);
  c += vEmis * t.a;
  fragColor = vec4(max(c, 0.0), 1.0);
}`;

let program: GlProgram | null = null;
/** The stations' material program */
export function stationProgram(): GlProgram {
  return (program ??= new GlProgram({ vertex, fragment, name: 'station-materials' }));
}

let atlas: Promise<Texture> | null = null;
/** The hull panel atlas, built off the main thread once */
export function stationAtlas(): Promise<Texture> {
  return (atlas ??= stationAtlasData().then((data) => new Texture({ source: new BufferImageSource({
    resource: data, width: STATION_ATLAS_W, height: STATION_ATLAS_H,
    // Data, not colour: alpha is its own channel, never multiplied in
    alphaMode: 'no-premultiply-alpha', addressMode: 'clamp-to-edge', scaleMode: 'linear', autoGenerateMipmaps: true,
  }) })));
}

// ---------------------------------------------------------------------------- soft sprites: the halo, nav, chase and weld lights

function canvasTex(size: number, draw: (x: CanvasRenderingContext2D, s: number) => void): Texture {
  if (typeof document === 'undefined') return Texture.WHITE;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d')!, size);
  return Texture.from(c);
}
const radial = (stops: [number, number][]) => (x: CanvasRenderingContext2D, s: number) => {
  const g = x.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  for (const [t, a] of stops) g.addColorStop(t, `rgba(255,255,255,${a})`);
  x.fillStyle = g;
  x.fillRect(0, 0, s, s);
};

let sprites: { glow: Texture; halo: Texture; star: Texture } | null = null;
/** A soft glow, the station's halo, and a four-pointed weld spark */
export function stationSprites(): { glow: Texture; halo: Texture; star: Texture } {
  return (sprites ??= {
    glow: canvasTex(128, radial([[0, 1], [0.12, 0.75], [0.3, 0.28], [0.55, 0.08], [1, 0]])),
    halo: canvasTex(256, radial([[0, 1], [0.5, 0.82], [0.75, 0.42], [0.9, 0.12], [1, 0]])),
    star: canvasTex(128, (x, s) => {
      radial([[0, 1], [0.1, 0.6], [0.25, 0.12], [0.5, 0]])(x, s);
      x.globalCompositeOperation = 'lighter';
      for (const [w, h] of [[s, s * 0.05], [s * 0.05, s]]) {
        const g = x.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
        g.addColorStop(0, 'rgba(255,255,255,0.9)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        x.fillStyle = g;
        x.fillRect((s - w) / 2, (s - h) / 2, w, h);
      }
    }),
  });
}
