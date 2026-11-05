import { describe, it, expect } from 'vitest';
import { spawnersOf, seedGroups, ghostCentre, slotStyle, packPopSlot, unpackPopSlot, feedMidRadius, lureSector, GHOST_STEP, FEED_TIERS, LURE_RAMP, LURE_SECTORS, type Lure } from './populations.js';
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

  it("a nomad's lure draws its ghost round to the pilots' sector, and a new lure starts from where the old one had got it", () => {
    const sp = spawnersOf(spawns.sol, sol).find((s) => s.def.groups.some((_, g) => slotStyle(s, g) === 'nomad'))!;
    const at = (tick: number, lure?: Lure) => ghostCentre(sol, 'sol', sp, 0, 'nomad', tick, lure);
    const none: Lure = { l1: -1, s1: 0, l2: -1, s2: 0 };
    expect(at(GHOST_STEP * 50, none)).toEqual(at(GHOST_STEP * 50));
    const a: Lure = { l1: -1, s1: 0, l2: 5, s2: 10 };
    // Drawn round to sector 5 once the ramp's run
    const far = at(GHOST_STEP * 10 + LURE_RAMP * 2, a);
    const off = (p: { x: number; y: number }, s: number) => { const d = Math.atan2(p.y, p.x) - ((s + 0.5) / LURE_SECTORS) * Math.PI * 2; return Math.abs(Math.atan2(Math.sin(d), Math.cos(d))); };
    // (LURE_PULL of the way: within a tenth of where it started from of the sector, across it)
    expect(off(far, 5)).toBeLessThan(0.1 * Math.PI + 0.01);
    // A new lure from step 40: where it was at 40 under the old one, then on towards the new
    const b: Lure = { l1: 5, s1: 10, l2: 12, s2: 40 };
    expect(at(GHOST_STEP * 40, b)).toEqual(at(GHOST_STEP * 40, a));
    const later = at(GHOST_STEP * 40 + LURE_RAMP * 2, b);
    expect(off(later, 12)).toBeLessThan(0.1 * Math.PI + 0.01);
    for (let k = 0; k < 64; k++) { const s = lureSector(Math.cos(k / 10) * 1000, Math.sin(k / 10) * 1000); expect(s).toBeGreaterThanOrEqual(0); expect(s).toBeLessThan(LURE_SECTORS); }
  });

  it('a slot on the wire: group, loaded, alive bits', () => {
    for (const [g, l, a] of [[-1, false, 0], [0, true, 7], [5, false, 1 << 12 | 3]] as const) expect(unpackPopSlot(packPopSlot(g, l, a))).toEqual({ group: g, loaded: l, alive: a });
  });

  it("the map feed's middle band ends at the system's first danger band (inner Sol's line)", () => {
    expect(feedMidRadius(sol)).toBe(76000);
    expect(feedMidRadius({ regions: undefined })).toBe(FEED_TIERS.midRadius);
  });
});
