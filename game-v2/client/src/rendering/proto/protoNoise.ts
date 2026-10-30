/**
 * PROTOTYPE (not used by the game yet; see docs/rendering/sun-sky-prototypes.md).
 *
 * The sun prototypes' noise: one 512 × 512 RGBA texture that tiles seamlessly, built once on the CPU
 * (about 60 ms), so the shaders read noise instead of computing it (a simplex call is ~45 ALU ops;
 * a texture read is one instruction, filtered and mipmapped for free):
 *   r  granules: cellular (Worley F2 − F1) cells, bright and domed, with dark lanes between (32 per tile)
 *   g  the same from another seed: the shader cross-fades r and g so granules come and go ("boil")
 *   b  one octave of smooth gradient noise (32 lattice cells per tile, 16 texels a cell), shaped like
 *      simplex noise: −1..1 stored as 0..1. `tnoise` in sunProto.ts reads it in place of `snoise`
 *   a  fBM (periods 4 to 64 per tile): broad cloud, warp and spot fields
 *
 * Pure data (no Pixi), so the native harness and the game make the same bytes.
 */

import { mulberry32 } from '@space-game/common';

export const SUN_NOISE_SIZE = 512;
/** Lattice cells per tile of the `b` channel (texels per cell = SIZE / this) */
export const SUN_NOISE_PERIOD = 32;
/** Granules per tile of the `r` and `g` channels */
export const SUN_GRANULES = 32;

const SIZE = SUN_NOISE_SIZE;

/** Perlin gradient noise whose lattice repeats every `period` cells across the tile; about −0.7..0.7 */
function gradient(period: number, rnd: () => number): (x: number, y: number) => number {
  const gx = new Float32Array(period * period), gy = new Float32Array(period * period);
  for (let i = 0; i < gx.length; i++) {
    const a = rnd() * Math.PI * 2;
    gx[i] = Math.cos(a); gy[i] = Math.sin(a);
  }
  const scale = period / SIZE;
  const dot = (cx: number, cy: number, dx: number, dy: number) => {
    const i = (cy % period) * period + (cx % period);
    return gx[i] * dx + gy[i] * dy;
  };
  return (x, y) => {
    const fx = x * scale, fy = y * scale;
    const ix = Math.floor(fx), iy = Math.floor(fy);
    const tx = fx - ix, ty = fy - iy;
    const u = tx * tx * tx * (tx * (tx * 6 - 15) + 10), v = ty * ty * ty * (ty * (ty * 6 - 15) + 10);
    const a = dot(ix, iy, tx, ty), b = dot(ix + 1, iy, tx - 1, ty);
    const c = dot(ix, iy + 1, tx, ty - 1), d = dot(ix + 1, iy + 1, tx - 1, ty - 1);
    return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
  };
}

/** Octaves of tiling gradient noise from `first` cells across, doubling each time, stretched to 0..1 */
function fbm(first: number, octaves: number, seed: number): Float32Array {
  const rnd = mulberry32(seed);
  const layers = Array.from({ length: octaves }, (_, i) => gradient(first << i, rnd));
  const out = new Float32Array(SIZE * SIZE);
  let lo = Infinity, hi = -Infinity;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let sum = 0, amp = 1;
      for (const n of layers) { sum += n(x + 0.5, y + 0.5) * amp; amp *= 0.5; }
      out[y * SIZE + x] = sum;
      if (sum < lo) lo = sum;
      if (sum > hi) hi = sum;
    }
  }
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - lo) / (hi - lo);
  return out;
}

/**
 * One octave scaled to simplex noise's spread (its standard deviation is 0.47 (measured); Perlin's about
 * 0.2), so a shader that sums octaves of it gets the contrast it got from `snoise`. Stored as 0..1.
 */
function simplexLike(seed: number): Float32Array {
  const n = gradient(SUN_NOISE_PERIOD, mulberry32(seed));
  const out = new Float32Array(SIZE * SIZE);
  let sq = 0;
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) { const v = n(x + 0.5, y + 0.5); out[y * SIZE + x] = v; sq += v * v; }
  const k = 0.47 / Math.sqrt(sq / out.length);
  for (let i = 0; i < out.length; i++) out[i] = Math.max(0, Math.min(1, out[i] * k * 0.5 + 0.5));
  return out;
}

