/**
 * The autopilot flown against the real flight model (common stepShipPhysics,
 * real ship designs, the input delay): it gets there without its nose
 * swinging about. Turning round to brake is fine when it has to, once.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  EntityType, loadCatalog, createShipState, parseBlueprint, stepShipPhysics, accelAlong, chargeTotal, boostOf, FULL_CHARGE,
  jumpTuning, jumpPhase, jumpRange, pilotJumpStep, type StarSystemData, type ShipTuning, type FlightBody, type Charge, type ShipDerived,
} from '@space-game/common';
import tuningJson from '../../../data/ships/tuning.json';
import pieces from '../../../data/ships/pieces.json';
import functions from '../../../data/ships/functions.json';
import materials from '../../../data/ships/materials.json';
import models from '../../../data/ships/models.json';

// The HUD pill is a plain div: enough of a DOM for it
(globalThis as any).document ??= { createElement: () => ({ style: {}, textContent: '' }), body: { appendChild: () => {} } };

const { Autopilot, autoSteer, newSteerMemory } = await import('./Autopilot');

const tuning = tuningJson as unknown as ShipTuning;
const SYSTEMS = (JSON.parse(readFileSync(join(__dirname, '../../../data/systems.json'), 'utf-8')) as { systems: StarSystemData[] }).systems;
const catalog = loadCatalog({ pieces, functions, materials, models } as any);
const ship = (name: string): ShipDerived => createShipState(catalog, tuning, 1,
  parseBlueprint(readFileSync(join(__dirname, '../../../data/ships/blueprints', `${name}.json`), 'utf-8')), 0).derived;

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

interface Opts {
  v0?: { x: number; y: number }; angle?: number;
  /** Input delay (ticks): controls apply this long after they're sent */
  delay?: number;
  /** The target circles the origin at this speed (a party member) */
  orbit?: number;
  /** The jump drive is ready to use */
  jumps?: boolean;
  /** Where (default: open space, a pilot's own station's pocket, from the origin) */
  system?: string; from?: { x: number; y: number };
  /** Hostile ships sitting about */
  hostiles?: { x: number; y: number; calm?: boolean }[];
}

/** Fly from the origin to (x, y): how long it took and how much the nose swung about */
function fly(d: ShipDerived, x: number, y: number, opts: Opts = {}) {
  const sys = opts.system ?? 'homestead', from = opts.from ?? { x: 0, y: 0 };
  const body: FlightBody = { x: from.x, y: from.y, vx: opts.v0?.x ?? 0, vy: opts.v0?.y ?? 0, angle: opts.angle ?? -Math.PI / 2, angVel: 0 };
  const me = { id: 1, type: EntityType.Player, x: 0, y: 0, vx: 0, vy: 0, angle: body.angle, renderX: 0, renderY: 0 };
  const other = { id: 2, type: EntityType.Player, x, y, vx: 0, vy: 0, angle: 0, renderX: x, renderY: y };
  const entities = new Map<number, any>([[1, me], [2, other]]);
  (opts.hostiles ?? []).forEach((h, i) => entities.set(10 + i, { id: 10 + i, type: EntityType.ShipBody, x: h.x, y: h.y, renderX: h.x, renderY: h.y, data: [3, 0, 0, 0, 0, 0, 0, 0, 0, h.calm ? 1 : 0] }));
  const state = { systemId: sys, playerId: 1, entities, getRawServerTick: () => 0 } as any;
  const sysData = SYSTEMS.find((s) => s.id === sys);
  const env = { central: sysData?.centralBody, lodestones: sysData?.lodestones };
  let primed = 0;
  const jt = jumpTuning(tuning);
  let charge: Charge = { ...FULL_CHARGE };
  let arrived = false;
  const ap = new Autopilot({
    state, tuning, accel: () => accelAlong(d, [0, -1]), boostFactor: () => boostOf(d), energy: () => chargeTotal(d, charge),
    jumpPhase: () => (opts.jumps ? jumpPhase(body.jump ?? 0, jt).phase : 'cooldown'), jumpReach: () => jumpRange(d, jt),
    objective: () => null, interact: () => {}, arrived: () => { arrived = true; }, message: () => {}, lead: () => opts.delay ?? 0,
    drive: () => {
      if (!opts.jumps) return null;
      const j = jumpPhase(body.jump ?? 0, jt);
      return { range: jumpRange(d, jt), cooldown: jt.cooldownTicks, cool: j.phase === 'ready' ? 0 : j.phase === 'cooldown' ? (1 - j.progress) * jt.cooldownTicks : jt.cooldownTicks, primed };
    },
  });
  ap.engage(opts.orbit ? { kind: 'player', id: 2, system: sys, name: 'them' } : { kind: 'point', system: sys, x, y, name: 'there' });
  const sync = () => { me.x = me.renderX = body.x; me.y = me.renderY = body.y; me.vx = body.vx; me.vy = body.vy; me.angle = body.angle; };
  sync();
  const queue: any[] = [];
  let lastAim: number | null = null;
  /** Ticks the aim swung more than 0.35 rad at once (turning round), and the biggest swing otherwise */
  const flips: number[] = [];
  let maxSwing = 0;
  let ticks = 0, eta = 0, closest = Infinity, starClosest = Infinity, jumped = 0;
  for (; ticks < 60 * 120; ticks++) {
    if (opts.orbit) {
      const r = Math.hypot(x, y), w = opts.orbit / r;
      other.x = other.renderX = Math.cos(w * ticks) * r; other.y = other.renderY = Math.sin(w * ticks) * r;
    }
    const c = ap.tick();
    if (!c) break;
    if (ticks === 0) eta = ap.routeView()?.eta ?? 0;
    for (const h of opts.hostiles ?? []) closest = Math.min(closest, Math.hypot(body.x - h.x, body.y - h.y));
    starClosest = Math.min(starClosest, Math.hypot(body.x, body.y));
    if (lastAim !== null) {
      const j = Math.abs(wrap(c.targetAngle - lastAim));
      if (j > 0.35) flips.push(ticks); else maxSwing = Math.max(maxSwing, j);
    }
    lastAim = c.targetAngle;
    queue.push(c);
    const now = queue.length > (opts.delay ?? 0) ? queue.shift() : { ...c, forward: false, backward: false, left: false, right: false, boost: false, jump: false };
    const before = jumpPhase(body.jump ?? 0, jt).phase;
    primed = pilotJumpStep(body, primed, env, ticks, jt.cooldownTicks, jt, (rangeBoost) => {
      charge = stepShipPhysics(body, { ...now, jumpDist: now.cursorDist }, d, tuning, { charge, drainRate: 1 }, null, rangeBoost).charge;
    });
    if (before !== 'burn' && jumpPhase(body.jump ?? 0, jt).phase === 'burn') jumped++;
    sync();
  }
  return { ticks, arrived, flips, maxSwing, eta, closest, starClosest, jumped };
}

