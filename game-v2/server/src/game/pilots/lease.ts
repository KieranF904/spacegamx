/**
 * @contract server.pilots.lease
 * owns:       holding the profile lease for each logged-in pilot: claim at login, renew while on, release on leaving
 * needs:      Pilots (sessions, store, opts, now), ProfileStore (optional lease methods), profile/lease
 * invariants: a pilot's lease is kept only while some session of their account is on this server — server/src/game/pilots/lease.test.ts
 *             a lease whose save failed is not released (it expires instead, so no server loads a stale profile) — server/src/game/pilots/lease.test.ts
 * extend:     none: the lease rules live in profile/lease.ts, this only calls them at the right moments
 */

import { LEASE_MS, LEASE_RENEW_MS, serverIdFromEnv, type LeaseResult } from '../../profile/lease.js';
import type { Pilots } from '../Pilots.js';

export function serverId(self: Pilots): string {
  return self.opts.serverId ?? (self.opts.serverId = serverIdFromEnv());
}

/** Take the account for this server; a store with no leases (or one that errs) is... refused only on an error */
export async function claim(self: Pilots, userId: number): Promise<LeaseResult> {
  if (!self.store.claimLease) return { ok: true };
  try {
    const r = await self.store.claimLease(userId, serverId(self), self.opts.leaseMs ?? LEASE_MS);
    if (r.ok) self.leaseAt.set(userId, self.now());
    return r;
  } catch (e) {
    console.error(`[Pilots] could not claim the lease of ${userId}:`, e);
    return { ok: false, holder: '' };
  }
}

/** Give the account up, unless another session of it is still here */
export async function release(self: Pilots, userId: number): Promise<void> {
  self.leaseAt.delete(userId);
  if (!self.store.releaseLease) return;
  for (const s of self.sessions.values()) if (s.conn.userId === userId) return;
  try {
    await self.store.releaseLease(userId, serverId(self));
  } catch (e) {
    console.error(`[Pilots] could not release the lease of ${userId}:`, e); // (it expires by itself)
  }
}

/** Once per tick: every ~LEASE_RENEW_MS push out the expiry of every pilot here */
export function renewDue(self: Pilots): void {
  if (!self.store.renewLeases || self.leasesRenewing) return;
  const now = self.now();
  if (now - self.leasesRenewedAt < (self.opts.leaseRenewMs ?? LEASE_RENEW_MS)) return;
  self.leasesRenewedAt = now;
  const ids = [...new Set([...self.sessions.values()].map((s) => s.conn.userId).filter((u): u is number => u !== null))];
  if (!ids.length) return;
  self.leasesRenewing = true;
  self.store.renewLeases(ids, serverId(self), self.opts.leaseMs ?? LEASE_MS)
    .then((kept) => {
      const lost = ids.filter((u) => !kept.includes(u));
      if (lost.length) console.error(`[Pilots] lease lost for accounts ${lost.join(', ')}`);
    })
    .catch((e) => console.error('[Pilots] lease renewal failed:', e))
    .finally(() => { self.leasesRenewing = false; });
}
