/**
 * The hangar's load test for a ports design (docs/design/energy-ports-2026-11.md §5; energy.ts `loadTest` is the pool
 * ships'): a few seconds of the ship's own power tick (portsTick, and the guns' gates portsGunReady / portsSpendShot /
 * portsBeamStep / portsMineStep) with the guns firing flat out, the engines boosting, or both, from every store full.
 *
 * Each consumer's share is measured against the same ship run beside it with unlimited power at its in ports (every
 * store kept full, every line carrying what the part taking from it is rated for): the shots fired, the ticks a beam
 * burns, the thrust, a tool's draw, real against ideal over a sliding window. Both runs fire on the same beat, so while
 * the power keeps up they agree exactly, and the first shot the real ship can't pay for is its brownout. A gun fed
 * straight from a reactor too small for it is short from the first second.
 *
 * Deterministic (integer eu, part order), so the hangar, a test and the server would agree. It allocates per call only.
 */

import type { ShipDerived } from '../rebuild.js';
import { averageInterval } from '../guns.js';
import { BROWNOUT } from '../energy.js';
import { EU, perTick } from './units.js';
import {
  P_RELAY, P_THRUSTER, P_TOOL, P_WEAPON, createPortsState, portsBeamStep, portsGauge, portsGunReady, portsLinkSend,
  portsMineStep, portsSpace, portsSpendShot, portsThrustFrac, portsThrustMul, portsTick, type PortsControls, type PortsLayout, type PortsState,
} from './ports.js';

export type PortsScenario = 'fire' | 'boost' | 'both';
export const PORTS_SCENARIOS: readonly PortsScenario[] = ['fire', 'boost', 'both'];
/** What each scenario does: guns firing flat out, the forward engines cruising or boosting */
export const PORTS_SCENARIO_USE: Record<PortsScenario, { fire: boolean; boost: boolean }> = {
  fire: { fire: true, boost: false },
  boost: { fire: false, boost: true },
  both: { fire: true, boost: true },
};
export const PORTS_TEST_SECONDS = 12;
/** A store counts as empty under this much of what the ship's stores hold */
const EMPTY = 0.05;
const TPS = 60;

export interface PortsLoadResult {
  scenario: PortsScenario;
  seconds: number;
  /** Per part: in use in this scenario (a gun firing, an engine pushing, a tool drawing) */
  used: Uint8Array;
  /** Per part: the lowest share of its full-power work it did over any of its windows (1 for a part not in use) */
  low: Float64Array;
  /** Per part: its share over the test's last stretch, once the stores have given what they had (what it settles to) */
  end: Float64Array;
  /** Per part: when it first fell short (BROWNOUT), seconds; -1 never */
  brownAt: Float64Array;
  /** The ship's first brownout (s, -1 none) and the part */
  firstBrown: number;
  firstPart: number;
  /** The lowest settled share among the guns, the engines and the tools in use (1: none short, or none in use) */
  guns: number;
  engines: number;
  tools: number;
  /** The stores (the core and every store, as the gauge): % at the end, the lowest %, when they fell under 5% (s, -1 never) */
  storeEnd: number;
  storeLow: number;
  storeEmptyAt: number;
  /** Per part: a store's fill at the end, 0..1; -1 for a part that isn't one */
  fill: Float64Array;
  /** Per link: E/s it carried on average over the test */
  flow: Float64Array;
}

/**
 * The same layout with unlimited power at every in port: each line carries what its taker's port is rated for, and a
 * touch block makes plenty. `extra`: per consumer, eu a tick its open in ports would bring (up to its own intake), given
 * straight into its buffer before each ideal tick (topUp)
 */
function idealLayout(L: PortsLayout): { L: PortsLayout; extra: Int32Array } {
  const linkCap = Int32Array.from(L.linkCap);
  for (const q of L.ports) if (q.dir === 0 && q.l >= 0) linkCap[q.l] = Math.max(linkCap[q.l], perTick(q.rate));
  const rate = Int32Array.from(L.rate), linked = new Int32Array(L.n);
  for (let i = 0; i < L.n; i++) {
    const r0 = L.role[i];
    if (r0 !== P_WEAPON && r0 !== P_THRUSTER && r0 !== P_TOOL) continue;
    let r = 0;
    for (let x = L.inStart[i]; x < L.inStart[i + 1]; x++) if (!L.linkAug[L.inLink[x]]) r += linkCap[L.inLink[x]];
    const own = L.intake[i];
    linked[i] = r;
    rate[i] = r0 === P_THRUSTER ? Math.max(L.rate[i], r) : Math.max(L.rate[i], Math.min(own || r, r) || own);
  }
  const extra = new Int32Array(L.n);
  for (const q of L.ports) if (q.dir === 0 && q.l < 0 && !q.aug) extra[q.part] += perTick(q.rate);
  for (let i = 0; i < L.n; i++) if (extra[i] > 0 && L.role[i] !== P_THRUSTER) extra[i] = Math.max(0, Math.min(extra[i], L.intake[i] - linked[i]));
  const touchOut = Int32Array.from(L.touchOut, (v) => (v > 0 ? 0x3fffffff : 0));
  return { L: { ...L, linkCap, rate, touchOut }, extra };
}
/** The ideal run's open in ports: what they would bring, into each consumer's buffer, before its tick */
function topUp(L: PortsLayout, e: PortsState, extra: Int32Array): void {
  for (const p of L.consumers) {
    if (extra[p] <= 0) continue;
    const s = portsSpace(L, e, p);
    e.held[p] += s < extra[p] ? s : extra[p];
  }
}

