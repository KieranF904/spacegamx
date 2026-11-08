/**
 * @contract server.replication.for-client
 * owns:       one client's share of a snapshot's ship motion: keyframes for ships it's new to or behind on, control rows,
 *             cause records (contacts it finds itself left out, pulls it works out left out, zero PULL records)
 * needs:      ReplicationCore (shadows, knocks, pullOff, pullsJudged, ships, stats, real, keyNow), ownShip (ownFor,
 *             ownPulls), workable (workable, otherBefore), causes/contactsFor, causes/shadowCauses
 * invariants: each keyframe and control row is packed once a snapshot for every client — server/src/net/replication.test.ts
 *             bytes per client unchanged — server/src/golden/frameHash.test.ts
 * extend:     a new kind of per-ship record goes in the shadows loop of forClient below
 */
import {
  InSystem, ReplicaMode, OWN_CAUSE, fieldOn, packKeyframe, packControlRow, type KeyframeRow, type ControlRow, type PullFieldRec,
} from '@space-game/common';
import { causeRow, causeRecords, untoldPulls, type CauseEvent } from '../causes/shadowCauses.js';
import { contactWindow, type ContactWindow } from '../causes/contactsFor.js';
import type { Kept, ReplicationCore, Shadow } from './types.js';
import { ownFor, ownPulls } from './ownShip.js';
import { workable, otherBefore } from './workable.js';

/**
 * One client's share: keyframes for ships it's new to or behind on, control
 * changes and causes for the rest. `known` is the client's ship → keyframe version. Its own ship goes too: the
 * causes of what moved it besides its inputs (it steps it itself), a keyframe only when it can't have it otherwise.
 * `since`: its last snapshot's tick, the window it finds contact pairs over itself (net/causes/contactsFor.ts)
 */
