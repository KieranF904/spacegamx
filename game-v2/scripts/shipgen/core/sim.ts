// Runs a design on the touch-routed power core (common/src/ships/power), as the review ships were checked: every gun on
// the trigger, engines pushing, tools at full, for N seconds. Each run is paired with an ideal one (the same graph with
// unlimited generation and relays), so a percentage is "of what this part could do", whatever its firing model.
import type { Blueprint, EnergyLayout, EnergyLayoutInput, ShipDerived, ShipTuning } from '../../../common/src/ships/index';
import {
  GUN_BEAM, ROLE_GEN, ROLE_RELAY, ROLE_THRUSTER, ROLE_TOOL, ROLE_WEAPON, beamStep, blueprintGeometry, buildEnergyLayout,
  createEnergyState, createShipState, energyTick, givesLeft, gunReady, isEngine, partMaterial, spendShot, thrustFrac, thrustMul,
} from '../../../common/src/ships/index';
import type { ShipgenContext } from './context';

export interface ShipEnergy {
  derived: ShipDerived;
  input: EnergyLayoutInput;
  L: EnergyLayout;
  /** Each weapon part's beat (ticks), as rebuild has it without the old flow's satisfaction */
  interval: Map<number, number>;
}

/** A design's energy layout, built from its rebuild as the power core's P2 rebuild will (power/testData.ts blueprintInput) */
export function shipEnergy(ctx: ShipgenContext, bp: Blueprint): ShipEnergy {
  const { catalog, tuning } = ctx;
  const d = createShipState(catalog, tuning, 1, bp, 0).derived;
  const geoms = blueprintGeometry(catalog, bp);
  const minSat = (tuning as ShipTuning).flow.minWeaponSatisfaction;
  const weapons = d.weapons.map((w) => ({ part: w.part, fire: w.fire, interval: w.interval * Math.max(w.satisfaction, minSat) }));
  const input: EnergyLayoutInput = {
    fns: bp.parts.map((p) => catalog.functions.get(p.fn)!), area: geoms.map((g) => g.area), mats: bp.parts.map((p) => partMaterial(catalog, p)),
    alive: d.alive, joins: d.joins, core: d.root >= 0 && bp.parts[d.root].fn === 'core' ? d.root : -1, tuning, weapons, geoms,
  };
  return { derived: d, input, L: buildEnergyLayout(input), interval: new Map(weapons.map((w) => [w.part, Math.max(1, Math.round(w.interval))])) };
}

export interface RunOptions {
  seconds: number;
  /** Every gun on the trigger */
  guns: boolean;
  /** Main engines (thrust > 0) */
  engines: 'off' | 'cruise' | 'boost';
  /** Other thrusters (Burst Strafers, Gyros) held active */
  others: boolean;
  /** Also keep the totals as they stood after this many seconds (RunResult.early) */
  earlyAt?: number;
}

export interface RunResult {
  ticks: number;
  /** Per part: shots fired (a beam: ticks lit) */
  fired: Float64Array;
  /** Per part: Σ thrust share (× boost when boosting) over the ticks it was active */
  thrust: Float64Array;
  /** Per part (tools): Σ satisfaction (0..1) */
  sat: Float64Array;
  /** Per part (relays): ticks it gave all its Gives while holding charge (Gives-limited), and ticks it was empty */
  limited: Int32Array;
  empty: Int32Array;
  /** fired / thrust / sat after RunOptions.earlyAt seconds */
  early?: { ticks: number; fired: Float64Array; thrust: Float64Array; sat: Float64Array };
}

/** The same graph with unlimited generation and relays (consumers keep their own numbers) */
function idealLayout(L: EnergyLayout): EnergyLayout {
  const rate = L.rate.slice(), cap = L.cap.slice(), give = L.give.slice(), take = L.take.slice();
  for (let p = 0; p < L.n; p++) {
    if (L.role[p] === ROLE_GEN) rate[p] = 1e7;
    if (L.role[p] === ROLE_RELAY) { cap[p] = 5e8; give[p] = 1e7; take[p] = 1e7; }
  }
  return { ...L, rate, cap, give, take };
}

export function runEnergy(se: ShipEnergy, o: RunOptions, ideal = false): RunResult {
  const L = ideal ? idealLayout(se.L) : se.L, e = createEnergyState(L), n = L.n, fns = se.input.fns;
  const ticks = Math.round(o.seconds * 60);
  const fired = new Float64Array(n), thrust = new Float64Array(n), sat = new Float64Array(n);
  const limited = new Int32Array(n), empty = new Int32Array(n);
  const active = new Uint8Array(n);
  for (let p = 0; p < n; p++) {
    if (L.role[p] !== ROLE_THRUSTER) continue;
    if (isEngine(fns[p])) active[p] = o.engines !== 'off' ? 1 : 0;
    else active[p] = o.others ? 1 : 0;
  }
  const ctl = { active, boosting: o.engines === 'boost', toolWant: null, reload: false };
  const cd = new Int32Array(n);
  const earlyTick = o.earlyAt !== undefined ? Math.round(o.earlyAt * 60) : -1;
  let early: RunResult['early'];
  for (let t = 0; t < ticks; t++) {
    if (t === earlyTick) early = { ticks: t, fired: fired.slice(), thrust: thrust.slice(), sat: sat.slice() };
    energyTick(L, e, ctl);
    const frac = thrustFrac(), mul = thrustMul(), gl = givesLeft();
    for (let p = 0; p < n; p++) {
      const r = L.role[p];
      if (r === ROLE_THRUSTER && active[p]) thrust[p] += frac[p] * (ctl.boosting ? mul[p] : 1);
      else if (r === ROLE_TOOL) sat[p] += e.sat[p] / 255;
      else if (r === ROLE_RELAY) {
        if (e.held[p] <= 0) empty[p]++;
        else if (L.give[p] > 0 && gl[p] <= 0) limited[p]++;
      } else if (r === ROLE_WEAPON && o.guns) {
        if (L.gun[p] === GUN_BEAM) { if (beamStep(L, e, p, true) > 0) fired[p]++; continue; }
        if (cd[p] > 0) cd[p]--;
        if (cd[p] === 0 && gunReady(L, e, p)) { spendShot(L, e, p); cd[p] = se.interval.get(p) ?? 1; fired[p]++; }
      }
    }
  }
  if (earlyTick === ticks) early = { ticks, fired: fired.slice(), thrust: thrust.slice(), sat: sat.slice() };
  return { ticks, fired, thrust, sat, limited, empty, ...(early ? { early } : {}) };
}
