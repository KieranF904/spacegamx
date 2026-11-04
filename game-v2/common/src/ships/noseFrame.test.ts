/**
 * Mouse-steer in the nose frame (flight.ts noseFrame, hits.ts CAPS.NOSE): the view on the heading, the movement keys push
 * along the ship. Said by both strafe bits with helm off; any other combination flies as it always did.
 */
import { describe, it, expect } from 'vitest';
import type { ShipTuning } from './tuning.js';
import { stepFlight, noseFrame, type FlightBody, type FlightControls } from './flight.js';
import { createShipState } from './state.js';
import { parseBlueprint } from './blueprint.js';
import { readShipJson, testCatalog, SHIP_DATA_DIR } from './testData.js';
import { readFileSync } from 'fs';
import { join } from 'path';
import { FRICTION, BOOST_FACTOR, WORLD_SIZE } from '../constants.js';

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');
const K = { friction: FRICTION, boostFactor: BOOST_FACTOR, worldSize: WORLD_SIZE };
const sparrow = parseBlueprint(readFileSync(join(SHIP_DATA_DIR, 'blueprints/sparrow-t.json'), 'utf-8'));
const d = createShipState(catalog, tuning, 1, sparrow, 0).derived;

const KEYS = { forward: false, backward: false, left: false, right: false, boost: false };
/** A few ticks from rest, the nose held at `angle` (the aim on it): which way it went (unit vector) */
function push(angle: number, c: Partial<FlightControls>): { x: number; y: number; body: FlightBody } {
  const body: FlightBody = { x: 0, y: 0, vx: 0, vy: 0, angle, angVel: 0 };
  for (let t = 0; t < 10; t++) stepFlight(body, { ...KEYS, targetAngle: angle, ...c }, d, tuning, { fuel: 0, drainRate: 0 } as never, K);
  const m = Math.hypot(body.x, body.y);
  return { x: body.x / m, y: body.y / m, body };
}

describe('noseFrame: mouse-steer, the keys along the ship', () => {
  it('is both strafe bits with helm off, and nothing else', () => {
    expect(noseFrame({ strafeLeft: true, strafeRight: true })).toBe(true);
    expect(noseFrame({ strafeLeft: true, strafeRight: true, helm: true })).toBe(false);
    expect(noseFrame({ strafeLeft: true })).toBe(false);
    expect(noseFrame({ strafeRight: true })).toBe(false);
    expect(noseFrame({})).toBe(false);
  });

  it('W pushes along the nose, S back, A/D to its sides, whichever way the ship points', () => {
    const nose = { strafeLeft: true, strafeRight: true };
    for (const a of [0, 0.7, Math.PI / 2, -2.4, Math.PI]) {
      // (An entity's angle points its nose along +x)
      const f = push(a, { ...nose, forward: true });
      expect(f.x).toBeCloseTo(Math.cos(a), 3); expect(f.y).toBeCloseTo(Math.sin(a), 3);
      const b = push(a, { ...nose, backward: true });
      expect(b.x).toBeCloseTo(-Math.cos(a), 3); expect(b.y).toBeCloseTo(-Math.sin(a), 3);
      // (Right of the nose: a quarter turn clockwise on screen, +angle)
      const r = push(a, { ...nose, right: true });
      expect(r.x).toBeCloseTo(Math.cos(a + Math.PI / 2), 3); expect(r.y).toBeCloseTo(Math.sin(a + Math.PI / 2), 3);
      const l = push(a, { ...nose, left: true });
      expect(l.x).toBeCloseTo(Math.cos(a - Math.PI / 2), 3); expect(l.y).toBeCloseTo(Math.sin(a - Math.PI / 2), 3);
    }
  });

  it('with no key held, the pair alone pushes nothing (as the two cancel at the helm)', () => {
    const r = push(0.4, { strafeLeft: true, strafeRight: true });
    expect([r.body.x, r.body.y, r.body.vx, r.body.vy]).toEqual([0, 0, 0, 0]);
  });

  it('legacy mouse-steer is untouched: W is up the world whatever the nose, a single strafe bit is ignored', () => {
    for (const c of [{}, { strafeLeft: true }, { strafeRight: true }]) {
      const f = push(1.1, { ...c, forward: true });
      expect(f.x).toBeCloseTo(0, 6); expect(f.y).toBeCloseTo(-1, 6);
    }
  });

  it('flies the same bit for bit from the same inputs (the tick layer and the server step the one function)', () => {
    const run = () => {
      const body: FlightBody = { x: 10, y: -5, vx: 0.3, vy: 0, angle: 0.2, angVel: 0 };
      for (let t = 0; t < 120; t++) {
        stepFlight(body, { ...KEYS, forward: t % 40 < 25, right: t % 30 > 18, targetAngle: 0.2 + t * 0.02, strafeLeft: true, strafeRight: true },
          d, tuning, { fuel: 0, drainRate: 0 } as never, K);
      }
      return [body.x, body.y, body.vx, body.vy, body.angle, body.angVel];
    };
    expect(run()).toEqual(run());
  });
});
