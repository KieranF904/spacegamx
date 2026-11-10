/**
 * The Flash Screen's numbers (docs/design/rework-2026-11.md section 5): a shield with no slow refill. When the ship's
 * shield breaks, each Flash Screen whose own store is full spends it and is back at once; the rest come back whole after
 * `FLASH_RESTORE_TICKS`. The store is the part's buffer on the ports core (power/ports.ts PortsLayout.flash: it holds
 * FunctionDef.flashCost E a shield point and fills over the part's in port). Pure numbers and the payment; the waiting
 * is the server half (server/src/ships/features/flash).
 */

import type { PortsLayout, PortsState } from '../../power/portsTypes.js';

/** How long a broken Flash Screen takes to return without its store (4 seconds) */
export const FLASH_RESTORE_TICKS = 240;

/** What a ship's Flash Screens give: the shield points they hold between them (counted in shieldMax), the live parts and each one's points */
export interface FlashInfo {
  max: number;
  parts: number[];
  pts: number[];
}

declare module '../types.js' {
  interface FeatureDerived { flash?: FlashInfo }
}

/**
 * A Flash Screen's store pays for its return: true, and the store is emptied, when it is full (and holds anything at
 * all); false, and nothing is taken, otherwise. Integer eu: the server's decision, which its pilot hears as a correction
 */
export function flashPay(L: PortsLayout, e: PortsState, p: number): boolean {
  if (e.held.length !== L.n || !L.flash[p] || L.cap[p] <= 0 || e.held[p] < L.cap[p]) return false;
  e.held[p] = 0;
  return true;
}
