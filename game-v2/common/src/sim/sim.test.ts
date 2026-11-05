/**
 * Sim foundation contracts (Stage 0): the stepShip adapter flies today's paths to the bit (the golden flight traces,
 * replicaStep), the determinism harness passes them and catches what isn't deterministic, and the small contracts
 * (shot ids, timeline, ring, head hash, input slots) hold.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createShipState } from '../ships/state.js';
import { readShipJson, testCatalog } from '../ships/testData.js';
import type { ShipTuning } from '../ships/tuning.js';
import type { FlightBody } from '../ships/flight.js';
import { FULL_CHARGE } from '../ships/energy.js';
import { quantizeCargo } from '../ships/load.js';
import { towLoad, towTuning } from '../ships/features/tow/tow.js';
import { replicaStep, ReplicaMode, controlBits, CTL } from '../ships/replica.js';
import { NO_FIELDS } from '../ships/jumpFields.js';
import { quantizeCursorDist, CURSOR_DIST_STEP } from '../network/protocol.js';
import { SCENARIOS, corsair, bodyRow, chargeRow, hashRows, type Scenario } from '../ships/golden/testData.js';
import {
  stepShip, newSimShip, simAimQ, simAim, NO_INPUT, shotId, shotIdParts, SHOT_ID_TICKS, Timeline, AHEAD_BACK, hitStateTick,
  StateRing, shipHash, tickHash, cloneSimShip, headHashWord, headHashOfWord, headAgrees, HEAD_HASH_HELD, HEAD_HASH_ROW,
  InputSlots, ScriptedInputs, runDeterminism, assertDeterministic, eventKey, SIM_PHASES, runTick,
  type SimEnv, type SimInput, type SimShipState, type HarnessScenario, type StepShipFn, type TimelineClock,
} from './index.js';

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');
const pins = JSON.parse(readFileSync(join(__dirname, '../ships/golden/flightTraces.golden.json'), 'utf8')) as Record<string, { trace: string; charge: string }>;

const envAt = (t: number): SimEnv => ({ tick: t, tuning, gravity: null, fields: NO_FIELDS, terrain: null });

function inputOf(t: Scenario['script'][number]): SimInput {
  return { bits: controlBits(t.keys), q: simAimQ(t.aim), jumpDist: quantizeCursorDist(t.dist ?? 0) * CURSOR_DIST_STEP, fire: false, fireAlt: false, aimDist: 0 };
}

function start(sc: Scenario, id = 1, accounted = true): SimShipState {
  const ship = createShipState(catalog, tuning, id, sc.ship(), 0);
  const body: FlightBody = { x: 0, y: 0, vx: 0, vy: 0, angle: -Math.PI / 2, angVel: 0, jump: 0, cargo: sc.cargo ?? 0 };
  return newSimShip({ id, derived: ship.derived, ship, body, charge: FULL_CHARGE, accounted });
}

/** The tow scenario's load arrives mid-run (golden flightTraces.test.ts): a state edit both runs make alike */
function towEdit(sc: Scenario, s: SimShipState, i: number): void {
  if (!sc.tow || i < sc.tow.from) return;
  const d = s.structure.derived;
  const towed = towLoad(createShipState(catalog, tuning, 2, corsair(), 0).derived.mass, Math.max(d.mass, d.fullMass ?? d.mass), towTuning(tuning));
  s.guns.tow = 2;
  s.body.cargo = quantizeCargo((sc.cargo ?? 0) + towed);
}

