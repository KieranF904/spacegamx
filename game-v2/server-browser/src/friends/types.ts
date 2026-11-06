/**
 * Friends, friend requests and the saved status, kept per account where the accounts are:
 *   - JsonFriendStore      (local dev: data/lobby/friends.json)
 *   - PostgresFriendStore  (production: the `friend_lists` table in ../../schema.sql)
 *
 * One record per account (FriendLists in lists.ts): both stores hold the same fields. Changes go through update(),
 * which hands the rules (lists.ts) the records of the accounts involved and writes back the ones that changed. The
 * lobby is one process, and each store runs its updates one at a time, so a change never races another.
 */

import type { FriendLists, Lists } from './lists.js';

export interface FriendStore {
  /** The account's record (null: none yet, which reads as no friends and Online) */
  get(userId: number): Promise<FriendLists | null>;
  /**
   * Run `fn` on the records of these accounts (made empty when they have none; `had` says which already had one)
   * and save the ones it changed. One update at a time.
   */
  update<T>(userIds: number[], fn: (lists: Lists, had: Set<number>) => T): Promise<T>;
  /** Usernames of these accounts (accounts that no longer exist are left out) */
  names(userIds: number[]): Promise<Map<number, string>>;
  /** An account is gone: its record and every mention of it go (Postgres drops the row by ON DELETE CASCADE too) */
  forgetUser(userId: number): Promise<void>;
  close(): Promise<void>;
}

/** Runs async jobs one at a time, in order (a failed job doesn't stop the next) */
export class Serial {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(job: () => Promise<T>): Promise<T> {
    const next = this.tail.then(job, job);
    this.tail = next.catch(() => {});
    return next;
  }
  /** Waits for what's queued */
  idle(): Promise<void> {
    return this.tail.then(() => {});
  }
}
