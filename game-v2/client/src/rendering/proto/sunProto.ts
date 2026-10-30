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
 * The game's sun has a hard ring inside its limb on stars whose edgeThickness is 0.03 (Sol): its rim highlight is
 * `smoothstep(1 - edgeThickness, 0.97, sunT)`, both edges 0.97, which GLSL leaves undefined (a step, in practice).
 * This gives that ramp a width (1.5% of the radius at least); nothing else changes. The faithful options all use it.
 */
export function withEdgeFix(src: string): string {
  const line = 'float brightEdge = smoothstep(brightEdgeStart, 0.97, sunT);';
  if (!src.includes(line)) return src;
  return src.replace(line, 'float brightEdge = smoothstep(min(brightEdgeStart, 0.955), 0.97, sunT);');
}

/** The baked simplex texture (protoNoise.bakeSimplex): this many texels across this many lattice units */
export const EXACT_SIZE = 2048;
export const EXACT_UNITS = 64;

/**
 * The exact stand-in for `snoise`: the game's own simplex values, baked (bakeSimplex; R16F, linear, clamped) and read
 * back with the coordinate mirrored into the baked square, so it's continuous everywhere and needs no tiling
 */
const TEXTURE_SNOISE_EXACT = `
  uniform sampler2D uSimplexTex;
  float snoise(vec2 v) {
    vec2 u = v * ${(1 / EXACT_UNITS).toFixed(6)} + 0.5;
    return textureLod(uSimplexTex, 1.0 - abs(1.0 - mod(u, 2.0)), 0.0).r;
  }
`;

/**
 * "A-exact": a game shader whose `snoise` reads the baked simplex texture (bind it as `uSimplexTex`): the same
 * values as the procedural noise, so the same picture, bar the texture's filtering between texels
 */
export function withExactNoise(src: string): string {
  const simplex = /float snoise\(vec2 v\) \{[\s\S]*?return 130\.0 \* dot\(m, g\);\s*\}/;
  if (!simplex.test(src)) throw new Error('withExactNoise: no snoise function in this shader');
  return src.replace(simplex, TEXTURE_SNOISE_EXACT);
}

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

/**
 * The cells' size: granules this many world units across whatever the star's size, and the smallest cell shown this
 * many px on screen. Round 1 had 60 and 10 (too fine to read at play zooms, Kieran found); B2 (round 3) has 500 and 48.
 */
export interface PhotoCells { granule: number; minPx: number }
const ROUND1_CELLS: PhotoCells = { granule: 60, minPx: 10 };
export const B2_CELLS: PhotoCells = { granule: 500, minPx: 48 };

/**
 * uLevel for a zoom (CSS px per world unit): the finest size of cell still at least `minPx` across at the disc's
 * middle. Cells are `granule` units at level 0 and 4.2 times bigger each level up; down to −2 zoomed right in.
 */
export function sunPhotoLevel(zoom: number, cells: PhotoCells = ROUND1_CELLS): number {
  const cellPx = (cells.granule * zoom) / 0.637;
  return Math.max(-2, Math.min(5, Math.log(cells.minPx / cellPx) / Math.log(1 / 0.237)));
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
export function sunPhotoLook(id: string, cb: SunBodyData, time = 0, zoom = 0.3, cells: PhotoCells = ROUND1_CELLS): SunPhotoLook {
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
      uTime: time, uReach: reach, uSeed: [rnd(), rnd()], uLevel: sunPhotoLevel(zoom, cells),
      uHot: palette.hot, uCore: palette.core, uBright: palette.bright, uMid: palette.mid, uDark: palette.dark, uRim: palette.rim, uCorona: palette.corona,
      uGran: [radius / cells.granule, contrast, boilRate, swirl],
      uSurf: [cb.detailParams?.limbDarkening !== undefined ? 0.3 + cb.detailParams.limbDarkening * 0.6 : 0.65, 0.8, sunlike ? 0.55 + rnd() * 0.3 : 0.15 * rnd(), 0.004 + rnd() * 0.004],
      uCor: [0.75 + rnd() * 0.3, 0.55 + rnd() * 0.35, Math.round(7 + rnd() * 8), 0.4 + rnd() * 0.4],
      uProm: [0.6, 0.12 + rnd() * 0.1, 0.006 + rnd() * 0.004, 1.5 + rnd() * 1.5],
      uFine: [sunPhotoFine(radius, zoom), heat],
    },
  };
}