describe('stepShip adapter flies today\'s paths to the bit', () => {
  for (const sc of SCENARIOS) {
    it(`golden pilot trace: ${sc.name}`, () => {
      let s = start(sc);
      const rows: number[][] = [], charges: number[][] = [];
      sc.script.forEach((t, i) => {
        towEdit(sc, s, i);
        s = stepShip(s, inputOf(t), envAt(i + 1)).state;
        rows.push(bodyRow(s.body));
        charges.push(chargeRow(s.charge));
      });
      expect(hashRows(rows)).toBe(pins[sc.name].trace);
      expect(hashRows(charges)).toBe(pins[sc.name].charge);
    });
  }

  it('an unaccounted Player state is today\'s replicaStep', () => {
    const sc = SCENARIOS.find((x) => x.name === 'plain-thrust-turn')!;
    let s = start(sc, 1, false);
    const body: FlightBody = { ...s.body };
    sc.script.forEach((t, i) => {
      const inp = inputOf(t);
      s = stepShip(s, inp, envAt(i + 1)).state;
      replicaStep(ReplicaMode.Player, body, { bits: inp.bits, targetAngle: simAim(inp.q) }, s.structure.derived, tuning, { gravity: null, central: null }, i + 1);
      expect(bodyRow(s.body)).toEqual(bodyRow(body));
    });
  });

  it('owns the hazard chain: an EMP from state cripples the drive and shows in the flown bits', () => {
    const sc = SCENARIOS.find((x) => x.name === 'plain-thrust-turn')!;
    const a = start(sc), b = start(sc);
    b.hazard.empUntil = 30;
    let sa = a, sb = b;
    for (let t = 1; t <= 40; t++) {
      sa = stepShip(sa, inputOf(sc.script[t - 1]), envAt(t)).state;
      sb = stepShip(sb, inputOf(sc.script[t - 1]), envAt(t)).state;
      if (t < 30) expect(sb.ctl.bits & CTL.emp).toBe(CTL.emp);
    }
    expect(sb.ctl.bits & CTL.emp).toBe(0);
    expect(bodyRow(sb.body)).not.toEqual(bodyRow(sa.body));
  });

  it('does not touch prev unless asked to step in place', () => {
    const sc = SCENARIOS[0];
    const s = start(sc), h = shipHash(s);
    const r = stepShip(s, inputOf(sc.script[0]), envAt(1));
    expect(shipHash(s)).toBe(h);
    expect(r.state).not.toBe(s);
    const same = stepShip(s, inputOf(sc.script[0]), envAt(1), s);
    expect(same.state).toBe(s);
    expect(shipHash(s)).toBe(shipHash(r.state));
  });
});

/** A scenario of several ships: golden scripts as pilots (one unaccounted), a pilotless one, a pull phase */
function crowd(): HarnessScenario {
  const ships: HarnessScenario['ships'] = [];
  SCENARIOS.forEach((sc, k) => {
    const s = start(sc, 10 + k, k % 3 !== 2);
    s.body.x = k * 400;
    ships.push({ state: s, input: (t) => (t - 1 < sc.script.length ? inputOf(sc.script[t - 1]) : NO_INPUT) });
  });
  const ai = start(SCENARIOS[0], 3);
  ai.mode = ReplicaMode.Pilotless;
  ai.accounted = false;
  ships.push({ state: ai, input: (t) => ({ ...NO_INPUT, bits: CTL.forward, q: simAimQ(t / 50), impulse: t % 40 === 0 ? [0.25, -0.125] : undefined }) });
  return {
    name: 'crowd', start: 0, ticks: 240, ships, env: envAt,
    phases: {
      // (A stand-in world phase: ship 3 tugs the lowest pilot toward it, worked out from last tick's states)
      pulls: (c) => {
        const from = c.prev.get(3)!, to = c.states.get(10)!;
        const dx = from.body.x - to.body.x, dy = from.body.y - to.body.y;
        to.body.vx += Math.sign(dx) * 0.01;
        to.body.vy += Math.sign(dy) * 0.01;
        c.events.push({ k: 'pull', tick: c.tick, target: 10, from: 3, dvx: Math.sign(dx) * 0.01, dvy: Math.sign(dy) * 0.01 });
      },
    },
  };
}