export function forClient(rep: ReplicationCore, systemId: number, self: number, known: Map<number, number>, snapshotTick: number, view?: Set<number>, held?: ReadonlyMap<number, unknown>, synced?: (id: number) => number | undefined, bodies?: (id: number) => boolean, kept?: Kept, readers?: (ships: KeyframeRow[]) => Iterable<number>, live?: ReadonlySet<number>, since?: number): { ships: KeyframeRow[]; ctl: ControlRow[]; own?: number[][]; ownRebuild?: number; causes?: number[][]; caused?: number[]; found?: ContactWindow } {
  const ships: KeyframeRow[] = [];
  const ctl: ControlRow[] = [];
  const out: { own?: number[][]; ownRebuild?: number; causes?: number[][]; caused?: number[]; ownEvents?: CauseEvent[]; found?: ContactWindow } = {};
  // (The ships it held before this snapshot: the ones it may take in its own contact pass, and the pullers whose
  // fields' pulls it works out itself)
  const before = since !== undefined || rep.ships.pulls.any ? new Set(known.keys()) : null;
  if (since !== undefined) rep.ships.contactLog.wanted = true;
  // (Which version of a ship this client goes by: moved only when causes don't explain it; a piece of debris, only
  // when it left what it works out)
  const ver = (s: Shadow) => (s.mode === ReplicaMode.Drift ? s.dver : s.cver);
  const bver = (s: Shadow) => s.bodied!.cver;
  // Its own ship, stepped by itself (CAPS.OWN_SIM): this window's causes, the real controls only where its inputs
  // don't say them, and a keyframe only when it can't have its ship otherwise (first, before the others' versions move on)
  const mine = rep.host.ownSim?.(self) ? rep.shadows.get(self) : undefined;
  if (mine?.own && InSystem.systemId[self] === systemId && (!view || view.has(self))) ownFor(rep, self, mine, mine.own, known, snapshotTick, ships, ctl, out, synced, kept, bodies);
  for (const id of known.keys()) if (!rep.shadows.has(id)) known.delete(id);
  // (A piece of debris knocked by one this client doesn't step, out of view or not had yet: what it has of it is off)
  if (view) {
    const steps = (x: number) => view.has(x) && (known.has(x) || !!held?.has(x));
    for (const [a, c] of rep.knocks) { const sa = steps(a), sc = steps(c); if (sa !== sc) known.delete(sa ? a : c); }
  }
  // (CAPS.CAUSES: ships whose causes go this snapshot, and those keyframed: a contact with one of them carries its state)
  const caused: [number, Shadow][] = [];
  // (A ship whose causes this client can't work out: its replica of it is off from the first of them, a keyframe now)
  const unworkable = new Map<number, number>();
  const keyed = new Set<number>();
  for (const [eid, s] of rep.shadows) {
    if ((eid === self && mine?.own) || InSystem.systemId[eid] !== systemId) continue;
    // Debris it's working out itself (unconfirmed): nothing yet (SnapshotBuilder sends it all if it isn't confirmed)
    if (held?.has(eid)) continue;
    // Out of the client's view: nothing (and a keyframe when it comes back)
    if (view && !view.has(eid)) { known.delete(eid); continue; }
    // (Causes it can't work out: a contact with a ship whose structure it hasn't got as the pass had it: a keyframe)
    if (s.causes.length && !workable(rep, s, synced, self, mine, view, eid, kept)) { known.delete(eid); rep.causeStats.unworkable++; unworkable.set(eid, s.causes[0].tick); }
    // Flown by its body on this client's tick layer (CAPS.BODIES): a keyframe only when its bodied shadow left the ship
    if (s.bodied && bodies?.(eid)) {
      if (known.get(eid) !== bver(s)) {
        known.set(eid, bver(s));
        ships.push(s.keyRow ??= packKeyframe({ id: eid, mode: s.mode, body: rep.real(eid), ctl: { bits: s.bits, targetAngle: 0 }, q: s.q, dock: s.dock ?? undefined }));
        rep.keyframes++;
        rep.bodyStats.keyframes++;
        keyed.add(eid);
      } else if (s.causes.length) caused.push([eid, s]);
      continue;
    }
    if (known.get(eid) !== ver(s)) {
      known.set(eid, ver(s));
      ships.push(s.keyRow ??= packKeyframe({ id: eid, mode: s.mode, body: rep.real(eid), ctl: { bits: s.bits, targetAngle: 0 }, q: s.q, dock: s.dock ?? undefined }));
      rep.keyframes++;
      keyed.add(eid);
      continue;
    }
    if (s.causes.length) caused.push([eid, s]);
    if (s.events.length) {
      if (!s.ctlRow) {
        const events: [number, number, number][] = [];
        for (let i = 0; i < s.events.length; i += 3) events.push([snapshotTick - s.events[i], s.events[i + 1], s.events[i + 2]]);
        s.ctlRow = packControlRow(eid, events, s.qSent);
      }
      ctl.push(s.ctlRow);
    }
  }
  // (A body it runs reads a ship keyframed now: what the body made of it this window was off too, so the body's ship
  // goes again as well (BodyNet.readersOf). Before any contact is settled: one with that ship then carries its state)
  if (readers && ships.length) {
    for (const id of readers(ships)) {
      const n = ships.length;
      rep.keyNow(id, known, ships);
      if (ships.length === n) continue;
      keyed.add(id);
      const i = caused.findIndex(([e]) => e === id);
      if (i >= 0) caused.splice(i, 1);
    }
  }
  // (CAPS.CONTACTS: the window's contacts it finds itself, between ships it held before and holds in step: neither
  // as own rows nor as records, net/causes/contactsFor.ts)
  const found = before && since !== undefined ? contactsFound(rep, systemId, self, before, known, ships, snapshotTick, since, mine, view, held, synced, kept) : null;
  // (Pull fields' pulls it works out itself: a puller it held before this snapshot, in view, not keyframed now, its
  // clients' replica of it the real ship as the tick began. A tick whose pulls aren't all so is told whole)
  const pulls = rep.ships.pulls;
  // (Each tick judged once, in the first round that covers it: a round that sends nothing has left its ticks' pulls to
  // be worked out, though the next sent snapshot's window starts from the last one sent. A puller keyframed now: what
  // this client had of it on this round's ticks may be off, whatever the reason)
  const judged = Math.max(since ?? -Infinity, rep.pullsJudged.get(known) ?? -Infinity);
  if (pulls.any) rep.pullsJudged.set(known, snapshotTick);
  const derivable = (from: number, t: number) => !pulls.needsPuller(from)
    || (!!before?.has(from) && (!view || view.has(from)) && !rep.pullOff.get(from)?.has(t) && !((unworkable.get(from) ?? Infinity) <= t - 1) && !(keyed.has(from) && t > judged));
  // (A tick a field could have acted on ship `id` from a puller it can't work that one out from: that tick's pulls of
  // the ship go whole, or as a zero row if the server had none, so its step works none out from the wrong place)
  const offFields = new Map<number, PullFieldRec[]>();
  const whole = (id: number, t: number) => {
    let off = offFields.get(t);
    if (!off) offFields.set(t, (off = pulls.activeAt(systemId, t).filter((f) => !derivable(f.from, t))));
    return off.length > 0 && off.some((f) => fieldOn(f, id, t));
  };
  if (found) {
    out.found = found;
    if (out.own && out.ownEvents) {
      const keep = out.own.map((_, i) => !found.found(self, out.ownEvents![i]));
      if (keep.includes(false)) {
        rep.contactStats.ownRows += keep.filter((k) => !k).length;
        out.own = out.own.filter((_, i) => keep[i]);
        out.ownEvents = out.ownEvents.filter((_, i) => keep[i]);
        if (!out.own.length) out.own = undefined;
      }
    }
  }
  // (Its own ship's contacts with a ship keyframed now after all (new to it, or one it couldn't work out): the other's
  // state goes, its replica of the other before the keyframe isn't the pass's)
  if (out.own && out.ownEvents) {
    for (let i = 0; i < out.own.length; i++) {
      const r = out.own[i], e = out.ownEvents[i];
      if (r[1] === OWN_CAUSE.CONTACT && r.length === 4 && keyed.has(r[2])) out.own[i] = causeRow(e, snapshotTick, false);
    }
  }
  if (pulls.any && mine?.own) ownPulls(rep, out, self, snapshotTick, judged, derivable, whole);
  out.ownEvents = undefined;
  // (Pilots it holds a field may have pulled from a puller it can't have as the server had it, on a tick the server
  // had no pull of theirs: a zero PULL record each, so its step doesn't work one out from the wrong place)
  const zeros = pulls.any && Number.isFinite(judged) ? zeroPulls(rep, self, known, keyed, view, snapshotTick, judged, whole) : null;
  if (zeros) for (const id of zeros.keys()) if (!caused.some(([e]) => e === id)) caused.push([id, rep.shadows.get(id)!]);
  // Their causes (CAPS.CAUSES), a contact without the other's state where its replica of the other is the pass's: in
  // step (no keyframe of it since the contact, none now) and not flown by its body here
  if (caused.length || found?.leftOut.length) {
    // (Its own ship keyframed now: ownFor's, first in the list)
    const ownKeyed = ships.some((k) => k[0] === self);
    const inStep = (c: NonNullable<CauseEvent['contact']>) => {
      const o = c.other;
      if (o === self) return c.inStep && !!mine?.own && !ownKeyed;
      const os = rep.shadows.get(o);
      if (!os || keyed.has(o)) return false;
      // (One flown by its body here: its bodied shadow is what this client has of it)
      if (os.bodied && bodies?.(o)) return !!c.bodyStep && os.bodied.cver === c.bcver && known.get(o) === os.bodied.cver;
      return c.inStep && os.cver === c.cver && known.get(o) === os.cver;
    };
    // (Contacts it finds itself go as no record, CAPS.CONTACTS)
    const lists = caused.map(([eid, s]) => {
      let l: readonly CauseEvent[] = s.causes;
      if (found) {
        l = s.causes.filter((e) => !found.found(eid, e));
        rep.contactStats.records += s.causes.length - l.length;
      }
      // (Pull fields' pulls it works out itself: common sim/pullFields.ts)
      const d = pulls.any ? untoldPulls(l, derivable, (t) => whole(eid, t)) : null;
      if (d) { l = l.filter((e) => !d.has(e)); rep.causeStats.pullDerived += d.size; }
      const z = zeros?.get(eid);
      if (z) l = [...l, ...z].sort((a, b) => a.tick - b.tick || a.seq - b.seq);
      return [eid, l] as const;
    });
    const { rows, stateless } = causeRecords(lists, snapshotTick,
      (e) => !!e.contact && inStep(e.contact), (e) => !!e.contact && otherBefore(rep, e.contact, synced));
    rep.causeStats.rows += rows.length;
    rep.causeStats.stateless += stateless;
    // (Ships it leaves out of its own contact pass this window: one record naming each twice, last)
    if (found) for (const id of found.leftOut) rows.push([0, OWN_CAUSE.CONTACT, id, id, 0]);
    if (rows.length) out.causes = rows;
    // (Every ship a record names: its client leaves hits on them this window to the records, SelfHits.onCaused; and
    // every ship a pair it finds touched, ContactWorld)
    const ids = new Set<number>(found?.touched);
    for (const r of rows) { ids.add(r[2]); if (r[1] === OWN_CAUSE.CONTACT) ids.add(r[3]); }
    out.caused = [...ids];
  } else if (found?.touched.size) {
    out.caused = [...found.touched];
  }
  return { ships, ctl, ...out };
}

