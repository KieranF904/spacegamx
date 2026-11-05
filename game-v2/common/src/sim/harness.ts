/**
 * The determinism harness (sim foundation, Stage 0; a test utility, pure, no vitest import).
 *
 * Runs a scenario twice with perfect input knowledge and requires bit-identical states, hashes and events every tick:
 *   PT  steps every tick as it comes, each ship into a fresh copy (stepShip without `out`), keeps a StateRing, and
 *       every `rollbackEvery` ticks rolls the last `rollbackDepth` ticks back and steps them again (a correction
 *       with nothing actually wrong must change nothing)
 *   ST  runs `lag` ticks behind, steps in place (out === prev), and copies its states through structuredClone
 *       between ticks (per-tick state must be plain data: a worker can step it)
 * Each tick runs through runTick (phases.ts): 'pilots' (Player mode, ascending id), 'pilotless' (every other mode),
 * then the scenario's own phases (contacts, pulls not in the step, ...) on both runs.
 *
 * Usage (a Stage 1 section's test):
 *   const r = runDeterminism({ name, start: 0, ticks: 300, ships: [{ state, input: (t) => ... }], env: (t) => env });
 *   expect(r.mismatch).toBeUndefined();          // or: assertDeterministic(r)
 * `opts.step` swaps the stepper (a section's own), `scenario.phases` adds world phases (C: contacts, pulls).
 */

import { cloneSimShip, type SimShipState } from './state.js';
import type { SimInput } from './input.js';
import type { SimEnv, StepShipFn } from './env.js';
import { eventKey, type SimEvent } from './events.js';
import { StateRing, shipHash } from './ring.js';
import { runTick, type PhaseTable } from './phases.js';
import { stepShip } from './step.js';
import { ReplicaMode } from '../ships/replica.js';

/** What a scenario's own phases get each tick */
export interface HarnessTick {
  tick: number;
  env: SimEnv;
  /** This tick's states by id (after the ships phases: stepped to `tick`), mutable */
  states: Map<number, SimShipState>;
  /** The states the tick stepped from (tick - 1), read-only */
  prev: ReadonlyMap<number, Readonly<SimShipState>>;
  events: SimEvent[];
}

export interface HarnessScenario {
  name: string;
  /** The tick the initial states are at; the first stepped tick is start + 1 */
  start: number;
  ticks: number;
  ships: { state: SimShipState; input: (t: number) => SimInput }[];
  env: (t: number) => SimEnv;
  /** World phases after the ships ('pulls', 'contacts', ...): must be deterministic in what they're given */
  phases?: PhaseTable<HarnessTick>;
}

export interface HarnessOpts {
  step?: StepShipFn;
  /** ST's lag behind PT, ticks (default 4) */
  lag?: number;
  rollbackEvery?: number;
  rollbackDepth?: number;
}

export interface HarnessMismatch {
  tick: number;
  id: number;
  /** 'state.body.x', 'hash', 'events' ... */
  path: string;
  pt: unknown;
  st: unknown;
  /** Which comparison: PT against ST, or a PT tick against itself re-stepped */
  between: 'pt-st' | 'pt-restep';
}

export interface HarnessReport {
  name: string;
  ticks: number;
  /** PT's tick hash per stepped tick (start + 1 ..) */
  tickHashes: number[];
  /** Per ship, its hash at each stepped tick */
  shipHashes: Map<number, number[]>;
  mismatch?: HarnessMismatch;
  /** Events PT produced, by tick (for a section's own checks) */
  events: Map<number, SimEvent[]>;
}

