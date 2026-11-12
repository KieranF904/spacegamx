/**
 * The weapon group keys (input/keybindings.ts: group1..group5, groupPrev, groupNext, groupRight; the opt-in mouse wheel).
 * 1-5 set the group the left button fires, with Shift the right button's; the number of the group a button is already on
 * puts that button back on "all".
 * Called by app/keys.ts with DEFAULT codes (InputManager has already mapped the player's rebinds onto them) and by
 * the input manager's wheel hook. Each returns true when it took the key.
 */
import { settings } from '../../settings/Settings';
import { fieldBridge } from '../field/bridge';
import { groupSelection } from './selection';

/** The group a group key picks (Digit1..Digit5, the actions' default codes), or 0 */
export function groupKeyNumber(code: string): number {
  const m = /^Digit([1-5])$/.exec(code);
  return m ? Number(m[1]) : 0;
}

/** 1-5 (`shift`: a physical Shift is held, the right button's), Comma, Period and Slash */
export function groupKey(code: string, shift = false): boolean {
  const g = groupKeyNumber(code);
  if (code === 'Comma') groupSelection.cycleLeft(-1);
  else if (code === 'Period') groupSelection.cycleLeft(1);
  else if (code === 'Slash') groupSelection.cycleRight(1);
  // (The build overlay's own 1-5 set a weapon's groups: the digits are its while it is open)
  else if (g && !fieldBridge.overlay?.isOpen) groupSelection.press(shift ? 'right' : 'left', g);
  else return false;
  // (No message: the group row above the quick bar and the chip by the weapon ring show the new selection)
  return true;
}

/** The mouse wheel as a group change (when the setting is on): true when taken, so it does not zoom as well */
export function groupWheel(deltaY: number): boolean {
  if (!settings.data.gameplay.wheelGroups || deltaY === 0) return false;
  groupSelection.cycleLeft(deltaY > 0 ? 1 : -1);
  return true;
}