/** One run's own state: the ports state and the guns' timers */
interface Run { L: PortsLayout; e: PortsState; cd: Float64Array; chg: Int32Array; ideal: boolean }

/** The guns firing flat out for a tick (guns.ts's beat: a cycle gun on its interval, a clip's salvo, a charge gun charging while it holds its shot, a beam burning); returns per part the work done (shots, beam ticks, a mining pulse's fulfilment) */
function fireTick(d: ShipDerived, run: Run, work: Float64Array): void {
  const { L, e } = run;
  for (const w of d.weapons) {
    const p = w.part, f = w.fire;
    if (L.role[p] !== P_WEAPON) continue;
    if (L.gun[p] === 3) { work[p] = portsBeamStep(L, e, p, true) > 0 ? 1 : 0; continue; }
    if (L.shot[p] <= 0) continue;
    if (run.cd[p] > 0) run.cd[p] -= 1;
    if (run.cd[p] > 0) continue;
    if (f.model === 'charge') {
      if (!portsGunReady(L, e, p)) continue;
      if (++run.chg[p] < (f.charge ?? 60)) continue;
      run.chg[p] = 0;
      portsSpendShot(L, e, p, 1);
      work[p] = 1;
      run.cd[p] = f.cooldown ?? w.interval;
      continue;
    }
    const n = f.model === 'clip' ? L.rounds[p] || 1 : 1;
    if (!portsGunReady(L, e, p, n)) continue;
    portsSpendShot(L, e, p, n);
    work[p] = n;
    // (fired on time it keeps the fraction of a tick it was late by, as guns.ts does)
    run.cd[p] = (run.cd[p] > -1 ? run.cd[p] : 0) + (f.model === 'clip' ? w.interval : averageInterval(f, w.interval));
  }
  for (const p of L.tools) if (L.miner[p]) { const s = portsMineStep(L, e, p, true); work[p] = s < 0 ? 0 : s; }
}

/** A part's window: a second, or three of a slow gun's beats, so a shot or two late reads as a share and not as nothing */
function windowOf(d: ShipDerived, L: PortsLayout, p: number): number {
  const w = d.weapons.find((x) => x.part === p);
  if (!w || L.gun[p] === 3) return 2 * TPS;
  const f = w.fire;
  const beat = f.model === 'clip' ? w.interval * Math.max(1, f.clip ?? 1) + (f.reload ?? 60) : f.model === 'charge' ? (f.charge ?? 60) + (f.cooldown ?? w.interval) : averageInterval(f, w.interval);
  return Math.max(2 * TPS, Math.ceil(3 * beat));
}