/**
 * Granulation: Worley cells on a jittered grid that wraps. F2 − F1 is the distance to the nearest
 * wall, so a cell is bright and domed in the middle, with a thin dark lane where it meets the next;
 * each cell gets its own brightness, as granules do.
 */
function granules(cells: number, seed: number): Float32Array {
  const rnd = mulberry32(seed);
  const px = new Float32Array(cells * cells), py = new Float32Array(cells * cells), lum = new Float32Array(cells * cells);
  for (let i = 0; i < px.length; i++) { px[i] = 0.12 + 0.76 * rnd(); py[i] = 0.12 + 0.76 * rnd(); lum[i] = rnd(); }
  const out = new Float32Array(SIZE * SIZE);
  const s = cells / SIZE;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const fx = (x + 0.5) * s, fy = (y + 0.5) * s;
      const cx = Math.floor(fx), cy = Math.floor(fy);
      let f1 = 9, f2 = 9, own = 0;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const gx = cx + ox, gy = cy + oy;
          const i = (((gy % cells) + cells) % cells) * cells + (((gx % cells) + cells) % cells);
          const dx = gx + px[i] - fx, dy = gy + py[i] - fy;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < f1) { f2 = f1; f1 = d; own = i; } else if (d < f2) f2 = d;
        }
      }
      const wall = Math.min(1, (f2 - f1) / 0.42);
      // Domed: brightest in the middle, falling to a thin lane at the wall
      const dome = Math.sqrt(wall) * (1 - 0.35 * Math.min(1, f1 * f1 * 2));
      out[y * SIZE + x] = dome * (0.62 + 0.38 * lum[own]);
    }
  }
  return out;
}

let cached: Uint8Array | null = null;

/** The texture's RGBA bytes, SUN_NOISE_SIZE² (made once) */
export function sunNoiseData(): Uint8Array {
  if (cached) return cached;
  const channels = [granules(SUN_GRANULES, 7001), granules(SUN_GRANULES, 7919), simplexLike(8111), fbm(4, 5, 9013)];
  const data = new Uint8Array(SIZE * SIZE * 4);
  for (let i = 0; i < SIZE * SIZE; i++) {
    for (let c = 0; c < 4; c++) data[i * 4 + c] = Math.round(channels[c][i] * 255);
  }
  return cached = data;
}

/**
 * The game's own 2D simplex noise (the `snoise` in SunRenderer, CoronaRaysRenderer: the same function, ported), baked
 * into a float texture: `size` texels across `units` lattice units centred on 0, value −1..1 at each texel's centre. It doesn't tile,
 * so it's read with mirrored repeat (continuous everywhere; the mirror lines hide in the octaves). The stand-in
 * `snoise` then returns the procedural one's own values, bilinearly filtered: "A-exact" in sunProto.ts.
 */
export function bakeSimplex(size: number, units: number): Float32Array {
  const C0 = 0.211324865405187, C1 = 0.366025403784439, C2 = -0.577350269189626, C3 = 0.024390243902439;
  const mod289 = (x: number) => x - Math.floor(x / 289) * 289;
  const permute = (x: number) => mod289((x * 34 + 1) * x);
  const fract = (x: number) => x - Math.floor(x);
  const out = new Float32Array(size * size);
  // (centred on 0: the sun's coordinates run both ways from its middle)
  const step = units / size, o = units / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const vx = (x + 0.5) * step - o, vy = (y + 0.5) * step - o;
      const s = (vx + vy) * C1;
      let ix = Math.floor(vx + s), iy = Math.floor(vy + s);
      const t = (ix + iy) * C0;
      const x0 = vx - ix + t, y0 = vy - iy + t;
      const i1x = x0 > y0 ? 1 : 0, i1y = x0 > y0 ? 0 : 1;
      const x1 = x0 + C0 - i1x, y1 = y0 + C0 - i1y, x2 = x0 + C2, y2 = y0 + C2;
      ix = mod289(ix); iy = mod289(iy);
      const p0 = permute(permute(iy) + ix), p1 = permute(permute(iy + i1y) + ix + i1x), p2 = permute(permute(iy + 1) + ix + 1);
      let sum = 0;
      for (const [p, dx, dy] of [[p0, x0, y0], [p1, x1, y1], [p2, x2, y2]]) {
        let m = Math.max(0.5 - (dx * dx + dy * dy), 0);
        m = m * m; m = m * m;
        const gx = 2 * fract(p * C3) - 1, h = Math.abs(gx) - 0.5, a0 = gx - Math.floor(gx + 0.5);
        m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
        sum += m * (a0 * dx + h * dy);
      }
      out[y * size + x] = 130 * sum;
    }
  }
  return out;
}

