/**
 * ConsentStore factory: the answers live where the accounts do. Accounts in Postgres (PostgresUserStore): the
 * `newsletter_consent` table, on the same pool. Otherwise: the JSON file beside users.json.
 */

import type { UserStore } from '../accounts/types.js';
import { JsonConsentStore } from './JsonConsentStore.js';
import type { ConsentStore } from './types.js';

type Pool = { query(sql: string, params?: any[]): Promise<{ rows: any[] }> };

export async function createConsentStore(users: UserStore, jsonPath: string): Promise<ConsentStore> {
  const pool = (users as { sharedPool?: Pool }).sharedPool;
  if (pool) {
    const { PostgresConsentStore } = await import('./PostgresConsentStore.js');
    return await PostgresConsentStore.create(pool);
  }
  return new JsonConsentStore(jsonPath);
}
