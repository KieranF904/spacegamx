/**
 * PROTOTYPE sun shaders (not used by the game yet; docs/rendering/sun-sky-prototypes.md has the
 * comparison, the costs and how to switch over). Two ways to make the star cheaper:
 *
 *   A  "port"   the game's own shaders (SunRenderer, CoronaRaysRenderer, the central bodies' GLSL_COMMON)
 *               with their noise read from a texture (protoNoise.ts) instead of computed: `withTextureNoise`
 *               rewrites the source, so the look stays the game's, octave for octave.
 *   B  "photosphere"  a new star in one quad: cells that boil at every scale the zoom shows, limb darkening,
 *               spots and faculae, a thin chromosphere, prominences and a streamered, rayed corona, in about
 *               five texture reads a pixel. `SUN_PHOTO_LITE` drops the swirl, the spots, a corona read and the
 *               prominences (the low tier).
 *
 * The quad for B spans ±uReach star radii round the star; vUV runs 0..1 across it, as for the game's quads.
 * Output is premultiplied, like the game's sun: the disc covers what's behind it, the corona adds light.
 */

import { hashString, mulberry32 } from '@space-game/common';
import { SUN_GRANULES, SUN_NOISE_PERIOD, SUN_NOISE_SIZE } from './protoNoise';

/** The texture-read stand-in for the game's `snoise` (2D simplex, −1..1): one read of the `b` channel */
const TEXTURE_SNOISE = `
  uniform sampler2D uNoiseTex;
  float snoise(vec2 v) { return textureLod(uNoiseTex, v * ${(1 / SUN_NOISE_PERIOD).toFixed(5)}, 0.0).b * 2.0 - 1.0; }
`;

/** ...and for GLSL_COMMON's value `noise` (0..1) */
const TEXTURE_VALUE_NOISE = `
  uniform sampler2D uNoiseTex;
  float noise(vec2 p) { return textureLod(uNoiseTex, p * ${(1 / SUN_NOISE_PERIOD).toFixed(5)}, 0.0).b; }
`;

/**
 * A game shader with its per-pixel noise read from the noise texture (bind protoNoise's texture, repeat
 * wrap, linear, as `uNoiseTex`). The reads use LOD 0, so the picture stays the procedural one's, aliasing and
 * all, and they're legal in any branch or loop (no derivatives).
 */
export function withTextureNoise(src: string): string {
  const simplex = /float snoise\(vec2 v\) \{[\s\S]*?return 130\.0 \* dot\(m, g\);\s*\}/;
  const value = /float noise\(vec2 p\) \{[\s\S]*?f\.y\);\s*\}/;
  if (simplex.test(src)) return src.replace(simplex, TEXTURE_SNOISE);
  if (value.test(src)) return src.replace(value, TEXTURE_VALUE_NOISE);
  throw new Error('withTextureNoise: no snoise or noise function in this shader');
}

export const SUN_PHOTO_VERT = `#version 300 es
  in vec2 aPosition;
  in vec2 aUV;
  out vec2 vUV;
  uniform mat3 uProjectionMatrix;
  uniform mat3 uWorldTransformMatrix;
  uniform mat3 uTransformMatrix;
  void main() {
    vUV = aUV;
    mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
    gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  }
`;

const T = SUN_NOISE_SIZE.toFixed(1);
const G = SUN_GRANULES.toFixed(1);
const P = SUN_NOISE_PERIOD.toFixed(1);

