/**
 * The rankings, read from the lobby (server-browser/src/rankings/routes.ts: POST /rankings/view). The lobby keeps one row
 * per account and ranks every game server's pilots together, so the Rankings tab asks it rather than the server the pilot
 * is on. The signed-in session token (saved by Game as `authToken`) adds the pilot's own numbers; a guest has none, and
 * gets the boards without a "you".
 */
import type { ServerRankingsMessage } from '@space-game/common';
import { LOBBY_URL } from './lobby';

/** The session token Game saved at sign-in (null: a guest, or storage is blocked) */
function savedToken(): string | null {
  try { return localStorage.getItem('authToken'); } catch { return null; }
}

/** The boards in the shape the Rankings tab draws (null: the lobby can't be reached) */
export async function fetchRankings(token: string | null = savedToken()): Promise<ServerRankingsMessage | null> {
  try {
    const r = await fetch(`${LOBBY_URL}/rankings/view`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(token ? { token } : {}),
    });
    const d = await r.json().catch(() => null);
    if (!r.ok || !d?.success || !Array.isArray(d.boards)) return null;
    return { type: 'rankings', weekEndsIn: Number(d.weekEndsIn) || 0, boards: d.boards };
  } catch {
    return null;
  }
}
