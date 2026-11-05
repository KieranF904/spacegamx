/**
 * The shot behaviours' shared half (features/weaponry): each weapon role's contract (what picks it, what it changes on
 * the shared side), the aim maths, the guided steer, and replica parity for a slowed ship (Player and Pilotless).
 * The server half's behaviour (the shells and beams in a running world) is server/src/game/shotBehaviours.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { getPlan, weaponRole } from '../plan.js';
import { feature } from './index.js';
import {
  ROLE_END_AT_AIM, ROLE_WALK, ROLE_GUIDED, ROLE_MARK, ROLE_SLOW, MARK_TAKEN, STATUS_MARKED, STATUS_SLOWED, statusBits, steerToward,
} from './weaponry.js';
import { readShipJson, testCatalog, SHIP_DATA_DIR } from '../../testData.js';
import type { ShipTuning, WeaponTuning } from '../../tuning.js';
import { gunDef, firesStraight, endsAtAim, aimReach, lifeToReach, MIN_AIM_REACH } from '../../launch.js';
import { parseBlueprint } from '../../blueprint.js';
import { createShipState } from '../../state.js';
import { stepShipPhysics } from '../../physics.js';
import { FULL_CHARGE } from '../../energy.js';
import { withSlowed, SLOW_CONTROL, type FlightBody } from '../../flight.js';
import { withEmp } from '../../hazards.js';
import { CTL, ReplicaMode, controlBits, flightControls, replicaStep } from '../../replica.js';
import { gridAim } from '../../../sim/a-adapt.js';
import { newFlightControls } from '../../flightInputs.js';
import { NO_FIELDS } from '../../jumpFields.js';

const tuning: ShipTuning = readShipJson('tuning.json');
const catalog = testCatalog();

/** Every weapon model's resolved tuning (its kind's with its model's changes: launch.ts gunDef) */
const models: [string, WeaponTuning][] = [...catalog.functions.values()]
  .filter((f) => f.model && f.weapon)
  .map((f) => [f.id, gunDef(tuning, f.weapon!, { model: f.weaponMods })]);

const playing = (role: string) => {
  const r = weaponRole(getPlan(), 'weaponry', role);
  return models.filter(([, d]) => r.applies(d)).map(([id]) => id).sort();
};

describe('weaponry: a weapon-kind feature', () => {
  it('gives no function a feature of its own, and comes after every feature before it (a later one, the Gyro, goes after it: numbers never move)', () => {
    expect(feature.applies({} as never)).toBe(false);
    const P = getPlan();
    for (const f of P.features) if (f.id !== 'weaponry' && f.order <= feature.order) expect(P.byId.get('weaponry')!).toBeGreaterThan(P.byId.get(f.id)!);
  });
  it('no role picks a gun with no tuning', () => {
    for (const r of feature.weapon!) expect(r.applies(undefined)).toBe(false);
  });
});

describe('weaponry role: endAtAim (bursts or splits at the aim distance)', () => {
  it('picks the aim bursts and the walking salvo, and no beam', () => {
    expect(playing(ROLE_END_AT_AIM)).toEqual(['emp_blackout', 'flak_cloudmaker', 'legendary_prism', 'legendary_singularity', 'mortar_quake']);
  });
  it('its shells are sent as they fly (the aim is the server\'s), and fly the mortar\'s land-at-cursor maths', () => {
    for (const id of ['emp_blackout', 'flak_cloudmaker', 'legendary_prism']) {
      const d = models.find(([m]) => m === id)![1];
      expect(endsAtAim(d), id).toBe(true);
      expect(firesStraight(d), id).toBe(false);
    }
    // (Their family's plain guns stay straight flyers, predicted by the pilot)
    for (const id of ['flak_burst', 'emp_hush']) expect(firesStraight(models.find(([m]) => m === id)![1]), id).toBe(true);
    const d = models.find(([m]) => m === 'flak_cloudmaker')![1];
    expect(aimReach(900, d)).toBe(900);
    expect(aimReach(0, d)).toBe(MIN_AIM_REACH);
    // Cut to the aim, never past its own life, never under 10 ticks
    expect(lifeToReach(50, 34, 900)).toBe(Math.round(900 / 34));
    expect(lifeToReach(50, 34, 99999)).toBe(50);
    expect(lifeToReach(50, 34, 1)).toBe(10);
  });
  it('the lobbed mortar is unchanged: the same reach it always had', () => {
    const lob = models.find(([m]) => m === 'mortar_lobber')![1];
    for (const dist of [0, 150, 900, 2500]) expect(aimReach(dist, lob)).toBe(Math.max(200, dist));
  });
});

