/**
 * @contract client.gun-range.keys
 * owns:       which keys do something else, or nothing, in the gun range: the inventory key folds the weapon picker; the
 *             build view, fabricator, refiner, dock / hangar, jump and quick bar keys are refused with a line saying why
 * needs:      nothing (pure); app/keys.ts runs it after the modal chain while inGunRange()
 * invariants: flying, firing, groups, targeting, the map, chat, respawn and X (the door) are never taken — client/src/ui/gunRange/rangeKeys.test.ts
 * extend:     a new key the range takes is one entry in RANGE_KEYS
 *
 * The server refuses all of it anyway (server game/gunRange/messageGate.ts): this only says so at once, and never sends.
 */

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

/** The quick bar's keys (1-5), unless they pick weapon groups (Settings, Gameplay) */
const QUICK = new Set(['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5']);

/** What a key does in the gun range instead of its usual (null: its usual) */
export function rangeKey(code: string, opts: { digitGroups: boolean }): RangeKey | null {
  if (QUICK.has(code)) return opts.digitGroups ? null : { say: 'Your items stay outside the gun range' };
  return Object.hasOwn(RANGE_KEYS, code) ? RANGE_KEYS[code] : null;
}
