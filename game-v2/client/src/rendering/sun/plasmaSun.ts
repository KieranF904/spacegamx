/**
 * The star: plasma round 5 (docs/rendering/sun-sky-prototypes.md), as the game draws it. A ball of glowing, turning
 * plasma (a 3D noise volume read at points on its sphere, domain-warped, with ridged filaments), its limb by viewing
 * angle (darkening, colour, contrast, a fake bump), a ragged edge under a chromosphere band, haze and spicules, and a
 * corona of glow and rays streaming outward, all in one quad of ±3 radii. Drawn into a target smaller than the screen
 * (SunRenderer: ½ resolution, ⅓ on Low) and stretched over it.
 *
 * Everything that differs between stars is data: `centralBody.plasma` in systems.json (PlasmaParams; checked by
 * server/src/data/validateGameData.ts), with defaults from the star's own palette (its detail colours or its hue).
 *
 * Shipped from the prototype's `PLASMA_FRAG` with `PLASMA_R4` and `PLASMA_R5` (proto/sunProto.ts keeps every round
 * and the lite and low versions for the lab and the harness), plus one addition, fine detail (`uFine`: threads, their flow,
 * granulation, the fine octaves' contrast and onset), which Sol uses for more detail at the limb and up close. Without
 * it (the defaults) it is R5 exactly.
 */

import { hashString, mulberry32 } from '@space-game/common';

/** The volume's size (protoNoise.noise3Data: a 64³ RGBA volume that tiles on every axis) */
export const PLASMA_NOISE_SIZE = 64;

