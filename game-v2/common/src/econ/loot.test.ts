import { describe, it, expect } from 'vitest';
import { rollTable, rollDrops, dropSpecFor, dropChances, type LootTable } from './loot.js';

/** Dice that give these values in turn */
const seq = (...v: number[]) => { let i = 0; return () => v[i++ % v.length]; };

const tables: Record<string, LootTable> = {
  common: { nothing: 50, entries: [{ item: 'scrap', weight: 20, min: 1, max: 2 }, { item: 'iron', weight: 30, min: 2, max: 5 }] },
  rare: { nothing: 95, entries: [{ item: 'chip', weight: 5 }] },
  sure: { kind: 'always', entries: [{ item: 'plate', min: 3, max: 3 }, { item: 'wire' }] },
};

describe('loot tables', () => {
  it('a roll picks one entry by weight, or nothing', () => {
    // 0.49 x 100 = 49 < 50: nothing; 0.6 -> 60 - 50 = 10 < 20: scrap; 0.75 -> 25 >= 20: iron
    expect(rollTable(tables.common, seq(0.49))).toEqual({});
    expect(rollTable(tables.common, seq(0.6, 0.99))).toEqual({ scrap: 2 });
    expect(rollTable(tables.common, seq(0.75, 0))).toEqual({ iron: 2 });
  });

  it('an always table drops every entry, amounts default to 1', () => {
    expect(rollTable(tables.sure, seq(0.5))).toEqual({ plate: 3, wire: 1 });
  });

  it('rolls every line, and the elite roll on eliteDrop', () => {
    const bag = rollDrops(tables, { drops: [{ table: 'sure', rolls: 2 }], eliteDrop: 'rare' }, seq(0.99, 0.0), 1);
    expect(bag.plate).toBe(6);
    expect(bag.wire).toBe(2);
    expect(rollDrops(tables, { eliteDrop: 'rare' }, seq(0.99), 1)).toEqual({ chip: 1 });
    expect(rollDrops(tables, { eliteDrop: 'rare' }, seq(0.99), 0)).toEqual({});
  });

  it('over many rolls, each entry comes up at its weight', () => {
    let s = 7;
    const dice = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    let scrap = 0;
    for (let i = 0; i < 20000; i++) if (rollTable(tables.common, dice).scrap) scrap++;
    expect(scrap / 20000).toBeGreaterThan(0.18);
    expect(scrap / 20000).toBeLessThan(0.22);
  });

  it('the most specific spec wins, drops and eliteDrop separately', () => {
    const s = dropSpecFor({ drops: [{ table: 'rare', rolls: 1 }] }, undefined, { eliteDrop: 'common', drops: [{ table: 'common', rolls: 1 }] });
    expect(s).toEqual({ drops: [{ table: 'rare', rolls: 1 }], eliteDrop: 'common' });
  });

  it('dropChances: the chance of at least one per kill', () => {
    const c = dropChances(tables, { drops: [{ table: 'common', rolls: 2 }, { table: 'sure', rolls: 1 }] });
    const by = Object.fromEntries(c.map((d) => [d.item, d]));
    expect(by.scrap.chance).toBeCloseTo(1 - 0.8 * 0.8);
    expect(by.plate.chance).toBe(1);
    expect(by.iron).toMatchObject({ min: 2, max: 5 });
    expect(c[0].chance).toBeGreaterThanOrEqual(c[c.length - 1].chance);
  });
});
