/** The gun range weapon picker's rows (pickerModel.ts): one per option, in order, with the hangar's classes and mounts. */

import { describe, expect, it } from 'vitest';
import { gunRangeOptions, type ShipTuning } from '@space-game/common';
import { testCatalog, readShipJson } from '../../../../common/src/ships/testData';
import { ALL_ROLES, filterRows, nextRow, pickerRows, rolesPresent } from './pickerModel';
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
