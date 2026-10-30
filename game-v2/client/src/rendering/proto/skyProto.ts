/**
 * PROTOTYPE sky stars (not used by the game yet; docs/rendering/sun-sky-prototypes.md).
 *
 * The game's star shader (sky/skyShaders.ts) runs over every pixel of the screen, six star layers deep,
 * each looking at up to nine cells for a star whose light reaches the pixel. Here the same stars are drawn
 * as sprites instead: one instanced draw per layer, one quad per cell on screen. The vertex shader does
 * what the old shader did per pixel per star (the cell's hashes: is there a star, where, how bright, what
 * colour, how crowded the sky is there and how much dust is in front) once per star; most cells have
 * no star, and their quads are collapsed before any pixel runs. The fragment shader only draws the star's
 * profile, so the cost goes with the number of stars on screen, not the screen's size.
 *
 * Same hashes, same placement, same profile: the picture is the old one (stars sum additively either way).
 * A black hole's lens is followed by putting each sprite where the bent light shows it and stretching its
 * quad by the lens's magnification; each pixel then works out the bent ray as before. (Not drawn: the faint
 * second image of a star inside the Einstein ring.)
 *
 * `#define SKY_BETTER` gives prototype C's stars: a photographic profile (a sharp core in a soft halo whose
 * wings are windowed to nothing at the star's reach, so bright stars glow without a hard edge), colour that
 * strengthens with brightness, finer longer diffraction spikes, and a less regular twinkle.
 *
 * Deep sky (galaxies, globular clusters) and the motes are one more instanced draw, the same way.
 */

import type { SkyBiome } from '../sky/skyBiome';

/** SkyRenderer's star layers, near to far: depth, and their stars' spacing on screen at zoom 1 (px) */
export const SKY_DEPTH = 80;
export const SKY_LAYERS = [
  { depth: 2, px: 240 },
  { depth: 4.5, px: 140 },
  { depth: 10, px: 82 },
  { depth: 22, px: 46 },
  { depth: 45, px: 26 },
  { depth: SKY_DEPTH, px: 15 },
];
export const MOTE_DEPTH = 0.3;
export const SKY_TILE = 320000;
/** Per layer (as in starsFrag): px a star can light, core radius, brightness, how much the band and dust apply */
const REACH = [26, 15, 8, 5, 3.5, 2.5];
const SIZE = [1.35, 1.1, 0.9, 0.75, 0.62, 0.55];
const LUM = [1.25, 1, 0.8, 0.62, 0.48, 0.36];
const FAR = [0, 0.12, 0.35, 0.65, 0.88, 1];

