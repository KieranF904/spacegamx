/**
 * AdminChatStore factory: the admin message log lives where the accounts do. Accounts in Postgres (PostgresUserStore):
 * the `admin_messages` table, on the same pool. Otherwise: the JSON file beside users.json.
 */

import type { UserStore } from '../accounts/types.js';
import { JsonAdminChatStore } from './JsonAdminChatStore.js';
import type { AdminChatStore } from './types.js';

type Pool = { query(sql: string, params?: any[]): Promise<{ rows: any[] }> };

export async function createAdminChatStore(users: UserStore, jsonPath: string): Promise<AdminChatStore> {
  const pool = (users as { sharedPool?: Pool }).sharedPool;
  if (pool) {
    const { PostgresAdminChatStore } = await import('./PostgresAdminChatStore.js');
    return await PostgresAdminChatStore.create(pool);
  }
  return new JsonAdminChatStore(jsonPath);
}
