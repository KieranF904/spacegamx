/**
 * @contract server.pilots.guests
 * owns:       guest pilots kept for a while by their browser's guest key (the join's guestKey): a guest who joins again
 *             (a dropped socket, a restarted server, a reload) flies on as they were, tutorial step and all; and a guest's
 *             lifetime: wiped after GUEST_KEEP_MS unused, at most GUEST_LIFE_MS old (then GUEST_GRACE_MS only to register)
 * needs:      ProfileStore (loadDoc / saveDoc only: never the accounts' saves); npm: node crypto, @space-game/common
 * invariants: a guest is kept by a hash of their key, never the key or their name (a name proves nothing) —
 *             server/src/game/pilots/guests.test.ts
 *             kept GUEST_KEEP_MS since last used, GUEST_KEEP_MAX at most (the oldest go first); a connected guest is never wiped
 *             — server/src/game/pilots/guests.test.ts
 *             a guest older than GUEST_LIFE_MS is handed back as expired (to register, not to play) for GUEST_GRACE_MS, then
 *             gone; a record taken by `consume` is gone for good (a guest registers once) — server/src/game/pilots/guests.test.ts
 *             one address keeps GUEST_KEEP_PER_IP guests at most (its own oldest go first): a flood of new guests from one place
 *             can't push out everyone else's — server/src/game/pilots/guests.test.ts
 * extend:     none: what a guest keeps is their profile; Pilots decides when one is put or taken
 */

import { createHash } from 'crypto';
import { cloneJson, GUEST_KEEP_MS, GUEST_LIFE_MS, GUEST_GRACE_MS } from '@space-game/common';
import type { ProfileStore } from '../../profile/ProfileStore.js';

// (How long a guest is kept unused, lives, and has to register: common network/guestProtocol.ts, which tells the guest too)
export { GUEST_KEEP_MS, GUEST_LIFE_MS, GUEST_GRACE_MS };
/** Guests kept at most (each a small profile: the doc stays a few MB at worst) */
export const GUEST_KEEP_MAX = 200;
/**
 * Guests kept at most from one address (a family or a class behind one router fits; a script minting keys does not). Past it a new
 * guest from that address takes the place of that address's own oldest: they still play and are kept, and others' are never touched
 */
export const GUEST_KEEP_PER_IP = 5;
/** The store's game-wide document they're written to */
export const GUEST_DOC = 'guests';
/** Written at most this often while something changed (a server killed outright, as `tsx watch` does on Windows, loses no more) */
export const GUEST_WRITE_MS = 10_000;

/** A guest key as the client makes them (network/guestId.ts): 32 to 64 hex digits; anything else isn't one */
const KEY = /^[0-9a-f]{32,64}$/i;

/** The id a guest is kept by: a hash of their key (null: no key, or not one) */
export function guestIdOf(key: unknown): string | null {
  if (typeof key !== 'string' || !KEY.test(key)) return null;
  return createHash('sha256').update(key.toLowerCase()).digest('hex').slice(0, 32);
}

/** `ip`: a hash of the address they joined from (none: unknown, as with a local game: not counted) */
/** What an address is kept as: a hash, so the saved doc holds no one's address */
function addressKey(address: string): string {
  return createHash('sha256').update(address).digest('hex').slice(0, 16);
}

/** `at`: when they were last put (last used); `created`: when the guest began (the 3 days run from it) */
interface Kept { name: string; profile: unknown; at: number; created: number; ip?: string }

/** A guest as `take` hands them back: `expired` is the 3 days gone (only to be registered), `expiresInMs` until that ends / until the wipe */
export interface TakenGuest { name: string; profile: unknown; expired: boolean; expiresInMs: number }

export class GuestKeep {
  /** By id, the least recently put first */
  private kept = new Map<string, Kept>();
  private dirty = false;
  private lastWrite = -Infinity;
  private writing: Promise<void> | null = null;
  /** The doc read from the store (at start-up): taking waits for it */
  readonly ready: Promise<void>;

