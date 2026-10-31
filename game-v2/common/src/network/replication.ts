/**
 * Ship motion on the wire (see ships/replica.ts). A snapshot carries:
 *
 *   ships  keyframes, only for ships a client is new to or that left the
 *          path their controls predicted:
 *          [id, mode, x, y, vx, vy, angle, angVel, jump, jumpScale, bits, q, brace?, cargo?, station?, ox?, oy?, dodge?, dodgeSpent?]
 *          (brace and cargo, the anchor's counter and the hold's mass, go when
 *          either is set or the ship is docked or dodging; station -1 when it
 *          isn't docked but a Burst Strafer's dodge and charge follow)
 *   ctl    control changes since the last snapshot, per ship:
 *          [id, tb, dq, tb, dq, ...]  where tb = bits × 8 + ticksAgo
 *          (ticksAgo counts back from the snapshot's tick: the step at that tick
 *          used them; one of 7 or more goes as tb = bits × 8 + 7, then ticksAgo)
 *          or, for the common case of the aim moving tick after tick with the
 *          same buttons held, [-1 - id, tb, dq, dq, dq, ...]: one change per tick
 *          from ticksAgo on (packControlRow). Each aim goes as the step
 *          from the one before, the first from the aim the client already has
 *          (its keyframe's or last change's: both ends keep it), wrapped to ±4096.
 *
 * q is the aim angle in the 13-bit cursor quantization; a pilot's arrives as a
 * float32 (the input encoding), so it's rounded the same way here.
 */

import { ReplicaMode, ReplicaControls, ReplicaEnv, FlightBody, ShipTuning, ShipDerived, replicaStep } from '../ships/index.js';
import { quantizeCursorAngle, dequantizeCursorAngle } from './cursorState.js';

export type KeyframeRow = number[];
export type ControlRow = number[];

/** The aim angle a step uses, from its quantized form */
export function replicaAngle(mode: ReplicaMode, q: number): number {
  const a = dequantizeCursorAngle(q);
  return mode === ReplicaMode.Player ? Math.fround(a) : a;
}

export function quantizeReplicaAngle(a: number): number {
  return quantizeCursorAngle(a);
}

export interface Keyframe {
  id: number;
  mode: ReplicaMode;
  body: FlightBody;
  ctl: ReplicaControls;
  q: number;
  /** Docked: the station entity and the offset from it */
  dock?: { station: number; ox: number; oy: number };
}

export function packKeyframe(k: Keyframe): KeyframeRow {
  const b = k.body;
  const row = [k.id, k.mode, b.x, b.y, b.vx, b.vy, b.angle, b.angVel, b.jump ?? 0, b.jumpScale ?? 1, k.ctl.bits, k.q];
  const dodge = !!(b.dodge || b.dodgeSpent);
  if (k.dock || b.brace || b.cargo || dodge) row.push(b.brace ?? 0, b.cargo ?? 0);
  if (k.dock) row.push(k.dock.station, Math.round(k.dock.ox * 100) / 100, Math.round(k.dock.oy * 100) / 100);
  else if (dodge) row.push(-1, 0, 0);
  // (The Burst Strafer's counter and charge spent: strafer.ts)
  if (dodge) row.push(b.dodge ?? 0, b.dodgeSpent ?? 0);
  return row;
}

export function unpackKeyframe(r: KeyframeRow): Keyframe {
  const mode = r[1] as ReplicaMode;
  return {
    id: r[0], mode,
    body: { x: r[2], y: r[3], vx: r[4], vy: r[5], angle: r[6], angVel: r[7], jump: r[8], jumpScale: r[9], ...(r[12] ? { brace: r[12] } : {}), ...(r[13] ? { cargo: r[13] } : {}), ...(r[17] ? { dodge: r[17] } : {}), ...(r[18] ? { dodgeSpent: r[18] } : {}) },
    ctl: { bits: r[10], targetAngle: replicaAngle(mode, r[11]) },
    q: r[11],
    dock: r.length > 14 && r[14] >= 0 ? { station: r[14], ox: r[15], oy: r[16] } : undefined,
  };
}

const AIM_Q = 8192;
const stepQ = (from: number, to: number) => ((to - from) % AIM_Q + AIM_Q + AIM_Q / 2) % AIM_Q - AIM_Q / 2;
const addQ = (q: number, d: number) => ((q + d) % AIM_Q + AIM_Q) % AIM_Q;

