import { describe, it, expect } from 'vitest';
import { catalogue, matches, whereFrom } from './catalogue';
import { resourceEntries } from '../resources/resourceData';

const all = catalogue();
const section = (id: string) => all.find((s) => s.id === id)!;
const tiles = (id: string) => section(id).groups.flatMap((g) => g.items);
const entry = (id: string) => resourceEntries().find((e) => e.id === id)!;

describe('the auto-pickup catalogue', () => {
  it('has its five sections; every ore, component and refined material once in its own', () => {
    expect(all.map((s) => s.id)).toEqual(['mining', 'drops', 'component', 'refined', 'salvage']);
    for (const [sec, cat] of [['mining', 'ore'], ['refined', 'refined']] as const) {
      const ids = tiles(sec).map((t) => t.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const e of resourceEntries().filter((x) => x.category === cat)) expect(ids, e.id).toContain(e.id);
    }
    expect(tiles('mining').every((t) => t.ore)).toBe(true);
    expect(tiles('component').map((t) => t.id)).toContain('capacitor_cell');
  });

  it('enemy drops: one group per enemy, tiers only', () => {
    const groups = section('drops').groups;
    expect(groups.length).toBeGreaterThan(5);
    const scrap = groups.find((g) => g.title === 'Scrapborn (any ship)')!;
    expect(scrap.items.map((t) => t.id)).toContain('scrap_electronics');
    for (const g of groups) for (const t of g.items) expect(['low', 'medium', 'high']).toContain(t.tier);
  });

  it('says where an item comes from: rocks, a den table, a boss; "Not in Sol" when it isn\'t', () => {
    expect(whereFrom(entry('iron_ore'))).toMatch(/rocks$/);
    expect(whereFrom(entry('coil_winding'))).toBe("The Scrap Mother's Nest · rare");
    expect(whereFrom(entry('reactor_core'))).toMatch(/^(The Tallyman|Hollow Crown) · rare$/);
    expect(whereFrom(entry('frost_gland'))).toMatch(/Not in Sol$/);
  });

  it('search: every word must match the name, id or where-from line', () => {
    const t = tiles('component').find((x) => x.id === 'coil_winding')!;
    expect(matches(t, 'coil nest')).toBe(true);
    expect(matches(t, 'coil pirate')).toBe(false);
    expect(matches(t, '')).toBe(true);
  });
});
