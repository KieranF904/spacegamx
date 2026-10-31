/**
 * Local circuits (docs/design/energy-system.md, Phase 1 "Local Circuits"):
 * what each power network holds and gives, worked out once a rebuild (never
 * per tick: energy.ts runs the tick over what's here, a loop over circuits).
 *
 * A circuit is one of the wire networks (wires.ts). It keeps its own charge:
 * its stores fill from its own generators and serve only its own consumers.
 * Every store gives at most its discharge rate (models.json `discharge`, per
 * cell per second), so a circuit asked for more than its generators' spare
 * stream plus its stores' rates browns out, and everything on it gets the
 * same share (engines first).
 *
 * - Pools: a circuit's batteries by label, as before: general (g: everything
 *   draws on it), drive (d: engines only), weapon (w: guns and mining lasers).
 * - Banks (k): capacitors (FunctionDef `bank`) touching each other are one
 *   bank. A bank charges from the circuit it's wired to, but gives only to
 *   the consumers it touches (shares an edge with), on top of their circuit.
 * - The core's own store sits on the main circuit (the one making the most
 *   power) like a battery, and trickles a little into every other circuit and
 *   into parts on no circuit at all, so a cut-off part limps instead of dying.
 *
 * Built for later power types (wave 2): a circuit is the unit a type would
 * go on (Circuit `type`, one per circuit, from its generators).
 */

import type { FunctionDef, MaterialDef } from './types.js';
import type { ShipTuning } from './tuning.js';
import { fnOutput, partDemand } from './grades.js';

/** A store group: one circuit's pool of a label, a capacitor bank, in Charge.s order */
export interface StoreGroup {
  /** g general, d drive (engines only), w weapon (guns and mining lasers only), k a capacitor bank (only what it touches) */
  kind: 'g' | 'd' | 'w' | 'k';
  /** The circuit that charges it (index into circuits) */
  circuit: number;
  /** Its parts */
  parts: number[];
  /** Energy it holds full, and the most it gives a second */
  cap: number;
  rate: number;
  /** A bank: the consumer parts it touches */
  feeds?: number[];
  /** A bank (energy Phase 2: surge.ts): it carries Surge; the Surge its Pulse Dynamos make a second; the shield generators it
   *  touches (flash restore); its label (S1, S2...) */
  type?: 'surge';
  surge?: number;
  shields?: number[];
  label?: string;
}

export interface Circuit {
  /** Its wire network (ShipDerived.networks), -1 for the parts on none (unwired: fed only by the core's trickle and banks) */
  net: number;
  /** A, B, C... (the main circuit first); '' for one with nothing on it that makes, stores or draws power */
  letter: string;
  /** The power type it carries: a wired circuit is Steady (Surge never travels along wires: it's a bank's, by touch) */
  type: 'steady';
  /** Its parts (the network's) */
  parts: number[];
  /** Generation, and what's left of it once the steady loads (shields, scanners, coils) have theirs: per second */
  supply: number;
  spare: number;
  /** Its pools (store group indices, -1 none) and the banks it charges */
  pools: { g: number; d: number; w: number };
  banks: number[];
  /** The main circuit: the core's store sits on it */
  main: boolean;
  /** What draws on it flat out, per second: engines (cruising), guns, mining lasers */
  engineDraw: number;
  gunDraw: number;
  minerDraw: number;
  /** Its generators, stores and burst consumers (part indices), for the hangar */
  generators: number[];
  storeParts: number[];
  consumers: number[];
}

export interface PowerLayout {
  circuits: Circuit[];
  stores: StoreGroup[];
  /** The core's store (absent without a core): what it holds, gives its circuit a second, and trickles to the others a second */
  core: { cap: number; rate: number; trickle: number; circuit: number } | null;
  /** Feed groups: burst consumers that share a supply (a circuit, and the bank they touch: a store index or -1) */
  feeds: { circuit: number; bank: number }[];
  /** Per part: its feed group (-1: not a burst consumer), its store group (-1: not a store), its draw flat out (per second), and its capacity */
  feedOf: number[];
  storeOf: number[];
  draw: number[];
  partCap: number[];
  /** Per part: its circuit (index into circuits), -1 none */
  circuitOf: number[];
  /** Dual-fed parts (surge.ts): part index → 'rail' (Rail Driver) or 'flash' (Flash Screen) */
  dual: Partial<Record<number, 'rail' | 'flash'>>;
}

export interface CircuitInput {
  fns: FunctionDef[];
  area: number[];
  mats: MaterialDef[];
  alive: boolean[];
  /** Joins between intact parts (rebuild step 1) */
  joins: [number, number][];
  network: number[];
  networks: { parts: number[]; supply: number; delivered: number }[];
  /** Engines, guns and mining lasers: they draw by the tick, not steadily */
  burst: (i: number) => boolean;
  core: boolean;
  tuning: ShipTuning;
  /** Each part's output against its health (tuning healthFactor): a damaged Pulse Dynamo makes less. Absent: all whole */
  health?: number[];
}