/** The fields both shaders read (skyShaders' FIELDS, with the inverse of its lens for placing sprites) */
const FIELDS = `
uniform sampler2D uNoise;
uniform vec2 uCamera;
uniform vec2 uRes;
uniform vec4 uSky;
uniform vec4 uBand;
uniform vec4 uField;
uniform vec4 uLens;
uniform vec2 uRot;

vec2 turned(vec2 v) { return vec2(uRot.x * v.x - uRot.y * v.y, uRot.y * v.x + uRot.x * v.y); }
vec2 unturned(vec2 v) { return vec2(uRot.x * v.x + uRot.y * v.y, -uRot.y * v.x + uRot.x * v.y); }
vec2 lensed(vec2 off) {
  if (uLens.w <= 0.0) return off;
  vec2 d = off - uLens.xy;
  return off - d * (uLens.z * uLens.z / max(dot(d, d), 1.0)) * uLens.w;
}

float hash(vec2 p) {
  p = fract(p * vec2(443.8975, 397.2973));
  p += dot(p, p.yx + 19.19);
  return fract(p.x * p.y);
}
vec2 hash2(vec2 p) { return vec2(hash(p), hash(p + 127.1)); }

struct Fields { float band; float dust; float neb; vec4 a; vec4 b; };
Fields skyFields(vec2 sky) {
  Fields F;
  vec2 uv = sky / uSky.y + uSky.zw;
  vec4 a = textureLod(uNoise, uv, 0.0);
  vec4 b = textureLod(uNoise, uv * 2.37 + (a.rg - 0.5) * 0.3, 0.0);
  float v = (dot(sky, uBand.xy) - uBand.z) / uBand.w + (a.r - 0.5) * 1.6 + (b.g - 0.5) * 0.4;
  F.band = exp(-v * v);
  F.neb = smoothstep(uField.y, uField.y + 0.28, a.g * 0.62 + b.r * 0.38);
  F.dust = smoothstep(0.5, 0.85, b.b) * smoothstep(0.2, 0.6, a.g) * (0.3 + 0.7 * max(F.band, F.neb)) * uField.x;
  F.a = a; F.b = b;
  return F;
}

/**
 * Where on screen (px from its middle) a point of the sky at offset src shows, and how much the lens stretches it:
 * the lens maps a pixel at image offset θ (from the hole) to the sky at β = θ − θE²θ/|θ|², so the outer image of
 * β is at |θ| = |β|/2 + sqrt(|β|²/4 + θE²), stretched round the hole by |θ|/|β|
 */
vec3 imageOf(vec2 src) {
  if (uLens.w <= 0.0) return vec3(unturned(src), 1.0);
  vec2 b = src - uLens.xy;
  float bl = max(length(b), 1e-3);
  float tl = bl * 0.5 + sqrt(bl * bl * 0.25 + uLens.z * uLens.z);
  return vec3(unturned(uLens.xy + b * (tl / bl)), min(tl / bl, 12.0));
}

/** A corner of a quad of half-size hs (px) round screen point c (px from the middle), as clip space */
vec4 cornerAt(vec2 c, float hs, vec2 corner, out vec2 screen) {
  screen = c + (corner * 2.0 - 1.0) * hs;
  return vec4(screen.x / (uRes.x * 0.5), -screen.y / (uRes.y * 0.5), 0.0, 1.0);
}
`;

