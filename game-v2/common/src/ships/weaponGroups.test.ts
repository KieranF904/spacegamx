import { describe, it, expect } from 'vitest';
import {
  partWeaponGroups, cleanWeaponGroups, packGroupSel, selLeft, selRight, cleanGroupSel, cycleSel, gunTriggered,
  gunTriggeredBy, trigWord, rightFiresGuns, GROUP_ALL, WEAPON_GROUPS, ALL_GROUP_BITS, EVERY_MASK, inGroup, freshMasks, clickCalls,
  gunSelected, trigSel,
} from './weaponGroups.js';
import { parseBlueprint, serializeBlueprint } from './blueprint.js';

describe('weapon groups', () => {
  it('a part with no wg is in group 1; masks keep five bits; the default is dropped when saved', () => {
    expect(partWeaponGroups({})).toBe(1);
    expect(partWeaponGroups({ wg: 0b1010 })).toBe(0b1010);
    expect(partWeaponGroups({ wg: 0 })).toBe(0);
    expect(cleanWeaponGroups(1)).toBeUndefined();
    expect(cleanWeaponGroups(0)).toBe(0);
    expect(cleanWeaponGroups(15)).toBe(15);
    expect(cleanWeaponGroups(16)).toBe(16);
    expect(cleanWeaponGroups(31)).toBe(31);
    expect(cleanWeaponGroups(32)).toBeUndefined();
    expect(partWeaponGroups({ wg: 0b10000 })).toBe(0b10000);
    expect(partWeaponGroups({ wg: 0b100001 })).toBe(1);
    expect(cleanWeaponGroups(-1)).toBeUndefined();
    expect(cleanWeaponGroups('3')).toBeUndefined();
  });

  it('the selection byte: left low nibble, right high; junk is "all"', () => {
    const s = packGroupSel(3, 2);
    expect(s).toBe(0x23);
    expect(selLeft(s)).toBe(3);
    expect(selRight(s)).toBe(2);
    expect(packGroupSel(9, -1)).toBe(0);
    expect(cleanGroupSel(0x45)).toBe(0x45);
    expect(cleanGroupSel(0x56)).toBe(0x50);
    expect(cleanGroupSel(0x65)).toBe(0x05);
    expect(cleanGroupSel('x')).toBe(0);
    expect(cleanGroupSel(300)).toBe(0);
    expect([0, 1, 2, 3, 4, 5].map((g) => cycleSel(g))).toEqual([1, 2, 3, 4, 5, 0]);
    expect(cycleSel(0, -1)).toBe(5);
  });

  it('five groups: every left / right pair packs into the one byte and comes back', () => {
    expect(WEAPON_GROUPS).toBe(5);
    expect(ALL_GROUP_BITS).toBe(31);
    const seen = new Set<number>();
    for (let l = 0; l <= WEAPON_GROUPS; l++) for (let r = 0; r <= WEAPON_GROUPS; r++) {
      const s = packGroupSel(l, r);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(0xff);
      expect([selLeft(s), selRight(s)]).toEqual([l, r]);
      expect(cleanGroupSel(s)).toBe(s);
      expect(trigSel(trigWord(true, true, s))).toBe(s);
      seen.add(s);
    }
    expect(seen.size).toBe(36);
    expect(packGroupSel(6, 6)).toBe(0);
  });

  it('group 5 fires only its members', () => {
    const five = 0b10000;
    expect(inGroup(five, 5)).toBe(true);
    expect(inGroup(five, 6)).toBe(false);
    expect(inGroup(0b01111, 5)).toBe(false);
    const sel = packGroupSel(5, 1);
    expect(gunTriggered(five, true, false, sel, false)).toBe(true);
    expect(gunTriggered(0b00001, true, false, sel, false)).toBe(false);
    expect(gunTriggered(0b00001, false, true, sel, false)).toBe(true);
    expect(gunTriggered(five, false, true, packGroupSel(0, 5), true)).toBe(true);
    expect(gunSelected(five, packGroupSel(5, 5), false)).toBe(true);
    expect(gunSelected(0b01111, packGroupSel(5, 5), false)).toBe(false);
  });

  it('click masks cover all 32 group masks as one whole number, never negative', () => {
    expect(EVERY_MASK).toBe(4294967295);
    // (A trigger-down with both selections "all": every mask's guns, the one "every gun" number)
    expect(freshMasks(trigWord(true, false, 0), 0, false)).toBe(EVERY_MASK);
    // (Left on group 5: the sixteen masks with bit 4, the top half, mask 31 among them)
    const top = freshMasks(trigWord(true, false, packGroupSel(5, 0)), 0, true);
    expect(top).toBe(0xffff0000);
    expect(top).toBeGreaterThan(0);
    for (let m = 0; m <= ALL_GROUP_BITS; m++) {
      expect(clickCalls(top, m)).toBe(m >= 16);
      expect(clickCalls(EVERY_MASK, m)).toBe(true);
      expect(clickCalls(undefined, m)).toBe(true);
    }
    expect(((top | 1) >>> 0)).toBe(0xffff0001);
  });

  it('both selections "all" fire every gun on either button, as before groups (the right button mines on a mining ship)', () => {
    for (const mask of [0, 1, 6, 15]) {
      expect(gunTriggered(mask, true, false, 0, false)).toBe(true);
      expect(gunTriggered(mask, false, true, 0, false)).toBe(true);
      expect(gunTriggered(mask, false, true, 0, true)).toBe(false);
      expect(gunTriggered(mask, false, false, 0, false)).toBe(false);
    }
    expect(rightFiresGuns(0, true)).toBe(false);
    expect(rightFiresGuns(packGroupSel(GROUP_ALL, 2), true)).toBe(true);
  });

  it('a group fires only its members; a weapon in several groups fires with any of them', () => {
    const sel = packGroupSel(1, 3);
    expect(gunTriggered(0b0001, true, false, sel, false)).toBe(true);
    expect(gunTriggered(0b0100, true, false, sel, false)).toBe(false);
    expect(gunTriggered(0b0100, false, true, sel, false)).toBe(true);
    expect(gunTriggered(0b0101, true, false, sel, true)).toBe(true);
    expect(gunTriggered(0b0101, false, true, sel, true)).toBe(true);
    expect(gunTriggered(0b0010, true, true, sel, false)).toBe(false);
  });

  it('the trigger word carries the buttons and the selection', () => {
    const w = trigWord(true, false, packGroupSel(2, 4));
    expect(gunTriggeredBy(0b0010, w, false)).toBe(true);
    expect(gunTriggeredBy(0b1000, w, false)).toBe(false);
    expect(trigWord(true, true, 0)).toBe(3);
  });

  it('a design keeps its weapons\' groups through save and load', () => {
    const bp = { name: 't', catalogVersion: 1, parts: [{ uid: 1, piece: 'sq', fn: 'cannon_pip', material: 'alloy', x: 0, y: 0, rot: 0 as const, flip: false, facing: 'N' as const, wg: 6 }] };
    const back = parseBlueprint(serializeBlueprint(bp));
    expect(back.parts[0].wg).toBe(6);
  });
});
