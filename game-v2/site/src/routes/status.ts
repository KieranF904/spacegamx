/**
 * The server status page and API (src/status.ts has the file's contract).
 *   GET /status
 *   GET /api/v1/status     public: { online, players, ...whatever the game reported }
 */

import { sendJson } from '../http.js';
import { statusJson } from '../status.js';
import { statusPage } from '../views/status.js';
import { PUBLIC_JSON, type RouteEnv } from './env.js';

export function registerStatus(env: RouteEnv): void {
  env.router.get('/status', async (ctx) => {
    const [status, catalog] = await Promise.all([env.statusFile.get(), env.catalog.get()]);
    env.page(ctx, 200, statusPage(ctx.page, { status, catalog }));
  });

  env.router.get('/api/v1/status', async (ctx) => {
    sendJson(ctx.res, 200, statusJson(await env.statusFile.get()), { ...PUBLIC_JSON, 'Cache-Control': 'public, max-age=2' });
  });
}
