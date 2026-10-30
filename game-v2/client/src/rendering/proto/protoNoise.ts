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