const sparrow = ship('sparrow-t');
/** The starter on the legacy thrusters it flew before (no rated speed): what the old timings were measured on */
const sparrowUnrated = (() => {
  const bp = parseBlueprint(readFileSync(join(__dirname, '../../../data/ships/blueprints/sparrow-t.json'), 'utf-8'));
  for (const q of bp.parts) if (q.fn === 'engine_ion_drive') q.fn = 'thruster';
  return createShipState(catalog, tuning, 1, bp, 0).derived;
})();

describe('autopilot routes', () => {
  it("goes round Sol's star to its far side (flying, and jumping), never into its heat", () => {
    const heat = SYSTEMS.find((s) => s.id === 'sol')!.centralBody!.radius! + 1500;
    for (const jumps of [false, true]) {
      const r = fly(sparrow, 70000, -1000, { system: 'sol', from: { x: -70000, y: 2000 }, jumps });
      expect(r.arrived).toBe(true);
      expect(r.starClosest).toBeGreaterThan(heat);
      if (jumps) expect(r.jumped).toBeGreaterThan(2);
    }
  });

  it('gives a hostile pack in the way a wide berth', () => {
    const pack = [{ x: 20000, y: 0 }, { x: 20500, y: 500 }];
    for (const jumps of [false, true]) {
      const r = fly(sparrow, 40000, 0, { hostiles: pack, jumps });
      expect(r.arrived).toBe(true);
      expect(r.closest).toBeGreaterThan(3000);
      expect(r.flips.length).toBeLessThanOrEqual(2);
    }
  });

  it('its ETA is about how long it really takes, and its jumping about the jump bench', () => {
    // jumpbench.mjs, sparrow-t jumping: 50k / 100k / 150k in 3.8 / 21.4 / 27.9 s (to within 300, not stopped)
    for (const [D, bench] of [[50000, 3.8], [100000, 21.4], [150000, 27.9]]) {
      const r = fly(sparrow, D, 0, { jumps: true });
      expect(r.arrived).toBe(true);
      expect(Math.abs(r.eta - r.ticks) / r.ticks).toBeLessThan(0.2);
      expect(r.ticks / 60).toBeLessThan(bench * 1.3 + 3); // (+ lining up, and settling at the end)
    }
    for (const D of [10000, 50000, 100000]) {
      const r = fly(sparrow, D, 0);
      expect(Math.abs(r.eta - r.ticks) / r.ticks).toBeLessThan(0.2);
    }
  });
});