/** Prepend `#define SUN_PHOTO_LITE` (after the version line) for the low tier */
export const SUN_PHOTO_FRAG = `#version 300 es
  precision highp float;
  in vec2 vUV;
  out vec4 fragColor;

  uniform sampler2D uNoiseTex;
  uniform float uTime;
  uniform float uReach;  // the quad's half-size, in star radii
  uniform vec2 uSeed;    // this star's place in the noise
  // The palette, hottest to coolest: what the surface's brightness maps to
  uniform vec3 uHot;
  uniform vec3 uCore;
  uniform vec3 uBright;
  uniform vec3 uMid;
  uniform vec3 uDark;
  uniform vec3 uRim;     // chromosphere and prominences
  uniform vec3 uCorona;
  uniform vec4 uGran;    // x granules across the radius, y their contrast, z boil rate, w swirl
  uniform float uLevel;  // which sizes of cell show: 0 the granules, each step up cells 4.2 times the size (from the zoom)
  uniform vec4 uSurf;    // x limb darkening (power of mu), y faculae, z spots, w spin (rad/s)
  uniform vec4 uCor;     // x corona strength, y its reach (radii), z streamers round it, w streamer contrast
  uniform vec4 uProm;    // x prominence strength, y their height (radii), z rise speed, w how many
  uniform vec2 uFine;    // x the corona's fine striations: a ring this many noise cells round (from the star's size on screen); y the disc's heat

  vec4 grad(vec2 uv, vec2 dx, vec2 dy) { return textureGrad(uNoiseTex, uv, dx, dy); }

  /**
   * Cells of size level n: two seeds cross-faded, each place on its own clock, so cells come and go (bigger ones
   * live longer); dividing by the spread a mix of two loses keeps the contrast through the fade
   */
  float cells(vec2 gq, vec2 dx, vec2 dy, float n, float boil) {
    float k = pow(0.237, n);
    vec4 g = grad(gq * k + n * 0.31, dx * k, dy * k);
    float t = 0.5 + 0.5 * sin(boil * pow(0.6, n) + g.b * 6.2832 + n * 1.7);
    return (mix(g.r, g.g, t) - 0.6) / sqrt(t * t + (1.0 - t) * (1.0 - t)) + 0.6;
  }

  void main() {
    vec2 p = (vUV - 0.5) * 2.0 * uReach;     // star radii from its middle
    float r = length(p);
    float px = fwidth(r);                    // a pixel, in radii
    vec2 dir = p / max(r, 1e-5);

    // Where on the ball: the arc from the pole (we look down on it) out to the limb, so features crowd and
    // shrink toward the edge as on a sphere; the ball turns slowly about the pole
    float rc = min(r, 0.9995);
    float arc = asin(rc) * 0.63662;
    float sa = sin(uTime * uSurf.w), ca = cos(uTime * uSurf.w);
    vec2 q = mat2(ca, sa, -sa, ca) * dir * arc;
    // Filter widths, worked out here where every pixel runs (derivatives aren't defined in branches)
    vec2 qdx = dFdx(q), qdy = dFdy(q);

    vec3 col = vec3(0.0);
    float cover = 1.0 - smoothstep(1.0 - px, 1.0 + px, r);

    if (cover > 0.0) {
      float mu = sqrt(max(1.0 - rc * rc, 0.0));
      float kg = uGran.x / ${G};             // granule texture tiles per unit of q
      vec2 gq = q * kg + uSeed;
      float act = 0.5, reg = 0.5;
  #ifndef SUN_PHOTO_LITE
      // Flows: push the cells about (the flow stars lean on this, and swirl), and mottle the surface
      vec4 flow = grad(q * 0.9 + uSeed * 0.37 + uTime * 0.0015, qdx * 0.9, qdy * 0.9);
      gq += (flow.ba - 0.5) * uGran.w;
      act = flow.a;
      // Big slow regions: brighter and dimmer, and where it peaks, spots
      reg = grad(q * 0.42 + uSeed.yx * 1.31, qdx * 0.42, qdy * 0.42).a;
  #endif
      // The two sizes of cell that suit the zoom, faded from one to the next: cells always a few pixels and up
      float n0 = floor(uLevel);
      float boil = uTime * uGran.z;
      float gran = mix(cells(gq, qdx * kg, qdy * kg, n0, boil), cells(gq, qdx * kg, qdy * kg, n0 + 1.0, boil), uLevel - n0);

      // Limb darkening, and the cells flatten toward the limb (seen edge-on); the big cells are fainter, as
      // supergranules are against granules
      float cw = uGran.y * 0.6 * pow(0.6, max(uLevel, 0.0));
      float I = uFine.y * pow(mu, uSurf.x) * (0.9 + cw * (gran - 0.6) * (0.35 + 0.65 * mu));
      // Mottling at two scales
      I *= (0.8 + 0.4 * act) * (0.88 + 0.24 * reg);
      // Faculae: bright patches round active regions, seen best near the limb
      I += uSurf.y * smoothstep(0.55, 0.75, act) * pow(1.0 - mu, 1.5) * 0.3;
  #ifndef SUN_PHOTO_LITE
      if (uSurf.z > 0.0) {
        // Spots: where the slow field peaks, a ragged penumbra round a dark umbra
        float th = 1.0 - uSurf.z * 0.3;
        float pen = smoothstep(th, th + 0.02, reg), umb = smoothstep(th + 0.035, th + 0.055, reg);
        I *= 1.0 - pen * (0.35 + 0.2 * gran) - umb * 0.4;
      }
  #endif
      vec3 c = mix(uDark, uMid, smoothstep(0.05, 0.38, I));
      c = mix(c, uBright, smoothstep(0.33, 0.7, I));
      c = mix(c, uCore, smoothstep(0.65, 1.0, I));
      c = mix(c, uHot, smoothstep(0.95, 1.25, I));
      col = c * cover;
    }

    // Outside (and over the edge): chromosphere, corona and prominences, all light, nothing covered
    float d = max(r - 1.0, 0.0);
    vec3 glow = vec3(0.0);
    if (d < uReach - 1.0 && r > 1.0 - 3.0 * px) {
      // Streamers and rays: a ring through the noise is a function of the angle alone (no atan, nothing to wrap);
      // the ring widens with height, so they bend and fork as they go out
      float R0 = uCor.z * 0.16;
      float n1 = textureLod(uNoiseTex, dir * (R0 + d * 0.35) / ${P} + vec2(uTime * 0.0021, uSeed.x), 0.0).b;
      float n3 = textureLod(uNoiseTex, dir * (R0 * 5.5 + d * 0.6) / ${P} + vec2(uSeed.y * 1.7, uTime * 0.004), 0.0).b;
  #ifndef SUN_PHOTO_LITE
      float n2 = textureLod(uNoiseTex, dir * (R0 * 2.7 + d * 0.8) / ${P} + vec2(uSeed.y, -uTime * 0.0033), 0.0).b;
  #else
      float n2 = 0.5;
  #endif
      float streams = pow(smoothstep(0.25, 0.85, n1 * 0.75 + n2 * 0.25), 1.0 + uCor.w * 2.0);
      float rays = smoothstep(0.35, 0.75, n3);
  #ifndef SUN_PHOTO_LITE
      // Fine striations, as fine as the zoom shows: straight plumes a few tens of pixels apart along the limb
      float fine = textureLod(uNoiseTex, dir * uFine.x / ${P} + uSeed * 1.9, 0.0).b;
      rays *= 0.55 + 0.9 * fine;
  #endif
      // The corona's light falls off fast near the star, and slower along a streamer or a ray
      float reach = uCor.y * (0.15 + 0.6 * streams + 0.45 * rays * (0.4 + 0.6 * streams));
      float corona = exp(-d / max(reach, 0.02)) * (0.22 + 0.4 * streams + 0.4 * rays) * 0.45 + 0.16 * exp(-d * 12.0);
      corona *= smoothstep(uReach - 1.0, (uReach - 1.0) * 0.6, d) * smoothstep(1.0 - 2.0 * px, 1.0 + 2.0 * px, r);
      glow = uCorona * corona * uCor.x;
      // The chromosphere: a thin bright line hugging the limb
      glow += uRim * exp(-d / 0.006) * 0.8 * smoothstep(1.0 - 3.0 * px, 1.0, r);
  #ifndef SUN_PHOTO_LITE
      if (uProm.x > 0.0 && d < uProm.y) {
        // Prominences: a few sites round the limb (a slower ring), each a wispy arch of gas rising off it
        float site = smoothstep(0.7, 0.82, textureLod(uNoiseTex, dir * uProm.w * 0.05 + uSeed * 0.71, 0.0).a);
        float h = uProm.y * site;
        // Fibrous: ridges of the noise drawn out along the radius (the field lines the gas follows), rising
        vec2 fp = vec2(dot(p, vec2(-dir.y, dir.x)) * 40.0, d * 9.0 - uTime * uProm.z * 9.0);
        float lod = log2(max(px * 40.0 * ${T} / ${P}, 1.0));
        float strand = 1.0 - abs(textureLod(uNoiseTex, fp / ${P} + uSeed, lod).b * 2.0 - 1.0);
        float body = site * smoothstep(h, h * 0.15, d) * smoothstep(0.55, 0.95, strand * (0.75 + 0.5 * (1.0 - d / max(h, 1e-3))));
        glow += uRim * body * uProm.x;
      }
  #endif
    }

    fragColor = vec4(col + glow, cover);
  }
`;

