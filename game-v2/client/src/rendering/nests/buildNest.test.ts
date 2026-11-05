import { describe, expect, it } from 'vitest';
import type { NestData } from '@space-game/common';
import systemsData from '../../../../data/systems.json';
import { buildNest } from './buildNest';

const all: NestData[] = [];
const walk = (o: unknown): void => {
  if (!o || typeof o !== 'object') return;
  const r = o as Record<string, unknown>;
  if (Array.isArray(r.nests)) all.push(...(r.nests as NestData[]));
  for (const v of Object.values(r)) walk(v);
};
walk(systemsData);
const KINDS = ['den', 'scrap', 'knot', 'dock', 'roost', 'dig', 'shrine', 'sift'];

describe('lit nests', () => {
  it('builds every nest in the data, each with consistent attributes and at most one light', () => {
    expect(all.length).toBeGreaterThan(0);
    for (const n of all) {
      const b = buildNest(n, 0xff5a4a), g = b.geo, v = g.vertexCount;
      expect(v, n.id).toBeGreaterThan(0);
      expect(g.surf.length, n.id).toBe(v * 4);
      expect(g.smo.length, n.id).toBe(v * 3);
      expect(g.mat.length, n.id).toBe(v * 4);
      expect(g.orb.length, n.id).toBe(v * 4);
      expect(g.idx.every((i) => i < v), n.id).toBe(true);
      expect(g.pos.every(Number.isFinite) && g.surf.every(Number.isFinite) && g.orb.every(Number.isFinite), n.id).toBe(true);
      // One draw's worth: well under what a chunk of rocks costs
      expect(g.idx.length / 3, n.id).toBeLessThan(6000);
    }
  });

  it('covers every kind, with the knot swirling and fine pieces that can drop out far off', () => {
    for (const k of KINDS) {
      const n = all.find((x) => x.kind === k);
      expect(n, k).toBeDefined();
      const b = buildNest(n!, 0xff5a4a);
      expect(b.light, k).not.toBeNull();
      const swirl = b.geo.orb.some((x, i) => i % 4 === 2 && x !== 0);
      expect(swirl, k).toBe(k === 'knot');
    }
    for (const k of ['scrap', 'knot', 'dig', 'den']) {
      const b = buildNest(all.find((x) => x.kind === k)!, 0xff5a4a);
      expect(b.geo.mat.some((x, i) => i % 4 === 3 && x === -2), k).toBe(true);
    }
  });

  it('lays a nest out the same every time', () => {
    const n = all.find((x) => x.kind === 'scrap')!;
    expect(buildNest(n, 1).geo.pos).toEqual(buildNest(n, 1).geo.pos);
  });
});