/**
 * A ship's control changes as a row; events are [ticksAgo, bits, q] oldest
 * first, `base` the aim the client has for it already.
 */
export function packControlRow(id: number, events: [number, number, number][], base: number): ControlRow {
  const dq = events.map(([, , q], i) => stepQ(i ? events[i - 1][2] : base, q));
  const tb = (t: number, b: number) => (t < 7 ? [b * 8 + t] : [b * 8 + 7, t]);
  const run = events.length > 1 && events.every(([t, b], i) => i === 0 || (t === events[i - 1][0] - 1 && b === events[0][1]));
  if (run) return [-1 - id, ...tb(events[0][0], events[0][1]), ...dq];
  return [id, ...events.flatMap(([t, b], i) => [...tb(t, b), dq[i]])];
}

/** Whose row it is */
export function controlRowId(row: ControlRow): number {
  return row[0] < 0 ? -1 - row[0] : row[0];
}

/** The other way: the events, from the aim the client had */
export function unpackControlRow(row: ControlRow, base: number): [number, number, number][] {
  const events: [number, number, number][] = [];
  let q = base;
  let i = 1;
  const tb = (): [number, number] => {
    const v = row[i++];
    return [v % 8 === 7 ? row[i++] : v % 8, Math.floor(v / 8)];
  };
  if (row[0] < 0) {
    const [t, b] = tb();
    for (let k = 0; i < row.length; k++) { q = addQ(q, row[i++]); events.push([t - k, b, q]); }
    return events;
  }
  while (i < row.length) {
    const [t, b] = tb();
    q = addQ(q, row[i++]);
    events.push([t, b, q]);
  }
  return events;
}

// ---------------------------------------------------------------------------
// The receiving side: every ship's timeline, stepped on demand
// ---------------------------------------------------------------------------

interface Step { body: FlightBody; bits: number; q: number }

interface Rep {
  mode: ReplicaMode;
  dock?: { station: number; ox: number; oy: number };
  /** Control changes not yet folded into a stepped state: tick → [bits, q] */
  events: Map<number, [number, number]>;
  /** Stepped states by tick (a window), the newest at `last` */
  hist: Map<number, Step>;
  last: number;
  /** The latest keyframe's tick (nothing before it can change) */
  kf: number;
  /** The newest aim it was sent (control rows give aims as steps from it) */
  q: number;
}

const HISTORY = 240;

const cloneBody = (b: FlightBody): FlightBody => ({ x: b.x, y: b.y, vx: b.vx, vy: b.vy, angle: b.angle, angVel: b.angVel, jump: b.jump, jumpScale: b.jumpScale, brace: b.brace, cargo: b.cargo, dodge: b.dodge, dodgeSpent: b.dodgeSpent });

/**
 * Every replicated ship a client knows: keyframes and control changes from
 * snapshots go in, states at any tick come out (stepped with the shared
 * replicaStep, exactly as the server's shadow does). A control change that
 * arrives after its tick was already stepped rewinds to just before it.
 */
export class ShipReplicaSet {
  private reps = new Map<number, Rep>();

  constructor(
    private tuning: ShipTuning,
    /** A ship's structure (null until its shipSync arrives) */
    private derived: (id: number) => ShipDerived | null | undefined,
    private env: () => ReplicaEnv,
    /** A station's position at a tick (docked ships ride along) */
    private stationAt?: (station: number, tick: number) => { x: number; y: number } | null,
  ) {}

  has(id: number): boolean {
    return this.reps.has(id);
  }

  /** Is this ship docked (riding inside its station) as last heard */
  isDocked(id: number): boolean {
    return this.reps.get(id)?.mode === ReplicaMode.Docked;
  }

  remove(id: number): void {
    this.reps.delete(id);
  }

  clear(): void {
    this.reps.clear();
  }

  ids(): IterableIterator<number> {
    return this.reps.keys();
  }

