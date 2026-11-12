/** The gun range weapon picker's rows (pickerModel.ts): one per option, in order, with the hangar's classes and mounts. */

import { describe, expect, it } from 'vitest';
import { FX_MAX, gunRangeMods, gunRangeOptions, type ShipTuning } from '@space-game/common';
import { testCatalog, readShipJson } from '../../../../common/src/ships/testData';
import { ALL_ROLES, filterRows, modRows, nextRow, pickerRows, pickerTabs, rolesPresent, shipGroups, toggleMod } from './pickerModel';
import { subsOf } from '../../ships/paletteFilters';

const catalog = testCatalog();
const tuning = readShipJson<ShipTuning>('tuning.json');
const options = gunRangeOptions(catalog, { level: 60 });

describe('gun range picker rows', () => {
  it('every option is a row, in its order, and nothing else', () => {
    const rows = pickerRows(catalog, tuning, [...options, 'no_such_weapon', 'hull']);
    expect(rows.map((r) => r.fn)).toEqual(options);
  });

  it('each row has its name, a palette class, a mount and a part item id', () => {
    for (const r of pickerRows(catalog, tuning, options)) {
      const f = catalog.functions.get(r.fn)!;
      expect(r.name).toBe(f.name ?? f.id);
      expect(subsOf('weapons').map((s) => s.id)).toContain(r.role);
      expect(['fixed', 'turret']).toContain(r.mount);
      expect(r.item).toMatch(new RegExp(`^part:[^:]+:${r.fn}:[^:]+$`));
    }
  });

  it('the wide range covers beams, guided, area and support weapons, and turrets and side mounts', () => {
    const rows = pickerRows(catalog, tuning, options);
    const roles = new Set(rows.map((r) => r.role));
    for (const r of ['direct', 'beam', 'guided', 'area', 'support'] as const) expect(roles.has(r)).toBe(true);
    expect(rows.some((r) => r.mount === 'turret')).toBe(true);
    expect(rows.some((r) => r.side)).toBe(true);
  });

  it('the class filter offers only classes with a row, in the palette order; All shows every row', () => {
    const rows = pickerRows(catalog, tuning, options);
    const roles = rolesPresent(rows).map((s) => s.id);
    expect(roles).toEqual(subsOf('weapons').map((s) => s.id).filter((id) => rows.some((r) => r.role === id)));
    expect(filterRows(rows, ALL_ROLES)).toHaveLength(rows.length);
    for (const id of roles) expect(filterRows(rows, id).every((r) => r.role === id)).toBe(true);
    const pip = pickerRows(catalog, tuning, ['cannon_pip']);
    expect(rolesPresent(pip)).toHaveLength(1);
  });

  it('arrow keys wrap through the list; Home and End go to its ends; other keys are not the list\'s', () => {
    expect(nextRow('ArrowDown', 2, 3)).toBe(0);
    expect(nextRow('ArrowUp', 0, 3)).toBe(2);
    expect(nextRow('Home', 2, 3)).toBe(0);
    expect(nextRow('End', 0, 3)).toBe(2);
    expect(nextRow('KeyW', 0, 3)).toBeNull();
    expect(nextRow('ArrowDown', 0, 0)).toBeNull();
  });
});

describe('gun range modifier chips', () => {
  const mt = tuning.modifiers!, all = gunRangeMods(catalog, mt, { level: 60 });

  it('every effect on offer is a chip, in its order, named and coloured as the game says; the ship\'s are on', () => {
    expect(all).toEqual(mt.effects);
    const chips = modRows(mt, [...all, 'no_such_effect'], ['split', 'burn']);
    expect(chips.map((c) => c.effect)).toEqual(all);
    for (const c of chips) {
      expect(c.name).toBe(mt.say[c.effect].name);
      expect(c.color).toBe(mt.say[c.effect].color);
      expect(c.on).toBe(c.effect === 'split' || c.effect === 'burn');
    }
    expect(modRows(undefined, all, [])).toEqual([]);
  });

  it('a click turns one effect and keeps the rest, in the options\' order; only effects on offer', () => {
    expect(toggleMod(all, [], 'burn')).toEqual(['burn']);
    expect(toggleMod(all, ['burn'], 'velocity')).toEqual(['velocity', 'burn']);
    expect(toggleMod(all, ['velocity', 'burn'], 'burn')).toEqual(['velocity']);
    expect(toggleMod(['velocity'], [], 'burn')).toBeNull();
    // (one the pilot no longer has on offer is dropped from what is asked)
    expect(toggleMod(['velocity', 'rapid'], ['burn'], 'rapid')).toEqual(['rapid']);
  });

  it('never more than a gun carries: with its fill on, another is refused and one can still come off', () => {
    const four = all.slice(0, FX_MAX);
    expect(toggleMod(all, four, all[FX_MAX])).toBeNull();
    expect(toggleMod(all, four, four[0])).toEqual(four.slice(1));
  });
});

describe('gun range library ships', () => {
  const SHIPS = [
    { id: 'starter', name: 'Starter', group: 'Library' }, { id: 'mod-showcase-1', name: 'Modifier showcase', group: 'Dev test ships' },
    { id: 'hauler', name: 'Hauler', group: 'Library' }, { id: 'nameless', name: '', group: 'Dev test ships' },
  ];

  it('every library ship sent is a row under its group, groups and ships in the order sent, the one flown marked', () => {
    const groups = shipGroups(SHIPS, 'hauler');
    expect(groups.map((g) => g.group)).toEqual(['Library', 'Dev test ships']);
    expect(groups[0].rows).toEqual([{ id: 'starter', name: 'Starter', on: false }, { id: 'hauler', name: 'Hauler', on: true }]);
    expect(groups[1].rows.map((r) => [r.id, r.name])).toEqual([['mod-showcase-1', 'Modifier showcase'], ['nameless', 'nameless']]);
    expect(groups.flatMap((g) => g.rows).length).toBe(SHIPS.length);
    expect(shipGroups(SHIPS, '').flatMap((g) => g.rows).some((r) => r.on)).toBe(false);
  });

  it('the Ships tab is there only for a pilot who was sent ships', () => {
    expect(pickerTabs([])).toEqual([]);
    expect(shipGroups([], '')).toEqual([]);
    expect(pickerTabs(SHIPS)).toEqual(['weapons', 'ships']);
  });
});
