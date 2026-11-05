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
 * A tick's pairs are found once (sim foundation 1C: common sim/c-contactCache.ts, the server's pass finds its own by the
 * same function) and kept with each ship's rows (memo). A ship stepped again from a tick (a late control row, a
 * decision, a cause, a keyframe: ShipReplicaSet tells it here) has the pairs from then on found again, and only the
 * ships that could have touched it then are stepped again with it: its live pairs (c-contactCache.ts contactLive) on
 * those ticks. When a tick's pairs are found again they are held against what its ships were stepped with: a ship
 * whose live pairs changed (it comes close to one re-stepped, or a snapshot left one of its pairs out) is stepped
 * again from there. What was found before and not yet found again waits in `was` until something reads the layer
 * (settle: every replica step asks first, and every snapshot's end). A window's ticks are final once its snapshot is in.
 */
import {
  CONTACT_BIG_BODY, CONTACT_FLAG, OWN_CAUSE, ReplicaMode, ContactPairCache, contactJumping, contactFxDue, contactLive, contactPairs, contactPieces, contactPair,
  isLeftOut, pairPlace, dhypot,
  type ContactEntry, type ContactPair, type CauseRow, type FlightBody, type OwnShape, type ReplicaRewinds, type ServerSnapshotMessage, type ShipDerived,
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
  /** The ships in the pass (by id) */
  ids: readonly number[];
  /** Its pairs, in the pass's order (the cache's) */
  pairs: readonly ContactPair[];
  /** Each ship's rows for them, by id */
  rows: Map<number, CauseRow[]>;
  /** Each ship's live partners (pairs that could have touched), by id */
  live: Map<number, number[]>;
}

const EMPTY: Memo = { ids: [], pairs: [], rows: new Map(), live: new Map() };
const NO_IDS: readonly number[] = [];
/** Ticks of windows kept */
const KEEP_TICKS = 600;
/** Ticks of pairs kept (a ship stepped again from further back than this has them worked out afresh) */
const MEMO_TICKS = KEEP_TICKS;

export class ContactWorld implements ReplicaRewinds {
  on = false;
  /** The snapshots' windows: their ticks and the ships each leaves out */
  private windows: { from: number; to: number; out: Set<number> }[] = [];
  private readonly memo = new Map<number, Memo>();
  /** Ticks found before and dropped since (a ship stepped again): what their ships were stepped with, until found again */
  private readonly was = new Map<number, Memo>();
  /** Each tick's pairs, found once (common sim/c-contactCache.ts) */
  readonly cache = new ContactPairCache((t) => this.find(t), MEMO_TICKS);
  /** Ticks up to this are final (their snapshot is in) */
  private final = -Infinity;
  /** Nothing is worked out here up to this tick (switched on after it: the server told those) */
  private since = -Infinity;
  private snapTick = -Infinity;
  private readonly busy = new Set<number>();
  private settling = false;
  /** A re-step this world asked for (a ship's pairs changed, not its own step): the tick's pairs stand */
  private inner = false;
  /** Ships being stepped again in the cascade now running, from which tick (each once) */
  private readonly walking = new Map<number, number>();
  private depth = 0;
  /** Each pair's last sparks (lower id × 2^22 + higher) */
  private readonly fxLast = new Map<number, number>();
  /**
   * ticks: ticks whose memo was worked out; pairs: pairs among them; restepped: ships stepped again because their
   * pairs (or a partner) changed; kept: ticks found again with no ship's live pairs changed
   */
  readonly stats = { ticks: 0, pairs: 0, touched: 0, fx: 0, cascades: 0, restepped: 0, kept: 0, reentry: 0 };

  constructor(private readonly host: ContactWorldHost) {}

  /** Switched on or off (netCaps): every ship is stepped again (what it took from rows it now takes itself, or back) */
  setOn(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    this.memo.clear();
    this.was.clear();
    this.queued.clear();
    this.bodies.clear();
    this.cache.clear();
    this.windows = [];
    this.since = on ? this.snapTick : -Infinity;
    this.final = this.since;
    const reps = this.host.reps;
    reps.setRewinds(on ? this : null);
    for (const id of [...reps.ids()]) reps.rewind(id, this.since + 1);
  }

  clear(): void {
    this.memo.clear();
    this.was.clear();
    this.queued.clear();
    this.bodies.clear();
    this.cache.clear();
    this.windows = [];
    this.fxLast.clear();
  }

  /**
   * A snapshot arriving, before anything of it goes in (its keyframes included): its window's ships left out (keyframed,
   * gone, out of view, or told to), and what was worked out past the last snapshot found again
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
    // (Found again with the window's ships left out, and held against what was found: settle)
    this.stale(prev + 1);
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
    this.settle();
    const from = this.final + 1, self = this.host.self();
    for (let t = from; t <= tick; t++) {
      const m = this.pairsAt(t);
      for (const [a, b] of m.pairs) {
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
    this.settle();
    if (this.fxLast.size > 256) for (const [k, t] of this.fxLast) if (t < tick - KEEP_TICKS) this.fxLast.delete(k);
    if (this.memo.size > MEMO_TICKS) for (const t of this.memo.keys()) if (t < tick - MEMO_TICKS) this.memo.delete(t);
    return { touched, fx, own };
  }

  /** Did ship `id` take part in tick t's pairs found here (it has causes then)? */
  involved(id: number, t: number): boolean {
    return this.on && this.pairsAt(t).rows.has(id);
  }

  /** Tick t's pass as found here, if it has been (tests, the dev overlay): its ships and pairs */
  passAt(t: number): { ids: readonly number[]; pairs: readonly ContactPair[] } | undefined {
    return this.memo.get(t);
  }

  /** Ship `id`'s rows for tick t's pairs found here, each with its place in the pass (undefined: none) */
  rowsFor(id: number, t: number): CauseRow[] | undefined {
    return this.on ? this.pairsAt(t).rows.get(id) : undefined;
  }

  // ---- ReplicaRewinds ----

  rewound(id: number, t: number): void {
    if (!this.on) return;
    this.host.forget?.(t);
    const from = Math.max(t, this.final + 1);
    // (Already being stepped again from here or before in this cascade)
    const seen = this.walking.get(id);
    if (seen !== undefined && seen <= from) return;
    this.walking.set(id, from);
    this.depth++;
    try {
      // Its own step changed from t (its controls, a keyframe): the pairs from t on read it. Stepped again because its
      // pairs changed (inner): its step at t stands, its state after it doesn't
      this.stale(this.inner ? from + 1 : from);
      // The ships it could have touched from then on read it as it was: stepped again too
      this.restepPartners(id, from);
    } finally {
      if (--this.depth === 0) this.walking.clear();
    }
  }

  /**
   * Work out what's waiting: ships to step again that were asked for mid-step, and ticks to find again (ShipReplicaSet
   * asks before it steps anything, when it isn't part way through a step; every snapshot's end)
   */
  settle(): void {
    if (this.settling || !this.on || this.host.reps.busy) return;
    this.settling = true;
    try {
      for (let guard = 0; (this.was.size || this.queued.size) && guard < 64; guard++) {
        this.flush();
        while (this.was.size) {
          let t = Infinity;
          for (const k of this.was.keys()) if (k < t) t = k;
          // (Found again: held against `was` there, pairsAt)
          if (this.busy.has(t)) break;
          this.pairsAt(t);
          this.was.delete(t);
          this.flush();
        }
      }
    } finally {
      this.settling = false;
    }
  }

  /** Is something waiting (ShipReplicaSet asks before a step) */
  get unsettled(): boolean {
    return this.was.size > 0 || this.queued.size > 0;
  }

  /** Ships to step again, asked for while the replica set was part way through a step: by the first tick */
  private readonly queued = new Map<number, number>();

  private flush(): void {
    if (!this.queued.size) return;
    const q = [...this.queued].sort((a, b) => a[1] - b[1]);
    this.queued.clear();
    for (const [id, t] of q) this.restep(id, t);
  }

  /** Pairs from tick `from` on are found again (what their ships were stepped with is kept, to hold them against) */
  private stale(from: number): void {
    from = Math.max(from, this.final + 1, this.since + 1);
    let any = false;
    for (const [k, m] of this.memo) {
      if (k < from) continue;
      // (Found again already and dropped again: the oldest is what its ships were stepped with)
      if (!this.was.has(k)) this.was.set(k, m);
      this.memo.delete(k);
      any = true;
    }
    if (any) { this.cache.dropFrom(from); this.stats.cascades++; }
    this.host.forget?.(from);
  }

  /** Ship `id`'s live partners from tick `from` on, stepped again from the first tick each could have touched it */
  private restepPartners(id: number, from: number): void {
    const again = new Map<number, number>();
    const scan = (k: number, m: Memo) => {
      if (k < from) return;
      for (const p of m.live.get(id) ?? NO_IDS) { const was = again.get(p); if (was === undefined || k < was) again.set(p, k); }
    };
    for (const [k, m] of this.was) scan(k, m);
    for (const [k, m] of this.memo) scan(k, m);
    for (const [p, k] of again) this.restep(p, k);
  }

  /** A ship's pairs changed on tick t (a partner stepped again, or its pairs found again differ): stepped again after t's step */
  private restep(id: number, t: number): void {
    const reps = this.host.reps;
    // (Not stepped to t yet: it reads its pairs when it gets there)
    if ((reps.lastOf(id) ?? -Infinity) < t) return;
    const seen = this.walking.get(id);
    if (seen !== undefined && seen <= t) return;
    // (Part way through a step (this was found from inside one): stepped again once it's done, settle)
    if (reps.busy) { const q = this.queued.get(id); if (q === undefined || t < q) this.queued.set(id, t); return; }
    this.stats.restepped++;
    const was = this.inner;
    this.inner = true;
    this.depth++;
    try {
      reps.rewind(id, t);
    } finally {
      this.inner = was;
      if (--this.depth === 0) this.walking.clear();
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

  /** The bodies in tick t's pass: held in step, by id (the cache's finder) */
  private entriesAt(t: number): ContactEntry[] {
    const { reps, store, tuning } = this.host;
    const self = this.host.self();
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
    return entries;
  }

  /** The cache's finder: tick t's pairs (its bodies kept for the memo's live pairs) */
  private find(t: number): ContactPair[] {
    const entries = this.entriesAt(t);
    this.bodies.set(t, entries);
    return contactPairs(entries);
  }

  /** The bodies each tick's pairs were just found from (find, for pairsAt) */
  private readonly bodies = new Map<number, ContactEntry[]>();

  /** Tick t's pairs among the ships it holds in step, worked out once */
  private pairsAt(t: number): Memo {
    const have = this.memo.get(t);
    if (have) return have;
    if (t <= this.since) return EMPTY;
    if (this.busy.has(t)) { this.stats.reentry++; return EMPTY; }
    this.busy.add(t);
    try {
      const pairs = this.cache.pairs(t);
      // (Found just now: their bodies; read from the cache, found earlier: their bodies again, for the live pairs)
      const byId = new Map<number, ContactEntry>();
      const found = this.bodies.get(t);
      this.bodies.delete(t);
      for (const e of found ?? (pairs.length ? this.entriesAt(t) : [])) byId.set(e.id, e);
      const m: Memo = { ids: [...byId.keys()], pairs, rows: new Map(), live: new Map() };
      const put = (id: number, row: number[], place: number) => {
        const l = m.rows.get(id);
        if (l) l.push({ seq: place, row }); else m.rows.set(id, [{ seq: place, row }]);
      };
      const link = (a: number, b: number) => {
        const l = m.live.get(a);
        if (l) l.push(b); else m.live.set(a, [b]);
      };
      for (const [a, b] of pairs) {
        const place = pairPlace(a, b);
        put(a, [OWN_CAUSE.CONTACT, b, CONTACT_FLAG.CHECK], place);
        put(b, [OWN_CAUSE.CONTACT, a, CONTACT_FLAG.CHECK | CONTACT_FLAG.SECOND], place);
        const ea = byId.get(a), eb = byId.get(b);
        if (!ea || !eb || contactLive(ea, eb)) { link(a, b); link(b, a); }
      }
      this.memo.set(t, m);
      this.stats.ticks++;
      this.stats.pairs += pairs.length;
      // Held against what its ships were stepped with: one whose live pairs changed is stepped again after this tick's step
      const old = this.was.get(t);
      if (old) {
        this.was.delete(t);
        this.compare(t, old, m);
      }
      return m;
    } finally {
      this.busy.delete(t);
    }
  }

  /** Ships whose live pairs on tick t differ between two findings: stepped again after t's step */
  private compare(t: number, old: Memo, now: Memo): void {
    const changed = new Set<number>();
    const diff = (x: Memo, y: Memo) => {
      for (const [id, ps] of x.live) {
        const other = y.live.get(id);
        if (!other) { changed.add(id); for (const p of ps) changed.add(p); continue; }
        for (const p of ps) if (!other.includes(p)) { changed.add(id); changed.add(p); }
      }
    };
    diff(old, now);
    diff(now, old);
    if (!changed.size) { this.stats.kept++; return; }
    for (const id of changed) this.restep(id, t);
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
