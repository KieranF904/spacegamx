import { describe, it, expect } from 'vitest';
import { dsin, dcos, dsincos, datan2, dhypot, dexp, dlog, dlog2, dpow, dsinh, dcosh, dtanh, dasinh, dlog1p } from './detTrig.js';

// (Distance in ulps between two doubles: how close to Math's each is)
const F = new Float64Array(2), B = new BigInt64Array(F.buffer);
function ulps(a: number, b: number): number {
  if (Object.is(a, b)) return 0;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Infinity;
  F[0] = a; F[1] = b;
  const d = B[0] - B[1];
  return Number(d < 0n ? -d : d);
}

function seeded(seed: number) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

function worst(n: number, gen: () => number[], ours: (...a: number[]) => number, ref: (...a: number[]) => number): number {
  let max = 0;
  for (let i = 0; i < n; i++) { const a = gen(); max = Math.max(max, ulps(ours(...a), ref(...a))); }
  return max;
}

describe('detTrig: exp, log, log2, pow', () => {
  const r = seeded(7);

  it('exp and log are within an ulp of Math (fdlibm, as V8 has them)', () => {
    expect(worst(50000, () => [r() * 1400 - 700], dexp, Math.exp)).toBeLessThanOrEqual(1);
    expect(worst(50000, () => [r() * 40 - 20], dexp, Math.exp)).toBeLessThanOrEqual(1);
    expect(worst(50000, () => [Math.exp(r() * 1380 - 690)], dlog, Math.log)).toBeLessThanOrEqual(1);
    expect(worst(50000, () => [1 + (r() - 0.5) * 1e-3], dlog, Math.log)).toBeLessThanOrEqual(1);
  });

  it('log2 is within an ulp or two, and exact for powers of two', () => {
    expect(worst(50000, () => [r() * 100], dlog2, Math.log2)).toBeLessThanOrEqual(2);
    for (let k = -1074; k <= 1023; k += 7) expect(dlog2(2 ** k)).toBe(k);
  });

  it('pow is within an ulp or two of Math.pow for the game\'s exponents, exact for whole powers that are', () => {
    expect(worst(50000, () => [r() * 10, r() * 6 - 3], dpow, Math.pow)).toBeLessThanOrEqual(2);
    expect(worst(50000, () => [r() * 3, [0.12, 0.75, 1.6, 6, 1.15, 1 / 1.15, -0.6, -0.7][Math.floor(r() * 8)]], dpow, Math.pow)).toBeLessThanOrEqual(2);
    expect(worst(50000, () => [r() * 1000, r() * 20 - 10], dpow, Math.pow)).toBeLessThanOrEqual(2);
    for (let k = 0; k <= 22; k++) { expect(dpow(10, k)).toBe(Number(`1e${k}`)); expect(dpow(10, -k)).toBe(Number(`1e-${k}`)); }
    for (let k = -1074; k <= 1023; k += 13) expect(dpow(2, k)).toBe(2 ** k);
  });

  it('special cases are Math.pow\'s, Math.exp\'s and Math.log\'s', () => {
    const pairs: [number, number][] = [[0, 0.5], [-0, 3], [-0, -3], [-0, 2], [0, -1], [Infinity, 0.5], [Infinity, -2], [-Infinity, 3], [-Infinity, 2],
      [-Infinity, -3], [-8, 1 / 3], [-2, 3], [-2, 64], [-2, 65], [2, Infinity], [0.5, Infinity], [2, -Infinity], [1, Infinity], [NaN, 0], [1, NaN],
      [NaN, 1], [2, 1024], [2, -1075], [1e-310, 0.5], [7, 0.5], [1.0000001, 1e300], [0.5, 1e25]];
    for (const [x, y] of pairs) expect([x, y, dpow(x, y)]).toEqual([x, y, Math.pow(x, y)]);
    for (const x of [0, -0, -1, Infinity, -Infinity, NaN, 1, 2, 1e-310, 5e-324]) {
      expect(Object.is(dlog(x), Math.log(x))).toBe(true);
      expect(Object.is(dlog2(x), Math.log2(x))).toBe(true);
    }
    for (const x of [0, -0, Infinity, -Infinity, NaN, 709.78, 709.79, -745.1, -745.2, 1e-20, -1e-20]) expect(Object.is(dexp(x), Math.exp(x))).toBe(true);
  });

  it('pins its bits: a change to any function here moves this (and every engine must give the same: npm run det:engines)', () => {
    const g = seeded(11);
    let h = 0x811c9dc5;
    const w = new Uint32Array(F.buffer, 0, 2);
    const mix = (v: number) => { F[0] = v; for (const x of [w[0], w[1]]) for (let i = 0; i < 4; i++) { h ^= (x >>> (i * 8)) & 0xff; h = Math.imul(h, 0x01000193); } };
    for (let i = 0; i < 2000; i++) {
      const a = (g() - 0.5) * 40, b = (g() - 0.5) * 40;
      mix(dsin(a)); mix(dcos(a)); mix(datan2(a, b)); mix(dhypot(a, b)); mix(dexp(a)); mix(dlog(Math.abs(a))); mix(dlog2(Math.abs(b))); mix(dpow(Math.abs(a), b * 0.1));
      const sc = dsincos(a);
      mix(sc[0] - dsin(a)); mix(sc[1] - dcos(a));
    }
    expect((h >>> 0).toString(16)).toBe('92dbde78');
  });

  it('sinh, cosh, tanh, asinh and log1p are within a few ulps of Math (asteroid orbits; tanh 4)', () => {
    const r2 = seeded(23);
    for (const span of [1, 8, 40]) {
      expect(worst(30000, () => [(r2() - 0.5) * span], dsinh, Math.sinh)).toBeLessThanOrEqual(3);
      expect(worst(30000, () => [(r2() - 0.5) * span], dcosh, Math.cosh)).toBeLessThanOrEqual(3);
      expect(worst(30000, () => [(r2() - 0.5) * span], dtanh, Math.tanh)).toBeLessThanOrEqual(4);
      expect(worst(30000, () => [(r2() - 0.5) * span * span], dasinh, Math.asinh)).toBeLessThanOrEqual(3);
    }
    expect(worst(30000, () => [(r2() - 0.5) * 1e-6], dlog1p, Math.log1p)).toBeLessThanOrEqual(2);
    expect(worst(30000, () => [r2() * 10 - 0.9], dlog1p, Math.log1p)).toBeLessThanOrEqual(2);
    for (const x of [0, -0, NaN, Infinity, -Infinity]) {
      expect(Object.is(dsinh(x), Math.sinh(x))).toBe(true);
      expect(Object.is(dtanh(x), Math.tanh(x))).toBe(true);
      expect(Object.is(dasinh(x), Math.asinh(x))).toBe(true);
    }
    expect(dcosh(0)).toBe(1);
  });
});
