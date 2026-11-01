/**
 * The energy tick (power/tick.ts; docs/design/energy-routing-impl.md §1.3-1.5, §0 D2/D3), on the prototype's scenarios
 * (prototypes/energy-lab): Takes and Gives limits, local priority, a Diode guarding an engine's store, the Ion boost,
 * the Burst Strafer, the whole-clip latch and Reload, a beam's burn and rest, the charge gate, dynamos, tools; then
 * 10k ticks of a bundled ship twice, bit for bit.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { FunctionDef } from '../types.js';
import { parseBlueprint } from '../blueprint.js';
import { SHIP_DATA_DIR } from '../testData.js';
import {
  GUN_BEAM, GUN_CLIP, NO_FILL_BOUND, ROLE_GEN, ROLE_RELAY, ROLE_THRUSTER, ROLE_WEAPON, type EnergyLayout, buildEnergyLayout, PHASE_THRUST, PHASE_WEAPON,
} from './layout.js';
import { type EnergyState, FLAG_LATCH, FLAG_LIT, createEnergyState, energyGauge, remapEnergy } from './state.js';
import {
  type EnergyControls, IDLE_CONTROLS, SETTLE_TICKS, beamStep, clipRounds, drawFromRelays, energyTick, genLeft, gunReady, settleEnergy, spendShot,
  stepThrustersFree, thrustFrac, thrustMul,
} from './tick.js';
import { packEnergy } from './wire.js';
import { perTick, perTickUp, toEu } from './units.js';
import { type PartSpec, blueprintInput, genFn, layoutInput, layoutOf, storeFn } from './testData.js';

const ctl = (o: Partial<EnergyControls> = {}): EnergyControls => ({ ...IDLE_CONTROLS, ...o });
const activeFor = (L: EnergyLayout, parts: number[]) => { const a = new Uint8Array(L.n); for (const p of parts) a[p] = 1; return a; };

/** A gun's mechanical beat (a cooldown that only counts down) over the energy gate: fires when its cooldown is out and it is ready */
class Gun {
  cd = 0;
  shots: number[] = [];
  constructor(readonly L: EnergyLayout, readonly e: EnergyState, readonly p: number, readonly interval: number) {}
  step(t: number, trigger = true): void {
    if (this.cd > 0) this.cd--;
    if (trigger && this.cd === 0 && gunReady(this.L, this.e, this.p)) { spendShot(this.L, this.e, this.p); this.cd = this.interval; this.shots.push(t); }
  }
}

function setup(specs: PartSpec[]) {
  const L = layoutOf(specs), e = createEnergyState(L);
  return { L, e };
}

const GEN = genFn('t_gen', 35), BIG = genFn('t_big', 400);

/** A dense design: every kind of node, every cell touching four (generators, stores, Conduits, Diodes, a dynamo, guns of each buffer kind, engines, strafers, shields) */
function dense(): PartSpec[] {
  const BAT = storeFn('t_bat', 300, 150, 50), CON = storeFn('t_conduit', 10, 200, 200), DIODE = storeFn('t_diode', 10, 200, 200, true);
  const kinds: (string | FunctionDef)[] = [GEN, BAT, 'cannon_pip', 'engine_ion_drive', CON, 'legendary_hive', DIODE, 'shield_deflector', BAT,
    'autocannon_stinger', 'engine_burst_strafer', 'power_pulse_dynamo', 'core', 'engine_afterburner'];
  const out: PartSpec[] = [];
  let core = false;
  for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) {
    let k = kinds[(x * 5 + y * 3) % kinds.length];
    if (k === 'core') { if (core) k = BAT; core = true; }
    out.push(['sq', k, x, y, (['N', 'E', 'S', 'W'] as const)[(x + y) % 4]]);
  }
  out.push(['rect2', 'laser_cutter', 0, -1, 'N'], ['rect2', 'cannon_longbarrel', 4, -1, 'N']);
  return out;
}

