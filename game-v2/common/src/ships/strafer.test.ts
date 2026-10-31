import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseBlueprint } from './blueprint.js';
import { createShipState } from './state.js';
import { readShipJson, testCatalog, SHIP_DATA_DIR } from './testData.js';
import type { ShipTuning } from './tuning.js';
import type { ShipDerived } from './rebuild.js';
import { worldToLocalDir, type FlightBody, type FlightControls } from './flight.js';
import { stepShipPhysics, quantizeShipBody } from './physics.js';
import { replicaStep, ReplicaMode, controlBits, CTL, flightSignature } from './replica.js';
import { dodgePhase, dodgeCharges, canDodge, stepDodge, strafeForce, dodgeLoad, burstEnergy, pilotExtras, type StrafeInfo } from './strafer.js';
import { FULL_CHARGE, chargeTotal, CHARGE_GROUPS_AT, type Charge } from './energy.js';
import { packKeyframe, unpackKeyframe } from '../network/replication.js';
import { encodeInputBinary, decodeInputBinary } from '../network/protocol.js';

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');

const sparrowBp = () => parseBlueprint(readFileSync(join(SHIP_DATA_DIR, 'blueprints/sparrow-t.json'), 'utf-8'));
const ship = (extra: object[] = []) => {
  const bp = sparrowBp();
  bp.parts.push(...(extra as never[]));
  return createShipState(catalog, tuning, 1, bp, 0);
};
/** A strafer on the right flank, nozzle out to the right: it dodges the ship left */
const RIGHT_FLANK = { uid: 60, piece: 'sq', fn: 'engine_burst_strafer', material: 'steel', x: 3, y: 0, rot: 0, flip: false, facing: 'E' };
/** And one on the left flank, nozzle out to the left: it dodges the ship right */
const LEFT_FLANK = { uid: 61, piece: 'sq', fn: 'engine_burst_strafer', material: 'steel', x: -2, y: 0, rot: 0, flip: false, facing: 'W' };
/** A capacitor touching the right-flank strafer */
const CAP = { uid: 62, piece: 'sq', fn: 'power_capacitor', material: 'composite', x: 3, y: -1, rot: 0, flip: false };

const NONE: FlightControls = { forward: false, backward: false, left: false, right: false, boost: false, targetAngle: -Math.PI / 2 };
const body = (o: Partial<FlightBody> = {}): FlightBody => ({ x: 0, y: 0, vx: 0, vy: 0, angle: -Math.PI / 2, angVel: 0, jump: 0, ...o });
const fly = (b: FlightBody, d: ShipDerived, c: Partial<FlightControls>, ticks: number, charge: { c: Charge } | null = null) => {
  for (let i = 0; i < ticks; i++) {
    const r = stepShipPhysics(b, { ...NONE, ...c }, d, tuning, charge ? { charge: charge.c, drainRate: 1 } : { charge: FULL_CHARGE, drainRate: 0 });
    if (charge) charge.c = r.charge;
  }
  return b;
};
/** Sideways speed in the ship's own frame (+ right) */
const lateral = (b: FlightBody) => worldToLocalDir([b.vx, b.vy], b.angle)[0];

describe('Burst Strafer: the part', () => {
  it('is a data-driven engine model in band L8-15 with a burst, charges and a big draw, and no cruising thrust', () => {
    const fn = catalog.functions.get('engine_burst_strafer')!;
    expect(fn.model).toBe(true);
    expect(fn.category).toBe('engines');
    expect(fn.unlock?.level).toBeGreaterThanOrEqual(8);
    expect(fn.unlock?.level).toBeLessThanOrEqual(15);
    expect(fn.strafe!.ticks).toBeGreaterThanOrEqual(10);
    expect(fn.strafe!.charges).toBeGreaterThanOrEqual(2);
    expect(fn.thrust ?? 0).toBe(0);
    // Several times an engine's energy per unit of push (the Vernier: a side thruster)
    const vern = catalog.functions.get('engine_vernier')!;
    expect(fn.demand! / fn.strafe!.kick).toBeGreaterThan((vern.demand! / vern.thrust!) * 3);
  });

  it('gives the ship a dodge to the side opposite its nozzle; none on a plain ship; it adds no thruster', () => {
    expect(ship().derived.strafe).toBeUndefined();
    const d = ship([RIGHT_FLANK]).derived;
    expect(d.strafe!.left.length).toBe(1);
    expect(d.strafe!.right.length).toBe(0);
    expect(strafeForce(d.strafe, -1)).toBeGreaterThan(0);
    expect(strafeForce(d.strafe, 1)).toBe(0);
    expect(d.thrusters.some((t) => t.part === d.strafe!.left[0].part)).toBe(false);
    const both = ship([RIGHT_FLANK, LEFT_FLANK]).derived;
    expect(both.strafe!.left.length).toBe(1);
    expect(both.strafe!.right.length).toBe(1);
    // (It's an engine on its circuit: a burst consumer with a feed group)
    const L = both.power!;
    expect(L.feedOf[both.strafe!.left[0].part]).toBeGreaterThanOrEqual(0);
    expect(flightSignature(both)).not.toBe(flightSignature(ship().derived));
  });
});

