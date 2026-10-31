/**
 * The ship's power layout (docs/design/rework-2026-11.md ยง2.2-2.3): worked out
 * once a rebuild, never per tick (energy.ts runs the tick over what's here).
 *
 * - **The pool**: the core's store plus every Battery and Heavy Bank on a
 *   powered wire network (one with a generator: wires.ts). One charge for the
 *   whole ship. It gives at most its rate a second (the core's and each
 *   battery's `discharge`, per cell), on top of the spare generation: that sum
 *   is the ship's Output.
 * - **Banks**: Capacitors that touch (share a full cell edge) are one bank, and
 *   Drive Cells that touch are another; the two kinds never mix. A Capacitor
 *   bank feeds the guns, beams and mining lasers it touches; a Drive Cell bank
 *   the engines and Burst Strafers it touches. A fed part draws on its bank(s)
 *   first, then on the ship's Output. A bank refills from spare generation
 *   only if a member is on a powered network, plus 10/s (`dynamo`) from each
 *   Pulse Dynamo touching it.
 * - **Feed groups**: burst consumers (engines, guns, mining lasers, burst part
 *   features) that draw on the same banks. Their shares are per group.
 */

import type { FunctionDef, MaterialDef } from './types.js';
import type { ShipTuning } from './tuning.js';
import { fnOutput, partDemand } from './grades.js';

/** A bank: touching Capacitors ('cap') or touching Drive Cells ('drive'), Charge.b order (by its lowest part index) */
export interface Bank {
  kind: 'cap' | 'drive';
  /** Its members (part indices, ascending) */
  parts: number[];
  /** What it holds full, and the most it gives a second (the sums over its members) */
  cap: number;
  rate: number;
  /** The consumer parts it feeds (touching, of its kind), ascending */
  feeds: number[];
  /** The Flash Screens it touches (a Capacitor bank only): it pays for their instant return (features/flash) */
  shields: number[];
  /** Whether spare generation refills it (a member on a powered network) */
  refills: boolean;
  /** What touching Pulse Dynamos put in a second, and the dynamos */
  dynamo: number;
  dynamos: number[];
}

export interface PowerLayout {
  /** The ship's pool: what it holds full (the core's store and the batteries'), the most it gives a second, and its parts (batteries) */
  pool: { cap: number; rate: number; coreCap: number; coreRate: number; parts: number[] };
  banks: Bank[];
  /** Generation left after the steady loads (per second), the whole ship */
  spare: number;
  /** Feed groups: burst consumers drawing on the same banks (bank indices, ascending; none: the ship's Output alone) */
  feeds: { banks: number[] }[];
  /** Per part: its feed group (-1: not a burst consumer), its bank (-1: none), its draw flat out (per second), its capacity, whether it is in the pool */
  feedOf: number[];
  bankOf: number[];
  draw: number[];
  /** Per engine: how hard boosting drains it, ื its draw (0 for an engine with no boost) */
  boostDrain: number[];
  partCap: number[];
  pooled: boolean[];
}

export interface CircuitInput {
  fns: FunctionDef[];
  area: number[];
  mats: MaterialDef[];
  alive: boolean[];
  /** Joins between intact parts (rebuild step 1) */
  joins: [number, number][];
  network: number[];
  networks: { parts: number[]; supply: number; delivered: number; powered: boolean }[];
  /** Engines, guns and mining lasers (and burst part features): they draw by the tick, not steadily */
  burst: (i: number) => boolean;
  /** Of those, the ones Drive Cell banks feed: engines, and part features that draw as one (a Burst Strafer) */
  engine: (i: number) => boolean;
  /** Of those, the ones Capacitor banks feed: guns, beams and mining lasers */
  gun: (i: number) => boolean;
  core: boolean;
  tuning: ShipTuning;
  /** Each part's output against its health (tuning healthFactor): a damaged Pulse Dynamo makes less. Absent: all whole */
  health?: number[];
}

/** The energy defaults (tuning.json `energy` overrides them) */
export const CIRCUIT_DEFAULTS = {
  /** The most the core's store gives a second */
  coreDischarge: 720,
  /** Discharge per cell per second of a store with no `discharge` of its own: a pool battery, a Drive Cell, a Capacitor */
  discharge: { general: 600, drive: 1400, bank: 2000 },
};

export type CircuitTuning = typeof CIRCUIT_DEFAULTS;

const tunings = new WeakMap<ShipTuning, CircuitTuning>();
export function circuitTuning(t: ShipTuning): CircuitTuning {
  let c = tunings.get(t);
  if (!c) {
    const e = ((t as { energy?: Partial<CircuitTuning> & { discharge?: Partial<CircuitTuning['discharge']> } }).energy ?? {});
    c = { ...CIRCUIT_DEFAULTS, ...e, discharge: { ...CIRCUIT_DEFAULTS.discharge, ...(e.discharge ?? {}) } } as CircuitTuning;
    tunings.set(t, c);
  }
  return c;
}

/** A store's bank kind: a Capacitor ('cap'), a Drive Cell ('drive'), or none (a pool battery) */
export function bankKind(fn: FunctionDef | undefined): 'cap' | 'drive' | null {
  if (!fn?.bank || !((fn.store ?? 0) > 0)) return null;
  return fn.pool === 'drive' ? 'drive' : 'cap';
}

