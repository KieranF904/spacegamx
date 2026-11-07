/**
 * The weapon group keys (input/keybindings.ts: groupPrev, groupNext, groupRight; the opt-in digits and mouse wheel).
 * Called by app/keys.ts with DEFAULT codes (InputManager has already mapped the player's rebinds onto them) and by
 * the input manager's wheel hook. Each returns true when it took the key.
 */
import { settings } from '../../settings/Settings';
import { fieldBridge } from '../field/bridge';
import { groupSelection } from './selection';

/** Comma, Period and Slash, and, if the setting is on, 1-5 (the quick bar's keys) */
export function groupKey(code: string): boolean {
  if (code === 'Comma') groupSelection.cycleLeft(-1);
  else if (code === 'Period') groupSelection.cycleLeft(1);
  else if (code === 'Slash') groupSelection.cycleRight(1);
  // (The build overlay's own 1-4 set a weapon's groups: the digits are its while it is open)
  else if (settings.data.gameplay.digitGroups && !fieldBridge.overlay?.isOpen && /^Digit[1-5]$/.test(code)) groupSelection.pickLeft(code === 'Digit5' ? 0 : Number(code.slice(5)));
  else return false;
  // (No message: the chip by the weapon ring shows the new selection)
  return true;
}

/** The mouse wheel as a group change (when the setting is on): true when taken, so it does not zoom as well */
export function groupWheel(deltaY: number): boolean {
  if (!settings.data.gameplay.wheelGroups || deltaY === 0) return false;
  groupSelection.cycleLeft(deltaY > 0 ? 1 : -1);
  return true;
}
