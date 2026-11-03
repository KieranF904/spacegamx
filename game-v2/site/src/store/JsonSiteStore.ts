/**
 * JsonSiteStore: the website's data in one JSON file (local dev), the same
 * rows as the Postgres tables in ../../schema.sql. Writes are atomic (temp file
 * + rename) and queued, as the lobby's JsonUserStore does.
 */

import fs from 'fs';
import path from 'path';
import type {
  ApiToken, Comment, Post, PostInput, PostPatch, PostStatus, Shout, SiteStore, Suggestion, SuggestionStatus,
} from './types.js';
import { SUGGESTION_STATUSES } from './types.js';

interface Vote { suggestionId: number; userId: number }

interface StoreFile {
  version: 1;
  nextId: Record<string, number>;
  posts: Post[];
  comments: Comment[];
  suggestions: Omit<Suggestion, 'votes'>[];
  votes: Vote[];
  shouts: Shout[];
  tokens: ApiToken[];
}

const now = () => new Date().toISOString();
const clone = <T>(v: T): T => structuredClone(v);

export class JsonSiteStore implements SiteStore {
  private data: StoreFile;
  private writeQueue: Promise<void> = Promise.resolve();
  private closed = false;
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.data = this.load();
  }

  private empty(): StoreFile {
    return { version: 1, nextId: {}, posts: [], comments: [], suggestions: [], votes: [], shouts: [], tokens: [] };
  }

  private load(): StoreFile {
    if (!fs.existsSync(this.filePath)) return this.empty();
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as Partial<StoreFile>;
      const base = this.empty();
      return {
        ...base, ...raw,
        nextId: raw.nextId ?? {},
        // (comments from before images were commentable have no `image`)
        posts: raw.posts ?? [], comments: (raw.comments ?? []).map((c) => ({ ...c, image: c.image ?? null })), suggestions: raw.suggestions ?? [],
        votes: raw.votes ?? [], shouts: raw.shouts ?? [], tokens: raw.tokens ?? [],
      } as StoreFile;
    } catch (err) {
      // Never overwrite a file we couldn't read: keep it aside and start empty
      const aside = `${this.filePath}.unreadable-${Date.now()}`;
      try { fs.copyFileSync(this.filePath, aside); } catch { /* best effort */ }
      console.error(`[SiteStore] Couldn't read ${this.filePath} (kept as ${aside}):`, err);
      return this.empty();
    }
  }

  private save(): void {
    if (this.closed) return;
    const json = JSON.stringify(this.data, null, 2);
    this.writeQueue = this.writeQueue.then(() => {
      try {
        const tmp = `${this.filePath}.tmp`;
        fs.writeFileSync(tmp, json);
        fs.renameSync(tmp, this.filePath);
      } catch (err) {
        console.error('[SiteStore] Failed to save:', err);
      }
    });
  }

  private id(kind: string, rows: { id: number }[]): number {
    const next = Math.max(this.data.nextId[kind] ?? 1, ...rows.map((r) => r.id + 1));
    this.data.nextId[kind] = next + 1;
    return next;
  }

  // ---------------------------------------------------------------- posts

  async listPosts(opts: { status?: PostStatus | 'all'; tag?: string; limit?: number; offset?: number }) {
    const status = opts.status ?? 'published';
    let all = this.data.posts.filter((p) => status === 'all' || p.status === status);
    if (opts.tag) all = all.filter((p) => p.tags.includes(opts.tag!));
    // Published first by when they went out; drafts by last edit
    const key = (p: Post) => p.publishedAt ?? p.updatedAt;
    all.sort((a, b) => (status === 'all' && a.status !== b.status ? (a.status === 'draft' ? -1 : 1) : key(b).localeCompare(key(a))));
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? 50;
    return { posts: clone(all.slice(offset, offset + limit)), total: all.length };
  }

  async getPost(id: number) { const p = this.data.posts.find((x) => x.id === id); return p ? clone(p) : null; }
  async getPostBySlug(slug: string) { const p = this.data.posts.find((x) => x.slug === slug); return p ? clone(p) : null; }

  async createPost(input: PostInput): Promise<Post | null> {
    if (this.data.posts.some((p) => p.slug === input.slug)) return null;
    const t = now();
    const post: Post = { ...input, id: this.id('post', this.data.posts), createdAt: t, updatedAt: t, publishedAt: input.status === 'published' ? t : null };
    this.data.posts.push(post);
    this.save();
    return clone(post);
  }

  async updatePost(id: number, patch: PostPatch): Promise<Post | null> {
    const post = this.data.posts.find((p) => p.id === id);
    if (!post) return null;
    if (patch.slug && patch.slug !== post.slug && this.data.posts.some((p) => p.slug === patch.slug)) return null;
    Object.assign(post, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
    post.updatedAt = now();
    if (post.status === 'published' && !post.publishedAt) post.publishedAt = post.updatedAt;
    this.save();
    return clone(post);
  }

  async deletePost(id: number) {
    this.data.posts = this.data.posts.filter((p) => p.id !== id);
    this.data.comments = this.data.comments.filter((c) => c.postId !== id);
    this.save();
  }

  async allTags() {
    const counts = new Map<string, number>();
    for (const p of this.data.posts) if (p.status === 'published') for (const t of p.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  // ---------------------------------------------------------------- comments

  async listComments(postId: number, includeHidden = false) {
    return clone(this.data.comments.filter((c) => c.postId === postId && (includeHidden || !c.hidden)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id));
  }

  async commentCounts(postIds: number[]) {
    const out = new Map<number, number>(postIds.map((id) => [id, 0]));
    for (const c of this.data.comments) if (!c.hidden && out.has(c.postId)) out.set(c.postId, out.get(c.postId)! + 1);
    return out;
  }

  async recentComments(limit: number) {
    return clone([...this.data.comments].sort((a, b) => b.id - a.id).slice(0, limit));
  }

  async addComment(c: Omit<Comment, 'id' | 'createdAt' | 'hidden' | 'image'> & { image?: string | null }) {
    const row: Comment = { ...c, image: c.image ?? null, id: this.id('comment', this.data.comments), createdAt: now(), hidden: false };
    this.data.comments.push(row);
    this.save();
    return clone(row);
  }

  async setCommentHidden(id: number, hidden: boolean) {
    const c = this.data.comments.find((x) => x.id === id);
    if (c) { c.hidden = hidden; this.save(); }
  }

  async deleteComment(id: number) { this.data.comments = this.data.comments.filter((c) => c.id !== id); this.save(); }

  // ---------------------------------------------------------------- suggestions

  private withVotes(s: Omit<Suggestion, 'votes'>): Suggestion {
    return { ...clone(s), votes: this.data.votes.filter((v) => v.suggestionId === s.id).length };
  }

  async listSuggestions(opts: { sort: 'top' | 'new'; status?: SuggestionStatus; includeHidden?: boolean; limit?: number }) {
    const rows = this.data.suggestions
      .filter((s) => (opts.includeHidden || !s.hidden) && (!opts.status || s.status === opts.status))
      .map((s) => this.withVotes(s));
    rows.sort((a, b) => (opts.sort === 'top' ? b.votes - a.votes : 0) || b.createdAt.localeCompare(a.createdAt) || b.id - a.id);
    return rows.slice(0, opts.limit ?? 200);
  }

  async getSuggestion(id: number) { const s = this.data.suggestions.find((x) => x.id === id); return s ? this.withVotes(s) : null; }

  async addSuggestion(s: Pick<Suggestion, 'title' | 'body' | 'authorId' | 'authorName'>) {
    const row = { ...s, id: this.id('suggestion', this.data.suggestions), createdAt: now(), status: 'open' as SuggestionStatus, reply: null, replyBy: null, repliedAt: null, hidden: false };
    this.data.suggestions.push(row);
    this.save();
    return this.withVotes(row);
  }

  async setVote(suggestionId: number, userId: number, on: boolean) {
    if (!this.data.suggestions.some((s) => s.id === suggestionId)) return null;
    const has = this.data.votes.some((v) => v.suggestionId === suggestionId && v.userId === userId);
    if (on && !has) { this.data.votes.push({ suggestionId, userId }); this.save(); }
    if (!on && has) { this.data.votes = this.data.votes.filter((v) => !(v.suggestionId === suggestionId && v.userId === userId)); this.save(); }
    return this.data.votes.filter((v) => v.suggestionId === suggestionId).length;
  }

  async votedBy(userId: number, ids: number[]) {
    const want = new Set(ids);
    return new Set(this.data.votes.filter((v) => v.userId === userId && want.has(v.suggestionId)).map((v) => v.suggestionId));
  }

  async setSuggestionStatus(id: number, status: SuggestionStatus, reply: string | null, by: string) {
    const s = this.data.suggestions.find((x) => x.id === id);
    if (!s) return;
    s.status = status;
    const text = reply?.trim() || null;
    if (text !== s.reply) { s.reply = text; s.replyBy = text ? by : null; s.repliedAt = text ? now() : null; }
    this.save();
  }

  async setSuggestionHidden(id: number, hidden: boolean) {
    const s = this.data.suggestions.find((x) => x.id === id);
    if (s) { s.hidden = hidden; this.save(); }
  }

  async deleteSuggestion(id: number) {
    this.data.suggestions = this.data.suggestions.filter((s) => s.id !== id);
    this.data.votes = this.data.votes.filter((v) => v.suggestionId !== id);
    this.save();
  }

  async suggestionCounts() {
    const out = Object.fromEntries(SUGGESTION_STATUSES.map((s) => [s, 0])) as Record<SuggestionStatus, number>;
    for (const s of this.data.suggestions) if (!s.hidden) out[s.status]++;
    return out;
  }

  // ---------------------------------------------------------------- shoutbox

  async recentShouts(limit: number) { return clone(this.data.shouts.slice(-limit)); }

  async addShout(s: Omit<Shout, 'id' | 'createdAt'>, keep: number) {
    const row: Shout = { ...s, id: this.id('shout', this.data.shouts), createdAt: now() };
    this.data.shouts.push(row);
    if (this.data.shouts.length > keep) this.data.shouts.splice(0, this.data.shouts.length - keep);
    this.save();
    return clone(row);
  }

  async deleteShout(id: number) {
    const before = this.data.shouts.length;
    this.data.shouts = this.data.shouts.filter((s) => s.id !== id);
    if (this.data.shouts.length === before) return false;
    this.save();
    return true;
  }

  // ---------------------------------------------------------------- tokens

  async createToken(t: Omit<ApiToken, 'id' | 'createdAt' | 'lastUsedAt'>) {
    const row: ApiToken = { ...t, id: this.id('token', this.data.tokens), createdAt: now(), lastUsedAt: null };
    this.data.tokens.push(row);
    this.save();
    return clone(row);
  }

  async listTokens() { return clone(this.data.tokens); }
  async findToken(hash: string) { const t = this.data.tokens.find((x) => x.hash === hash); return t ? clone(t) : null; }

  async touchToken(id: number) {
    const t = this.data.tokens.find((x) => x.id === id);
    // (At most once a minute: it's only for "last used")
    if (t && (!t.lastUsedAt || Date.now() - Date.parse(t.lastUsedAt) > 60_000)) { t.lastUsedAt = now(); this.save(); }
  }

  async revokeToken(id: number) { this.data.tokens = this.data.tokens.filter((t) => t.id !== id); this.save(); }

  // ---------------------------------------------------------------- accounts

  async forgetUser(userId: number) {
    this.data.shouts = this.data.shouts.filter((s) => s.authorId !== userId);
    this.data.votes = this.data.votes.filter((v) => v.userId !== userId);
    for (const c of this.data.comments) if (c.authorId === userId) { c.authorId = null; c.authorName = 'a former pilot'; }
    for (const s of this.data.suggestions) if (s.authorId === userId) { s.authorId = null; s.authorName = 'a former pilot'; }
    this.save();
  }

  async close() {
    this.closed = true;
    await this.writeQueue;
  }
}