  /** `live`: a guest id someone is connected as (not idle, so never wiped for it) */
  constructor(private readonly store: Pick<ProfileStore, 'loadDoc' | 'saveDoc'>, private readonly now: () => number, private readonly live: (id: string) => boolean = () => false) {
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    let raw: unknown = null;
    try {
      raw = await this.store.loadDoc(GUEST_DOC);
    } catch (e) {
      console.error('[Guests] could not read the kept guests:', e);
    }
    const list = (raw as { guests?: unknown } | null)?.guests;
    if (!Array.isArray(list)) return;
    // (Kept before any put since start-up, oldest first: a put meanwhile is newer)
    const fresh = new Map<string, Kept>();
    for (const g of list as { id?: unknown; name?: unknown; profile?: unknown; at?: unknown; created?: unknown; ip?: unknown }[]) {
      if (typeof g?.id !== 'string' || typeof g.name !== 'string' || typeof g.at !== 'number' || !g.profile || typeof g.profile !== 'object') continue;
      // (A guest kept before the 3 days: begun when last used)
      fresh.set(g.id, { name: g.name, profile: g.profile, at: g.at, created: typeof g.created === 'number' ? g.created : g.at, ...(typeof g.ip === 'string' ? { ip: g.ip } : {}) });
    }
    for (const [id, k] of this.kept) { fresh.delete(id); fresh.set(id, k); }
    this.kept = fresh;
    this.prune();
  }

  /** A guest's profile as it is now (a copy); `address` is where they joined from (the per-address cap) */
  put(id: string, name: string, profile: unknown, address?: string): void {
    const prior = this.kept.get(id);
    const ip = address ? addressKey(address) : prior?.ip;
    this.kept.delete(id);
    // (A new guest from an address already at its cap: that address's oldest makes room: the order is oldest first)
    if (ip && !prior) {
      const mine = [...this.kept].filter(([, k]) => k.ip === ip);
      for (let i = 0; i <= mine.length - GUEST_KEEP_PER_IP; i++) this.kept.delete(mine[i][0]);
    }
    this.kept.set(id, { name, profile: cloneJson(profile), at: this.now(), created: prior?.created ?? this.now(), ...(ip ? { ip } : {}) });
    this.dirty = true;
    this.prune();
  }

  /** The guest kept under this id, if still kept (a copy of their profile; it stays kept until it's put again or expires) */
  async take(id: string): Promise<TakenGuest | null> {
    await this.ready;
    // (The joining connection is "connected as" this guest already: it doesn't keep its own record from the wipe)
    this.prune(id);
    const k = this.kept.get(id);
    if (!k) return null;
    const age = this.now() - k.created;
    const expired = age > GUEST_LIFE_MS;
    return { name: k.name, profile: cloneJson(k.profile), expired, expiresInMs: (expired ? GUEST_LIFE_MS + GUEST_GRACE_MS : GUEST_LIFE_MS) - age };
  }

  /** The guest registered: their record is gone for good (true if there was one: only the first call to it gets the profile moved) */
  consume(id: string): boolean {
    const had = this.kept.delete(id);
    if (had) this.dirty = true;
    return had;
  }

  get size(): number { return this.kept.size; }

  private prune(joining?: string): void {
    const now = this.now();
    // (Unused for GUEST_KEEP_MS, or past the 3 days and the grace to register: never one someone is connected as)
    for (const [id, k] of this.kept) {
      if ((now - k.at > GUEST_KEEP_MS || now - k.created > GUEST_LIFE_MS + GUEST_GRACE_MS) && (id === joining || !this.live(id))) { this.kept.delete(id); this.dirty = true; }
    }
    // (Then the oldest put first, till the count fits: put order is time order)
    for (const id of this.kept.keys()) {
      if (this.kept.size <= GUEST_KEEP_MAX) break;
      this.kept.delete(id);
      this.dirty = true;
    }
  }

  /** Once a tick: written to the store if anything changed and the last write was long enough ago */
  tick(): void {
    if (this.dirty && !this.writing && this.now() - this.lastWrite >= GUEST_WRITE_MS) void this.write();
  }

  /** Written now (shutdown) */
  async flush(): Promise<void> {
    await this.writing;
    if (this.dirty) await this.write();
  }

  private write(): Promise<void> {
    this.dirty = false;
    this.lastWrite = this.now();
    // (After the start-up read: written before it, the guests kept from before would be lost)
    const p = this.ready
      .then(() => this.store.saveDoc(GUEST_DOC, { guests: [...this.kept].map(([id, k]) => ({ id, name: k.name, at: k.at, created: k.created, profile: k.profile, ...(k.ip ? { ip: k.ip } : {}) })) }))
      .catch((e) => { this.dirty = true; console.error('[Guests] could not write the kept guests:', e); })
      .finally(() => { if (this.writing === p) this.writing = null; });
    this.writing = p;
    return p;
  }
}
