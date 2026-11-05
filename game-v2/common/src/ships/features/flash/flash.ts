/**
 * The Flash Screen's numbers (docs/design/rework-2026-11.md section 5): a shield with no slow refill. When the ship's
 * shield breaks, the Flash Screens' share (`FlashInfo.max`) comes back whole after `FLASH_RESTORE_TICKS`, or at once if
 * the Capacitor banks touching a Flash Screen can pay `FLASH_BANK_COST` energy a point (taken from them). Pure maths;
 * the waiting is the server half (server/src/ships/features/flash).
 */

/** How long a broken Flash Screen takes to return (4 seconds) */
export const FLASH_RESTORE_TICKS = 240;
/** Energy a Capacitor bank pays for each point of shield it brings back at once */
export const FLASH_BANK_COST = 4;

/** What a ship's Flash Screens give: the shield points they hold between them (counted in shieldMax) and the live parts */
export interface FlashInfo {
  max: number;
  parts: number[];
}

declare module '../types.js' {
  interface FeatureDerived { flash?: FlashInfo }
}

/**
 * Pays for an instant return: `held` is what each touching bank holds (energy), `max` the points to bring back. Takes
 * from the banks in order and writes what is left of each into `left`; returns whether it could pay in full (`left`
 * is untouched when it could not).
 */
export function flashPay(held: readonly number[], max: number, left: number[]): boolean {
  let owe = max * FLASH_BANK_COST, total = 0;
  for (let i = 0; i < held.length; i++) total += held[i];
  if (owe <= 0 || total + 1e-9 < owe) return false;
  for (let i = 0; i < held.length; i++) {
    const take = Math.min(held[i], owe);
    left[i] = held[i] - take;
    owe -= take;
  }
  return true;
}