export type Rgb = [number, number, number];

/** What sunPhotoLook reads: a system's centralBody (systems.json) */
export interface SunBodyData {
  radius?: number;
  hue?: number;
  sunStyle?: string;
  detailStar?: boolean;
  detailParams?: Record<string, number>;
  detailColors?: Record<string, string>;
}

export interface SunPhotoLook {
  /** The quad's half-size in star radii (uReach) */
  reach: number;
  uniforms: Record<string, number | number[]>;
}

const hex = (h: string): Rgb => { const v = parseInt(h.replace('#', ''), 16); return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]; };
function hsl(h: number, s: number, l: number): Rgb {
  h = (((h % 360) + 360) % 360) / 360;
  const f = (n: number) => { const k = (n + h * 12) % 12; return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0), f(8), f(4)];
}
const lift = (c: Rgb, k: number): Rgb => c.map((v) => v + (1 - v) * k) as Rgb;

/** Granules this many world units across, whatever the star's size */
const GRANULE = 60;

/**
 * uLevel for a zoom (CSS px per world unit): the finest size of cell still at least 10 px across at the disc's
 * middle. Cells are GRANULE units at level 0 and 4.2 times bigger each level up; down to −2 zoomed right in.
 */
export function sunPhotoLevel(zoom: number): number {
  const cellPx = (GRANULE * zoom) / 0.637;
  return Math.max(-2, Math.min(4, Math.log(10 / cellPx) / Math.log(1 / 0.237)));
}

