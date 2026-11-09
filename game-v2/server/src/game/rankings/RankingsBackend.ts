/**
 * @contract server.rankings.backend
 * owns:       where ranked stats go: the lobby (server-browser/src/rankings), which keeps one row per account and makes the
 *             boards for every game server; the game server only reports changes and never ranks anyone itself
 * needs:      fetch (the lobby's /admin/rankings/* behind LOBBY_ADMIN_SECRET, /rankings/view), common ServerRankingsMessage
 * invariants: a report that wasn't taken is sent again with the same batch id, so the lobby counts it once — server/src/game/rankings/rankings.test.ts
 *             nothing here throws into the game: a lobby that's down is `false` / null — server/src/game/rankings/rankings.test.ts
 * extend:     another place to keep rankings is another implementation of RankingsBackend (index.ts picks it)
 */
import type { ServerRankingsMessage } from '@space-game/common';

export type RankStats = Record<string, number>;

/** What one report says about one pilot: `weekly` is added to their week, `allTime` is their total */
export interface RankPlayerReport { userId: number; weekly: RankStats; allTime: RankStats }

export interface RankBatch {
  /** This game server's name (the lobby limits reports per server) */
  server: string;
  /** A random id: the same batch sent again counts once */
  batch: string;
  /** The week the weekly numbers belong to (common weekOf) */
  week: number;
  players: RankPlayerReport[];
}

/** The old per-server rankings document's boards (see rankingsMigration.ts) */
export interface RankingsImport {
  week: number;
  weekly: Record<string, { name: string; v: RankStats }>;
  allTime: Record<string, { name: string; v: RankStats }>;
}

export interface RankingsBackend {
  /** Hand a batch to the lobby: true when it was taken (or can never be: a bad batch isn't sent again) */
  report(batch: RankBatch): Promise<boolean>;
  /** An old rankings document merged in; idempotent (throws when the lobby can't take it) */
  importDoc(doc: RankingsImport): Promise<void>;
  /** The boards as the lobby makes them (null: can't reach it) */
  view(): Promise<Omit<ServerRankingsMessage, 'type'> | null>;
}

export class LobbyRankings implements RankingsBackend {
  constructor(private lobbyUrl: string, private secret: string, private timeoutMs = 8000) {}

  private url(path: string): string {
    return `${this.lobbyUrl.replace(/\/$/, '')}${path}`;
  }

  private warned = new Set<number>();
  private warn(status: number): void {
    if (this.warned.has(status)) return;
    this.warned.add(status);
    console.warn(`[Rankings] the lobby answered ${status}${status === 404 ? ' (it has no rankings yet)' : status === 403 ? " (LOBBY_ADMIN_SECRET isn't the same here and there)" : ''}`);
  }

  async report(batch: RankBatch): Promise<boolean> {
    try {
      const r = await fetch(this.url('/admin/rankings/report'), {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.secret}` },
        body: JSON.stringify(batch), signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (r.ok) return true;
      this.warn(r.status);
      // (A batch it refused as bad won't get better by sending again: only "try later" answers are kept for another go)
      return r.status >= 400 && r.status < 500 && r.status !== 429 && r.status !== 408 && r.status !== 403 && r.status !== 404;
    } catch {
      return false;
    }
  }

  async importDoc(doc: RankingsImport): Promise<void> {
    const r = await fetch(this.url('/admin/rankings/import'), {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.secret}` },
      body: JSON.stringify(doc), signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) { this.warn(r.status); throw new Error(`the lobby answered ${r.status}`); }
  }

  async view(): Promise<Omit<ServerRankingsMessage, 'type'> | null> {
    try {
      const r = await fetch(this.url('/rankings'), { signal: AbortSignal.timeout(this.timeoutMs) });
      const d: any = r.ok ? await r.json() : null;
      return d?.success ? { weekEndsIn: d.weekEndsIn, boards: d.boards } : null;
    } catch {
      return null;
    }
  }
}
