/**
 * Picks the site's storage, as the lobby does for accounts:
 *   SITE_STORE_BACKEND=postgres + DATABASE_URL -> PostgresSiteStore
 *   otherwise                                   -> JsonSiteStore (<dataDir>/site.json)
 */

import path from 'path';
import type { SiteStore } from './types.js';
import { JsonSiteStore } from './JsonSiteStore.js';

export async function createSiteStore(dataDir: string): Promise<SiteStore> {
  const backend = (process.env.SITE_STORE_BACKEND || '').toLowerCase();
  if (backend === 'postgres' && process.env.DATABASE_URL) {
    const { PostgresSiteStore } = await import('./PostgresSiteStore.js');
    console.log('[Site] PostgreSQL store');
    return PostgresSiteStore.create(process.env.DATABASE_URL);
  }
  const store = new JsonSiteStore(path.join(dataDir, 'site.json'));
  console.log(`[Site] JSON store at ${store.filePath}`);
  return store;
}

export type { SiteStore } from './types.js';
