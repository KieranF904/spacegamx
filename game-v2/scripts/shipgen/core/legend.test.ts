import { describe, it, expect } from 'vitest';
import { loadCatalog } from '../../../common/src/ships/index';
import { loadContext, readCatalogFiles } from './context';
import { buildLegend, legendFor, legendText } from './legend';
import { allShapes } from './shapes';

const ctx = loadContext();
const legend = buildLegend(ctx);

describe('shipgen legend', () => {
  it('codes every catalog model and every structure function in every pilot material, once each', () => {
    const fns = [...ctx.catalog.functions.values()];
    for (const f of fns.filter((x) => x.model && !x.exclusive)) {
      expect(legend.entries.filter((e) => e.fn === f.id), f.id).toHaveLength(1);
    }
    const mats = [...ctx.catalog.materials.values()].filter((m) => !m.exclusive);
    for (const f of fns.filter((x) => !x.model && !x.legacy && !x.exclusive)) {
      for (const m of mats) expect(legend.find(f.id, m.id), `${f.id} ${m.id}`).toBeDefined();
    }
    // (nothing exclusive or legacy)
    for (const e of legend.entries) {
      const f = ctx.catalog.functions.get(e.fn)!;
      expect(f.exclusive || f.legacy).toBeFalsy();
    }
  });

  it('gives unique two-capital codes, the same on a fresh load of the catalog', () => {
    const codes = legend.entries.map((e) => e.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of codes) expect(c).toMatch(/^[A-Z]{2}$/);
    const fresh = buildLegend({ ...ctx, catalog: loadCatalog(readCatalogFiles(), { overlapShrink: ctx.tuning.overlapShrink }) });
    expect(fresh.entries.map((e) => `${e.code}=${e.fn}|${e.material}`)).toEqual(legend.entries.map((e) => `${e.code}=${e.fn}|${e.material}`));
  });

  it("names each part's power role from the power core (generators, stores, conduits, diodes, consumers)", () => {
    for (const e of legend.entries) {
      const f = ctx.catalog.functions.get(e.fn)!;
      if (e.fn === 'core') expect(e.power.role).toBe('core');
      else if ((f.produce ?? 0) > 0) expect(e.power.role, e.fn).toBe('generator');
      else if ((f.store ?? 0) > 0) expect(e.power.role, e.fn).toBe(f.oneWay ? 'diode' : f.relayOnly ? 'conduit' : 'store');
      else if (f.weapon) expect(e.power.role, e.fn).toBe('weapon');
      else if ((f.thrust ?? 0) > 0) expect(e.power.role, e.fn).toBe('thruster');
      if (['generator', 'dynamo'].includes(e.power.role)) expect(e.power.makes, e.fn).toBeGreaterThan(0);
      if (['store', 'conduit', 'diode'].includes(e.power.role)) expect(e.power.gives, e.fn).toBeGreaterThan(0);
      if (e.power.role === 'weapon') expect(e.power.uses, e.fn).toBeGreaterThanOrEqual(0);
      expect(e.line.startsWith(`${e.code} = `)).toBe(true);
      if (e.facing === 'free') expect(e.line).toContain('FACES OUT');
    }
  });

  it('filters by tier band: nothing above its level, legendaries only when asked', () => {
    const low = legendFor(legend, { maxLevel: 5 });
    expect(low.length).toBeGreaterThan(10);
    expect(low.every((e) => e.level <= 5 && e.rarity !== 'legendary' && !e.job)).toBe(true);
    expect(legendFor(legend, { maxLevel: 99 }).some((e) => e.rarity === 'legendary')).toBe(false);
    expect(legendFor(legend, { maxLevel: 99, rarities: ['legendary'] }).filter((e) => e.kind === 'model').every((e) => e.rarity === 'legendary')).toBe(true);
    const text = legendText(low);
    for (const e of low) expect(text).toContain(e.line);
  });

  it('gives every shaped player piece a letter and its distinct shapes', () => {
    for (const s of allShapes(ctx.catalog).filter((x) => !x.bespoke)) {
      expect(s.letter, s.piece).toMatch(/^[a-uw-z]$/);
      expect(s.classes.length).toBeGreaterThanOrEqual(1);
      expect(s.classes.length).toBeLessThanOrEqual(8);
    }
    expect(new Set(allShapes(ctx.catalog).filter((x) => x.letter).map((x) => x.letter)).size).toBe(allShapes(ctx.catalog).filter((x) => x.letter).length);
  });
});
