/** GET /api/v1/changelog: the "What's new" feed for the game's menu (src/changelog.ts) */

import { changelogItems } from '../changelog.js';
import { sendJson } from '../http.js';
import { LIMITS } from '../security.js';
import { PUBLIC_JSON, type RouteEnv } from './env.js';

export function registerChangelog(env: RouteEnv): void {
  env.router.get('/api/v1/changelog', async (ctx) => {
    if (env.limited(ctx, `public:${ctx.ip}`, LIMITS.publicApi)) return sendJson(ctx.res, 429, { error: 'Slow down' });
    const sp = ctx.url.searchParams;
    const { posts } = await env.store.listPosts({ limit: 200 });
    const items = changelogItems(posts, {
      origin: env.cfg.origin, since: sp.get('since')?.slice(0, 40), tag: sp.get('tag')?.slice(0, 24), limit: Number(sp.get('limit')) || 20,
    });
    sendJson(ctx.res, 200, { items, updatedAt: items[0]?.publishedAt ?? null }, PUBLIC_JSON);
  });
}
