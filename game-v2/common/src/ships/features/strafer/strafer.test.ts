import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseBlueprint } from '../../blueprint.js';
import { createShipState } from '../../state.js';
import { readShipJson, testCatalog, SHIP_DATA_DIR } from '../../testData.js';
import type { ShipTuning } from '../../tuning.js';
import type { ShipDerived } from '../../rebuild.js';
import { worldToLocalDir, type FlightBody, type FlightControls } from '../../flight.js';
import { stepShipPhysics, quantizeShipBody } from '../../physics.js';
import { replicaStep, ReplicaMode, controlBits, CTL, flightSignature } from '../../replica.js';
import {
  dodgePhase, stepDodge, strafeForce, dodgeLoad, burstEnergy, pilotExtras, chooseDodgeDir, dodgeDirOf, dodgeVec, oppositeDir, bestDodge,
  dodgeAffordable, DODGE_DIRS, DODGE_LEFT, DODGE_RIGHT, DODGE_FORWARD, DODGE_BACK, type StrafeInfo,
} from './strafer.js';
import { FULL_CHARGE, chargeTotal, CHARGE_GROUPS_AT, PILOT_ROW, type Charge } from '../../energy.js';
import { packKeyframe, unpackKeyframe } from '../../../network/replication.js';
import { encodeInputBinary, decodeInputBinary } from '../../../network/protocol.js';

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');

const sparrowBp = () => parseBlueprint(readFileSync(join(SHIP_DATA_DIR, 'blueprints/fixtures/sparrow-t.json'), 'utf-8'));
const ship = (extra: object[] = []) => {
  const bp = sparrowBp();
  bp.parts.push(...(extra as never[]));
  return createShipState(catalog, tuning, 1, bp, 0);
};
/** A strafer on the right flank, nozzle out to the right: it dodges the ship left */
const RIGHT_FLANK = { uid: 60, piece: 'sq', fn: 'engine_burst_strafer', material: 'steel', x: 3, y: 0, rot: 0, flip: false, facing: 'E' };
/** And one on the left flank, nozzle out to the left: it dodges the ship right */
const LEFT_FLANK = { uid: 61, piece: 'sq', fn: 'engine_burst_strafer', material: 'steel', x: -2, y: 0, rot: 0, flip: false, facing: 'W' };
/** A Drive Cell touching the right-flank strafer */
const CELL = { uid: 62, piece: 'sq', fn: 'power_drive_cell', material: 'steel', x: 3, y: -1, rot: 0, flip: false };

const testStrafer = () => createShipState(catalog, tuning, 1, parseBlueprint(readFileSync(join(SHIP_DATA_DIR, 'blueprints/dev/test-strafer.json'), 'utf-8')), 0).derived;

const NONE: FlightControls = { forward: false, backward: false, left: false, right: false, boost: false, targetAngle: -Math.PI / 2 };
const body = (o: Partial<FlightBody> = {}): FlightBody => ({ x: 0, y: 0, vx: 0, vy: 0, angle: -Math.PI / 2, angVel: 0, jump: 0, ...o });
const fly = (b: FlightBody, d: ShipDerived, c: Partial<FlightControls>, ticks: number, charge: { c: Charge } | null = null) => {
  for (let i = 0; i < ticks; i++) {
    const r = stepShipPhysics(b, { ...NONE, ...c }, d, tuning, charge ? { charge: charge.c, drainRate: 1 } : { charge: FULL_CHARGE, drainRate: 0 });
    if (charge) charge.c = r.charge;
  }
  return b;
};
/** Velocity in the ship's own frame ([right, back]) */
const local = (b: FlightBody) => worldToLocalDir([b.vx, b.vy], b.angle);
const lateral = (b: FlightBody) => local(b)[0];

