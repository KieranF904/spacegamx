/**
 * The most-commonly-met-first order from the real game data.
 */
import { describe, it, expect } from 'vitest';
import { RESOURCE_DATA, commonnessIndex, levelIndex, resourceEntries, sourceIndex } from './resourceData';
import { buildCommonness, sortByCommonness } from './commonness';

const lv = levelIndex();
const ix = sourceIndex();
const ci = commonnessIndex();
const inCategory = (c: string) => sortByCommonness(ci, lv, 'res', resourceEntries().filter((e) => e.category === c), (e) => e.name).map((e) => e.id);
const ores = inCategory('ore');

describe('commonness order', () => {
  it('iron, copper and silicate are among the first ores', () => {
    for (const id of ['iron_ore', 'copper_ore', 'silicate']) {
      expect(ores.indexOf(id), id).toBeGreaterThanOrEqual(0);
      expect(ores.indexOf(id), id).toBeLessThan(8);
    }
  });

  it('aurum comes after every ore mined in Sol', () => {
    const sol = ix.systems.find((s) => s.id === 'sol')!;
    const mined = new Set(sol.rocks.flatMap((r) => ix.rocks.find((x) => x.id === r.rock)!.yields.map((y) => y.item)));
    expect(mined.size).toBeGreaterThan(0);
    for (const id of mined) if (ores.includes(id)) expect(ores.indexOf('aurum'), id).toBeGreaterThan(ores.indexOf(id));
  });

  it('alloy plate is the first refined item', () => {
    expect(inCategory('refined')[0]).toBe('alloy_plate');
  });

  it('a boss comes after its faction ordinary entry', () => {
    const order = sortByCommonness(ci, lv, 'enemy', ix.enemies, (e) => e.name).map((e) => e.id);
    for (const [id, b] of Object.entries(RESOURCE_DATA.bosses)) {
      if (!b.faction || !order.includes(id) || !order.includes(`faction:${b.faction}`)) continue;
      expect(order.indexOf(id), id).toBeGreaterThan(order.indexOf(`faction:${b.faction}`));
    }
  });

  it('systems run from Sol outward', () => {
    const order = sortByCommonness(ci, lv, 'sys', ix.systems, (s) => s.name).map((s) => s.id);
    expect(order[0]).toBe('sol');
    const lvls = order.map((id) => lv.sys.get(id) ?? 1);
    expect(lvls).toEqual([...lvls].sort((a, b) => a - b));
  });

  it('is deterministic', () => {
    const again = buildCommonness(RESOURCE_DATA, ix, lv);
    const a = sortByCommonness(again, lv, 'res', resourceEntries(), (e) => e.name).map((e) => e.id);
    const b = sortByCommonness(ci, lv, 'res', [...resourceEntries()].reverse(), (e) => e.name).map((e) => e.id);
    expect(a).toEqual(b);
  });
});
