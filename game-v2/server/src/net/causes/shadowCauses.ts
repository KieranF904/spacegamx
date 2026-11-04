/**
 * Causes on Replication's shadows: what moved a ship in a tick besides its controls (ships/bridge/ownCauses.ts), as
 * rows its clients work out with the shared function (common network/ownTick.ts applyOwnCauses), for a pilot's own
 * ship (CAPS.OWN_SIM) and for every other ship a client holds (CAPS.CAUSES, network/causes.ts).
 *
 * The server works each tick's causes out once per ship on its shadow, a contact always with the other's state as the
 * contact pass had it. What a client is sent differs only in that state: it goes unless the client's replica of the
 * other, before that tick's causes, is the pass's (`inStep`, settled after the tick for every contact at once).
 */
import { OWN_CAUSE, CONTACT_FLAG, PAIR, applyCauseRows, type OwnCauseEnv, type FlightBody } from '@space-game/common';
import type { OwnCause, OwnContact } from '../../ships/bridge/ownCauses.js';

/** A cause as its clients are told it: its tick and row ([kind, ...]) */
export interface CauseEvent {
  tick: number;
  /** Its place among the tick's causes, every ship's (the order clients work them out in) */
  seq: number;
  row: number[];
  /** A rebuild: its centres of mass either side (a client works it out from the structures it has before and after its sync) */
  rebuild?: { from: readonly number[]; to: readonly number[] };
  /**
   * A contact: whether a replica of the other before that tick's causes is the pass's (then the row may go without the
   * state), the other's versions then (a keyframe of it since: the client's replica moved), and its rebuilds then
   */
  contact?: {
    other: number; inStep: boolean; preStep?: boolean; version: number; cver: number; rebuilds: number; before?: boolean;
    /** The other flown by its body (CAPS.BODIES): whether its bodied shadow, as clients running it have it, was the pass's; its version then */
    bodyStep?: boolean; bcver?: number;
  };
}

/** A tick's causes as rows (a contact with the other's state), with what applying them needs */
export interface WorkedCauses { rows: number[][]; seqs: number[]; env: OwnCauseEnv; contacts: Map<number, OwnContact>; rebuilt: { from: [number, number]; to: [number, number] } | null }

/**
 * A ship's causes on one tick, made into rows; a string instead when a client couldn't work them out from rows (why:
 * the ship gets a keyframe). `window`: its causes earlier in the snapshot window (a second rebuild in one can't be: the
 * structure between isn't on the client)
 */
export function workCauses(causes: readonly OwnCause[], window: readonly CauseEvent[], cellSize: number, restitution: number): WorkedCauses | string {
  const rows: number[][] = [], seqs: number[] = [];
  const contacts = new Map<number, OwnContact>();
  let rebuilt: { from: [number, number]; to: [number, number] } | null = null, self: OwnContact['self'] | null = null;
  for (const c of causes) {
    seqs.push(c.seq ?? 0);
    if (c.kind === 0) rows.push([OWN_CAUSE.PULL, c.dvx, c.dvy]);
    else if (c.kind === 1) {
      if (contacts.has(c.other)) return 'contact twice';
      contacts.set(c.other, c);
      self ??= c.self;
      rows.push([OWN_CAUSE.CONTACT, c.other, c.flags | CONTACT_FLAG.STATE, c.pre.x, c.pre.y, c.pre.angle, c.pre.vx, c.pre.vy]);
    } else {
      if (rebuilt || window.some((e) => e.row[0] === OWN_CAUSE.REBUILD)) return 'rebuilt twice in a window';
      rebuilt = { from: [c.from[0], c.from[1]], to: [c.to[0], c.to[1]] };
      rows.push([OWN_CAUSE.REBUILD]);
    }
  }
  const env: OwnCauseEnv = {
    cellSize, restitution, self,
    other: (id) => { const c = contacts.get(id); return c ? { shape: c.otherShape, body: { ...c.pre } } : null; },
    rebuilt: () => rebuilt,
  };
  return { rows, seqs, env, contacts, rebuilt };
}

/** The worked rows as this window's events (a contact's other settled later: settleContacts) */
export function recordCauses(list: CauseEvent[], w: WorkedCauses, tick: number): void {
  for (let i = 0; i < w.rows.length; i++) {
    const r = w.rows[i];
    const c = r[0] === OWN_CAUSE.CONTACT ? w.contacts.get(r[1])! : null;
    list.push({ tick, seq: w.seqs[i], row: r, rebuild: r[0] === OWN_CAUSE.REBUILD && w.rebuilt ? w.rebuilt : undefined, contact: c ? { other: c.other, inStep: false, version: -1, cver: -1, rebuilds: c.otherRebuilds } : undefined });
  }
}

/** What a shadow is, for settling a contact with it: stepped on which tick, its body before that tick's causes, and those */
export interface ContactOther { stepped?: number; pre?: FlightBody; preTick?: number; body: FlightBody; version: number; cver: number; bodied?: ContactOther; worked?: WorkedCauses; workedTick?: number }

/**
 * This tick's contacts, once every shadow is stepped: is the other's replica, as the pass had it before the pair, what
 * a client stepping it in step has: its body before the tick's causes, then its causes before this pair, worked out
 * as the client works them (its shadow stepped this tick, in step, the very numbers; not one flown by its body, whose
 * replica on a client running it isn't this shadow). A client that has every such cause of the other's (ShipCauses
 * works a contact's other out to the pair, midOf) then needs no state
 */