  /** A snapshot's keyframes and control changes */
  apply(tick: number, ships?: KeyframeRow[], ctl?: ControlRow[]): void {
    for (const row of ships ?? []) {
      const k = unpackKeyframe(row);
      let r = this.reps.get(k.id);
      if (!r) { r = { mode: k.mode, events: new Map(), hist: new Map(), last: tick, kf: tick, q: k.q }; this.reps.set(k.id, r); }
      r.q = k.q;
      r.mode = k.mode;
      r.dock = k.dock;
      // The new path starts here; what came before stays (we may still be drawing it)
      for (const t of [...r.hist.keys()]) if (t >= tick) r.hist.delete(t);
      for (const t of [...r.events.keys()]) if (t <= tick) r.events.delete(t);
      r.hist.set(tick, { body: k.body, bits: k.ctl.bits, q: k.q });
      r.last = tick;
      r.kf = tick;
    }
    for (const packed of ctl ?? []) {
      const id = controlRowId(packed);
      const r = this.reps.get(id);
      if (!r) continue;
      const events = unpackControlRow(packed, r.q);
      if (events.length) r.q = events[events.length - 1][2];
      for (const [ago, bits, q] of events) {
        const t = tick - ago;
        if (t <= r.kf) continue;
        r.events.set(t, [bits, q]);
        // Already stepped past it: rewind to just before
        if (t <= r.last) {
          for (const h of [...r.hist.keys()]) if (h >= t) r.hist.delete(h);
          r.last = Math.max(...r.hist.keys(), -Infinity);
        }
      }
      if (!r.hist.size) this.reps.delete(id); // nothing to replay from: wait for a keyframe
    }
  }

  /** The state at a whole tick, stepping forward as needed (null: unknown ship) */
  at(id: number, tick: number): Step | null {
    const r = this.reps.get(id);
    if (!r || !r.hist.size) return null;
    const exact = r.hist.get(tick);
    if (exact) return exact;
    if (tick < r.last) {
      // Before the window (or a gap): the earliest we have
      let best: Step | null = null, bt = Infinity;
      for (const [t, s] of r.hist) if (t >= tick && t < bt) { bt = t; best = s; }
      return best ?? r.hist.get(r.last)!;
    }
    const d = this.derived(id);
    let cur = r.hist.get(r.last)!;
    if (r.mode === ReplicaMode.Docked) {
      const st = r.dock && this.stationAt?.(r.dock.station, tick);
      if (!st) return cur;
      const body = { ...cloneBody(cur.body), x: st.x + r.dock!.ox, y: st.y + r.dock!.oy, vx: 0, vy: 0 };
      return { body, bits: cur.bits, q: cur.q };
    }
    if (!d) return cur;
    const env = this.env();
    // Don't run away: a ship we haven't heard about for a long time simply waits
    const to = Math.min(tick, r.last + 600);
    while (r.last < to) {
      const t = r.last + 1;
      const ev = r.events.get(t);
      const bits = ev ? ev[0] : cur.bits, q = ev ? ev[1] : cur.q;
      const body = cloneBody(cur.body);
      replicaStep(r.mode, body, { bits, targetAngle: replicaAngle(r.mode, q) }, d, this.tuning, env, t);
      cur = { body, bits, q };
      r.hist.set(t, cur);
      r.last = t;
    }
    for (const t of r.hist.keys()) if (t < r.last - HISTORY) r.hist.delete(t);
    for (const t of r.events.keys()) if (t < r.last - HISTORY) r.events.delete(t);
    return cur;
  }

  /** Where a ship is at a fractional tick (between two stepped states) */
  pose(id: number, t: number): { x: number; y: number; angle: number; vx: number; vy: number; jump: number; jumpScale: number; brace: number; dodge: number; aim: number; bits: number } | null {
    const f = Math.floor(t);
    const a = this.at(id, f);
    if (!a) return null;
    const b = this.at(id, f + 1) ?? a;
    const k = Math.max(0, Math.min(1, t - f));
    let da = b.body.angle - a.body.angle;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    const mode = this.reps.get(id)!.mode;
    return {
      x: a.body.x + (b.body.x - a.body.x) * k, y: a.body.y + (b.body.y - a.body.y) * k, angle: a.body.angle + da * k,
      vx: b.body.vx, vy: b.body.vy, jump: b.body.jump ?? 0, jumpScale: b.body.jumpScale ?? 1, brace: b.body.brace ?? 0, dodge: b.body.dodge ?? 0, aim: replicaAngle(mode, b.q), bits: b.bits,
    };
  }
}