describe('Burst Strafer: the counter', () => {
  const S: StrafeInfo = { left: [{ part: 0, force: 5 }], right: [{ part: 1, force: 5 }], ticks: 15, charges: 3, recharge: 150 };

  it('a press fires one burst of `ticks`, then holds until let go; a charge is spent and comes back over `recharge`', () => {
    const b: { dodge?: number; dodgeSpent?: number } = {};
    let pushed = 0;
    for (let i = 0; i < 40; i++) if (stepDodge(b, -1, S, false)) pushed++;
    expect(pushed).toBe(S.ticks);
    expect(dodgePhase(b.dodge, S.ticks).phase).toBe('held');
    expect(dodgeCharges(S, b.dodgeSpent).ready).toBe(2);
    // Let go: ready again, and the spent charge refills
    stepDodge(b, 0, S, false);
    expect(b.dodge).toBeUndefined();
    for (let i = 0; i < S.recharge; i++) stepDodge(b, 0, S, false);
    expect(dodgeCharges(S, b.dodgeSpent).ready).toBe(3);
    expect(b.dodgeSpent).toBeUndefined();
  });

  it('runs out after its charges, and does nothing while blocked or to a side with no strafer', () => {
    const b: { dodge?: number; dodgeSpent?: number } = {};
    let bursts = 0;
    for (let n = 0; n < 5; n++) {
      if (stepDodge(b, 1, S, false)) bursts++;
      for (let i = 0; i < S.ticks + 2; i++) stepDodge(b, 1, S, false);
      stepDodge(b, 0, S, false);
    }
    expect(bursts).toBe(3);
    expect(canDodge(S, 1, b.dodge, b.dodgeSpent)).toBe(false);
    const c: { dodge?: number; dodgeSpent?: number } = {};
    expect(stepDodge(c, 1, S, true)).toBe(0);
    expect(stepDodge(c, 1, { ...S, right: [] }, false)).toBe(0);
    expect(c.dodge).toBeUndefined();
  });
});

