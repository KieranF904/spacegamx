/**
 * Asteroid orbits: a fixed timetable of which asteroid can be where, and when.
 *
 * An asteroid's orbit never changes: it's an ellipse round its star, and where
 * it is on it is a pure function of the tick. So rather than move every
 * asteroid every tick and re-file it in the collision grid, each orbit is
 * walked once (when the asteroid is made) and filed in every cell it passes
 * through, along with the stretch of its orbit (as mean anomaly, the orbit's
 * own clock) it spends there. A shot then asks the cells it crosses which
 * asteroids are there now: a multiply and a compare per entry, no orbit
 * solving. Only the few that pass get their exact position worked out.
 *
 * Every footprint is padded (the asteroid's size, half a walk step, a little
 * slack), so what comes back always includes everything the old per-tick grid
 * would have returned; the exact tests that follow decide what's hit.
 *
 * A rock that keeps still (a stationary field's: `fixed`) is filed only in the
 * cells round its spot, there for its whole clock.
 */
import { ORBIT_MU, dcos, dsin } from '@space-game/common';

/** Cell size of the timetable (world units) */
const ORBIT_CELL = 1000;
/** Walk step along an orbit (world units of arc at most) */
const ORBIT_STEP = 100;
/** Cell coordinates fit in ±OFFSET (1M world units) */
const OFFSET = 1024;
const STRIDE = 2048;
const TWO_PI = Math.PI * 2;
/** Slack on each stretch of orbit clock (radians; about a fifth of a tick on the slowest orbit) */
const PHASE_SLACK = 1e-5;
/** Slack on each footprint (world units: orbit-solver and rounding error, well under one) */
const SPACE_SLACK = 2;

/** A new cell's room (entries); doubled as it fills */
const CELL_START = 4;

export interface OrbitShape {
  semiMajorAxis: number;
  eccentricity: number;
  argPeriapsis: number;
  meanAnomaly0: number;
  epochTick: number;
  size: number;
  /** It keeps still: semiMajorAxis from the centre at angle argPeriapsis (OrbitType.Fixed) */
  fixed?: boolean;
}

export class AsteroidOrbits {
  /**
   * The cells: a key's cell index, and each cell's region of the pools (start, entries, room).
   * Every cell's entries (asteroid ids and the stretch [lo, hi] of orbit clock each spends there)
   * live in three shared pools rather than three small arrays per cell: a big system's orbits
   * cross a couple of hundred thousand cells, and that many little arrays cost far more than
   * what's in them. A full cell moves to a region twice the size at the pools' end; when more
   * than half the pools is left behind that way, they're compacted.
   */
  private cellOf = new Map<number, number>();
  private cStart = new Int32Array(1 << 12);
  private cN = new Int32Array(1 << 12);
  private cCap = new Int32Array(1 << 12);
  private cells = 0;
  private freeCells: number[] = [];
  private pIds = new Int32Array(1 << 16);
  private pLo = new Float32Array(1 << 16);
  private pHi = new Float32Array(1 << 16);
  private poolEnd = 0;
  private wasted = 0;
  /** What each filed asteroid's orbit is (to work out its clock, and to unfile it) */
  private orbits = new Map<number, { system: number; shape: OrbitShape }>();
  /** Query dedupe: an asteroid's last query number, by id */
  private stamp = new Int32Array(1 << 14);
  private queryNo = 0;
  /** Each filed asteroid's clock: mean anomaly at its epoch, rate (per tick), epoch tick */
  private m0 = new Float64Array(1 << 14);
  private rate = new Float64Array(1 << 14);
  private epoch = new Float64Array(1 << 14);
  /** Orbit clock memo: an asteroid's clock at `phaseTick[id]` */
  private phase = new Float64Array(1 << 14);
  private phaseTick = new Float64Array(1 << 14).fill(-1);