export const SKY_SPRITE_VERT = `#version 300 es
precision highp float;
in vec2 aPosition;
in vec2 aUV;            // the quad's corner, 0..1
${FIELDS}
uniform float uTime;
uniform vec4 uL;        // this layer: x scale, y cell size (layer units), z share of cells with a star, w alpha
uniform vec4 uLook;     // x px a star can light, y core radius, z brightness, w how far (band and dust apply)
uniform vec4 uGrid;     // xy the first cell, z columns
uniform float uLayer;
uniform vec4 uStarMix;
uniform vec3 uTint;
uniform vec2 uStreak;
out vec2 vScreen;       // px from the screen's middle
flat out vec2 vSrc;     // the star, in the same (turned, unbent) frame
flat out vec4 vStar;    // x core radius, y brightness, z spikes (0/1), w reach (px)
flat out vec3 vCol;     // colour × everything the old shader multiplied in after the profile
flat out vec2 vStreakV;

vec3 starColor(float t) {
  vec3 red = vec3(1.0, 0.62, 0.38), yel = vec3(1.0, 0.9, 0.74), wht = vec3(0.96, 0.97, 1.0), blu = vec3(0.66, 0.78, 1.0);
  return t < 0.35 ? mix(red, yel, t / 0.35) : t < 0.6 ? mix(yel, wht, (t - 0.35) / 0.25) : mix(wht, blu, (t - 0.6) / 0.4);
}

void main() {
  int id = gl_InstanceID;
  int cols = int(uGrid.z);
  vec2 cell = uGrid.xy + vec2(float(id % cols), float(id / cols));
  vec2 s = cell + uLayer * 71.37;
  float h = hash(s);
  float z = uL.x, cellPx = uL.y * z;
  // The star, px from the screen's middle in the sky's frame
  vec2 src = (cell + hash2(s * 1.731) - uCamera / uL.y) * cellPx;
  Fields F = skyFields(uCamera + src / uSky.x);
  float crowd = (0.3 + uStarMix.z * F.band + 0.7 * F.neb) * (0.55 + 0.9 * F.b.a);
  float far = uLook.w;
  float keep = uL.z * mix(1.0, clamp(crowd, 0.0, 1.0), far);
  vScreen = vec2(0.0); vSrc = src; vStar = vec4(0.0); vCol = vec3(0.0); vStreakV = vec2(0.0);
  if (h > keep || uL.w <= 0.003) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }

  // Camera travel smears it into a streak
  vec2 sv = vec2(0.0);
  float sl = 0.0;
  if (uStreak.x != 0.0 || uStreak.y != 0.0) {
    sv = uStreak * z;
    sl = min(max(length(sv) - 2.5, 0.0), cellPx * 0.6);
    sv = sl > 0.0 ? normalize(sv) * sl : vec2(0.0);
  }
  float m = hash(s * 2.917);
  float lum = uLook.z * (0.22 + 0.78 * m * m * m) * (m > 0.985 ? 1.8 : 1.0);
  float r = uLook.y * (0.6 + 1.2 * m * m * m * m);
  float spikes = uLayer < 1.5 && m > 1.0 - uStarMix.w * 0.08 ? 1.0 : 0.0;
  float ph = hash(s * 4.13);
#ifdef SKY_BETTER
  // A less regular twinkle, strongest on the bright near stars
  float tw = sin(uTime * (0.6 + 2.0 * ph) + ph * 6.2832) * 0.6 + sin(uTime * (1.9 + 3.1 * ph) + ph * 17.0) * 0.4;
  float shimmer = 1.0 + (0.12 + 0.16 * m) * tw * (1.0 - far);
#else
  float shimmer = 1.0 + 0.18 * sin(uTime * (0.6 + 2.0 * ph) + ph * 6.2832) * (1.0 - far);
#endif
  float t = clamp(hash(s * 5.13) * 0.85 + 0.15 + uStarMix.x * 0.45, 0.0, 1.0);
  vec3 c = starColor(t * t * (3.0 - 2.0 * t));
#ifdef SKY_BETTER
  // Faint stars look white to the eye; colour comes through as they brighten
  c = mix(vec3(dot(c, vec3(0.3, 0.5, 0.2))), c, 0.45 + 0.9 * m * m);
#endif
  float ext = F.dust * far;
  c *= mix(vec3(1.0), vec3(1.0, 0.7, 0.5), ext * 0.7) * (1.0 - ext * 0.85);
  float fade = clamp((keep - h) / (0.35 * keep + 1e-4), 0.0, 1.0);
  vCol = c * lum * fade * shimmer * uL.w * uTint * uStarMix.y;
  float reach = uLook.x + sl;
  vStar = vec4(r, lum, spikes, reach);
  vStreakV = sv;
  vec3 img = imageOf(src + sv * 0.5);
  gl_Position = cornerAt(img.xy, (reach + length(sv) * 0.5) * img.z + 1.0, aUV, vScreen);
}
`;

