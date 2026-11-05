/**
 * Stage 1A: every caller moves ships through the one stepper (step.ts). One script is flown through each caller's real
 * code (the server's pilot step bridge/flight.ts stepMovement and pilotless step bridge/pilotless.ts stepPilotless, each
 * on a small fake bridge; ShipClient.predict on the state it reads; replicaStep on the bits the server's step sent) and
 * through stepShip itself, with the hazard chain (env hazard, numb, slowed, EMP) and a stillstone's priming in play, and
 * every path must land on the same state, tick by tick. Plus the distant tier's cruise measurement (SimLod.ts), the aim
 * grid's round trip, and step.ts's own copies of CTL's bits.
 */

import { describe, it, expect } from 'vitest';
import { Input } from '../ecs/components.js';
import { createShipState, type ShipState } from '../ships/state.js';
import { readShipJson, testCatalog } from '../ships/testData.js';
import type { ShipTuning } from '../ships/tuning.js';
import type { FlightBody } from '../ships/flight.js';
import type { HazardFlight } from '../ships/hazards.js';
import type { ShipDerived } from '../ships/rebuild.js';
import { FULL_CHARGE, type Charge } from '../ships/energy.js';
import { warmthStage, WARMTH_STAGES } from '../ships/warmth.js';
import { replicaStep, ReplicaMode, controlBits, CTL, type ReplicaEnv } from '../ships/replica.js';
import { replicaAngle } from '../network/replication.js';
import { quantizeCursorAngle, dequantizeCursorAngle } from '../network/cursorState.js';
import { quantizeCursorDist, CURSOR_DIST_STEP } from '../network/protocol.js';
import { SCENARIOS, bodyRow, chargeRow, type Scenario } from '../ships/golden/testData.js';
import type { LodestoneData } from '../data/schemas.js';
import { stepShip, newSimShip, cloneCharge, simAim, CTL_STATE_BITS, type SimEnv, type SimShipState } from './index.js';
import { aimQ, pilotInput, gridAim } from './a-adapt.js';
import { stepMovement } from '../../../server/src/ships/bridge/flight.js';
import { stepPilotless } from '../../../server/src/ships/bridge/pilotless.js';
import { controllerInput } from '../../../server/src/ships/bridge/inputs.js';
import { cruiseOf } from '../../../server/src/ships/SimLod.js';
import { ShipClient } from '../../../client/src/ships/ShipClient.js';

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');

// The world: a stillstone where the ships start (priming), a hazard east of x = 40 (a pilot's env hazard)
const STONE: LodestoneData = { id: 'test-stone', position: { x: 0, y: 0 } };
const FIELDS = { central: null, lodestones: [STONE] };
const HAZARD_EAST: HazardFlight = { control: 0.85, driftAccel: 0.002, jump: 0.9, cap: 1 };
const hazardAt = (_d: ShipDerived, x: number) => (x > 40 ? HAZARD_EAST : undefined);
const REPLICA_ENV: ReplicaEnv = { gravity: null, central: null, lodestones: [STONE], hazard: hazardAt, terrain: null };
const simEnv = (t: number): SimEnv => ({ tick: t, tuning, gravity: null, fields: FIELDS, terrain: null, hazard: hazardAt });

// Hazard windows (ticks stepped into): EMP'd, slowed, numb with cold
const empAt = (t: number) => t >= 30 && t < 45;
const slowedAt = (t: number) => t >= 60 && t < 90;
const numbAt = (t: number) => t >= 100 && t < 140;
const COLD = warmthStage(10);
const EMP_END = 45, SLOW_END = 90;

const wireAim = (a: number) => Math.fround(dequantizeCursorAngle(quantizeCursorAngle(a)));
const distOf = (s: Scenario['script'][number]) => quantizeCursorDist(s.dist ?? 0) * CURSOR_DIST_STEP;