/** uFine.x for a star of `radius` at a zoom: its corona's fine striations about 30 px apart round the limb */
export function sunPhotoFine(radius: number, zoom: number): number {
  return Math.max(12, Math.min(4000, (radius * zoom) / 30));
}

/**
 * B's uniforms for a star: its palette from the system's own colours (a detail star's) or from its hue,
 * the surface from its style (flow stars swirl, granular ones are fine-grained and contrasty, detail stars
 * take their warp), and the details that tell stars apart (spots, prominences, streamers) seeded by its id.
 * Set uTime and uLevel (sunPhotoLevel) each frame.
 */
export function sunPhotoLook(id: string, cb: SunBodyData, time = 0, zoom = 0.3): SunPhotoLook {
  // (uFine.x, uLevel and uTime follow the zoom and the clock: set them each frame, from sunPhotoFine and sunPhotoLevel)
  const rnd = mulberry32(hashString(`sunphoto:${id}`));
  const hue = cb.detailParams?.hue ?? cb.hue ?? 40;
  const radius = cb.detailParams?.radius ?? cb.radius ?? 20000;
  const dc = cb.detailColors;
  // (Swirl shears the cells into streaks: the flow stars' look; real granules barely stretch)
  let swirl = 0.08, contrast = 1, boilRate = 0.5, heat = 1.15;
  if (cb.detailStar) {
    swirl = 0.03 + (cb.detailParams?.warpAmount ?? 0.4) * 0.1;
    heat = 1.05;
    contrast = 0.8 + (cb.detailParams?.fbmContrast ?? 1) * 0.3;
  } else if (cb.sunStyle === 'flow') {
    swirl = 1.6; contrast = 0.9; boilRate = 0.35;
  } else if (cb.sunStyle === 'granular') {
    swirl = 0.05; contrast = 1.1; boilRate = 0.7;
  }
  const palette = dc
    ? { hot: hex(dc.centerColor ?? '#fff2cc'), core: hex(dc.edgeColor ?? '#ffdd66'), bright: hex(dc.brightColor ?? '#ffaa22'), mid: hex(dc.midColor ?? '#cc4400'),
        dark: hex(dc.darkColor ?? '#5a1a00'), rim: lift(hex(dc.plasmaColor ?? dc.edgeColor ?? '#ffbb44'), 0.15), corona: hex(dc.brightColor ?? '#ffaa22') }
    : { hot: hsl(hue + 15, 0.5, 0.94), core: hsl(hue + 8, 0.8, 0.8), bright: hsl(hue, 0.9, 0.6), mid: hsl(hue - 6, 0.95, 0.4),
        dark: hsl(hue - 18, 0.95, 0.18), rim: hsl(hue + 12, 0.85, 0.78), corona: hsl(hue, 0.85, 0.62) };
  // Yellow-orange stars like ours get spots; hotter or stranger ones fewer
  const sunlike = hue > 5 && hue < 60;
  const reach = 3.2;
  return {
    reach,
    uniforms: {
      uTime: time, uReach: reach, uSeed: [rnd(), rnd()], uLevel: sunPhotoLevel(zoom),
      uHot: palette.hot, uCore: palette.core, uBright: palette.bright, uMid: palette.mid, uDark: palette.dark, uRim: palette.rim, uCorona: palette.corona,
      uGran: [radius / GRANULE, contrast, boilRate, swirl],
      uSurf: [cb.detailParams?.limbDarkening !== undefined ? 0.3 + cb.detailParams.limbDarkening * 0.6 : 0.65, 0.8, sunlike ? 0.55 + rnd() * 0.3 : 0.15 * rnd(), 0.004 + rnd() * 0.004],
      uCor: [0.75 + rnd() * 0.3, 0.55 + rnd() * 0.35, Math.round(7 + rnd() * 8), 0.4 + rnd() * 0.4],
      uProm: [0.6, 0.12 + rnd() * 0.1, 0.006 + rnd() * 0.004, 1.5 + rnd() * 1.5],
      uFine: [sunPhotoFine(radius, zoom), heat],
    },
  };
}
