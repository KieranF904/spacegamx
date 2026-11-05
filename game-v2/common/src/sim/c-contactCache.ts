/**
 * Contact pairs found once per tick and cached (sim foundation, Stage 1C; the ContactCache contract in env.ts).
 *
 * `contactPairs` is the one way a tick's candidate pairs are found: a system's bodies (sorted by id) through the
 * contact pass's sweep (ships/contactPass.ts contactCandidates), as id pairs [a, b] (a < b) in the pass's order. The
 * server's pass (server ships/bridge/flight.ts resolveContacts) and a client finding its own pairs (CAPS.CONTACTS:
 * client ships/causes/ContactWorld.ts) both take their pairs from a ContactPairCache over it: found the first time a
 * tick is asked for, then read from the cache by every reader of that tick (the server's pass, a client's ships
 * stepping it, a re-step of it). A re-step that moves a body drops the ticks from its tick on (`dropFrom`): only
 * those are found again.
 *
 * `live` says which pairs could have touched: their centres within both reaches plus CONTACT_MARGIN, the most the
 * pushes of earlier pairs in the pass can close (the margin the sweep pads by). A pair that isn't live is skipped by
 * the pass whatever the rest of the tick did (the reach check, ownTick.ts applyCauseRows), so a client re-stepping a
 * ship need only re-step the ships it had live pairs with (ContactWorld).
 */

import { contactCandidates, CONTACT_MARGIN, type ContactEntry } from '../ships/contactPass.js';
import type { ContactCache } from './env.js';

export type ContactPair = readonly [number, number];

const SCRATCH: number[] = [];

/** One system's candidate pairs (`entries` sorted by id) as ids [a, b], a < b, in the pass's order */
export function contactPairs(entries: readonly ContactEntry[], out: ContactPair[] = []): ContactPair[] {
  const found = contactCandidates(entries, SCRATCH);
  for (let i = 0; i < found.length; i += 2) out.push([entries[found[i]].id, entries[found[i + 1]].id]);
  return out;
}

/** Could this pair touch this tick (its bodies before the pass)? */
export function contactLive(a: ContactEntry, b: ContactEntry): boolean {
  const dx = b.x - a.x, dy = b.y - a.y, r = a.r + b.r + CONTACT_MARGIN;
  return dx * dx + dy * dy <= r * r;
}

/** A tick's pairs, cached until its tick is stepped again */
export class ContactPairCache implements ContactCache {
  private readonly by = new Map<number, readonly ContactPair[]>();
  private hi = -Infinity;
  /** found: ticks whose pairs were worked out (a tick found again after a dropFrom counts again); read: cached reads */
  readonly stats = { found: 0, read: 0 };
  /** How many times each recent tick's pairs were found (tests: once per tick unless it was stepped again) */
  readonly finds = new Map<number, number>();

  constructor(
    /** Tick t's pairs, worked out (called once per tick until dropped) */
    private readonly find: (t: number) => readonly ContactPair[],
    /** Ticks kept behind the newest found */
    private readonly keep = 600,
  ) {}

  pairs(t: number): readonly ContactPair[] {
    const have = this.by.get(t);
    if (have) { this.stats.read++; return have; }
    const found = this.find(t);
    this.by.set(t, found);
    this.stats.found++;
    this.finds.set(t, (this.finds.get(t) ?? 0) + 1);
    if (t > this.hi) {
      this.hi = t;
      if (this.by.size > this.keep) for (const k of this.by.keys()) if (k <= t - this.keep) this.by.delete(k);
      if (this.finds.size > this.keep) for (const k of this.finds.keys()) if (k <= t - this.keep) this.finds.delete(k);
    }
    return found;
  }

  /** Tick t's pairs if they're cached */
  peek(t: number): readonly ContactPair[] | undefined {
    return this.by.get(t);
  }

  /** Tick t's pairs as worked out elsewhere (the server's pass, which finds them as it goes) */
  set(t: number, pairs: readonly ContactPair[]): void {
    this.by.set(t, pairs);
    if (t > this.hi) this.hi = t;
  }

  dropFrom(t: number): void {
    if (t > this.hi) return;
    for (const k of [...this.by.keys()]) if (k >= t) this.by.delete(k);
    this.hi = -Infinity;
    for (const k of this.by.keys()) if (k > this.hi) this.hi = k;
  }

  clear(): void {
    this.by.clear();
    this.finds.clear();
    this.hi = -Infinity;
  }
}
