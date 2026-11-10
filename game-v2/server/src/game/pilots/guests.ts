/**
 * @contract server.pilots.guests
 * owns:       guest pilots kept for a while by their browser's guest key (the join's guestKey): a guest who joins again
 *             (a dropped socket, a restarted server, a reload) flies on as they were, tutorial step and all
 * needs:      ProfileStore (loadDoc / saveDoc only: never the accounts' saves); npm: node crypto, @space-game/common
 * invariants: a guest is kept by a hash of their key, never the key or their name (a name proves nothing) —
 *             server/src/game/pilots/guests.test.ts
 *             kept GUEST_KEEP_MS at most, GUEST_KEEP_MAX at most (the oldest go first) — server/src/game/pilots/guests.test.ts
 *             one address keeps GUEST_KEEP_PER_IP guests at most (its own oldest go first): a flood of new guests from one place
 *             can't push out everyone else's — server/src/game/pilots/guests.test.ts
 * extend:     none: what a guest keeps is their profile; Pilots decides when one is put or taken
 */

import { createHash } from 'crypto';
import { cloneJson } from '@space-game/common';
import type { ProfileStore } from '../../profile/ProfileStore.js';

/** How long a guest who left is kept (wall ms): long enough to come back after a restart, an update or a night */
export const GUEST_KEEP_MS = 24 * 60 * 60_000;
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

interface Kept { name: string; profile: unknown; at: number; ip?: string }

export class GuestKeep {
  /** By id, the least recently put first */
  private kept = new Map<string, Kept>();
  private dirty = false;
  private lastWrite = -Infinity;
  private writing: Promise<void> | null = null;
  /** The doc read from the store (at start-up): taking waits for it */
  readonly ready: Promise<void>;

  constructor(private readonly store: Pick<ProfileStore, 'loadDoc' | 'saveDoc'>, private readonly now: () => number) {
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
    for (const g of list as { id?: unknown; name?: unknown; profile?: unknown; at?: unknown; ip?: unknown }[]) {
      if (typeof g?.id !== 'string' || typeof g.name !== 'string' || typeof g.at !== 'number' || !g.profile || typeof g.profile !== 'object') continue;
      fresh.set(g.id, { name: g.name, profile: g.profile, at: g.at, ...(typeof g.ip === 'string' ? { ip: g.ip } : {}) });
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
    this.kept.set(id, { name, profile: cloneJson(profile), at: this.now(), ...(ip ? { ip } : {}) });
    this.dirty = true;
    this.prune();
  }

  /** The guest kept under this id, if still kept (a copy of their profile; it stays kept until it's put again or expires) */
  async take(id: string): Promise<{ name: string; profile: unknown } | null> {
    await this.ready;
    this.prune();
    const k = this.kept.get(id);
    return k ? { name: k.name, profile: cloneJson(k.profile) } : null;
  }

  get size(): number { return this.kept.size; }

  private prune(): void {
    const old = this.now() - GUEST_KEEP_MS;
    for (const [id, k] of this.kept) {
      if (k.at >= old && this.kept.size <= GUEST_KEEP_MAX) break;
      this.kept.delete(id);
      this.dirty = true;
    }
    // (Put order is time order, except a clock that went back: those are caught on the next prune)
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
      .then(() => this.store.saveDoc(GUEST_DOC, { guests: [...this.kept].map(([id, k]) => ({ id, name: k.name, at: k.at, profile: k.profile, ...(k.ip ? { ip: k.ip } : {}) })) }))
      .catch((e) => { this.dirty = true; console.error('[Guests] could not write the kept guests:', e); })
      .finally(() => { if (this.writing === p) this.writing = null; });
    this.writing = p;
    return p;
  }
}