describe('Burst Strafer: the part', () => {
  it('is a data-driven engine model in band L8-15 with a burst, a short cooldown and a big draw, and no cruising thrust', () => {
    const fn = catalog.functions.get('engine_burst_strafer')!;
    expect(fn.model).toBe(true);
    expect(fn.category).toBe('engines');
    expect(fn.unlock?.level).toBeGreaterThanOrEqual(8);
    expect(fn.unlock?.level).toBeLessThanOrEqual(15);
    expect(fn.strafe!.ticks).toBeGreaterThanOrEqual(8);
    // A short cooldown (no charges): ready again in well under a second, never shorter than a burst
    expect(fn.strafe!.cooldown).toBeGreaterThanOrEqual(fn.strafe!.ticks);
    expect(fn.strafe!.cooldown).toBeLessThanOrEqual(30);
    expect((fn.strafe as Record<string, unknown>).charges).toBeUndefined();
    expect(fn.thrust ?? 0).toBe(0);
    // Several times an engine's energy per unit of push (the Vernier: a side thruster)
    const vern = catalog.functions.get('engine_vernier')!;
    expect(fn.demand! / fn.strafe!.kick).toBeGreaterThan((vern.demand! / vern.thrust!) * 3);
  });

  it('gives the ship a push away from its nozzle; none on a plain ship; it adds no thruster', () => {
    expect(ship().derived.fx?.strafe).toBeUndefined();
    const d = ship([RIGHT_FLANK]).derived;
    expect(d.fx!.strafe!.parts.length).toBe(1);
    expect(strafeForce(d.fx?.strafe, DODGE_LEFT)).toBeGreaterThan(0);
    expect(strafeForce(d.fx?.strafe, DODGE_RIGHT)).toBe(0);
    expect(strafeForce(d.fx?.strafe, DODGE_FORWARD)).toBeCloseTo(0, 6);
    // (A diagonal gets its component: cos 45°)
    expect(strafeForce(d.fx?.strafe, (DODGE_LEFT + DODGE_FORWARD) / 2)).toBeCloseTo(strafeForce(d.fx?.strafe, DODGE_LEFT) * Math.SQRT1_2, 3);
    expect(d.thrusters.some((t) => t.part === d.fx!.strafe!.parts[0].part)).toBe(false);
    const both = ship([RIGHT_FLANK, LEFT_FLANK]).derived;
    expect(both.fx!.strafe!.parts.length).toBe(2);
    // (It's an engine on its circuit: a burst consumer with a feed group)
    expect(both.power!.feedOf[both.fx!.strafe!.parts[0].part]).toBeGreaterThanOrEqual(0);
    expect(flightSignature(both)).not.toBe(flightSignature(ship().derived));
  });

  it('strafers facing forward and back dodge back and forward (the dev test ship has them every way)', () => {
    const d = testStrafer();
    const s = d.fx!.strafe!;
    // Two at the nose (facing N: push back), two at the tail (facing S: push forward), one each flank
    expect(s.parts.length).toBe(6);
    expect(strafeForce(s, DODGE_BACK)).toBeCloseTo(strafeForce(s, DODGE_LEFT) * 2, 3);
    expect(strafeForce(s, DODGE_FORWARD)).toBeCloseTo(strafeForce(s, DODGE_LEFT) * 2, 3);
    expect(strafeForce(s, DODGE_RIGHT)).toBeGreaterThan(0);
    // (Every flank strafer touches a Drive Cell bank)
    const L = d.power!;
    expect(s.parts.filter((p) => L.feeds[L.feedOf[p.part]].banks.length > 0).length).toBeGreaterThanOrEqual(4);
  });
});

