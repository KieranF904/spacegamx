/**
 * The star's noise volume (sun/plasmaSun.ts): built once (about 0.1 s), in the procedural worker, and kept by the asset
 * cache (`plasmaNoise`, PLASMA_NOISE_VERSION). Pure data (no Pixi), so the native harness and the lab make the same bytes
 * (proto/protoNoise.ts re-exports it).
 */

import { mulberry32 } from '@space-game/common';

export const NOISE3_SIZE = 64;
/** What noise3Data makes, by version (assetCache.ts): bump it whenever its output changes */
export const PLASMA_NOISE_VERSION = 1;

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

/**
 * The plasma star's noise (plasmaSun.ts): a 64³ RGBA volume that tiles on every axis, read at points on
 * the star's sphere (so features sit on the ball and turn with it, with no seam or pole) and, for the corona, along
 * rings that scroll outward through the third axis:
 *   r  fBM, periods 2, 4, 8 across the volume (pre-summed: three octaves in one read)
 *   g  the same from another seed (the warp's second axis, active regions)
 *   b  ridged fBM, periods 2, 4, 8: thin bright ridges (filaments, rays)
 *   a  one octave, period 8: fine detail
 */
export function noise3Data(): Uint8Array {
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
  return data;
}
