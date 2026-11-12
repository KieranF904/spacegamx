/**
 * @contract client.ui.group-row-model
 * owns:       what the HUD's weapon group row shows: for each of the five groups, the weapons of the current ship in it
 *             (by model, counted), and whether the left and the right button fire it now
 * needs:      common weaponGroups (inGroup, selLeft, selRight, rightFiresGuns) and partItemId (a weapon's icon is its item's)
 * invariants: a button on "all" marks every group that has a weapon (the right button none on a mining ship: it mines);
 *             a button on a group marks that group alone, empty or not; a weapon in several groups shows in each —
 *             client/src/ui/hud/groupRowModel.test.ts
 * extend:     a new thing to show per group is a field of GroupCell filled in groupRowView
 */

import { GROUP_ALL, WEAPON_GROUPS, inGroup, partItemId, partWeaponGroups, rightFiresGuns, selLeft, selRight, type ShipState } from '@space-game/common';

/** One weapon on the ship: its model, its item (the icon) and its group mask */
export interface RowGun { fn: string; item: string; wg: number }

/** A group's weapons of one model */
export interface CellGun { fn: string; item: string; n: number }

export interface GroupCell {
  /** The group, 1..5 */
  g: number;
  guns: CellGun[];
  /** The left / right button fires this group now */
  left: boolean;
  right: boolean;
  /** That button is set to this very group (not "all") */
  leftPicked: boolean;
  rightPicked: boolean;
}

export interface GroupRowView {
  cells: GroupCell[];
  /** The buttons' selections (0 all, 1..5) */
  left: number;
  right: number;
  /** The ship has a weapon at all (no row without one) */
  armed: boolean;
}

/** The standing weapons of a ship, in the order its guns are stepped (planned parts not built yet are left out) */
export function shipRowGuns(ship: Pick<ShipState, 'blueprint' | 'derived' | 'ghost'>): RowGun[] {
  const out: RowGun[] = [];
  for (const w of ship.derived.weapons) {
    const p = ship.blueprint.parts[w.part];
    if (!p || ship.ghost?.[w.part]) continue;
    out.push({ fn: p.fn, item: partItemId(p), wg: partWeaponGroups(p) });
  }
  return out;
}

/** The row for these weapons and this selection (packGroupSel); `hasMiners`: the right button on "all" mines */
export function groupRowView(guns: readonly RowGun[], sel: number, hasMiners: boolean): GroupRowView {
  const left = selLeft(sel), right = selRight(sel), rightGuns = rightFiresGuns(sel, hasMiners);
  const cells: GroupCell[] = [];
  for (let g = 1; g <= WEAPON_GROUPS; g++) {
    const list: CellGun[] = [];
    for (const gun of guns) {
      if (!inGroup(gun.wg, g)) continue;
      const have = list.find((c) => c.item === gun.item);
      if (have) have.n++; else list.push({ fn: gun.fn, item: gun.item, n: 1 });
    }
    cells.push({
      g, guns: list,
      left: left === g || (left === GROUP_ALL && list.length > 0),
      right: right === g || (right === GROUP_ALL && rightGuns && list.length > 0),
      leftPicked: left === g, rightPicked: right === g,
    });
  }
  return { cells, left, right, armed: guns.length > 0 };
}

/** Everything the row draws from, as one string: redraw only when it changes */
export function groupRowKey(v: GroupRowView): string {
  let s = `${v.left}|${v.right}`;
  for (const c of v.cells) s += `;${c.left ? 1 : 0}${c.right ? 1 : 0}` + c.guns.map((x) => `,${x.item}*${x.n}`).join('');
  return s;
}

/** How many weapon icons a group shows before "+n" */
export const ROW_ICONS = 3;

/** A group's tooltip: "Group 2: Pip Cannon ×2, Needle" and what the buttons do */
export function groupTip(c: GroupCell, fnName: (fn: string) => string): string {
  const what = c.guns.length ? c.guns.map((x) => `${fnName(x.fn)}${x.n > 1 ? ` ×${x.n}` : ''}`).join(', ') : 'empty';
  const on = c.leftPicked && c.rightPicked ? 'On both buttons. ' : c.leftPicked ? 'On the left button. ' : c.rightPicked ? 'On the right button. ' : '';
  return `Group ${c.g}: ${what}. ${on}Click: left button fires it. Right-click: right button. Again: back to all.`;
}