/** The energy defaults (tuning.json `energy` overrides them) */
export const CIRCUIT_DEFAULTS = {
  /** The core's store: how fast it gives the main circuit, and the trickle it gives every other circuit (per second, shared) */
  coreDischarge: 720,
  coreTrickle: 12,
  /** Discharge per cell per second of a store with no `discharge` of its own (legacy batteries), by pool */
  discharge: { general: 600, drive: 1400, weapon: 900, bank: 2000 },
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

const kindOf = (fn: FunctionDef): StoreGroup['kind'] => (fn.bank ? 'k' : fn.pool === 'drive' ? 'd' : fn.pool === 'weapon' ? 'w' : 'g');

/** A store part's discharge rate (per second) */
export function partDischarge(fn: FunctionDef, area: number, m: MaterialDef | undefined, t: CircuitTuning): number {
  if (!(fn.store ?? 0)) return 0;
  const k = kindOf(fn);
  const per = fn.discharge ?? (k === 'k' ? t.discharge.bank : k === 'd' ? t.discharge.drive : k === 'w' ? t.discharge.weapon : t.discharge.general);
  return per * area * fnOutput(fn, m);
}

/** A store part's capacity */
export function partCapacity(fn: FunctionDef, area: number, m: MaterialDef | undefined): number {
  return (fn.store ?? 0) * area * fnOutput(fn, m);
}

export const CIRCUIT_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

export function powerLayout(a: CircuitInput): PowerLayout {
  const { fns, area, mats, alive, network, networks, tuning } = a;
  const n = fns.length;
  const ct = circuitTuning(tuning);
  const joins = a.joins.filter(([x, y]) => alive[x] && alive[y]);
  const isStore = (i: number) => alive[i] && (fns[i].store ?? 0) > 0;
  const isBank = (i: number) => isStore(i) && !!fns[i].bank;
  // (A Pulse Dynamo is part of the bank it touches: capacitors and dynamos touching each other are one Surge bank)
  const isDynamo = (i: number) => alive[i] && (fns[i].surge ?? 0) > 0;
  const inBank = (i: number) => isBank(i) || isDynamo(i);
  const isConsumer = (i: number) => alive[i] && (fns[i].demand ?? 0) > 0 && a.burst(i);

  // Banks: capacitors touching each other (union-find over the joins between them)
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (const [x, y] of joins) if (inBank(x) && inBank(y)) { const rx = find(x), ry = find(y); if (rx !== ry) parent[Math.max(rx, ry)] = Math.min(rx, ry); }
  const touching: number[][] = Array.from({ length: n }, () => []);
  for (const [x, y] of joins) { touching[x].push(y); touching[y].push(x); }

  // Circuits: one per network, then the loose one (parts on none) if anything there draws or banks
  const circuits: Circuit[] = networks.map((net, k) => ({
    net: k, letter: '', type: 'steady', parts: net.parts, supply: net.supply, spare: Math.max(0, net.supply - net.delivered),
    pools: { g: -1, d: -1, w: -1 }, banks: [], main: false, engineDraw: 0, gunDraw: 0, minerDraw: 0, generators: [], storeParts: [], consumers: [],
  }));
  let loose = -1;
  const looseIndex = () => {
    if (loose < 0) {
      loose = circuits.length;
      circuits.push({ net: -1, letter: '', type: 'steady', parts: [], supply: 0, spare: 0, pools: { g: -1, d: -1, w: -1 }, banks: [], main: false, engineDraw: 0, gunDraw: 0, minerDraw: 0, generators: [], storeParts: [], consumers: [] });
    }
    return loose;
  };
  const circuitOf = new Array<number>(n).fill(-1);
  for (let i = 0; i < n; i++) if (alive[i] && network[i] >= 0) circuitOf[i] = network[i];

  // Stores: each circuit's pools, then the banks
  const stores: StoreGroup[] = [];
  const storeOf = new Array<number>(n).fill(-1);
  const partCap = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (!isStore(i)) continue;
    partCap[i] = partCapacity(fns[i], area[i], mats[i]);
    if (isBank(i) || circuitOf[i] < 0) continue;
    const c = circuits[circuitOf[i]], k = kindOf(fns[i]) as 'g' | 'd' | 'w';
    if (c.pools[k] < 0) { c.pools[k] = stores.length; stores.push({ kind: k, circuit: circuitOf[i], parts: [], cap: 0, rate: 0 }); }
    const s = stores[c.pools[k]];
    s.parts.push(i); s.cap += partCap[i]; s.rate += partDischarge(fns[i], area[i], mats[i], ct);
    storeOf[i] = c.pools[k];
    c.storeParts.push(i);
  }
  const bankRoots = new Map<number, number>();
  const isShield = (i: number) => alive[i] && (fns[i].shield ?? 0) > 0;
  for (let i = 0; i < n; i++) {
    if (!inBank(i)) continue;
    const r = find(i);
    let b = bankRoots.get(r);
    if (b === undefined) {
      b = stores.length; bankRoots.set(r, b);
      stores.push({ kind: 'k', type: 'surge', circuit: -1, parts: [], cap: 0, rate: 0, feeds: [], surge: 0, shields: [], label: `S${bankRoots.size}` });
    }
    const s = stores[b];
    s.parts.push(i);
    if (isBank(i)) { s.cap += partCap[i]; s.rate += partDischarge(fns[i], area[i], mats[i], ct); }
    else s.surge! += fns[i].surge! * area[i] * (a.health?.[i] ?? 1);
    storeOf[i] = b;
    // (It charges from the circuit its first wired capacitor is on)
    if (s.circuit < 0 && isBank(i) && circuitOf[i] >= 0) s.circuit = circuitOf[i];
    for (const j of touching[i]) {
      if (isConsumer(j) && !s.feeds!.includes(j)) s.feeds!.push(j);
      if (isShield(j) && !s.shields!.includes(j)) s.shields!.push(j);
    }
  }
  for (const [, b] of bankRoots) {
    const s = stores[b];
    if (s.circuit < 0) s.circuit = looseIndex();
    for (const i of s.parts) if (circuitOf[i] < 0) circuitOf[i] = s.circuit;
    s.feeds!.sort((x, y) => x - y);
    s.shields!.sort((x, y) => x - y);
    circuits[s.circuit].banks.push(b);
    circuits[s.circuit].storeParts.push(...s.parts);
  }

  // Burst consumers: their feed group (their circuit, and the first bank they touch)
  const draw = new Array<number>(n).fill(0);
  const feedOf = new Array<number>(n).fill(-1);
  const feeds: PowerLayout['feeds'] = [];
  const feedKey = new Map<number, number>();
  const bankOfConsumer = new Map<number, number>();
  for (const s of stores.keys()) for (const j of stores[s].feeds ?? []) if (!bankOfConsumer.has(j)) bankOfConsumer.set(j, s);
  for (let i = 0; i < n; i++) {
    if (!isConsumer(i)) continue;
    draw[i] = partDemand(fns[i], area[i], mats[i]);
    const c = circuitOf[i] >= 0 ? circuitOf[i] : looseIndex();
    const bank = bankOfConsumer.get(i) ?? -1;
    const key = c * 4096 + bank + 1;
    let f = feedKey.get(key);
    if (f === undefined) { f = feeds.length; feedKey.set(key, f); feeds.push({ circuit: c, bank }); }
    feedOf[i] = f;
    if (circuitOf[i] < 0) circuitOf[i] = c;
    const cc = circuits[c];
    cc.consumers.push(i);
    // (A Burst Strafer is an engine that draws only while a burst runs: strafer.ts)
    if ((fns[i].thrust ?? 0) > 0 || fns[i].strafe) cc.engineDraw += draw[i];
    else if (fns[i].weapon) cc.gunDraw += draw[i];
    else cc.minerDraw += draw[i];
  }
  for (const c of circuits) if (c.net >= 0) c.generators = c.parts.filter((i) => alive[i] && (fns[i].produce ?? 0) > 0);

  // The main circuit: the one making the most (then holding the most, then the first)
  let main = -1;
  const held = (c: Circuit) => [c.pools.g, c.pools.d, c.pools.w, ...c.banks].reduce((t, s) => t + (s >= 0 ? stores[s].cap : 0), 0);
  circuits.forEach((c, k) => {
    if (c.net < 0 || (!c.generators.length && !c.storeParts.length && !c.consumers.length)) return;
    if (main < 0 || c.supply > circuits[main].supply + 1e-9 || (Math.abs(c.supply - circuits[main].supply) <= 1e-9 && held(c) > held(circuits[main]) + 1e-9)) main = k;
  });
  if (main >= 0) circuits[main].main = true;
  // Letters: the main circuit A, then the rest in order, skipping ones with no power role
  let next = 0;
  const order = main >= 0 ? [main, ...circuits.keys()].filter((k, j, all) => all.indexOf(k) === j) : [...circuits.keys()];
  for (const k of order) {
    const c = circuits[k];
    if (c.net < 0 || (!c.generators.length && !c.storeParts.length && !c.consumers.length)) continue;
    c.letter = CIRCUIT_LETTERS[next++ % CIRCUIT_LETTERS.length];
  }

  const dual: PowerLayout['dual'] = {};
  for (let i = 0; i < n; i++) if (alive[i] && fns[i].dual) dual[i] = fns[i].dual;
  const coreCap = a.core ? ((tuning as { energy?: { coreCapacity?: number } }).energy?.coreCapacity ?? 240) : 0;
  return {
    circuits,
    stores,
    core: a.core ? { cap: coreCap, rate: ct.coreDischarge, trickle: ct.coreTrickle, circuit: main } : null,
    feeds,
    feedOf,
    storeOf,
    draw,
    partCap,
    circuitOf,
    dual,
  };
}