describe('energy tick: stores', () => {
  it('fills a store no faster than its Takes, and gives no faster than its Gives (Generator > Battery > Pip)', () => {
    const BAT = storeFn('t_bat', 300, 10, 50);
    const { L, e } = setup([['sq', genFn('t_oc', 124), 0, 0], ['sq', BAT, 1, 0], ['sq', 'cannon_pip', 2, 0, 'E']]);
    e.held[1] = 0;
    for (let t = 0; t < 60; t++) energyTick(L, e, IDLE_CONTROLS);
    expect(e.held[1]).toBe(perTick(50) * 60);
    // Fed through a Battery that Gives 10 E/s, a Pip (20 E/s) fires every 30 ticks, not 15
    e.held[1] = L.cap[1];
    const g = new Gun(L, e, 2, 15);
    for (let t = 0; t < 600; t++) { energyTick(L, e, IDLE_CONTROLS); g.step(t); }
    expect(g.shots.length).toBeGreaterThanOrEqual(19);
    expect(g.shots.length).toBeLessThanOrEqual(21);
  });

  it('keeps a gun on its beat at full supply (D3): a Pip every 15 ticks, a Rattler every 7', () => {
    for (const [fn, interval] of [['cannon_pip', 15], ['autocannon_rattler', 7]] as const) {
      const { L, e } = setup([['sq', GEN, 0, 0], ['sq', fn, 1, 0, 'E']]);
      const g = new Gun(L, e, 1, interval);
      for (let t = 0; t < 600; t++) { energyTick(L, e, IDLE_CONTROLS); g.step(t); }
      const gaps = g.shots.slice(1).map((s, i) => s - g.shots[i]);
      expect(new Set(gaps)).toEqual(new Set([interval]));
    }
  });

  it('serves the thrusters first from what they share (local priority), so a gun on an engine\'s store only starves it by draining the store', () => {
    const BAT = storeFn('t_bat', 300, 15, 50);
    const run = (withGun: boolean) => {
      const { L, e } = setup([['sq', 'cannon_pip', 0, 0, 'N'], ['sq', BAT, 1, 0], ['sq', 'engine_ion_drive', 2, 0, 'S']]);
      const g = new Gun(L, e, 0, 15), c = ctl({ active: activeFor(L, [2]) });
      const frac: number[] = [];
      for (let t = 0; t < 1800; t++) { energyTick(L, e, c); frac.push(thrustFrac()[2]); g.step(t, withGun); }
      return { frac, shots: g.shots.length };
    };
    const gun = run(true), alone = run(false);
    // While the Battery holds anything the engine gets its fill first (Gives 15: the engine its 9, the Pip the rest)
    expect(Math.min(...gun.frac.slice(0, 18 * 60))).toBe(1);
    expect(gun.shots).toBeGreaterThan(0);
    // The gun empties the Battery at ~15 E/s (20 s), the engine alone at 9 E/s (33 s): at 25 s one is dry, the other isn't
    expect(gun.frac[25 * 60]).toBeLessThan(0.9);
    expect(alone.frac[25 * 60]).toBe(1);
  });

  it('lets a Diode guard an engine\'s store: power passes towards the engine, never back to the guns', () => {
    const BAT = storeFn('t_bat', 300, 150, 50), DIODE = storeFn('t_diode', 10, 200, 200, true), CONDUIT = storeFn('t_conduit', 10, 200, 200);
    const build = (mid: FunctionDef) => setup([
      ['sq', 'cannon_pip', 0, 0, 'N'], ['sq', BAT, 1, 0], ['sq', mid, 2, 0, 'E'], ['sq', BAT, 3, 0], ['sq', 'engine_ion_drive', 4, 0, 'S'],
    ]);
    const firing = (mid: FunctionDef) => {
      const { L, e } = build(mid), g = new Gun(L, e, 0, 15);
      for (let t = 0; t < 1200; t++) { energyTick(L, e, IDLE_CONTROLS); g.step(t); }
      return { L, e };
    };
    const d = firing(DIODE), c = firing(CONDUIT);
    expect(d.e.held[1]).toBeLessThan(d.L.cap[1]);
    expect(d.e.held[3]).toBe(d.L.cap[3]);
    expect(c.e.held[3]).toBeLessThan(c.L.cap[3]);
    // The other way: the engine draws its store down and the guns' store tops it up through the diode, the engine
    // never short, every tick's flow along both pairs (1-2, 2-3) towards the engine
    const { L, e } = build(DIODE), on = ctl({ active: activeFor(L, [4]) });
    expect(Array.from(L.pairA, (a, x) => [a, L.pairB[x], L.pairDir[x]])).toEqual([[1, 2, 1], [2, 3, 1]]);
    const trace = new Float64Array(L.links), total = [0, 0];
    for (let t = 0; t < 600; t++) {
      trace.fill(0);
      energyTick(L, e, on, trace);
      expect(thrustFrac()[4]).toBe(1);
      for (let x = 0; x < 2; x++) { expect(trace[L.linkPair + x]).toBeGreaterThanOrEqual(0); total[x] += trace[L.linkPair + x]; }
    }
    expect(total[0]).toBeGreaterThan(0);
    expect(total[1]).toBeGreaterThan(0);
    expect(e.held[1]).toBeLessThan(L.cap[1]);
  });

  it('feeds a gun through a Diode facing it (ticked): the stores behind it pay for the shots', () => {
    const BAT = storeFn('t_bat', 300, 150, 50), DIODE = storeFn('t_diode', 10, 200, 200, true);
    const { L, e } = setup([['sq', BAT, 0, 0], ['sq', DIODE, 1, 0, 'S'], ['sq', BAT, 2, 0], ['sq', 'cannon_pip', 1, 1, 'S']]);
    const g = new Gun(L, e, 3, 15), trace = new Float64Array(L.links);
    for (let t = 0; t < 600; t++) { energyTick(L, e, IDLE_CONTROLS, trace); g.step(t); }
    // On its beat (40 shots of 5 E: far more than the diode's 10 E), drawn from both stores through the diode only
    expect(g.shots.length).toBe(40);
    expect([L.linkFrom[0], L.linkTo[0], L.linkPush]).toEqual([1, 3, 1]);
    expect(trace[0]).toBeGreaterThan(toEu(150));
    expect(e.held[0]).toBeLessThan(L.cap[0]);
    expect(e.held[2]).toBeLessThan(L.cap[2]);
  });

  it('tops up the stores a Pulse Dynamo touches, with no generator', () => {
    const { L, e } = setup([['sq', 'power_pulse_dynamo', 0, 0], ['sq', storeFn('t_bat', 300, 150, 50), 1, 0]]);
    e.held[1] = 0;
    for (let t = 0; t < 60; t++) energyTick(L, e, IDLE_CONTROLS);
    expect(e.held[1]).toBe(perTick(10) * 60);
  });

  it('lets several generators waterfill one store, within its Takes', () => {
    const run = (takes: number) => {
      const { L, e } = setup([['sq', GEN, 0, 1], ['sq', storeFn('t_bat', 300, 150, takes), 1, 1], ['sq', GEN, 2, 1], ['sq', GEN, 1, 0]]);
      e.held[1] = 0;
      energyTick(L, e, IDLE_CONTROLS);
      return { got: e.held[1], waste: genLeft()[0] + genLeft()[2] + genLeft()[3] };
    };
    const tight = run(50);
    expect(tight.got).toBe(perTick(50));
    expect(tight.waste).toBe(3 * perTick(35) - perTick(50));
    const open = run(200);
    expect(open.got).toBe(3 * perTick(35));
    expect(open.waste).toBe(0);
  });

  it('fills a chain of stores (two hops and more from the generator) exactly, so a full ship sends nothing', () => {
    const BAT = storeFn('t_bat', 300, 150, 50), CON = storeFn('t_con', 10, 200, 200), BANK = storeFn('t_bank', 1200, 100, 150);
    const kinds = [BAT, BAT, CON, BAT, BANK];
    // Then downstream first in part order (so the pairs run against the flow)
    for (const forward of [true, false]) {
      const specs: PartSpec[] = [['sq', GEN, forward ? 0 : 5, 0], ...kinds.map((k, i): PartSpec => ['sq', k, forward ? i + 1 : 4 - i, 0])];
      const { L, e } = setup(specs);
      for (let p = 1; p < L.n; p++) e.held[p] = 0;
      for (let t = 0; t < 600 * 60; t++) energyTick(L, e, IDLE_CONTROLS);
      expect(Array.from(e.held)).toEqual(Array.from(L.cap));
      expect(e.gauge).toBe(L.gaugeMax);
      expect(packEnergy(L, e, [])).toBe(0);
    }
  });

  it('never bounces the last gap back and forth when nothing feeds the stores', () => {
    // The generator is all the shield's, so the two stores only even out between themselves
    const BAT = storeFn('t_bat', 300, 150, 50);
    const { L, e } = setup([['sq', genFn('t_small', 8), 0, 0], ['sq', 'shield_deflector', 0, 1], ['sq', BAT, 1, 0], ['sq', BAT, 2, 0]]);
    expect([L.depth[2], L.depth[3]]).toEqual([0, 1]);
    e.held[3] = L.cap[3] - 1;
    energyTick(L, e, IDLE_CONTROLS);
    const after = Array.from(e.held);
    for (let t = 0; t < 120; t++) { energyTick(L, e, IDLE_CONTROLS); expect(Array.from(e.held)).toEqual(after); }
    expect(after[2] + after[3]).toBe(L.cap[2] + L.cap[3] - 1);
  });

  it('gives tools their share, and the shields theirs together', () => {
    const { L, e } = setup([['sq', genFn('t_small', 8), 0, 0], ['sq', 'shield_deflector', 1, 0], ['sq', 'shield_deflector', 5, 0]]);
    energyTick(L, e, IDLE_CONTROLS);
    // One shield gets 8 of its 16, the other (touching nothing) none
    expect(e.sat[1]).toBe(Math.round((255 * perTick(8)) / perTick(16)));
    expect(e.sat[2]).toBe(0);
    expect(e.shieldSat).toBe(Math.round((255 * perTick(8)) / (2 * perTick(16))));
    const want = new Int32Array(L.n);
    energyTick(L, e, ctl({ toolWant: want }));
    expect([e.sat[1], e.shieldSat]).toEqual([255, 255]);
  });
});

