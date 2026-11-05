/**
 * ProfileStore factory: the same switch as the account store.
 *   USER_STORE_BACKEND=postgres + DATABASE_URL -> PostgresProfileStore
 *   otherwise (default)                         -> JsonProfileStore (data/profiles/)
 */

import { join } from 'path';
import type { ProfileStore } from './ProfileStore.js';
import { JsonProfileStore } from './JsonProfileStore.js';

export type { ProfileStore } from './ProfileStore.js';
export { MemoryProfileStore } from './ProfileStore.js';

export async function createProfileStore(dataPath: string): Promise<ProfileStore> {
  const backend = process.env.USER_STORE_BACKEND || '';
  const databaseUrl = process.env.DATABASE_URL || '';
  if (backend.toLowerCase() === 'postgres' && databaseUrl) {
    const { PostgresProfileStore } = await import('./PostgresProfileStore.js');
    return PostgresProfileStore.create(databaseUrl);
  }
  return new JsonProfileStore(join(dataPath, 'profiles'));
}
