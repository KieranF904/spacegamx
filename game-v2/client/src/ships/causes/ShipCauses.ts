/**
 * Other ships' causes on this client's tick-aligned layer (CAPS.CAUSES; common network/causes.ts). What moved a ship
 * it holds besides its controls comes as that cause at its tick (a snapshot's `causes` rows): after the ship's step on
 * that tick the replica set hands its body here (ShipReplicaSet.setCauses), and the cause is worked out with the very
 * function the server's shadow runs (applyOwnCauses), so the replica stays the server's ship and no keyframe comes.
 *
 *   structure  a rebuild's tick splits the structure it flew until then (the one it had before this frame's shipSync,
 *              beforeSync) from the new one
 *   contacts   one record a pair, each side it holds pushed: the other body's pose as the record gives it, or,
 *              without the state, this layer's replica of it on that tick before its own causes (ShipReplicaSet.preAt);
 *              its structure as it was then (OTHER_BEFORE: from before this frame's shipSync)
 *
 * The own ship's causes are OwnTick's (ships/own/OwnTick.ts); it is never one of these.
 *
 * Finding contact pairs itself (CAPS.CONTACTS: ContactWorld), a ship's pairs with ships it holds in step come as no
 * record; they go in among its told causes by their place in the pass (CAUSE_PLACE: rowsAt), and are worked out alike.
 */
import {
  applyOwnCauses, applyCauseRows, cargoBefore, causesByShip, replicaHash, replicasByte, placeRows, pairPlace, type CauseRow, CONTACT_BIG_BODY, OWN_CAUSE, CONTACT_FLAG,
  type ReplicaCauses, type ShipReplicaSet, type ShipDerived, type ShipState, type ShipTuning, type FlightBody,
  type OwnCauseEnv, type OwnShape, type PlacedGeom, type ServerSnapshotMessage, type Vec2,
} from '@space-game/common';
import type { StructSource } from '../ShipStore.js';
import type { ContactWorld } from './ContactWorld.js';
import { MidCursors } from './MidCursors.js';

export interface ShipCausesHost {
  store: StructSource;
  reps: ShipReplicaSet;
  /** Its own ship's id */
  self(): number;
  /** The structure its own ship flew tick t with (OwnTick.derived: a contact with it reads it) */
  ownDerived?(t: number): ShipDerived | null | undefined;
  /** Its own ship on tick t as the contact pass had it when it touched `other` (OwnTick.midOf) */
  ownMid?(t: number, other: number): FlightBody | null;
  tuning: ShipTuning;
  /** The contact pairs it finds itself (CAPS.CONTACTS), when it does */
  contacts?(): ContactWorld | null;
}

/** Ticks of causes kept (a window is never this far back) */
const KEEP_TICKS = 600;

export class ShipCauses implements ReplicaCauses {
  /** Causes by ship, then tick ([kind, ...], with their place among the tick's) */
  private readonly rows = new Map<number, Map<number, CauseRow[]>>();
  /** Ships' structures before their shipSync this frame */
  private readonly before = new Map<number, ShipDerived>();
  /** A rebuild: the structure flown up to (and on) its tick, and the centres of mass either side, by ship */
  private readonly until = new Map<number, { derived: ShipDerived; tick: number; from: Vec2; to: Vec2 }>();
  /** A contact's other as it was before its shipSync (OTHER_BEFORE), by tick and id */
  private readonly touched = new Map<string, ShipDerived>();
  /** A contact's other as the snapshot found it, by tick and id (it may be gone by the time the replica is stepped: removed in that very snapshot) */
  private readonly kept = new Map<string, ShipState>();
  readonly stats = { rows: 0, failed: 0 };
  /** Each ship part way through a tick's causes, worked out once (a crowd's pairs read each other) */
  readonly cursors = new MidCursors();

  /** Finding contact pairs itself (ContactWorld) */
  private finds(): boolean {
    return !!this.host.contacts?.();
  }

  /** Where ship `id`'s causes on tick t start (its step's body), for the cursors */
  private start(id: number, t: number): { pre: FlightBody; rows: CauseRow[]; env: OwnCauseEnv } | null {
    const pre = this.host.reps.preAt(id, t);
    if (!pre) return null;
    const rows = this.rowsAt(id, t) ?? [];
    return { pre, rows, env: this.env(id, t, rows) };
  }
  /** The check's byte for each snapshot taken in (by its tick): every ship held then (noteHeld) */
  private readonly held = new Map<number, number>();

  /** The replica set asks here after each step */
  constructor(private readonly host: ShipCausesHost) {
    host.reps.setCauses(this);
  }

  /** A ship's structure is about to change (shipSync): the one it flew until now */
  beforeSync(id: number): void {
    if (id === this.host.self()) return;
    const d = this.host.store.get(id)?.derived;
    if (d) this.before.set(id, d);
  }