describe('energy tick: thrusters', () => {
  it('runs an Ion Drive at full boost for ~1.8 s, then at the better of cruise and boost (never slower than cruising)', () => {
    const { L, e } = setup([['sq', GEN, 0, 0], ['sq', 'engine_ion_drive', 1, 0, 'S']]);
    const c = ctl({ active: activeFor(L, [1]), boosting: true });
    let full = 0;
    const after: number[] = [];
    for (let t = 0; t < 600; t++) {
      energyTick(L, e, c);
      const thrust = thrustFrac()[1] * thrustMul()[1];
      if (t === full && thrustMul()[1] === 2 && thrustFrac()[1] === 1) full++;
      else if (t > 150) after.push(thrust);
    }
    expect(full / 60).toBeGreaterThan(1.7);
    expect(full / 60).toBeLessThan(1.9);
    expect(Math.min(...after)).toBeGreaterThanOrEqual(1);
    expect(after.reduce((s, v) => s + v, 0) / after.length).toBeGreaterThan(1);
    // Cruising it never runs dry (intake 12 over burn 9)
    const k = ctl({ active: activeFor(L, [1]) });
    for (let t = 0; t < 600; t++) { energyTick(L, e, k); expect(thrustFrac()[1]).toBe(1); }
    expect(e.held[1]).toBe(L.cap[1] - L.burn[1]);
  });

  it('gives a Burst Strafer one full dodge, then ~6%, then refills in 3.5 s', () => {
    const { L, e } = setup([['sq', BIG, 0, 0], ['sq', 'engine_burst_strafer', 1, 0, 'E']]);
    const on = ctl({ active: activeFor(L, [1]) });
    const burst = () => { const f: number[] = []; for (let t = 0; t < 12; t++) { energyTick(L, e, on); f.push(thrustFrac()[1]); } return f; };
    expect(Math.min(...burst())).toBeGreaterThan(0.99);
    const dry = burst().slice(2);
    for (const f of dry) { expect(f).toBeGreaterThan(0.05); expect(f).toBeLessThan(0.07); }
    let t = 0;
    while (e.held[1] < L.cap[1] && t < 1000) { energyTick(L, e, IDLE_CONTROLS); t++; }
    expect(t / 60).toBeGreaterThan(3.4);
    expect(t / 60).toBeLessThan(3.6);
  });

  it('steps replicas\' thrusters alone, their intake assumed met', () => {
    const { L, e } = setup([['sq', 'engine_ion_drive', 0, 0, 'S']]);
    const c = ctl({ active: activeFor(L, [0]), boosting: true });
    for (let t = 0; t < 600; t++) stepThrustersFree(L, e, c);
    expect(thrustMul()[0] * thrustFrac()[0]).toBeGreaterThanOrEqual(1);
    expect(e.held[0]).toBeLessThan(L.cap[0]);
  });
});

