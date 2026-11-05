/**
 * The F9 dev test ships (data/ships/blueprints/dev/test-*.json): loaded the way the server's devShip does
 * (loadShipConfigFromDisk -> config.dev), each validates and mounts cleanly, carries the part it exists to test,
 * and flies on its power (the Brownout one is short on purpose).
 */
import { describe, it, expect } from 'vitest';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  loadCatalog, validateBlueprint, createShipState, loadTest, stepShipPhysics, strafeForce, burstEnergy, chargeTotal,
  DODGE_FORWARD, DODGE_BACK, DODGE_LEFT, DODGE_RIGHT, FULL_CHARGE, type ShipTuning, type Charge, type FlightBody,
} from '@space-game/common';
import { loadShipConfigFromDisk } from './loadShipConfig.js';

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '../../../data');
const cfg = loadShipConfigFromDisk(dataDir);
const catalog = loadCatalog(cfg.catalog as never);
const tuning = cfg.tuning as ShipTuning;

const CARRIES: Record<string, string[]> = {
  'test-tow-hauler': ['utility_tow_beam', 'cargo'],
  'test-strafer': ['engine_burst_strafer', 'power_drive_cell'],
  'test-surge-striker': ['power_pulse_dynamo', 'railgun_rail_driver', 'shield_flash_screen', 'power_capacitor'],
  'test-support': ['utility_repair_beam', 'point_defence_turret'],
  'test-brownout': ['power_capacitor'],
};
const dev = cfg.dev ?? {};

describe('dev test ships (F9)', () => {
  it('all five are in the dev set', () => {
    for (const id of Object.keys(CARRIES)) expect(dev[id], id).toBeDefined();
  });
  for (const [id, fns] of Object.entries(CARRIES)) {
    describe(id, () => {
      it('validates, mounting rules included', () => {
        expect(validateBlueprint(catalog, dev[id], tuning, null).errors).toEqual([]);
      });
      it('carries its test parts', () => {
        for (const fn of fns) expect(dev[id].parts.some((p) => p.fn === fn), fn).toBe(true);
      });
      it(id === 'test-brownout' ? 'browns out when firing and boosting, and refills when you ease off' : 'has positive spare power at idle and does not brown out thrusting and firing', () => {
        const d = createShipState(catalog, tuning, 1, dev[id], 0).derived;
        const t = loadTest(d, tuning, { fire: true, thrust: true, boost: id === 'test-brownout', seconds: id === 'test-brownout' ? 30 : 10 });
        const browned = t.brownAt >= 0;
        if (id === 'test-brownout') {
          expect(browned).toBe(true);
          expect(t.refill).toBeLessThan(Infinity); // and it recovers when you ease off
        } else {
          expect(d.energy!.spare, 'spare').toBeGreaterThan(0);
          expect(browned, JSON.stringify(t)).toBe(false);
        }
      });
    });
  }
  it('the strafer dodges every way, Drive Cell banks touch its flank strafers, and a run of dodges is backed before the ship browns out', () => {
    const d = createShipState(catalog, tuning, 1, dev['test-strafer'], 0).derived;
    const s = d.fx!.strafe!;
    for (const way of [DODGE_FORWARD, DODGE_BACK, DODGE_LEFT, DODGE_RIGHT]) expect(strafeForce(s, way), String(way)).toBeGreaterThan(0);
    const L = d.power!;
    expect(s.parts.filter((p) => L.feeds[L.feedOf[p.part]].banks.length > 0).length).toBeGreaterThanOrEqual(4);
    expect(burstEnergy(d, DODGE_LEFT)).toBeGreaterThan(100);
    // Dodging left as often as it allows: the first several get their full push, then the ship can't keep up
    let charge: Charge = FULL_CHARGE;
    const kicks: number[] = [];
    for (let n = 0; n < 30; n++) {
      const b: FlightBody = { x: 0, y: 0, vx: 0, vy: 0, angle: -Math.PI / 2, angVel: 0, jump: 0, dodgeDir: 1 };
      for (let i = 0; i < s.cooldown; i++) {
        charge = stepShipPhysics(b, { forward: false, backward: false, left: false, right: false, boost: false, targetAngle: -Math.PI / 2, dodge: i < 4 }, d, tuning, { charge, drainRate: 1 }).charge;
      }
      kicks.push(-b.x);
    }
    expect(kicks[0]).toBeGreaterThan(0);
    expect(kicks.slice(0, 8).every((k) => Math.abs(k - kicks[0]) < 1e-6 * kicks[0] + 1e-9)).toBe(true);
    expect(kicks[kicks.length - 1]).toBeLessThan(kicks[0] * 0.8);
    expect(chargeTotal(d, charge)).toBeLessThan(50);
  });
  it('the striker has a Capacitor bank with its Pulse Dynamos against it, feeding the Rail Driver', () => {
    const d = createShipState(catalog, tuning, 1, dev['test-surge-striker'], 0).derived, L = d.power!;
    const rail = dev['test-surge-striker'].parts.findIndex((p) => p.fn === 'railgun_rail_driver');
    const bank = L.banks.find((b) => b.kind === 'cap')!;
    expect(bank.dynamos.length).toBe(2);
    expect(bank.dynamo).toBeCloseTo(20, 6);
    expect(bank.feeds).toContain(rail);
  });
});
