/**
 * The wire spool, retired: ships no longer take wire (power flows between parts that touch), so the item is gone from the
 * catalogue. A save is cleaned as it loads (econ/profile.ts migrateProfile): every spool held (hold, storage, quick bar,
 * a finished or running craft job, a fabricator order) is paid back as credits at the spool's craft value.
 * Idempotent: a profile with no spools changes nothing. Junk never throws.
 */

import type { PlayerProfile } from './profile.js';

export const WIRE_SPOOL_ID = 'wire_spool';
/** Credits per spool refunded: what it was worth (its recipe: 4 copper wire and 1 insulated polymer) */
export const WIRE_SPOOL_REFUND = 14;

/** Take every spool out of a profile and credit the refund; returns how many spools went */
export function retireWireSpools(p: Pick<PlayerProfile, 'cargo' | 'storage' | 'quickbar' | 'credits' | 'jobs' | 'fabOrders'>): number {
  let n = 0;
  for (const key of ['cargo', 'storage'] as const) {
    const list = p[key];
    if (!Array.isArray(list) || !list.some((s) => s.id === WIRE_SPOOL_ID)) continue;
    for (const s of list) if (s.id === WIRE_SPOOL_ID) n += Math.max(0, Math.floor(s.n) || 0);
    p[key] = list.filter((s) => s.id !== WIRE_SPOOL_ID);
  }
  p.quickbar = p.quickbar.map((id) => (id === WIRE_SPOOL_ID ? null : id));
  for (const j of p.jobs ?? []) {
    const k = j.out?.[WIRE_SPOOL_ID];
    if (typeof k === 'number' && k > 0) { n += Math.floor(k); delete j.out[WIRE_SPOOL_ID]; }
  }
  if (p.fabOrders?.some((o) => o.item === WIRE_SPOOL_ID)) {
    for (const o of p.fabOrders) if (o.item === WIRE_SPOOL_ID) n += Math.max(0, o.n - o.made);
    p.fabOrders = p.fabOrders.filter((o) => o.item !== WIRE_SPOOL_ID);
  }
  if (n > 0) p.credits += n * WIRE_SPOOL_REFUND;
  return n;
}
