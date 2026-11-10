/**
 * @contract server.replication.workable
 * owns:       whether a client can work a ship's window of causes out from the structures it has (contacts' others,
 *             rebuilds either side of this frame's sync, OTHER_BEFORE)
 * needs:      ReplicationCore (ships: get, structLog, debrisNet.comAt), causes/shadowCauses CauseEvent
 * invariants: a cause a client can't work out costs it a keyframe, never a wrong replica — server/src/net/replication.test.ts
 * extend:     a new structure a cause reads is one check in workable below
 */
import type { CauseEvent } from '../causes/shadowCauses.js';
import { sameVec, type Kept, type ReplicationCore, type Shadow } from './types.js';

/** A contact's other, rebuilt since while its client still has it as it was: it keeps that structure (OTHER_BEFORE) */
export function otherBefore(rep: ReplicationCore, c: NonNullable<CauseEvent['contact']>, synced?: (id: number) => number | undefined): boolean {
  const now = rep.ships.get(c.other)?.rebuilds ?? -1, has = synced ? synced(c.other) : now;
  return now !== c.rebuilds && has === c.rebuilds;
}

/**
 * Can a client work this window's causes of a ship out: has it each contact's other's structure as the pass had it
 * (or will it, by this frame's sync: one in view rebuilt no further since; syncs go before the snapshot)
 */
export function workable(rep: ReplicationCore, s: Shadow, synced: ((id: number) => number | undefined) | undefined, self: number, mine: Shadow | undefined, view?: Set<number>, eid?: number, kept?: Kept): boolean {
  for (const e of s.causes) {
    if (e.rebuild && !rebuildOk(rep, eid!, e, s.causes, synced, kept)) return false;
    const c = e.contact;
    if (!c) continue;
    // (Its own ship: it has the structure it flew each tick with)
    if (c.other === self) { if (!mine?.own) return false; continue; }
    // (Not rebuilt since, in view: it has it, or will by this frame's sync. The cheap test first; none of them moves anything)
    const now = rep.ships.get(c.other)?.rebuilds;
    if (now === c.rebuilds && (!view || view.has(c.other))) continue;
    // (Keeping every structure by its tick, CAPS.STRUCTS: the one the other had then)
    if (kept?.(c.other)?.includes(c.rebuilds)) continue;
    if ((synced ? synced(c.other) : now) === c.rebuilds) continue;
    return false;
  }
  return true;
}

/**
 * Can its client work a rebuild out: it recentres from the structure it has before this frame's sync to the one
 * after, so those must be the rebuild's either side (none of its other rebuilds in between: a death's, say, that
 * isn't a cause)
 */
export function rebuildOk(rep: ReplicationCore, eid: number, e: CauseEvent, window: readonly CauseEvent[], synced?: (id: number) => number | undefined, kept?: Kept): boolean {
  const r = e.rebuild!;
  // (Keeping every structure by its tick, CAPS.STRUCTS: this rebuild's and the one before it, in that order)
  const k = kept?.(eid);
  if (k) {
    const pr = rep.ships.structLog.around(eid, e.tick), i = pr ? k.indexOf(pr[1].rebuilds) : -1;
    return !!pr && i > 0 && k[i - 1] === pr[0].rebuilds && sameVec(pr[1].com, r.to) && sameVec(pr[0].com, r.from);
  }
  // (Else from the one it has before this frame's sync to the one after: a second in the window has the one between)
  if (window.filter((w) => w.rebuild).length > 1) return false;
  const ship = rep.ships.get(eid);
  if (!ship || ship.derived.com[0] !== r.to[0] || ship.derived.com[1] !== r.to[1]) return false;
  const has = synced ? synced(eid) : undefined, had = has === undefined ? undefined : rep.ships.debrisNet.comAt(eid, has);
  return !!had && had[0] === r.from[0] && had[1] === r.from[1];
}