  /**
   * A snapshot, after the replicas took its keyframes: its causes, each ship's rebuild split, and each such ship stepped
   * again from its earliest; a ship keyframed now forgets the ones before (its keyframe is how that tick ended)
   */
  onSnapshot(m: ServerSnapshotMessage): void {
    const { reps, store } = this.host;
    const keyed = new Set<number>();
    for (const k of m.ships ?? []) { this.drop(k[0], m.tick); keyed.add(k[0]); }
    // (Each record to the ships it names that this layer steps: held, not its own, not keyframed now)
    const self = this.host.self();
    for (const [id, ticks] of causesByShip(m.causes, m.tick, (id) => id !== self && !keyed.has(id) && reps.has(id))) {
      let mine = this.rows.get(id);
      if (!mine) this.rows.set(id, (mine = new Map()));
      let earliest = Infinity;
      for (const [t, rows] of ticks) {
        // (Finding contact pairs itself: each row's place in the pass, so the ones it finds go in between, CAUSE_PLACE)
        if (this.host.contacts?.()) { const pl = placeRows(id, rows.map((r) => r.row)); rows.forEach((r, i) => { r.seq = pl[i]; }); }
        mine.set(t, rows);
        earliest = Math.min(earliest, t);
        this.stats.rows += rows.length;
        for (const r of rows) {
          if (r.row[0] === OWN_CAUSE.CONTACT) {
            const os = store.get(r.row[1]);
            if (os) this.kept.set(t + ':' + r.row[1], os);
            const d = r.row[2] & CONTACT_FLAG.OTHER_BEFORE ? this.before.get(r.row[1]) : undefined;
            if (d) this.touched.set(t + ':' + r.row[1], d);
          }
          if (r.row[0] === OWN_CAUSE.REBUILD) {
            const now = store.get(id)?.derived, was = this.before.get(id) ?? now;
            if (was && now) this.until.set(id, { derived: was, tick: t, from: was.com, to: now.com });
          }
        }
      }
      reps.rewind(id, earliest);
    }
    this.before.clear();
    const old = m.tick - KEEP_TICKS;
    for (const [id, ticks] of this.rows) {
      for (const t of ticks.keys()) if (t < old) ticks.delete(t);
      if (!ticks.size || !reps.has(id)) this.rows.delete(id);
    }
    for (const [id, u] of this.until) if (u.tick < old || !reps.has(id)) this.until.delete(id);
    for (const m of [this.touched, this.kept] as Map<string, unknown>[]) if (m.size > 64) for (const k of [...m.keys()]) if (Number(k.split(':')[0]) < old) m.delete(k);
  }

  /**
   * A snapshot fully taken in (keyframes, causes, removals): the check's byte for it, every ship held (not its own, no
   * debris, none docked), its state at the snapshot's tick (network/causes.ts replicasByte)
   */
  noteHeld(tick: number): void {
    const { reps, store } = this.host, self = this.host.self();
    let sum = 0;
    for (const id of reps.ids()) {
      if (id === self || store.get(id)?.kind !== 'ship' || reps.isDocked(id)) continue;
      const st = reps.at(id, tick);
      if (st) sum = (sum + replicaHash(id, st.body)) >>> 0;
    }
    this.held.set(tick, replicasByte(sum));
    if (this.held.size > 64) for (const t of [...this.held.keys()]) if (t < tick - KEEP_TICKS) this.held.delete(t);
  }

  /** The check's byte for a snapshot (its own check adds it: OwnTick.takeCheck); undefined: not noted */
  heldByte(tick: number): number | undefined {
    return this.held.get(tick);
  }

  /** A ship gone (removed, out of view): its causes with it */
  remove(id: number): void {
    this.rows.delete(id);
    this.until.delete(id);
  }

  clear(): void {
    this.cursors.clear();
    this.rows.clear();
    this.until.clear();
    this.touched.clear();
    this.kept.clear();
    this.before.clear();
  }

  /** (A keyframe at tick k: its causes up to k are in it) */
  private drop(id: number, k: number): void {
    const ticks = this.rows.get(id);
    if (ticks) for (const t of ticks.keys()) if (t <= k) ticks.delete(t);
    const u = this.until.get(id);
    if (u && u.tick <= k) this.until.delete(id);
  }

  // ---- ReplicaCauses (ShipReplicaSet asks these as it steps another ship) ----

  derived(id: number, t: number): ShipDerived | undefined {
    // (Each structure kept by its tick, CAPS.STRUCTS: the one it flew then)
    const kept = this.host.store.derivedAt?.(id, t);
    if (kept) return kept;
    const u = this.until.get(id);
    return u && t <= u.tick ? u.derived : undefined;
  }

  has(id: number, t: number): boolean {
    return !!this.rows.get(id)?.has(t) || !!this.host.contacts?.()?.involved(id, t);
  }