export const SKY_SPRITE_FRAG = `#version 300 es
precision highp float;
in vec2 vScreen;
flat in vec2 vSrc;
flat in vec4 vStar;
flat in vec3 vCol;
flat in vec2 vStreakV;
out vec4 fragColor;
uniform vec4 uLens;
uniform vec2 uRot;
uniform vec2 uSpike;

vec2 turned(vec2 v) { return vec2(uRot.x * v.x - uRot.y * v.y, uRot.y * v.x + uRot.x * v.y); }
vec2 lensed(vec2 off) {
  if (uLens.w <= 0.0) return off;
  vec2 d = off - uLens.xy;
  return off - d * (uLens.z * uLens.z / max(dot(d, d), 1.0)) * uLens.w;
}

void main() {
  vec2 d = lensed(turned(vScreen)) - vSrc;
  vec2 sv = vStreakV;
  if (sv.x != 0.0 || sv.y != 0.0) d -= sv * clamp(dot(d, sv) / dot(sv, sv), 0.0, 1.0);
  float d2 = dot(d, d), rr = vStar.w;
  if (d2 > rr * rr) { fragColor = vec4(0.0); return; }
  float r = vStar.x, lum = vStar.y;
  float q = d2 / (r * r);
#ifdef SKY_BETTER
  // A sharp core in a soft halo (Moffat-like), the wings windowed to nothing at the reach
  float win = 1.0 - d2 / (rr * rr);
  float I = exp(-q * 1.2) + 0.16 * lum * pow(1.0 + q * 0.12, -1.6) * win * win;
  if (vStar.z > 0.5) {
    vec2 e = vec2(dot(d, uSpike), dot(d, vec2(-uSpike.y, uSpike.x)));
    float len = r * 15.0;
    I += 0.6 * (exp(-abs(e.y) * 2.2) * exp(-abs(e.x) / len) + exp(-abs(e.x) * 2.2) * exp(-abs(e.y) / len)) * win;
  }
#else
  float I = exp(-q * 1.2) + 0.1 * lum * exp(-sqrt(q) * 0.7);
  if (vStar.z > 0.5) {
    vec2 e = vec2(dot(d, uSpike), dot(d, vec2(-uSpike.y, uSpike.x)));
    float len = r * 11.0;
    I += 0.55 * (exp(-abs(e.y) * 1.4) * exp(-abs(e.x) / len) + exp(-abs(e.x) * 1.4) * exp(-abs(e.y) / len));
  }
#endif
  fragColor = vec4(vCol * I, 0.0);
}
`;

/** Deep sky (instances below uCounts.x) and motes (the rest): the old deepSky() and motes(), one object per instance */
export const SKY_DEEP_VERT = `#version 300 es
precision highp float;
in vec2 aPosition;
in vec2 aUV;
${FIELDS}
uniform vec4 uDeep;      // x scale, y cell size, z galaxy chance, w cluster chance
uniform vec4 uMotes;     // x scale, y cell size, z alpha
uniform vec4 uGridDeep;  // xy first cell, z columns
uniform vec4 uGridMote;
uniform vec2 uCounts;    // x deep cells
uniform vec2 uStreak;
out vec2 vScreen;
flat out vec2 vSrc;      // the object's centre (sky frame, px from the screen's middle)
flat out vec4 vObj;      // x kind (0 none, 1 galaxy, 2 cluster, 3 mote), y R (px), z dimming by dust, w mote brightness
flat out vec2 vSeed;
flat out vec2 vStreakV;

void main() {
  int id = gl_InstanceID;
  vScreen = vec2(0.0); vSrc = vec2(0.0); vObj = vec4(0.0); vSeed = vec2(0.0); vStreakV = vec2(0.0);
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  if (float(id) < uCounts.x) {
    int cols = int(uGridDeep.z);
    vec2 cell = uGridDeep.xy + vec2(float(id % cols), float(id / cols));
    vec2 s = cell + 913.7;
    float h = hash(s);
    if (h > uDeep.z + uDeep.w) return;
    float cellPx = uDeep.y * uDeep.x;
    vec2 src = (cell + 0.25 + 0.5 * hash2(s * 1.37) - uCamera / uDeep.y) * cellPx;
    float R = (9.0 + 26.0 * pow(hash(s * 3.71), 2.0)) * cellPx / 700.0;
    Fields F = skyFields(uCamera + src / uSky.x);
    vSrc = src; vSeed = s;
    vObj = vec4(h < uDeep.z ? 1.0 : 2.0, R, 1.0 - F.dust * 0.85, 0.0);
    vec3 img = imageOf(src);
    gl_Position = cornerAt(img.xy, R * 2.4 * img.z + 1.0, aUV, vScreen);
  } else {
    int k = id - int(uCounts.x);
    if (uMotes.z <= 0.003) return;
    int cols = int(uGridMote.z);
    vec2 cell = uGridMote.xy + vec2(float(k % cols), float(k / cols));
    vec2 s = cell + 333.3;
    if (hash(s) > 0.55) return;
    float cellPx = uMotes.y * uMotes.x;
    vec2 src = (cell + 0.2 + 0.6 * hash2(s * 1.9) - uCamera / uMotes.y) * cellPx;
    vec2 sv = uStreak * uMotes.x;
    float sl = min(length(sv), cellPx * 0.18);
    sv = sl > 0.3 ? normalize(sv) * sl : vec2(0.0);
    vSrc = src; vStreakV = sv;
    vObj = vec4(3.0, 0.0, 0.0, uMotes.z * (0.4 + 0.6 * hash(s * 3.3)));
    vec3 img = imageOf(src + sv * 0.5);
    gl_Position = cornerAt(img.xy, (3.2 + sl * 0.5) * img.z + 1.0, aUV, vScreen);
  }
}
`;

