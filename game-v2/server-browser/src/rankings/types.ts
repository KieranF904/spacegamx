/**
 * Rankings kept per account where the accounts are:
 *   - JsonRankingStore      (local dev: data/lobby/rankings.json)
 *   - PostgresRankingStore  (production: the `ranking_rows` table in ../../schema.sql)
 * One row per account (RankRecord in board.ts). The lobby is the only writer and runs its changes one at a time
 * (Serial, shared with the friends' stores), so a change never races another.
 */
import type { RankRecord } from './board.js';

export interface RankingStore {
  /** These accounts' rows (accounts with none are left out) */
  get(userIds: number[]): Promise<Map<number, RankRecord>>;
  /** Every row (the boards are made from them) */
  all(): Promise<RankRecord[]>;
  /** Save these rows, replacing any the accounts had */
  put(rows: RankRecord[]): Promise<void>;
  /** An account is gone: off the boards */
  forgetUser(userId: number): Promise<void>;
  close(): Promise<void>;
}