describe('energy tick: weapons', () => {
  it('keeps a clip a true magazine: no top-up while it has rounds, Reload refills the whole clip, empty it latches for 1.5 s (Twinlink)', () => {
    const { L, e } = setup([['sq', BIG, 0, 0], ['rect2', 'cannon_twinlink', 1, 0, 'E']]);
    expect(L.gun[1]).toBe(GUN_CLIP);
    const g = new Gun(L, e, 1, 6);
    let t = 0;
    for (; g.shots.length < 5; t++) { energyTick(L, e, IDLE_CONTROLS); g.step(t); }
    expect(clipRounds(L, e, 1)).toBe(11);
    for (let k = 0; k < 300; k++) energyTick(L, e, IDLE_CONTROLS);
    expect(clipRounds(L, e, 1)).toBe(11);
    expect(e.flags[1]).toBe(0);
    // Reload: latched, it can't fire until the whole clip is back
    energyTick(L, e, ctl({ reload: true }));
    expect(e.flags[1] & FLAG_LATCH).toBe(FLAG_LATCH);
    expect(gunReady(L, e, 1)).toBe(false);
    let k = 1;
    while (e.flags[1] & FLAG_LATCH) { energyTick(L, e, IDLE_CONTROLS); k++; }
    expect(e.held[1]).toBe(L.cap[1]);
    expect(k).toBe(Math.ceil((5 * L.shot[1]) / perTickUp(55)));
    // Fired dry it latches itself, and the whole clip takes today's reload (90 ticks)
    const h = new Gun(L, e, 1, 6);
    t = 0;
    while (h.shots.length < 16) { energyTick(L, e, IDLE_CONTROLS); h.step(t++); }
    expect(e.flags[1] & FLAG_LATCH).toBe(FLAG_LATCH);
    let wait = 0;
    while (!gunReady(L, e, 1)) { energyTick(L, e, IDLE_CONTROLS); wait++; expect(wait).toBeLessThan(200); }
    expect(wait).toBe(90);
  });

  it('gates a clip on a whole salvo (the Hive looses 4): short of one and unlatched, it latches itself and refills', () => {
    const { L, e } = setup([['sq', BIG, 0, 0], ['sq', 'legendary_hive', 1, 0, 'E']]);
    expect(L.rounds[1]).toBe(4);
    expect(gunReady(L, e, 1)).toBe(true);
    expect(spendShot(L, e, 1)).toBe(4 * L.shot[1]);
    expect(clipRounds(L, e, 1)).toBe(4);
    expect(e.flags[1]).toBe(0);
    // Three rounds (an unpacked row, a remap): not a salvo, so it latches rather than sticking
    e.held[1] = 3 * L.shot[1];
    expect(gunReady(L, e, 1)).toBe(false);
    expect(gunReady(L, e, 1, 1)).toBe(true);
    energyTick(L, e, IDLE_CONTROLS);
    expect(e.flags[1] & FLAG_LATCH).toBe(FLAG_LATCH);
    while (e.flags[1] & FLAG_LATCH) energyTick(L, e, IDLE_CONTROLS);
    expect(clipRounds(L, e, 1)).toBe(8);
    // Two salvos empty it, and the second latches it
    spendShot(L, e, 1);
    expect(e.flags[1]).toBe(0);
    spendShot(L, e, 1);
    expect([e.held[1], e.flags[1] & FLAG_LATCH]).toEqual([0, FLAG_LATCH]);
  });

  it('latches a clip that comes back empty (a repaired gun) without Reload', () => {
    const { L, e } = setup([['sq', BIG, 0, 0], ['sq', 'legendary_hive', 1, 0, 'E']]);
    e.held[1] = 0;
    energyTick(L, e, IDLE_CONTROLS);
    expect(e.flags[1] & FLAG_LATCH).toBe(FLAG_LATCH);
    while (e.flags[1] & FLAG_LATCH) energyTick(L, e, IDLE_CONTROLS);
    expect(clipRounds(L, e, 1)).toBe(8);
  });

  it('burns a beam while lit, rests it when dry, and relights it at half its buffer (Cutter: 3.6 s on, 2.25 s off)', () => {
    const { L, e } = setup([['sq', BIG, 0, 0], ['rect2', 'laser_cutter', 1, 0, 'E']]);
    expect(L.gun[1]).toBe(GUN_BEAM);
    const runs: [boolean, number][] = [];
    for (let t = 0; t < 900; t++) {
      energyTick(L, e, IDLE_CONTROLS);
      const on = beamStep(L, e, 1, true) > 0;
      if (runs.length && runs[runs.length - 1][0] === on) runs[runs.length - 1][1]++; else runs.push([on, 1]);
    }
    expect(runs[0][0]).toBe(true);
    expect(runs[0][1] / 60).toBeCloseTo(3.6, 1);
    expect(runs[1][0]).toBe(false);
    expect(runs[1][1] / 60).toBeCloseTo(2.25, 1);
    expect(runs[2][1] / 60).toBeCloseTo(1.8, 1);
    // Let go, it goes out; nothing is spent
    const held = e.held[1];
    expect(beamStep(L, e, 1, false)).toBe(0);
    expect(e.flags[1] & FLAG_LIT).toBe(0);
    expect(e.held[1]).toBe(held);
  });

  it('gates a charge gun on a paid shot: a Longbarrel is ready again in 3.5 s (charge 120 + cooldown 90)', () => {
    const { L, e } = setup([['sq', BIG, 0, 0], ['rect2', 'cannon_longbarrel', 1, 0, 'E']]);
    expect(gunReady(L, e, 1)).toBe(true);
    expect(spendShot(L, e, 1)).toBe(toEu(385));
    let t = 0;
    while (!gunReady(L, e, 1)) { energyTick(L, e, IDLE_CONTROLS); t++; }
    expect(t).toBe(210);
  });

  it('pays a one-off draw (Flash) from the relays feeding a part, fullest first, or all or nothing', () => {
    const BAT = storeFn('t_bat', 300, 150, 50);
    const { L, e } = setup([['sq', BAT, 0, 0], ['sq', 'shield_flash_screen', 1, 0], ['sq', BAT, 2, 0], ['sq', BAT, 1, 1]]);
    e.held[0] = 1000; e.held[2] = 3000; e.held[3] = 0;
    expect(drawFromRelays(L, e, 1, 2500)).toBe(2500);
    expect([e.held[0], e.held[2], e.held[3]]).toEqual([1000, 500, 0]);
    expect(drawFromRelays(L, e, 1, 5000, true)).toBe(0);
    expect([e.held[0], e.held[2]]).toEqual([1000, 500]);
    expect(drawFromRelays(L, e, 1, 5000)).toBe(1500);
    expect(e.gauge).toBe(energyGauge(L, e));
    // (not a consumer: nothing)
    expect(drawFromRelays(L, e, 0, 10)).toBe(0);
  });
});

