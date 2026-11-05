/**
 * MessageStore factory: the inbox lives where the accounts do. Accounts in Postgres (PostgresUserStore): the
 * `messages` table, on the same pool. Otherwise: the JSON file beside users.json.
 */

import type { UserStore } from '../accounts/types.js';
import { JsonMessageStore } from './JsonMessageStore.js';
import type { MessageStore } from './types.js';

type Pool = { query(sql: string, params?: any[]): Promise<{ rows: any[] }> };

export async function createMessageStore(users: UserStore, jsonPath: string): Promise<MessageStore> {
  const pool = (users as { sharedPool?: Pool }).sharedPool;
  if (pool) {
    const { PostgresMessageStore } = await import('./PostgresMessageStore.js');
    return await PostgresMessageStore.create(pool);
  }
  return new JsonMessageStore(jsonPath);
}