describe('determinism harness', () => {
  it('PT and ST agree to the bit on every golden script, re-stepped and worker-copied', () => {
    for (const sc of SCENARIOS) {
      const s = start(sc);
      const r = runDeterminism({ name: sc.name, start: 0, ticks: sc.script.length, ships: [{ state: s, input: (t) => inputOf(sc.script[t - 1]) }], env: envAt });
      assertDeterministic(r);
      expect(r.tickHashes.length).toBe(sc.script.length);
    }
  });

  it('a crowd with pilotless ships, impulses and a world phase', () => {
    const r = runDeterminism(crowd(), { lag: 6, rollbackEvery: 5, rollbackDepth: 8 });
    assertDeterministic(r);
    expect(new Set(r.tickHashes).size).toBeGreaterThan(200);
    expect([...r.events.values()].flat().some((e) => e.k === 'pull')).toBe(true);
  });

  it('catches a stepper that keeps hidden state', () => {
    let calls = 0;
    const leaky: StepShipFn = (prev, input, env, out, events) => {
      const r = stepShip(prev, input, env, out, events);
      if (++calls === 150) r.state.body.vx += 1e-4;
      return r;
    };
    const sc = SCENARIOS[0];
    const r = runDeterminism({ name: 'leaky', start: 0, ticks: 120, ships: [{ state: start(sc), input: (t) => inputOf(sc.script[t - 1]) }], env: envAt }, { step: leaky });
    expect(r.mismatch).toBeDefined();
    expect(r.mismatch!.path).toBe('state.body.vx');
  });

  it('catches a stepper that writes into the state it stepped from', () => {
    const aliasing: StepShipFn = (prev, input, env, out, events) => {
      const r = stepShip(prev, input, env, out, events);
      // (Shares prev's array and bumps it: the tick before is changed under the ring, so a re-step comes out otherwise)
      prev.guns.cooldown[0] = (prev.guns.cooldown[0] ?? 0) + 1;
      r.state.guns.cooldown = prev.guns.cooldown;
      return r;
    };
    const sc = SCENARIOS[0];
    const r = runDeterminism({ name: 'alias', start: 0, ticks: 60, ships: [{ state: start(sc), input: (t) => inputOf(sc.script[t - 1]) }], env: envAt }, { step: aliasing });
    expect(r.mismatch).toBeDefined();
  });
});

describe('shot ids', () => {
  it('are collision-free over owners, slots, barrels and a wrap window of ticks', () => {
    const seen = new Set<number>();
    for (const owner of [0, 1, 7, 4095, (1 << 20) - 1]) for (const tick of [0, 1, 59, 1000, SHOT_ID_TICKS - 1]) for (const slot of [0, 1, 31, 254]) for (const barrel of [0, 1, 31]) {
      const id = shotId(owner, tick, slot, barrel);
      expect(Number.isSafeInteger(id)).toBe(true);
      expect(seen.has(id)).toBe(false);
      seen.add(id);
      expect(shotIdParts(id)).toEqual({ tick16: tick, owner, slot, barrel });
    }
    expect(shotId(5, 100, 3, 0)).toBe(shotId(5, 100 + SHOT_ID_TICKS, 3, 0));
  });

  it('refuse what they cannot pack', () => {
    expect(() => shotId(1 << 20, 0, 0, 0)).toThrow(RangeError);
    expect(() => shotId(1, 0, 256, 0)).toThrow(RangeError);
    expect(() => shotId(1, 0, 0, 32)).toThrow(RangeError);
    expect(eventKey({ k: 'fire', tick: 3, owner: 1, slot: 2, barrel: 0, shot: shotId(1, 3, 2, 0), aimQ: 0 })).toBe(`f${shotId(1, 3, 2, 0)}`);
  });
});

describe('timeline', () => {
  const clock = (o: Partial<TimelineClock> = {}): TimelineClock => ({ predictionEnabled: true, confirmedTick: 100, predictedTick: 106, frameTick: 106.2, rawServerTick: 103.2, renderTick: 98.4, hasPrev: true, ...o });
  it('draws own things half a tick behind the prediction, decided ships AHEAD_BACK behind them, the rest interpolated', () => {
    const tl = new Timeline(clock());
    expect(tl.drawTick('own')).toBeCloseTo(105.7, 9);
    expect(tl.drawTick('ownShot')).toBe(tl.drawTick('own'));
    expect(tl.drawTick('ahead')).toBeCloseTo(105.7 - AHEAD_BACK, 9);
    expect(tl.drawTick('pilot')).toBe(98.4);
    expect(tl.drawTick('boss')).toBe(98.4);
    expect(tl.confirmed(100)).toBe(true);
    expect(tl.confirmed(101)).toBe(false);
  });
  it('without prediction everything is interpolated, own at the raw server tick', () => {
    const tl = new Timeline(clock({ predictionEnabled: false }));
    expect(tl.drawTick('own')).toBe(103.2);
    expect(tl.drawTick('ahead')).toBe(98.4);
  });
  it('hit-tests pilots at this tick, everyone else at the last', () => {
    expect(hitStateTick(50, true)).toBe(50);
    expect(hitStateTick(50, false)).toBe(49);
  });
});