  /**
   * A ship's causes on tick t, in the order the server's step had them: those told, and (CAPS.CONTACTS) the pairs found
   * here, each by its place in the pass (a pair told isn't one found: told wins)
   */
  rowsAt(id: number, t: number): CauseRow[] | undefined {
    const told = this.rows.get(id)?.get(t);
    const found = this.host.contacts?.()?.rowsFor(id, t);
    if (!found) return told;
    if (!told) return found;
    const have = new Set<number>();
    for (const r of told) if (r.row[0] === OWN_CAUSE.CONTACT) have.add(pairPlace(id, r.row[1]));
    const all = [...told, ...found.filter((r) => !have.has(r.seq))];
    all.sort((a, b) => a.seq - b.seq);
    return all;
  }

  preStep(id: number, t: number, body: FlightBody): void {
    const rows = this.rows.get(id)?.get(t);
    if (rows) cargoBefore(body, rows.map((r) => r.row));
  }

  after(id: number, t: number, body: FlightBody): void {
    if (this.finds()) { if (!this.cursors.after(id, t, body, () => this.start(id, t))) this.stats.failed++; return; }
    const rows = this.rowsAt(id, t);
    if (rows && !applyOwnCauses(body, rows.map((r) => r.row), this.env(id, t, rows))) this.stats.failed++;
  }

  /**
   * A ship's body on tick t as the server rebuilt it (after that tick's contacts, before its recentring: where a split's
   * pieces start, DebrisSplits); null: no causes of it that tick here (its replica's state is it)
   */
  beforeRebuild(id: number, t: number): FlightBody | null {
    const rows = this.rowsAt(id, t);
    if (!rows) return null;
    // (No rebuild among them, a death's say: after them all, unrounded)
    const row = rows.find((r) => r.row[0] === OWN_CAUSE.REBUILD);
    return this.midOf(id, t, row ? row.seq : Infinity);
  }

  /**
   * A ship's body on tick t just before the cause at `seq` (the contact pass had it so): before the tick's causes, then
   * its causes before that one, unrounded. Its own ship's: before its causes (the server sends the state otherwise)
   */
  midOf(id: number, t: number, seq: number): FlightBody | null {
    if (this.finds() && id !== this.host.self()) return this.cursors.mid(id, t, seq, () => this.start(id, t));
    const pre = this.host.reps.preAt(id, t);
    const rows = id === this.host.self() ? undefined : this.rowsAt(id, t);
    const earlier = rows?.filter((r) => r.seq < seq);
    if (!pre || !earlier?.length) return pre;
    const body = { ...pre };
    if (!applyCauseRows(body, earlier.map((r) => r.row), this.env(id, t, earlier))) this.stats.failed++;
    return body;
  }

  private env(id: number, t: number, rows: readonly CauseRow[]): OwnCauseEnv {
    const { store, reps, tuning } = this.host;
    const ship = store.get(id), d = this.derived(id, t) ?? ship?.derived;
    const u = this.until.get(id);
    return {
      cellSize: tuning.cellSize,
      restitution: tuning.collision?.restitution ?? 0.3,
      self: ship && d ? shapeOf(ship, d, store.geometry(ship)) : null,
      other: (o) => {
        const os = store.get(o) ?? this.kept.get(t + ':' + o);
        if (!os) return null;
        const od = store.derivedAt?.(o, t) ?? this.touched.get(t + ':' + o) ?? (o === this.host.self() ? this.host.ownDerived?.(t) : this.derived(o, t)) ?? os.derived;
        if (!od) return null;
        // (Its replica as the pass had it: a row with the state doesn't read it, and one not held has none)
        const row = rows.find((r) => r.row[0] === OWN_CAUSE.CONTACT && r.row[1] === o);
        const stateless = reps.has(o) && row && !(row.row[2] & CONTACT_FLAG.STATE);
        const at = !stateless ? null : o === this.host.self() ? this.host.ownMid?.(t, id) ?? null : this.midOf(o, t, row.seq);
        return { shape: shapeOf(os, od, store.geometry(os)), body: at ? { x: at.x, y: at.y, angle: at.angle, vx: at.vx, vy: at.vy } : { x: 0, y: 0, angle: 0, vx: 0, vy: 0 } };
      },
      rebuilt: () => {
        const kept = store.rebuildAt?.(id, t);
        if (kept !== undefined) return kept;
        return u && u.tick === t ? { from: u.from, to: u.to } : null;
      },
    };
  }
}

function shapeOf(ship: ShipState, d: ShipDerived, geom: PlacedGeom[]): OwnShape {
  return { geom, alive: d.alive, com: d.com, mass: d.mass, radius: d.radius, big: ship.blueprint.parts.length > CONTACT_BIG_BODY };
}