/** Every leaf of a state as [path, value] (structure: its version only), for an exact (Object.is) compare */
export function flattenState(s: Readonly<SimShipState>): [string, unknown][] {
  const out: [string, unknown][] = [];
  const walk = (v: unknown, path: string) => {
    if (v !== null && typeof v === 'object') {
      if (ArrayBuffer.isView(v)) { const a = v as unknown as ArrayLike<number>; out.push([`${path}.length`, a.length]); for (let i = 0; i < a.length; i++) out.push([`${path}[${i}]`, a[i]]); return; }
      if (Array.isArray(v)) { out.push([`${path}.length`, v.length]); v.forEach((x, i) => walk(x, `${path}[${i}]`)); return; }
      for (const k of Object.keys(v).sort()) { if ((v as Record<string, unknown>)[k] !== undefined) walk((v as Record<string, unknown>)[k], `${path}.${k}`); }
      return;
    }
    out.push([path, v]);
  };
  const { structure, ...rest } = s;
  walk(rest, 'state');
  out.push(['state.structure.version', structure.version]);
  return out;
}

/** The first differing leaf of two states, or null */
export function diffStates(a: Readonly<SimShipState>, b: Readonly<SimShipState>): { path: string; a: unknown; b: unknown } | null {
  const fa = flattenState(a), fb = flattenState(b);
  const n = Math.max(fa.length, fb.length);
  for (let i = 0; i < n; i++) {
    const x = fa[i], y = fb[i];
    if (!x || !y || x[0] !== y[0]) return { path: x?.[0] ?? y![0], a: x?.[1], b: y?.[1] };
    if (!Object.is(x[1], y[1])) return { path: x[0], a: x[1], b: y[1] };
  }
  if (a.structure !== b.structure && a.structure.version === b.structure.version) return { path: 'state.structure (same version, another object)', a: 'ref', b: 'ref' };
  return null;
}

/** (structuredClone: in every engine we run; common's lib settings don't declare it) */
const clonePlain = <T>(v: T): T => (globalThis as unknown as { structuredClone<U>(x: U): U }).structuredClone(v);

/** A copy as a worker would get it: structuredClone of the per-tick part, the structure re-attached by reference */
function workerCopy(s: SimShipState): SimShipState {
  const { structure, ...rest } = s;
  return { ...clonePlain(rest), structure };
}

const isPilot = (s: Readonly<SimShipState>) => s.mode === ReplicaMode.Player;

/** One tick of every ship and the scenario's phases. `inPlace`: step into the prev objects (ST) */
function tickAll(sc: HarnessScenario, step: StepShipFn, prev: Map<number, SimShipState>, t: number, inPlace: boolean): { states: Map<number, SimShipState>; events: SimEvent[] } {
  const env = sc.env(t);
  const ids = [...prev.keys()].sort((a, b) => a - b);
  const states = new Map<number, SimShipState>();
  const events: SimEvent[] = [];
  const inputOf = new Map(sc.ships.map((x) => [x.state.id, x.input]));
  // (Stepping in place overwrites prev: the phases get it as it was)
  const before = inPlace ? new Map([...prev].map(([id, s]) => [id, cloneSimShip(s)])) : prev;
  const ctx: HarnessTick = { tick: t, env, states, prev: before, events };
  const shipsPhase = (pilots: boolean) => () => {
    for (const id of ids) {
      const p = prev.get(id)!;
      if (isPilot(p) !== pilots) continue;
      states.set(id, step(p, inputOf.get(id)!(t), env, inPlace ? p : undefined, events).state);
    }
  };
  runTick<HarnessTick>({ ...sc.phases, pilots: shipsPhase(true), pilotless: shipsPhase(false) }, ctx, t);
  return { states, events };
}

const keysOf = (ev: SimEvent[]) => ev.map(eventKey).join(',');

