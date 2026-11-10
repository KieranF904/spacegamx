/**
 * The Flash Screen's numbers (docs/design/rework-2026-11.md section 5): a shield with no slow refill. When the ship's
 * shield breaks, the Flash Screens' share (`FlashInfo.max`) comes back whole after `FLASH_RESTORE_TICKS`. Pure numbers;
 * the waiting is the server half (server/src/ships/features/flash).
 */

/** How long a broken Flash Screen takes to return (4 seconds) */
export const FLASH_RESTORE_TICKS = 240;

/** What a ship's Flash Screens give: the shield points they hold between them (counted in shieldMax) and the live parts */
export interface FlashInfo {
  max: number;
  parts: number[];
}

declare module '../types.js' {
  interface FeatureDerived { flash?: FlashInfo }
}
