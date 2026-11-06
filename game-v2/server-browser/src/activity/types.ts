/**
 * The player activity feed: what pilots do on each game server (joins, deaths, boss fights, sales, ...), for the
 * website's admin panel only. The game servers send it in batches (POST /admin/activity/ingest, behind
 * LOBBY_ADMIN_SECRET); the lobby adds its own (sign-in, sign-out, registrations, account admin) as the server "Lobby".
 *
 * Kept where the accounts are, in both backends, at most KEEP_PER_SERVER events per server (oldest go first):
 *   - JsonActivityStore      (local dev: data/lobby/activity.json)
 *   - PostgresActivityStore  (production: the `activity` table, made at start)
 *
 * Never chat or private-message contents: the game servers send counts for those. Text is plain, escaped where shown.
 */

export interface ActivityEvent {
  /** Increasing (newer is higher): a reader asks for events after the last id it has */
  id: number;
  /** Epoch ms, as the game server stamped it (clamped to the lobby's clock) */
  at: number;
  /** The game server's name ("Local dev", "AUS Main"), or "Lobby" */
  server: string;
  /** join, leave, death, boss_kill, ... (lower-case letters and _) */
  type: string;
  /** The pilot it's about ('' for none: a server error, say) */
  player: string;
  /** A second pilot it names (the other side of a trade, a PvP killer, an admin's target) */
  other: string;
  /** One short line */
  detail: string;
}

/** An event as a game server sends it (the lobby gives it an id and the server's name) */
export type NewActivity = Omit<ActivityEvent, 'id'>;

export interface ActivityQuery {
  /** Only events newer than this id (live updates) */
  after?: number;
  /** Only events older than this id (paging back) */
  before?: number;
  server?: string;
  type?: string;
  /** This pilot, as either side (case-insensitive, exact) */
  player?: string;
  /** Words anywhere in the player, other, type or detail (case-insensitive) */
  search?: string;
  limit: number;
}

export interface ActivityStore {
  /** Store these (oldest first); returns them with their ids */
  add(events: NewActivity[]): Promise<ActivityEvent[]>;
  /** Newest first */
  list(q: ActivityQuery): Promise<ActivityEvent[]>;
  /** Every server that has events, and the event types seen (for the filters) */
  facets(): Promise<{ servers: string[]; types: string[] }>;
  close(): Promise<void>;
}

/** Events kept per server (the oldest go first past it) */
export const KEEP_PER_SERVER = 5000;
/** Servers kept (a server name past this is refused until one is forgotten: the store can't be grown by names) */
export const MAX_SERVERS = 50;
