/**
 * DonationStore factory: donations live where the accounts do. Accounts in Postgres (PostgresUserStore): the
 * `donations` table, on the same pool. Otherwise: the JSON file beside users.json.
 */

import type { UserStore } from '../accounts/types.js';
import { JsonDonationStore } from './JsonDonationStore.js';
import type { DonationStore } from './types.js';

type Pool = { query(sql: string, params?: any[]): Promise<{ rows: any[] }> };

export async function createDonationStore(users: UserStore, jsonPath: string): Promise<DonationStore> {
  const pool = (users as { sharedPool?: Pool }).sharedPool;
  if (pool) {
    const { PostgresDonationStore } = await import('./PostgresDonationStore.js');
    return await PostgresDonationStore.create(pool);
  }
  return new JsonDonationStore(jsonPath);
}
