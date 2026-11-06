/**
 * The admin Activity page (admins only, here and at every lobby it reads: src/activity.ts says how).
 *   GET  /admin/activity[?source=&server=&type=&player=&q=]   the latest 100, newest first, from every source
 *   GET  /admin/activity/feed[?...same, after.<source>=<id>]  JSON { sources, rows (HTML), cursors }: the page's live updates
 *   POST /admin/activity/connect { source, username, password } sign in to another lobby (its session in an HttpOnly cookie)
 *   POST /admin/activity/disconnect { source }                 and out again
 */

import type { Ctx } from '../app.js';
import { mergeEvents, sourceCookie, type ActivityEvent, type ActivityQuery, type SourceRead } from '../activity.js';
import type { ActivityLobby } from '../config.js';
import { redirect, sendJson, str } from '../http.js';
import { cookie, LIMITS, parseCookies } from '../security.js';
import { activityPage, activityRow, type ActivityFilters, type Row, type SourceView } from '../views/activity.js';
import type { RouteEnv } from './env.js';

const PAGE_ROWS = 100;
const TOKEN = /^[A-Za-z0-9_-]{16,256}$/;
const COOKIE_DAYS = 7;

function filtersOf(ctx: Ctx): ActivityFilters {
  const p = ctx.url.searchParams;
  return { source: str(p.get('source'), 40), server: str(p.get('server'), 64), type: str(p.get('type'), 24), player: str(p.get('player'), 40).trim(), q: str(p.get('q'), 100).trim() };
}

export function registerActivity(env: RouteEnv): void {
  const lobbies = env.cfg.activityLobbies;

  /** This visitor's session at a lobby: the site's own one, or the one they signed in to there */
  function tokenFor(ctx: Ctx, l: ActivityLobby): string | null {
    if (l.own) return ctx.token;
    const t = parseCookies(ctx.req.headers.cookie)[sourceCookie(l)];
    return t && TOKEN.test(t) ? t : null;
  }

  /** Every source this view reads (one, if the filter names it), each asked at once */
  async function readAll(ctx: Ctx, f: ActivityFilters, after: (l: ActivityLobby) => number | undefined) {
    const chosen = lobbies.filter((l) => !f.source || l.id === f.source);
    const q = (l: ActivityLobby): ActivityQuery => ({ limit: PAGE_ROWS, after: after(l), server: f.server || undefined, type: f.type || undefined, player: f.player || undefined, search: f.q || undefined });
    const reads = await Promise.all(chosen.map(async (l) => [l, await env.activity.read(l, tokenFor(ctx, l), q(l))] as [ActivityLobby, SourceRead]));
    const sources: SourceView[] = lobbies.map((l) => {
      const r = reads.find(([x]) => x === l)?.[1];
      const connected = !l.own && !!tokenFor(ctx, l);
      if (!r) return { id: l.id, name: l.name, state: 'ok', own: l.own, connected, live: [] };
      return { id: l.id, name: l.name, state: r.state, error: 'error' in r ? r.error : undefined, own: l.own, connected, live: r.state === 'ok' ? r.live : [] };
    });
    const ok = reads.filter((x): x is [ActivityLobby, Extract<SourceRead, { state: 'ok' }>] => x[1].state === 'ok');
    const rows = mergeEvents(ok.map(([l, r]) => ({ source: l.id, events: r.events })), PAGE_ROWS) as Row[];
    const cursors: Record<string, number> = {};
    for (const [l, r] of ok) cursors[l.id] = Math.max(after(l) ?? 0, ...r.events.map((e: ActivityEvent) => e.id));
    return {
      sources, rows, cursors,
      servers: [...new Set(ok.flatMap(([, r]) => r.servers))],
      types: [...new Set(ok.flatMap(([, r]) => r.types))],
    };
  }

  async function show(ctx: Ctx, status = 200, error?: string) {
    const f = filtersOf(ctx);
    const d = await readAll(ctx, f, () => undefined);
    env.page(ctx, status, activityPage(ctx.page, { ...d, filters: f, error }));
  }

  env.router.get('/admin/activity', async (ctx) => {
    if (!env.requireAdmin(ctx)) return;
    await show(ctx);
  });

  env.router.get('/admin/activity/feed', async (ctx) => {
    if (!env.requireAdmin(ctx)) return;
    const f = filtersOf(ctx);
    const after = (l: ActivityLobby) => {
      const n = Number(ctx.url.searchParams.get(`after.${l.id}`));
      return Number.isSafeInteger(n) && n > 0 ? n : undefined;
    };
    // (A source without a cursor, one that wasn't answering when the page loaded, sends its latest page: all new here)
    const d = await readAll(ctx, f, after);
    const names = new Map(lobbies.map((l) => [l.id, l.name]));
    sendJson(ctx.res, 200, {
      sources: d.sources.map((s) => ({ id: s.id, name: s.name, state: s.state })),
      rows: d.rows.map((r) => ({ at: r.at, html: String(activityRow(r, names, lobbies.length > 1)) })),
      cursors: d.cursors,
    });
  });

  env.router.post('/admin/activity/connect', async (ctx) => {
    if (!env.requireAdmin(ctx)) return;
    const fields = await env.fields(ctx);
    const l = lobbies.find((x) => x.id === str(fields.source, 40) && !x.own);
    if (!l) return redirect(ctx.res, '/admin/activity');
    if (env.limited(ctx, `signin:${ctx.ip}`, LIMITS.signin)) return show(ctx, 429, 'Too many sign-in attempts. Wait a minute and try again.');
    const r = await env.activity.login(l, str(fields.username, 40).trim(), str(fields.password, 200), ctx.ip);
    if (!r.ok) return show(ctx, 400, `${l.name}: ${r.error}`);
    // (Only this page's cookie: HttpOnly, and never shown to the page's script)
    env.setCookie(ctx, cookie(sourceCookie(l), r.token, { maxAge: COOKIE_DAYS * 86400, secure: env.cfg.secureCookies }));
    redirect(ctx.res, '/admin/activity');
  });

  env.router.post('/admin/activity/disconnect', async (ctx) => {
    if (!env.requireAdmin(ctx)) return;
    const fields = await env.fields(ctx);
    const l = lobbies.find((x) => x.id === str(fields.source, 40) && !x.own);
    if (l) {
      const t = tokenFor(ctx, l);
      if (t) await env.activity.logout(l, t);
      env.setCookie(ctx, cookie(sourceCookie(l), '', { maxAge: 0, secure: env.cfg.secureCookies }));
    }
    redirect(ctx.res, '/admin/activity');
  });
}