/** A store part's discharge rate (per second) */
export function partDischarge(fn: FunctionDef, area: number, m: MaterialDef | undefined, t: CircuitTuning): number {
  if (!(fn.store ?? 0)) return 0;
  const k = bankKind(fn);
  const per = fn.discharge ?? (k === 'cap' ? t.discharge.bank : k === 'drive' ? t.discharge.drive : t.discharge.general);
  return per * area * fnOutput(fn, m);
}

/** A store part's capacity */
export function partCapacity(fn: FunctionDef, area: number, m: MaterialDef | undefined): number {
  return (fn.store ?? 0) * area * fnOutput(fn, m);
}

export function powerLayout(a: CircuitInput): PowerLayout {
  const { fns, area, mats, alive, network, networks, tuning } = a;
  const n = fns.length;
  const ct = circuitTuning(tuning);
  const kind = (i: number) => (alive[i] ? bankKind(fns[i]) : null);
  const isConsumer = (i: number) => alive[i] && (fns[i].demand ?? 0) > 0 && a.burst(i);
  const onPowered = (i: number) => network[i] >= 0 && !!networks[network[i]]?.powered;
  const touching: number[][] = Array.from({ length: n }, () => []);
  for (const [x, y] of a.joins) if (alive[x] && alive[y]) { touching[x].push(y); touching[y].push(x); }

  // The pool: the core's store, and every battery (a store that isn't a bank member) on a powered network
  const partCap = new Array<number>(n).fill(0);
  const pooled = new Array<boolean>(n).fill(false);
  const coreCap = a.core ? ((tuning as { energy?: { coreCapacity?: number } }).energy?.coreCapacity ?? 240) : 0;
  const coreRate = a.core ? ct.coreDischarge : 0;
  const pool = { cap: coreCap, rate: coreRate, coreCap, coreRate, parts: [] as number[] };
  for (let i = 0; i < n; i++) {
    if (!alive[i] || !((fns[i].store ?? 0) > 0)) continue;
    partCap[i] = partCapacity(fns[i], area[i], mats[i]);
    if (kind(i) || !onPowered(i)) continue;
    pooled[i] = true;
    pool.parts.push(i);
    pool.cap += partCap[i];
    pool.rate += partDischarge(fns[i], area[i], mats[i], ct);
  }

  // Banks: members of one kind touching each other (union-find, the lowest index the root, so banks number by it)
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (const [x, y] of a.joins) {
    const k = kind(x);
    if (!k || k !== kind(y)) continue;
    const rx = find(x), ry = find(y);
    if (rx !== ry) parent[Math.max(rx, ry)] = Math.min(rx, ry);
  }
  const banks: Bank[] = [];
  const bankOf = new Array<number>(n).fill(-1);
  const rootBank = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const k = kind(i);
    if (!k) continue;
    const r = find(i);
    let b = rootBank.get(r);
    if (b === undefined) { b = banks.length; rootBank.set(r, b); banks.push({ kind: k, parts: [], cap: 0, rate: 0, feeds: [], shields: [], refills: false, dynamo: 0, dynamos: [] }); }
    const B = banks[b];
    B.parts.push(i);
    B.cap += partCap[i];
    B.rate += partDischarge(fns[i], area[i], mats[i], ct);
    if (onPowered(i)) B.refills = true;
    bankOf[i] = b;
    for (const j of touching[i]) {
      if (isConsumer(j) && !B.feeds.includes(j) && (k === 'drive' ? a.engine(j) : a.gun(j))) B.feeds.push(j);
      if (k === 'cap' && alive[j] && fns[j].flash && !B.shields.includes(j)) B.shields.push(j);
      if (alive[j] && (fns[j].dynamo ?? 0) > 0 && !B.dynamos.includes(j)) B.dynamos.push(j);
    }
  }
  for (const B of banks) {
    B.feeds.sort((x, y) => x - y);
    B.shields.sort((x, y) => x - y);
    B.dynamos.sort((x, y) => x - y);
    for (const j of B.dynamos) B.dynamo += fns[j].dynamo! * (a.health?.[j] ?? 1);
  }

  // Burst consumers: their feed group (the banks feeding them)
  const draw = new Array<number>(n).fill(0);
  const boostDrain = new Array<number>(n).fill(0);
  const feedOf = new Array<number>(n).fill(-1);
  const feeds: PowerLayout['feeds'] = [];
  const feedKey = new Map<string, number>();
  const fedBy: number[][] = Array.from({ length: n }, () => []);
  banks.forEach((B, b) => { for (const j of B.feeds) fedBy[j].push(b); });
  for (let i = 0; i < n; i++) {
    if (!isConsumer(i)) continue;
    draw[i] = partDemand(fns[i], area[i], mats[i]);
    boostDrain[i] = fns[i].boostDrain ?? 1;
    const key = fedBy[i].join(',');
    let f = feedKey.get(key);
    if (f === undefined) { f = feeds.length; feedKey.set(key, f); feeds.push({ banks: fedBy[i] }); }
    feedOf[i] = f;
  }

  const spare = networks.reduce((t, net) => t + Math.max(0, net.supply - net.delivered), 0);
  return { pool, banks, spare, feeds, feedOf, bankOf, draw, boostDrain, partCap, pooled };
}
