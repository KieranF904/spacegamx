/**
 * PostgresMessageStore: the inbox in the `messages` table (../../schema.sql), sharing the accounts' pool.
 * The table is made at start when it's missing (as schema.sql would), so a deploy needn't re-apply the schema.
 */

import crypto from 'crypto';
import type { InboxPage, MessageRecord, MessageStore, NewMessage, SentSummary } from './types.js';

interface PgPool {
  query(sql: string, params?: any[]): Promise<{ rows: any[] }>;
}

/** schema.sql's statements for the inbox (run at start: IF NOT EXISTS) */
export const MESSAGES_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS messages (
    id           BIGSERIAL PRIMARY KEY,
    user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    from_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    from_name    TEXT NOT NULL,
    subject      TEXT NOT NULL,
    body         TEXT NOT NULL,
    important    BOOLEAN NOT NULL DEFAULT FALSE,
    batch        TEXT NOT NULL,
    sent_to      TEXT NOT NULL,
    created_at   BIGINT NOT NULL,
    read_at      BIGINT,
    archived_at  BIGINT
  )`,
  'CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_messages_batch ON messages(batch)',
];

const COLUMNS = 'id, user_id, from_user_id, from_name, subject, body, important, batch, sent_to, created_at, read_at, archived_at';
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export class PostgresMessageStore implements MessageStore {
  constructor(private pool: PgPool) {}

  static async create(pool: PgPool): Promise<PostgresMessageStore> {
    try {
      for (const sql of MESSAGES_SCHEMA) await pool.query(sql);
    } catch (e) {
      throw new Error(`The inbox's "messages" table is missing and this database user can't make it: run server-browser/schema.sql as the tables' owner (${e})`);
    }
    return new PostgresMessageStore(pool);
  }

  async send(userIds: number[], msg: NewMessage): Promise<{ batch: string; count: number }> {
    const batch = crypto.randomUUID();
    const ids = [...new Set(userIds)];
    if (!ids.length) return { batch, count: 0 };
    const r = await this.pool.query(
      `INSERT INTO messages (user_id, from_user_id, from_name, subject, body, important, batch, sent_to, created_at)
       SELECT u, $2, $3, $4, $5, $6, $7, $8, $9 FROM unnest($1::bigint[]) AS u
       RETURNING id`,
      [ids, msg.from_user_id, msg.from_name, msg.subject, msg.body, msg.important, batch, msg.sent_to, Date.now()]);
    return { batch, count: r.rows.length };
  }

  async list(userId: number, limit: number): Promise<InboxPage> {
    const rows = await this.pool.query(
      `SELECT ${COLUMNS} FROM messages WHERE user_id = $1 AND archived_at IS NULL ORDER BY created_at DESC, id DESC LIMIT $2`, [userId, limit]);
    const counts = await this.pool.query(
      `SELECT COUNT(*)::int AS unread, COUNT(*) FILTER (WHERE important)::int AS important
       FROM messages WHERE user_id = $1 AND archived_at IS NULL AND read_at IS NULL`, [userId]);
    return {
      messages: rows.rows.map((r) => this.toRecord(r)),
      unread: counts.rows[0]?.unread ?? 0,
      unreadImportant: counts.rows[0]?.important ?? 0,
    };
  }

  async markRead(userId: number, ids: number[] | 'all'): Promise<number> {
    const r = ids === 'all'
      ? await this.pool.query('UPDATE messages SET read_at = $2 WHERE user_id = $1 AND read_at IS NULL AND archived_at IS NULL RETURNING id', [userId, Date.now()])
      : await this.pool.query('UPDATE messages SET read_at = $2 WHERE user_id = $1 AND read_at IS NULL AND archived_at IS NULL AND id = ANY($3::bigint[]) RETURNING id', [userId, Date.now(), ids]);
    return r.rows.length;
  }

  async archive(userId: number, ids: number[]): Promise<number> {
    const r = await this.pool.query(
      `UPDATE messages SET archived_at = $2, read_at = COALESCE(read_at, $2)
       WHERE user_id = $1 AND archived_at IS NULL AND id = ANY($3::bigint[]) RETURNING id`, [userId, Date.now(), ids]);
    return r.rows.length;
  }

  async sent(limit: number): Promise<SentSummary[]> {
    const r = await this.pool.query(
      `SELECT batch, MIN(sent_to) AS sent_to, MIN(from_name) AS from_name, MIN(subject) AS subject, MIN(body) AS body,
              BOOL_OR(important) AS important, MIN(created_at) AS created_at,
              COUNT(*)::int AS recipients, COUNT(read_at)::int AS read
       FROM messages GROUP BY batch ORDER BY MIN(created_at) DESC LIMIT $1`, [limit]);
    return r.rows.map((x) => ({
      batch: x.batch, sent_to: x.sent_to, from_name: x.from_name, subject: x.subject, body: x.body,
      important: !!x.important, created_at: Number(x.created_at), recipients: x.recipients, read: x.read,
    }));
  }

  async forgetUser(userId: number): Promise<void> {
    await this.pool.query('DELETE FROM messages WHERE user_id = $1', [userId]);
  }

  /** (The pool is the accounts': they close it) */
  async close(): Promise<void> {}

  private toRecord(r: any): MessageRecord {
    return {
      id: Number(r.id), user_id: Number(r.user_id), from_user_id: num(r.from_user_id), from_name: r.from_name,
      subject: r.subject, body: r.body, important: !!r.important, batch: r.batch, sent_to: r.sent_to,
      created_at: Number(r.created_at), read_at: num(r.read_at), archived_at: num(r.archived_at),
    };
  }
}
