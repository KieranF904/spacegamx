/**
 * PostgresSiteStore: the website's data in PostgreSQL (production), the tables
 * in ../../schema.sql. Same behaviour as JsonSiteStore.
 *
 * 'pg' isn't a dependency until it's wanted (as with the lobby's
 * PostgresUserStore): `npm install pg` in site/, apply schema.sql, then run with
 * SITE_STORE_BACKEND=postgres DATABASE_URL=postgres://...
 *
 * (Not exercised against a live database yet: run its schema and the site's
 * flows against a scratch database before switching production to it.)
 */

import type {
  ApiToken, Comment, Post, PostInput, PostPatch, PostStatus, Shout, SiteStore, Suggestion, SuggestionStatus,
} from './types.js';
import { SUGGESTION_STATUSES } from './types.js';

interface PgResult { rows: any[] }
interface PgPool { query(sql: string, params?: unknown[]): Promise<PgResult>; end(): Promise<void> }

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v ?? ''));
const isoOrNull = (v: unknown): string | null => (v == null ? null : iso(v));

function post(r: any): Post {
  return {
    id: Number(r.id), slug: r.slug, title: r.title, summary: r.summary, body: r.body, tags: r.tags ?? [], cover: r.cover,
    status: r.status, authorId: r.author_id == null ? null : Number(r.author_id), authorName: r.author_name,
    createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), publishedAt: isoOrNull(r.published_at),
  };
}
function comment(r: any): Comment {
  return { id: Number(r.id), postId: Number(r.post_id), authorId: r.author_id == null ? null : Number(r.author_id), authorName: r.author_name, body: r.body, createdAt: iso(r.created_at), hidden: !!r.hidden };
}
function suggestion(r: any): Suggestion {
  return {
    id: Number(r.id), title: r.title, body: r.body, authorId: r.author_id == null ? null : Number(r.author_id), authorName: r.author_name,
    createdAt: iso(r.created_at), status: r.status, reply: r.reply, replyBy: r.reply_by, repliedAt: isoOrNull(r.replied_at),
    hidden: !!r.hidden, votes: Number(r.votes ?? 0),
  };
}
function shout(r: any): Shout {
  return { id: Number(r.id), authorId: Number(r.author_id), authorName: r.author_name, isAdmin: !!r.is_admin, text: r.text, createdAt: iso(r.created_at) };
}
function token(r: any): ApiToken {
  return { id: Number(r.id), name: r.name, hash: r.hash, prefix: r.prefix, createdBy: Number(r.created_by), createdByName: r.created_by_name, createdAt: iso(r.created_at), lastUsedAt: isoOrNull(r.last_used_at) };
}

const SUGGESTION_SELECT = `SELECT s.*, (SELECT COUNT(*) FROM site_votes v WHERE v.suggestion_id = s.id)::int AS votes FROM site_suggestions s`;

export class PostgresSiteStore implements SiteStore {
  constructor(private pool: PgPool) {}

  static async create(connectionString: string): Promise<PostgresSiteStore> {
    const moduleName = 'pg';
    const pg: any = await import(moduleName);
    return new PostgresSiteStore(new pg.Pool({ connectionString }) as PgPool);
  }

