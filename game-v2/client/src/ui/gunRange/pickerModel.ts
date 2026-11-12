/**
 * @contract client.gun-range.picker-model
 * owns:       the gun range weapon picker's rows: each weapon on offer with its name, role (the hangar palette's weapon
 *             classes: direct, burst, beam, guided, area, support), mount (fixed, turret, side), Mk grade and item icon id;
 *             the role filter (the classes present, in the palette's order) and the keyboard's next row; the weapon
 *             modifier chips (each effect on offer with its name, colour and one-line say) and what a click on one asks for;
 *             an admin's library ships under their group headings
 * needs:      @space-game/common (Catalog, ShipTuning, ModifierTuning, FX_MAX, mountingOf, partMount, partItemId),
 *             ships/paletteFilters (weaponRole, subsOf)
 * invariants: every option the server sent is a row, in its order, and nothing else — client/src/ui/gunRange/pickerModel.test.ts
 *             the role filter offers only roles that have a row, in the palette's order — client/src/ui/gunRange/pickerModel.test.ts
 *             a click on a chip asks for the effects on with that one turned, on offer only, never more than a gun carries — client/src/ui/gunRange/pickerModel.test.ts
 *             every library ship the server sent is a row under its group, in the order sent, and nothing else — client/src/ui/gunRange/pickerModel.test.ts
 * extend:     a new thing shown on a row is a field of PickerRow, filled in pickerRows
 */

import { FX_MAX, mountingOf, partItemId, partMount, type Catalog, type ModifierTuning, type ShipTuning } from '@space-game/common';
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

/** One weapon modifier chip: an effect on offer, how the game names and colours it, and whether the ship carries it */
export interface ModRow { effect: string; name: string; color: string; say: string; on: boolean }

/** The chips for these effects on offer (ones the tuning doesn't know dropped), in the order given */
export function modRows(mt: ModifierTuning | undefined, options: readonly string[], on: readonly string[]): ModRow[] {
  if (!mt) return [];
  return options.filter((e) => mt.effects.includes(e)).map((e) => {
    const s = mt.say[e];
    return { effect: e, name: s?.name ?? e, color: s?.color ?? '#c9d4e5', say: s?.say ?? '', on: on.includes(e) };
  });
}

/** What a click on a chip asks for: the effects on with this one turned, in the options' order (null: not on offer, or a gun's fill already on) */
export function toggleMod(options: readonly string[], on: readonly string[], effect: string): string[] | null {
  if (!options.includes(effect)) return null;
  const had = on.includes(effect);
  if (!had && on.filter((e) => options.includes(e)).length >= FX_MAX) return null;
  return options.filter((e) => (e === effect ? !had : on.includes(e)));
}

/** One library ship an admin may fly, and a heading's worth of them */
export interface ShipRow { id: string; name: string; on: boolean }
export interface ShipGroup { group: string; rows: ShipRow[] }

/** The Ships tab's rows: every ship sent, under its group, groups and ships each in the order first sent */
export function shipGroups(ships: readonly { id: string; name: string; group: string }[], flown: string): ShipGroup[] {
  const out: ShipGroup[] = [];
  for (const s of ships) {
    let g = out.find((x) => x.group === s.group);
    if (!g) out.push((g = { group: s.group, rows: [] }));
    g.rows.push({ id: s.id, name: s.name || s.id, on: s.id === flown });
  }
  return out;
}

/** The picker's tabs: Weapons alone (no tab row at all) unless there are library ships to offer */
export type PickerTab = 'weapons' | 'ships';
export function pickerTabs(ships: readonly unknown[]): PickerTab[] {
  return ships.length ? ['weapons', 'ships'] : [];
}