describe('weaponry role: walk (a salvo landing along the aim)', () => {
  it('picks the Quake only', () => {
    expect(playing(ROLE_WALK)).toEqual(['mortar_quake']);
  });
  it('its shells land at 70%, 100% and 130% of the aim distance, a quarter second apart', () => {
    const d = models.find(([m]) => m === 'mortar_quake')![1];
    expect(d.walk).toEqual({ at: [0.7, 1, 1.3], gap: 15 });
    expect([0, 1, 2].map((i) => aimReach(1000, d, i))).toEqual([700, 1000, 1300]);
    // (a shell past the list lands where the last does)
    expect(aimReach(1000, d, 9)).toBe(1300);
    // (Its salvo costs its rounds from the hold: the firing model's)
    expect(catalog.functions.get('mortar_quake')!.fire!.rounds).toBe(3);
  });
});

describe('weaponry role: guided (steers to the cursor while held)', () => {
  it('picks the Hammerhead only, which is no longer a straight flyer', () => {
    expect(playing(ROLE_GUIDED)).toEqual(['missile_hammerhead']);
    expect(firesStraight(models.find(([m]) => m === 'missile_hammerhead')![1])).toBe(false);
  });
  it('turns toward the target by at most its rate a tick, the short way round, and points at it once within it', () => {
    const out = { x: 0, y: 0 };
    // Heading east, the cursor due north: it turns left by exactly `turn`
    steerToward(0, 0, 10, 0, 0, -100, 0.05, out);
    expect(Math.atan2(out.y, out.x)).toBeCloseTo(-0.05, 12);
    expect(Math.hypot(out.x, out.y)).toBeCloseTo(1, 12);
    // Nearly on it: it points straight at it
    steerToward(0, 0, 10, 0, 100, 2, 0.05, out);
    expect(Math.atan2(out.y, out.x)).toBeCloseTo(Math.atan2(2, 100), 12);
    // Behind it, just past the back: it takes the short way (across the ±π seam)
    steerToward(0, 0, -10, 0.01, -100, -10, 0.05, out);
    expect(Math.atan2(out.y, out.x)).toBeLessThan(0);
  });
});

describe('weaponry role: mark (a beam whose target takes more from everyone)', () => {
  it('picks the Searchlight only, a beam', () => {
    expect(playing(ROLE_MARK)).toEqual(['laser_searchlight']);
    const d = models.find(([m]) => m === 'laser_searchlight')![1];
    expect(d.type).toBe('beam');
    // While lit and 2 s after, +20%
    expect(d.mark).toEqual({ ticks: 120 });
    expect(MARK_TAKEN).toBe(1.2);
  });
  it('shows in the status row as a bit', () => {
    expect(statusBits(true, false)).toBe(STATUS_MARKED);
    expect(statusBits(false, true)).toBe(STATUS_SLOWED);
    expect(statusBits(true, true)).toBe(STATUS_MARKED | STATUS_SLOWED);
    expect(statusBits(false, false)).toBe(0);
  });
});

