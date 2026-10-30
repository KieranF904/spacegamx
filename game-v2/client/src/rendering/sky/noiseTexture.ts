/**
 * The sky's noise: one 256 × 256 texture that tiles seamlessly, built once on
 * the CPU. Four channels of different noise, so the sky shaders take their
 * clouds, dust and filaments from a few texture reads instead of computing
 * noise per pixel:
 *   r  broad fBM (periods 4 to 64 across the tile): cloud shapes, band warp
 *   g  fBM from a different seed (8 to 64): a second cloud field, colour mixing
 *   b  ridged fBM (4 to 32): sharp ridges, for dust lanes and filaments
 *   a  fine fBM (16 to 128): grain, clumps of unresolved stars
 */

import { BufferImageSource, Texture } from 'pixi.js';
import { mulberry32 } from '@space-game/common';

const SIZE = 256;
let cached: Texture | null = null;

/** Value noise whose lattice repeats every `period` cells across the tile */
function lattice(period: number, rnd: () => number): (x: number, y: number) => number {
  const v = new Float32Array(period * period);
  for (let i = 0; i < v.length; i++) v[i] = rnd();
  const scale = period / SIZE;
  return (x, y) => {
    const fx = x * scale, fy = y * scale;
    const ix = Math.floor(fx), iy = Math.floor(fy);
    let tx = fx - ix, ty = fy - iy;
    // Quintic fade: no creases along the lattice lines
    tx = tx * tx * tx * (tx * (tx * 6 - 15) + 10);
    ty = ty * ty * ty * (ty * (ty * 6 - 15) + 10);
    const x0 = ix % period, y0 = iy % period, x1 = (ix + 1) % period, y1 = (iy + 1) % period;
    const a = v[y0 * period + x0], b = v[y0 * period + x1], c = v[y1 * period + x0], d = v[y1 * period + x1];
    return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
  };
}

/** Octaves of tiling value noise from `first` cells across, doubling each time */
function fbm(first: number, octaves: number, seed: number, ridged = false): Float32Array {
  const rnd = mulberry32(seed);
  const layers = Array.from({ length: octaves }, (_, i) => lattice(first << i, rnd));
  const out = new Float32Array(SIZE * SIZE);
  let lo = Infinity, hi = -Infinity;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let sum = 0, amp = 1;
      for (const n of layers) {
        const v = n(x, y);
        sum += (ridged ? (1 - Math.abs(2 * v - 1)) ** 2 : v) * amp;
        amp *= 0.5;
      }
      out[y * SIZE + x] = sum;
      if (sum < lo) lo = sum;
      if (sum > hi) hi = sum;
    }
  }
  // Stretch to fill 0..1
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - lo) / (hi - lo);
  return out;
}

export function skyNoiseTexture(): Texture {
  if (cached) return cached;
  const channels = [fbm(4, 5, 1013), fbm(8, 4, 2027), fbm(4, 4, 3041, true), fbm(16, 4, 4057)];
  const data = new Uint8Array(SIZE * SIZE * 4);
  for (let i = 0; i < SIZE * SIZE; i++) {
    for (let c = 0; c < 4; c++) data[i * 4 + c] = Math.round(channels[c][i] * 255);
  }
  cached = new Texture({
    source: new BufferImageSource({
      resource: data, width: SIZE, height: SIZE,
      // Data, not colour: alpha is its own channel, never multiplied in
      alphaMode: 'no-premultiply-alpha',
      addressMode: 'repeat', scaleMode: 'linear', autoGenerateMipmaps: true,
    }),
  });
  return cached;
}
