/**
 * PostgresFriendStore: friends in the `friend_lists` table (../../schema.sql), sharing the accounts' pool. One row per
 * account; the lists are id arrays. The table is made at start when it's missing (as schema.sql would), so a deploy
 * needn't re-apply the schema. Updates run one at a time in this process (the lobby is the only writer).
 */

import { cleanLists, emptyLists, isEmpty, type FriendLists, type Lists } from './lists.js';
import { Serial, type FriendStore } from './types.js';

interface PgPool {
  query(sql: string, params?: any[]): Promise<{ rows: any[] }>;
}

/** schema.sql's statements for the friends lists (run at start: IF NOT EXISTS) */
export const FRIENDS_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS friend_lists (
    user_id    BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    status     TEXT NOT NULL DEFAULT 'online',
    friends    BIGINT[] NOT NULL DEFAULT '{}',
    incoming   BIGINT[] NOT NULL DEFAULT '{}',
    outgoing   BIGINT[] NOT NULL DEFAULT '{}',
    updated_at BIGINT NOT NULL
  )`,
];

const toLists = (r: any): FriendLists => cleanLists({ status: r.status, friends: r.friends, in: r.incoming, out: r.outgoing }, Number(r.user_id));
const same = (a: FriendLists, b: FriendLists) => JSON.stringify(a) === JSON.stringify(b);

export class PostgresFriendStore implements FriendStore {
  private serial = new Serial();

  constructor(private pool: PgPool) {}

  static async create(pool: PgPool): Promise<PostgresFriendStore> {
    try {
      for (const sql of FRIENDS_SCHEMA) await pool.query(sql);
    } catch (e) {
      throw new Error(`The friends' "friend_lists" table is missing and this database user can't make it: run server-browser/schema.sql as the tables' owner (${e})`);
    }
    return new PostgresFriendStore(pool);
  }

  async get(userId: number): Promise<FriendLists | null> {
    const r = await this.pool.query('SELECT user_id, status, friends, incoming, outgoing FROM friend_lists WHERE user_id = $1', [userId]);
    return r.rows[0] ? toLists(r.rows[0]) : null;
  }

  update<T>(userIds: number[], fn: (lists: Lists, had: Set<number>) => T): Promise<T> {
    return this.serial.run(async () => {
      const ids = [...new Set(userIds)];
      const r = await this.pool.query('SELECT user_id, status, friends, incoming, outgoing FROM friend_lists WHERE user_id = ANY($1::bigint[])', [ids]);
      const before = new Map<number, FriendLists>(r.rows.map((row) => [Number(row.user_id), toLists(row)]));
      const lists: Lists = new Map(ids.map((id) => [id, before.has(id) ? structuredClone(before.get(id)!) : emptyLists()]));
      const out = fn(lists, new Set(before.keys()));
      const now = Date.now();
      for (const [id, l] of lists) {
        const b = before.get(id);
        if (b ? same(b, l) : isEmpty(l)) continue;
        await this.pool.query(
          `INSERT INTO friend_lists (user_id, status, friends, incoming, outgoing, updated_at) VALUES ($1, $2, $3::bigint[], $4::bigint[], $5::bigint[], $6)
           ON CONFLICT (user_id) DO UPDATE SET status = $2, friends = $3::bigint[], incoming = $4::bigint[], outgoing = $5::bigint[], updated_at = $6`,
          [id, l.status, l.friends, l.in, l.out, now]);
      }
      return out;
    });
  }

  async names(userIds: number[]): Promise<Map<number, string>> {
    const ids = [...new Set(userIds)];
    if (!ids.length) return new Map();
    const r = await this.pool.query('SELECT id, username FROM users WHERE id = ANY($1::bigint[])', [ids]);
    return new Map(r.rows.map((row) => [Number(row.id), String(row.username)]));
  }

  forgetUser(userId: number): Promise<void> {
    return this.serial.run(async () => {
      await this.pool.query('DELETE FROM friend_lists WHERE user_id = $1', [userId]);
      await this.pool.query(
        `UPDATE friend_lists SET friends = array_remove(friends, $1::bigint), incoming = array_remove(incoming, $1::bigint),
           outgoing = array_remove(outgoing, $1::bigint), updated_at = $2
         WHERE $1::bigint = ANY(friends) OR $1::bigint = ANY(incoming) OR $1::bigint = ANY(outgoing)`, [userId, Date.now()]);
    });
  }

  /** (The pool is the accounts': they close it) */
  async close(): Promise<void> {
    await this.serial.idle();
  }
}
