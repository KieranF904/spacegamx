/**
 * Where friends, friend requests and the saved status are kept: per account, in the lobby (server-browser/src/friends),
 * so they follow the account to every server. Social.ts talks to it through this.
 *
 *   LobbyFriends   the real one: the lobby's /admin/friends/* (index.ts gives it BROWSER_URL and LOBBY_ADMIN_SECRET)
 *   MemoryFriends  in memory, for tests, benches and a server run with no lobby secret (the default in GameServer)
 *
 * Every call may throw FriendsUnavailable (the lobby is down, refused, or says slow down); Social tells the pilot.
 */
import type { SocialStatus } from '@space-game/common';

export interface FriendEntry { id: number; name: string }

/** One account's lists, with names */
export interface FriendRecord {
  status: SocialStatus;
  friends: FriendEntry[];
  incoming: FriendEntry[];
  outgoing: FriendEntry[];
}

export type RequestResult = 'sent' | 'accepted' | 'already' | 'pending' | 'full' | 'theirFull' | 'busy' | 'self' | 'unknown';
export type RespondResult = 'accepted' | 'declined' | 'full' | 'gone';
export type RemoveResult = 'unfriended' | 'removed' | 'none';

/** What a change did, and both accounts' lists after it (`them`: the other account, when there is one) */
export interface FriendChange<R> { result: R; other?: FriendEntry; me: FriendRecord; them?: FriendRecord }

export interface FriendsBackend {
  /** How often online pilots' lists are read again (changes made on other servers); 0: never */
  readonly refreshMs: number;
  /** `username`: as signed in here (the lobby knows it; the in-memory stand-in learns names this way) */
  get(userId: number, username: string): Promise<FriendRecord>;
  request(userId: number, name: string): Promise<FriendChange<RequestResult>>;
  respond(userId: number, name: string, accept: boolean): Promise<FriendChange<RespondResult>>;
  remove(userId: number, name: string): Promise<FriendChange<RemoveResult>>;
  setStatus(userId: number, status: SocialStatus): Promise<void>;
  /** A server's old friends document (friendsMigration.ts) merged in; idempotent */
  importDoc(accounts: Record<string, unknown>): Promise<{ friends: number; requests: number; skipped: number }>;
}

export class FriendsUnavailable extends Error {
  /** `limited`: the lobby said slow down (not down) */
  constructor(message: string, readonly limited = false) {
    super(message);
  }
}
