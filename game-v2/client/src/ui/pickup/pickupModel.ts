/**
 * @contract client.ui.pickup-model
 * owns:       what the pickup panel lists from the loot in reach: one row per item (all pods summed) with how much would fit and whether it eats whitelist-reserved space, and one row per wreck with its keeping
 * needs:      common econ/holdGhosts.ts (manualRoom: the server's own room rule), LootNearPod; no DOM
 * invariants: a locked wreck's items are not offered until its lock has run out; a row that cannot fit any is marked full — client/src/ui/pickup/pickupModel.test.ts
 *             rows sum an item over every takeable pod — client/src/ui/pickup/pickupModel.test.ts
 * extend:     a new row fact is one field on PickupRow, worked out in pickupRows
 */

import { manualRoom, type HoldGhost, type HoldView, type LootNearPod } from '@space-game/common';

export interface PickupRow {
  item: string;
  /** In reach, all pods summed */
  n: number;
  /** How many the hold takes now (0: full) */
  fit: number;
  /** Taking it would use space the whitelist keeps */
  reserved: boolean;
}
export interface WreckRow { id: number; mine: boolean; /** Seconds until anyone may take from it (0: open) */ lock: number; count: number }

/** Seconds a wreck's lock still has to run, `sinceMs` after it was told */
export const lockLeft = (p: LootNearPod, sinceMs: number) => Math.max(0, Math.ceil((p.lock ?? 0) - sinceMs / 1000));

/** The panel's rows: items in takeable pods (most first), then wrecks */
export function pickupRows(near: readonly LootNearPod[], hold: HoldView, ghosts: readonly HoldGhost[], sinceMs = 0): { rows: PickupRow[]; wrecks: WreckRow[] } {
  const sum = new Map<string, number>();
  const wrecks: WreckRow[] = [];
  for (const p of near) {
    const lock = lockLeft(p, sinceMs);
    const count = Object.values(p.items).reduce((t, n) => t + n, 0);
    if (p.mine || p.lock !== undefined) wrecks.push({ id: p.id, mine: !!p.mine, lock, count });
    if (lock > 0) continue;
    for (const [id, n] of Object.entries(p.items)) sum.set(id, (sum.get(id) ?? 0) + n);
  }
  const rows = [...sum].map(([item, n]) => {
    const r = manualRoom(hold, ghosts, item);
    const fit = Math.min(n, r.fit);
    return { item, n, fit, reserved: fit > r.fit - r.reserved };
  }).sort((a, b) => b.n - a.n || a.item.localeCompare(b.item));
  return { rows, wrecks };
}
