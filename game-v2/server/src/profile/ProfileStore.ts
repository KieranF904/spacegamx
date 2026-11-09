/**
 * ProfileStore: where pilots' progress is kept between sessions.
 *
 * One document per account (see PlayerProfile in common/src/econ/profile.ts).
 * Implementations:
 *   - JsonProfileStore      (default: data/profiles/<userId>.json)
 *   - PostgresProfileStore  (USER_STORE_BACKEND=postgres + DATABASE_URL: the
 *                            `profiles` table in schema.sql, data as jsonb)
 *
 * Stores hand back raw JSON; the game runs it through migrateProfile(), so a
 * store never needs to know the profile's shape or version.
 */

import { LocalLeases, type ProfileLeases } from './lease.js';

export interface ProfileStore extends Partial<ProfileLeases> {
  /** The saved document, or null for an account that has never played */
  load(userId: number): Promise<unknown | null>;
  save(userId: number, profile: unknown): Promise<void>;
  /** Forget an account's save for good (its account was deleted); nothing if there is none */
  delete(userId: number): Promise<void>;
  /** Game-wide documents (the rankings), by name */
  loadDoc(key: string): Promise<unknown | null>;
  saveDoc(key: string, doc: unknown): Promise<void>;
  /** Flush pending writes and release resources */
  close(): Promise<void>;
}

/** Keeps nothing (guests, tests, proto mode) */
export class MemoryProfileStore implements ProfileStore {
  private leases = new LocalLeases();
  claimLease: ProfileLeases['claimLease'] = (u, s, t) => this.leases.claimLease(u, s, t);
  renewLeases: ProfileLeases['renewLeases'] = (u, s, t) => this.leases.renewLeases(u, s, t);
  releaseLease: ProfileLeases['releaseLease'] = (u, s) => this.leases.releaseLease(u, s);
  private docs = new Map<number, string>();
  async load(userId: number): Promise<unknown | null> {
    const d = this.docs.get(userId);
    return d ? JSON.parse(d) : null;
  }
  async save(userId: number, profile: unknown): Promise<void> {
    this.docs.set(userId, JSON.stringify(profile));
  }
  async delete(userId: number): Promise<void> {
    this.docs.delete(userId);
  }
  private named = new Map<string, string>();
  async loadDoc(key: string): Promise<unknown | null> {
    const d = this.named.get(key);
    return d ? JSON.parse(d) : null;
  }
  async saveDoc(key: string, doc: unknown): Promise<void> {
    this.named.set(key, JSON.stringify(doc));
  }
  async close(): Promise<void> {}
}
