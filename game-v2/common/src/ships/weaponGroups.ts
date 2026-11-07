/**
 * Weapon groups (docs/design/groups-mines-docking.md, "Weapon groups"). Each weapon is in any of four groups (a blueprint
 * part's `wg`, a 4-bit mask: bit 0 = group 1). The pilot picks the group the left button fires and the one the right
 * button fires; 0 means "all", which is how every ship fired before groups: the left button fires every weapon, the
 * right button fires every weapon too (or mines, on a ship with mining lasers). So a pilot who never touches groups
 * fires exactly as before.
 *
 * The selection is one byte of input state (ClientInputMessage.weaponGroups, the Input component's `weaponGroups`), sent
 * only when it changes, at an input's target tick like any other control; firing itself is unchanged (no delay).
 * Pure and deterministic: the server's gun step, the pilot's prediction and other ships' gun lanes all read it here.
 */

import type { PlacedPart } from './types.js';

/** How many groups there are (1..WEAPON_GROUPS) */
export const WEAPON_GROUPS = 4;
/** A part's mask when it has no `wg`: group 1 only */
export const DEFAULT_WEAPON_GROUPS = 1;
/** Every group's bit */
export const ALL_GROUP_BITS = (1 << WEAPON_GROUPS) - 1;
/** A selection of "all" (either button) */
export const GROUP_ALL = 0;

/** A part's group mask (0..15; absent: group 1) */
export function partWeaponGroups(p: Pick<PlacedPart, 'wg'> | undefined): number {
  const v = p?.wg;
  return v === undefined ? DEFAULT_WEAPON_GROUPS : v & ALL_GROUP_BITS;
}

/** A design's `wg` as kept (canonical): a whole 0..15 other than the default, else absent */
export function cleanWeaponGroups(v: unknown): number | undefined {
  if (!Number.isInteger(v)) return undefined;
  const m = (v as number) & ALL_GROUP_BITS;
  return (v as number) >= 0 && (v as number) <= ALL_GROUP_BITS && m !== DEFAULT_WEAPON_GROUPS ? m : undefined;
}

/** In group g (1..4)? */
export const inGroup = (mask: number, g: number): boolean => g >= 1 && g <= WEAPON_GROUPS && (mask & (1 << (g - 1))) !== 0;

/** The selection as one byte: the left button's group (0 all, 1..4) in the low nibble, the right button's in the high */
export function packGroupSel(left: number, right: number): number {
  return (clampSel(left) | (clampSel(right) << 4)) & 0xff;
}
export const selLeft = (packed: number): number => clampSel(packed & 0x0f);
export const selRight = (packed: number): number => clampSel((packed >> 4) & 0x0f);
const clampSel = (g: number): number => (Number.isInteger(g) && g >= 0 && g <= WEAPON_GROUPS ? g : GROUP_ALL);

/** A selection byte from anything a client sent (junk: both "all") */
export function cleanGroupSel(v: unknown): number {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 0xff ? packGroupSel(n & 0x0f, (n >> 4) & 0x0f) : 0;
}

/** The next selection when cycling: all, 1, 2, 3, 4, all... (`dir` -1 goes back) */
export function cycleSel(g: number, dir: 1 | -1 = 1): number {
  const n = WEAPON_GROUPS + 1;
  return (((clampSel(g) + dir) % n) + n) % n;
}

/**
 * Does the right button fire guns (true) or the mining lasers (false)? As before groups: a ship with mining lasers
 * mines on the right button when it is on "all"; set to a group, the right button fires that group instead.
 */
export const rightFiresGuns = (sel: number, hasMiners: boolean): boolean => selRight(sel) !== GROUP_ALL || !hasMiners;

/**
 * Is this gun's trigger down: the left button held and the gun in the left selection, or the right button held, firing
 * guns, and the gun in the right selection. With both selections "all" (the default) this is `left || right` for every
 * gun (right only on a ship without mining lasers), exactly the old rule.
 */
export function gunTriggered(mask: number, left: boolean, right: boolean, sel: number, hasMiners: boolean): boolean {
  if (left) { const g = selLeft(sel); if (g === GROUP_ALL || inGroup(mask, g)) return true; }
  if (right && rightFiresGuns(sel, hasMiners)) { const g = selRight(sel); if (g === GROUP_ALL || inGroup(mask, g)) return true; }
  return false;
}

/**
 * The trigger word a tick's guns step on (GunState / ShipState `trig`, a gun row's bits): left 1, right 2, the selection
 * byte from bit 2. A gun's trigger last tick is gunTriggered on last tick's word, so turret slew and semi-automatic
 * clicks ("held through from the tick before") work per gun with one number of state.
 */
export const TRIG_LEFT = 1;
export const TRIG_RIGHT = 2;
export const TRIG_SEL_SHIFT = 2;
/** A trigger word's button bits: "a trigger is held" is `word & TRIG_BUTTONS`; the selection above them is not a trigger */
export const TRIG_BUTTONS = TRIG_LEFT | TRIG_RIGHT;
export function trigWord(left: boolean, right: boolean, sel: number): number {
  return (left ? TRIG_LEFT : 0) | (right ? TRIG_RIGHT : 0) | ((sel & 0xff) << TRIG_SEL_SHIFT);
}
export const trigSel = (word: number): number => (word >> TRIG_SEL_SHIFT) & 0xff;
/** gunTriggered on a trigger word */
export function gunTriggeredBy(mask: number, word: number, hasMiners: boolean): boolean {
  return gunTriggered(mask, (word & TRIG_LEFT) !== 0, (word & TRIG_RIGHT) !== 0, trigSel(word), hasMiners);
}

/**
 * Is this gun in a group a button would fire (whatever is held)? A semi-automatic gun answers a buffered click only while
 * selected. With both selections "all" every gun is (the right button's guns only where it fires guns, which "all" on the
 * left already covers)
 */
export function gunSelected(mask: number, sel: number, hasMiners: boolean): boolean {
  const l = selLeft(sel);
  if (l === GROUP_ALL || inGroup(mask, l)) return true;
  const r = selRight(sel);
  return rightFiresGuns(sel, hasMiners) && (r === GROUP_ALL || inGroup(mask, r));
}
