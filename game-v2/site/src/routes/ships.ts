/**
 * The ship gallery and the API the game uses to share ships.
 *   GET    /ships, /ships/:id                 the gallery, one shared ship
 *   GET    /api/v1/ships[?owner=name]         public list;   GET /api/v1/ships/:id   one, with its plan
 *   POST   /api/v1/ships                      the game server shares a ship  (Authorization: Bearer <SITE_GAME_KEY>)
 *   DELETE /api/v1/ships/:id?userId=          the game server withdraws one of that pilot's ships
 *   /admin/ships                              hide, show, delete
 */

import { sendJson } from '../http.js';
import { LIMITS } from '../security.js';
import { checkShip, MAX_SHIPS_PER_PILOT, SHIP_BODY_MAX } from '../ships.js';
import type { SharedShip } from '../store/types.js';
import * as A from '../views/admin.js';
import * as S from '../views/ships.js';
import { PUBLIC_JSON, type RouteEnv } from './env.js';

const idOf = (v: string) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : 0; };

function publicShip(origin: string, s: SharedShip, withPlan: boolean) {
  return {
    id: s.id, name: s.name, owner: s.ownerName, url: `${origin}/ships/${s.id}`, stats: s.stats, power: s.power,
    createdAt: s.createdAt, updatedAt: s.updatedAt, ...(withPlan ? { plan: s.plan } : {}),
  };
}

export function registerShips(env: RouteEnv): void {
  const { router, store, catalog, cfg, page } = env;

  router.get('/ships', async (ctx) => {
    const [c, shared] = await Promise.all([catalog.get(), store.listShips({ limit: 48 })]);
    page(ctx, 200, S.galleryPage(ctx.page, { catalog: c, shared }));
  });

  router.get('/ships/:id', async (ctx, p) => {
    const ship = idOf(p.id) ? await store.getShip(idOf(p.id)) : null;
    if (!ship || (ship.hidden && !ctx.user?.isAdmin)) return env.notFound(ctx, 'ship');
    page(ctx, 200, S.sharedShipPage(ctx.page, { catalog: await catalog.get(), ship }));
  });

  // ---- public API
  router.get('/api/v1/ships', async (ctx) => {
    if (env.limited(ctx, `public:${ctx.ip}`, LIMITS.publicApi)) return sendJson(ctx.res, 429, { error: 'Slow down' });
    const owner = (ctx.url.searchParams.get('owner') ?? '').trim().slice(0, 20).toLowerCase();
    let ships = await store.listShips({ limit: 200 });
    if (owner) ships = ships.filter((s) => s.ownerName.toLowerCase() === owner);
    sendJson(ctx.res, 200, { ships: ships.slice(0, 60).map((s) => publicShip(cfg.origin, s, false)) }, PUBLIC_JSON);
  });

  router.get('/api/v1/ships/:id', async (ctx, p) => {
    const ship = idOf(p.id) ? await store.getShip(idOf(p.id)) : null;
    if (!ship || ship.hidden) return sendJson(ctx.res, 404, { error: 'No such ship' });
    sendJson(ctx.res, 200, { ship: publicShip(cfg.origin, ship, true) }, PUBLIC_JSON);
  });

  // ---- the game server
  const gameOnly = (ctx: Parameters<typeof env.limited>[0]): boolean => {
    if (!cfg.gameKey) { sendJson(ctx.res, 503, { error: 'Sharing ships is not set up on this site' }); return false; }
    if (!ctx.game) { sendJson(ctx.res, 401, { error: 'Send Authorization: Bearer <the game key>' }); return false; }
    return true;
  };

  router.post('/api/v1/ships', async (ctx) => {
    if (!gameOnly(ctx)) return;
    const f = await env.fields(ctx, SHIP_BODY_MAX);
    const c = await catalog.get();
    const r = checkShip(f, c?.render ?? null);
    if (!r.ok) return sendJson(ctx.res, r.status, { error: r.error });
    if (env.limited(ctx, `ships:${r.value.ownerId}`, LIMITS.shipShare)) return sendJson(ctx.res, 429, { error: 'This pilot is sharing too fast' });
    const saved = await store.saveShip(r.value, MAX_SHIPS_PER_PILOT);
    if (saved === 'cap') return sendJson(ctx.res, 409, { error: `A pilot can share ${MAX_SHIPS_PER_PILOT} ships: withdraw one first` });
    console.log(`[Site] ship "${saved.ship.name}" ${saved.created ? 'shared' : 'updated'} by ${saved.ship.ownerName}`);
    sendJson(ctx.res, saved.created ? 201 : 200, { id: saved.ship.id, url: `${cfg.origin}/ships/${saved.ship.id}`, created: saved.created });
  });

  router.on('DELETE', '/api/v1/ships/:id', async (ctx, p) => {
    if (!gameOnly(ctx)) return;
    const ship = idOf(p.id) ? await store.getShip(idOf(p.id)) : null;
    if (!ship) return sendJson(ctx.res, 404, { error: 'No such ship' });
    if (String(ship.ownerId) !== ctx.url.searchParams.get('userId')) return sendJson(ctx.res, 403, { error: 'That ship belongs to another pilot' });
    await store.deleteShip(ship.id);
    sendJson(ctx.res, 200, { deleted: true });
  });

  // ---- admin
  router.get('/admin/ships', async (ctx) => {
    if (!env.requireAdmin(ctx)) return;
    page(ctx, 200, A.adminShips(ctx.page, await store.listShips({ includeHidden: true, limit: 200 }), ctx.page.notice));
  });

  router.post('/admin/ships/:id/:action', async (ctx, p) => {
    if (!env.requireAdmin(ctx)) return;
    await env.fields(ctx);
    const id = idOf(p.id);
    if (p.action === 'hide' || p.action === 'show') await store.setShipHidden(id, p.action === 'hide');
    else if (p.action === 'delete') await store.deleteShip(id);
    else return env.notFound(ctx, 'page');
    ctx.res.writeHead(303, { Location: `/admin/ships?ok=${p.action === 'hide' ? 'hidden' : p.action === 'show' ? 'shown' : 'removed'}` });
    ctx.res.end();
  });
}
