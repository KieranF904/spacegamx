/**
 * Contact pairs found on this client's tick layer (CAPS.CONTACTS; common network/causes.ts contactsFor). The server's
 * contact pass (bridge/flight.ts resolveContacts) takes, each tick, every candidate pair of ships in a system in order
 * of their ids (common ships/contactPass.ts). For the ships this client holds in step, it takes the same pairs from its
 * replicas, as they were after that tick's step: a pair of two such ships comes as no record at all. Each ship's pairs
 * go in among the causes it was told (a pair with a ship it doesn't hold, or holds out of step), in the pass's order
 * (CAUSE_PLACE), and are worked out by the very function the told ones are (applyOwnCauses: OwnTick for its own ship,
 * ShipCauses for the others).
 *
 * Which ships: those it holds from before the snapshot's window (none keyframed in it), ships not debris, not docked,
 * not mid-jump, with their structure for that tick; less those the snapshot names as gone, out of view, or left out (a
 * CONTACT record naming one ship twice: pinned, rebuilt where it lacks the structure, pulled after the pass). The server
 * works out the same set for it (server net/causes/contactsFor.ts) and tells it the rest.
 *
 * A tick's pairs are worked out once (memo) from every such ship's step; a ship stepped again from a tick (a late
 * control row, a decision, a cause, a keyframe: ShipReplicaSet tells it here) has the pairs from then on worked out
 * again, and every ship that took part stepped again with them. A window's ticks are final once its snapshot is in.
 */
import {
  CONTACT_BIG_BODY, CONTACT_FLAG, OWN_CAUSE, ReplicaMode, contactCandidates, contactJumping, contactFxDue, contactPieces, contactPair,
  isLeftOut, pairPlace, dhypot,
  type ContactEntry, type CauseRow, type FlightBody, type OwnShape, type ReplicaRewinds, type ServerSnapshotMessage, type ShipDerived,
  type ShipReplicaSet, type ShipTuning,
} from '@space-game/common';
import type { StructSource } from '../ShipStore.js';

export interface ContactWorldHost {
  reps: ShipReplicaSet;
  store: StructSource;
  /** Its own ship's id */
  self(): number;
  /** Is its own ship stepped on its tick layer (CAPS.OWN_SIM)? */
  ownOn(): boolean;
  /** The structure a ship flew tick t with (its own: OwnTick.derived; others: ShipCauses.derived, else its current) */
  derivedAt(id: number, t: number): ShipDerived | null | undefined;
  /** A ship on tick t just before the cause at `place` (the pass had it so: OwnTick.midOf, ShipCauses.midOf) */
  mid(id: number, t: number, place: number): FlightBody | null;
  /** Ships part way through their causes kept from tick t on go (a ship stepped again from there: MidCursors.forget) */
  forget?(from: number): void;
  tuning: ShipTuning;
}

/** A contact's sparks, as the server's `contact` message has them */
export interface ContactFx { x: number; y: number; nx: number; ny: number; speed: number }

interface Memo {
  /** The ships it took that tick */
  ids: number[];
  /** Its pairs (ids, lower first), in the pass's order */
  pairs: number[];
  /** Each ship's rows for them, by id */
  rows: Map<number, CauseRow[]>;
}

const EMPTY: Memo = { ids: [], pairs: [], rows: new Map() };
/** Ticks of windows kept */
const KEEP_TICKS = 600;
/** Ticks of pairs kept (a ship stepped again from further back than this has them worked out afresh) */
const MEMO_TICKS = KEEP_TICKS;

export class ContactWorld implements ReplicaRewinds {
  on = false;
  /** The snapshots' windows: their ticks and the ships each leaves out */
  private windows: { from: number; to: number; out: Set<number> }[] = [];
  private readonly memo = new Map<number, Memo>();
  /** The latest tick with pairs worked out (a ship stepped again after it changes none) */
  private memoMax = -Infinity;
  /** Ticks up to this are final (their snapshot is in) */
  private final = -Infinity;
  /** Nothing is worked out here up to this tick (switched on after it: the server told those) */
  private since = -Infinity;
  private snapTick = -Infinity;
  private cascading = false;
  private readonly busy = new Set<number>();
  /** Each pair's last sparks (lower id × 2^22 + higher) */
  private readonly fxLast = new Map<number, number>();
  readonly stats = { ticks: 0, pairs: 0, touched: 0, fx: 0, cascades: 0, reentry: 0 };

  constructor(private readonly host: ContactWorldHost) {}