/** `seconds` of the scenario from every store full (see the file's comment). Pool ships (no `d.ports`) get null */
export function portsLoadTest(d: ShipDerived, scenario: PortsScenario, seconds = PORTS_TEST_SECONDS): PortsLoadResult | null {
  const L = d.ports;
  if (!L) return null;
  const use = PORTS_SCENARIO_USE[scenario], n = L.n, ticks = Math.max(1, Math.round(seconds * TPS));
  const real: Run = { L, e: createPortsState(L), cd: new Float64Array(n), chg: new Int32Array(n), ideal: false };
  const { L: LI, extra } = idealLayout(L);
  const ideal: Run = { L: LI, e: createPortsState(LI), cd: new Float64Array(n), chg: new Int32Array(n), ideal: true };
  // (The forward engines push in every scenario: cruising while firing, boosting otherwise)
  const active = new Uint8Array(n);
  for (const t of d.thrusters) if (t.force[1] < -1e-9 && L.role[t.part] === P_THRUSTER) active[t.part] = 1;
  const ctl: PortsControls = { active, boosting: use.boost, toolWant: null, reload: false };

  const used = new Uint8Array(n);
  for (let p = 0; p < n; p++) {
    if (L.role[p] === P_THRUSTER) used[p] = active[p];
    else if (L.role[p] === P_TOOL) used[p] = L.miner[p] ? (use.fire ? 1 : 0) : 1;
    else if (L.role[p] === P_WEAPON) used[p] = use.fire && (L.shot[p] > 0) ? 1 : 0;
  }
  const win = new Int32Array(n);
  for (let p = 0; p < n; p++) if (used[p]) win[p] = L.role[p] === P_WEAPON ? windowOf(d, L, p) : TPS;
  const lastStretch = Math.max(3 * TPS, ...Array.from(win)), endFrom = Math.max(0, ticks - Math.min(ticks, lastStretch));
  // Per part, per tick: the work each run did (ring buffers over each part's window, as running sums)
  const workR = new Float64Array(n), workI = new Float64Array(n);
  const histR: Float64Array[] = [], histI: Float64Array[] = [];
  for (let p = 0; p < n; p++) { histR.push(new Float64Array(win[p] || 1)); histI.push(new Float64Array(win[p] || 1)); }
  const sumR = new Float64Array(n), sumI = new Float64Array(n), endR = new Float64Array(n), endI = new Float64Array(n);
  const low = new Float64Array(n).fill(1), brownAt = new Float64Array(n).fill(-1);
  const flowSum = new Float64Array(L.links);
  let storeLow = 100, storeEmptyAt = -1;
  const pct = (e: PortsState) => (L.gaugeMax > 0 ? (100 * e.gauge) / L.gaugeMax : 100);

  for (let t = 0; t < ticks; t++) {
    for (const r of LI.relays) ideal.e.held[r] = LI.cap[r];
    topUp(LI, ideal.e, extra);
    for (const run of [real, ideal]) {
      const work = run.ideal ? workI : workR;
      work.fill(0);
      portsTick(run.L, run.e, ctl);
      if (!run.ideal) { const s = portsLinkSend(); for (let l = 0; l < L.links; l++) flowSum[l] += s[l]; }
      const frac = portsThrustFrac(), mul = portsThrustMul();
      for (const p of L.thrusters) if (active[p]) work[p] = Math.min(frac[p] * mul[p], 64);
      for (const p of L.tools) if (!L.miner[p]) work[p] = run.e.sat[p] / 255;
      if (use.fire) fireTick(d, run, work);
    }
    const g = pct(real.e);
    if (g < storeLow) storeLow = g;
    if (storeEmptyAt < 0 && L.gaugeMax > 0 && g < 100 * EMPTY) storeEmptyAt = t / TPS;
    for (let p = 0; p < n; p++) {
      if (!used[p]) continue;
      const W = win[p], k = t % W, hr = histR[p], hi = histI[p];
      sumR[p] += workR[p] - hr[k]; sumI[p] += workI[p] - hi[k]; hr[k] = workR[p]; hi[k] = workI[p];
      if (t >= endFrom) { endR[p] += workR[p]; endI[p] += workI[p]; }
      const s = sumI[p] > 1e-9 ? Math.min(1, sumR[p] / sumI[p]) : 1;
      if (s < low[p]) low[p] = s;
      if (brownAt[p] < 0 && s < BROWNOUT) brownAt[p] = t / TPS;
    }
  }

  const end = new Float64Array(n).fill(1);
  let firstBrown = -1, firstPart = -1, guns = 1, engines = 1, tools = 1;
  for (let p = 0; p < n; p++) {
    if (!used[p]) continue;
    end[p] = endI[p] > 1e-9 ? Math.min(1, endR[p] / endI[p]) : 1;
    if (brownAt[p] >= 0 && (firstBrown < 0 || brownAt[p] < firstBrown)) { firstBrown = brownAt[p]; firstPart = p; }
    const r = L.role[p];
    if (r === P_WEAPON || (r === P_TOOL && L.miner[p])) guns = Math.min(guns, end[p]);
    else if (r === P_THRUSTER) engines = Math.min(engines, end[p]);
    else tools = Math.min(tools, end[p]);
  }
  const fill = new Float64Array(n).fill(-1);
  for (const r of L.relays) fill[r] = L.cap[r] > 0 ? real.e.held[r] / L.cap[r] : 0;
  const flow = Float64Array.from(flowSum, (v) => (v * TPS) / EU / ticks);
  real.e.gauge = portsGauge(L, real.e);
  return { scenario, seconds, used, low, end, brownAt, firstBrown, firstPart, guns, engines, tools, storeEnd: pct(real.e), storeLow, storeEmptyAt, fill, flow };
}

const cache = new WeakMap<PortsLayout, Partial<Record<PortsScenario, PortsLoadResult>>>();
/** portsLoadTest, kept per layout (the hangar asks for it on every redraw of its panel and overlay) */
export function portsLoadTestCached(d: ShipDerived, scenario: PortsScenario): PortsLoadResult | null {
  const L = d.ports;
  if (!L) return null;
  let c = cache.get(L);
  if (!c) cache.set(L, (c = {}));
  return (c[scenario] ??= portsLoadTest(d, scenario) ?? undefined) ?? null;
}

/** A part's role for the panel's words */
export const portsRoleOf = (L: PortsLayout, p: number): 'gun' | 'engine' | 'tool' | 'store' | 'other' =>
  L.role[p] === P_WEAPON || (L.role[p] === P_TOOL && L.miner[p]) ? 'gun' : L.role[p] === P_THRUSTER ? 'engine' : L.role[p] === P_TOOL ? 'tool' : L.role[p] === P_RELAY ? 'store' : 'other';