export const SKY_DEEP_FRAG = `#version 300 es
precision highp float;
in vec2 vScreen;
flat in vec2 vSrc;
flat in vec4 vObj;
flat in vec2 vSeed;
flat in vec2 vStreakV;
out vec4 fragColor;
uniform vec4 uLens;
uniform vec2 uRot;
uniform vec3 uMoteColor;

vec2 turned(vec2 v) { return vec2(uRot.x * v.x - uRot.y * v.y, uRot.y * v.x + uRot.x * v.y); }
vec2 lensed(vec2 off) {
  if (uLens.w <= 0.0) return off;
  vec2 d = off - uLens.xy;
  return off - d * (uLens.z * uLens.z / max(dot(d, d), 1.0)) * uLens.w;
}
float hash(vec2 p) {
  p = fract(p * vec2(443.8975, 397.2973));
  p += dot(p, p.yx + 19.19);
  return fract(p.x * p.y);
}
vec2 hash2(vec2 p) { return vec2(hash(p), hash(p + 127.1)); }

void main() {
  vec2 d = lensed(turned(vScreen)) - vSrc;
  vec3 col = vec3(0.0);
  if (vObj.x > 2.5) {
    vec2 sv = vStreakV;
    if (sv.x != 0.0 || sv.y != 0.0) d -= sv * clamp(dot(d, sv) / dot(sv, sv), 0.0, 1.0);
    col = uMoteColor * exp(-dot(d, d) * 1.1) * vObj.w;
  } else {
    vec2 s = vSeed;
    float R = vObj.y, l = length(d);
    if (l <= R * 2.4) {
      if (vObj.x < 1.5) {
        float ang = hash(s * 5.3) * 6.2832, tilt = 0.22 + 0.78 * hash(s * 6.1);
        vec2 e = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * d;
        e.y /= tilt;
        float rr = length(e) / R;
        float core = exp(-rr * rr * 28.0);
        float disk = exp(-rr * 3.0);
        float arms = 0.5 + 0.5 * sin(2.0 * atan(e.y, e.x) + log(rr + 0.04) * 5.5 * (hash(s * 7.7) > 0.5 ? 1.0 : -1.0));
        float spiral = step(0.35, hash(s * 8.9));
        float body = disk * mix(0.75, 0.3 + 1.1 * arms * smoothstep(0.04, 0.25, rr), spiral);
        col = vec3(1.0, 0.86, 0.68) * core * 1.2 + mix(vec3(0.92, 0.88, 1.0), vec3(0.62, 0.74, 1.0), clamp(rr * 1.4, 0.0, 1.0)) * body * 0.55;
      } else {
        float k = l / R;
        col = vec3(1.0, 0.9, 0.75) * exp(-k * k * 2.2) * 0.1;
        vec2 sc = floor(d / 2.6);
        float sh = hash(sc + s);
        if (sh < exp(-k * k * 1.6) * 0.75) {
          vec2 sp = (sc + hash2(sc * 1.3 + s)) * 2.6;
          col += vec3(1.0, 0.92, 0.8) * exp(-dot(d - sp, d - sp) * 1.4) * (0.35 + 0.6 * hash(sc * 2.1 + s));
        }
      }
      col *= vObj.z;
    }
  }
  fragColor = vec4(col, 0.0);
}
`;

const scaleAt = (zoom: number, depth: number) => 1 / (1 / zoom + depth);
const smooth = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** A view of the sky: CSS size, the camera (world point, zoom, roll) and the seconds */
export interface SkyView { w: number; h: number; cam: [number, number]; zoom: number; t: number; angle?: number; streak?: [number, number] }