export function settleContacts(events: readonly CauseEvent[], tick: number, shadow: (id: number) => ContactOther | undefined): void {
  for (let i = events.length - 1; i >= 0 && events[i].tick === tick; i--) {
    const c = events[i].contact;
    if (!c) continue;
    const o = shadow(c.other), r = events[i].row;
    c.version = o?.version ?? -1;
    c.cver = o?.cver ?? -1;
    const same = (b: FlightBody | null | undefined) => !!b && b.x === r[3] && b.y === r[4] && b.angle === r[5] && b.vx === r[6] && b.vy === r[7];
    const ok = !!o && o.stepped === tick && !o.bodied;
    c.inStep = ok && same(midOf(o!, tick, events[i].seq));
    // (Before all its causes that tick: what a pilot's own client reads of it, OwnTick, which has no other's causes in order)
    c.preStep = ok && same(o!.preTick === tick ? o!.pre : o!.body);
    // (Flown by its body: the shadow clients running it have)
    const ob = o?.bodied;
    c.bcver = ob?.cver ?? -1;
    c.bodyStep = !!ob && ob.stepped === tick && same(midOf(ob, tick, events[i].seq));
  }
}

/** A shadow's body on this tick just before the cause at `seq`: before the tick's causes, then the ones before it */
function midOf(o: ContactOther, tick: number, seq: number): FlightBody | null {
  if (o.preTick !== tick || o.workedTick !== tick || !o.worked) return o.body;
  const w = o.worked, body = { ...o.pre! }, rows: number[][] = [];
  for (let i = 0; i < w.rows.length; i++) if (w.seqs[i] < seq) rows.push(w.rows[i]);
  if (rows.length && !applyCauseRows(body, rows, w.env)) return null;
  return body;
}

/**
 * A cause row for a client: [ago, kind, ...]; a contact goes without the other's state where `stateless` says its
 * replica of the other is the pass's, and with OTHER_BEFORE where it had the other's structure from before a rebuild
 */
export function causeRow(e: CauseEvent, snapshotTick: number, stateless: boolean): number[] {
  const r = [snapshotTick - e.tick, ...e.row];
  const c = e.contact;
  if (c?.before) r[3] |= CONTACT_FLAG.OTHER_BEFORE;
  if (c && stateless && !c.before) { r[3] &= ~CONTACT_FLAG.STATE; r.length = 4; }
  return r;
}

interface PairRec { tick: number; seq: number; row: number[]; a?: number; b?: number; f?: number; sa?: number[]; sb?: number[] }

/**
 * One client's records of its caused ships' causes (CAPS.CAUSES, network/causes.ts), in tick then step order: a pull
 * or rebuild as it is, a contact once for both ships, each side's other's state only where `stateless` says its
 * replica of the other isn't the pass's, OTHER_BEFORE where `before` says it had the other as it was before a rebuild
 */
export function causeRecords(caused: readonly (readonly [number, readonly CauseEvent[]])[], snapshotTick: number, stateless: (e: CauseEvent) => boolean, before: (e: CauseEvent) => boolean): { rows: number[][]; stateless: number } {
  const recs: PairRec[] = [];
  const pairs = new Map<string, PairRec>();
  let free = 0;
  for (const [eid, events] of caused) {
    for (const e of events) {
      const r = e.row;
      if (r[0] !== OWN_CAUSE.CONTACT) { recs.push({ tick: e.tick, seq: e.seq, row: [snapshotTick - e.tick, r[0], eid, ...r.slice(1)] }); continue; }
      const other = r[1], fl = r[2], first = !(fl & CONTACT_FLAG.SECOND);
      const a = first ? eid : other, b = first ? other : eid, key = e.tick + ':' + a + ':' + b;
      let p = pairs.get(key);
      if (!p) {
        const selfPin = fl & CONTACT_FLAG.SELF_PINNED ? 1 : 0, otherPin = fl & CONTACT_FLAG.OTHER_PINNED ? 1 : 0;
        p = { tick: e.tick, seq: e.seq, row: [], a, b, f: (first ? selfPin : otherPin) * PAIR.A_PINNED + (first ? otherPin : selfPin) * PAIR.B_PINNED };
        pairs.set(key, p);
        recs.push(p);
      }
      p.seq = Math.min(p.seq, e.seq);
      // (This is its side: what it needs of the other)
      const keep = !stateless(e) || before(e);
      if (!keep) free++;
      if (first) { if (keep) { p.f! |= PAIR.B_STATE; p.sb = r.slice(3, 8); } if (before(e)) p.f! |= PAIR.B_BEFORE; }
      else { if (keep) { p.f! |= PAIR.A_STATE; p.sa = r.slice(3, 8); } if (before(e)) p.f! |= PAIR.A_BEFORE; }
    }
  }
  recs.sort((x, y) => x.tick - y.tick || x.seq - y.seq);
  const rows = recs.map((p) => (p.a === undefined ? p.row : [snapshotTick - p.tick, OWN_CAUSE.CONTACT, p.a, p.b!, p.f!, ...(p.sa ?? []), ...(p.sb ?? [])]));
  return { rows, stateless: free };
}