describe('state ring, hashes, head hash, input slots, phases', () => {
  it('keeps copies, prunes to k, drops from a tick, and folds tick hashes by id', () => {
    const sc = SCENARIOS[0];
    const a = start(sc, 1), b = start(sc, 2);
    const ring = new StateRing(4);
    for (let t = 0; t < 10; t++) { ring.put(t, a); ring.put(t, b); a.body.x += 1; }
    expect(ring.get(1, 5)).toBeUndefined();
    expect(ring.get(1, 9)!.body.x).toBe(9);
    a.body.x = 1000;
    expect(ring.get(1, 9)!.body.x).toBe(9);
    expect(ring.tickHash(9)).toBe(tickHash([ring.get(2, 9)!, ring.get(1, 9)!]));
    ring.dropFrom(1, 8);
    expect(ring.last(1)).toBe(7);
    expect(ring.last(2)).toBe(9);
  });

  it('hashes what the contract lists and nothing else', () => {
    const s = start(SCENARIOS[0]);
    const h = shipHash(s);
    const c = cloneSimShip(s);
    expect(shipHash(c)).toBe(h);
    c.guns.clickAt = 5;
    expect(shipHash(c)).not.toBe(h);
    const r = cloneSimShip(s);
    r.accounted = false;
    const r2 = cloneSimShip(r);
    r2.charge.g = 3; // (an unaccounted charge isn't hashed)
    expect(shipHash(r2)).toBe(shipHash(r));
    const v = cloneSimShip(s);
    v.structure = { ...v.structure, version: 1 };
    expect(shipHash(v)).not.toBe(h);
  });

  it('head hash round-trips and compares only when it should', () => {
    const b = headHashWord({ own: 0xbeef, flags: HEAD_HASH_HELD });
    expect(b).toBeLessThan(2 ** 24);
    expect(headHashOfWord(b)).toEqual({ own: 0xbeef, flags: HEAD_HASH_HELD });
    expect(headAgrees(headHashOfWord(b), 0x1234beef)).toBe(true);
    expect(headAgrees(headHashOfWord(b), 0x1234beee)).toBe(false);
    expect(headAgrees(headHashOfWord(b), undefined)).toBe(false);
    expect(headAgrees({ own: 1, flags: HEAD_HASH_HELD | HEAD_HASH_ROW }, 2)).toBe(true);
    expect(headAgrees({ own: 1, flags: 0 }, 2)).toBe(true);
  });

  it('possess swaps a source in and release puts the old one back', () => {
    const slots = new InputSlots();
    const ai = new ScriptedInputs('decided', () => NO_INPUT), admin = new ScriptedInputs('known', () => ({ ...NO_INPUT, bits: CTL.forward }));
    slots.set(7, ai);
    slots.possess(7, admin);
    expect(slots.get(7)).toBe(admin);
    expect(slots.possessed(7)).toBe(true);
    slots.release(7);
    expect(slots.get(7)).toBe(ai);
  });

  it('runs phases in the one order whatever order the table is written in', () => {
    const seen: string[] = [];
    runTick({ contacts: () => seen.push('contacts'), pilots: () => seen.push('pilots'), quantize: () => seen.push('quantize'), pilotless: () => seen.push('pilotless') }, null, 1);
    expect(seen).toEqual(['pilots', 'pilotless', 'contacts', 'quantize']);
    expect(SIM_PHASES.indexOf('pilots')).toBeLessThan(SIM_PHASES.indexOf('shots'));
    expect(SIM_PHASES.indexOf('shots')).toBeLessThan(SIM_PHASES.indexOf('pilotless'));
  });
});