  /** Orbits added but not yet walked and filed, in filing order (see flush) */
  private pending = new Map<number, { system: number; shape: OrbitShape }>();
  private settleAfterFlush = false;
  private filed = 0;

  /** How many entries are filed (for stats) */
  get entries(): number { this.flush(); return this.filed; }

  private static key(system: number, cx: number, cy: number): number {
    return ((system * STRIDE) + cx + OFFSET) * STRIDE + (cy + OFFSET);
  }

  /** File an asteroid's whole orbit */
  add(id: number, system: number, shape: OrbitShape): void {
    if (this.orbits.has(id)) this.remove(id);
    const a = shape.semiMajorAxis;
    this.orbits.set(id, { system, shape });
    this.grow(id);
    this.m0[id] = shape.fixed ? 0 : shape.meanAnomaly0;
    this.rate[id] = shape.fixed ? 0 : Math.sqrt(ORBIT_MU / (a * a * a));
    this.epoch[id] = shape.epochTick;
    this.phaseTick[id] = -1;
    // The walk (the costly part) waits until a query needs the cells: a world nobody shoots in never pays it
    this.pending.set(id, { system, shape });
  }

  /**
   * File every orbit added so far, in the order they were added (so each cell's order is the
   * same as filing them one by one on add). A running server calls this at start; queries call it first.
   */
  flush(): void {
    if (this.pending.size) {
      const todo = [...this.pending];
      this.pending.clear();
      for (const [id, o] of todo) this.file(id, o.system, o.shape);
    }
    if (this.settleAfterFlush) { this.settleAfterFlush = false; this.compact(true); }
  }

  private file(id: number, system: number, shape: OrbitShape): void {
    this.walk(system, shape, (key, lo, hi) => {
      let c = this.cellOf.get(key);
      if (c === undefined) { c = this.newCell(); this.cellOf.set(key, c); }
      if (this.cN[c] === this.cCap[c]) this.moveCell(c, this.cCap[c] * 2);
      const at = this.cStart[c] + this.cN[c];
      this.pIds[at] = id;
      // Rounded outwards by the slack (far more than float32 loses)
      this.pLo[at] = lo - PHASE_SLACK;
      this.pHi[at] = hi + PHASE_SLACK;
      this.cN[c]++;
      this.filed++;
    });
    if (this.wasted > this.poolEnd / 2 && this.poolEnd > 1 << 16) this.compact();
  }

  /** A cell (an index into the cell arrays), with a region of CELL_START */
  private newCell(): number {
    let c = this.freeCells.pop();
    if (c === undefined) {
      c = this.cells++;
      if (c >= this.cStart.length) {
        const len = this.cStart.length * 2;
        for (const k of ['cStart', 'cN', 'cCap'] as const) { const a = new Int32Array(len); a.set(this[k]); this[k] = a; }
      }
    }
    this.cN[c] = 0;
    this.cCap[c] = 0;
    this.moveCell(c, CELL_START);
    return c;
  }

  /** Give a cell a region of `cap` at the pools' end, its entries copied over (the old region is left behind) */
  private moveCell(c: number, cap: number): void {
    if (this.poolEnd + cap > this.pIds.length) {
      const len = Math.max(this.pIds.length * 2, this.poolEnd + cap);
      const ids = new Int32Array(len); ids.set(this.pIds.subarray(0, this.poolEnd)); this.pIds = ids;
      const lo = new Float32Array(len); lo.set(this.pLo.subarray(0, this.poolEnd)); this.pLo = lo;
      const hi = new Float32Array(len); hi.set(this.pHi.subarray(0, this.poolEnd)); this.pHi = hi;
    }
    const from = this.cStart[c], n = this.cN[c], to = this.poolEnd;
    if (n) {
      this.pIds.copyWithin(to, from, from + n);
      this.pLo.copyWithin(to, from, from + n);
      this.pHi.copyWithin(to, from, from + n);
    }
    this.wasted += this.cCap[c];
    this.cStart[c] = to;
    this.cCap[c] = cap;
    this.poolEnd += cap;
  }

