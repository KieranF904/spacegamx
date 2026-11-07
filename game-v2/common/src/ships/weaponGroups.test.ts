import { describe, it, expect } from 'vitest';
import {
  partWeaponGroups, cleanWeaponGroups, packGroupSel, selLeft, selRight, cleanGroupSel, cycleSel, gunTriggered,
  gunTriggeredBy, trigWord, rightFiresGuns, GROUP_ALL,
} from './weaponGroups.js';
import { parseBlueprint, serializeBlueprint } from './blueprint.js';

describe('weapon groups', () => {
  it('a part with no wg is in group 1; masks keep four bits; the default is dropped when saved', () => {
    expect(partWeaponGroups({})).toBe(1);
    expect(partWeaponGroups({ wg: 0b1010 })).toBe(0b1010);
    expect(partWeaponGroups({ wg: 0 })).toBe(0);
    expect(cleanWeaponGroups(1)).toBeUndefined();
    expect(cleanWeaponGroups(0)).toBe(0);
    expect(cleanWeaponGroups(15)).toBe(15);
    expect(cleanWeaponGroups(16)).toBeUndefined();
    expect(cleanWeaponGroups(-1)).toBeUndefined();
    expect(cleanWeaponGroups('3')).toBeUndefined();
  });

  it('the selection byte: left low nibble, right high; junk is "all"', () => {
    const s = packGroupSel(3, 2);
    expect(s).toBe(0x23);
    expect(selLeft(s)).toBe(3);
    expect(selRight(s)).toBe(2);
    expect(packGroupSel(9, -1)).toBe(0);
    expect(cleanGroupSel(0x45)).toBe(0x40);
    expect(cleanGroupSel('x')).toBe(0);
    expect(cleanGroupSel(300)).toBe(0);
    expect([0, 1, 2, 3, 4].map((g) => cycleSel(g))).toEqual([1, 2, 3, 4, 0]);
    expect(cycleSel(0, -1)).toBe(4);
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