/** A fake bridge with what stepMovement and stepPilotless read: one ship, its body and charge kept here */
function fakeBridge(eid: number, ship: ShipState, body: FlightBody, charge: Charge) {
  let tick = 0, cold = WARMTH_STAGES[0];
  const st = { body: { ...body }, charge, tick: () => tick };
  const b = {
    bodies: new Map([[eid, ship]]), tuning,
    readBody: () => ({ ...st.body, jump: ship.jump, jumpScale: ship.jumpScale, cargo: ship.cargo, dodge: ship.dodge, dodgeDir: ship.dodgeDir }),
    writeBody: (_e: number, s: ShipState, x: FlightBody) => {
      st.body = { x: x.x, y: x.y, vx: x.vx, vy: x.vy, angle: x.angle, angVel: x.angVel };
      s.jump = x.jump ?? 0; s.jumpScale = x.jumpScale; s.cargo = x.cargo; s.dodge = x.dodge; s.dodgeDir = x.dodgeDir;
    },
    chargeOf: () => st.charge, setCharge: (_e: number, c: Charge) => { st.charge = c; }, charge: new Map<number, Charge>(),
    empUntil: new Map<number, number>(), slowedUntil: new Map<number, number>(),
    slowedTicksLeft: (e: number) => Math.max(0, (b.slowedUntil.get(e) ?? 0) - tick),
    isEmped: (e: number) => (b.empUntil.get(e) ?? -1) > tick,
    coldStage: () => cold,
    replicaCtl: new Map<number, { bits: number; q: number }>(),
    ownCauses: { add: () => {} },
    controllers: new Map(), autopilot: new Map(), pinned: new Map(), apHeading: new Map(),
    fireWeapons: () => {}, isJumping: () => false,
    host: {
      getTick: () => tick, gravityAt: () => null, terrainAt: () => null, jumpFields: () => FIELDS,
      hazardFlight: (_e: number, d: ShipDerived, x: number, y: number) => hazardAt(d, x),
      cargoMass: () => ship.cargo ?? 0,
    },
  };
  /** Set the tick being stepped into and its hazards (as the server's statuses would have them) */
  const at = (t: number) => {
    tick = t;
    if (empAt(t)) b.empUntil.set(eid, EMP_END); else b.empUntil.delete(eid);
    if (slowedAt(t)) b.slowedUntil.set(eid, SLOW_END); else b.slowedUntil.delete(eid);
    cold = numbAt(t) ? COLD : WARMTH_STAGES[0];
  };
  return { b: b as never, st, at };
}

const START: FlightBody = { x: 0, y: 0, vx: 0, vy: 0, angle: -Math.PI / 2, angVel: 0, jump: 0, cargo: 0 };