describe('weaponry role: slow (a beam whose target flies slowed)', () => {
  it('picks the Frostbite only (its kind\'s), which no longer chills', () => {
    expect(playing(ROLE_SLOW)).toEqual(['legendary_frostbite']);
    const d = tuning.weapons!.frostbite;
    expect(d.slow).toEqual({ ticks: 42 });
    expect((d as Record<string, unknown>).chill).toBeUndefined();
    expect(SLOW_CONTROL).toBe(0.6);
  });
  it('the bridge has no beam chill path left', () => {
    const src = readFileSync(join(__dirname, '../../../../../server/src/ships/bridge/weapons.ts'), 'utf8');
    expect(src).not.toMatch(/def\.chill|frostHit/);
  });
  it('withSlowed: thrust and turning × SLOW_CONTROL on top of what else holds the drive, nothing when not slowed', () => {
    expect(withSlowed(undefined, false)).toBeUndefined();
    expect(withSlowed(undefined, true)).toEqual({ control: SLOW_CONTROL, driftAccel: 0, jump: 1, cap: 1 });
    const h = { control: 0.5, driftAccel: 0.1, jump: 0.8, cap: 0.7 };
    expect(withSlowed(h, false)).toBe(h);
    expect({ ...withSlowed(h, true)! }).toEqual({ control: 0.5 * SLOW_CONTROL, driftAccel: 0.1, jump: 0.8, cap: 0.7 });
  });
});

// ---- Replica parity with slowed on: the server's flight (stepShipPhysics with the slowed hazard) against replicaStep
// on the control bits (CTL.slowed), tick for tick, for a pilot's ship and a pilotless one, EMP'd too on some ticks.

const sparrow = () => createShipState(catalog, tuning, 1, parseBlueprint(readFileSync(join(SHIP_DATA_DIR, 'blueprints/sparrow-t.json'), 'utf-8')), 0);

function fly(mode: ReplicaMode.Player | ReplicaMode.Pilotless, replica: boolean, slowedOn: (t: number) => boolean): number[][] {
  const s = sparrow(), d = s.derived;
  const body: FlightBody = { x: 0, y: 0, vx: 0, vy: 0, angle: -Math.PI / 2, angVel: 0, jump: 0, cargo: 0 };
  const rows: number[][] = [];
  for (let t = 0; t < 200; t++) {
    const keys = { forward: t < 150, left: t >= 40 && t < 60, right: t >= 120, boost: t >= 70 && t < 90, strafeLeft: t >= 100 && t < 115 };
    const aim = gridAim(-Math.PI / 2 + Math.sin(t / 20) * 0.8); // (aims come on the grid: sim/input.ts simAim)
    const slowed = slowedOn(t), emp = t >= 160 && t < 175;
    if (replica) {
      const bits = controlBits(keys) | (slowed ? CTL.slowed : 0) | (emp ? CTL.emp : 0);
      replicaStep(mode, body, { bits, targetAngle: aim }, d, tuning, { gravity: null, central: null, ...NO_FIELDS }, t + 1);
    } else {
      // (What the server flies: the controls the bits give back, the drive slowed, then EMP'd; bridge/flight.ts, pilotless.ts)
      const c = flightControls({ bits: controlBits({ ...newFlightControls(), ...keys }), targetAngle: aim }, body);
      const h = withSlowed(undefined, slowed);
      stepShipPhysics(body, c, d, tuning, { charge: FULL_CHARGE, drainRate: 0 }, null, 1, emp ? withEmp(h) : h, null);
    }
    rows.push([body.x, body.y, body.vx, body.vy, body.angle, body.angVel]);
  }
  return rows;
}

describe('weaponry: a slowed ship\'s replica flies it the same, tick for tick', () => {
  const windows = (t: number) => (t >= 10 && t < 80) || (t >= 130 && t < 170);
  for (const mode of [ReplicaMode.Player, ReplicaMode.Pilotless] as const) {
    it(`${ReplicaMode[mode]}: replicaStep on CTL.slowed matches the server's slowed flight bit for bit`, () => {
      const server = fly(mode, false, windows), replica = fly(mode, true, windows);
      for (const row of server) for (const v of row) expect(Number.isFinite(v)).toBe(true);
      expect(replica).toEqual(server);
    });
    it(`${ReplicaMode[mode]}: slowed it covers less ground and turns less than unslowed`, () => {
      const slowed = fly(mode, false, windows), plain = fly(mode, false, () => false);
      expect(slowed).not.toEqual(plain);
      const speed = (r: number[]) => Math.hypot(r[2], r[3]);
      // (Thrusting from rest, slowed the whole first window: slower at its end)
      expect(speed(slowed[79])).toBeLessThan(speed(plain[79]));
      // (Unslowed throughout, the replica of a slowed-free ship needs no bit)
      expect(fly(mode, true, () => false)).toEqual(plain);
    });
  }
});
