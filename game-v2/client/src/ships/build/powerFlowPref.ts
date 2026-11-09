/**
 * @contract client.ships.build-power-flow-pref
 * owns:       the one remembered choice of the power flow overlay (on or off), shared by the hangar and the world build view
 * needs:      browser localStorage (optional: blocked storage just means the choice is not kept)
 * invariants: the default is off, and a blocked or broken store reads as off — client/src/ships/build/powerFlow.test.ts
 * extend:     none; a second power-flow setting would be another key here
 */

const KEY = 'sg.build.powerFlow';

type Store = Pick<Storage, 'getItem' | 'setItem'>;

function safeStorage(): Store | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Was the overlay left on? Off unless the player turned it on */
export function loadPowerFlow(storage: Store | null = safeStorage()): boolean {
  try {
    return storage?.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function savePowerFlow(on: boolean, storage: Store | null = safeStorage()): void {
  try {
    storage?.setItem(KEY, on ? '1' : '0');
  } catch { /* blocked storage: the choice just isn't kept */ }
}
