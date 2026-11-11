/**
 * GET /api/v1/launcher-news: the development news the launcher's join screen shows.
 *   out: { items: LauncherNewsItem[] } (src/launcherNews.ts): the latest 10 published posts flagged "launcher", plain text.
 * Public, cached a minute, open to any origin (Access-Control-Allow-Origin: * from PUBLIC_JSON): the game page and the
 * website can be on different hosts, and nothing here is private.
 */

import { launcherNewsItems } from '../launcherNews.js';
import { sendJson } from '../http.js';
import { LIMITS } from '../security.js';
import { PUBLIC_JSON, type RouteEnv } from './env.js';

export function registerLauncherNews(env: RouteEnv): void {
  env.router.get('/api/v1/launcher-news', async (ctx) => {
    if (env.limited(ctx, `public:${ctx.ip}`, LIMITS.publicApi)) return sendJson(ctx.res, 429, { error: 'Slow down' });
    const { posts } = await env.store.listPosts({ limit: 200 });
    sendJson(ctx.res, 200, { items: launcherNewsItems(posts, { origin: env.cfg.origin }) }, PUBLIC_JSON);
  });
}