/** Uniforms every sprite draw shares (SkyRenderer.setBiome and update) */
export function skySpriteUniforms(b: SkyBiome, v: SkyView, lens: number): Record<string, number | number[]> {
  const a = v.angle ?? 0;
  const zSky = scaleAt(v.zoom, SKY_DEPTH);
  return {
    uCamera: v.cam, uRes: [v.w, v.h], uRot: [Math.cos(a), Math.sin(a)], uSky: [zSky, SKY_TILE, b.seed[0], b.seed[1]],
    uBand: [-Math.sin(b.band.angle), Math.cos(b.band.angle), b.band.offset, b.band.width], uField: [b.dust.strength, b.nebula.cover, 0, 0],
    uLens: [-v.cam[0] * v.zoom, -v.cam[1] * v.zoom, lens * 4.5 * v.zoom, lens > 0 ? 1 : 0],
    uTime: v.t, uStarMix: [b.stars.temperature, b.stars.brightness, b.stars.bandBoost, b.stars.spikes], uTint: b.stars.tint,
    uSpike: [Math.cos(b.stars.spikeAngle + a), Math.sin(b.stars.spikeAngle + a)], uStreak: v.streak ?? [0, 0], uMoteColor: b.moteColor,
  };
}

/**
 * The part of the sky the screen shows, px from its middle in the sky's (turned) frame: the screen's box, or with a
 * black hole the box round where its edges' light comes from (bent toward the hole, so the screen sees sky that would
 * otherwise be off it).
 */
export function skyBox(v: SkyView, lens: number): [number, number, number, number] {
  const a = v.angle ?? 0, c = Math.cos(a), s = Math.sin(a);
  const turned = (x: number, y: number) => [c * x - s * y, s * x + c * y];
  const E = lens * 4.5 * v.zoom, lx = -v.cam[0] * v.zoom, ly = -v.cam[1] * v.zoom;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  const N = 16;
  for (let i = 0; i <= N; i++) {
    for (const [sx, sy] of [[-1 + (2 * i) / N, -1], [-1 + (2 * i) / N, 1], [-1, -1 + (2 * i) / N], [1, -1 + (2 * i) / N]]) {
      let [x, y] = turned((sx * v.w) / 2, (sy * v.h) / 2);
      if (E > 0) {
        const dx = x - lx, dy = y - ly, k = (E * E) / Math.max(dx * dx + dy * dy, 1);
        x -= dx * k; y -= dy * k;
      }
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
  }
  // The hole on screen (or nearly): the pixels inside its ring see sky from anywhere, but those are the second images,
  // which aren't drawn; a star's first image is farther from the hole than the star is, so every star whose first
  // image lands on screen lies within the farthest corner's distance of the hole
  if (E > 0 && Math.abs(lx) < v.w / 2 + E && Math.abs(ly) < v.h / 2 + E) {
    const D = Math.max(...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sy]) => { const [x, y] = turned((sx * v.w) / 2, (sy * v.h) / 2); return Math.hypot(x - lx, y - ly); }));
    return [lx - D, lx + D, ly - D, ly + D];
  }
  return [x0, x1, y0, y1];
}

/**
 * The cells a draw covers: every cell whose star could light a pixel the screen shows (skyBox, grown by the
 * reach), and its instance count; null when the layer is faded out.
 */