describe('every caller flies the one stepper (stepShip) to the same state', () => {
  for (const name of ['plain-thrust-turn', 'strafer-replay', 'drive-bank-boost']) {
    it(`a pilot: stepMovement, predict, replicaStep and stepShip agree tick by tick (${name}, hazards and priming in play)`, () => {
      const sc = SCENARIOS.find((s) => s.name === name)!;
      const eid = 7;
      const mk = () => createShipState(catalog, tuning, eid, sc.ship(), 0);
      // The server's pilot step
      const serverShip = mk();
      serverShip.cargo = 0;
      const server = fakeBridge(eid, serverShip, START, cloneCharge(FULL_CHARGE));
      // The pilot's prediction (ShipClient.predict with the state it reads)
      const clientShip = mk();
      const self = {
        store: { get: () => clientShip }, docked: false, berth: null, opts: { state: { entities: new Map() }, tuning },
        hazardFor: hazardAt, central: null, lodestones: [STONE], gravity: null, terrain: null, jump: undefined,
      };
      const predict = ShipClient.prototype.predict as (this: unknown, ...a: Parameters<ShipClient['predict']>) => Charge | null;
      const player = { id: eid, x: 0, y: 0, vx: 0, vy: 0, angle: START.angle, angVel: 0, jump: 0, cargoMass: 0, dodge: 0, dodgeDir: 0, jumpPrime: 0, warmth: 100, empUntil: 0, slowUntil: 0 } as Record<string, number>;
      let clientCharge = cloneCharge(FULL_CHARGE);
      // A replica on the bits the server's step sent, and stepShip itself
      const replica: FlightBody = { ...START };
      let direct: SimShipState = newSimShip({ id: eid, derived: mk().derived, ship: mk(), body: START, charge: FULL_CHARGE });
      let primed = 0;
      sc.script.forEach((s, i) => {
        const t = i + 1;
        // Server: the keys in the Input component, as the wire leaves them
        server.at(t);
        const keys = { ...s.keys };
        for (const k of ['forward', 'backward', 'left', 'right', 'boost', 'helm', 'strafeLeft', 'strafeRight', 'jump', 'dodge'] as const) (Input as unknown as Record<string, number[]>)[k][eid] = keys[k] ? 1 : 0;
        Input.targetAngle[eid] = wireAim(s.aim);
        Input.cursorDist[eid] = distOf(s);
        expect(stepMovement(server.b, eid)).toBe(true);
        // Client: the input message, the hazards as the pilot's row tells them
        player.empUntil = empAt(t) ? EMP_END : 0;
        player.slowUntil = slowedAt(t) ? SLOW_END : 0;
        player.warmth = numbAt(t) ? 10 : 100;
        const msg = { type: 'input', seq: t, tick: 0, fireLeft: false, fireRight: false, forward: false, backward: false, left: false, right: false, boost: false, ...keys, targetAngle: wireAim(s.aim), cursorDist: distOf(s) };
        clientCharge = predict.call(self, player as never, msg as never, clientCharge, t)!;
        // Replica: the server's replicated controls
        const ctl = (server.b as unknown as { replicaCtl: Map<number, { bits: number; q: number }> }).replicaCtl.get(eid)!;
        replicaStep(ReplicaMode.Player, replica, { bits: ctl.bits, targetAngle: replicaAngle(ReplicaMode.Player, ctl.q) }, serverShip.derived, tuning, REPLICA_ENV, t);
        // stepShip on its own state
        direct.hazard.empUntil = empAt(t) ? EMP_END : 0;
        direct.hazard.slowUntil = slowedAt(t) ? SLOW_END : 0;
        direct.hazard.numb = numbAt(t) ? COLD.control : 1;
        direct = stepShip(direct, pilotInput({ ...keys, targetAngle: wireAim(s.aim), cursorDist: distOf(s) } as never), simEnv(t)).state;

        const sb = { ...server.st.body, jump: serverShip.jump, jumpScale: serverShip.jumpScale, cargo: serverShip.cargo, dodge: serverShip.dodge, dodgeDir: serverShip.dodgeDir };
        const at = `${name} tick ${t}`;
        expect(bodyRow(direct.body), at).toEqual(bodyRow(sb));
        expect(bodyRow({ ...player, cargo: player.cargoMass } as unknown as FlightBody), at).toEqual(bodyRow(sb));
        expect(bodyRow(replica), at).toEqual(bodyRow(sb));
        expect(chargeRow(direct.charge), at).toEqual(chargeRow(server.st.charge));
        expect(chargeRow(clientCharge), at).toEqual(chargeRow(server.st.charge));
        // The priming, everywhere (state, replicas included)
        expect(player.jumpPrime, at).toBe(serverShip.jumpPrime);
        expect(direct.jumpPrime, at).toBe(serverShip.jumpPrime);
        expect(replica.jumpPrime ?? 0, at).toBe(serverShip.jumpPrime);
        // The controls it flew, as replicated
        expect(direct.ctl.bits, at).toBe(ctl.bits);
        expect(direct.ctl.q, at).toBe(ctl.q);
        primed = Math.max(primed, serverShip.jumpPrime ?? 0);
      });
      // (The script did meet each hazard and the stone)
      expect(primed).toBeGreaterThan(0);
    });
  }

  for (const withImpulse of [false, true]) {
    it(`a pilotless ship: stepPilotless, stepShip${withImpulse ? ' (an order\'s impulse)' : ' and replicaStep'} agree tick by tick`, () => {
      const sc = SCENARIOS.find((s) => s.name === 'plain-thrust-turn')!;
      const eid = 9;
      const ship = createShipState(catalog, tuning, eid, sc.ship(), 0);
      const server = fakeBridge(eid, ship, START, cloneCharge(FULL_CHARGE));
      const orders = (t: number) => {
        const s = sc.script[t - 1];
        if (t > 150 && t < 170) return null; // (no orders: holding its heading)
        const k = s.keys;
        return { controls: { forward: !!k.forward, backward: !!k.backward, left: !!k.left, right: !!k.right, boost: !!k.boost, targetAngle: s.aim + 0.0001 * t }, firing: false, impulse: withImpulse && t % 25 === 0 ? [0.3, -0.2] as [number, number] : undefined };
      };
      let tick = 0;
      const bb = server.b as unknown as { controllers: Map<number, unknown>; replicaCtl: Map<number, { bits: number; q: number }> };
      const replica: FlightBody = { ...START };
      let direct: SimShipState = newSimShip({ id: eid, derived: ship.derived, body: START, charge: FULL_CHARGE, accounted: false, mode: ReplicaMode.Pilotless });
      for (let t = 1; t <= Math.min(200, sc.script.length); t++) {
        tick = t;
        server.at(t);
        const o = orders(t);
        if (o) bb.controllers.set(eid, () => o); else bb.controllers.delete(eid);
        stepPilotless(server.b, eid, ship, { friction: 0, boostFactor: 0, worldSize: 0 } as never, tick);
        const ctl = bb.replicaCtl.get(eid)!;
        direct.hazard.empUntil = empAt(t) ? EMP_END : 0;
        direct.hazard.slowUntil = slowedAt(t) ? SLOW_END : 0;
        direct.hazard.numb = numbAt(t) ? COLD.control : 1;
        direct = stepShip(direct, { ...controllerInput({ pinned: new Map() } as never, eid, o as never, undefined) }, simEnv(t)).state;
        const sb = { ...server.st.body, jump: ship.jump, jumpScale: ship.jumpScale, cargo: ship.cargo };
        const at = `tick ${t}`;
        expect(bodyRow(direct.body), at).toEqual(bodyRow(sb));
        expect(direct.ctl.bits, at).toBe(ctl.bits);
        expect(direct.ctl.q, at).toBe(ctl.q);
        expect(direct.jumpPrime, at).toBe(ship.jumpPrime ?? 0);
        // (Its aim is the grid's: simAim)
        if (o) expect(ctl.q).toBe(aimQ(o.controls.targetAngle));
        // Numb is the chain's for pilotless ships too: replicas read it from CTL.numb
        expect((ctl.bits & CTL.numb) !== 0, at).toBe(numbAt(t));
        if (!withImpulse) {
          replicaStep(ReplicaMode.Pilotless, replica, { bits: ctl.bits, targetAngle: replicaAngle(ReplicaMode.Pilotless, ctl.q) }, ship.derived, tuning, REPLICA_ENV, t);
          expect(bodyRow(replica), at).toEqual(bodyRow(sb));
          expect(replica.jumpPrime ?? 0, at).toBe(ship.jumpPrime ?? 0);
        }
      }
    });
  }

  it('pilotless ships fly no env hazard (step.ts ENV_HAZARD_MODES), pilots do', () => {
    const sc = SCENARIOS[0];
    const ship = createShipState(catalog, tuning, 1, sc.ship(), 0);
    const fly = (mode: ReplicaMode, hazard: boolean) => {
      let s = newSimShip({ id: 1, derived: ship.derived, body: { ...START, x: 100 }, charge: FULL_CHARGE, accounted: false, mode });
      for (let t = 1; t <= 60; t++) s = stepShip(s, { bits: CTL.forward, q: aimQ(0.3), jumpDist: -1, fire: false, fireAlt: false, aimDist: 0 }, { ...simEnv(t), hazard: hazard ? hazardAt : undefined }).state;
      return bodyRow(s.body);
    };
    expect(fly(ReplicaMode.Pilotless, true)).toEqual(fly(ReplicaMode.Pilotless, false));
    expect(fly(ReplicaMode.Player, true)).not.toEqual(fly(ReplicaMode.Player, false));
  });

  it('the distant tier measures cruise on the same motion (SimLod cruiseOf)', () => {
    const ship = createShipState(catalog, tuning, 1, SCENARIOS[0].ship(), 0);
    const c = cruiseOf(ship, tuning);
    // (The same measurement, on replicaStep: a pilotless ship holding full thrust up the screen)
    const body: FlightBody = { x: 0, y: 0, vx: 0, vy: 0, angle: -Math.PI / 2, angVel: 0, jump: 0 };
    const env: ReplicaEnv = { gravity: null, central: null };
    let speed = 0;
    for (let i = 0; i < 1200; i++) {
      replicaStep(ReplicaMode.Pilotless, body, { bits: CTL.forward, targetAngle: -Math.PI / 2 }, ship.derived, tuning, env, i + 1);
      const s = Math.hypot(body.vx, body.vy);
      if (i > 60 && s - speed < 1e-4) { speed = s; break; }
      speed = s;
    }
    expect(c.speed).toBeCloseTo(speed, 9);
    expect(c.speed).toBeGreaterThan(0);
    expect(c.turn).toBeGreaterThan(0);
  });
});

