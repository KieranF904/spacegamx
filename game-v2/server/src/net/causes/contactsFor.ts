/**
 * Which of a window's contacts a client finds itself (CAPS.CONTACTS; client ships/causes/ContactWorld.ts), worked out
 * here as the client works it out, so neither side guesses. The client takes, on each tick of the window, the ships it
 * held before it and holds in step through it (none keyframed now, none gone or out of view) that it would put in its
 * contact pass (ships, not docked, not mid-jump, with their structure then), less those it is told to leave out; and
 * every candidate pair among them (common ships/contactPass.ts). For ships the server's pass also had, in step, those
 * are the server's pairs to the bit: they go neither as records nor as own rows nor as sparks.
 *
 * A ship is left out (a CONTACT record naming it twice: common network/causes.ts isLeftOut) when the client could take
 * it differently from the server's pass:
 *   - out of the pass here while the client would take it (another reason than docking: a jump, no mass)
 *   - pinned (it doesn't give) where the client wasn't told so (its first shipSync says it: `toldPinned`), or told so
 *     where it isn't: only when it has a candidate pair among them
 *   - its structure that tick not one the client has (a rebuild since that the client can't reach back for)
 *   - pulled after the pass began (pulls are before it everywhere else: the client puts them there)
 * Its pairs then come as records, as before.
 */
import { OWN_CAUSE } from '@space-game/common';
import type { CauseEvent } from './shadowCauses.js';
import { passIndex, type ContactLog } from './contactLog.js';

export interface ContactWindowHost {
  log: ContactLog;
  systemId: number;
  /** The window's ticks: after `from`, up to `to` */
  from: number;
  to: number;
  /** The ships it takes before any is left out (held before the window and in step through it, its own included) */
  held: ReadonlySet<number>;
  /** Docked (it leaves those out itself) */
  docked(id: number): boolean;
  /** Has the client the structure ship `id` flew with when it had been rebuilt `rebuilds` times, for tick `t`? */
  structOk(id: number, rebuilds: number, t: number): boolean;
  /** Each ship's causes this window (contacts, pulls) */
  events(id: number): readonly CauseEvent[] | undefined;
  /**
   * Was the client told ship `id` is pinned (its sync's `pinned`)? Undefined: it can't say (not synced as the ship it is
   * now), and a pinned ship is left out. Absent: no client knows, every pinned ship is left out
   */
  toldPinned?(id: number): boolean | undefined;
}

export interface ContactWindow {
  /** Ships it leaves out of its pass this window */
  leftOut: number[];
  /** Is this contact (ship `id`'s event) one the client finds itself? */
  found(id: number, e: CauseEvent): boolean;
  /** ...the pair of these two ships on tick t (its sparks) */
  pair(a: number, b: number, t: number): boolean;
  /** Ships a pair it finds touched (their hits are told this window, as for a told cause) */
  touched: Set<number>;
  /** Contacts it finds this window (both sides once) */
  count: number;
}

const WINDOW_MAX = 600;

export function contactWindow(h: ContactWindowHost): ContactWindow {
  const out = new Set<number>();
  const { log, systemId, held } = h;
  const from = Math.max(h.from, h.to - WINDOW_MAX);
  // (Pulled after the pass began, or a pass's ship whose structure it lacks or that's pinned with a pair among them)
  for (const id of held) {
    for (const e of h.events(id) ?? []) {
      if (e.row[0] !== OWN_CAUSE.PULL || e.tick <= from || e.tick > h.to) continue;
      const L = log.at(e.tick, systemId);
      if (L && e.seq >= L.seq) { out.add(id); break; }
    }
  }
  // (Out of a pass there was, docked aside, or a pass's structure it lacks. By ship over the window's passes (one sum
  // for every client in the system: ContactLog.window); docked and structOk read nothing that moves within the window)
  const passes = log.window(systemId, from, h.to);
  if (passes.any) {
    for (const id of held) {
      if (out.has(id)) continue;
      const e = passes.ships.get(id);
      if ((!e || e.missing) && !h.docked(id)) { out.add(id); continue; }
      if (!e) continue;
      for (let k = 0; k < e.rebuilds.length; k++) if (!h.structOk(id, e.rebuilds[k], e.ticks[k])) { out.add(id); break; }
    }
  }
  // (A tick whose pass had none pinned: a side differs only where it was told pinned, so with none of those its pairs
  // can't differ. toldPinned reads nothing that moves within the window: asked once a ship)
  let toldAny: boolean | undefined;
  for (let t = from + 1; t <= h.to; t++) {
    const L = log.at(t, systemId);
    if (!L) continue;
    // (A pair's side the client takes otherwise pinned or not than the pass had it)
    if (L.pinned.length || (h.toldPinned && (toldAny ??= [...held].some((id) => h.toldPinned!(id) === true)))) {
      const told = h.toldPinned;
      const differs = (id: number) => { const p = L.pinned.includes(id), k = told?.(id); return k === undefined ? p : k !== p; };
      for (let k = 0; k < L.pairs.length; k += 2) {
        const a = L.pairs[k], b = L.pairs[k + 1];
        if (!held.has(a) || !held.has(b)) continue;
        if (differs(a)) out.add(a);
        if (differs(b)) out.add(b);
      }
    }
  }
  // Its pass on a tick: the ships it takes there, as the server's pass had them
  const inPass = (id: number, t: number) => {
    if (!held.has(id) || out.has(id) || t <= from || t > h.to) return false;
    const L = log.at(t, systemId);
    return !!L && passIndex(L, id) >= 0;
  };
  const touched = new Set<number>();
  let count = 0;
  for (const id of held) {
    for (const e of h.events(id) ?? []) {
      const c = e.contact;
      if (!c || !inPass(id, e.tick) || !inPass(c.other, e.tick)) continue;
      touched.add(id);
      touched.add(c.other);
      count++;
    }
  }
  return {
    leftOut: [...out].sort((a, b) => a - b),
    found: (id, e) => !!e.contact && inPass(id, e.tick) && inPass(e.contact.other, e.tick),
    pair: (a, b, t) => inPass(a, t) && inPass(b, t),
    touched,
    count,
  };
}
