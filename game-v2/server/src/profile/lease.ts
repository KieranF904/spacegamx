/**
 * @contract server.profile.lease
 * owns:       the profile lease: which game server holds an account right now (types, the in-process table, the server id)
 * needs:      ProfileStore implementers (JsonProfileStore, MemoryProfileStore, PostgresProfileStore); npm: os
 * invariants: one holder per account at a time; a holder that stops renewing loses it after LEASE_MS — server/src/profile/lease.test.ts
 *             a server may always re-claim an account it holds itself — server/src/profile/lease.test.ts
 * extend:     another backend implements ProfileLeases (claimLease, renewLeases, releaseLease) on its store
 */

import { hostname } from 'os';

/** A stale lease (its server crashed or was suspended without releasing) is free after this long */
export const LEASE_MS = 90_000;
/** A server renews the leases of its pilots this often */
export const LEASE_RENEW_MS = 30_000;

export type LeaseResult = { ok: true } | { ok: false; holder: string };

/** What a store offers for one-server-per-account; optional, so a store without it means one server and no contention */
export interface ProfileLeases {
  /** Take the account for `serverId` (or keep it); refused while another server holds an unexpired lease */
  claimLease(userId: number, serverId: string, ttlMs?: number): Promise<LeaseResult>;
  /** Push the expiry out for the accounts `serverId` still holds; returns those it still holds */
  renewLeases(userIds: number[], serverId: string, ttlMs?: number): Promise<number[]>;
  /** Give the account up (only if `serverId` holds it) */
  releaseLease(userId: number, serverId: string): Promise<void>;
}

/** This server's id: SERVER_ID, else hostname:port */
export function serverIdFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return (env.SERVER_ID || '').trim() || `${hostname()}:${env.PORT || '3000'}`;
}

/** The in-process table (JSON and memory stores: one server, so it never refuses its own id) */
export class LocalLeases implements ProfileLeases {
  private held = new Map<number, { holder: string; until: number }>();
  constructor(private now: () => number = () => Date.now()) {}

  async claimLease(userId: number, serverId: string, ttlMs = LEASE_MS): Promise<LeaseResult> {
    const cur = this.held.get(userId);
    if (cur && cur.holder !== serverId && cur.until > this.now()) return { ok: false, holder: cur.holder };
    this.held.set(userId, { holder: serverId, until: this.now() + ttlMs });
    return { ok: true };
  }

  async renewLeases(userIds: number[], serverId: string, ttlMs = LEASE_MS): Promise<number[]> {
    const kept: number[] = [];
    for (const id of userIds) {
      const cur = this.held.get(id);
      if (!cur || cur.holder !== serverId) continue;
      cur.until = this.now() + ttlMs;
      kept.push(id);
    }
    return kept;
  }

  async releaseLease(userId: number, serverId: string): Promise<void> {
    if (this.held.get(userId)?.holder === serverId) this.held.delete(userId);
  }
}