describe('Burst Strafer: ways', () => {
  const S: StrafeInfo = { parts: [{ part: 0, push: [-10, 0] }, { part: 1, push: [10, 0] }], ticks: 12, cooldown: 24 };
  const ALL: StrafeInfo = { ...S, parts: [...S.parts, { part: 2, push: [0, -10] }, { part: 3, push: [0, 10] }] };

  it('ways are ship-local, 1 right round to 25 forward; the nearest way to a vector; opposites', () => {
    expect(dodgeVec(DODGE_RIGHT)).toEqual([1, 0]);
    expect(dodgeVec(DODGE_BACK)).toEqual([0, 1]);
    expect(dodgeVec(DODGE_LEFT)).toEqual([-1, 0]);
    expect(dodgeVec(DODGE_FORWARD)).toEqual([0, -1]);
    expect(dodgeDirOf([1, 0])).toBe(DODGE_RIGHT);
    expect(dodgeDirOf([0, -1])).toBe(DODGE_FORWARD);
    expect(dodgeDirOf([-1, -1])).toBe((DODGE_LEFT + DODGE_FORWARD) / 2);
    expect(dodgeDirOf([0, 0])).toBe(0);
    expect(dodgeDirOf(null)).toBe(0);
    for (let i = 1; i <= DODGE_DIRS; i++) {
      expect(dodgeDirOf(dodgeVec(i))).toBe(i);
      expect(oppositeDir(oppositeDir(i))).toBe(i);
    }
    expect(oppositeDir(DODGE_LEFT)).toBe(DODGE_RIGHT);
  });

  it('dodges the way asked if anything pushes that way; else back from the last; else sideways, right on a tie', () => {
    expect(chooseDodgeDir(S, [-1, 0], undefined)).toBe(DODGE_LEFT);
    expect(chooseDodgeDir(S, [1, -1], undefined)).toBe(dodgeDirOf([1, -1]));
    // Forward asked, but only side strafers: back from the last dodge (left: so right), else sideways (right on a tie)
    expect(chooseDodgeDir(S, [0, -1], DODGE_LEFT)).toBe(DODGE_RIGHT);
    expect(chooseDodgeDir(S, [0, -1], undefined)).toBe(DODGE_RIGHT);
    expect(chooseDodgeDir(S, null, DODGE_RIGHT)).toBe(DODGE_LEFT);
    // All four ways: anywhere, forward and back too; with nothing held, back from the last
    expect(chooseDodgeDir(ALL, [0, -1], undefined)).toBe(DODGE_FORWARD);
    expect(chooseDodgeDir(ALL, null, DODGE_FORWARD)).toBe(DODGE_BACK);
    // A diagonal with strafers on two sides gets both
    const diag = dodgeDirOf([-1, -1]);
    expect(strafeForce(ALL, diag)).toBeCloseTo(20 * Math.SQRT1_2, 3);
    // Only a left-pusher: whatever's asked, it goes left
    const one: StrafeInfo = { ...S, parts: [S.parts[0]] };
    expect(chooseDodgeDir(one, [1, 0], DODGE_LEFT)).toBe(DODGE_LEFT);
    expect(bestDodge(one).dir).toBe(DODGE_LEFT);
    // Only a back-pusher: no side at all, so its own way
    expect(chooseDodgeDir({ ...S, parts: [{ part: 0, push: [0, 10] }] }, null, undefined)).toBe(DODGE_BACK);
    expect(chooseDodgeDir({ ...S, parts: [] }, [1, 0], undefined)).toBe(0);
  });
});

describe('Burst Strafer: the counter', () => {
  const S: StrafeInfo = { parts: [{ part: 0, push: [-10, 0] }, { part: 1, push: [10, 0] }], ticks: 12, cooldown: 24 };

  it('a press fires one burst of `ticks`, cools down, then holds until let go; ready again `cooldown` ticks after it started', () => {
    const b: { dodge?: number; dodgeDir?: number } = {};
    let pushed = 0, first = -1;
    for (let i = 0; i < 60; i++) { const w = stepDodge(b, true, [-1, 0], S, false); if (w) { pushed++; expect(w).toBe(DODGE_LEFT); if (first < 0) first = i; } }
    expect(pushed).toBe(S.ticks);
    expect(dodgePhase(b.dodge, S).phase).toBe('held');
    expect(b.dodgeDir).toBe(DODGE_LEFT);
    // Let go: ready
    stepDodge(b, false, null, S, false);
    expect(b.dodge).toBeUndefined();
    // Tapping as fast as it allows: a burst every `cooldown` ticks exactly
    const c: { dodge?: number; dodgeDir?: number } = {};
    const starts: number[] = [];
    for (let t = 0; t < 200; t++) {
      // (the pilot presses whenever it's ready and holds a few ticks)
      const ready = dodgePhase(c.dodge, S).phase === 'ready';
      const before = c.dodge ?? 0;
      stepDodge(c, ready || (before > 0 && before < 4), null, S, false);
      if (before === 0 && c.dodge === 1) starts.push(t);
    }
    expect(starts.length).toBeGreaterThan(6);
    for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBe(S.cooldown);
  });

  it('weaves when no way is held, and does nothing while blocked or with no strafers', () => {
    const b: { dodge?: number; dodgeDir?: number } = {};
    const ways: number[] = [];
    for (let n = 0; n < 4; n++) {
      ways.push(stepDodge(b, true, null, S, false));
      for (let i = 0; i < S.cooldown + 2; i++) stepDodge(b, true, null, S, false);
      stepDodge(b, false, null, S, false);
    }
    expect(ways).toEqual([DODGE_RIGHT, DODGE_LEFT, DODGE_RIGHT, DODGE_LEFT]);
    const c: { dodge?: number; dodgeDir?: number } = {};
    expect(stepDodge(c, true, [1, 0], S, true)).toBe(0);
    expect(stepDodge(c, true, [1, 0], undefined, false)).toBe(0);
    expect(c.dodge).toBeUndefined();
  });

  it('phases: burst, cooling (with the share of the cooldown left), held', () => {
    expect(dodgePhase(0, S)).toEqual({ phase: 'ready', progress: 1, cooling: 0 });
    expect(dodgePhase(6, S).phase).toBe('burst');
    expect(dodgePhase(18, S).phase).toBe('cooling');
    expect(dodgePhase(18, S).cooling).toBeCloseTo(0.25, 6);
    expect(dodgePhase(24, S).phase).toBe('held');
  });
});

