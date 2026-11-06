/**
 * The website: pages, forms, the shoutbox, the admin panel and the posts API.
 * createApp() takes its parts (store, lobby, pilot data, uploads), so tests run
 * it with fakes and no sockets.
 *
 * Routes (pages):
 *   GET  /                         home: hero, play, live count, latest updates, the game, shoutbox
 *   GET  /updates[?tag=&page=]     the feed;   GET /updates/:slug  a post and its comments
 *   POST /updates/:slug/comments   comment (signed in); `image` (an image's src in the post) puts it on that image;
 *                                  with Accept: application/json it answers { ok, id, item } (the list item's HTML)
 *   GET  /rss.xml                  RSS 2.0
 *   GET  /guides                   the guides (Markdown files in site/guides: src/guides.ts);  GET /guides/:slug  one guide
 *                                  (hidden unless SITE_GUIDES=1: a 404, and nothing links to them)
 *   GET  /database[/:kind[/:id]]   parts, items, ships, bosses, stations (src/routes/catalog.ts)
 *   GET  /ships[/:id]              the ship gallery (src/routes/ships.ts);  GET /status  the game server's state (src/routes/status.ts)
 *   GET  /suggestions[?sort=&status=]  POST /suggestions   POST /suggestions/:id/vote
 *   GET  /shoutbox/stream (SSE)    POST /shoutbox    POST /shoutbox/:id/delete (admin)
 *   GET  /signin /register         POST them;  POST /signout
 *   GET  /account                  POST /account/email|password|signout-all|delete
 *   GET  /pilots[?period=weekly]   GET /pilots/:name   GET /pilots/find?name=
 *   GET  /play                     the game, handed this session (play.ts)
 *   /admin/...                     posts, comments, suggestions, shoutbox, pilots & bans, API tokens, activity (src/routes/activity.ts)
 *
 * Ranks (the lobby's): owner > admin. Admins moderate (comments, suggestions, the shoutbox, shared ships, bans
 * of pilots) and write drafts. The owner alone (requireOwner, and `api.owner` for the API) publishes and
 * unpublishes posts, changes or deletes a published one, makes and revokes API tokens, grants and revokes admin,
 * bans admins and deletes other people's accounts. Nobody bans or demotes the owner here. (The site has no
 * settings pages: its settings are the environment, src/config.ts.)
 *
 * The API (JSON; admin: Bearer sgs_ token, Bearer lobby session of an admin, or the
 * admin's cookie session plus X-CSRF-Token):
 *   GET  /api/v1/status            public: online, pilots, and what else the game reports
 *   GET  /api/v1/catalog           public: the catalog as JSON;  GET /api/v1/changelog  public: the "What's new" feed
 *   GET  /api/v1/ships             public: shared ships;  POST/DELETE /api/v1/ships  the game server, with its key (src/routes/ships.ts)
 *   GET  /api/v1/me
 *   GET  /api/v1/posts[?status=all|draft|published]     GET /api/v1/posts/:slug
 *   POST /api/v1/posts             create, or update the post with that slug (upsert)
 *   PATCH /api/v1/posts/:slug      change some fields;  DELETE /api/v1/posts/:slug
 *   POST /api/v1/uploads           an image as the raw body -> { url }
 *   POST /api/v1/preview           { body } -> { html } (sanitised)
 *   POST /api/v1/session           { username, password } -> { token } (an admin's lobby session, for the CLI)
 *   DELETE /api/v1/session         ends that session
 */

import fs from 'fs/promises';
import type http from 'http';
import path from 'path';
import type { Duplex } from 'stream';
import type { SiteConfig } from './config.js';
import type { html } from './html.js';
import { HttpError, readBody, readFields, redirect, Router, safeNext, sendHtml, sendJson, str, type Params } from './http.js';
import type { Lobby, LobbyUser } from './lobby.js';
import { CatalogBook } from './catalog/book.js';
import { GuideBook } from './guides.js';
import { renderMarkdown } from './markdown.js';
import { BOARDS, type PilotSource } from './pilots.js';
import { postImages } from './postImages.js';
import { gameIndex, injectHandoff, isDevGamePath, proxyToDev, proxyUpgradeToDev } from './play.js';
import { checkPost } from './posts.js';
import { HttpActivityClient, type ActivityClient } from './activity.js';
import { registerActivity } from './routes/activity.js';
import { registerCatalog } from './routes/catalog.js';
import { registerChangelog } from './routes/changelog.js';
import type { RouteEnv } from './routes/env.js';
import { registerShips } from './routes/ships.js';
import { registerStatus } from './routes/status.js';
import { rssFeed } from './rss.js';
import {
  cookie, Csrf, CSRF_COOKIE, hashToken, keyMatches, LIMITS, newApiToken, parseCookies, RateLimiter, sameOrigin, securityHeaders,
  SESSION_COOKIE, SESSION_MAX_AGE_S, TOKEN_PREFIX,
} from './security.js';
import { StatusFile, type ServerStatus } from './status.js';
import { cleanShout, publicShout, SHOUT_KEEP, SHOUT_MAX, ShoutHub } from './shoutbox.js';
import type { Post, SiteStore, SuggestionStatus } from './store/types.js';
import { SUGGESTION_STATUSES } from './store/types.js';
import { contentType, MAX_UPLOAD_BYTES, Uploads } from './uploads.js';
import * as A from './views/admin.js';
import * as G from './views/guides.js';
import type { PageCtx } from './views/layout.js';
import * as V from './views/pages.js';

export interface AppDeps {
  cfg: SiteConfig;
  store: SiteStore;
  lobby: Lobby;
  pilots: PilotSource;
  uploads: Uploads;
  /** (tests) */
  limiter?: RateLimiter;
  catalog?: CatalogBook;
  status?: { get(): Promise<ServerStatus | null> };
  /** (tests) The lobbies' activity feeds */
  activity?: ActivityClient;
}

export interface Ctx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  path: string;
  ip: string;
  token: string | null;
  user: LobbyUser | null;
  csrf: string;
  csrfSeed: string;
  /** How an API call was authenticated (owner: may publish; a token is its maker's, as their rank is now) */
  api: { via: 'token' | 'lobby' | 'session'; name: string; userId: number; author: string; owner: boolean } | null;
  /** The call carries the game server's key (SITE_GAME_KEY): it may share ships, and nothing else */
  game: boolean;
  page: PageCtx;
}

/** Fixed notes shown after a redirect (?ok=key): never text from the request */
const NOTICES: Record<string, string> = {
  signedin: 'Signed in.', registered: 'Account created.', signedout: 'Signed out.',
  email: 'Email changed.', password: 'Password changed. Your other sessions were signed out.', everywhere: 'Signed out everywhere.',
  deleted: 'Account deleted.', suggested: 'Suggestion posted.', commented: 'Comment posted.',
  saved: 'Saved.', published: 'Published.', unpublished: 'Unpublished: it is a draft again.', postdeleted: 'Post deleted.',
  hidden: 'Hidden.', shown: 'Shown again.', removed: 'Deleted.', banned: 'Banned.', unbanned: 'Ban lifted.', revoked: 'Token revoked.',
  promoted: 'Now an admin.', demoted: 'No longer an admin.', accountdeleted: 'Account deleted for good.',
};

/** Why an admin's change to a post was refused (publishing is the owner's) */
const OWNER_PUBLISHES = 'Only the owner can publish, unpublish, or change a published post. Save it as a draft.';

