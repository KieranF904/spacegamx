/**
 * The source index: every rock lists what it yields, every enemy what it drops, and the per-item columns are the same facts read the other way round.
 * Chances and shares only ever come out as tiers.
 */
import { describe, it, expect } from 'vitest';
import { RESOURCE_DATA, sourceIndex, resourceEntries } from './resourceData';
import { TIER_FLOORS, tierOf } from './tiers';
import { bossDropRows, factionDropRows } from './drops';

const idx = sourceIndex();
const TIERS = ['low', 'medium', 'high'];

describe('tiers', () => {
  it('map a value to the highest floor it reaches', () => {
    expect(tierOf('drop', 0.04)).toBe('low');
    expect(tierOf('drop', TIER_FLOORS.drop.medium)).toBe('medium');
    expect(tierOf('drop', 0.39)).toBe('medium');
    expect(tierOf('drop', TIER_FLOORS.drop.high)).toBe('high');
    expect(tierOf('rock', 0.01)).toBe('low');
    expect(tierOf('rock', 0.9)).toBe('high');
  });
});

describe('rocks', () => {
  it('lists every mineable rock type, with where it is and what it yields', () => {
    const rock = idx.rocks.find((r) => r.id === 'asteroid_metal')!;
    expect(rock.name).toBe('Chondrite');
    expect(rock.systems.length).toBeGreaterThan(0);
    expect(rock.yields[0].item).toBe('iron_ore');
    expect(rock.yields[0].tier).toBe('high');
    expect(rock.yields.map((y) => y.item)).toContain('leestone_ore');
    expect(rock.yields.every((y) => TIERS.includes(y.tier))).toBe(true);
  });

  it('agrees with the item side: an item is mined from a rock exactly when the rock yields it', () => {
    for (const r of idx.rocks) for (const y of r.yields) {
      expect(idx.columns.get(y.item)!.mined.some((m) => m.rock === r.id && m.tier === y.tier), `${r.id} ${y.item}`).toBe(true);
    }
    for (const [item, c] of idx.columns) for (const m of c.mined) {
      expect(idx.rocks.find((r) => r.id === m.rock)!.yields.some((y) => y.item === item), `${item} ${m.rock}`).toBe(true);
    }
  });

  it('agrees with the text sources: an ore with a mined source has a mined chip', () => {
    for (const e of resourceEntries()) expect(e.sources.some((s) => s.kind === 'mined'), e.id).toBe(e.cols.mined.length > 0);
  });
});

describe('enemies', () => {
  it('lists every boss, and every faction that drops loot, with its drops', () => {
    for (const id of Object.keys(RESOURCE_DATA.bosses)) expect(idx.enemies.some((e) => e.id === id), id).toBe(true);
    const rust = idx.enemies.find((e) => e.id === 'boss_rustjaw')!;
    expect(rust.kind).toBe('boss');
    expect(rust.drops.map((d) => d.item)).toContain('rustjaw_cog');
    const pirates = idx.enemies.find((e) => e.id === 'faction:pirates')!;
    expect(pirates.drops.map((d) => d.item)).toContain('scrap_electronics');
    expect(pirates.where.length).toBeGreaterThan(0);
  });

  it('agrees with the item side in both directions', () => {
    for (const e of idx.enemies) for (const x of e.drops) {
      expect(idx.columns.get(x.item)!.dropped.some((m) => m.enemy === e.id && m.tier === x.tier), `${e.id} ${x.item}`).toBe(true);
    }
    for (const [item, c] of idx.columns) for (const m of c.dropped) {
      expect(idx.enemies.find((e) => e.id === m.enemy)!.drops.some((x) => x.item === item), `${item} ${m.enemy}`).toBe(true);
    }
  });

  it('agrees with the text sources: a dropped item has a drop source', () => {
    for (const e of resourceEntries()) expect(e.sources.some((s) => s.kind === 'drop'), e.id).toBe(e.cols.dropped.length > 0);
  });
});

describe('numbers', () => {
  it('no source text shows a percentage', () => {
    for (const e of resourceEntries()) for (const s of e.sources) expect(`${s.text} ${(s.where ?? []).join(' ')}`, e.id).not.toMatch(/\d\s*%|per 100/);
  });
});

describe('columns', () => {
  it('a refined item lists its recipe inputs, and its inputs list it as a use', () => {
    const alloy = idx.columns.get('alloy_plate')!;
    expect(alloy.madeFrom.some((r) => r.kind === 'refine' && r.inputs.some((i) => i.item === 'iron_ore'))).toBe(true);
    expect(idx.columns.get('iron_ore')!.usedIn).toContain('alloy_plate');
  });
  it('stations, quartermasters and job rewards are found', () => {
    expect(idx.columns.get('pack_optics')!.soldAt.some((s) => s.kind === 'quartermaster')).toBe(true);
    expect([...idx.columns.values()].some((c) => c.soldAt.some((s) => s.kind === 'station'))).toBe(true);
    expect([...idx.columns.values()].some((c) => c.rewards.length > 0)).toBe(true);
  });
});

describe('drops from the loot tables', () => {
  it("a faction's chance for an item is the best of its ships': the den's nest_rare counts for the Scrapborn", () => {
    const rows = factionDropRows(RESOURCE_DATA, 'scrapborn');
    // (Outside the den only the hulk's rare roll has it, 1 in 100; a den ship's nest_rare roll 4 in 100)
    expect(rows.find((r) => r.item === 'coil_winding')!.chance).toBeCloseTo(0.04);
    expect(rows.find((r) => r.item === 'iron_ore')!.chance).toBeCloseTo(1 - 0.85 ** 2);
    const scrap = idx.enemies.find((e) => e.id === 'faction:scrapborn')!;
    expect(scrap.drops.find((d) => d.item === 'coil_winding')!.tier).toBe('low');
  });

  it('a boss lists its sure drops at certainty and its rare ones low (reactor cores in the Reaches)', () => {
    const tally = bossDropRows(RESOURCE_DATA, 'boss_tallyman');
    expect(tally.find((r) => r.item === 'targeting_chip')!.chance).toBe(1);
    expect(tierOf('drop', tally.find((r) => r.item === 'reactor_core')!.chance)).toBe('low');
  });
});