describe('Burst Strafer: flight', () => {
  it('a burst throws the ship sideways (left for a right-flank strafer), and only during its ticks', () => {
    const d = ship([RIGHT_FLANK]).derived;
    const b = fly(body(), d, { dodge: -1 }, 1);
    expect(lateral(b)).toBeLessThan(0);
    fly(b, d, { dodge: -1 }, d.strafe!.ticks - 1);
    const v = lateral(b);
    expect(v).toBeLessThan(-3);
    // Held on: no second burst, just coasting down
    fly(b, d, { dodge: -1 }, 20);
    expect(Math.abs(lateral(b))).toBeLessThan(Math.abs(v));
    // And nothing the other way
    const c = fly(body(), d, { dodge: 1 }, 15);
    expect(c.vx).toBe(0);
    expect(c.vy).toBe(0);
  });

  it('mass matters: a laden ship dodges less; cruising thrust is no different with strafers fitted', () => {
    const d = ship([RIGHT_FLANK]).derived;
    const light = fly(body(), d, { dodge: -1 }, 15), heavy = fly(body({ cargo: 20 }), d, { dodge: -1 }, 15);
    expect(Math.abs(lateral(heavy))).toBeLessThan(Math.abs(lateral(light)) * 0.6);
    const plain = fly(body(), ship().derived, { right: true }, 30), fitted = fly(body(), d, { right: true }, 30);
    // (Its own mass slows the ship a touch; it never adds push)
    expect(Math.hypot(fitted.vx, fitted.vy)).toBeLessThanOrEqual(Math.hypot(plain.vx, plain.vy));
  });

  it('a burst costs a lot of energy, and a capacitor bank it touches pays first', () => {
    const plain = ship([RIGHT_FLANK]).derived, banked = ship([RIGHT_FLANK, CAP]).derived;
    expect(burstEnergy(plain, -1)).toBeGreaterThan(50);
    expect(dodgeLoad(plain, -1)!.some((v) => v > 0)).toBe(true);
    const cost = (d: ShipDerived) => {
      const ch = { c: FULL_CHARGE as Charge };
      fly(body(), d, { dodge: -1 }, d.strafe!.ticks, ch);
      return ch.c;
    };
    const a = cost(plain), b = cost(banked);
    // Without a bank the core's store pays; with one, the bank does and the core's barely touched
    expect(a.core).toBeLessThan(85);
    expect(b.core).toBeGreaterThan(a.core + 10);
    const bank = banked.power!.stores.findIndex((s) => s.kind === 'k');
    expect(bank).toBeGreaterThanOrEqual(0);
    expect(b.s[bank]).toBeLessThan(100);
    expect(chargeTotal(plain, a)).toBeLessThan(100);
  });

  it('prediction replays a dodge exactly from any snapshot, and replicas fly it from the control bits', () => {
    const d = ship([RIGHT_FLANK, LEFT_FLANK]).derived;
    const inputs: Partial<FlightControls>[] = [];
    for (let t = 0; t < 120; t++) inputs.push({ forward: t < 60, targetAngle: -1.2 + t * 0.01, dodge: t >= 10 && t < 20 ? -1 : t >= 50 && t < 70 ? 1 : 0 });
    // The server's run
    const states: FlightBody[] = [];
    const s = body();
    for (const c of inputs) { fly(s, d, c, 1); states.push({ ...s }); }
    // A client reconciling from the snapshot at tick 14 (mid-burst) and replaying its inputs
    const snap = { ...states[14] };
    quantizeShipBody(snap);
    for (let t = 15; t < inputs.length; t++) fly(snap, d, inputs[t], 1);
    expect(snap).toEqual(states[states.length - 1]);
    // A replica stepping the control bits (keyframed at tick 0)
    const r = body();
    for (const c of inputs) replicaStep(ReplicaMode.Player, r, { bits: controlBits({ ...NONE, ...c }), targetAngle: c.targetAngle ?? NONE.targetAngle }, d, tuning, { gravity: null, central: null, lodestones: [] } as never);
    expect(r).toEqual(states[states.length - 1]);
  });
});

describe('Burst Strafer: the wire', () => {
  it('the input carries the dodge both ways', () => {
    const base = { type: 'input' as const, seq: 1, tick: 0, forward: false, backward: false, left: false, right: false, boost: false, fireLeft: false, fireRight: false, targetAngle: 0 };
    expect(decodeInputBinary(encodeInputBinary({ ...base, dodge: -1 })).dodge).toBe(-1);
    expect(decodeInputBinary(encodeInputBinary({ ...base, dodge: 1 })).dodge).toBe(1);
    expect(decodeInputBinary(encodeInputBinary({ ...base, dodge: 0, brace: true })).dodge).toBe(0);
    expect(controlBits({ dodge: 1 }) & CTL.dodgeRight).toBeTruthy();
    expect(controlBits({ dodge: -1 }) & (CTL.dodge | CTL.dodgeRight)).toBe(CTL.dodge);
  });

  it('keyframes carry the dodge and charge (and a dock still unpacks)', () => {
    const k = { id: 5, mode: ReplicaMode.Player, body: body({ dodge: -7, dodgeSpent: 140 }), ctl: { bits: 0, targetAngle: 0 }, q: 0 };
    const u = unpackKeyframe(packKeyframe(k));
    expect(u.body.dodge).toBe(-7);
    expect(u.body.dodgeSpent).toBe(140);
    expect(u.dock).toBeUndefined();
    const docked = unpackKeyframe(packKeyframe({ ...k, body: body(), dock: { station: 0, ox: 3, oy: 4 } }));
    expect(docked.dock).toEqual({ station: 0, ox: 3, oy: 4 });
    expect(docked.body.dodge).toBeUndefined();
  });

  it("the pilot's row carries the dodge, charge and tow after the charge groups", () => {
    const data = new Array(CHARGE_GROUPS_AT).fill(0);
    data[11] = 2;
    data.push(50, 60, 3, 140, 43);
    expect(pilotExtras(data)).toEqual({ dodge: 3, dodgeSpent: 140, tow: 43 });
    expect(pilotExtras(undefined)).toEqual({ dodge: 0, dodgeSpent: 0, tow: 0 });
  });
});