/**
 * ALTERNATIVE: the plasma star (round 3). Not a photosphere but the star as it looks in the ultraviolet (or in a
 * game's imagination): glowing, domain-warped plasma with bright ridged filaments and active regions on a ball that
 * really turns (the noise is a 3D volume read at points on its sphere, about an axis tilted toward us, so features
 * swing across the disc and over the limb), a warm core, a limb that fades softly into its glow, a fringe of flame,
 * and a corona of soft glow and rays that stream outward (rings through the volume that scroll along its third axis).
 *
 * Multicolour (optional, per star: centralBody.plasma.iridescence): the plasma's own fields pick a hue for each place,
 * so colours swirl round each other with the flow: a rainbow, or two or three tints. Costs nothing extra: the fields
 * are reads the shader already makes.
 *
 * Bind protoNoise.noise3Data as `uNoise3` (a 64³ RGBA 3D texture, repeat, trilinear with mipmaps). `#define PLASMA_LITE`
 * drops the warp, the fine detail octaves, the flame fringe and the fine rays.
 */
export const PLASMA_FRAG = `#version 300 es
  // (#define PLASMA_R4 for round 4: the limb by viewing angle, a fake bump normal, the chromosphere, haze and spicules)
  precision highp float;
  precision highp sampler3D;
  in vec2 vUV;
  out vec4 fragColor;

  uniform sampler3D uNoise3;
  uniform float uTime;
  uniform float uReach;  // the quad's half-size, in star radii
  uniform vec3 uSeed;
  // The palette, coolest to hottest
  uniform vec3 uDark;
  uniform vec3 uMid;
  uniform vec3 uBright;
  uniform vec3 uCore;
  uniform vec3 uHot;
  uniform vec3 uRim;     // the flame fringe and the inner corona
  uniform vec3 uCorona;
  uniform vec4 uSurf;    // x feature scale, y warp, z contrast, w core glow
  uniform vec4 uMotion;  // x spin (rad/s), y axis tilt toward us (rad), z boil rate, w corona outflow
  uniform vec4 uCor;     // x strength, y ray frequency, z ray reach (radii), w glow falloff
  uniform vec2 uLimb;    // x how far in from the edge the disc fades into its glow (radii), y heat (brightness overall)
  uniform float uDetail; // 0..3: how many fine octaves (each 4x finer) show, faded in as the star grows on screen
  uniform vec4 uIrid;    // multicolour: x strength (0 off), y 1 rainbow / 0 tints, z drift (per s), w hue spread
  uniform vec3 uTintA;   // ... its tints
  uniform vec3 uTintB;
  uniform vec3 uTintC;
  // Round 4: the limb by viewing angle (mu, the cosine of it), and the edge into the atmosphere
  uniform vec4 uLimbD;     // x limb darkening (how dark at the edge), y its power, z contrast left at the limb, w bump
  uniform vec4 uLimbTint;  // rgb the colour the limb deepens toward, a how far
  uniform vec4 uChromo;    // x chromosphere strength, y its width (radii), z halo (scattered light), w spicule height (radii)
  uniform vec3 uChromoCol;

  vec3 ramp(float I) {
    vec3 c = mix(uDark, uMid, smoothstep(0.0, 0.32, I));
    c = mix(c, uBright, smoothstep(0.28, 0.6, I));
    c = mix(c, uCore, smoothstep(0.55, 0.88, I));
    return mix(c, uHot, smoothstep(0.86, 1.2, I));
  }

  /** The multicolour tint for a place, from two of the plasma's own fields (h, k in 0..1) */
  vec3 tint(float h, float k) {
    if (uIrid.y > 0.5) {
      // A rainbow: the hue runs along the field and drifts with time
      vec3 q = clamp(abs(fract(h * uIrid.w + uTime * uIrid.z + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
  #ifdef PLASMA_R4
      return mix(vec3(1.0), q, 0.85);
  #else
      return mix(vec3(1.0), q, 0.6);
  #endif
    }
    float a = h * uIrid.w + uTime * uIrid.z;
    return mix(mix(uTintA, uTintB, smoothstep(0.3, 0.7, fract(a))), uTintC, smoothstep(0.45, 0.85, k));
  }

  /** Recolour a ramp colour by a tint, keeping its brightness and the white-hot peaks */
  vec3 iridesce(vec3 c, vec3 t, float I) {
    float l = dot(c, vec3(0.3, 0.55, 0.15));
    vec3 tinted = t * l * 1.7;
  #ifdef PLASMA_R4
    // Bright places keep their hue (brighter, not whiter), so a rainbow stays a rainbow up close
    vec3 bright = t * (0.55 + 0.55 * I);
    return mix(c, mix(tinted, bright, smoothstep(0.75, 1.15, I)), uIrid.x);
  #else
    return mix(c, mix(tinted, c, smoothstep(0.95, 1.25, I)), uIrid.x);
  #endif
  }

  void main() {
    vec2 p = (vUV - 0.5) * 2.0 * uReach;
    float r = length(p);
    float px = fwidth(r);
    vec2 dir = p / max(r, 1e-5);

    // The point on the ball under this pixel, turned about a tilted axis
    float rc = min(r, 0.999);
    vec3 n = vec3(dir * rc, sqrt(1.0 - rc * rc));
    float ct = cos(uMotion.y), st = sin(uMotion.y);
    n = vec3(n.x, ct * n.y - st * n.z, st * n.y + ct * n.z);
    float a = uTime * uMotion.x, ca = cos(a), sa = sin(a);
    n = vec3(ca * n.x + sa * n.z, n.y, -sa * n.x + ca * n.z);
    vec3 P = n * uSurf.x + uSeed;
    // Filter widths here, where every pixel runs
    vec3 Px = dFdx(P), Py = dFdy(P);
    float boil = uTime * uMotion.z;

  #ifdef PLASMA_R4
    // (the soft edge and the chromosphere a share of the radius, but no more than this many pixels: zoomed in on a big
    // star they'd otherwise be hundreds of px of haze)
    float limbW = min(uLimb.x, 60.0 * px);
  #else
    float limbW = uLimb.x;
  #endif
    vec3 col = vec3(0.0);
    // The disc fades out over its last limbW of radius (a soft edge into the glow, as the game's sun does)
    float cover = 1.0 - smoothstep(1.0 - limbW - px, 1.0 + px * 0.5, r);
    if (cover > 0.0) {
      float mu = sqrt(max(1.0 - rc * rc, 0.0));
  #ifndef PLASMA_LITE
      // Domain warp: the plasma pushed about by a slower field of itself, which drifts on its own clock
      vec4 w = textureGrad(uNoise3, P * 0.21 + vec3(0.0, 0.0, boil * 0.5), Px * 0.21, Py * 0.21);
      vec3 Q = P + (w.rgb - 0.5) * uSurf.y;
      vec4 f = textureGrad(uNoise3, Q * 0.37 + vec3(boil, 0.0, 0.0), Px * 0.37, Py * 0.37);
      vec4 f2 = textureGrad(uNoise3, Q * 1.13 + vec3(0.31, boil * 1.7, 0.7), Px * 1.13, Py * 1.13);
      float body = f.r * 0.62 + f2.r * 0.38;
      float fil = pow(clamp(f.b * 0.55 + f2.b * 0.45, 0.0, 1.0), 3.0);
      float act = smoothstep(0.45, 0.8, w.g);
  #else
      // (no warp: two octaves straight off the ball)
      vec4 f = textureGrad(uNoise3, P * 0.37 + vec3(boil, 0.0, 0.0), Px * 0.37, Py * 0.37);
      vec4 f2 = textureGrad(uNoise3, P * 1.13 + vec3(0.31, boil * 1.7, 0.7), Px * 1.13, Py * 1.13);
      float body = f.r * 0.62 + f2.r * 0.38;
      float fil = pow(clamp(f.b * 0.55 + f2.b * 0.45, 0.0, 1.0), 3.0);
      float act = smoothstep(0.45, 0.8, f.g);
      vec3 Q = P;
  #endif
      float I = 0.5 + (body - 0.5) * 1.3 * uSurf.z + fil * (0.45 + 0.6 * act);
  #ifndef PLASMA_LITE
      // Finer octaves as the zoom shows them (the loop's bound is a uniform: whole screens agree, and pay only when close)
      float k = 4.1, amp = 0.3;
      for (int o = 0; o < 3; o++) {
        float wo = clamp(uDetail - float(o), 0.0, 1.0);
        if (wo <= 0.0) break;
        vec4 g = textureGrad(uNoise3, Q * k + float(o) * 0.37, Px * k, Py * k);
        I += ((o == 1 ? g.r : g.a) - 0.5) * amp * wo;
        k *= 4.0; amp *= 0.7;
      }
  #endif
  #ifdef PLASMA_R4
      float edgeOn = 1.0 - mu;   // 0 face-on, 1 seen edge-on at the limb
      // Contrast falls toward the limb (the cells seen through more atmosphere, and edge-on)
      I = 0.65 + (I - 0.65) * mix(uLimbD.z, 1.0, mu);
    #ifndef PLASMA_LITE
      if (uLimbD.w > 0.0) {
        // A fake normal: the plasma's height compared a step along a fixed light, so its ridges catch light on one side
        // and shade on the other; strongest at grazing angles, where relief shows most
        vec3 Ld = vec3(0.55, -0.6, 0.58);
        float hb = textureGrad(uNoise3, (Q + Ld * 0.35) * 0.37 + vec3(boil, 0.0, 0.0), Px * 0.37, Py * 0.37).r;
        I *= 1.0 + uLimbD.w * clamp((f.r - hb) * 5.0, -0.6, 0.6) * (0.3 + 0.7 * edgeOn);
      }
    #endif
      // Limb darkening (its depth and curve per star), and a core
      I = (I * mix(1.0 - uLimbD.x, 1.0, pow(mu, uLimbD.y)) + uSurf.w * pow(mu, 6.0) * 0.45) * uLimb.y;
      col = ramp(I);
      // Toward the limb the colour deepens (cooler, higher layers), and light scattered in the atmosphere hazes it
      col = mix(col, uLimbTint.rgb * (0.35 + dot(col, vec3(0.3, 0.55, 0.15))), uLimbTint.a * pow(edgeOn, 1.6));
      col += uCorona * uChromo.z * 0.15 * pow(edgeOn, 4.0);
  #else
      // A warm core, a darker, redder limb, and a bright rim right at the edge (the plasma seen edge-on)
      I = (I * mix(0.55, 1.0, pow(mu, 0.45)) + uSurf.w * pow(mu, 6.0) * 0.45) * uLimb.y;
      col = ramp(I) + uRim * pow(1.0 - mu, 6.0) * 0.4;
  #endif
      if (uIrid.x > 0.0) {
        // Multicolour: a slow field of its own (a few regions across the ball), pushed by the warp so the colours swirl
        // round each other; one more read, only for those stars
        float hs = 1.3 / uSurf.x;
        vec4 hz = textureGrad(uNoise3, (P + (Q - P) * 0.6) * hs + uSeed.zyx + vec3(0.0, uTime * uIrid.z * 3.0, 0.0), Px * hs, Py * hs);
        col = iridesce(col, tint(hz.r, hz.g), I);
      }
      col *= cover;
    }

    // Outside, and over the soft edge: flame at the limb, then glow and rays streaming outward
    float d = max(r - 1.0, 0.0);
    vec3 glow = vec3(0.0);
  #ifdef PLASMA_R4
    float inner = 1.0 - limbW - 3.0 * uChromo.y - 3.0 * px;
  #else
    float inner = 1.0 - limbW - 3.0 * px;
  #endif
    if (d < uReach - 1.0 && r > inner) {
      float outward = uTime * uMotion.w;
      float kr = uCor.y * 0.04;
  #ifdef PLASMA_R4
      // (a wider ring for the broad streamers: more of them round, so no two- or four-lobed shapes)
      float s1 = textureLod(uNoise3, vec3(dir * kr * 1.8, d * 0.12 - outward) + uSeed, 0.0).r;
  #else
      // Broad streamers: a ring through the volume (a function of the angle), its third axis scrolling slowly with
      // height and time, so they run out straight and flow outward
      float s1 = textureLod(uNoise3, vec3(dir * kr, d * 0.12 - outward) + uSeed, 0.0).r;
  #endif
      float streams = smoothstep(0.3, 0.85, s1);
  #if !defined(PLASMA_LITE) || defined(PLASMA_R4)
      // Fine rays: a ring four times as fast round, ridged, so they come out thin, straight and bright
      float s2 = textureLod(uNoise3, vec3(dir * kr * 4.0, d * 0.2 - outward * 1.6) + uSeed.zxy, 0.0).b;
      float rays = pow(s2, 3.0);
  #else
      float rays = 0.35;
  #endif
      float reach = uCor.z * (0.25 + 0.75 * streams);
      float corona = exp(-d * uCor.w) * 0.28 + exp(-d / max(reach, 0.02)) * (0.12 + 0.4 * streams) * (0.3 + 1.1 * rays);
      // (rising through the disc's fading edge, so the two meet without a line)
      corona *= smoothstep(uReach - 1.0, (uReach - 1.0) * 0.55, d) * smoothstep(1.0 - limbW - 2.0 * px, 1.0, r);
      vec3 cc = mix(uRim, uCorona, smoothstep(0.0, 0.25, d));
      if (uIrid.x > 0.0) cc = mix(cc, tint(s1, streams) * dot(cc, vec3(0.3, 0.55, 0.15)) * 1.7, uIrid.x * 0.8);
      glow = cc * corona * uCor.x;
  #ifdef PLASMA_R4
      // The chromosphere: a thin hotter band straddling the limb, so the surface runs into the atmosphere; a wide
      // halo of scattered light round it; and spicules, tongues of gas off the limb that fade from its colour into
      // the corona's
      float cw = min(uChromo.y, 20.0 * px) + 2.0 * px;
      float band = exp(-pow((r - 1.0 + cw * 0.3) / cw, 2.0));
      glow += uChromoCol * band * uChromo.x * 0.32 * (0.7 + 0.6 * streams);
      glow += uCorona * uChromo.z * 0.1 * exp(-d * 3.5) * smoothstep(1.0 - limbW - 2.0 * px, 1.0, r);
    #ifndef PLASMA_LITE
      float sh = uChromo.w;
      if (d < sh) {
        float lod = log2(max(px * kr * 12.0 * 64.0, 1.0));
        float t = textureLod(uNoise3, vec3(dir * kr * 12.0, d / sh * 0.8 - outward * 6.0) + uSeed.yzx, lod).b;
        float tongue = smoothstep(0.55, 0.95, t + 0.3 * (1.0 - d / sh)) * (1.0 - d / sh);
        glow += mix(uChromoCol, cc, d / sh) * tongue * (0.35 + 0.6 * streams) * 0.4 * smoothstep(1.0 - limbW - 2.0 * px, 1.0, r);
      }
    #endif
  #elif !defined(PLASMA_LITE)
      if (d < 0.04) {
        // The flame fringe: ridged tongues of plasma licking up off the limb, rising
        float lod = log2(max(px * kr * 12.0 * 64.0, 1.0));
        float t = textureLod(uNoise3, vec3(dir * kr * 12.0, d * 20.0 - outward * 6.0) + uSeed.yzx, lod).b;
        float tongue = smoothstep(0.6, 0.95, t + 0.3 * (1.0 - d / 0.04)) * (1.0 - d / 0.04);
        // (faded in across the disc's soft edge, as the corona is, so it starts without a line)
        glow += uRim * tongue * (0.3 + 0.6 * streams) * 0.5 * smoothstep(1.0 - limbW - 2.0 * px, 1.0, r);
      }
  #endif
    }

    fragColor = vec4(col + glow, cover);
  }
`;

