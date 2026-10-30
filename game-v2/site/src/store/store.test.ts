import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { JsonSiteStore } from './JsonSiteStore.js';
import type { SiteStore } from './types.js';

const post = (slug: string, status: 'draft' | 'published' = 'published') =>
  ({ slug, title: `Post ${slug}`, summary: '', body: 'Hello', tags: ['news', 'ships'], cover: null, status, authorId: 1, authorName: 'boss' });

/**
 * What both stores do the same. The Postgres one runs it too when SITE_TEST_DATABASE_URL names a scratch database
 * (it makes its own schema there from site/schema.sql, and drops it after):
 *   SITE_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/spacetest npx vitest run site/src/store
 * (and `npm install --no-save pg` in site/, or anywhere above it)
 */
function contract(name: string, make: () => Promise<{ store: SiteStore; done: () => Promise<void> | void }>) {
  describe(`${name} site store`, () => {
    it('posts: create, slug clash, publish keeps its first date, list, tags, delete', async () => {
      const { store, done } = await make();
      const a = await store.createPost(post('alpha', 'draft'));
      expect(a).toMatchObject({ slug: 'alpha', status: 'draft', publishedAt: null, tags: ['news', 'ships'] });
      expect(await store.createPost(post('alpha'))).toBeNull();
      const b = await store.createPost(post('beta'));
      expect(b?.publishedAt).not.toBeNull();
      expect((await store.listPosts({})).posts.map((p) => p.slug)).toEqual(['beta']);
      expect((await store.listPosts({ status: 'all' })).total).toBe(2);
      expect((await store.listPosts({ tag: 'ships' })).total).toBe(1);
      expect((await store.listPosts({ tag: 'nope' })).total).toBe(0);
      const pub = await store.updatePost(a!.id, { status: 'published', title: 'Alpha!' });
      expect(pub).toMatchObject({ title: 'Alpha!', status: 'published' });
      expect(pub?.publishedAt).not.toBeNull();
      const first = pub!.publishedAt;
      await store.updatePost(a!.id, { status: 'draft' });
      expect((await store.updatePost(a!.id, { status: 'published' }))?.publishedAt).toBe(first);
      expect(await store.updatePost(a!.id, { slug: 'beta' })).toBeNull();
      expect(await store.updatePost(999999, { title: 'x' })).toBeNull();
      expect((await store.getPostBySlug('beta'))?.id).toBe(b!.id);
      expect(await store.allTags()).toEqual([{ tag: 'news', count: 2 }, { tag: 'ships', count: 2 }]);
      await store.deletePost(a!.id);
      expect(await store.getPost(a!.id)).toBeNull();
      await done();
    });

    it('comments: add, count, hide, and they go with their post', async () => {
      const { store, done } = await make();
      const p = (await store.createPost(post('talk')))!;
      const c1 = await store.addComment({ postId: p.id, authorId: 2, authorName: 'ace', body: 'First' });
      await store.addComment({ postId: p.id, authorId: 3, authorName: 'bob', body: 'Second' });
      expect((await store.commentCounts([p.id])).get(p.id)).toBe(2);
      await store.setCommentHidden(c1.id, true);
      expect((await store.listComments(p.id)).map((c) => c.body)).toEqual(['Second']);
      expect(await store.listComments(p.id, true)).toHaveLength(2);
      expect((await store.recentComments(5))[0].body).toBe('Second');
      await store.deletePost(p.id);
      expect(await store.listComments(p.id, true)).toEqual([]);
      await done();
    });

    it('suggestions: votes are one per account, statuses and replies, counts', async () => {
      const { store, done } = await make();
      const s = await store.addSuggestion({ title: 'More ships', body: 'Please', authorId: 2, authorName: 'ace' });
      const t = await store.addSuggestion({ title: 'Less ships', body: '', authorId: 3, authorName: 'bob' });
      expect(await store.setVote(s.id, 5, true)).toBe(1);
      expect(await store.setVote(s.id, 5, true)).toBe(1);
      expect(await store.setVote(s.id, 6, true)).toBe(2);
      expect(await store.setVote(999999, 6, true)).toBeNull();
      expect([...(await store.votedBy(5, [s.id, t.id]))]).toEqual([s.id]);
      expect((await store.listSuggestions({ sort: 'top' })).map((x) => x.title)).toEqual(['More ships', 'Less ships']);
      await store.setSuggestionStatus(t.id, 'planned', ' Soon ', 'boss');
      expect(await store.getSuggestion(t.id)).toMatchObject({ status: 'planned', reply: 'Soon', replyBy: 'boss' });
      await store.setSuggestionStatus(t.id, 'done', null, 'boss');
      expect(await store.getSuggestion(t.id)).toMatchObject({ status: 'done', reply: null, replyBy: null, repliedAt: null });
      await store.setSuggestionHidden(t.id, true);
      expect((await store.listSuggestions({ sort: 'new' })).map((x) => x.id)).toEqual([s.id]);
      expect((await store.suggestionCounts()).open).toBe(1);
      expect(await store.setVote(s.id, 6, false)).toBe(1);
      await store.deleteSuggestion(s.id);
      expect(await store.getSuggestion(s.id)).toBeNull();
      await done();
    });

    it('shouts keep only the latest', async () => {
      const { store, done } = await make();
      for (let i = 1; i <= 5; i++) await store.addShout({ authorId: 2, authorName: 'ace', isAdmin: false, text: `s${i}` }, 3);
      expect((await store.recentShouts(10)).map((x) => x.text)).toEqual(['s3', 's4', 's5']);
      const last = (await store.recentShouts(1))[0];
      expect(await store.deleteShout(last.id)).toBe(true);
      expect(await store.deleteShout(last.id)).toBe(false);
      await done();
    });

    it('API tokens: only the hash is kept; find, touch, revoke', async () => {
      const { store, done } = await make();
      const t = await store.createToken({ name: 'cli', hash: 'abc123', prefix: 'sgs_ab', createdBy: 1, createdByName: 'boss' });
      expect(await store.findToken('abc123')).toMatchObject({ id: t.id, name: 'cli', lastUsedAt: null });
      expect(await store.findToken('nope')).toBeNull();
      await store.touchToken(t.id);
      expect((await store.findToken('abc123'))?.lastUsedAt).not.toBeNull();
      expect(await store.listTokens()).toHaveLength(1);
      await store.revokeToken(t.id);
      expect(await store.findToken('abc123')).toBeNull();
      await done();
    });

    it('a deleted account: its shouts and votes go, its comments and suggestions stay unsigned', async () => {
      const { store, done } = await make();
      const p = (await store.createPost(post('gone')))!;
      await store.addComment({ postId: p.id, authorId: 7, authorName: 'leaver', body: 'Bye' });
      const s = await store.addSuggestion({ title: 'Idea', body: '', authorId: 7, authorName: 'leaver' });
      await store.setVote(s.id, 7, true);
      await store.addShout({ authorId: 7, authorName: 'leaver', isAdmin: false, text: 'Hi' }, 50);
      await store.forgetUser(7);
      expect(await store.recentShouts(10)).toEqual([]);
      expect((await store.getSuggestion(s.id))).toMatchObject({ authorId: null, authorName: 'a former pilot', votes: 0 });
      expect((await store.listComments(p.id))[0]).toMatchObject({ authorId: null, authorName: 'a former pilot', body: 'Bye' });
      await done();
    });
  });
}

contract('JSON', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'site-store-'));
  const store = new JsonSiteStore(join(dir, 'site.json'));
  return { store, done: async () => { await store.close(); rmSync(dir, { recursive: true, force: true }); } };
});

const databaseUrl = process.env.SITE_TEST_DATABASE_URL;
if (databaseUrl) {
  contract('postgres', async () => {
    const moduleName = 'pg';
    const pg: any = await import(moduleName);
    const schema = `site_test_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const admin = new pg.Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const client = await admin.connect();
    await client.query(`SET search_path TO ${schema}`);
    await client.query(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../schema.sql'), 'utf-8'));
    client.release();
    const url = new URL(databaseUrl);
    url.searchParams.set('options', `-c search_path=${schema}`);
    const { PostgresSiteStore } = await import('./PostgresSiteStore.js');
    const store = await PostgresSiteStore.create(url.toString());
    return { store, done: async () => { await store.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); } };
  });
}
