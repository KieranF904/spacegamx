/**
 * The Database pages and the catalog API.
 *   GET /database[?q=]                      the five lists and a search across them
 *   GET /database/:kind[?q=&category=&rarity=&sort=]    parts | items | ships | bosses | stations
 *   GET /database/:kind/:id                 one entry
 *   GET /api/v1/catalog[?kind=parts]        the catalog as JSON (the contract's shape: src/catalog/types.ts)
 */

import { sendJson } from '../http.js';
import type { Catalog } from '../catalog/book.js';
import { parseQuery } from '../catalog/query.js';
import { CATALOG_KINDS, type CatalogFile, type CatalogKind } from '../catalog/types.js';
import { LIMITS } from '../security.js';
import * as D from '../views/database.js';
import { PUBLIC_JSON, type RouteEnv } from './env.js';

const isKind = (v: string): v is CatalogKind => (CATALOG_KINDS as readonly string[]).includes(v);

/** The catalog without the site's lookup maps: the same shape the game would write */
export function catalogJson(c: Catalog): CatalogFile {
  const { from: _from, part: _p, item: _i, ship: _s, boss: _b, station: _st, system: _sy, ...file } = c;
  return file;
}

export function registerCatalog(env: RouteEnv): void {
  const { router, catalog, page } = env;

  router.get('/database', async (ctx) => page(ctx, 200, D.databaseIndex(ctx.page, await catalog.get(), parseQuery(ctx.url.searchParams))));

  router.get('/database/:kind', async (ctx, p) => {
    if (!isKind(p.kind)) return env.notFound(ctx, 'page');
    const c = await catalog.get(), q = parseQuery(ctx.url.searchParams);
    const view = { parts: D.partsList, items: D.itemsList, ships: D.shipsList, bosses: D.bossesList, stations: D.stationsList }[p.kind];
    page(ctx, 200, view(ctx.page, c, q));
  });

  router.get('/database/:kind/:id', async (ctx, p) => {
    if (!isKind(p.kind)) return env.notFound(ctx, 'page');
    const c = await catalog.get();
    const id = p.id.slice(0, 80);
    if (!c) return page(ctx, 404, D.entryNotFound(ctx.page, p.kind));
    switch (p.kind) {
      case 'parts': { const e = c.part.get(id); return page(ctx, e ? 200 : 404, e ? D.partPage(ctx.page, c, e) : D.entryNotFound(ctx.page, 'parts')); }
      case 'items': { const e = c.item.get(id); return page(ctx, e ? 200 : 404, e ? D.itemPage(ctx.page, c, e) : D.entryNotFound(ctx.page, 'items')); }
      case 'ships': { const e = c.ship.get(id); return page(ctx, e ? 200 : 404, e ? D.shipPage(ctx.page, c, e) : D.entryNotFound(ctx.page, 'ships')); }
      case 'bosses': { const e = c.boss.get(id); return page(ctx, e ? 200 : 404, e ? D.bossPage(ctx.page, c, e) : D.entryNotFound(ctx.page, 'bosses')); }
      case 'stations': { const e = c.station.get(id); return page(ctx, e ? 200 : 404, e ? D.stationPage(ctx.page, c, e) : D.entryNotFound(ctx.page, 'stations')); }
    }
  });

  router.get('/api/v1/catalog', async (ctx) => {
    if (env.limited(ctx, `public:${ctx.ip}`, LIMITS.publicApi)) return sendJson(ctx.res, 429, { error: 'Slow down' });
    const c = await catalog.get();
    if (!c) return sendJson(ctx.res, 503, { error: 'No catalog yet' });
    const file = catalogJson(c);
    const kind = ctx.url.searchParams.get('kind');
    if (kind && isKind(kind)) return sendJson(ctx.res, 200, { version: file.version, builtAt: file.builtAt, source: file.source, [kind]: file[kind] }, PUBLIC_JSON);
    sendJson(ctx.res, 200, file, PUBLIC_JSON);
  });
}
