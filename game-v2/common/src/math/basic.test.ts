import { describe, it, expect } from 'vitest';
import { clamp, lerp, smoothstep, wrapPi, cloneJson } from './basic.js';
import { wrapAngle } from '../ships/flight.js';
import { wrapPi as turretWrapPi } from '../ships/turret.js';

const PI = Math.PI, TAU = 2 * Math.PI;

/** The sim's old wrap (flight.ts, replication.ts, turret.ts, minebay.ts), with a step cap so the test can't hang */
function oldLoop(a: number): number {
  let n = 0;
  while (a > Math.PI) { a -= 2 * Math.PI; if (++n > 1e6) throw new Error('loop'); }
  while (a < -Math.PI) { a += 2 * Math.PI; if (++n > 1e6) throw new Error('loop'); }
  return a;
}

/** asteroid/orbit.ts's old wrap */
function oldModulo(angle: number): number {
  let a = angle % TAU;
  if (a > Math.PI) a -= TAU;
  if (a < -Math.PI) a += TAU;
  return a;
}

/** A seeded uniform in [-1, 1) */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return (s / 4294967296) * 2 - 1; };
}

/** x moved by k ulps */
function ulps(x: number, k: number): number {
  const f = new Float64Array([x]);
  const u = new BigInt64Array(f.buffer);
  u[0] += BigInt(k);
  return f[0];
}

function mismatches(ref: (a: number) => number, inputs: Iterable<number>): number[] {
  const bad: number[] = [];
  for (const a of inputs) if (!Object.is(wrapPi(a), ref(a))) bad.push(a);
  return bad;
}

function* sample(n: number, gen: () => number): Generator<number> { for (let i = 0; i < n; i++) yield gen(); }

describe('math/basic', () => {
  it('clamp and lerp', () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
    expect(clamp(2, 0, 3)).toBe(2);
    expect(lerp(10, 20, 0.25)).toBe(12.5);
  });
  it('smoothstep clamps and eases, either edge order', () => {
    expect(smoothstep(0, 1, -1)).toBe(0);
    expect(smoothstep(0, 1, 2)).toBe(1);
    expect(smoothstep(0, 1, 0.5)).toBe(0.5);
    expect(smoothstep(1, 0, 0.9)).toBeCloseTo(0.028, 12);
  });
  it('the sim wraps are this one', () => {
    expect(wrapAngle).toBe(wrapPi);
    expect(turretWrapPi).toBe(wrapPi);
  });
  it('wrapPi is bit-identical to the old sim loop on every angle the sim feeds it', () => {
    const r = rng(12345);
    // Steps on a wrapped angle, differences of two wrapped angles, float32 cursor angles, and up to ten turns out
    expect(mismatches(oldLoop, sample(200_000, () => r() * PI + r() * 0.5))).toEqual([]);
    expect(mismatches(oldLoop, sample(200_000, () => r() * PI - r() * PI))).toEqual([]);
    expect(mismatches(oldLoop, sample(100_000, () => Math.fround(r() * PI)))).toEqual([]);
    expect(mismatches(oldLoop, sample(300_000, () => r() * 64))).toEqual([]);
    for (let a = -50; a <= 50; a += 0.173) expect(Object.is(wrapPi(a), oldLoop(a))).toBe(true);
  });
  it('wrapPi matches the old loop to the ulp around the wrap points', () => {
    for (const c of [0, PI, -PI, TAU, -TAU, 3 * PI, -3 * PI, 4 * PI, -4 * PI, 20 * PI, -20 * PI]) {
      const near: number[] = [];
      for (let k = -2000; k <= 2000; k++) near.push(ulps(c, k));
      expect(mismatches(oldLoop, near)).toEqual([]);
    }
  });
  it('wrapPi matches the old orbit modulo wrap at any size (but for whole negative turns: +0, not -0)', () => {
    const r = rng(777);
    expect(mismatches(oldModulo, sample(200_000, () => r() * 64))).toEqual([]);
    expect(mismatches(oldModulo, sample(200_000, () => r() * 1e9))).toEqual([]);
    expect(Object.is(wrapPi(-TAU), 0)).toBe(true);
  });
  it('wrapPi always returns: Infinity and NaN give NaN; -0 and the ends are kept', () => {
    expect(wrapPi(Infinity)).toBeNaN();
    expect(wrapPi(-Infinity)).toBeNaN();
    expect(wrapPi(NaN)).toBeNaN();
    expect(wrapPi(1e300)).toBeGreaterThanOrEqual(-PI);
    expect(wrapPi(1e300)).toBeLessThanOrEqual(PI);
    expect(Object.is(wrapPi(-0), -0)).toBe(true);
    expect(wrapPi(PI)).toBe(PI);
    expect(wrapPi(-PI)).toBe(-PI);
  });
  it('cloneJson is deep', () => {
    const o = { a: [1, { b: 2 }] };
    const c = cloneJson(o);
    expect(c).toEqual(o);
    expect(c.a).not.toBe(o.a);
  });
});
