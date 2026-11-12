/**
 * The HUD's weapon group row: which weapons each of the five groups shows, and which groups the left and the right
 * button are marked on, for "all" and for a picked group.
 */
import { describe, expect, it } from 'vitest';
import { packGroupSel } from '@space-game/common';
import { ROW_ICONS, groupRowKey, groupRowView, groupTip, type RowGun } from './groupRowModel';

const gun = (fn: string, wg: number): RowGun => ({ fn, item: `part:iron:${fn}:a`, wg });
// Two cannons in group 1, a laser in 2, a launcher in 2 and 5, a flak gun in no group (it fires on "all" only)
const GUNS = [gun('cannon', 1), gun('cannon', 1), gun('laser', 2), gun('launcher', 2 | 16), gun('flak', 0)];
const marks = (sel: number, miners = false) => {
  const v = groupRowView(GUNS, sel, miners);
  return { l: v.cells.filter((c) => c.left).map((c) => c.g), r: v.cells.filter((c) => c.right).map((c) => c.g) };
};

describe('groupRowView', () => {
  it('five cells, each with its weapons by model, counted; a weapon in two groups shows in both', () => {
    const v = groupRowView(GUNS, 0, false);
    expect(v.cells.map((c) => c.g)).toEqual([1, 2, 3, 4, 5]);
    expect(v.cells.map((c) => c.guns.map((x) => `${x.fn}*${x.n}`))).toEqual([['cannon*2'], ['laser*1', 'launcher*1'], [], [], ['launcher*1']]);
    expect(v.armed).toBe(true);
    expect(groupRowView([], 0, false).armed).toBe(false);
  });

  it('all / all: both buttons mark every group that has a weapon, and none is "picked"', () => {
    expect(marks(0)).toEqual({ l: [1, 2, 5], r: [1, 2, 5] });
    const v = groupRowView(GUNS, 0, false);
    expect(v.left).toBe(0);
    expect(v.right).toBe(0);
    expect(v.cells.some((c) => c.leftPicked || c.rightPicked)).toBe(false);
  });

  it('a button on a group marks that group alone, even an empty one', () => {
    expect(marks(packGroupSel(2, 0))).toEqual({ l: [2], r: [1, 2, 5] });
    expect(marks(packGroupSel(0, 5))).toEqual({ l: [1, 2, 5], r: [5] });
    expect(marks(packGroupSel(3, 4))).toEqual({ l: [3], r: [4] });
    const v = groupRowView(GUNS, packGroupSel(1, 5), false);
    expect(v.cells.map((c) => [c.leftPicked, c.rightPicked])).toEqual([[true, false], [false, false], [false, false], [false, false], [false, true]]);
    expect([v.left, v.right]).toEqual([1, 5]);
  });

  it('a mining ship: the right button on "all" mines, so it marks no group until it is put on one', () => {
    expect(marks(0, true)).toEqual({ l: [1, 2, 5], r: [] });
    expect(marks(packGroupSel(0, 2), true)).toEqual({ l: [1, 2, 5], r: [2] });
  });

  it('the redraw key changes with the selection and with the weapons, and only then', () => {
    const k = (guns: RowGun[], sel: number) => groupRowKey(groupRowView(guns, sel, false));
    expect(k(GUNS, 0)).toBe(k(GUNS.slice(), 0));
    expect(k(GUNS, packGroupSel(1, 0))).not.toBe(k(GUNS, 0));
    expect(k(GUNS, packGroupSel(0, 1))).not.toBe(k(GUNS, packGroupSel(1, 0)));
    expect(k(GUNS.slice(1), 0)).not.toBe(k(GUNS, 0));
    expect(k([...GUNS.slice(0, 4), gun('flak', 8)], 0)).not.toBe(k(GUNS, 0));
  });

  it('the tooltip names the weapons and the buttons', () => {
    const v = groupRowView(GUNS, packGroupSel(1, 3), false);
    const name = (fn: string) => fn.toUpperCase();
    expect(groupTip(v.cells[0], name)).toBe('Group 1: CANNON ×2. On the left button. Click: left button fires it. Right-click: right button. Again: back to all.');
    expect(groupTip(v.cells[2], name)).toContain('Group 3: empty. On the right button.');
    expect(groupTip(v.cells[1], name)).toContain('Group 2: LASER, LAUNCHER. Click');
    expect(ROW_ICONS).toBeGreaterThan(0);
  });
});