describe('energy state', () => {
  it('keeps what each part held over a rebuild of the same design (a lost part empties), and starts a refit full', () => {
    const specs: PartSpec[] = [['sq', GEN, 0, 0], ['sq', storeFn('t_bat', 300, 150, 50), 1, 0], ['sq', 'cannon_pip', 2, 0, 'E']];
    const L = layoutOf(specs), e = createEnergyState(L);
    e.held[1] = 1000;
    const hurt = layoutOf(specs, [true, true, false]);
    remapEnergy(e, hurt, true);
    expect([e.held[1], e.held[2]]).toEqual([1000, 0]);
    remapEnergy(e, L, true);
    expect(e.held[2]).toBe(0);
    remapEnergy(e, L, false);
    expect(Array.from(e.held)).toEqual(Array.from(L.cap));
  });

  it('keeps a beam\'s flags over a rebuild of the same design, a clip only its latch, and clears the rest', () => {
    const specs: PartSpec[] = [['sq', BIG, 0, 0], ['rect2', 'laser_cutter', 1, 0, 'E'], ['rect2', 'cannon_twinlink', 0, 1, 'E'], ['sq', storeFn('t_bat', 300, 150, 50), 3, 0]];
    const L = layoutOf(specs), e = createEnergyState(L);
    e.flags[1] = FLAG_LIT | FLAG_LATCH; e.flags[2] = FLAG_LIT | FLAG_LATCH; e.flags[3] = FLAG_LATCH;
    remapEnergy(e, layoutOf(specs), true);
    expect([e.flags[1], e.flags[2], e.flags[3]]).toEqual([FLAG_LIT | FLAG_LATCH, FLAG_LATCH, 0]);
  });

  it('settles a sleeping ship: some ticks simulated, then everything a generator reaches full', () => {
    const { L, e } = setup([['sq', GEN, 0, 0], ['sq', storeFn('t_bat', 300, 150, 50), 1, 0], ['sq', storeFn('t_bat2', 300, 150, 50), 5, 5]]);
    e.held[1] = 0; e.held[2] = 0;
    expect(L.fillBound).toBeLessThan(100000);
    expect(settleEnergy(L, e, 10 * L.fillBound)).toBe(600);
    expect(e.held[1]).toBe(L.cap[1]);
    expect(e.held[2]).toBe(0);
    expect(e.gauge).toBe(energyGauge(L, e));
  });

  it('settles with its tools asleep (a full shield wants nothing), so shields wanting more than the plant still let it fill', () => {
    const specs: PartSpec[] = [
      ['sq', GEN, 0, 0], ['sq', storeFn('t_bat', 300, 150, 50), 1, 0], ['sq', 'shield_deflector', 0, 1], ['sq', 'shield_deflector', 1, 1], ['sq', 'shield_deflector', 2, 0],
    ];
    const { L, e } = setup(specs);
    expect(L.fillBound).toBeLessThan(NO_FILL_BOUND);
    e.held[1] = 0;
    settleEnergy(L, e, 100000);
    expect(e.held[1]).toBe(L.cap[1]);
    // Awake, every shield at its full rate, it doesn't fill
    const awake = setup(specs);
    awake.e.held[1] = 0;
    settleEnergy(awake.L, awake.e, 600, IDLE_CONTROLS);
    expect(awake.e.held[1]).toBeLessThan(awake.L.cap[1] / 100);
  });

  it('never reloads a partly spent clip that isn\'t latched when it settles (D2), but fills a latched one', () => {
    const { L, e } = setup([['sq', BIG, 0, 0], ['rect2', 'cannon_twinlink', 1, 0, 'E'], ['rect2', 'cannon_twinlink', 0, 1, 'E']]);
    for (let k = 0; k < 5; k++) { spendShot(L, e, 1); spendShot(L, e, 2); }
    e.flags[2] |= FLAG_LATCH;
    settleEnergy(L, e, 10 * Math.max(L.fillBound, SETTLE_TICKS));
    expect(clipRounds(L, e, 1)).toBe(11);
    expect(e.flags[1]).toBe(0);
    expect(e.held[2]).toBe(L.cap[2]);
    expect(e.flags[2]).toBe(0);
  });
});

