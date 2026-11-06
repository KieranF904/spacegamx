/**
 * Friends, friend requests and the chosen status of each account: the pure rules (no I/O, no clock).
 *
 * The stores (JsonFriendStore, PostgresFriendStore) hand an operation the records of just the accounts it touches
 * (`Lists`, filled with empty records for accounts that have none yet) and write back the ones that changed.
 * Records are keyed by account id (users.id; ids are never reused). Names are the accounts' own (the users table).
 *
 * The game server's in-memory stand-in (server/src/game/social/MemoryFriends.ts) follows these same rules.
 */

export type SocialStatus = 'online' | 'away' | 'busy' | 'invisible';
export const STATUSES: readonly SocialStatus[] = ['online', 'away', 'busy', 'invisible'];
export const isStatus = (v: unknown): v is SocialStatus => typeof v === 'string' && (STATUSES as readonly string[]).includes(v);

/** Friends per account */
export const MAX_FRIENDS = 100;
/** Requests waiting on one account (to it, or from it) */
export const MAX_PENDING = 50;

export interface FriendLists {
  status: SocialStatus;
  friends: number[];
  /** Requests to this account */
  in: number[];
  /** Requests it sent */
  out: number[];
}

/** The records an operation may read and change (every id it was given has one) */
export type Lists = Map<number, FriendLists>;

export const emptyLists = (): FriendLists => ({ status: 'online', friends: [], in: [], out: [] });

export const isEmpty = (l: FriendLists): boolean => l.status === 'online' && !l.friends.length && !l.in.length && !l.out.length;

const ids = (v: unknown, self: number): number[] =>
  Array.isArray(v) ? [...new Set(v.map(Number).filter((x) => Number.isSafeInteger(x) && x > 0 && x !== self))] : [];

/** A stored or sent record checked field by field (anything odd is dropped, never trusted) */
export function cleanLists(raw: unknown, self: number): FriendLists {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return { status: isStatus(r.status) ? r.status : 'online', friends: ids(r.friends, self), in: ids(r.in, self), out: ids(r.out, self) };
}

const drop = (list: number[], id: number) => {
  const i = list.indexOf(id);
  if (i >= 0) list.splice(i, 1);
};

export type RequestResult = 'self' | 'already' | 'pending' | 'sent' | 'accepted' | 'full' | 'theirFull' | 'busy';

/** `from` asks `to` to be friends. If `to` had asked `from` already, they are friends at once ('accepted') */
export function request(l: Lists, from: number, to: number): RequestResult {
  if (from === to) return 'self';
  const a = l.get(from)!, b = l.get(to)!;
  if (a.friends.includes(to)) return 'already';
  if (a.in.includes(to)) return respond(l, from, to, true) ? 'accepted' : 'full';
  if (a.out.includes(to)) return 'pending';
  if (a.friends.length >= MAX_FRIENDS || a.out.length >= MAX_PENDING) return 'full';
  if (b.friends.length >= MAX_FRIENDS) return 'theirFull';
  if (b.in.length >= MAX_PENDING) return 'busy';
  a.out.push(to);
  b.in.push(from);
  return 'sent';
}

/** `me` answers `from`'s request; true if they are friends now */
export function respond(l: Lists, me: number, from: number, accept: boolean): boolean {
  const a = l.get(me)!, b = l.get(from)!;
  if (!a.in.includes(from)) return false;
  drop(a.in, from);
  drop(b.out, me);
  if (!accept) return false;
  if (a.friends.length >= MAX_FRIENDS || b.friends.length >= MAX_FRIENDS) return false;
  if (!a.friends.includes(from)) a.friends.push(from);
  if (!b.friends.includes(me)) b.friends.push(me);
  // (A request the other way, if any, is answered by this too)
  drop(a.out, from);
  drop(b.in, me);
  return true;
}

/** No longer friends (either side), and no request either way. True if anything changed */
export function unfriend(l: Lists, me: number, other: number): boolean {
  const a = l.get(me)!, b = l.get(other)!;
  const had = a.friends.includes(other) || a.out.includes(other) || a.in.includes(other);
  drop(a.friends, other); drop(a.out, other); drop(a.in, other);
  drop(b.friends, me); drop(b.out, me); drop(b.in, me);
  return had;
}

/** Every mention of an account gone from one record. True if anything changed */
export function forgetIn(rec: FriendLists, id: number): boolean {
  const n = rec.friends.length + rec.in.length + rec.out.length;
  drop(rec.friends, id); drop(rec.in, id); drop(rec.out, id);
  return rec.friends.length + rec.in.length + rec.out.length !== n;
}

/**
 * One game server's old friends document (server/src/game/social: `{ accounts: { id: { status, friends, in, out } } }`)
 * merged in. Idempotent: friendships and requests are added only when missing (and within the caps); a status only
 * for an account that had no record here before (`had`). Ids not in `exists` (deleted accounts) are skipped.
 * Returns how many friendships and requests were added.
 */
export function importDoc(l: Lists, accounts: Map<number, FriendLists>, exists: Set<number>, had: Set<number>): { friends: number; requests: number } {
  let friends = 0, requests = 0;
  for (const [id, r] of accounts) {
    if (!exists.has(id)) continue;
    const a = l.get(id)!;
    if (!had.has(id) && r.status !== 'online') a.status = r.status;
    for (const f of r.friends) {
      if (!exists.has(f) || a.friends.includes(f)) continue;
      const b = l.get(f)!;
      if (a.friends.length >= MAX_FRIENDS || b.friends.length >= MAX_FRIENDS) continue;
      a.friends.push(f); b.friends.push(id);
      drop(a.in, f); drop(a.out, f); drop(b.in, id); drop(b.out, id);
      friends++;
    }
    const asks: [number, number][] = [...r.out.map((t) => [id, t] as [number, number]), ...r.in.map((s) => [s, id] as [number, number])];
    for (const [from, to] of asks) {
      if (!exists.has(from) || !exists.has(to)) continue;
      const x = l.get(from)!, y = l.get(to)!;
      if (x.friends.includes(to) || x.out.includes(to) || x.in.includes(to)) continue;
      if (x.out.length >= MAX_PENDING || y.in.length >= MAX_PENDING) continue;
      x.out.push(to); y.in.push(from);
      requests++;
    }
  }
  return { friends, requests };
}
