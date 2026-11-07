import { describe, it, expect } from 'vitest';
import { LiquidFx, LIQUID_CAP, type LiquidSink } from './liquidSplash';
import { ImpactAnchor } from './impactAnchor';
import type { LiquidLayer } from './weaponStyles';

const L: LiquidLayer = {
  blobs: { count: 4, size: 3, speed: 4, cone: 40, pull: 0.25, life: 60 },
  film: { length: 60, thickness: 4, creep: 0.3, life: 90 }, hot: 0xffd27a, cool: 0x5a1606,
};
/** A sink that records the lines drawn this frame */
function sink(): LiquidSink & { lines: number[][] } {
  const lines: number[][] = [];
  return { lines, line: (x0, y0, x1, y1) => { lines.push([x0, y0, x1, y1]); }, dot: () => {}, disc: () => {} };
}

describe('liquid splash', () => {
  it('throws blobs off the surface that fall back and stick as smears, under a film along the surface', () => {
    const fx = new LiquidFx(), s = sink();
    // A surface facing up (-y), the beam coming down and sliding right
    fx.spawn(L, 0, 0, { nx: 0, ny: -1, dx: 0.6, dy: 0.8 }, 1);
    const n0 = fx.n;
    expect(n0).toBe(2 + 4);
    let rose = false;
    for (let f = 0; f < 40; f++) {
      s.lines.length = 0;
      fx.update(1, s);
      // (nothing goes into the surface: every line stays on or above y = a thickness below it)
      for (const l of s.lines) { expect(l[1]).toBeLessThan(6); expect(l[3]).toBeLessThan(6); if (l[1] < -8) rose = true; }
    }
    expect(rose).toBe(true);
    // The blobs have landed by now, each a smear in their place: still as many pieces, none of them rising
    expect(fx.n).toBe(n0);
    // The main film creeps the way the beam slid (right, +x): its front well past where it started
    s.lines.length = 0;
    fx.update(1, s);
    expect(Math.max(...s.lines.map((l) => l[2]))).toBeGreaterThan(20);
  });

  it('a blob that lands further along the surface than the film reaches fell off the edge: no smear', () => {
    const fx = new LiquidFx(), s = sink();
    fx.spawn({ ...L, film: { ...L.film, length: 0.5 } }, 0, 0, { nx: 0, ny: -1, dx: 0.6, dy: 0.8 }, 1);
    for (let f = 0; f < 40; f++) fx.update(1, s);
    // (only the two films are left)
    expect(fx.n).toBe(2);
  });

  it('rides what it hit and is capped', () => {
    const fx = new LiquidFx(), s = sink();
    fx.spawn(L, 100, 0, { nx: 0, ny: -1, dx: 0, dy: 1 }, 1);
    const a = new ImpactAnchor(7, { x: 0, y: 0, angle: 0 }, 100, 0);
    fx.bind(0, a);
    expect(a.left).toBeGreaterThan(L.film.life);
    // The target moves 50 to the right: the film goes with it
    a.step({ x: 50, y: 0, angle: 0 }, 1);
    fx.update(1, s);
    const xs = s.lines.map((l) => (l[0] + l[2]) / 2);
    expect(Math.min(...xs)).toBeGreaterThan(120);
    for (let i = 0; i < LIQUID_CAP; i++) fx.spawn(L, 0, 0, { nx: 0, ny: -1, dx: 0, dy: 1 }, 1);
    expect(fx.n).toBe(LIQUID_CAP);
  });
});