export function spriteGrid(b: SkyBiome, v: SkyView, layer: number | 'deep', lens = 0, layerOn = true): { count: number; uniforms: Record<string, number | number[]> } | null {
  const [bx0, bx1, by0, by1] = skyBox(v, lens);
  const grid = (cellSize: number, scale: number, reachPx: number) => {
    const cellPx = cellSize * scale;
    const gx = v.cam[0] / cellSize, gy = v.cam[1] / cellSize;
    const x0 = Math.floor(gx + (bx0 - reachPx) / cellPx), x1 = Math.floor(gx + (bx1 + reachPx) / cellPx);
    const y0 = Math.floor(gy + (by0 - reachPx) / cellPx), y1 = Math.floor(gy + (by1 + reachPx) / cellPx);
    const cols = x1 - x0 + 1, rows = y1 - y0 + 1;
    return { cols, rows, u: [x0, y0, cols, rows] };
  };
  if (layer === 'deep') {
    const zSky = scaleAt(v.zoom, SKY_DEPTH);
    const deepCell = 700 / scaleAt(1, SKY_DEPTH);
    const g = grid(deepCell, zSky, 2.4 * 35 * zSky * deepCell / 700);
    const zm = scaleAt(v.zoom, MOTE_DEPTH);
    const moteCell = 140 / scaleAt(1, MOTE_DEPTH);
    const motes = 0.32 * b.motes * smooth(0.15, 0.5, v.zoom);
    const m = motes > 0.003 ? grid(moteCell, zm, 8) : { cols: 0, rows: 0, u: [0, 0, 1, 0] };
    const nd = g.cols * g.rows, nm = m.cols * m.rows;
    return {
      count: nd + nm,
      uniforms: {
        uDeep: [zSky, deepCell, b.deep.galaxies, b.deep.clusters], uMotes: [zm, moteCell, motes, 0],
        uGridDeep: g.u, uGridMote: m.u, uCounts: [nd, nm],
      },
    };
  }
  const L = SKY_LAYERS[layer];
  const dens = Math.sqrt(b.stars.density);
  const z = scaleAt(v.zoom, L.depth), cell = L.px / dens / scaleAt(1, L.depth), ratio = (cell * z) / (L.px / dens);
  const alpha = layerOn ? smooth(0.28, 0.55, ratio) : 0;
  if (alpha <= 0.003) return null;
  const g = grid(cell, z, REACH[layer] + 2);
  return {
    count: g.cols * g.rows,
    uniforms: { uL: [z, cell, Math.min(1, ratio * ratio), alpha], uLook: [REACH[layer], SIZE[layer], LUM[layer], FAR[layer]], uGrid: g.u, uLayer: layer },
  };
}

/**
 * The game's star shader (skyShaders' starsFrag) cut down to the inside of a black hole's Einstein ring. Every pixel
 * there shows a star's second image (bent right round the hole), from sky anywhere at all, which sprites can't reach;
 * so near a hole the old per-pixel shader still draws inside the ring (on a quad round it) and the sprites the rest.
 * Outside the ring it draws nothing, and a sprite's pixel inside the ring adds nothing (its bent ray points elsewhere).
 */
export function insideRingOnly(starsFrag: string): string {
  const main = 'void main() {\n  vec2 off = lensed(turned((vUV - 0.5) * uRes));';
  if (!starsFrag.includes(main)) throw new Error('insideRingOnly: starsFrag has changed');
  return starsFrag.replace(main, 'void main() {\n  vec2 sc = turned((vUV - 0.5) * uRes);\n  if (uLens.w <= 0.0 || length(sc - uLens.xy) > uLens.z) { fragColor = vec4(0.0); return; }\n  vec2 off = lensed(sc);');
}

/** The screen box (px from its middle, y down) round a black hole's Einstein ring, or null when it's off screen or there's none */
export function ringBox(v: SkyView, lens: number): [number, number, number, number] | null {
  if (lens <= 0) return null;
  const a = v.angle ?? 0, c = Math.cos(a), s = Math.sin(a);
  const E = lens * 4.5 * v.zoom, lx = -v.cam[0] * v.zoom, ly = -v.cam[1] * v.zoom;
  // (the hole's place on screen: its offset turned back into the screen's axes)
  const hx = c * lx + s * ly, hy = -s * lx + c * ly;
  const x0 = Math.max(-v.w / 2, hx - E), x1 = Math.min(v.w / 2, hx + E), y0 = Math.max(-v.h / 2, hy - E), y1 = Math.min(v.h / 2, hy + E);
  return x0 < x1 && y0 < y1 ? [x0, y0, x1, y1] : null;
}
