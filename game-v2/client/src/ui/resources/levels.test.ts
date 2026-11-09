/**
 * The level rule per kind from the real game data, the sort order of the grids, and locked against a given player level.
 */
import { describe, it, expect } from 'vitest';
import { GRADE_LEVEL, MATERIAL_LEVEL } from '@space-game/common';
import { RESOURCE_DATA, levelIndex, sourceIndex } from './resourceData';
import { isLocked, levelOf, sortByLevel, systemLevel } from './levels';
import { enemyGridHtml, resourceGridHtml, rockGridHtml, systemGridHtml } from './resourceGrid';
import { pageHtml, previewHtml } from './entryCards';

const lv = levelIndex();
const ix = sourceIndex();
const deps = (level?: number) => ({ icon: () => '', level: level === undefined ? undefined : () => level });
const tilesOf = (html: string) =>
  [...html.matchAll(/<button type="button" class="rg-tile( locked)?" data-view-of="(\w+)" data-id="([^"]+)"[^>]*?(?: data-level="(\d+)")? aria-label/g)].map((m) => ({ locked: !!m[1], id: m[3], level: m[4] ? Number(m[4]) : 0 }));

describe('level rule', () => {
  it('a system opens at the level of its grade', () => {
    expect(levelOf(lv, 'sys', 'sol')).toBeUndefined();
    expect(levelOf(lv, 'sys', 'borealis')).toBe(GRADE_LEVEL[RESOURCE_DATA.spawns!.borealis.grade!]);
    expect(levelOf(lv, 'sys', 'void_sector')).toBe(GRADE_LEVEL[5]);
    for (const s of ix.systems) expect(levelOf(lv, 'sys', s.id), s.id).toBe(systemLevel(RESOURCE_DATA, s.id));
  });

  it('a rock and an enemy open at the lowest level of the systems they are in', () => {
    for (const r of ix.rocks) expect(levelOf(lv, 'rock', r.id) ?? 0, r.id).toBe(Math.min(...r.systems.map((p) => levelOf(lv, 'sys', p.id) ?? 0)));
    for (const e of ix.enemies.filter((x) => x.systemIds.length)) expect(levelOf(lv, 'enemy', e.id) ?? 0, e.id).toBe(Math.min(...e.systemIds.map((id) => levelOf(lv, 'sys', id) ?? 0)));
  });

  it('a resource opens at its recipe level, its material level, else where it comes from', () => {
    expect(levelOf(lv, 'res', 'iron_ore')).toBeUndefined();
    expect(levelOf(lv, 'res', 'steel_plate')).toBe(MATERIAL_LEVEL.steel);
    expect(levelOf(lv, 'res', 'titanium_plate')).toBe(MATERIAL_LEVEL.titanium);
    expect(levelOf(lv, 'res', 'ferrite_plate')).toBeGreaterThanOrEqual(30);
    expect(levelOf(lv, 'res', 'pack_wiring')).toBe(6);
    // a plain ore: the lowest level among the systems that hold it
    for (const [item, c] of ix.columns) {
      if (!c.systems.length || RESOURCE_DATA.recipes.refining.some((r) => r.id === item)) continue;
      if (RESOURCE_DATA.recipes.craft.some((r) => item in r.out && r.level !== undefined)) continue;
      expect(levelOf(lv, 'res', item) ?? 0, item).toBe(Math.min(...c.systems.map((s) => levelOf(lv, 'sys', s.id) ?? 0)));
    }
  });

  it('no level of 1 or less is stored', () => {
    for (const m of [lv.res, lv.rock, lv.enemy, lv.sys]) for (const [id, l] of m) expect(l, id).toBeGreaterThan(1);
  });
});

describe('sorting', () => {
  it('sorts by level then name', () => {
    const a = [{ n: 'b', l: 5 }, { n: 'a', l: 5 }, { n: 'z', l: undefined }, { n: 'c', l: 2 }];
    expect(sortByLevel(a, (x) => x.l, (x) => x.n).map((x) => x.n)).toEqual(['z', 'c', 'a', 'b']);
  });

  it('every grid group runs ascending by level', () => {
    const grids = [resourceGridHtml(deps(1)), rockGridHtml(deps(1)), enemyGridHtml(deps(1)), systemGridHtml(deps(1))];
    for (const html of grids) for (const group of html.split('<section').slice(1)) {
      const ls = tilesOf(group).map((t) => t.level);
      expect(ls.length).toBeGreaterThan(0);
      expect(ls).toEqual([...ls].sort((x, y) => x - y));
    }
  });
});

describe('locked', () => {
  it('isLocked compares a gate with the player level', () => {
    expect(isLocked(undefined, 1)).toBe(false);
    expect(isLocked(12, 11)).toBe(true);
    expect(isLocked(12, 12)).toBe(false);
    expect(isLocked(12, undefined)).toBe(false);
  });

  it('tiles are locked exactly above the player level', () => {
    for (const player of [1, 12, 100]) {
      const t = tilesOf(resourceGridHtml(deps(player))).concat(tilesOf(systemGridHtml(deps(player))));
      for (const x of t) expect(x.locked, `${x.id} @${player}`).toBe(x.level > player);
    }
    expect(tilesOf(systemGridHtml(deps(1))).find((t) => t.id === 'void_sector')!.locked).toBe(true);
    expect(tilesOf(systemGridHtml(deps(40))).some((t) => t.locked)).toBe(false);
    expect(systemGridHtml(deps(1))).toContain('🔒 Lv 32');
  });

  it('an ungated tile has no badge, and no player level locks nothing', () => {
    expect(tilesOf(systemGridHtml(deps(1))).find((t) => t.id === 'sol')!.level).toBe(0);
    expect(systemGridHtml(deps())).not.toContain('locked');
  });

  it('the preview and the page say when it unlocks', () => {
    expect(previewHtml('sys', 'void_sector', deps(1))).toContain('Unlocks at level 32');
    expect(pageHtml('res', 'steel_plate', deps(1))).toContain('Unlocks at level 5');
    expect(pageHtml('res', 'steel_plate', deps(9))).not.toContain('Unlocks at level');
    expect(pageHtml('sys', 'sol', deps(1))).not.toMatch(/at level/);
  });
});
