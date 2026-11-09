/**
 * Moving the old per-server rankings document into the lobby, once.
 *
 * Rankings used to be kept by each game server (the 'rankings' document in its profile store: data/profiles/_rankings.json
 * in dev, the `rankings` game_docs row in production). They are now one row per account in the lobby. At start,
 * Achievements runs this: if the document is there and not yet marked moved, it goes to the lobby's import (every number
 * raised to the larger of the lobby's and the document's; gone accounts skipped), then the document is marked
 * `movedToLobby` (kept, not deleted).
 *
 * Idempotent both ways: a marked document is never sent again, and sending one twice (a crash between the import and the
 * mark) changes nothing. If the lobby can't take it, nothing is marked and the next start tries again.
 */
import type { ProfileStore } from '../../profile/ProfileStore.js';
import type { RankingsBackend } from './RankingsBackend.js';

/** The rankings document in the profile store (the old home of the boards) */
export const RANKINGS_DOC = 'rankings';

export type MigrationResult = 'none' | 'already' | 'moved' | 'failed';

export async function migrateRankings(store: ProfileStore, backend: RankingsBackend, now: () => number = Date.now): Promise<MigrationResult> {
  let raw: unknown;
  try {
    raw = await store.loadDoc(RANKINGS_DOC);
  } catch (e) {
    console.error('[Rankings] could not read the old rankings document:', e);
    return 'failed';
  }
  if (!raw || typeof raw !== 'object') return 'none';
  const doc = raw as { movedToLobby?: unknown; week?: unknown; weekly?: unknown; allTime?: unknown };
  if (doc.movedToLobby) return 'already';
  const map = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, { name: string; v: Record<string, number> }> : {});
  const weekly = map(doc.weekly), allTime = map(doc.allTime);
  if (Object.keys(weekly).length || Object.keys(allTime).length) {
    try {
      await backend.importDoc({ week: Number(doc.week), weekly, allTime });
      console.log(`[Rankings] moved this server's boards to the lobby: ${Object.keys(allTime).length} pilots`);
    } catch (e) {
      console.error(`[Rankings] could not move this server's boards to the lobby yet (${(e as Error).message}); will try again`);
      return 'failed';
    }
  }
  try {
    await store.saveDoc(RANKINGS_DOC, { ...doc, movedToLobby: now() });
  } catch (e) {
    // (The import is idempotent: sending it again next start changes nothing)
    console.error('[Rankings] could not mark the old rankings document moved:', e);
  }
  return 'moved';
}