/** Per-star plasma settings a system can give (centralBody.plasma in systems.json): all optional */
export interface PlasmaParams {
  /** Feature scale (bigger: finer swirls), warp, contrast, core glow, brightness overall */
  scale?: number;
  warp?: number;
  contrast?: number;
  core?: number;
  heat?: number;
  /** How far in from the edge the disc fades into its glow (radii) */
  softEdge?: number;
  /** Round 4, the limb by viewing angle: how dark it gets (0..1) and the curve's power, the contrast left there (0..1),
   * the colour it deepens toward and how far, and a fake bump normal's strength */
  limbDarkening?: number;
  limbPower?: number;
  limbContrast?: number;
  limbTint?: string;
  limbTintStrength?: number;
  bump?: number;
  /** Round 4, the edge: the chromosphere's strength, colour and width (radii), the scattered halo, spicule height (radii) */
  rim?: number;
  rimColor?: string;
  rimWidth?: number;
  halo?: number;
  spicules?: number;
  /** Multicolour swirls: a rainbow, or tints (two or three colours) carried round by the flow */
  iridescence?: { mode: 'rainbow' | 'tints'; colors?: string[]; strength?: number; drift?: number; spread?: number };
}

export interface PlasmaLook { reach: number; uniforms: Record<string, number | number[]> }

