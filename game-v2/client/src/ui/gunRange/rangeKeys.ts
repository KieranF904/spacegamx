/**
 * @contract client.gun-range.keys
 * owns:       which keys do something else, or nothing, in the gun range: the inventory key folds the weapon picker; the
 *             build view, fabricator, refiner, dock / hangar, jump and quick bar keys are refused with a line saying why
 * needs:      input/keybindings actionKey (the quick bar's keys); app/keys.ts runs it after the modal chain while inGunRange()
 * invariants: flying, firing, the weapon groups' keys (1-5 and the rest), targeting, the map, chat, respawn and the interact key (the
 *             doors) are never taken — client/src/ui/gunRange/rangeKeys.test.ts
 * extend:     a new key the range takes is one entry in RANGE_KEYS
 *
 * The server refuses all of it anyway (server game/gunRange/messageGate.ts): this only says so at once, and never sends.
 */

import { actionKey } from '../../input/keybindings';

export type RangeKey = { fold: true } | { say: string };

const NO_BUILD = "You can't build in the gun range. Nothing made here can leave it";
const RANGE_KEYS: Readonly<Record<string, RangeKey>> = {
  // I: the weapon picker, folded or open (there is no hold in here)
  KeyI: { fold: true },
  // 7, 8, 9: the build view and the field machines
  Digit7: { say: NO_BUILD }, Digit8: { say: NO_BUILD }, Digit9: { say: NO_BUILD },
  // H: no station, no hangar
  KeyH: { say: 'No hangar in the gun range. Fly to the exit door to go back to your station' },
  // J: the range ship has no jump drive
  KeyJ: { say: 'No jump drive in the gun range. The exit door takes you back' },
};

/**
 * The quick bar's keys: its actions' default codes (input/keybindings.ts quick1..quick5: C V B N M), as app/keys.ts has
 * them. 1-5 are the weapon groups', in the range as anywhere: never taken here.
 */
const QUICK = new Set([1, 2, 3, 4, 5].map((n) => actionKey(`quick${n}`)));

/** What a key does in the gun range instead of its usual (null: its usual) */
export function rangeKey(code: string): RangeKey | null {
  if (QUICK.has(code)) return { say: 'Your items stay outside the gun range' };
  return Object.hasOwn(RANGE_KEYS, code) ? RANGE_KEYS[code] : null;
}
