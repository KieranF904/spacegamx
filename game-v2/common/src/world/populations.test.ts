import { describe, it, expect } from 'vitest';
import { spawnersOf, seedGroups, ghostCentre, slotStyle, packPopSlot, unpackPopSlot, feedMidRadius, GHOST_STEP, FEED_TIERS } from './populations.js';
import type { StarSystemData } from '../data/schemas.js';
import factions from '../../../data/factions.json';
import systems from '../../../data/systems.json';

const sol = (systems as unknown as { systems: StarSystemData[] }).systems.find((s) => s.id === 'sol')!;
const spawns = (factions as unknown as { spawns: Record<string, Parameters<typeof spawnersOf>[0]> }).spawns;

describe('hostile populations (shared rules)', () => {
  it("lists a system's nests (with a place and packs) in data order, each with its band", () => {
    const list = spawnersOf(spawns.sol, sol);
    expect(list.map((s) => s.def.id)).toEqual(spawns.sol!.nests!.filter((n) => n.packs > 0 && sol.nests?.some((q) => q.id === n.id)).map((n) => n.id));
    list.forEach((s, i) => { expect(s.index).toBe(i); expect(s.band!.max).toBeGreaterThan(s.band!.min); });
  });

  it("seeds each slot's group the same every time, keeping to the groups' limits", () => {
    for (const sp of spawnersOf(spawns.sol, sol)) {
      const g = seedGroups('sol', sp);
      expect(seedGroups('sol', sp)).toEqual(g);
      expect(g.length).toBe(sp.def.packs);
      sp.def.groups.forEach((grp, i) => { if (grp.limit !== undefined) expect(g.filter((q) => q === i).length).toBeLessThanOrEqual(grp.limit); });
    }
  });

  it('a ghost moves only every GHOST_STEP ticks, keeps to its band, and nomads keep out of the safe space', () => {
    for (const sp of spawnersOf(spawns.sol, sol)) {
      sp.def.groups.forEach((_, gi) => {
        const style = slotStyle(sp, gi);
        const a = ghostCentre(sol, 'sol', sp, 0, style, GHOST_STEP * 7), b = ghostCentre(sol, 'sol', sp, 0, style, GHOST_STEP * 7 + GHOST_STEP - 1);
        expect(b).toEqual(a);
        for (let t = 0; t < 60 * 60 * 30; t += 60 * 97) {
          const c = ghostCentre(sol, 'sol', sp, 1, style, t), r = Math.hypot(c.x, c.y);
          expect(r).toBeGreaterThanOrEqual(sp.band!.min - 1);
          expect(r).toBeLessThanOrEqual(sp.band!.max + 1);
          if (style === 'nomad') expect(r).toBeGreaterThan(sol.regions![0].outer);
        }
      });
    }
  });

  it('a slot on the wire: group, loaded, alive bits', () => {
    for (const [g, l, a] of [[-1, false, 0], [0, true, 7], [5, false, 1 << 12 | 3]] as const) expect(unpackPopSlot(packPopSlot(g, l, a))).toEqual({ group: g, loaded: l, alive: a });
  });

  it("the map feed's middle band ends at the system's first danger band (inner Sol's line)", () => {
    expect(feedMidRadius(sol)).toBe(76000);
    expect(feedMidRadius({ regions: undefined })).toBe(FEED_TIERS.midRadius);
  });
});
