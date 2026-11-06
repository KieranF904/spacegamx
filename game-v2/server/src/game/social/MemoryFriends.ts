/**
 * Friends in memory (FriendsBackend): what a game server uses with no lobby to keep them (tests, benches, a server
 * started without LOBBY_ADMIN_SECRET; nothing outlives the process). Tests share one between two servers as their
 * stand-in lobby, and set `down` to see how the game copes when the lobby isn't answering.
 *
 * Names are learnt as pilots sign in (get), so only accounts seen here can be asked by name (the lobby knows them all).
 */
import type { SocialStatus } from '@space-game/common';
import { FriendsUnavailable, type FriendChange, type FriendRecord, type FriendsBackend, type RemoveResult, type RequestResult, type RespondResult } from './FriendsBackend.js';
import { emptyDoc, findByName, parseDoc, request, respond, touch, unfriend, forget } from './friendsDoc.js';

export class MemoryFriends implements FriendsBackend {
  readonly refreshMs: number;
  readonly doc = emptyDoc();
  /** Every call throws FriendsUnavailable while this is set (tests: the lobby is down) */
  down = false;
  /** Calls made (tests) */
  calls = 0;

  constructor(opts: { refreshMs?: number } = {}) {
    this.refreshMs = opts.refreshMs ?? 0;
  }

  private check(): void {
    this.calls++;
    if (this.down) throw new FriendsUnavailable('down');
  }

  private rec(id: number): FriendRecord {
    const a = this.doc.accounts[id];
    const entry = (i: number) => ({ id: i, name: this.doc.accounts[i]?.name ?? '?' });
    return { status: a?.status ?? 'online', friends: (a?.friends ?? []).map(entry), incoming: (a?.in ?? []).map(entry), outgoing: (a?.out ?? []).map(entry) };
  }

  private change<R>(me: number, other: number | undefined, result: R): FriendChange<R> {
    if (other === undefined) return { result, me: this.rec(me) };
    return { result, other: { id: other, name: this.doc.accounts[other].name }, me: this.rec(me), ...(other !== me ? { them: this.rec(other) } : {}) };
  }

  async get(userId: number, username: string): Promise<FriendRecord> {
    this.check();
    touch(this.doc, userId, username);
    return this.rec(userId);
  }

  async request(userId: number, name: string): Promise<FriendChange<RequestResult>> {
    this.check();
    const to = findByName(this.doc, name);
    if (to === undefined) return this.change(userId, undefined, 'unknown');
    return this.change(userId, to, request(this.doc, userId, to) as RequestResult);
  }

  async respond(userId: number, name: string, accept: boolean): Promise<FriendChange<RespondResult>> {
    this.check();
    const from = findByName(this.doc, name);
    if (from === undefined || !this.doc.accounts[userId]?.in.includes(from)) return this.change(userId, from, 'gone');
    return this.change(userId, from, respond(this.doc, userId, from, accept) ? 'accepted' : accept ? 'full' : 'declined');
  }

  async remove(userId: number, name: string): Promise<FriendChange<RemoveResult>> {
    this.check();
    const other = findByName(this.doc, name);
    if (other === undefined) return this.change(userId, undefined, 'none');
    const wasFriend = !!this.doc.accounts[userId]?.friends.includes(other);
    return this.change(userId, other, unfriend(this.doc, userId, other) ? (wasFriend ? 'unfriended' : 'removed') : 'none');
  }

  async setStatus(userId: number, status: SocialStatus): Promise<void> {
    this.check();
    const a = this.doc.accounts[userId];
    if (a) a.status = status;
  }

  /** (Accounts it doesn't know yet are taken whole; known ones keep their own) */
  async importDoc(accounts: Record<string, unknown>): Promise<{ friends: number; requests: number; skipped: number }> {
    this.check();
    const parsed = parseDoc({ accounts });
    let n = 0;
    for (const [id, a] of Object.entries(parsed.accounts)) if (!this.doc.accounts[id]) { this.doc.accounts[id] = a; n++; }
    return { friends: n, requests: 0, skipped: 0 };
  }

  /** An account was deleted (the lobby does this itself) */
  forget(userId: number): void {
    forget(this.doc, userId);
  }
}