  /**
   * Done filing the world's belts: close up and trim every cell to what it holds (and a
   * little room), so the pools are the size of what's in them rather than of how they grew
   */
  settle(): void {
    if (this.pending.size) this.settleAfterFlush = true;
    else this.compact(true);
  }

  /** Close up the regions left behind: every live cell's region copied, in order, to fresh pools (`tight`: each trimmed to its entries and a little room) */
  private compact(tight = false): void {
    let size = 0;
    for (const c of this.cellOf.values()) {
      if (tight) this.cCap[c] = Math.max(CELL_START, this.cN[c] + 2);
      size += this.cCap[c];
    }
    const len = Math.max(1 << 16, Math.ceil(size * 1.25) + 4096);
    const ids = new Int32Array(len), lo = new Float32Array(len), hi = new Float32Array(len);
    let at = 0;
    for (const c of this.cellOf.values()) {
      const from = this.cStart[c], n = this.cN[c];
      ids.set(this.pIds.subarray(from, from + n), at);
      lo.set(this.pLo.subarray(from, from + n), at);
      hi.set(this.pHi.subarray(from, from + n), at);
      this.cStart[c] = at;
      at += this.cCap[c];
    }
    this.pIds = ids; this.pLo = lo; this.pHi = hi;
    this.poolEnd = at;
    this.wasted = 0;
  }

  /** Unfile an asteroid (its id may be reused for anything) */
  remove(id: number): void {
    const o = this.orbits.get(id);
    if (!o) return;
    this.orbits.delete(id);
    if (this.pending.delete(id)) { this.phaseTick[id] = -1; return; }
    const seen = new Set<number>();
    this.walk(o.system, o.shape, (key) => {
      if (seen.has(key)) return;
      seen.add(key);
      const c = this.cellOf.get(key);
      if (c === undefined) return;
      // Keep the rest in filing order
      const s0 = this.cStart[c], n = this.cN[c];
      let w = 0;
      for (let r = 0; r < n; r++) {
        if (this.pIds[s0 + r] === id) { this.filed--; continue; }
        this.pIds[s0 + w] = this.pIds[s0 + r]; this.pLo[s0 + w] = this.pLo[s0 + r]; this.pHi[s0 + w] = this.pHi[s0 + r]; w++;
      }
      this.cN[c] = w;
      if (w === 0) {
        this.cellOf.delete(key);
        this.wasted += this.cCap[c];
        this.cCap[c] = 0;
        this.freeCells.push(c);
      }
    });
    this.phaseTick[id] = -1;
  }