describe('autopilot flight', () => {
  it("doesn't turn round each time the boost runs out on a long leg (and is quicker for it)", () => {
    // (It used to: the boost ending dropped the speed it wanted below the speed it had, so it turned round to brake)
    for (const [x, y, before] of [[40000, 0, 1690], [20000, -20000, 1194]]) {
      // (The old timings were on unrated engines; the starter's Ion Drives top out at their rating, a little slower)
      const r = fly(sparrowUnrated, x, y);
      expect(r.arrived).toBe(true);
      expect(r.flips).toEqual([]);
      expect(r.maxSwing).toBeLessThan(0.1);
      expect(r.ticks).toBeLessThan(before * 0.9);
      const rated = fly(sparrow, x, y);
      expect(rated.arrived).toBe(true);
      expect(rated.flips).toEqual([]);
      expect(rated.maxSwing).toBeLessThan(0.1);
      expect(rated.ticks).toBeLessThan(before);
    }
  });

  it('holds a steady heading near and far, drifting, chasing, and through the input delay', () => {
    const cases: [number, number, Opts][] = [
      [3000, 1200, {}], [-800, 900, {}], [8000, 0, { v0: { x: 0, y: 25 } }], [8000, 0, { v0: { x: -30, y: 0 }, angle: Math.PI }],
      [1500, 0, { v0: { x: 30, y: 0 }, angle: 0 }], [2500, 0, { v0: { x: 60, y: 0 }, angle: 0 }],
      [20000, 0, { delay: 6 }], [1200, 300, { delay: 6 }], [-5000, -3000, { delay: 6, v0: { x: 20, y: 0 } }],
      [6000, 2000, { orbit: 3 }], [12000, 0, { orbit: 6, delay: 6 }], [70000, 10000, { jumps: true }], [70000, 10000, { jumps: true, delay: 6 }],
    ];
    for (const [x, y, o] of cases) {
      const r = fly(sparrow, x, y, o);
      const what = `${x},${y} ${JSON.stringify(o)}`;
      expect(r.arrived, what).toBe(true);
      expect(r.flips, what).toEqual([]);
      expect(r.maxSwing, what).toBeLessThan(0.25);
    }
  });

  it('a ship that has to brake turns round once, cleanly, and stays turned round', () => {
    // Coming in fast with the input delay (the sparrow), and ships with next to no reverse thrust
    const runs = [fly(sparrow, 2500, 0, { v0: { x: 60, y: 0 }, angle: 0, delay: 6 })];
    for (const name of ['hauler', 'ark-tender', 'sunspear']) {
      const d = ship(name);
      runs.push(fly(d, 3000, 1200), fly(d, 20000, 0, { delay: 6 }), fly(d, 9000, 0, { jumps: true }));
    }
    for (const r of runs) {
      expect(r.arrived).toBe(true);
      // One turn round, maybe a small settle right at the end; never a turn back and forth on the way
      const turnRounds = r.flips.filter((t) => r.flips.every((u) => u >= t || t - u > 20));
      expect(turnRounds.length).toBeLessThanOrEqual(2);
    }
  });
});

describe('autoSteer', () => {
  const base = { dx: 5000, dy: 0, rvx: 0, rvy: 0, a: 0.33, vmax: 21.9, vStop: 60, far: false };

  it('faces the target, leaning a little into sideways drift', () => {
    const mem = newSteerMemory();
    expect(autoSteer({ ...base, rvx: 15 }, mem).targetAngle).toBeCloseTo(0, 5);
    const lean = autoSteer({ ...base, rvx: 15, rvy: 2 }, mem).targetAngle;
    expect(lean).toBeLessThan(0);
    expect(lean).toBeGreaterThan(-0.3);
  });

  it('over top speed with room to stop it coasts (no thrust back, no turning round)', () => {
    const mem = newSteerMemory();
    const s = autoSteer({ ...base, rvx: 30 }, mem);
    expect(mem.braking).toBe(false);
    expect(s.targetAngle).toBeCloseTo(0, 5);
    expect(s.ix).toBe(0);
  });

  it("turns round to brake when it can't stop in time, and stays turned round on the way in", () => {
    const mem = newSteerMemory();
    const s = autoSteer({ ...base, dx: 600, rvx: 25, vStop: 18 }, mem);
    expect(mem.braking).toBe(true);
    expect(Math.abs(s.targetAngle)).toBeCloseTo(Math.PI, 1);
    // A little under the braking curve now: still facing back
    const s2 = autoSteer({ ...base, dx: 400, rvx: 13, vStop: 14 }, mem);
    expect(mem.braking).toBe(true);
    expect(Math.abs(s2.targetAngle)).toBeGreaterThan(2.5);
  });

  it('slow, it brakes on its reverse thrusters without turning round', () => {
    const mem = newSteerMemory();
    const s = autoSteer({ ...base, dx: 150, rvx: 6, vStop: 2 }, mem);
    expect(mem.braking).toBe(false);
    expect(s.ix).toBe(-1);
    expect(s.targetAngle).toBeCloseTo(0, 5);
  });
});