describe('Burst Strafer: flight', () => {
  it('a burst throws the ship the way asked (left for a right-flank strafer), and only during its ticks', () => {
    const d = ship([RIGHT_FLANK]).derived;
    const b = fly(body(), d, { dodge: true }, 1);
    expect(lateral(b)).toBeLessThan(0);
    fly(b, d, { dodge: true }, d.fx!.strafe!.ticks - 1);
    const v = lateral(b);
    expect(v).toBeLessThan(-3);
    // Held on: no second burst, just coasting down
    fly(b, d, { dodge: true }, 40);
    expect(Math.abs(lateral(b))).toBeLessThan(Math.abs(v));
  });

  it('dodges any way with strafers on all sides: forward, back and diagonals, the way the keys ask (screen-relative)', () => {
    const d = testStrafer();
    const s = d.fx!.strafe!;
    // (Facing up: screen up is forward, screen right is the ship's right)
    const go = (c: Partial<FlightControls>) => {
      // Thrust and dodge both: compare against the same keys without the dodge
      const a = fly(body(), d, { ...c, dodge: true }, s.ticks), b = fly(body(), d, c, s.ticks);
      return [a.vx - b.vx, a.vy - b.vy];
    };
    expect(go({ forward: true })[1]).toBeLessThan(-1);
    expect(go({ backward: true })[1]).toBeGreaterThan(1);
    expect(go({ left: true })[0]).toBeLessThan(-1);
    expect(go({ right: true })[0]).toBeGreaterThan(1);
    const diag = go({ right: true, backward: true });
    expect(diag[0]).toBeGreaterThan(0.5);
    expect(diag[1]).toBeGreaterThan(0.5);
    // (Forward gets two strafers' push, a flank one)
    expect(Math.abs(go({ forward: true })[1])).toBeGreaterThan(Math.abs(go({ left: true })[0]) * 1.5);
    // At the helm the same keys are ship-relative: forward, back, Q/E
    const helm = (c: Partial<FlightControls>) => local(fly(body({ angle: 0.7 }), d, { ...c, helm: true, targetAngle: 0.7, dodge: true }, s.ticks));
    expect(helm({ strafeLeft: true })[0]).toBeLessThan(-1);
    expect(helm({ backward: true })[1]).toBeGreaterThan(1);
  });

  it('a burst is about twice the old one (5.5 × 15 ticks a cell): it takes you out of a shot', () => {
    const d = ship([RIGHT_FLANK]).derived;
    const b = fly(body(), d, { dodge: true }, 90);
    const fn = catalog.functions.get('engine_burst_strafer')!;
    expect(fn.strafe!.kick * fn.strafe!.ticks).toBeGreaterThanOrEqual(5.5 * 15 * 1.9);
    // (Displacement, ship-local: well clear of its own width)
    expect(Math.abs(worldToLocalDir([b.x, b.y], b.angle)[0])).toBeGreaterThan(d.radius);
  });

  it('mass matters: a laden ship dodges less; cruising thrust is no different with strafers fitted', () => {
    const d = ship([RIGHT_FLANK]).derived;
    const light = fly(body(), d, { dodge: true }, 15), heavy = fly(body({ cargo: 20 }), d, { dodge: true }, 15);
    expect(Math.abs(lateral(heavy))).toBeLessThan(Math.abs(lateral(light)) * 0.6);
    const plain = fly(body(), ship().derived, { right: true }, 30), fitted = fly(body(), d, { right: true }, 30);
    // (Its own mass slows the ship a touch; it never adds push)
    expect(Math.hypot(fitted.vx, fitted.vy)).toBeLessThanOrEqual(Math.hypot(plain.vx, plain.vy));
  });

  it('a burst costs a lot of energy, and a Drive Cell bank it touches pays first', () => {
    const plain = ship([RIGHT_FLANK]).derived, banked = ship([RIGHT_FLANK, CELL]).derived;
    expect(burstEnergy(plain, DODGE_LEFT)).toBeGreaterThan(100);
    expect(burstEnergy(plain, DODGE_RIGHT)).toBe(0);
    // (At an angle, a share of it)
    expect(burstEnergy(plain, dodgeDirOf([-1, -1]))).toBeCloseTo(burstEnergy(plain, DODGE_LEFT) * Math.SQRT1_2, 3);
    expect(dodgeLoad(plain, DODGE_LEFT)!.some((v) => v > 0)).toBe(true);
    const cost = (d: ShipDerived) => {
      const ch = { c: FULL_CHARGE as Charge };
      fly(body(), d, { dodge: true }, d.fx!.strafe!.ticks, ch);
      return ch.c;
    };
    const a = cost(plain), b = cost(banked);
    // Without a bank the pool pays; with one, the bank does and the pool's touched less
    expect(a.g).toBeLessThan(85);
    expect(b.g).toBeGreaterThan(a.g + 5);
    expect(banked.power!.banks[0].kind).toBe('drive');
    expect(b.b[0]).toBeLessThan(100);
    expect(chargeTotal(plain, a)).toBeLessThan(100);
    expect(dodgeAffordable(plain, FULL_CHARGE, DODGE_LEFT)).toBe(1);
  });

  it('energy is the limit: dodging as fast as it allows browns out a small ship, then bursts get weaker and are refused', () => {
    const d = ship([RIGHT_FLANK]).derived;
    const ch = { c: FULL_CHARGE as Charge };
    const b = body();
    const kicks: number[] = [];
    for (let n = 0; n < 40; n++) {
      // Press: hold a few ticks, then let go till it's ready
      const before = lateral(b);
      for (let i = 0; i < d.fx!.strafe!.cooldown; i++) {
        fly(b, d, { dodge: i < 4 }, 1, ch);
      }
      kicks.push(before - lateral(b));
      b.vx = b.vy = 0;
    }
    // The first bursts get their full push; by the end the ship can't keep up
    expect(kicks[kicks.length - 1]).toBeLessThan(kicks[0] * 0.75);
    expect(chargeTotal(d, ch.c)).toBeLessThan(30);
    expect(dodgeAffordable(d, ch.c, DODGE_LEFT)).toBeLessThan(1);
  });

  it('a burst that gets almost no energy on its first tick is refused: no push, ready again once let go', () => {
    const d = ship([RIGHT_FLANK]).derived;
    const empty: Charge = { g: 0, b: d.power!.banks.map(() => 0) };
    // (All it has is what the generators make this tick: under a quarter of a burst's draw)
    expect(d.energy!.spare / 60).toBeLessThan(0.25 * (burstEnergy(d, DODGE_LEFT) / d.fx!.strafe!.ticks));
    const b = body();
    const r = stepShipPhysics(b, { ...NONE, dodge: true }, d, tuning, { charge: empty, drainRate: 1 });
    expect(lateral(b)).toBe(0);
    expect(b.dodge).toBe(Math.max(d.fx!.strafe!.ticks, d.fx!.strafe!.cooldown));
    expect(dodgeAffordable(d, empty, DODGE_LEFT)).toBeLessThan(0.25);
    stepShipPhysics(b, { ...NONE }, d, tuning, { charge: r.charge, drainRate: 1 });
    expect(b.dodge).toBeUndefined();
  });

  it('prediction replays a dodge exactly from any snapshot, and replicas fly it from the control bits', () => {
    const d = ship([RIGHT_FLANK, LEFT_FLANK]).derived;
    const inputs: Partial<FlightControls>[] = [];
    for (let t = 0; t < 160; t++) inputs.push({ forward: t < 60, right: t >= 45 && t < 52, left: t >= 90 && t < 95, targetAngle: -1.2 + t * 0.01, dodge: (t >= 10 && t < 20) || (t >= 45 && t < 50) || (t >= 90 && t < 93) || (t >= 120 && t < 125) });
    // The server's run
    const states: FlightBody[] = [];
    const s = body();
    for (const c of inputs) { fly(s, d, c, 1); states.push({ ...s }); }
    expect(s.dodgeDir).toBeGreaterThan(0);
    // A client reconciling from the snapshot at tick 14 (mid-burst) and replaying its inputs
    for (const at of [14, 47, 100]) {
      const snap = { ...states[at] };
      quantizeShipBody(snap);
      for (let t = at + 1; t < inputs.length; t++) fly(snap, d, inputs[t], 1);
      expect(snap).toEqual(states[states.length - 1]);
    }
    // Through a keyframe too (its counter and way ride it)
    const k = unpackKeyframe(packKeyframe({ id: 1, mode: ReplicaMode.Player, body: { ...states[47] }, ctl: { bits: 0, targetAngle: 0 }, q: 0 }));
    for (let t = 48; t < inputs.length; t++) fly(k.body, d, inputs[t], 1);
    // (A keyframe always says a jump's scale: 1 where the body had none)
    expect({ ...k.body, jumpScale: undefined }).toEqual({ ...states[states.length - 1], jumpScale: undefined });
    // A replica stepping the control bits (keyframed at tick 0)
    const r = body();
    for (const c of inputs) replicaStep(ReplicaMode.Player, r, { bits: controlBits({ ...NONE, ...c }), targetAngle: c.targetAngle ?? NONE.targetAngle }, d, tuning, { gravity: null, central: null, lodestones: [] } as never);
    expect(r).toEqual(states[states.length - 1]);
  });
});

