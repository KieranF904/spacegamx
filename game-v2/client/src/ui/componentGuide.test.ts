/**
 * The component guide's data: every buildable component under exactly one
 * tab, each tab by level, and the requirement line saying what gates it for
 * this pilot (a level, a job's licence, a boss part) or that it's open.
 */
import { describe, expect, it } from 'vitest';
import { join } from 'path';
import { Economy, JOB_MATERIALS, MATERIAL_LEVEL, type ItemsFile, type RecipesFile } from '@space-game/common';
import { loadShipConfigFromDisk } from '../../../server/src/ships/loadShipConfig';
import { createShipBridge } from '../../../server/src/proto/createProtoServer';
import items from '../../../data/items.json';
import recipes from '../../../data/recipes.json';
import quests from '../../../data/quests.json';
import bosses from '../../../data/bosses.json';
import {
  bossDrops, COMP_TABS, guideRows, questTeaches, requirementLine, rowGates, rowItemId, rowsOf, sortRows, tabOf,
  type CompRow, type PilotView,
} from './componentGuide';

const { catalog } = createShipBridge(loadShipConfigFromDisk(join(__dirname, '../../../data')));
const econ = new Economy(items as unknown as ItemsFile, recipes as unknown as RecipesFile, catalog, {});
const PLATES = (recipes as unknown as { parts: { plates: Record<string, string> } }).parts.plates;
const rows = guideRows(catalog, PLATES);
const QUESTS = questTeaches(quests as unknown as Parameters<typeof questTeaches>[0]);
const DROPS = bossDrops(bosses as unknown as Parameters<typeof bossDrops>[0]);

const row = (id: string) => rows.find((r) => r.id === id)!;
const pilot = (level: number, learned: string[] = [], bag: Record<string, number> = {}): PilotView => ({ level, learned, have: (id) => bag[id] ?? 0 });
const line = (id: string, p: PilotView) => {
  const r = row(id);
  return requirementLine(rowGates(r, catalog.functions.get(r.fn), p, { items: econ.items.all(), quests: QUESTS, drops: DROPS, inputs: econ.recipes.recipeFor(rowItemId(r))?.inputs ?? {} }));
};

describe('component guide tabs', () => {
  it('every buildable model, structure material and the core sits under exactly one tab', () => {
    const models = [...catalog.functions.values()].filter((f) => f.model && !f.legacy && !f.exclusive);
    expect(models.length).toBeGreaterThan(50);
    for (const f of models) expect(rows.filter((r) => r.id === f.id).length, f.id).toBe(1);
    for (const m of catalog.materials.values()) {
      const n = rows.filter((r) => r.id === `structure:${m.id}`).length;
      expect(n, m.id).toBe(m.exclusive || !PLATES[m.id] ? 0 : 1);
    }
    expect(row('core').tab).toBe('structure');
    // (each row once, in one of the tabs, and every tab has some)
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    const tabs = new Set(COMP_TABS.map((t) => t.id));
    for (const r of rows) expect(tabs.has(r.tab), r.id).toBe(true);
    expect(COMP_TABS.reduce((n, t) => n + rowsOf(rows, t.id).length, 0)).toBe(rows.length);
    for (const t of COMP_TABS) expect(rowsOf(rows, t.id).length, t.id).toBeGreaterThan(0);
  });

  it('follows the data: a model by its category, jump coils with engines, plating with shields', () => {
    expect(row('cannon_bastion').tab).toBe('weapons');
    expect(row('utility_jump_coil').tab).toBe('engines');
    expect(row('plating_reactive_armour').tab).toBe('shields');
    expect(row('utility_constructor').tab).toBe('utility');
    expect(row('structure:steel').level).toBe(MATERIAL_LEVEL.steel);
    // Legacy and bosses' own functions aren't built
    expect(tabOf(catalog.functions.get('conduit')!)).toBeNull();
    for (const f of catalog.functions.values()) if (f.exclusive) expect(tabOf(f), f.id).toBeNull();
  });

  it('each tab runs by level, licence-only last', () => {
    for (const t of COMP_TABS) {
      const lv = rowsOf(rows, t.id).map((r) => r.level ?? Infinity);
      expect(lv, t.id).toEqual([...lv].sort((a, b) => a - b));
    }
    const s = sortRows([{ level: null, order: 0, name: 'a' }, { level: 5, order: 2, name: 'b' }, { level: 5, order: 1, name: 'c' }, { level: 0, order: 9, name: 'd' }] as CompRow[]);
    expect(s.map((r) => r.name)).toEqual(['d', 'c', 'b', 'a']);
  });
});

describe('requirement line', () => {
  it('a level not reached, then open', () => {
    const lv = row('cannon_bastion').level!;
    expect(line('cannon_bastion', pilot(lv - 1))).toEqual({ met: false, text: `Reach level ${lv} (you're ${lv - 1})` });
    expect(line('cannon_bastion', pilot(lv))).toEqual({ met: true, text: `Unlocked at level ${lv}` });
    expect(line('cannon_pip', pilot(1)).text).toBe('Starter: every pilot can build it');
  });

  it("a weapon's licence never opens it early", () => {
    expect(line('railgun_needle', pilot(row('railgun_needle').level! - 1, ['fn:railgun'])).met).toBe(false);
  });

  it("a legendary needs its boss's part, and says who drops it", () => {
    const lv = row('legendary_hive').level!;
    const r = line('legendary_hive', pilot(lv));
    expect(r.met).toBe(false);
    expect(r.text).toBe("Needs Rustjaw's Cog: dropped by Rustjaw");
    expect(line('legendary_hive', pilot(lv - 1)).text).toBe(`Reach level ${lv} (you're ${lv - 1}) · Needs Rustjaw's Cog: dropped by Rustjaw`);
    expect(line('legendary_hive', pilot(lv, [], { rustjaw_cog: 1 }))).toEqual({ met: true, text: `Unlocked at level ${lv}, Rustjaw's Cog in hand` });
  });

  it('nothing opens early: a licence for a model or material does nothing before its level', () => {
    const lv = row('utility_constructor').level!;
    if (lv > 0) expect(line('utility_constructor', pilot(lv - 1, ['fn:constructor', 'fn:utility_constructor'])).met).toBe(false);
    const sl = MATERIAL_LEVEL.steel;
    expect(line('structure:steel', pilot(sl - 1, ['material:steel']))).toEqual({ met: false, text: `Reach level ${sl} (you're ${sl - 1})` });
    expect(line('structure:steel', pilot(sl))).toEqual({ met: true, text: `Unlocked at level ${sl}` });
  });

  it("a job's material needs its level and the job's licence; the core its licence", () => {
    for (const m of JOB_MATERIALS) {
      const r = row(`structure:${m}`), lv = r.level!;
      expect(line(r.id, pilot(lv - 1)).text.startsWith(`Reach level ${lv} (you're ${lv - 1}) · Learned from `)).toBe(true);
      expect(line(r.id, pilot(lv - 1)).text).toContain('the job “');
      expect(line(r.id, pilot(lv)).met).toBe(false);
      expect(line(r.id, pilot(lv, [`material:${m}`]))).toEqual({ met: true, text: `Unlocked at level ${lv}, licence learned` });
    }
    expect(line('structure:leestone', pilot(1)).text).toMatch(/Ark-Heavy/);
    expect(line('core', pilot(1)).text).toMatch(/^Learned from .*First Light/);
    expect(line('core', pilot(1, ['fn:core']))).toEqual({ met: true, text: 'Licence learned' });
  });
});