export function runDeterminism(sc: HarnessScenario, opts: HarnessOpts = {}): HarnessReport {
  const step = opts.step ?? stepShip;
  const lag = opts.lag ?? 4, every = opts.rollbackEvery ?? 7, depth = opts.rollbackDepth ?? 5;
  const ring = new StateRing(Math.max(64, lag + depth + 2));
  const report: HarnessReport = { name: sc.name, ticks: sc.ticks, tickHashes: [], shipHashes: new Map(), events: new Map() };
  for (const x of sc.ships) { ring.put(sc.start, x.state); report.shipHashes.set(x.state.id, []); }
  const ptEvents = new Map<number, string>();
  const fromRing = (t: number) => {
    const m = new Map<number, SimShipState>();
    for (const x of sc.ships) m.set(x.state.id, ring.get(x.state.id, t) as SimShipState);
    return m;
  };
  const fail = (m: HarnessMismatch) => { report.mismatch = m; return report; };

  // ST's own copies, stepped in place
  let st = new Map(sc.ships.map((x) => [x.state.id, workerCopy(cloneSimShip(x.state))]));
  let stTick = sc.start;
  const stUpTo = (to: number): HarnessMismatch | undefined => {
    while (stTick < to) {
      const t = stTick + 1;
      const r = tickAll(sc, step, st, t, true);
      for (const [id, s] of r.states) {
        const pt = ring.get(id, t)!;
        const d = diffStates(pt, s);
        if (d) return { tick: t, id, path: d.path, pt: d.a, st: d.b, between: 'pt-st' };
        if (ring.hash(id, t) !== shipHash(s)) return { tick: t, id, path: 'hash', pt: ring.hash(id, t), st: shipHash(s), between: 'pt-st' };
      }
      if (keysOf(r.events) !== ptEvents.get(t)) return { tick: t, id: -1, path: 'events', pt: ptEvents.get(t), st: keysOf(r.events), between: 'pt-st' };
      st = new Map([...r.states].map(([id, s]) => [id, workerCopy(s)]));
      stTick = t;
    }
    return undefined;
  };

  const end = sc.start + sc.ticks;
  for (let t = sc.start + 1; t <= end; t++) {
    const r = tickAll(sc, step, fromRing(t - 1), t, false);
    for (const [, s] of r.states) ring.put(t, s);
    ptEvents.set(t, keysOf(r.events));
    report.events.set(t, r.events);
    // A correction with nothing wrong: roll back and step again, the same states must come out
    if (every > 0 && (t - sc.start) % every === 0) {
      const from = Math.max(sc.start + 1, t - depth + 1);
      const keep = new Map<number, Map<number, [SimShipState, number]>>();
      for (let u = from; u <= t; u++) keep.set(u, new Map(sc.ships.map((x) => [x.state.id, [cloneSimShip(ring.get(x.state.id, u)!), ring.hash(x.state.id, u)!]])));
      for (const x of sc.ships) ring.dropFrom(x.state.id, from);
      for (let u = from; u <= t; u++) {
        const rr = tickAll(sc, step, fromRing(u - 1), u, false);
        for (const [id, s] of rr.states) {
          const [was, h] = keep.get(u)!.get(id)!;
          const d = diffStates(was, s);
          if (d) return fail({ tick: u, id, path: d.path, pt: d.a, st: d.b, between: 'pt-restep' });
          if (h !== shipHash(s)) return fail({ tick: u, id, path: 'hash', pt: h, st: shipHash(s), between: 'pt-restep' });
          ring.put(u, s);
        }
        if (keysOf(rr.events) !== ptEvents.get(u)) return fail({ tick: u, id: -1, path: 'events', pt: ptEvents.get(u), st: keysOf(rr.events), between: 'pt-restep' });
      }
    }
    report.tickHashes.push(ring.tickHash(t));
    for (const x of sc.ships) report.shipHashes.get(x.state.id)!.push(ring.hash(x.state.id, t)!);
    const m = stUpTo(t - lag);
    if (m) return fail(m);
  }
  const m = stUpTo(end);
  if (m) return fail(m);
  return report;
}

/** Throws with the first mismatch, readably */
export function assertDeterministic(r: HarnessReport): void {
  const m = r.mismatch;
  if (m) throw new Error(`${r.name}: ${m.between} mismatch at tick ${m.tick}, ship ${m.id}, ${m.path}: ${JSON.stringify(m.pt)} vs ${JSON.stringify(m.st)}`);
}
