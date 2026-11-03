/**
 * What the feature route modules (catalog, ships, status, changelog) get from the app: its pieces, and a few of its
 * helpers. Each module has one `register(env)`; app.ts calls them. Keeps app.ts from growing a route per feature.
 */

import type { Ctx } from '../app.js';
import type { CatalogBook } from '../catalog/book.js';
import type { SiteConfig } from '../config.js';
import type { SafeHtml } from '../html.js';
import type { Router } from '../http.js';
import type { LobbyUser } from '../lobby.js';
import type { ServerStatus } from '../status.js';
import type { SiteStore } from '../store/types.js';

export interface RouteEnv {
  router: Router<Ctx>;
  cfg: SiteConfig;
  store: SiteStore;
  catalog: CatalogBook;
  statusFile: { get(): Promise<ServerStatus | null> };
  page(ctx: Ctx, status: number, body: SafeHtml): void;
  notFound(ctx: Ctx, what: string): void;
  /** true if the caller is over the limit (and the Retry-After header is set) */
  limited(ctx: Ctx, key: string, rule: { limit: number; windowMs: number }): boolean;
  requireAdmin(ctx: Ctx): LobbyUser | null;
  fields(ctx: Ctx, max?: number): Promise<Record<string, any>>;
}

/** Headers for the public read-only JSON (any site may read it; short cache) */
export const PUBLIC_JSON = { 'Cache-Control': 'public, max-age=60', 'Access-Control-Allow-Origin': '*' } as const;