  /** Switched on or off (netCaps): every ship is stepped again (what it took from rows it now takes itself, or back) */
  setOn(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    this.memo.clear();
    this.memoMax = -Infinity;
    this.windows = [];
    this.since = on ? this.snapTick : -Infinity;
    this.final = this.since;
    const reps = this.host.reps;
    reps.setRewinds(on ? this : null);
    for (const id of [...reps.ids()]) reps.rewind(id, this.since + 1);
  }

  clear(): void {
    this.memo.clear();
    this.memoMax = -Infinity;
    this.windows = [];
    this.fxLast.clear();
  }

  /**
   * A snapshot arriving, before anything of it goes in (its keyframes included): its window's ships left out (keyframed,
   * gone, out of view, or told to), and what was worked out past the last snapshot worked out again
   */
  beginSnapshot(m: ServerSnapshotMessage): void {
    const prev = this.snapTick;
    this.snapTick = m.tick;
    if (!this.on) return;
    const out = new Set<number>();
    for (const k of m.ships ?? []) out.add(k[0]);
    for (const id of m.removed ?? []) out.add(id);
    for (const id of m.out ?? []) out.add(id);
    for (const r of m.causes ?? []) if (isLeftOut(r)) out.add(r[2]);
    this.windows.push({ from: prev + 1, to: m.tick, out });
    while (this.windows.length && this.windows[0].to < m.tick - KEEP_TICKS) this.windows.shift();
    this.final = Math.max(this.final, prev);
    this.invalidate(prev + 1, -1);
  }

  /**
   * The snapshot fully in (keyframes, causes, decisions, removals): its window stepped through, its ticks final. What
   * it worked out there: each pair that touched (the ships whose hits that window are told, as for a told cause:
   * SelfHits.onCaused) and their sparks
   */
  endSnapshot(tick: number): { touched: Set<number>; fx: ContactFx[]; own: boolean } {
    const touched = new Set<number>(), fx: ContactFx[] = [];
    let own = false;
    if (!this.on) return { touched, fx, own };
    const from = this.final + 1, self = this.host.self();
    for (let t = from; t <= tick; t++) {
      const m = this.pairsAt(t);
      for (let i = 0; i < m.pairs.length; i += 2) {
        const a = m.pairs[i], b = m.pairs[i + 1];
        const res = this.resolve(a, b, t);
        if (!res) continue;
        touched.add(a); touched.add(b);
        if (a === self || b === self) own = true;
        this.stats.touched++;
        if (res.closing <= 0) continue;
        const key = a * 4194304 + b;
        if (!contactFxDue(res.closing, this.fxLast.get(key), t, this.host.tuning)) continue;
        this.fxLast.set(key, t);
        const r = (v: number) => Math.round(v * 100) / 100;
        fx.push({ x: r(res.at[0]), y: r(res.at[1]), nx: r(res.nx), ny: r(res.ny), speed: r(res.closing) });
        this.stats.fx++;
      }
    }
    this.final = Math.max(this.final, tick);
    if (this.fxLast.size > 256) for (const [k, t] of this.fxLast) if (t < tick - KEEP_TICKS) this.fxLast.delete(k);
    if (this.memo.size > MEMO_TICKS) for (const t of this.memo.keys()) if (t < tick - MEMO_TICKS) this.memo.delete(t);
    return { touched, fx, own };
  }

  /** Did ship `id` take part in tick t's pairs found here (it has causes then)? */
  involved(id: number, t: number): boolean {
    return this.on && this.pairsAt(t).rows.has(id);
  }

  /** Ship `id`'s rows for tick t's pairs found here, each with its place in the pass (undefined: none) */
  rowsFor(id: number, t: number): CauseRow[] | undefined {
    return this.on ? this.pairsAt(t).rows.get(id) : undefined;
  }

  // ---- ReplicaRewinds ----

  rewound(id: number, t: number): void {
    if (!this.on) return;
    this.host.forget?.(t);
    if (this.cascading) return;
    this.invalidate(Math.max(t, this.final + 1), id);
  }

  /** Pairs worked out from tick `from` on go, and every ship that took part is stepped again from there */
  private invalidate(from: number, except: number): void {
    this.host.forget?.(from);
    if (from > this.memoMax) return;
    this.memoMax = from - 1;
    const again = new Set<number>();
    for (const [k, m] of this.memo) {
      if (k < from) continue;
      for (const id of m.ids) again.add(id);
      this.memo.delete(k);
    }
    if (!again.size) return;
    this.stats.cascades++;
    this.cascading = true;
    try {
      for (const id of again) if (id !== except) this.host.reps.rewind(id, from);
    } finally {
      this.cascading = false;
    }
  }