  /**
   * Walk an orbit by eccentric anomaly E (position and mean anomaly are both
   * direct formulas of it: no solving), reporting each cell the padded
   * footprint touches and the stretch of mean anomaly it's there for, merged
   * over consecutive steps
   */
  private walk(system: number, s: OrbitShape, emit: (key: number, lo: number, hi: number) => void): void {
    if (s.fixed) {
      // Still: the cells round its spot, all its clock (which never moves off 0)
      const x = dcos(s.argPeriapsis) * s.semiMajorAxis, y = dsin(s.argPeriapsis) * s.semiMajorAxis, reach = s.size + SPACE_SLACK;
      for (let cx = Math.floor((x - reach) / ORBIT_CELL); cx <= Math.floor((x + reach) / ORBIT_CELL); cx++) {
        for (let cy = Math.floor((y - reach) / ORBIT_CELL); cy <= Math.floor((y + reach) / ORBIT_CELL); cy++) emit(AsteroidOrbits.key(system, cx, cy), 0, TWO_PI);
      }
      return;
    }
    const a = s.semiMajorAxis, e = s.eccentricity;
    const b = a * Math.sqrt(1 - e * e);
    const cw = dcos(s.argPeriapsis), sw = dsin(s.argPeriapsis);
    // Arc speed along E is at most a, so a step of E covers at most a·dE of arc
    const steps = Math.max(16, Math.ceil(TWO_PI * a / ORBIT_STEP));
    const dE = TWO_PI / steps;
    const reach = s.size + (a * dE) / 2 + SPACE_SLACK;
    /** Open stretches: cell -> [lo, hi, last step] */
    const open = new Map<number, [number, number, number]>();
    for (let k = 0; k < steps; k++) {
      const e0 = k * dE, e1 = k === steps - 1 ? TWO_PI : (k + 1) * dE, em = (e0 + e1) / 2;
      // Clock at both ends of the step, and where it is halfway (every point of the step is within reach of it)
      const m0 = e0 - e * dsin(e0), m1 = e1 - e * dsin(e1);
      const px = a * (dcos(em) - e), py = b * dsin(em);
      const x = px * cw - py * sw, y = px * sw + py * cw;
      const cx0 = Math.floor((x - reach) / ORBIT_CELL), cx1 = Math.floor((x + reach) / ORBIT_CELL);
      const cy0 = Math.floor((y - reach) / ORBIT_CELL), cy1 = Math.floor((y + reach) / ORBIT_CELL);
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cy = cy0; cy <= cy1; cy++) {
          const key = AsteroidOrbits.key(system, cx, cy);
          const run = open.get(key);
          if (run && run[2] === k - 1) { run[1] = m1; run[2] = k; continue; }
          if (run) emit(key, run[0], run[1]);
          open.set(key, [m0, m1, k]);
        }
      }
    }
    for (const [key, run] of open) emit(key, run[0], run[1]);
  }

  /**
   * Asteroids in a system that may be within `padding` of the box at this tick,
   * each once, in filing order within each cell
   */
  query(system: number, x1: number, y1: number, x2: number, y2: number, padding: number, tick: number): number[] {
   
    const cx0 = Math.floor((Math.min(x1, x2) - padding) / ORBIT_CELL), cx1 = Math.floor((Math.max(x1, x2) + padding) / ORBIT_CELL);
    const cy0 = Math.floor((Math.min(y1, y2) - padding) / ORBIT_CELL), cy1 = Math.floor((Math.max(y1, y2) + padding) / ORBIT_CELL);
    if (++this.queryNo === 0x7fffffff) { this.stamp.fill(0); this.queryNo = 1; }
    const q = this.queryNo;
    const out: number[] = [];
    const stamp = this.stamp, phase = this.phase, phaseTick = this.phaseTick;
    const ids = this.pIds, los = this.pLo, his = this.pHi;
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const c = this.cellOf.get(AsteroidOrbits.key(system, cx, cy));
        if (c === undefined) continue;
        const s0 = this.cStart[c], s1 = s0 + this.cN[c];
        for (let i = s0; i < s1; i++) {
          const id = ids[i];
          if (stamp[id] === q) continue;
          // Its orbit clock (mean anomaly in [0, 2π)) this tick
          let m: number;
          if (phaseTick[id] === tick) m = phase[id];
          else {
            m = (this.m0[id] + this.rate[id] * (tick - this.epoch[id])) % TWO_PI;
            if (m < 0) m += TWO_PI;
            phase[id] = m;
            phaseTick[id] = tick;
          }
          if (m < los[i] || m > his[i]) continue;
          stamp[id] = q;
          out.push(id);
        }
      }
    }
    return out;
  }

  private grow(id: number): void {
    if (id < this.stamp.length) return;
    const len = Math.max(id + 1, this.stamp.length * 2);
    const st = new Int32Array(len); st.set(this.stamp); this.stamp = st;
    const ph = new Float64Array(len); ph.set(this.phase); this.phase = ph;
    const pt = new Float64Array(len).fill(-1); pt.set(this.phaseTick); this.phaseTick = pt;
    for (const k of ['m0', 'rate', 'epoch'] as const) { const f = new Float64Array(len); f.set(this[k]); this[k] = f; }
  }
}