export const PLASMA_SUN_VERT = `#version 300 es
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

/** The star's fragment shader; `fine` (a star with fine detail: plasmaFine) adds the threads and granulation */
export const plasmaSunFrag = (fine: boolean): string => fine ? PLASMA_SUN_FRAG.replace('#version 300 es', '#version 300 es\n  #define PLASMA_FINE 1') : PLASMA_SUN_FRAG;

/** Whether a star's look uses the fine detail (its own program, so the others pay nothing for it) */
export const plasmaFine = (look: StarLook): boolean => {
  const f = look.uniforms.uFine as number[];
  return f[0] > 0 || f[1] > 0 || f[2] !== 1;
};

export const PLASMA_SUN_FRAG = `#version 300 es
  #define SHADER_NAME plasma-sun
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
  uniform vec3 uRim;     // the inner corona's colour
  uniform vec3 uCorona;
  uniform vec4 uSurf;    // x feature scale, y warp, z contrast, w core glow
  uniform vec4 uMotion;  // x spin (rad/s), y axis tilt toward us (rad), z boil rate, w corona outflow
  uniform vec4 uCor;     // x strength, y ray frequency, z ray reach (radii), w glow falloff
  uniform vec2 uLimb;    // x how far in from the edge the disc fades (radii), y heat (brightness overall)
  uniform float uDetail; // 0..3: how many fine octaves (each 4x finer) show, faded in as the star grows on screen
  uniform vec4 uIrid;    // multicolour: x strength (0 off), y 1 rainbow / 0 tints, z drift (per s), w hue spread
  uniform vec3 uTintA;   // ... its tints
  uniform vec3 uTintB;
  uniform vec3 uTintC;
  uniform vec4 uLimbD;     // x limb darkening (how dark at the edge), y its power, z contrast left at the limb, w bump
  uniform vec4 uLimbTint;  // rgb the colour the limb deepens toward, a how far
  uniform vec4 uChromo;    // x chromosphere strength, y its width (radii), z halo (scattered light), w spicule height (radii)
  uniform vec3 uChromoCol;
  uniform vec3 uEvolve;    // x how fast the pattern evolves in place (sample units/s), y the warp's own evolution, z its wander
  uniform float uPxR;      // the star's radius on screen (CSS px): what the edge's noise is sized by
  uniform vec4 uFine;      // the fine detail (PLASMA_FINE): x threads, y granulation, z the fine octaves' contrast, w how far the plasma pushes them

  vec3 ramp(float I) {
    vec3 c = mix(uDark, uMid, smoothstep(0.0, 0.32, I));
    c = mix(c, uBright, smoothstep(0.28, 0.6, I));
    c = mix(c, uCore, smoothstep(0.55, 0.88, I));
    return mix(c, uHot, smoothstep(0.86, 1.2, I));
  }

  /** The multicolour tint for a place, from two of the plasma's own fields (h, k in 0..1) */
  vec3 tint(float h, float k) {
    if (uIrid.y > 0.5) {
      vec3 q = clamp(abs(fract(h * uIrid.w + uTime * uIrid.z + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
      return mix(vec3(1.0), q, 0.85);
    }
    float a = h * uIrid.w + uTime * uIrid.z;
    return mix(mix(uTintA, uTintB, smoothstep(0.3, 0.7, fract(a))), uTintC, smoothstep(0.45, 0.85, k));
  }

  /** Multicolour from the structure: lanes a deeper hue than the hot cores, so colour follows the flow */
  vec3 iridesce(vec3 c, float h, float I) {
    vec3 lane = tint(h - 0.18, 0.3);
    vec3 hot = tint(h + 0.12, 0.75);
    float l = dot(c, vec3(0.3, 0.55, 0.15));
    vec3 m = mix(lane * l * 1.5, hot * (0.45 + 0.6 * I), smoothstep(0.35, 1.0, I));
    return mix(c, m, uIrid.x);
  }

  /**
   * A ring of the noise round the limb (along \`dir\`, at height h above it), f features' worth round it. f moves in
   * steps of two with the star's size on screen and the two neighbouring steps are cross-faded (their contrast kept), so
   * as the zoom changes the features stay where they are on the star and only fade in or out: a frequency that followed
   * the zoom exactly re-rolled the pattern every frame, which flickered while zooming. Up the radius the frequency is kh
   * of the step's (at least hMin). Each read is filtered for the pixel's footprint (px radii), so it never aliases.
   */
  vec4 edgeRing(vec2 dir, float h, float f, float kh, float hMin, float z, vec3 off, float px) {
    float L = log2(max(f, 1e-3));
    float l0 = floor(L), a = L - l0;
    float f0 = exp2(l0), f1 = f0 * 2.0;
    // (each step its own place in the volume, the same whichever of the two it is, so nothing jumps as they hand over)
    float h0 = max(hMin, f0 * kh), h1 = max(hMin, f1 * kh);
    vec4 n0 = textureLod(uNoise3, vec3(dir * f0, h * h0 + z) + off + fract(l0 * 0.37), log2(max(max(f0, h0) * ${PLASMA_NOISE_SIZE.toFixed(1)} * px, 1.0)));
    vec4 n1 = textureLod(uNoise3, vec3(dir * f1, h * h1 + z) + off + fract((l0 + 1.0) * 0.37), log2(max(max(f1, h1) * ${PLASMA_NOISE_SIZE.toFixed(1)} * px, 1.0)));
    return clamp((mix(n0, n1, a) - 0.5) / sqrt(a * a + (1.0 - a) * (1.0 - a)) + 0.5, 0.0, 1.0);
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
    // Evolution: the sampling sphere slides through the volume along the line of sight, so features grow, morph and
    // dissolve where they are; the warp evolves on its own clock and wanders a little, independent of the turning
    vec3 viewAxis = vec3(sa * ct, -st, ca * ct);
    vec3 evo = viewAxis * uTime * uEvolve.x;
    vec3 evoW = viewAxis * uTime * uEvolve.y + vec3(sin(uTime * 0.031), cos(uTime * 0.023), sin(uTime * 0.017)) * uEvolve.z;

    // (the soft edge a share of the radius, but no more than 60 px: zoomed in on a big star it'd be hundreds of px of haze)
    float limbW = min(uLimb.x, 60.0 * px);
    vec3 col = vec3(0.0);
    // A ragged edge: where the fade starts and ends varies round the limb and along the radius (structure the fringe
    // shares), so there's no clean ring where the disc ends; only near the limb. Its features about every 40 px along
    // the limb at any zoom (in steps, cross-faded: edgeRing), and along the radius the same, so the small volume's
    // voxels never show
    float en = 0.5;
    if (r > 1.0 - 3.0 * limbW - 3.0 * px && r < 1.1)
      en = edgeRing(dir, r - 1.0, max(uCor.y * 0.36, uPxR / 110.0), 0.7, 6.0, uTime * uMotion.w * 2.0, uSeed.zyx, px).r;
    float cover = 1.0 - smoothstep(1.0 - limbW * (0.5 + 1.3 * en) - px, 1.0 + px * 0.5 + limbW * 0.4 * en, r);
    if (cover > 0.0) {
      float mu = sqrt(max(1.0 - rc * rc, 0.0));
      // Domain warp: the plasma pushed about by a slower field of itself, which drifts on its own clock
      vec4 w = textureGrad(uNoise3, P * 0.21 + vec3(0.0, 0.0, boil * 0.5) + evoW, Px * 0.21, Py * 0.21);
      vec3 Q = P + (w.rgb - 0.5) * uSurf.y;
      vec4 f = textureGrad(uNoise3, Q * 0.37 + vec3(boil, 0.0, 0.0) + evo, Px * 0.37, Py * 0.37);
      vec4 f2 = textureGrad(uNoise3, Q * 1.13 + vec3(0.31, boil * 1.7, 0.7) + evo * 1.6, Px * 1.13, Py * 1.13);
      float body = f.r * 0.62 + f2.r * 0.38;
      float fil = pow(clamp(f.b * 0.55 + f2.b * 0.45, 0.0, 1.0), 3.0);
      float act = smoothstep(0.45, 0.8, w.g);
      float I = 0.5 + (body - 0.5) * 1.3 * uSurf.z + fil * (0.45 + 0.6 * act);
      // Finer octaves as the zoom shows them (the loop's bound is a uniform: whole screens agree, and pay only when close)
  #ifdef PLASMA_FINE
      // Fine detail (a star's uFine; Sol's), from the same reads: each octave's ridges are threads (thin bright
      // filaments, strongest in active regions) with darker lanes beside them (granulation), and the octaves are pushed
      // along by the plasma's second field (f2, read already), so the fine detail flows with it instead of lying over it.
      // (Pushed by f2, not each by the one before: the octaves' reads stay independent of each other, so they overlap)
      vec3 Qf = Q + (f2.rga - 0.5) * uFine.w;
      float k = 4.1, amp = 0.3;
  #else
      float k = 4.1, amp = 0.3;
  #endif
      for (int o = 0; o < 3; o++) {
        float wo = clamp(uDetail - float(o), 0.0, 1.0);
        if (wo <= 0.0) break;
  #ifdef PLASMA_FINE
        vec4 g = textureGrad(uNoise3, Qf * k + float(o) * 0.37 + evo * k * 2.0, Px * k, Py * k);
        I += ((o == 1 ? g.r : g.a) - 0.5) * amp * wo * uFine.z;
        float rr = g.b * g.b;
        I += (uFine.x * (rr * rr * (0.5 + 0.9 * act) - 0.07) - uFine.y * (rr - 0.3)) * amp * wo;
  #else
        vec4 g = textureGrad(uNoise3, Q * k + float(o) * 0.37 + evo * k * 2.0, Px * k, Py * k);
        I += ((o == 1 ? g.r : g.a) - 0.5) * amp * wo;
  #endif
        k *= 4.0; amp *= 0.7;
      }
      float edgeOn = 1.0 - mu;   // 0 face-on, 1 seen edge-on at the limb
      // Contrast falls toward the limb (the cells seen through more atmosphere, and edge-on)
      I = 0.65 + (I - 0.65) * mix(uLimbD.z, 1.0, mu);
      if (uLimbD.w > 0.0) {
        // A fake normal: the plasma's height compared a step along a fixed light, so its ridges catch light on one side
        // and shade on the other; strongest at grazing angles, where relief shows most
        vec3 Ld = vec3(0.55, -0.6, 0.58);
        float hb = textureGrad(uNoise3, (Q + Ld * 0.35) * 0.37 + vec3(boil, 0.0, 0.0) + evo, Px * 0.37, Py * 0.37).r;
        I *= 1.0 + uLimbD.w * clamp((f.r - hb) * 5.0, -0.6, 0.6) * (0.3 + 0.7 * edgeOn);
      }
      // Limb darkening (its depth and curve per star), and a core
      I = (I * mix(1.0 - uLimbD.x, 1.0, pow(mu, uLimbD.y)) + uSurf.w * pow(mu, 6.0) * 0.45) * uLimb.y;
      col = ramp(I);
      // Toward the limb the colour deepens (cooler, higher layers), and light scattered in the atmosphere hazes it
      col = mix(col, uLimbTint.rgb * (0.35 + dot(col, vec3(0.3, 0.55, 0.15))), uLimbTint.a * pow(edgeOn, 1.6));
      col += uCorona * uChromo.z * 0.15 * pow(edgeOn, 4.0);
      // Multicolour from the structure itself (the warp, the body and filaments, the heat): no extra read
      if (uIrid.x > 0.0) col = iridesce(col, (w.r - 0.5) * 1.2 + body * 0.8 + fil * 0.6 + I * 0.35, I);
      col *= cover;
    }

    // Outside, and over the soft edge: the chromosphere, haze and spicules, then glow and rays streaming outward
    float d = max(r - 1.0, 0.0);
    vec3 glow = vec3(0.0);
    float inner = 1.0 - 2.6 * limbW - 3.0 * uChromo.y - 3.0 * px;
    if (d < uReach - 1.0 && r > inner) {
      float outward = uTime * uMotion.w;
      float kr = uCor.y * 0.04;
      // Broad streamers: a ring through the volume (a function of the angle; wide, so no two- or four-lobed shapes),
      // its third axis scrolling with height and time, so they run out straight and flow outward
      float s1 = textureLod(uNoise3, vec3(dir * kr * 1.8, d * 0.12 - outward) + uSeed, 0.0).r;
      float streams = smoothstep(0.3, 0.85, s1);
      // Fine rays: a ring four times as fast round, ridged, so they come out thin, straight and bright
      float s2 = textureLod(uNoise3, vec3(dir * kr * 4.0, d * 0.2 - outward * 1.6) + uSeed.zxy, 0.0).b;
      float rays = pow(s2, 3.0);
      float reach = uCor.z * (0.25 + 0.75 * streams);
      float corona = exp(-d * uCor.w) * 0.28 + exp(-d / max(reach, 0.02)) * (0.12 + 0.4 * streams) * (0.3 + 1.1 * rays);
      // (rising through the disc's ragged fade, so the two meet without a line)
      corona *= smoothstep(uReach - 1.0, (uReach - 1.0) * 0.55, d) * smoothstep(1.0 - limbW * (1.0 + en) - 2.0 * px, 1.0, r);
      vec3 cc = mix(uRim, uCorona, smoothstep(0.0, 0.25, d));
      if (uIrid.x > 0.0) cc = mix(cc, tint(s1, streams) * dot(cc, vec3(0.3, 0.55, 0.15)) * 1.7, uIrid.x * 0.8);
      glow = cc * corona * uCor.x;
      // The chromosphere band, the haze and the spicules lie over the disc's ragged fade and vary round the limb (with
      // the same structure), so the fade never reads as a ramp, and none of them ends at one height all round
      float cw = (min(uChromo.y, 20.0 * px) + 2.0 * px) * (0.7 + 0.6 * en);
      float band = exp(-pow((r - 1.0 + cw * 0.6) / cw, 2.0));
      glow += uChromoCol * band * uChromo.x * 0.32 * (0.55 + 0.5 * streams + 0.5 * en);
      float hazeIn = smoothstep(1.0 - 2.5 * limbW - 2.0 * px, 1.0, r);
      // (three falloffs, short to long, so the light past the fringe keeps fading smoothly instead of levelling off)
      glow += uCorona * uChromo.z * (0.1 * exp(-d * 40.0) + 0.08 * exp(-d * 3.5) + 0.04 * exp(-d * 1.2)) * hazeIn * (0.6 + 0.8 * en);
      float sh = uChromo.w;
      float s = r - 1.0;
      float shv = sh * (0.4 + 0.6 * streams + 0.6 * en);
      if (s < shv) {
        float u = max(s, 0.0) / shv;
        // (sized by the star's size on screen, a uniform, in steps (edgeRing): sized by each pixel's own footprint,
        // neighbouring pixels' slight differences jump the ring to unrelated noise, in blocks)
        float t = edgeRing(dir, s, max(kr * 12.0, uPxR / 70.0), 0.3, 0.8 / sh, -outward * 6.0, uSeed.yzx, px).b;
        // Rooted at the limb: the tongues rise from just inside it (a little over the ragged fade) with the same width
        // all along it, and thin out going up, to a height that varies round it. The noise runs on through the limb (no
        // one slice of it drawn out inward into streaks), and further in there's only a soft glow under them, about the
        // tongues' average, over the fade
        float env = (1.0 - u) * (1.0 - u);
        float root = smoothstep(-0.6 * limbW - 2.0 * px, 0.0, s);
        float under = smoothstep(-1.6 * limbW - 2.0 * px, -0.2 * limbW, s) * (1.0 - root) * 0.3;
        float tongue = smoothstep(0.5, 0.95, t + 0.3 * (1.0 - u)) * root + under;
        glow += mix(uChromoCol, cc, u) * tongue * env * (0.35 + 0.6 * streams) * 0.3;
      }
    }

    fragColor = vec4(col + glow, cover);
  }
`;

/** Per-star plasma settings (centralBody.plasma in systems.json; common's STAR_PLASMA_FIELDS gives each one's range for
 * the data checks): all optional, defaults from the star's palette */
export interface PlasmaParams {
  /** Feature scale (bigger: finer swirls), warp, contrast, core glow, brightness overall */
  scale?: number;
  warp?: number;
  contrast?: number;
  core?: number;
  heat?: number;
  /** How far in from the edge the disc fades into its glow (radii) */
  softEdge?: number;
  /** The limb by viewing angle: how dark it gets (0..1) and the curve's power, the contrast left there (0..1), the
   * colour it deepens toward and how far, and a fake bump normal's strength */
  limbDarkening?: number;
  limbPower?: number;
  limbContrast?: number;
  limbTint?: string;
  limbTintStrength?: number;
  bump?: number;
  /** The edge: the chromosphere's strength, colour and width (radii), the scattered halo, spicule height (radii) */
  rim?: number;
  rimColor?: string;
  rimWidth?: number;
  halo?: number;
  spicules?: number;
  /** How fast the pattern evolves in place, and the warp's own evolution and wander */
  evolve?: number;
  /** x how fast the surface's own pattern moves (its boil and its evolution, both above): 1.5 by default (Kieran,
   * 2026-11-03: half again livelier); the star's turning keeps its own speed */
  animate?: number;
  warpEvolve?: number;
  warpWander?: number;
  /** Fine detail, seen as the star grows on screen (all 0, and fineContrast 1: R5 exactly): threads (thin bright
   * filaments a scale finer than the plasma's, 0..), how far they push the fine octaves along (0..), granulation (dark
   * lanes between small cells, 0..), the fine octaves' contrast (1: R5's), and how much earlier they come in (octaves) */
  threads?: number;
  threadFlow?: number;
  granulation?: number;
  fineContrast?: number;
  fineOnset?: number;
  /** Multicolour swirls: a rainbow, or tints (two or three colours) carried round by the flow */
  iridescence?: { mode: 'rainbow' | 'tints'; colors?: string[]; strength?: number; drift?: number; spread?: number };
}

/** What a star's look is made from: a system's centralBody (systems.json) */
export interface StarBody {
  radius?: number;
  hue?: number;
  sunStyle?: string;
  detailStar?: boolean;
  detailParams?: Record<string, number>;
  detailColors?: Record<string, string>;
  plasma?: PlasmaParams;
}

type Rgb = [number, number, number];
const hex = (h: string): Rgb => { const v = parseInt(h.replace('#', ''), 16); return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]; };
function hsl(h: number, s: number, l: number): Rgb {
  h = (((h % 360) + 360) % 360) / 360;
  const f = (n: number) => { const k = (n + h * 12) % 12; return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0), f(8), f(4)];
}
const lift = (c: Rgb, k: number): Rgb => c.map((v) => v + (1 - v) * k) as Rgb;
const luma = (c: Rgb) => 0.3 * c[0] + 0.55 * c[1] + 0.15 * c[2];

/** A star's radius in world units (a detail star's own, else the body's) */
export const starRadius = (cb: StarBody): number => cb.detailParams?.radius ?? cb.radius ?? 1000;

/** uDetail for a star this many CSS px in radius on screen: a fine octave from 1,500 px, another each 4x bigger, up to 3 */
export function plasmaDetail(pxPerRadius: number, onset = 0): number {
  return Math.max(0, Math.min(3, Math.log2(pxPerRadius / 1500) / 2 + 0.5 + onset));
}

export interface StarLook {
  /** The quad's half-size, in star radii */
  reach: number;
  /** How far in from the edge the disc fades (radii): inside 1 − 1.85 × this the disc is opaque */
  softEdge: number;
  /** The fine octaves' onset shift (plasmaDetail) */
  fineOnset: number;
  /** The shader's uniforms that don't change with time or zoom (uTime, uDetail and uPxR are set each frame) */
  uniforms: Record<string, number | number[]>;
}

/**
 * A star's look: its palette from its detail colours or its hue, its surface from its style (flow stars warp hardest,
 * granular ones are finer and contrastier), its brightness from how hot its palette is (a red giant's dark reds stay
 * dark), its motion and corona seeded by its id, and anything its `plasma` settings say.
 */
export function starLook(id: string, cb: StarBody): StarLook {
  const rnd = mulberry32(hashString(`plasma:${id}`));
  const hue = cb.detailParams?.hue ?? cb.hue ?? 40;
  const dc = cb.detailColors;
  const o = cb.plasma ?? {};
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
  const heat = o.heat ?? (dc ? Math.max(0.5, Math.min(0.9, 0.2 + luma(palette.mid) * 1.6)) : 0.95);
  const ir = o.iridescence;
  const tints = (ir?.colors ?? ['#ff5fa2', '#5fd0ff', '#b6ff6a']).map(hex);
  const reach = 3.0;
  const softEdge = o.softEdge ?? soft;
  const anim = o.animate ?? 1.5;
  return {
    reach,
    softEdge,
    fineOnset: o.fineOnset ?? 0,
    uniforms: {
      uReach: reach, uSeed: [rnd() * 10, rnd() * 10, rnd() * 10],
      uDark: palette.dark, uMid: palette.mid, uBright: palette.bright, uCore: palette.core, uHot: palette.hot, uRim: palette.rim, uCorona: palette.corona,
      uSurf: [o.scale ?? scale, o.warp ?? warp, o.contrast ?? contrast, o.core ?? core],
      uMotion: [0.004 + rnd() * 0.003, 0.5 + rnd() * 0.4, (0.004 + rnd() * 0.003) * anim, 0.012 + rnd() * 0.008],
      uCor: [0.85 + rnd() * 0.3, 9 + Math.round(rnd() * 6), 0.7 + rnd() * 0.4, 10],
      uLimb: [softEdge, heat],
      uIrid: ir ? [ir.strength ?? 0.85, ir.mode === 'rainbow' ? 1 : 0, ir.drift ?? 0.01, ir.spread ?? (ir.mode === 'rainbow' ? 1.6 : 1.2)] : [0, 0, 0, 1],
      uTintA: tints[0], uTintB: tints[1] ?? tints[0], uTintC: tints[2] ?? tints[1] ?? tints[0],
      uLimbD: [o.limbDarkening ?? 0.5, o.limbPower ?? 0.6, o.limbContrast ?? 0.45, o.bump ?? 0.5],
      uLimbTint: [...(o.limbTint ? hex(o.limbTint) : palette.dark.map((c) => c * 1.6)), o.limbTintStrength ?? 0.45],
      uChromo: [o.rim ?? 0.6, o.rimWidth ?? 0.008, o.halo ?? 0.4, o.spicules ?? 0.035],
      uChromoCol: o.rimColor ? hex(o.rimColor) : lift(palette.rim, 0.1),
      uEvolve: [(o.evolve ?? 0.012) * anim, (o.warpEvolve ?? 0.006) * anim, o.warpWander ?? 0.15],
      uFine: [o.threads ?? 0, o.granulation ?? 0, o.fineContrast ?? 1, o.threadFlow ?? 0],
    },
  };
}

/** The radius (share of the star's) inside which its disc is opaque: nothing behind it shows (the sky skips it) */
export const opaqueShare = (look: StarLook): number => Math.min(0.95, 1 - 1.85 * look.softEdge);