describe('energy tick: conservation', () => {
  it('moves only what the trace says: a buffer changes by its links in less out, a generator gives its output less its waste', () => {
    const L = buildEnergyLayout(layoutInput(dense())), e = createEnergyState(L);
    // Half of everything gone, nothing pushing or firing (so a buffer's only change is its links)
    for (let p = 0; p < L.n; p++) e.held[p] = Math.floor(L.cap[p] / 2);
    const trace = new Float64Array(L.links), net = new Float64Array(L.n), gOut = new Float64Array(L.n);
    let moved = 0;
    for (let t = 0; t < 300; t++) {
      const before = Array.from(e.held);
      trace.fill(0); net.fill(0); gOut.fill(0);
      energyTick(L, e, IDLE_CONTROLS, trace);
      for (let x = 0; x < L.links; x++) {
        // (a pair's is signed, from pairA to pairB)
        const v = trace[x], from = L.linkFrom[x], to = L.linkTo[x];
        net[to] += v; net[from] -= v;
        if (L.role[from] === ROLE_GEN) gOut[from] += v;
        moved += Math.abs(v);
      }
      for (let p = 0; p < L.n; p++) {
        const r = L.role[p];
        if (r === ROLE_RELAY || r === ROLE_WEAPON || r === ROLE_THRUSTER) expect(e.held[p] - before[p]).toBe(net[p]);
        if (r === ROLE_GEN) expect(gOut[p]).toBe(L.rate[p] - genLeft()[p]);
      }
    }
    expect(moved).toBeGreaterThan(0);
  });
});