describe('Burst Strafer: the wire', () => {
  it('the input and the control bits carry the dodge (its way rides the movement keys)', () => {
    const base = { type: 'input' as const, seq: 1, tick: 0, forward: false, backward: false, left: false, right: false, boost: false, fireLeft: false, fireRight: false, targetAngle: 0 };
    expect(decodeInputBinary(encodeInputBinary({ ...base, dodge: true })).dodge).toBe(true);
    expect(decodeInputBinary(encodeInputBinary({ ...base, dodge: false })).dodge).toBe(false);
    expect(controlBits({ dodge: true }) & CTL.dodge).toBeTruthy();
    expect(controlBits({ dodge: false }) & CTL.dodge).toBe(0);
  });

  it('keyframes carry the dodge counter and way (and a dock and cargo still unpack)', () => {
    const k = { id: 5, mode: ReplicaMode.Player, body: body({ dodge: 7, dodgeDir: 17 }), ctl: { bits: 0, targetAngle: 0 }, q: 0 };
    const u = unpackKeyframe(packKeyframe(k));
    expect(u.body.dodge).toBe(7);
    expect(u.body.dodgeDir).toBe(17);
    expect(u.dock).toBeUndefined();
    // (The way alone, after a dodge's done, still rides: the next default dodge goes back from it)
    expect(unpackKeyframe(packKeyframe({ ...k, body: body({ dodgeDir: 9 }) })).body.dodgeDir).toBe(9);
    const docked = unpackKeyframe(packKeyframe({ ...k, body: body({ cargo: 3 }), dock: { station: 0, ox: 3, oy: 4 } }));
    expect(docked.dock).toEqual({ station: 0, ox: 3, oy: 4 });
    expect(docked.body.cargo).toBe(3);
    expect(docked.body.dodge).toBeUndefined();
  });

  it("the pilot's row carries the dodge, its way and the tow after the charge groups", () => {
    const data = new Array(CHARGE_GROUPS_AT).fill(0);
    data[PILOT_ROW.groups] = 2;
    data.push(50, 60, 3, 17, 43);
    expect(pilotExtras(data)).toEqual({ dodge: 3, dodgeDir: 17, tow: 43, marked: 0, slowed: 0 });
    expect(pilotExtras(undefined)).toEqual({ dodge: 0, dodgeDir: 0, tow: 0, marked: 0, slowed: 0 });
  });
});
