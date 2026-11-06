/**
 * The admin Activity page's sources: one or more lobbies (cfg.activityLobbies), each keeping the activity feed of the
 * game servers that report to it (server-browser/src/activity). The site asks each lobby itself, server to server:
 *
 *   POST <lobby>/activity/read { token, after?, server?, type?, player?, search?, limit } (an admin's session there)
 *
 * The site's own lobby takes the visitor's site session. Another one (the production lobby, read from the dev site)
 * takes a session made by signing in to it on the Activity page (POST <lobby>/auth/login), kept in an HttpOnly cookie
 * for that page only; the password goes straight to that lobby and is never stored.
 *
 * A lobby that doesn't answer like the feed (none at that address yet, an older build without it, offline) is
 * "not available yet": the page says so for that source and shows the rest.
 */

import type { ActivityLobby } from './config.js';

export interface ActivityEvent { id: number; at: number; server: string; type: string; player: string; other: string; detail: string }

export interface ActivityQuery { after?: number; server?: string; type?: string; player?: string; search?: string; limit: number }

export type SourceRead =
  | { state: 'ok'; events: ActivityEvent[]; servers: string[]; types: string[]; live: string[] }
  /** It has the feed, but this session isn't one there (sign in to it) */
  | { state: 'signin' }
  | { state: 'forbidden'; error: string }
  | { state: 'unavailable'; error: string };

export interface ActivityClient {
  read(lobby: ActivityLobby, token: string | null, q: ActivityQuery): Promise<SourceRead>;
  /** Sign in to a lobby that isn't the site's own: its session token, or why not */
  login(lobby: ActivityLobby, username: string, password: string, ip: string): Promise<{ ok: true; token: string } | { ok: false; error: string }>;
  logout(lobby: ActivityLobby, token: string): Promise<void>;
}

type Fetch = typeof fetch;

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

/** One event as a lobby sent it, made safe to show (escaping is the page's) */
function cleanEvent(e: any): ActivityEvent | null {
  if (!e || typeof e !== 'object' || !Number.isSafeInteger(Number(e.id))) return null;
  return { id: Number(e.id), at: Number(e.at) || 0, server: str(e.server, 64), type: str(e.type, 24), player: str(e.player, 40), other: str(e.other, 40), detail: str(e.detail, 200) };
}

export class HttpActivityClient implements ActivityClient {
  constructor(private fetchFn: Fetch = fetch, private timeoutMs = 6000) {}

  private async post(url: string, body: object, ip?: string): Promise<{ status: number; body: any } | null> {
    try {
      const r = await this.fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(ip ? { 'X-Forwarded-For': ip } : {}) },
        body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs),
      });
      let parsed: any = null;
      try { parsed = await r.json(); } catch { /* not JSON: not the feed */ }
      return { status: r.status, body: parsed };
    } catch {
      return null;
    }
  }

  async read(lobby: ActivityLobby, token: string | null, q: ActivityQuery): Promise<SourceRead> {
    const r = await this.post(`${lobby.url}/activity/read`, { token: token ?? '', ...q });
    if (!r) return { state: 'unavailable', error: "The lobby isn't answering" };
    // (Only an answer that says it's the feed counts: a 404 page, the game's index.html or an old lobby don't)
    if (r.body?.feed !== true) return { state: 'unavailable', error: 'This lobby has no activity feed yet' };
    if (r.status === 401) return { state: 'signin' };
    if (r.status === 403) return { state: 'forbidden', error: str(r.body.error, 200) || 'Only an admin can see this' };
    if (r.status !== 200 || !Array.isArray(r.body.events)) return { state: 'unavailable', error: str(r.body.error, 200) || `The lobby answered ${r.status}` };
    const list = (v: unknown) => (Array.isArray(v) ? v.slice(0, 100).map((x) => str(x, 64)).filter(Boolean) : []);
    return {
      state: 'ok',
      events: r.body.events.slice(0, 500).map(cleanEvent).filter((e: ActivityEvent | null): e is ActivityEvent => !!e),
      servers: list(r.body.servers), types: list(r.body.types), live: list(r.body.live),
    };
  }

  async login(lobby: ActivityLobby, username: string, password: string, ip: string) {
    const r = await this.post(`${lobby.url}/auth/login`, { username, password }, ip);
    if (!r) return { ok: false as const, error: "That lobby isn't answering" };
    if (!r.body?.success || typeof r.body.token !== 'string') return { ok: false as const, error: str(r.body?.error, 200) || 'Sign-in failed' };
    if (!r.body.isAdmin && !r.body.isOwner) return { ok: false as const, error: 'That account is not an admin there' };
    return { ok: true as const, token: r.body.token as string };
  }

  async logout(lobby: ActivityLobby, token: string): Promise<void> {
    await this.post(`${lobby.url}/auth/logout`, { token });
  }
}

/** The cookie that keeps a session for a lobby that isn't the site's own */
export const sourceCookie = (lobby: ActivityLobby) => `sg_act_${lobby.id}`;

/** Every source's events, newest first (they're different id spaces: by time, then source and id) */
export function mergeEvents(bySource: { source: string; events: ActivityEvent[] }[], limit: number): (ActivityEvent & { source: string })[] {
  return bySource.flatMap(({ source, events }) => events.map((e) => ({ ...e, source })))
    .sort((a, b) => b.at - a.at || (a.source < b.source ? -1 : a.source > b.source ? 1 : b.id - a.id))
    .slice(0, limit);
}