export const NOISE3_SIZE = 64;

/** 3D Perlin noise whose lattice repeats every `period` cells across the volume; about −0.8..0.8 */
function gradient3(period: number, rnd: () => number): (x: number, y: number, z: number) => number {
  const n = period * period * period;
  const g = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    // A random direction on the sphere
    const u = rnd() * 2 - 1, a = rnd() * Math.PI * 2, s = Math.sqrt(1 - u * u);
    g[i * 3] = s * Math.cos(a); g[i * 3 + 1] = s * Math.sin(a); g[i * 3 + 2] = u;
  }
  const scale = period / NOISE3_SIZE;
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const dot = (cx: number, cy: number, cz: number, dx: number, dy: number, dz: number) => {
    const i = (((cz % period) * period + (cy % period)) * period + (cx % period)) * 3;
    return g[i] * dx + g[i + 1] * dy + g[i + 2] * dz;
  };
  return (x, y, z) => {
    const fx = x * scale, fy = y * scale, fz = z * scale;
    const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
    const tx = fx - ix, ty = fy - iy, tz = fz - iz;
    const u = fade(tx), v = fade(ty), w = fade(tz);
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    const c00 = lerp(dot(ix, iy, iz, tx, ty, tz), dot(ix + 1, iy, iz, tx - 1, ty, tz), u);
    const c10 = lerp(dot(ix, iy + 1, iz, tx, ty - 1, tz), dot(ix + 1, iy + 1, iz, tx - 1, ty - 1, tz), u);
    const c01 = lerp(dot(ix, iy, iz + 1, tx, ty, tz - 1), dot(ix + 1, iy, iz + 1, tx - 1, ty, tz - 1), u);
    const c11 = lerp(dot(ix, iy + 1, iz + 1, tx, ty - 1, tz - 1), dot(ix + 1, iy + 1, iz + 1, tx - 1, ty - 1, tz - 1), u);
    return lerp(lerp(c00, c10, v), lerp(c01, c11, v), w);
  };
}

let cached3: Uint8Array | null = null;

/**
 * The plasma star's noise (sunProto.ts, PLASMA_FRAG): a 64³ RGBA volume that tiles on every axis, read at points on
 * the star's sphere (so features sit on the ball and turn with it, with no seam or pole) and, for the corona, along
 * rings that scroll outward through the third axis:
 *   r  fBM, periods 2, 4, 8 across the volume (pre-summed: three octaves in one read)
 *   g  the same from another seed (the warp's second axis, active regions)
 *   b  ridged fBM, periods 2, 4, 8: thin bright ridges (filaments, rays)
 *   a  one octave, period 8: fine detail
 */
export function noise3Data(): Uint8Array {
  if (cached3) return cached3;
  const S = NOISE3_SIZE, n = S * S * S;
  const rnd = (seed: number) => {
    const r = mulberry32(seed);
    return [gradient3(2, r), gradient3(4, r), gradient3(8, r)];
  };
  const A = rnd(11), B = rnd(23), Cr = rnd(37), D = gradient3(8, mulberry32(41));
  const ch = [new Float32Array(n), new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let z = 0, i = 0; z < S; z++) {
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++, i++) {
        const X = x + 0.5, Y = y + 0.5, Z = z + 0.5;
        ch[0][i] = A[0](X, Y, Z) + A[1](X, Y, Z) * 0.5 + A[2](X, Y, Z) * 0.25;
        ch[1][i] = B[0](X, Y, Z) + B[1](X, Y, Z) * 0.5 + B[2](X, Y, Z) * 0.25;
        let r = 0, amp = 1;
        for (const o of Cr) { const v = 1 - Math.abs(o(X, Y, Z) * 1.6); r += v * v * amp; amp *= 0.5; }
        ch[2][i] = r;
        ch[3][i] = D(X, Y, Z);
      }
    }
  }
  const data = new Uint8Array(n * 4);
  for (let c = 0; c < 4; c++) {
    let lo = Infinity, hi = -Infinity;
    for (const v of ch[c]) { if (v < lo) lo = v; if (v > hi) hi = v; }
    for (let i = 0; i < n; i++) data[i * 4 + c] = Math.round(((ch[c][i] - lo) / (hi - lo)) * 255);
  }
  return cached3 = data;
}
