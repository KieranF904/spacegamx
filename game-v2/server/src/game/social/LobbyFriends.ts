/**
 * Friends kept by the lobby (server-browser/src/friends/routes.ts): its /admin/friends/*, behind LOBBY_ADMIN_SECRET
 * like the activity ingest and the account admin. Anything but a good answer throws FriendsUnavailable.
 */
import type { SocialStatus } from '@space-game/common';
import { FriendsUnavailable, type FriendChange, type FriendRecord, type FriendsBackend, type RemoveResult, type RequestResult, type RespondResult } from './FriendsBackend.js';

/** Online pilots' lists are read again this often (changes made on other servers reach them) */
export const LOBBY_REFRESH_MS = 60_000;

export class LobbyFriends implements FriendsBackend {
  readonly refreshMs: number;
  private timeoutMs: number;

  constructor(private lobbyUrl: string, private secret: string, opts: { refreshMs?: number; timeoutMs?: number } = {}) {
    this.refreshMs = opts.refreshMs ?? LOBBY_REFRESH_MS;
    this.timeoutMs = opts.timeoutMs ?? 5000;
  }

  private async post(path: string, body: unknown): Promise<any> {
    let r: Response;
    try {
      r = await fetch(`${this.lobbyUrl}/admin/friends/${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.secret}` },
        body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      console.error(`[Friends] lobby unreachable (${path}):`, String(err));
      throw new FriendsUnavailable('unreachable');
    }
    const data: any = await r.json().catch(() => null);
    if (r.status === 429) throw new FriendsUnavailable('limited', true);
    if (r.status === 403) console.error("[Friends] the lobby refused (LOBBY_ADMIN_SECRET isn't the same on the lobby and this server)");
    if (!r.ok || !data?.success) {
      if (r.status !== 403) console.error(`[Friends] the lobby answered ${r.status} (${path}): ${data?.error ?? ''}`);
      throw new FriendsUnavailable(data?.error ?? `status ${r.status}`);
    }
    return data;
  }

  private record(d: any): FriendRecord {
    return { status: d.status, friends: d.friends ?? [], incoming: d.incoming ?? [], outgoing: d.outgoing ?? [] };
  }

  private change<R>(d: any): FriendChange<R> {
    return { result: d.result, other: d.other, me: this.record(d.me), ...(d.them ? { them: this.record(d.them) } : {}) };
  }

  async get(userId: number): Promise<FriendRecord> {
    return this.record(await this.post('get', { userId }));
  }

  async request(userId: number, name: string): Promise<FriendChange<RequestResult>> {
    return this.change(await this.post('request', { userId, name }));
  }

  async respond(userId: number, name: string, accept: boolean): Promise<FriendChange<RespondResult>> {
    return this.change(await this.post('respond', { userId, name, accept }));
  }

  async remove(userId: number, name: string): Promise<FriendChange<RemoveResult>> {
    return this.change(await this.post('remove', { userId, name }));
  }

  async setStatus(userId: number, status: SocialStatus): Promise<void> {
    await this.post('status', { userId, status });
  }

  async importDoc(accounts: Record<string, unknown>): Promise<{ friends: number; requests: number; skipped: number }> {
    const d = await this.post('import', { accounts });
    return { friends: d.friends, requests: d.requests, skipped: d.skipped };
  }
}
