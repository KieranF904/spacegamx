/**
 * The jump overlay against the jump itself: where jumpLanding (the pilot's reticle) says the ship stops, worked out the
 * moment the drive is switched on and on every tick of its charge, against where stepShipPhysics really leaves it,
 * the aim and distance going as an input says them (quantized). Within 100 units, whatever the ship and its motion.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseBlueprint } from './blueprint.js';
import { createShipState } from './state.js';
import { jumpTuning, jumpPhase, jumpReachAt, jumpBurnAt, jumpChargeNeed, JUMP_ALIGN, wrapAngle, type GravityWell, type FlightConstants } from './flight.js';
import { jumpLanding, jumpGo } from './jumpAim.js';
import { stepShipPhysics } from './physics.js';
import { FULL_CHARGE, type Charge } from './energy.js';
import { readShipJson, testCatalog, SHIP_DATA_DIR } from './testData.js';
import { FRICTION } from '../constants.js';
import { quantizeCursorAngle, dequantizeCursorAngle } from '../network/cursorState.js';
import { cursorDistOnGrid } from '../network/inputCompact.js';

const tuning = readShipJson('tuning.json');
const catalog = testCatalog();
const jt = jumpTuning(tuning);
const ship = (file: string) => createShipState(catalog, tuning, 1, parseBlueprint(readFileSync(join(SHIP_DATA_DIR, 'blueprints', file), 'utf-8')), 0).derived;

interface Case {
  ship?: string; x?: number; y?: number; vx?: number; vy?: number; angle?: number;
  /** The cursor's bearing and distance (0: full reach) */
  aim: number; dist: number;
  /** A charging field's range boost (a star's ring), a hazard, a well */
  boost?: number; hazard?: FlightConstants['hazard']; gravity?: GravityWell;
  helm?: boolean;
  /** Thrust held from the burn on (the pilot flying off as soon as it lands) */
  holdW?: boolean;
}

function jump(c: Case) {
  const d = ship(c.ship ?? 'sparrow-t.json');
  const body = { x: c.x ?? 0, y: c.y ?? 0, vx: c.vx ?? 0, vy: c.vy ?? 0, angle: c.angle ?? 0, angVel: 0, jump: 0, jumpScale: 1 };
  let charge: Charge = structuredClone(FULL_CHARGE);
  const boost = c.boost ?? 1;
  const reach = jumpReachAt(d, jt, boost, c.hazard);
  // (What an input says: the aim on the 13-bit grid, the distance on the compact grid)
  const targetAngle = dequantizeCursorAngle(quantizeCursorAngle(c.aim));
  const jumpDist = cursorDistOnGrid(c.dist);
  const k = { friction: FRICTION, gravity: c.gravity ?? null, hazard: c.hazard };
  const predicted: [number, number][] = [];
  let held = 0;
  // (A short jump charges longer: jumpChargeNeed)
  const need = jumpChargeNeed(jumpGo(jumpDist, reach, jt), jt), burnAt = jumpBurnAt(jt);
  for (let t = 0; t < 4000; t++) {
    const ph = jumpPhase(body.jump, jt).phase;
    if (ph === 'ready' || ph === 'charging') predicted.push(jumpLanding(body, body.jump, c.helm ? body.angle : targetAngle, jumpDist, reach, jt, k));
    if (ph === 'charging' && body.jump >= need - 1) held++;
    const burning = ph === 'burn' || ph === 'cooldown';
    stepShipPhysics(body, {
      forward: !!(c.holdW && burning), backward: false, left: false, right: false, boost: false, targetAngle, helm: !!c.helm,
      strafeLeft: false, strafeRight: false, jump: !burning, jumpDist,
    }, d, tuning, { charge, drainRate: 1, tick: t }, c.gravity ?? null, boost, c.hazard);
    // Where the burn leaves it: its last tick
    if (body.jump === burnAt + jt.burnTicks - 1) {
      const off = predicted.map(([x, y]) => Math.hypot(x - body.x, y - body.y));
      return { off: Math.max(...off), at: [body.x, body.y], speed: Math.hypot(body.vx, body.vy), angle: body.angle, held, reach };
    }
    void charge;
  }
  throw new Error('never burnt');
}

describe('the jump overlay is where the jump lands', () => {
  const cases: [string, Case][] = [
    ['still, dead ahead, 30k', { aim: 0, dist: 30000 }],
    ['still, dead ahead, 49k', { aim: 0, dist: 49000 }],
    ['moving fast sideways', { vy: 40, aim: 0, dist: 30000 }],
    ['moving fast forward', { vx: 40, aim: 0, dist: 30000 }],
    ['moving fast against the aim', { vx: -35, vy: 20, aim: 0.3, dist: 20000 }],
    ['aim 0.5 rad off the nose', { aim: 0.5, dist: 30000 }],
    ['aim 2 rad off the nose', { aim: 2, dist: 30000 }],
    ['aim right behind', { aim: 3.1, dist: 30000 }],
    ['odd angles', { angle: 1.234, aim: -2.7, dist: 27777, vx: 13, vy: -21 }],
    ['past its reach (max range)', { aim: 0.2, dist: 150000 }],
    ['the shortest jump', { aim: -1, dist: 100 }],
    ['a short jump, sliding (a longer charge)', { aim: 0.3, dist: 8000, vx: 25, vy: -10 }],
    ['a jump in the taper', { aim: -0.4, dist: 17000, vy: 18 }],
    ['a star\'s ring, 80k', { aim: 0, dist: 80000, boost: 1.6 }],
    ['a gravity hazard', { x: 30000, y: 8000, vx: -6, aim: 2.5, dist: 40000, hazard: { control: 0.7, driftAccel: 0.007, jump: 0.55, cap: 1 } }],
    ['a black hole\'s well', { x: 20000, y: -15000, aim: 1, dist: 30000, gravity: { strength: 2e6, minRadius: 3000 } }],
    ['a big, slow-turning ship', { ship: 'bastion.json', aim: 2.8, dist: 30000, vx: 10 }],
    ['a galleon, turning while moving', { ship: 'galleon.json', aim: -2, dist: 45000, vy: 15 }],
    ['helm: along the nose', { helm: true, angle: 0.7, aim: 2, dist: 30000, vx: 20 }],
    ['thrust held from the burn on', { aim: 0.4, dist: 30000, holdW: true }],
  ];
  it.each(cases)('%s', (_, c) => {
    const r = jump(c);
    expect(r.off, JSON.stringify(r)).toBeLessThan(100);
    // It stops dead where it lands (no coast to drift off the mark)
    expect(r.speed).toBe(0);
    // Mouse-steered, the burn went along the aim itself
    if (!c.helm) expect(Math.abs(wrapAngle(r.angle - c.aim))).toBeLessThan(0.002);
  });

  it('a hazard\'s jump share shortens the reach, and the overlay\'s reach is the burn\'s', () => {
    const r = jump({ aim: 0, dist: 0, hazard: { control: 1, driftAccel: 0, jump: 0.6, cap: 1 } });
    expect(Math.hypot(r.at[0], r.at[1])).toBeCloseTo(r.reach, -2);
    expect(r.reach).toBeCloseTo(jumpReachAt(ship('sparrow-t.json'), jt) * 0.6, 6);
  });

  it('a charge waits on its last tick for a slow ship to come round, and never burns off the aim', () => {
    const r = jump({ ship: 'bastion.json', aim: 3.1, dist: 30000 });
    expect(r.held).toBeGreaterThan(1);
    expect(Math.abs(wrapAngle(r.angle - 3.1))).toBeLessThan(JUMP_ALIGN);
  });
});
