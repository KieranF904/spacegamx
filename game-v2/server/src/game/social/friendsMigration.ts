/**
 * Moving the old per-server friends document into the lobby, once.
 *
 * Friends used to be kept by each game server (the 'social' document in its profile store: data/profiles/_social.json
 * in dev, the `social` game_docs row in production). They are now per account in the lobby. At start, Social runs
 * this: if the document is there and not yet marked moved, its accounts go to the lobby's import (which merges them in:
 * friendships and requests added when missing, a status only for an account with none yet, deleted accounts skipped),
 * then the document is marked `movedToLobby` (kept, not deleted: what was moved, should anyone need to look).
 *
 * Idempotent both ways: a marked document is never sent again, and sending one twice (a crash between the import and
 * the mark, two dev servers on one profile store) adds nothing the first didn't (short of bringing back a friendship
 * removed in between). If the lobby can't take it, nothing is marked and Social tries again later.
 */
import type { ProfileStore } from '../../profile/ProfileStore.js';
import type { FriendsBackend } from './FriendsBackend.js';
import { SOCIAL_DOC } from './friendsDoc.js';

export type MigrationResult = 'none' | 'already' | 'moved' | 'failed';

export async function migrateFriends(store: ProfileStore, backend: FriendsBackend, now: () => number = Date.now): Promise<MigrationResult> {
  let raw: unknown;
  try {
    raw = await store.loadDoc(SOCIAL_DOC);
  } catch (e) {
    console.error('[Friends] could not read the old friends document:', e);
    return 'failed';
  }
  if (!raw || typeof raw !== 'object') return 'none';
  const doc = raw as { movedToLobby?: unknown; accounts?: unknown };
  if (doc.movedToLobby) return 'already';
  const accounts = doc.accounts && typeof doc.accounts === 'object' && !Array.isArray(doc.accounts) ? doc.accounts as Record<string, unknown> : {};
  if (Object.keys(accounts).length) {
    try {
      const r = await backend.importDoc(accounts);
      console.log(`[Friends] moved this server's friends to the lobby: ${Object.keys(accounts).length} accounts, ${r.friends} friendships and ${r.requests} requests added, ${r.skipped} deleted accounts skipped`);
    } catch (e) {
      console.error(`[Friends] could not move this server's friends to the lobby yet (${(e as Error).message}); will try again`);
      return 'failed';
    }
  }
  try {
    await store.saveDoc(SOCIAL_DOC, { ...doc, movedToLobby: now() });
  } catch (e) {
    // (The import is idempotent: sending it again next start adds nothing)
    console.error('[Friends] could not mark the old friends document moved:', e);
  }
  return 'moved';
}
