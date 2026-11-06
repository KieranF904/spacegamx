/**
 * The old per-server friends document, and the rules the in-memory stand-in (MemoryFriends.ts) keeps friends by.
 *
 * Friends used to live here: one game-wide document in each game server's profile store (ProfileStore.saveDoc
 * 'social': data/profiles/_social.json in dev, the game_docs row in production), so each server had its own. They now
 * live per account in the lobby (server-browser/src/friends, whose lists.ts has the same rules); friendsMigration.ts
 * moves an old document there once. MemoryFriends keeps one of these documents in memory when there is no lobby.
 *
 * Pure: no I/O, no clock. Accounts are keyed by lobby account id (ids are never reused); the name is the
 * account's username as last seen signing in, for lookups by name.
 */
import { isSocialStatus, type SocialStatus } from '@space-game/common';

export const SOCIAL_DOC = 'social';
/** Friends per account */
export const MAX_FRIENDS = 100;
/** Requests waiting on one account (to it, or from it) */
export const MAX_PENDING = 50;

export interface SocialAccount {
  name: string;
  status: SocialStatus;
  friends: number[];
  /** Requests to this account */
  in: number[];
  /** Requests it sent */
  out: number[];
}

export interface SocialDoc { v: 1; accounts: Record<string, SocialAccount> }

export function emptyDoc(): SocialDoc {
  return { v: 1, accounts: {} };
}

const ids = (v: unknown): number[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is number => Number.isInteger(x) && x > 0))] : []);

/** A stored document checked field by field (anything odd is dropped, never trusted) */
export function parseDoc(raw: unknown): SocialDoc {
  const doc = emptyDoc();
  const accs = (raw as { accounts?: unknown } | null)?.accounts;
  if (!accs || typeof accs !== 'object') return doc;
  for (const [k, a] of Object.entries(accs as Record<string, unknown>)) {
    const id = Number(k);
    if (!Number.isInteger(id) || id <= 0 || !a || typeof a !== 'object') continue;
    const r = a as Record<string, unknown>;
    if (typeof r.name !== 'string' || !r.name) continue;
    doc.accounts[id] = {
      name: r.name.slice(0, 40), status: isSocialStatus(r.status) ? r.status : 'online',
      friends: ids(r.friends).filter((f) => f !== id), in: ids(r.in).filter((f) => f !== id), out: ids(r.out).filter((f) => f !== id),
    };
  }
  return doc;
}

/** The account's record (made, or renamed, as it signs in) */
export function touch(doc: SocialDoc, id: number, name: string): SocialAccount {
  let a = doc.accounts[id];
  if (!a) a = doc.accounts[id] = { name, status: 'online', friends: [], in: [], out: [] };
  else a.name = name;
  return a;
}

/** An account id by name (any case), among those known here */
export function findByName(doc: SocialDoc, name: string): number | undefined {
  const n = name.trim().toLowerCase();
  if (!n) return undefined;
  for (const [k, a] of Object.entries(doc.accounts)) if (a.name.toLowerCase() === n) return Number(k);
  return undefined;
}

const drop = (list: number[], id: number) => {
  const i = list.indexOf(id);
  if (i >= 0) list.splice(i, 1);
};

export type RequestResult = 'self' | 'unknown' | 'already' | 'pending' | 'sent' | 'accepted' | 'full' | 'theirFull' | 'busy';

/** `from` asks `to` to be friends. If `to` had asked `from` already, they are friends at once ('accepted') */
export function request(doc: SocialDoc, from: number, to: number): RequestResult {
  if (from === to) return 'self';
  const a = doc.accounts[from], b = doc.accounts[to];
  if (!a || !b) return 'unknown';
  if (a.friends.includes(to)) return 'already';
  if (a.in.includes(to)) return respond(doc, from, to, true) ? 'accepted' : 'full';
  if (a.out.includes(to)) return 'pending';
  if (a.friends.length >= MAX_FRIENDS || a.out.length >= MAX_PENDING) return 'full';
  if (b.friends.length >= MAX_FRIENDS) return 'theirFull';
  if (b.in.length >= MAX_PENDING) return 'busy';
  a.out.push(to);
  b.in.push(from);
  return 'sent';
}

/** `me` answers `from`'s request; true if they are friends now */
export function respond(doc: SocialDoc, me: number, from: number, accept: boolean): boolean {
  const a = doc.accounts[me], b = doc.accounts[from];
  if (!a || !a.in.includes(from)) return false;
  drop(a.in, from);
  if (b) drop(b.out, me);
  if (!accept || !b) return false;
  if (a.friends.length >= MAX_FRIENDS || b.friends.length >= MAX_FRIENDS) return false;
  if (!a.friends.includes(from)) a.friends.push(from);
  if (!b.friends.includes(me)) b.friends.push(me);
  // (A request the other way, if any, is answered by this too)
  drop(a.out, from);
  drop(b.in, me);
  return true;
}

/** No longer friends (either side), and no request either way. True if anything changed */
export function unfriend(doc: SocialDoc, me: number, other: number): boolean {
  const a = doc.accounts[me], b = doc.accounts[other];
  if (!a) return false;
  const had = a.friends.includes(other) || a.out.includes(other) || a.in.includes(other);
  drop(a.friends, other); drop(a.out, other); drop(a.in, other);
  if (b) { drop(b.friends, me); drop(b.out, me); drop(b.in, me); }
  return had;
}

/** An account was deleted: its record and every mention of it go */
export function forget(doc: SocialDoc, id: number): boolean {
  if (!doc.accounts[id]) return false;
  delete doc.accounts[id];
  for (const a of Object.values(doc.accounts)) { drop(a.friends, id); drop(a.in, id); drop(a.out, id); }
  return true;
}
