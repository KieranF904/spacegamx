/**
 * UserStore factory
 *
 * Selects the account storage backend:
 *   - USER_STORE_BACKEND=postgres + DATABASE_URL  -> PostgresUserStore
 *   - otherwise (default)                          -> JsonUserStore
 *
 * Both implement the same UserStore interface, so the rest of the
 * server code never needs to know which one is active.
 */

import path from 'path';
import { UserStore } from './types.js';
import { JsonUserStore } from './JsonUserStore.js';

export async function createUserStore(dataPath: string): Promise<UserStore> {
  const backend = process.env.USER_STORE_BACKEND || '';
  const databaseUrl = process.env.DATABASE_URL || '';

  if (backend.toLowerCase() === 'postgres' && databaseUrl) {
    // Dynamic import so 'pg' is only loaded when actually used
    const { PostgresUserStore } = await import('./PostgresUserStore.js');
    return await PostgresUserStore.create(databaseUrl);
  }

  // Default: local JSON file store
  return new JsonUserStore(path.join(dataPath, 'users.json'));
}