describe('energy tick: determinism', () => {
  // (a ship routed by touch: generators, stores and guns linked, so serve, push and the pairs all run)
  const bp = parseBlueprint(readFileSync(join(SHIP_DATA_DIR, 'blueprints', 'sparrow-t.json'), 'utf-8'));

  /** 10k ticks of a scripted fight: thrust (some engines) on and off, boost bursts, every gun on its beat, Reload now and then */
  function fight(L: EnergyLayout): { hash: number; e: EnergyState } {
    const e = createEnergyState(L);
    const thr = Array.from(L.cons.subarray(L.phase[PHASE_THRUST], L.phase[PHASE_THRUST + 1]));
    const wpn = Array.from(L.cons.subarray(L.phase[PHASE_WEAPON], L.phase[PHASE_WEAPON + 1]));
    const active = new Uint8Array(L.n), c = ctl({ active });
    const cd = new Int32Array(L.n);
    let h = 0x811c9dc5 | 0;
    for (let t = 0; t < 10000; t++) {
      for (let x = 0; x < thr.length; x++) active[thr[x]] = (t >> 6) % 3 !== 0 && (x + (t >> 9)) % 2 === 0 ? 1 : 0;
      c.boosting = t % 700 < 120;
      c.reload = t % 997 === 0;
      energyTick(L, e, c);
      const firing = t % 2400 < 1500;
      for (const p of wpn) {
        if (L.gun[p] === GUN_BEAM) { beamStep(L, e, p, firing); continue; }
        if (cd[p] > 0) cd[p]--;
        if (firing && cd[p] === 0 && gunReady(L, e, p)) { spendShot(L, e, p); cd[p] = 6 + (p % 13); }
      }
      for (let p = 0; p < L.n; p++) h = Math.imul(h ^ e.held[p] ^ (e.flags[p] << 24), 0x01000193);
      h = Math.imul(h ^ Math.round(thrustFrac()[thr[0] ?? 0] * 1e6), 0x01000193);
    }
    return { hash: h, e };
  }

  for (const [name, input] of [['a dense design', () => layoutInput(dense())], ['a bundled ship', () => blueprintInput(bp)]] as const) {
    it(`runs 10k ticks of ${name} bit-identically twice`, () => {
      const L1 = buildEnergyLayout(input()), L2 = buildEnergyLayout(input());
      expect(L2).toEqual(L1);
      const a = fight(L1), b = fight(L2);
      expect(b.hash).toBe(a.hash);
      expect(Array.from(b.e.held)).toEqual(Array.from(a.e.held));
      // (and something actually moved)
      expect(Array.from(a.e.held)).not.toEqual(Array.from(L1.cap));
      expect(L1.pushRelay.length + L1.pairA.length).toBeGreaterThan(0);
    });
  }
});
