import { describe, expect, it } from 'vitest';
import systems from '../../../data/systems.json';
import type { StructureData } from '@space-game/common';
import { RING_KIND, SOLAR_RING, solarRingAngle, solarRingGeometry } from './solarRingGeometry';

const helios = (systems as unknown as { systems: { structures?: StructureData[] }[] }).systems
  .flatMap((s) => s.structures ?? []).find((s) => s.kind === 'solar_ring')!;

describe('solarRingGeometry (the Helios Array)', () => {
  const g = solarRingGeometry(helios);
  const verts = g.positions.length / 2;

  it('is one modest mesh: every index in range, every value finite', () => {
    expect(verts).toBeGreaterThan(1000);
    // (cheap: one draw, well under what the old Graphics tessellated)
    expect(verts).toBeLessThan(60000);
    expect(g.uvs.length).toBe(verts * 2);
    expect(g.colors.length).toBe(verts * 3);
    expect(g.mats.length).toBe(verts * 4);
    expect(g.indices.length % 3).toBe(0);
    expect(Math.max(...g.indices)).toBeLessThan(verts);
    for (const a of [g.positions, g.uvs, g.colors, g.mats]) expect(a.every(Number.isFinite)).toBe(true);
  });

  it('stays within its band round the star (the culling bound in Scenery.ts)', () => {
    const R = helios.radius;
    let lo = Infinity, hi = 0;
    for (let i = 0; i < verts; i++) {
      const r = Math.hypot(g.positions[i * 2], g.positions[i * 2 + 1]);
      lo = Math.min(lo, r); hi = Math.max(hi, r);
    }
    expect(lo).toBeGreaterThan(R + SOLAR_RING.rimIn - 200);
    expect(hi).toBeLessThan(R * 1.08 + 1400);
  });

  it('lights its sun-facing side: bevelled members are brighter on their inner edge', () => {
    // The first band is the inner chord: vertices alternate inner edge, outer edge
    const inner = g.mats[1], outer = g.mats[4 + 1];
    expect(inner).toBeGreaterThan(0.8);
    expect(outer).toBeLessThan(0.3);
  });

  it('has its cells, lamps and Halden inlay, and builds the same every time', () => {
    const kinds = new Set<number>();
    for (let i = 0; i < verts; i++) kinds.add(g.mats[i * 4]);
    for (const k of Object.values(RING_KIND)) expect(kinds.has(k)).toBe(true);
    const again = solarRingGeometry(helios);
    expect(again.positions).toEqual(g.positions);
    expect(again.mats).toEqual(g.mats);
  });

  it('turns by the server clock', () => {
    expect(solarRingAngle(0)).toBe(0);
    expect(solarRingAngle(60)).toBeCloseTo(SOLAR_RING.spin);
    expect(solarRingAngle(60 * 3600 * 24)).toBeLessThan(Math.PI * 2);
  });
});