describe('autopilot through gates and rifts', () => {
  /**
   * Fly the sparrow from (x, y) in Sol; pressing X within 300 of a gate takes you through it (arriving 500
   * beside the gate back, stopped, as the server has it), and flying into a rift's 200 takes you through that
   */
  function trip(dest: any, x: number, y: number, ticks = 60 * 60) {
    const systems = (JSON.parse(readFileSync(join(__dirname, '../../../data/systems.json'), 'utf-8')) as { systems: any[] }).systems;
    const body: FlightBody = { x, y, vx: 0, vy: 0, angle: 0, angVel: 0 };
    const me = { id: 1, type: EntityType.Player, x, y, vx: 0, vy: 0, angle: 0, renderX: x, renderY: y };
    const state = { systemId: 'sol', playerId: 1, entities: new Map<number, any>([[1, me]]), getRawServerTick: () => 0 } as any;
    const log: string[] = [];
    let arrivals = 0;
    const through = (to: string, ax: number, ay: number, keep: boolean) => {
      log.push(`${state.systemId}->${to}`);
      state.systemId = to;
      body.x = ax; body.y = ay;
      if (!keep) body.vx = body.vy = 0;
    };
    const ap = new Autopilot({
      state, tuning, accel: () => accelAlong(sparrow, [0, -1]), boostFactor: () => 2.2, energy: () => 100,
      jumpPhase: () => 'cooldown', jumpReach: () => 0, objective: () => null, message: () => {},
      arrived: () => { arrivals++; },
      interact: () => {
        const here = systems.find((s) => s.id === state.systemId);
        const g = here.portals.find((p: any) => Math.hypot(p.position.x - body.x, p.position.y - body.y) < 300);
        if (!g) return;
        const back = systems.find((s) => s.id === g.targetSystem).portals.find((p: any) => p.targetSystem === state.systemId);
        through(g.targetSystem, back.position.x + 500, back.position.y, false);
      },
    });
    ap.engage(dest);
    // (It presses X at most every 1.2 s of real time: run the clock with the ticks)
    let clock = 0;
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    for (let t = 0; t < ticks; t++, clock += 1000 / 60) {
      me.x = me.renderX = body.x; me.y = me.renderY = body.y; me.vx = body.vx; me.vy = body.vy; me.angle = body.angle;
      const c = ap.tick();
      const rift = systems.find((s) => s.id === state.systemId).rifts?.find((r: any) => Math.hypot(r.position.x - body.x, r.position.y - body.y) < 200);
      if (rift) through(rift.destination.system, rift.destination.x, rift.destination.y, true);
      stepShipPhysics(body, c ? { ...c, jumpDist: 0 } : { forward: false, backward: false, left: false, right: false, boost: false, targetAngle: body.angle },
        sparrow, tuning, { charge: { ...FULL_CHARGE }, drainRate: 0 });
    }
    now.mockRestore();
    return { ap, log, arrivals, state };
  }

  it('flying to a gate ends on the far side of it (it used to fly straight back through the gate home, and again, and again)', () => {
    const r = trip({ kind: 'gate', system: 'sol', to: 'borealis', name: 'gate to Borealis' }, 147000, 1000);
    expect(r.log).toEqual(['sol->borealis']);
    expect(r.arrivals).toBe(1);
    expect(r.ap.active).toBe(false);
    expect(r.state.systemId).toBe('borealis');
  });

  it('flying into a rift ends on the far side of it too', () => {
    const r = trip({ kind: 'point', system: 'sol', x: 112326, y: -24656, name: 'the rift' }, 109000, -24656);
    expect(r.log).toEqual(['sol->glasswater']);
    expect(r.ap.active).toBe(false);
  });

  it('a trip to another system goes on through each gate on the way', () => {
    const r = trip({ kind: 'system', system: 'void_sector', name: 'Void Sector' }, 1000, 177000, 60 * 20);
    expect(r.log).toEqual(['sol->nebula_prime']);
    expect(r.ap.active).toBe(true);
    // Heading for Nebula Prime's rift on to the Void Sector, not back to Sol
    const h = r.ap.heading()!;
    expect(Math.hypot(h.x - 32734, h.y + 35803)).toBeLessThan(1);
  });
});