/**
 * The window's contacts a CONTACTS client finds itself (net/causes/contactsFor.ts): the ships it takes are the ones it
 * held before this snapshot and holds in step through it (no keyframe now, still in view, in this system, ships; its
 * own when it steps it, CAPS.OWN_SIM)
 */
export function contactsFound(rep: ReplicationCore, systemId: number, self: number, before: ReadonlySet<number>, known: ReadonlyMap<number, number>, ships: KeyframeRow[], snapshotTick: number, since: number, mine: Shadow | undefined, view?: Set<number>, held?: ReadonlyMap<number, unknown>, synced?: (id: number) => number | undefined, kept?: Kept): ContactWindow {
  const keyed = new Set(ships.map((k) => k[0]));
  const take = new Set<number>();
  for (const id of before) {
    if (!known.has(id) || keyed.has(id) || held?.has(id) || InSystem.systemId[id] !== systemId || rep.ships.get(id)?.kind !== 'ship') continue;
    if (id === self ? !mine?.own : !rep.shadows.has(id) || (view && !view.has(id))) continue;
    take.add(id);
  }
  const w = contactWindow({
    log: rep.ships.contactLog, systemId, from: since, to: snapshotTick, held: take,
    docked: (id) => rep.shadows.get(id)?.mode === ReplicaMode.Docked,
    events: (id) => rep.shadows.get(id)?.causes,
    structOk: (id, rb) => {
      if (kept?.(id)?.includes(rb)) return true;
      const now = rep.ships.get(id)?.rebuilds;
      return now === rb && (synced?.(id) === now || id === self || !!view?.has(id));
    },
  });
  rep.contactStats.windows++;
  rep.contactStats.leftOut += w.leftOut.length;
  rep.contactStats.found += w.count;
  return w;
}

/**
 * The other pilots' zero PULL records this window (forClient): on a tick a field could act on one it holds (in view,
 * not keyframed now) from a puller this client can't have as the server had it, with no pull of the server's on it
 * then. Null: none
 */
export function zeroPulls(rep: ReplicationCore, self: number, known: ReadonlyMap<number, number>, keyed: ReadonlySet<number>, view: Set<number> | undefined, snapshotTick: number, since: number, whole: (id: number, t: number) => boolean): Map<number, CauseEvent[]> | null {
  let out: Map<number, CauseEvent[]> | null = null;
  for (let t = since + 1; t <= snapshotTick; t++) {
    for (const id of known.keys()) {
      if (id === self || keyed.has(id) || (view && !view.has(id))) continue;
      const s = rep.shadows.get(id);
      if (!s || s.mode !== ReplicaMode.Player || !whole(id, t)) continue;
      if (s.causes.some((e) => e.tick === t && e.row[0] === OWN_CAUSE.PULL)) continue;
      let l = (out ??= new Map()).get(id);
      if (!l) out.set(id, (l = []));
      l.push({ tick: t, seq: -1, row: [OWN_CAUSE.PULL, 0, 0] });
      rep.causeStats.pullZero++;
    }
  }
  return out;
}