describe('the step\'s small rules', () => {
  it('the aim grid round-trips every step (aimQ), the top one included', () => {
    for (let q = 0; q <= 8191; q++) {
      const a = simAim(q);
      expect(aimQ(a)).toBe(q);
      expect(aimQ(dequantizeCursorAngle(q))).toBe(q);
      expect(gridAim(a)).toBe(a);
    }
  });

  it('step.ts\'s own copies of the CTL bits match CTL', () => {
    expect(CTL_STATE_BITS).toBe(CTL.emp | CTL.numb | CTL.slowed | CTL.noBoost | CTL.power | CTL.share);
    expect(CTL.jump).toBe(256);
  });

  it('an EMP\'d pilot sends no jump bit (the step started none)', () => {
    const ship = createShipState(catalog, tuning, 1, SCENARIOS[0].ship(), 0);
    const s = newSimShip({ id: 1, derived: ship.derived, body: START, charge: FULL_CHARGE });
    s.hazard.empUntil = 5;
    const r = stepShip(s, { bits: controlBits({ forward: true, jump: true }), q: 0, jumpDist: 0, fire: false, fireAlt: false, aimDist: 0 }, simEnv(1)).state;
    expect(r.ctl.bits & CTL.jump).toBe(0);
    expect(r.ctl.bits & CTL.emp).toBe(CTL.emp);
  });
});