/** uDetail for a star this many px in radius on screen: a fine octave from 1,500 px, another each 4x bigger, up to 3 */
export function plasmaDetail(pxPerRadius: number): number {
  return Math.max(0, Math.min(3, Math.log2(pxPerRadius / 1500) / 2 + 0.5));
}

const luma = (c: Rgb) => 0.3 * c[0] + 0.55 * c[1] + 0.15 * c[2];

/**
 * The plasma star's uniforms for a system: its palette from its detail colours or its hue (as the game's sun takes
 * them), its surface from its style (flow stars warp hardest, granular ones are finer and contrastier), its brightness
 * from how hot its palette is (a red giant's dark reds stay dark), its motion and corona seeded by its id, and anything
 * its `plasma` settings say. Each frame: uTime, and uDetail from plasmaDetail.
 */
export function plasmaLook(id: string, cb: SunBodyData & { plasma?: PlasmaParams }, time = 0, pxPerRadius = 3000): PlasmaLook {
  const rnd = mulberry32(hashString(`plasma:${id}`));
  const hue = cb.detailParams?.hue ?? cb.hue ?? 40;
  const dc = cb.detailColors;
  const o = cb.plasma ?? {};
  // Features about the size of the game's sun's own (its fBM's first octaves); flow stars a little broader
  let scale = 9.5, warp = 1.4, contrast = 1, core = 1.2, soft = 0.025;
  if (cb.detailStar) {
    warp = 0.9 + (cb.detailParams?.warpAmount ?? 0.4) * 1.5;
    contrast = cb.detailParams?.fbmContrast ?? 1;
    core = 0.55;
    soft = Math.max(0.015, (cb.detailParams?.edgeThickness ?? 0.03) * 0.8);
  } else if (cb.sunStyle === 'flow') { warp = 2.4; scale = 8; core = 1.6; }
  else if (cb.sunStyle === 'granular') { warp = 0.8; scale = 12; contrast = 1.2; core = 1.6; }
  const palette = dc
    ? { dark: hex(dc.darkColor ?? '#5a1a00'), mid: hex(dc.midColor ?? '#cc4400'), bright: hex(dc.brightColor ?? '#ffaa22'), core: hex(dc.edgeColor ?? '#ffdd66'),
        hot: hex(dc.centerColor ?? '#fff2cc'), rim: lift(hex(dc.plasmaColor ?? dc.edgeColor ?? '#ffbb44'), 0.2), corona: hex(dc.brightColor ?? '#ffaa22') }
    : { dark: hsl(hue - 20, 0.95, 0.16), mid: hsl(hue - 8, 0.95, 0.38), bright: hsl(hue, 0.9, 0.58), core: hsl(hue + 8, 0.85, 0.78),
        hot: hsl(hue + 15, 0.5, 0.95), rim: hsl(hue + 12, 0.9, 0.72), corona: hsl(hue, 0.85, 0.6) };
  // A dark palette (a red giant's) burns lower: its middle colour's brightness sets the heat
  // (a red giant's dark reds stay dark; a blue or pink star's hot core stays nearly white, a touch under the game's)
  const heat = o.heat ?? (dc ? Math.max(0.5, Math.min(0.9, 0.2 + luma(palette.mid) * 1.6)) : 0.95);
  const ir = o.iridescence;
  const tints = (ir?.colors ?? ['#ff5fa2', '#5fd0ff', '#b6ff6a']).map(hex);
  const reach = 3.0;
  return {
    reach,
    uniforms: {
      uTime: time, uReach: reach, uSeed: [rnd() * 10, rnd() * 10, rnd() * 10],
      uDark: palette.dark, uMid: palette.mid, uBright: palette.bright, uCore: palette.core, uHot: palette.hot, uRim: palette.rim, uCorona: palette.corona,
      uSurf: [o.scale ?? scale, o.warp ?? warp, o.contrast ?? contrast, o.core ?? core],
      uMotion: [0.004 + rnd() * 0.003, 0.5 + rnd() * 0.4, 0.004 + rnd() * 0.003, 0.012 + rnd() * 0.008],
      uCor: [0.85 + rnd() * 0.3, 9 + Math.round(rnd() * 6), 0.7 + rnd() * 0.4, 10],
      uLimb: [o.softEdge ?? soft, heat],
      uDetail: plasmaDetail(pxPerRadius),
      uIrid: ir ? [ir.strength ?? 0.85, ir.mode === 'rainbow' ? 1 : 0, ir.drift ?? 0.01, ir.spread ?? (ir.mode === 'rainbow' ? 1.6 : 1.2)] : [0, 0, 0, 1],
      uTintA: tints[0], uTintB: tints[1] ?? tints[0], uTintC: tints[2] ?? tints[1] ?? tints[0],
      // Round 4 (unused by round 3): defaults from the star's own palette
      uLimbD: [o.limbDarkening ?? 0.5, o.limbPower ?? 0.6, o.limbContrast ?? 0.45, o.bump ?? 0.5],
      uLimbTint: [...(o.limbTint ? hex(o.limbTint) : palette.dark.map((c) => c * 1.6)), o.limbTintStrength ?? 0.45],
      uChromo: [o.rim ?? 0.6, o.rimWidth ?? 0.008, o.halo ?? 0.4, o.spicules ?? 0.035],
      uChromoCol: o.rimColor ? hex(o.rimColor) : lift(palette.rim, 0.1),
    },
  };
}