  /** Is ship `id` left out of tick t's pass here (keyframed in that window, gone, out of view, or told to)? */
  private leftOut(id: number, t: number): boolean {
    for (let i = this.windows.length - 1; i >= 0; i--) {
      const w = this.windows[i];
      if (t > w.to) return false;
      if (t >= w.from) return w.out.has(id);
    }
    return false;
  }

  /** Tick t's pairs among the ships it holds in step, worked out once */
  private pairsAt(t: number): Memo {
    const have = this.memo.get(t);
    if (have) return have;
    if (t <= this.since) return EMPTY;
    if (this.busy.has(t)) { this.stats.reentry++; return EMPTY; }
    const { reps, store, tuning } = this.host;
    const self = this.host.self();
    this.busy.add(t);
    try {
      // (Who: held from before this window, ships, not docked or debris, their structure that tick known)
      const ids: number[] = [];
      for (const id of reps.ids()) {
        const kf = reps.kfOf(id), mode = reps.modeOf(id);
        if (kf === undefined || kf >= t || mode === ReplicaMode.Docked || mode === ReplicaMode.Drift) continue;
        if (id === self ? !this.host.ownOn() : store.get(id)?.kind !== 'ship') continue;
        if (!store.get(id)?.derived || this.leftOut(id, t)) continue;
        ids.push(id);
      }
      ids.sort((a, b) => a - b);
      // (Every one stepped to the tick before, a tick at a time across them all: none reads another more than a tick on)
      let low = t - 1;
      for (const id of ids) low = Math.min(low, reps.lastOf(id) ?? t - 1);
      for (let k = Math.max(low + 1, t - 600); k < t; k++) for (const id of ids) if ((reps.lastOf(id) ?? k) < k) reps.at(id, k);
      const entries: ContactEntry[] = [];
      for (const id of ids) {
        const d = this.host.derivedAt(id, t);
        if (!d || !(d.mass > 0)) continue;
        const pre = reps.preAt(id, t);
        if (!pre || contactJumping(pre.jump, tuning)) continue;
        entries.push({ id, x: pre.x, y: pre.y, r: d.radius });
      }
      const found = contactCandidates(entries);
      const m: Memo = { ids: entries.map((e) => e.id), pairs: [], rows: new Map() };
      const put = (id: number, row: number[], place: number) => {
        const l = m.rows.get(id);
        if (l) l.push({ seq: place, row }); else m.rows.set(id, [{ seq: place, row }]);
      };
      for (let i = 0; i < found.length; i += 2) {
        const a = entries[found[i]].id, b = entries[found[i + 1]].id, place = pairPlace(a, b);
        m.pairs.push(a, b);
        put(a, [OWN_CAUSE.CONTACT, b, CONTACT_FLAG.CHECK], place);
        put(b, [OWN_CAUSE.CONTACT, a, CONTACT_FLAG.CHECK | CONTACT_FLAG.SECOND], place);
      }
      this.memo.set(t, m);
      if (t > this.memoMax) this.memoMax = t;
      this.stats.ticks++;
      this.stats.pairs += m.pairs.length / 2;
      return m;
    } finally {
      this.busy.delete(t);
    }
  }

  /** A pair on tick t as the pass took it: from both ships just before it (null: they didn't touch) */
  private resolve(a: number, b: number, t: number): { closing: number; nx: number; ny: number; at: [number, number] } | null {
    const { store, tuning } = this.host, place = pairPlace(a, b);
    const ba = this.host.mid(a, t, place), bb = this.host.mid(b, t, place);
    const sa = store.get(a), sb = store.get(b), da = this.host.derivedAt(a, t), db = this.host.derivedAt(b, t);
    if (!ba || !bb || !sa || !sb || !da || !db) return null;
    if (dhypot(bb.x - ba.x, bb.y - ba.y) > da.radius + db.radius) return null;
    const shape = (s: typeof sa, d: ShipDerived): OwnShape => ({ geom: store.geometry(s), alive: d.alive, com: d.com, mass: d.mass, radius: d.radius, big: s.blueprint.parts.length > CONTACT_BIG_BODY });
    const A = shape(sa, da), B = shape(sb, db), cs = tuning.cellSize;
    const pa = contactPieces(A.geom, A.alive, A.com, cs, ba, A.big ? { x: bb.x, y: bb.y, r: B.radius } : undefined);
    const pb = contactPieces(B.geom, B.alive, B.com, cs, bb, B.big ? { x: ba.x, y: ba.y, r: A.radius } : undefined);
    const res = contactPair(pa, pb, { ...ba }, { ...bb }, 1 / A.mass, 1 / B.mass, tuning.collision?.restitution ?? 0.3);
    return res ? { closing: res.closing, nx: res.nx, ny: res.ny, at: [res.at[0], res.at[1]] } : null;
  }
}