  async listPosts(opts: { status?: PostStatus | 'all'; tag?: string; limit?: number; offset?: number }) {
    const status = opts.status ?? 'published';
    const where: string[] = [];
    const params: unknown[] = [];
    if (status !== 'all') { params.push(status); where.push(`status = $${params.length}`); }
    if (opts.tag) { params.push(opts.tag); where.push(`$${params.length} = ANY(tags)`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.pool.query(`SELECT COUNT(*)::int AS n FROM site_posts ${w}`, params);
    const order = status === 'all' ? `(status = 'draft') DESC, COALESCE(published_at, updated_at) DESC` : `COALESCE(published_at, updated_at) DESC`;
    const rows = await this.pool.query(`SELECT * FROM site_posts ${w} ORDER BY ${order} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, opts.limit ?? 50, opts.offset ?? 0]);
    return { posts: rows.rows.map(post), total: total.rows[0].n };
  }

  async getPost(id: number) { const r = await this.pool.query('SELECT * FROM site_posts WHERE id = $1', [id]); return r.rows[0] ? post(r.rows[0]) : null; }
  async getPostBySlug(slug: string) { const r = await this.pool.query('SELECT * FROM site_posts WHERE slug = $1', [slug]); return r.rows[0] ? post(r.rows[0]) : null; }

  async createPost(i: PostInput) {
    const r = await this.pool.query(
      `INSERT INTO site_posts (slug, title, summary, body, tags, cover, status, author_id, author_name, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $7 = 'published' THEN now() END)
       ON CONFLICT (slug) DO NOTHING RETURNING *`,
      [i.slug, i.title, i.summary, i.body, i.tags, i.cover, i.status, i.authorId, i.authorName]);
    return r.rows[0] ? post(r.rows[0]) : null;
  }

  async updatePost(id: number, patch: PostPatch) {
    const cols: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) cols[k] = v;
    const keys = Object.keys(cols);
    const sets = keys.map((k, n) => `${k} = $${n + 2}`);
    try {
      const r = await this.pool.query(
        `UPDATE site_posts SET ${[...sets, 'updated_at = now()', `published_at = CASE WHEN ${keys.includes('status') ? `$${keys.indexOf('status') + 2}` : 'status'} = 'published' THEN COALESCE(published_at, now()) ELSE published_at END`].join(', ')}
         WHERE id = $1 RETURNING *`,
        [id, ...keys.map((k) => cols[k])]);
      return r.rows[0] ? post(r.rows[0]) : null;
    } catch (e: any) {
      if (e?.code === '23505') return null; // the slug is taken
      throw e;
    }
  }

  async deletePost(id: number) { await this.pool.query('DELETE FROM site_posts WHERE id = $1', [id]); }

  async allTags() {
    const r = await this.pool.query(`SELECT t AS tag, COUNT(*)::int AS count FROM site_posts, unnest(tags) t WHERE status = 'published' GROUP BY t ORDER BY count DESC, t`);
    return r.rows.map((x) => ({ tag: x.tag, count: x.count }));
  }

  async listComments(postId: number, includeHidden = false) {
    const r = await this.pool.query(`SELECT * FROM site_comments WHERE post_id = $1 ${includeHidden ? '' : 'AND NOT hidden'} ORDER BY created_at, id`, [postId]);
    return r.rows.map(comment);
  }

  async commentCounts(postIds: number[]) {
    const out = new Map<number, number>(postIds.map((id) => [id, 0]));
    if (!postIds.length) return out;
    const r = await this.pool.query('SELECT post_id, COUNT(*)::int AS n FROM site_comments WHERE post_id = ANY($1) AND NOT hidden GROUP BY post_id', [postIds]);
    for (const x of r.rows) out.set(Number(x.post_id), x.n);
    return out;
  }

  async recentComments(limit: number) { return (await this.pool.query('SELECT * FROM site_comments ORDER BY id DESC LIMIT $1', [limit])).rows.map(comment); }

  async addComment(c: Omit<Comment, 'id' | 'createdAt' | 'hidden'>) {
    const r = await this.pool.query('INSERT INTO site_comments (post_id, author_id, author_name, body) VALUES ($1, $2, $3, $4) RETURNING *', [c.postId, c.authorId, c.authorName, c.body]);
    return comment(r.rows[0]);
  }

  async setCommentHidden(id: number, hidden: boolean) { await this.pool.query('UPDATE site_comments SET hidden = $2 WHERE id = $1', [id, hidden]); }
  async deleteComment(id: number) { await this.pool.query('DELETE FROM site_comments WHERE id = $1', [id]); }

  async listSuggestions(opts: { sort: 'top' | 'new'; status?: SuggestionStatus; includeHidden?: boolean; limit?: number }) {
    const where: string[] = [];
    const params: unknown[] = [];
    if (!opts.includeHidden) where.push('NOT s.hidden');
    if (opts.status) { params.push(opts.status); where.push(`s.status = $${params.length}`); }
    params.push(opts.limit ?? 200);
    const r = await this.pool.query(
      `${SUGGESTION_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY ${opts.sort === 'top' ? 'votes DESC, ' : ''}s.created_at DESC, s.id DESC LIMIT $${params.length}`, params);
    return r.rows.map(suggestion);
  }

  async getSuggestion(id: number) { const r = await this.pool.query(`${SUGGESTION_SELECT} WHERE s.id = $1`, [id]); return r.rows[0] ? suggestion(r.rows[0]) : null; }

  async addSuggestion(s: Pick<Suggestion, 'title' | 'body' | 'authorId' | 'authorName'>) {
    const r = await this.pool.query('INSERT INTO site_suggestions (title, body, author_id, author_name) VALUES ($1, $2, $3, $4) RETURNING *, 0 AS votes', [s.title, s.body, s.authorId, s.authorName]);
    return suggestion(r.rows[0]);
  }

  async setVote(suggestionId: number, userId: number, on: boolean) {
    const exists = await this.pool.query('SELECT 1 FROM site_suggestions WHERE id = $1', [suggestionId]);
    if (!exists.rows.length) return null;
    if (on) await this.pool.query('INSERT INTO site_votes (suggestion_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [suggestionId, userId]);
    else await this.pool.query('DELETE FROM site_votes WHERE suggestion_id = $1 AND user_id = $2', [suggestionId, userId]);
    return (await this.pool.query('SELECT COUNT(*)::int AS n FROM site_votes WHERE suggestion_id = $1', [suggestionId])).rows[0].n;
  }

  async votedBy(userId: number, ids: number[]) {
    if (!ids.length) return new Set<number>();
    const r = await this.pool.query('SELECT suggestion_id FROM site_votes WHERE user_id = $1 AND suggestion_id = ANY($2)', [userId, ids]);
    return new Set(r.rows.map((x) => Number(x.suggestion_id)));
  }

  async setSuggestionStatus(id: number, status: SuggestionStatus, reply: string | null, by: string) {
    const text = reply?.trim() || null;
    await this.pool.query(
      `UPDATE site_suggestions SET status = $2,
         reply_by = CASE WHEN reply IS DISTINCT FROM $3 THEN (CASE WHEN $3::text IS NULL THEN NULL ELSE $4 END) ELSE reply_by END,
         replied_at = CASE WHEN reply IS DISTINCT FROM $3 THEN (CASE WHEN $3::text IS NULL THEN NULL ELSE now() END) ELSE replied_at END,
         reply = $3
       WHERE id = $1`, [id, status, text, by]);
  }

  async setSuggestionHidden(id: number, hidden: boolean) { await this.pool.query('UPDATE site_suggestions SET hidden = $2 WHERE id = $1', [id, hidden]); }
  async deleteSuggestion(id: number) { await this.pool.query('DELETE FROM site_suggestions WHERE id = $1', [id]); }

  async suggestionCounts() {
    const out = Object.fromEntries(SUGGESTION_STATUSES.map((s) => [s, 0])) as Record<SuggestionStatus, number>;
    const r = await this.pool.query('SELECT status, COUNT(*)::int AS n FROM site_suggestions WHERE NOT hidden GROUP BY status');
    for (const x of r.rows) out[x.status as SuggestionStatus] = x.n;
    return out;
  }

  async recentShouts(limit: number) {
    const r = await this.pool.query('SELECT * FROM (SELECT * FROM site_shouts ORDER BY id DESC LIMIT $1) x ORDER BY id', [limit]);
    return r.rows.map(shout);
  }

  async addShout(s: Omit<Shout, 'id' | 'createdAt'>, keep: number) {
    const r = await this.pool.query('INSERT INTO site_shouts (author_id, author_name, is_admin, text) VALUES ($1, $2, $3, $4) RETURNING *', [s.authorId, s.authorName, s.isAdmin, s.text]);
    await this.pool.query('DELETE FROM site_shouts WHERE id <= (SELECT id FROM site_shouts ORDER BY id DESC OFFSET $1 LIMIT 1)', [keep]);
    return shout(r.rows[0]);
  }

  async deleteShout(id: number) { return (await this.pool.query('DELETE FROM site_shouts WHERE id = $1 RETURNING id', [id])).rows.length > 0; }

  async createToken(t: Omit<ApiToken, 'id' | 'createdAt' | 'lastUsedAt'>) {
    const r = await this.pool.query('INSERT INTO site_api_tokens (name, hash, prefix, created_by, created_by_name) VALUES ($1, $2, $3, $4, $5) RETURNING *', [t.name, t.hash, t.prefix, t.createdBy, t.createdByName]);
    return token(r.rows[0]);
  }
  async listTokens() { return (await this.pool.query('SELECT * FROM site_api_tokens ORDER BY id')).rows.map(token); }
  async findToken(hash: string) { const r = await this.pool.query('SELECT * FROM site_api_tokens WHERE hash = $1', [hash]); return r.rows[0] ? token(r.rows[0]) : null; }
  async touchToken(id: number) { await this.pool.query(`UPDATE site_api_tokens SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`, [id]); }
  async revokeToken(id: number) { await this.pool.query('DELETE FROM site_api_tokens WHERE id = $1', [id]); }

  async forgetUser(userId: number) {
    await this.pool.query('DELETE FROM site_shouts WHERE author_id = $1', [userId]);
    await this.pool.query('DELETE FROM site_votes WHERE user_id = $1', [userId]);
    await this.pool.query(`UPDATE site_comments SET author_id = NULL, author_name = 'a former pilot' WHERE author_id = $1`, [userId]);
    await this.pool.query(`UPDATE site_suggestions SET author_id = NULL, author_name = 'a former pilot' WHERE author_id = $1`, [userId]);
  }

  async close() { await this.pool.end(); }
}
