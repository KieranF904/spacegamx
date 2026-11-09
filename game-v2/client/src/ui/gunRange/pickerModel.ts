/**
 * @contract client.gun-range.picker-model
 * owns:       the gun range weapon picker's rows: each weapon on offer with its name, role (the hangar palette's weapon
 *             classes: direct, burst, beam, guided, area, support), mount (fixed, turret, side), Mk grade and item icon id;
 *             the role filter (the classes present, in the palette's order) and the keyboard's next row
 * needs:      @space-game/common (Catalog, ShipTuning, mountingOf, partMount, partItemId), ships/paletteFilters (weaponRole, subsOf)
 * invariants: every option the server sent is a row, in its order, and nothing else — client/src/ui/gunRange/pickerModel.test.ts
 *             the role filter offers only roles that have a row, in the palette's order — client/src/ui/gunRange/pickerModel.test.ts
 * extend:     a new thing shown on a row is a field of PickerRow, filled in pickerRows
 */

import { mountingOf, partItemId, partMount, type Catalog, type ShipTuning } from '@space-game/common';
import { subsOf, weaponRole, type SubDef, type WeaponRole } from '../../ships/paletteFilters';

export interface PickerRow {
  fn: string;
  name: string;
  role: WeaponRole;
  mount: 'fixed' | 'turret';
  /** Bolts on at its side and fires across (a right-angle mount) */
  side: boolean;
  /** Mk grade (1 when the model has none) */
  grade: number;
  /** The part's item id (its icon: ui/itemIcons) */
  item: string;
}

export const ALL_ROLES = 'all';

/** The rows for these options (unknown ids dropped), in the order given */
export function pickerRows(catalog: Catalog, tuning: ShipTuning | undefined, options: readonly string[]): PickerRow[] {
  const out: PickerRow[] = [];
  for (const fn of options) {
    const f = catalog.functions.get(fn);
    if (!f?.weapon) continue;
    const piece = Array.isArray(f.pieces) && f.pieces.length ? f.pieces[0] : 'sq';
    out.push({
      fn, name: f.name ?? fn, role: weaponRole(f, tuning), mount: partMount(catalog, { fn }) === 'turret' ? 'turret' : 'fixed',
      side: mountingOf(catalog, fn)?.angle === 'right', grade: f.grade ?? 1,
      item: partItemId({ material: f.material ?? 'alloy', fn, piece }),
    });
  }
  return out;
}

/** The role filter's choices: the palette's weapon classes that have a row, in its order */
export function rolesPresent(rows: readonly PickerRow[]): SubDef[] {
  const have = new Set(rows.map((r) => r.role));
  return subsOf('weapons').filter((s) => have.has(s.id as WeaponRole));
}

/** The rows a role filter shows (ALL_ROLES: every one) */
export function filterRows(rows: readonly PickerRow[], role: string): PickerRow[] {
  return role === ALL_ROLES ? [...rows] : rows.filter((r) => r.role === role);
}

/** Arrow keys over the list: the row index to focus next (wraps; Home/End to the ends), or null for any other key */
export function nextRow(code: string, at: number, n: number): number | null {
  if (n <= 0) return null;
  switch (code) {
    case 'ArrowDown': return (at + 1) % n;
    case 'ArrowUp': return (at - 1 + n) % n;
    case 'Home': return 0;
    case 'End': return n - 1;
    default: return null;
  }
}