const STATIC_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webp': 'image/webp', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

const SESSION_CACHE_MS = 20_000;
const PER_PAGE = 10;

export function createApp(deps: AppDeps) {
  const { cfg, store, lobby, pilots, uploads } = deps;
  const limiter = deps.limiter ?? new RateLimiter();
  const csrf = new Csrf(cfg.secret);
  const hub = new ShoutHub(store);
  const guides = new GuideBook(cfg.guidesDir, cfg.production);
  const sessions = new Map<string, { user: LobbyUser | null; until: number }>();
  const router = new Router<Ctx>();
  const catalog = deps.catalog ?? new CatalogBook(cfg.catalogFile, cfg.catalogGameFile);
  const statusFile = deps.status ?? new StatusFile(cfg.statusFile);

  // ------------------------------------------------------------ helpers

  async function userFor(token: string): Promise<LobbyUser | null> {
    const hit = sessions.get(token);
    if (hit && hit.until > Date.now()) return hit.user;
    const user = await lobby.validate(token);
    sessions.set(token, { user, until: Date.now() + SESSION_CACHE_MS });
    if (sessions.size > 5000) sessions.clear();
    return user;
  }

  function forget(token: string | null) { if (token) sessions.delete(token); }

  function ipOf(req: http.IncomingMessage): string {
    if (cfg.trustProxy) {
      const real = req.headers['x-real-ip'];
      if (real) return String(real).trim();
      const xff = req.headers['x-forwarded-for'];
      if (xff) return String(xff).split(',')[0].trim();
    }
    return req.socket?.remoteAddress ?? '';
  }

  function setSession(ctx: Ctx, token: string | null) {
    const c = token
      ? cookie(SESSION_COOKIE, token, { maxAge: SESSION_MAX_AGE_S, secure: cfg.secureCookies })
      : cookie(SESSION_COOKIE, '', { maxAge: 0, secure: cfg.secureCookies });
    appendCookie(ctx.res, c);
  }

  function appendCookie(res: http.ServerResponse, c: string) {
    const prev = res.getHeader('Set-Cookie');
    res.setHeader('Set-Cookie', [...(Array.isArray(prev) ? prev : prev ? [String(prev)] : []), c]);
  }

  function notice(ctx: Ctx) {
    const ok = ctx.url.searchParams.get('ok');
    return ok && NOTICES[ok] ? { kind: 'ok' as const, text: NOTICES[ok] } : null;
  }

  const page = (ctx: Ctx, status: number, body: ReturnType<typeof html>) => sendHtml(ctx.res, status, body);

  function limited(ctx: Ctx, key: string, rule: { limit: number; windowMs: number }): boolean {
    if (limiter.hit(key, rule.limit, rule.windowMs)) return false;
    const wait = limiter.retryAfter(key, rule.limit, rule.windowMs);
    ctx.res.setHeader('Retry-After', String(Math.max(1, wait)));
    return true;
  }

  const slow = (ctx: Ctx, key: string, rule: { limit: number; windowMs: number }) =>
    `You're going a bit fast. Try again in ${Math.max(1, limiter.retryAfter(key, rule.limit, rule.windowMs))} s.`;

  function wantsJson(ctx: Ctx) {
    return String(ctx.req.headers.accept ?? '').includes('application/json') || String(ctx.req.headers['content-type'] ?? '').startsWith('application/json');
  }

  function requireUser(ctx: Ctx): LobbyUser | null {
    if (ctx.user) return ctx.user;
    if (wantsJson(ctx)) sendJson(ctx.res, 401, { error: 'Sign in first' });
    else redirect(ctx.res, `/signin?next=${encodeURIComponent(ctx.path)}`);
    return null;
  }

  function requireAdmin(ctx: Ctx): LobbyUser | null {
    if (!ctx.user) { redirect(ctx.res, `/signin?next=${encodeURIComponent(ctx.path)}`); return null; }
    if (!ctx.user.isAdmin) { page(ctx, 404, V.notFoundPage(ctx.page)); return null; }
    return ctx.user;
  }

  /** The owner only: signed out goes to sign in, a pilot gets "not found", an admin a page saying it's the owner's */
  function requireOwner(ctx: Ctx): LobbyUser | null {
    const user = requireAdmin(ctx);
    if (!user) return null;
    if (!user.isOwner) { page(ctx, 403, A.ownerOnly(ctx.page)); return null; }
    return user;
  }

  /** The form or JSON body (the CSRF check may have read a form already) */
  async function fields(ctx: Ctx, max?: number): Promise<Record<string, any>> {
    const done = (ctx.req as { __fields?: Record<string, any> }).__fields;
    return done ?? readFields(ctx.req, max);
  }

  function backTo(v: unknown, fallback: string): string {
    const s = safeNext(v);
    return s === '/' ? fallback : s;
  }

  // ------------------------------------------------------------ home, updates

  router.get('/', async (ctx) => {
    const [{ posts }, shouts, rankings, guideList] = await Promise.all([store.listPosts({ limit: 3 }), store.recentShouts(30), pilots.rankings(), cfg.guides ? guides.all() : []]);
    const comments = await store.commentCounts(posts.map((p) => p.id));
    page(ctx, 200, V.homePage(ctx.page, { posts, comments, shouts, rankings, guides: guideList }));
  });

  router.get('/updates', async (ctx) => {
    const tag = ctx.url.searchParams.get('tag')?.slice(0, 24) || null;
    const pageN = Math.max(1, Math.min(1000, parseInt(ctx.url.searchParams.get('page') ?? '1', 10) || 1));
    const [{ posts, total }, tags] = await Promise.all([store.listPosts({ tag: tag ?? undefined, limit: PER_PAGE, offset: (pageN - 1) * PER_PAGE }), store.allTags()]);
    const comments = await store.commentCounts(posts.map((p) => p.id));
    page(ctx, 200, V.updatesPage(ctx.page, { posts, total, page: pageN, perPage: PER_PAGE, tag, tags, comments }));
  });

  async function neighbours(post: Post) {
    if (post.status !== 'published') return { newer: null, older: null };
    const { posts } = await store.listPosts({ limit: 1000 });
    const i = posts.findIndex((p) => p.id === post.id);
    return { newer: i > 0 ? posts[i - 1] : null, older: i >= 0 && i < posts.length - 1 ? posts[i + 1] : null };
  }

  async function showPost(ctx: Ctx, slug: string, status = 200, extra: { error?: string; draft?: string } = {}) {
    const post = await store.getPostBySlug(slug);
    if (!post || (post.status !== 'published' && !ctx.user?.isAdmin)) { page(ctx, 404, V.notFoundPage(ctx.page, 'update')); return; }
    const [comments, near] = await Promise.all([store.listComments(post.id), neighbours(post)]);
    page(ctx, status, V.postPage(ctx.page, { post, comments, ...near, ...extra }));
  }

  router.get('/updates/:slug', async (ctx, p) => showPost(ctx, p.slug));

  // ------------------------------------------------------------ guides

  router.get('/guides', async (ctx) => {
    if (!cfg.guides) { page(ctx, 404, V.notFoundPage(ctx.page)); return; }
    page(ctx, 200, G.guidesIndexPage(ctx.page, await guides.all()));
  });

  router.get('/guides/:slug', async (ctx, p) => {
    const hit = cfg.guides && /^[a-z0-9-]{1,60}$/.test(p.slug) ? await guides.get(p.slug) : null;
    if (!hit) { page(ctx, 404, V.notFoundPage(ctx.page, 'guide')); return; }
    page(ctx, 200, G.guidePage(ctx.page, hit));
  });

  router.post('/updates/:slug/comments', async (ctx, p) => {
    const user = requireUser(ctx);
    if (!user) return;
    const post = await store.getPostBySlug(p.slug);
    if (!post || post.status !== 'published') { page(ctx, 404, V.notFoundPage(ctx.page, 'update')); return; }
    const f = await fields(ctx);
    const json = wantsJson(ctx); // (the image viewer posts with fetch; the forms post and redirect)
    const body = str(f.body, 5000).replace(/\r\n/g, '\n').trim();
    const fail = (status: number, error: string, draft: string) => (json ? sendJson(ctx.res, status, { error }) : showPost(ctx, p.slug, status, { error, draft }));
    if (!body) return fail(400, 'Write something first.', body);
    if (body.length > 2000) return fail(400, 'Comments can be 2000 characters at most.', body.slice(0, 2000));
    if (limited(ctx, `comment:${user.id}`, LIMITS.comment)) return fail(429, slow(ctx, `comment:${user.id}`, LIMITS.comment), body);
    if (limited(ctx, `commentDay:${user.id}`, LIMITS.commentDaily)) return fail(429, 'Daily comment limit reached.', body);
    // A comment on an image names it by its src; one that isn't an image of this post is just a comment on the post
    const wanted = str(f.image, 1000);
    const cover = V.coverOf(post);
    const images = [...(cover && !postImages(post.body).some((i) => i.src === cover) ? [{ src: cover, alt: post.title }] : []), ...postImages(post.body)];
    const on = wanted ? images.find((i) => i.src === wanted) : undefined;
    const c = await store.addComment({ postId: post.id, authorId: user.id, authorName: user.username, body, image: on?.src ?? null });
    if (json) sendJson(ctx.res, 200, { ok: true, id: c.id, item: String(V.commentItem(ctx.page, post, c, on?.alt ?? '')) });
    else redirect(ctx.res, `/updates/${encodeURIComponent(post.slug)}?ok=commented#c${c.id}`);
  });

  router.get('/rss.xml', async (ctx) => {
    const { posts } = await store.listPosts({ limit: 20 });
    ctx.res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
    ctx.res.end(rssFeed(posts, { origin: cfg.origin, siteName: cfg.name }));
  });
  router.get('/updates/rss.xml', (ctx) => redirect(ctx.res, '/rss.xml', 301));

  // ------------------------------------------------------------ suggestions

  async function showSuggestions(ctx: Ctx, status = 200, extra: { error?: string; draft?: { title: string; body: string } } = {}) {
    const sort = ctx.url.searchParams.get('sort') === 'new' ? 'new' : 'top';
    const st = ctx.url.searchParams.get('status') as SuggestionStatus | null;
    const filter = st && (SUGGESTION_STATUSES as readonly string[]).includes(st) ? st : null;
    const [list, counts] = await Promise.all([store.listSuggestions({ sort, status: filter ?? undefined }), store.suggestionCounts()]);
    const voted = ctx.user ? await store.votedBy(ctx.user.id, list.map((s) => s.id)) : new Set<number>();
    page(ctx, status, V.suggestionsPage(ctx.page, { list, sort, status: filter, voted, counts, ...extra }));
  }

  router.get('/suggestions', (ctx) => showSuggestions(ctx));

  router.post('/suggestions', async (ctx) => {
    const user = requireUser(ctx);
    if (!user) return;
    const f = await fields(ctx);
    const title = str(f.title, 500).replace(/\s+/g, ' ').trim();
    const body = str(f.body, 5000).replace(/\r\n/g, '\n').trim();
    const draft = { title: title.slice(0, 120), body: body.slice(0, 2000) };
    if (title.length < 4) return showSuggestions(ctx, 400, { error: 'Give it a title of at least a few words.', draft });
    if (title.length > 120 || body.length > 2000) return showSuggestions(ctx, 400, { error: 'Titles can be 120 characters, the details 2000.', draft });
    if (limited(ctx, `suggest:${user.id}`, LIMITS.suggestion)) return showSuggestions(ctx, 429, { error: slow(ctx, `suggest:${user.id}`, LIMITS.suggestion), draft });
    const s = await store.addSuggestion({ title, body, authorId: user.id, authorName: user.username });
    await store.setVote(s.id, user.id, true); // you back your own idea
    redirect(ctx.res, `/suggestions?sort=new&ok=suggested#s${s.id}`);
  });

  router.post('/suggestions/:id/vote', async (ctx, p) => {
    const user = requireUser(ctx);
    if (!user) return;
    const f = await fields(ctx);
    const id = Number(p.id);
    const on = !(f.on === false || f.on === '0' || f.on === 'false');
    const json = wantsJson(ctx);
    if (limited(ctx, `vote:${user.id}`, LIMITS.vote)) { json ? sendJson(ctx.res, 429, { error: 'Too many votes at once' }) : redirect(ctx.res, `/suggestions#s${id}`); return; }
    const s = Number.isInteger(id) ? await store.getSuggestion(id) : null;
    if (!s || s.hidden) { json ? sendJson(ctx.res, 404, { error: 'No such suggestion' }) : page(ctx, 404, V.notFoundPage(ctx.page, 'suggestion')); return; }
    if (s.status === 'done' || s.status === 'declined') { json ? sendJson(ctx.res, 409, { error: 'Voting is closed on this one' }) : redirect(ctx.res, `/suggestions#s${id}`); return; }
    const votes = await store.setVote(id, user.id, on);
    if (json) sendJson(ctx.res, 200, { votes, voted: on });
    else redirect(ctx.res, `${backTo(f.back, '/suggestions')}#s${id}`);
  });

  // ------------------------------------------------------------ shoutbox

  router.get('/shoutbox/stream', async (ctx) => { await hub.open(ctx.req, ctx.res, ctx.ip); });

  router.post('/shoutbox', async (ctx) => {
    const user = requireUser(ctx);
    if (!user) return;
    const f = await fields(ctx, 8 * 1024);
    const json = wantsJson(ctx);
    const fail = (status: number, error: string) => (json ? sendJson(ctx.res, status, { error }) : redirect(ctx.res, '/#shout-h'));
    const text = cleanShout(str(f.text, 2000));
    if (!text) return fail(400, 'Say something first');
    if (text.length > SHOUT_MAX) return fail(400, `${SHOUT_MAX} characters at most`);
    if (limited(ctx, `shout:${user.id}`, LIMITS.shout) || limited(ctx, `shoutMin:${user.id}`, LIMITS.shoutMinute)) return fail(429, 'Easy there: wait a few seconds');
    const recent = await store.recentShouts(5);
    if (recent.some((s) => s.authorId === user.id && s.text === text && Date.now() - Date.parse(s.createdAt) < 60_000)) return fail(409, 'You just said that');
    const shout = await store.addShout({ authorId: user.id, authorName: user.username, isAdmin: user.isAdmin, text }, SHOUT_KEEP);
    hub.broadcast('shout', publicShout(shout));
    if (json) sendJson(ctx.res, 200, { ok: true, shout: publicShout(shout) });
    else redirect(ctx.res, '/#shout-h');
  });

  async function deleteShout(ctx: Ctx, p: Params) {
    if (!requireAdmin(ctx)) return;
    await fields(ctx);
    const id = Number(p.id);
    if (await store.deleteShout(id)) hub.broadcast('delete', { id });
    if (wantsJson(ctx)) sendJson(ctx.res, 200, { ok: true });
    else redirect(ctx.res, '/admin/shoutbox?ok=removed');
  }
  router.post('/shoutbox/:id/delete', deleteShout);
  router.post('/admin/shoutbox/:id/delete', deleteShout);

  // ------------------------------------------------------------ sign in, register, out

  router.get('/signin', (ctx) => {
    if (ctx.user) return redirect(ctx.res, safeNext(ctx.url.searchParams.get('next')));
    page(ctx, 200, V.signInPage(ctx.page, { mode: 'signin', next: safeNext(ctx.url.searchParams.get('next')) }));
  });
  router.get('/register', (ctx) => {
    if (ctx.user) return redirect(ctx.res, safeNext(ctx.url.searchParams.get('next')));
    page(ctx, 200, V.signInPage(ctx.page, { mode: 'register', next: safeNext(ctx.url.searchParams.get('next')) }));
  });

  async function auth(ctx: Ctx, mode: 'signin' | 'register') {
    const f = await fields(ctx);
    const username = str(f.username, 254).trim();
    const email = str(f.email, 254).trim();
    const password = str(f.password, 500);
    const next = safeNext(f.next);
    const again = (status: number, error: string) => page(ctx, status, V.signInPage(ctx.page, { mode, next, error, username, email }));
    const key = `${mode}:${ctx.ip}`;
    if (limited(ctx, key, mode === 'signin' ? LIMITS.signin : LIMITS.register)) return again(429, slow(ctx, key, mode === 'signin' ? LIMITS.signin : LIMITS.register));
    if (!username || !password || (mode === 'register' && !email)) return again(400, 'Fill in every field.');
    const r = mode === 'signin' ? await lobby.login(username, password, ctx.ip) : await lobby.register(username, email, password, ctx.ip);
    if (!r.ok) return again(r.status === 429 ? 429 : r.status >= 500 ? 503 : 400, r.error);
    sessions.set(r.token, { user: r.user, until: Date.now() + SESSION_CACHE_MS });
    setSession(ctx, r.token);
    const sep = next.includes('?') ? '&' : '?';
    const [p, hash] = next.split('#');
    redirect(ctx.res, `${p}${sep}ok=${mode === 'signin' ? 'signedin' : 'registered'}${hash ? `#${hash}` : ''}`);
  }
  router.post('/signin', (ctx) => auth(ctx, 'signin'));
  router.post('/register', (ctx) => auth(ctx, 'register'));

  router.post('/signout', async (ctx) => {
    await fields(ctx);
    if (ctx.token) { await lobby.logout(ctx.token); forget(ctx.token); }
    setSession(ctx, null);
    redirect(ctx.res, '/?ok=signedout');
  });

  // ------------------------------------------------------------ account

  async function showAccount(ctx: Ctx, status = 200, errors: Partial<Record<V.AccountForm, string>> = {}) {
    const user = requireUser(ctx);
    if (!user) return;
    const acc = await lobby.account(ctx.token!);
    if (!acc.ok) { forget(ctx.token); setSession(ctx, null); return redirect(ctx.res, '/signin?next=/account'); }
    const card = await pilots.card(acc.account.id);
    page(ctx, status, V.accountPage(ctx.page, { account: acc.account, card, errors }));
  }
  router.get('/account', (ctx) => showAccount(ctx));

  router.post('/account/:action', async (ctx, p) => {
    const user = requireUser(ctx);
    if (!user) return;
    const f = await fields(ctx);
    const token = ctx.token!;
    const key = `account:${user.id}`;
    const forms: Record<string, V.AccountForm> = { email: 'email', password: 'password', 'signout-all': 'everywhere', delete: 'delete' };
    const form = Object.hasOwn(forms, p.action) ? forms[p.action] : undefined;
    if (!form) { page(ctx, 404, V.notFoundPage(ctx.page)); return; }
    if (form !== 'everywhere' && limited(ctx, key, LIMITS.account)) return showAccount(ctx, 429, { [form]: slow(ctx, key, LIMITS.account) });
    const password = str(f.password, 500);

    if (form === 'email') {
      const r = await lobby.changeEmail(token, password, str(f.email, 254), ctx.ip);
      if (!r.ok) return showAccount(ctx, 400, { email: r.error });
      return redirect(ctx.res, '/account?ok=email');
    }
    if (form === 'password') {
      const next = str(f.newPassword, 500);
      if (next !== str(f.repeat, 500)) return showAccount(ctx, 400, { password: "The new passwords don't match." });
      const r = await lobby.changePassword(token, password, next, ctx.ip);
      if (!r.ok) return showAccount(ctx, 400, { password: r.error });
      sessions.clear(); // other sessions of this account ended
      return redirect(ctx.res, '/account?ok=password');
    }
    if (form === 'everywhere') {
      const r = await lobby.logoutAll(token);
      if (!r.ok) return showAccount(ctx, 400, { everywhere: r.error });
      sessions.clear();
      setSession(ctx, null);
      return redirect(ctx.res, '/?ok=everywhere');
    }
    // delete
    if (str(f.confirm, 100).trim().toLowerCase() !== user.username.toLowerCase()) return showAccount(ctx, 400, { delete: 'Type your pilot name exactly to confirm.' });
    const r = await lobby.deleteAccount(token, password, ctx.ip);
    if (!r.ok) return showAccount(ctx, 400, { delete: r.error });
    await store.forgetUser(user.id);
    sessions.clear();
    setSession(ctx, null);
    console.log(`[Site] account ${user.username} (#${user.id}) deleted; site content unsigned`);
    redirect(ctx.res, '/?ok=deleted');
  });

  // ------------------------------------------------------------ pilots

  router.get('/pilots', async (ctx) => {
    const period = ctx.url.searchParams.get('period') === 'weekly' ? 'weekly' : 'allTime';
    page(ctx, 200, V.pilotsPage(ctx.page, { rankings: await pilots.rankings(), period }));
  });

  router.get('/pilots/find', (ctx) => {
    const name = (ctx.url.searchParams.get('name') ?? '').trim().slice(0, 20);
    redirect(ctx.res, name ? `/pilots/${encodeURIComponent(name)}` : '/pilots');
  });

  router.get('/pilots/:name', async (ctx, p) => {
    const name = p.name.slice(0, 40);
    if (!/^[A-Za-z0-9_-]{2,20}$/.test(name)) { page(ctx, 404, V.notFoundPage(ctx.page, 'pilot')); return; }
    const [account, rankings] = await Promise.all([lobby.findUser(name), pilots.rankings()]);
    // Without the lobby's admin secret, the rankings still know names and ids
    let id = account?.id ?? null;
    let shown = account?.username ?? null;
    if (!id && rankings) {
      for (const b of Object.values(rankings.allTime)) {
        const row = b.find((r) => r.name.toLowerCase() === name.toLowerCase());
        if (row) { id = Number(row.userId); shown = row.name; break; }
      }
    }
    if (!id || !shown) { page(ctx, 404, V.notFoundPage(ctx.page, 'pilot')); return; }
    const [card, ships, cat] = await Promise.all([pilots.card(id), store.listShips({ ownerId: id, limit: 12 }), catalog.get()]);
    const ranks: { label: string; rank: number; value: number }[] = [];
    if (rankings) for (const b of BOARDS) {
      const i = (rankings.allTime[b.key] ?? []).findIndex((r) => Number(r.userId) === id);
      if (i >= 0) ranks.push({ label: b.label, rank: i + 1, value: rankings.allTime[b.key][i].value });
    }
    page(ctx, 200, V.pilotPage(ctx.page, { name: shown, card, ranks, ships, render: cat?.render ?? null, names: { bosses: cat ? Object.fromEntries(cat.bosses.map((b) => [b.id, b.name])) : {}, ribbons: Object.fromEntries((cat?.ribbons ?? []).map((r) => [r.id, r.name])) } }));
  });

  // ------------------------------------------------------------ play

  router.get('/play', async (ctx) => {
    if (cfg.game.mode === 'link') return redirect302(ctx, cfg.game.url);
    const index = await gameIndex(cfg.game);
    if (!index) {
      page(ctx, 503, V.errorPage(ctx.page, "The game isn't reachable", cfg.game.mode === 'proxy' ? `The game's dev server (${cfg.game.devUrl}) isn't answering. Start it with npm run dev:client.` : "The game files aren't there. Try again in a minute."));
      return;
    }
    // Only a live session is handed over (a stale one would only bounce off the lobby)
    const token = ctx.user && ctx.token ? ctx.token : null;
    // The game is its own app: the site's strict CSP would block Pixi (it needs eval), the inline handoff,
    // and the game's sockets to the lobby and game servers. It keeps the other headers.
    ctx.res.removeHeader('Content-Security-Policy');
    ctx.res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
    ctx.res.end(injectHandoff(index, token));
  });

  function redirect302(ctx: Ctx, to: string) {
    ctx.res.writeHead(302, { Location: to });
    ctx.res.end();
  }

  // ------------------------------------------------------------ admin

  router.get('/admin', async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const [{ posts }, comments, suggestions, shouts, live] = await Promise.all([
      store.listPosts({ status: 'all', limit: 10_000 }), store.recentComments(100), store.suggestionCounts(), store.recentShouts(SHOUT_KEEP), pilots.live(),
    ]);
    page(ctx, 200, A.adminOverview(ctx.page, {
      posts: { published: posts.filter((p) => p.status === 'published').length, drafts: posts.filter((p) => p.status === 'draft').length },
      comments: comments.length, suggestions, shouts: shouts.length, streams: hub.size, live, lobbyAdmin: !!cfg.lobbyAdminSecret,
    }));
  });

  router.get('/admin/posts', async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const { posts } = await store.listPosts({ status: 'all', limit: 500 });
    page(ctx, 200, A.adminPosts(ctx.page, posts, notice(ctx)));
  });

  router.get('/admin/posts/new', (ctx) => {
    if (!requireAdmin(ctx)) return;
    page(ctx, 200, A.adminEditor(ctx.page, { post: { body: '', tags: [] } }));
  });

  router.get('/admin/posts/:id', async (ctx, p) => {
    if (!requireAdmin(ctx)) return;
    const post = await store.getPost(Number(p.id));
    if (!post) { page(ctx, 404, V.notFoundPage(ctx.page, 'post')); return; }
    page(ctx, 200, A.adminEditor(ctx.page, { post, notice: notice(ctx) }));
  });

  router.post('/admin/posts', async (ctx) => {
    const admin = requireAdmin(ctx);
    if (!admin) return;
    const f = await fields(ctx, 512 * 1024);
    const c = checkPost(f, false);
    if (!c.ok) return page(ctx, 400, A.adminEditor(ctx.page, { post: formPost(f), error: c.error }));
    if (c.value.status === 'published' && !admin.isOwner) return page(ctx, 403, A.adminEditor(ctx.page, { post: formPost(f), error: OWNER_PUBLISHES }));
    const post = await store.createPost({ ...c.value, authorId: admin.id, authorName: admin.username });
    if (!post) return page(ctx, 400, A.adminEditor(ctx.page, { post: formPost(f), error: `There's already a post at /updates/${c.value.slug}: pick another slug.` }));
    redirect(ctx.res, `/admin/posts/${post.id}?ok=${post.status === 'published' ? 'published' : 'saved'}`);
  });

  router.post('/admin/posts/:id', async (ctx, p) => {
    const admin = requireAdmin(ctx);
    if (!admin) return;
    const existing = await store.getPost(Number(p.id));
    if (!existing) { page(ctx, 404, V.notFoundPage(ctx.page, 'post')); return; }
    const f = await fields(ctx, 512 * 1024);
    const c = checkPost(f, false);
    if (!c.ok) return page(ctx, 400, A.adminEditor(ctx.page, { post: { ...existing, ...formPost(f) }, error: c.error }));
    if ((existing.status === 'published' || c.value.status === 'published') && !admin.isOwner) {
      return page(ctx, 403, A.adminEditor(ctx.page, { post: { ...existing, ...formPost(f) }, error: OWNER_PUBLISHES }));
    }
    const post = await store.updatePost(existing.id, c.value);
    if (!post) return page(ctx, 400, A.adminEditor(ctx.page, { post: { ...existing, ...formPost(f) }, error: `There's already a post at /updates/${c.value.slug}: pick another slug.` }));
    redirect(ctx.res, `/admin/posts/${post.id}?ok=${post.status === 'published' && existing.status !== 'published' ? 'published' : post.status === 'draft' && existing.status === 'published' ? 'unpublished' : 'saved'}`);
  });

  router.post('/admin/posts/:id/:action', async (ctx, p) => {
    const admin = requireAdmin(ctx);
    if (!admin) return;
    await fields(ctx);
    const id = Number(p.id);
    const post = await store.getPost(id);
    if (!post) { page(ctx, 404, V.notFoundPage(ctx.page, 'post')); return; }
    // (Publishing, and taking down or deleting what's live, are the owner's)
    if ((p.action === 'publish' || p.action === 'unpublish' || post.status === 'published') && !requireOwner(ctx)) return;
    if (p.action === 'publish' || p.action === 'unpublish') {
      await store.updatePost(id, { status: p.action === 'publish' ? 'published' : 'draft' });
      return redirect(ctx.res, `/admin/posts?ok=${p.action === 'publish' ? 'published' : 'unpublished'}`);
    }
    if (p.action === 'delete') { await store.deletePost(id); return redirect(ctx.res, '/admin/posts?ok=postdeleted'); }
    page(ctx, 404, V.notFoundPage(ctx.page));
  });

  router.get('/admin/comments', async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const comments = await store.recentComments(200);
    const posts = new Map<number, Post>();
    for (const id of new Set(comments.map((c) => c.postId))) { const p = await store.getPost(id); if (p) posts.set(id, p); }
    page(ctx, 200, A.adminComments(ctx.page, { comments, posts }, notice(ctx)));
  });

  router.post('/admin/comments/:id/:action', async (ctx, p) => {
    if (!requireAdmin(ctx)) return;
    const f = await fields(ctx);
    const id = Number(p.id);
    if (p.action === 'hide' || p.action === 'show') await store.setCommentHidden(id, p.action === 'hide');
    else if (p.action === 'delete') await store.deleteComment(id);
    else { page(ctx, 404, V.notFoundPage(ctx.page)); return; }
    const okKey = p.action === 'hide' ? 'hidden' : p.action === 'show' ? 'shown' : 'removed';
    const back = backTo(f.back, '/admin/comments');
    const [pathPart, hash] = back.split('#');
    redirect(ctx.res, `${pathPart}${pathPart.includes('?') ? '&' : '?'}ok=${okKey}${hash ? `#${hash}` : ''}`);
  });

  router.get('/admin/suggestions', async (ctx) => {
    if (!requireAdmin(ctx)) return;
    page(ctx, 200, A.adminSuggestions(ctx.page, await store.listSuggestions({ sort: 'new', includeHidden: true, limit: 500 }), notice(ctx)));
  });

  router.post('/admin/suggestions/:id', async (ctx, p) => {
    const admin = requireAdmin(ctx);
    if (!admin) return;
    const f = await fields(ctx);
    const status = str(f.status) as SuggestionStatus;
    if (!(SUGGESTION_STATUSES as readonly string[]).includes(status)) { sendHtml(ctx.res, 400, 'Bad status'); return; }
    await store.setSuggestionStatus(Number(p.id), status, str(f.reply, 2000), admin.username);
    redirect(ctx.res, `/admin/suggestions?ok=saved#s${Number(p.id)}`);
  });

  router.post('/admin/suggestions/:id/:action', async (ctx, p) => {
    if (!requireAdmin(ctx)) return;
    await fields(ctx);
    const id = Number(p.id);
    if (p.action === 'hide' || p.action === 'show') await store.setSuggestionHidden(id, p.action === 'hide');
    else if (p.action === 'delete') await store.deleteSuggestion(id);
    else { page(ctx, 404, V.notFoundPage(ctx.page)); return; }
    redirect(ctx.res, `/admin/suggestions?ok=${p.action === 'hide' ? 'hidden' : p.action === 'show' ? 'shown' : 'removed'}`);
  });

  router.get('/admin/shoutbox', async (ctx) => {
    if (!requireAdmin(ctx)) return;
    page(ctx, 200, A.adminShoutbox(ctx.page, await store.recentShouts(SHOUT_KEEP), notice(ctx)));
  });

  router.get('/admin/tokens', async (ctx) => {
    if (!requireOwner(ctx)) return;
    page(ctx, 200, A.adminTokens(ctx.page, { tokens: await store.listTokens() }, notice(ctx)));
  });

  router.post('/admin/tokens', async (ctx) => {
    const admin = requireOwner(ctx);
    if (!admin) return;
    const f = await fields(ctx);
    const name = str(f.name, 60).replace(/\s+/g, ' ').trim() || 'token';
    const t = newApiToken();
    await store.createToken({ name, hash: t.hash, prefix: t.prefix, createdBy: admin.id, createdByName: admin.username });
    console.log(`[Site] API token "${name}" created by ${admin.username}`);
    // Shown once, in this response (not a redirect: it must never be in a URL)
    page(ctx, 200, A.adminTokens(ctx.page, { tokens: await store.listTokens(), created: { name, token: t.token } }));
  });

  router.post('/admin/tokens/:id/revoke', async (ctx, p) => {
    if (!requireOwner(ctx)) return;
    await fields(ctx);
    await store.revokeToken(Number(p.id));
    redirect(ctx.res, '/admin/tokens?ok=revoked');
  });

  /** The pilots list (a refusal from the lobby shown above it, with the status it came with) */
  async function pilotsPage(ctx: Ctx, search: string, refused?: { error: string; status: number }) {
    if (!cfg.lobbyAdminSecret) return page(ctx, 200, A.adminPilots(ctx.page, { users: [], total: 0, search, enabled: false }));
    const r = await lobby.listUsers(search, 0, 100);
    const status = refused ? (refused.status === 403 ? 403 : 400) : 200;
    const n = refused ? { kind: 'error' as const, text: refused.error } : notice(ctx);
    page(ctx, status, A.adminPilots(ctx.page, r.ok ? { users: r.users, total: r.total, search, enabled: true } : { users: [], total: 0, search, enabled: true, error: r.error }, n));
  }

  router.get('/admin/pilots', async (ctx) => {
    if (!requireAdmin(ctx)) return;
    await pilotsPage(ctx, (ctx.url.searchParams.get('q') ?? '').trim().slice(0, 20));
  });

  // Bans are moderation (admins, of pilots; the owner, of admins too); admin rank and deleting accounts are the owner's.
  // Each names the signed-in admin to the lobby, which checks the same rules.
  router.post('/admin/pilots/:action', async (ctx, p) => {
    const admin = requireAdmin(ctx);
    if (!admin) return;
    const f = await fields(ctx);
    const username = str(f.username, 40);
    const done = (r: { ok: true } | { ok: false; error: string; status: number }, ok: string) => {
      if (!r.ok) return pilotsPage(ctx, username, r);
      sessions.clear(); // (cached sessions carry the old rank, or a deleted account)
      redirect(ctx.res, `/admin/pilots?q=${encodeURIComponent(username)}&ok=${ok}`);
    };
    if (p.action === 'ban') {
      if (username.toLowerCase() === admin.username.toLowerCase()) return redirect(ctx.res, '/admin/pilots');
      const days = str(f.days);
      const until = days === 'forever' ? null : Date.now() + Math.max(1, Math.min(3650, Number(days) || 1)) * 86_400_000;
      const r = await lobby.ban(username, until, str(f.reason, 200).trim() || 'No reason given', admin.username, admin.username);
      if (r.ok) console.log(`[Site] ${admin.username} banned ${username}`);
      return done(r, 'banned');
    }
    if (p.action === 'unban') return done(await lobby.unban(username, admin.username), 'unbanned');
    if (p.action === 'admin') {
      if (!requireOwner(ctx)) return;
      const on = str(f.on) === '1';
      const r = await lobby.setAdmin(username, on, admin.username);
      if (r.ok) console.log(`[Site] ${admin.username} ${on ? 'made' : 'removed'} ${username} ${on ? 'an admin' : 'as admin'}`);
      return done(r, on ? 'promoted' : 'demoted');
    }
    if (p.action === 'delete') {
      if (!requireOwner(ctx)) return;
      const r = await lobby.deleteUser(username, admin.username);
      if (r.ok) console.log(`[Site] ${admin.username} deleted the account ${username}`);
      return done(r, 'accountdeleted');
    }
    page(ctx, 404, V.notFoundPage(ctx.page));
  });

  // ------------------------------------------------------------ API

  /** Who's calling the admin API (null: it has answered 401/403) */
  async function apiAdmin(ctx: Ctx): Promise<Ctx['api']> {
    if (ctx.api) return ctx.api;
    if (ctx.user?.isAdmin) return (ctx.api = { via: 'session', name: ctx.user.username, userId: ctx.user.id, author: ctx.user.username, owner: !!ctx.user.isOwner });
    sendJson(ctx.res, ctx.user ? 403 : 401, { error: ctx.user ? 'Admins only' : 'Send Authorization: Bearer <token> (an API token from /admin/tokens)' });
    return null;
  }

  /** A change to what's live (publishing, unpublishing, editing or deleting a published post) by a caller who isn't the owner: refused (true) */
  function notOwners(ctx: Ctx, who: NonNullable<Ctx['api']>, live: boolean): boolean {
    if (!live || who.owner) return false;
    sendJson(ctx.res, 403, { error: OWNER_PUBLISHES });
    return true;
  }

  function postJson(p: Post) {
    return { ...p, url: `${cfg.origin}/updates/${encodeURIComponent(p.slug)}` };
  }

  router.get('/api/v1/me', async (ctx) => {
    const who = await apiAdmin(ctx);
    if (who) sendJson(ctx.res, 200, { name: who.name, userId: who.userId, via: who.via });
  });

  router.get('/api/v1/posts', async (ctx) => {
    if (!(await apiAdmin(ctx))) return;
    const st = ctx.url.searchParams.get('status');
    const status = st === 'draft' || st === 'published' ? st : 'all';
    const { posts, total } = await store.listPosts({ status, limit: 500 });
    sendJson(ctx.res, 200, { total, posts: posts.map(({ body: _b, ...rest }) => ({ ...rest, url: `${cfg.origin}/updates/${encodeURIComponent(rest.slug)}` })) });
  });

  router.get('/api/v1/posts/:slug', async (ctx, p) => {
    if (!(await apiAdmin(ctx))) return;
    const post = await store.getPostBySlug(p.slug);
    post ? sendJson(ctx.res, 200, { post: postJson(post) }) : sendJson(ctx.res, 404, { error: 'No such post' });
  });

  router.post('/api/v1/posts', async (ctx) => {
    const who = await apiAdmin(ctx);
    if (!who) return;
    const f = await fields(ctx, 512 * 1024);
    const c = checkPost(f, false);
    if (!c.ok) return sendJson(ctx.res, 400, { error: c.error });
    const existing = await store.getPostBySlug(c.value.slug);
    if (existing) {
      // Upsert: re-posting the same file updates it (fields not sent keep their values)
      const patch = checkPost(f, true);
      if (!patch.ok) return sendJson(ctx.res, 400, { error: patch.error });
      if (notOwners(ctx, who, existing.status === 'published' || patch.value.status === 'published')) return;
      const post = await store.updatePost(existing.id, { ...patch.value, slug: existing.slug });
      console.log(`[Site] API: ${who.name} updated "${existing.slug}" (${post?.status})`);
      return sendJson(ctx.res, 200, { created: false, post: postJson(post!) });
    }
    if (notOwners(ctx, who, c.value.status === 'published')) return;
    const post = await store.createPost({ ...c.value, authorId: who.userId, authorName: who.author });
    if (!post) return sendJson(ctx.res, 409, { error: 'That slug is taken' });
    console.log(`[Site] API: ${who.name} created "${post.slug}" (${post.status})`);
    sendJson(ctx.res, 201, { created: true, post: postJson(post) });
  });

  async function patchPost(ctx: Ctx, p: Params) {
    const who = await apiAdmin(ctx);
    if (!who) return;
    const existing = await store.getPostBySlug(p.slug);
    if (!existing) return sendJson(ctx.res, 404, { error: 'No such post' });
    const f = await fields(ctx, 512 * 1024);
    const c = checkPost(f, true);
    if (!c.ok) return sendJson(ctx.res, 400, { error: c.error });
    if (notOwners(ctx, who, existing.status === 'published' || c.value.status === 'published')) return;
    const post = await store.updatePost(existing.id, c.value);
    post ? sendJson(ctx.res, 200, { post: postJson(post) }) : sendJson(ctx.res, 409, { error: 'That slug is taken' });
  }
  router.on('PATCH', '/api/v1/posts/:slug', patchPost);

  router.on('DELETE', '/api/v1/posts/:slug', async (ctx, p) => {
    const who = await apiAdmin(ctx);
    if (!who) return;
    const existing = await store.getPostBySlug(p.slug);
    if (!existing) return sendJson(ctx.res, 404, { error: 'No such post' });
    if (notOwners(ctx, who, existing.status === 'published')) return;
    await store.deletePost(existing.id);
    sendJson(ctx.res, 200, { deleted: true });
  });

  router.post('/api/v1/uploads', async (ctx) => {
    const who = await apiAdmin(ctx);
    if (!who) return;
    if (limited(ctx, `upload:${who.userId}`, LIMITS.upload)) return sendJson(ctx.res, 429, { error: 'Too many uploads' });
    let buf: Buffer;
    try { buf = await readBody(ctx.req, MAX_UPLOAD_BYTES); } catch (e) { return sendJson(ctx.res, e instanceof HttpError ? e.status : 400, { error: 'Images can be 8 MB at most' }); }
    const r = await uploads.save(buf);
    r.ok ? sendJson(ctx.res, 201, { url: r.url, bytes: r.bytes }) : sendJson(ctx.res, 400, { error: r.error });
  });

  router.post('/api/v1/preview', async (ctx) => {
    if (!(await apiAdmin(ctx))) return;
    const f = await fields(ctx, 512 * 1024);
    sendJson(ctx.res, 200, { html: renderMarkdown(str(f.body, 200_000), 'post') });
  });

  router.post('/api/v1/session', async (ctx) => {
    const f = await fields(ctx);
    const key = `signin:${ctx.ip}`;
    if (limited(ctx, key, LIMITS.signin)) return sendJson(ctx.res, 429, { error: 'Too many attempts. Wait a minute.' });
    const r = await lobby.login(str(f.username, 254), str(f.password, 500), ctx.ip);
    if (!r.ok) return sendJson(ctx.res, r.status === 429 ? 429 : 401, { error: r.error });
    if (!r.user.isAdmin) { await lobby.logout(r.token); return sendJson(ctx.res, 403, { error: 'Admins only' }); }
    sendJson(ctx.res, 200, { token: r.token, name: r.user.username });
  });

  router.on('DELETE', '/api/v1/session', async (ctx) => {
    const bearer = bearerOf(ctx.req);
    if (bearer && !bearer.startsWith(TOKEN_PREFIX)) { await lobby.logout(bearer); forget(bearer); }
    sendJson(ctx.res, 200, { ok: true });
  });

  // ------------------------------------------------------------ features (catalog, ships, status, changelog)

  const env: RouteEnv = {
    router, cfg, store, catalog, statusFile,
    page: (ctx, status, body) => page(ctx, status, body),
    notFound: (ctx, what) => page(ctx, 404, V.notFoundPage(ctx.page, what)),
    limited: (ctx, key, rule) => limited(ctx, key, rule),
    requireAdmin: (ctx) => requireAdmin(ctx),
    fields: (ctx, max) => fields(ctx, max),
    activity: deps.activity ?? new HttpActivityClient(),
    setCookie: (ctx, c) => appendCookie(ctx.res, c),
  };
  registerActivity(env);
  registerCatalog(env);
  registerChangelog(env);
  registerShips(env);
  registerStatus(env);

  // ------------------------------------------------------------ the request

  function bearerOf(req: http.IncomingMessage): string | null {
    const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ''));
    return m ? m[1] : null;
  }

  async function serveStatic(res: http.ServerResponse, rel: string): Promise<boolean> {
    const file = path.resolve(cfg.publicDir, '.' + path.posix.normalize('/' + rel));
    if (!file.startsWith(cfg.publicDir + path.sep)) return false;
    try {
      const buf = await fs.readFile(file);
      res.writeHead(200, {
        'Content-Type': STATIC_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Cache-Control': cfg.production ? 'public, max-age=86400' : 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(buf);
      return true;
    } catch { return false; }
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let url: URL;
    try { url = new URL(req.url ?? '/', 'http://site.local'); } catch { res.writeHead(400); res.end(); return; }
    const pathname = url.pathname;

    // The game's dev files (proxy mode): straight through to Vite
    if (cfg.game.mode === 'proxy' && isDevGamePath(pathname)) { proxyToDev(cfg.game.devUrl, req, res); return; }
    if (pathname.startsWith('/static/') && (req.method === 'GET' || req.method === 'HEAD')) {
      if (await serveStatic(res, pathname.slice('/static/'.length))) return;
      res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return;
    }
    if (pathname.startsWith('/uploads/') && req.method === 'GET') {
      const name = pathname.slice('/uploads/'.length);
      const buf = await uploads.read(name);
      if (!buf) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': contentType(name), 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" });
      res.end(buf);
      return;
    }
    if (pathname === '/favicon.ico') { if (await serveStatic(res, 'favicon.svg')) return; }
    if (pathname === '/robots.txt') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('User-agent: *\nDisallow: /admin\nDisallow: /account\nDisallow: /api\n'); return; }

    securityHeaders(res, cfg.secureCookies);
    const cookies = parseCookies(req.headers.cookie);
    let csrfSeed = cookies[CSRF_COOKIE];
    if (!csrfSeed || csrfSeed.length < 16 || csrfSeed.length > 64) {
      csrfSeed = Csrf.seed();
      appendCookie(res, cookie(CSRF_COOKIE, csrfSeed, { secure: cfg.secureCookies, maxAge: 365 * 86400 }));
    }
    const ip = ipOf(req);
    let token: string | null = cookies[SESSION_COOKIE] || null;
    if (token && !/^[A-Za-z0-9_-]{16,256}$/.test(token)) token = null;
    let user = token ? await userFor(token) : null;
    if (token && !user) { appendCookie(res, cookie(SESSION_COOKIE, '', { maxAge: 0, secure: cfg.secureCookies })); token = null; }

    // The API: a bearer token instead of cookies (no CSRF: nothing is sent automatically)
    let api: Ctx['api'] = null;
    let game = false;
    const bearer = pathname.startsWith('/api/') ? bearerOf(req) : null;
    if (bearer && keyMatches(bearer, cfg.gameKey)) {
      // The game server: not an admin and not a browser session, so it can only do what the game-only routes allow
      if (!limiter.hit(`api:${ip}`, LIMITS.api.limit, LIMITS.api.windowMs)) { sendJson(res, 429, { error: 'Slow down' }); return; }
      game = true; user = null; token = null;
    } else if (bearer && !(pathname === '/api/v1/session' && req.method === 'DELETE')) {
      const failKey = `apifail:${ip}`;
      if (!limiter.hit(`api:${ip}`, LIMITS.api.limit, LIMITS.api.windowMs)) { sendJson(res, 429, { error: 'Slow down' }); return; }
      if (limiter.retryAfter(failKey, LIMITS.apiAuthFail.limit, LIMITS.apiAuthFail.windowMs) > 0) { sendJson(res, 429, { error: 'Too many bad tokens; wait a few minutes' }); return; }
      if (bearer.startsWith(TOKEN_PREFIX)) {
        const t = await store.findToken(hashToken(bearer));
        if (t) {
          // (A token can publish while its maker is the owner: asked of the lobby each call, so a demoted maker's can't)
          const maker = await lobby.findUser(t.createdByName);
          api = { via: 'token', name: `${t.createdByName} (${t.name})`, userId: t.createdBy, author: t.createdByName, owner: !!maker?.isOwner && maker.id === t.createdBy };
          void store.touchToken(t.id);
        }
      } else {
        const u = await userFor(bearer);
        if (u?.isAdmin) api = { via: 'lobby', name: u.username, userId: u.id, author: u.username, owner: !!u.isOwner };
      }
      if (!api) { limiter.hit(failKey, LIMITS.apiAuthFail.limit, LIMITS.apiAuthFail.windowMs); sendJson(res, 401, { error: 'That token is not valid (or not an admin\'s)' }); return; }
      user = null; token = null; // a bearer call never acts as the browser's session
    }

    const csrfToken = csrf.token(csrfSeed);
    const live = await pilots.live();
    const ctx: Ctx = {
      req, res, url, path: pathname, ip, token, user, csrf: csrfToken, csrfSeed, api, game,
      page: { siteName: cfg.name, user, csrf: csrfToken, path: pathname, live: live ? { players: live.players, fresh: live.fresh } : null, origin: cfg.origin, authors: cfg.authors, guides: cfg.guides },
    };

    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? 'GET');
    if (unsafe && !api && !game) {
      // Cross-site posts are refused outright; same-site ones need the token
      // (forms send _csrf; scripts send X-CSRF-Token). /api/v1/session is a
      // credential exchange for the CLI and sends no cookies' worth of trust.
      const exempt = pathname === '/api/v1/session';
      if (!exempt && !sameOrigin(req, cfg.origin)) { sendJson(res, 403, { error: 'Cross-site request refused' }); return; }
      if (!exempt) {
        let given = req.headers['x-csrf-token'] ? String(req.headers['x-csrf-token']) : undefined;
        if (!given) {
          const type = String(req.headers['content-type'] ?? '');
          if (type.startsWith('application/x-www-form-urlencoded')) {
            // Peek the form for _csrf, then hand the parsed fields to the route
            const parsed = await readFields(req);
            given = typeof parsed._csrf === 'string' ? parsed._csrf : undefined;
            (req as { __fields?: Record<string, any> }).__fields = parsed;
          }
        }
        if (!csrf.verify(csrfSeed, given)) {
          if (wantsJson(ctx)) sendJson(res, 403, { error: 'Your session form expired. Reload the page and try again.' });
          else sendHtml(res, 403, V.errorPage(ctx.page, 'That form expired', 'Go back, reload the page and try again.'));
          return;
        }
      }
    }

    const m = router.match(req.method ?? 'GET', pathname);
    if (m === 'method') { res.setHeader('Allow', 'GET, POST'); sendJson(res, 405, { error: 'Method not allowed' }); return; }
    if (!m) {
      if (pathname.startsWith('/api/')) sendJson(res, 404, { error: 'Not found' });
      else sendHtml(res, 404, V.notFoundPage(ctx.page));
      return;
    }
    ctx.page.notice = notice(ctx);
    await m.handler(ctx, m.params);
  }

  return {
    async handle(req: http.IncomingMessage, res: http.ServerResponse) {
      try {
        await handle(req, res);
      } catch (e) {
        const status = e instanceof HttpError ? e.status : 500;
        if (status === 500) console.error('[Site] error:', e);
        if (!res.headersSent) sendJson(res, status, { error: e instanceof HttpError ? e.message : 'Something went wrong' });
        else res.end();
      }
    },
    upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer) {
      // Only the game's dev server (Vite HMR) has sockets here
      if (cfg.game.mode === 'proxy') proxyUpgradeToDev(cfg.game.devUrl, req, socket, head);
      else socket.destroy();
    },
    hub,
    close() { hub.close(); },
  };
}

function formPost(f: Record<string, any>): Partial<Post> {
  return {
    title: str(f.title, 140), slug: str(f.slug, 80), summary: str(f.summary, 300), cover: str(f.cover, 300) || null,
    body: str(f.body, 100_000), tags: str(f.tags, 200).split(',').map((t) => t.trim()).filter(Boolean),
  };
}
