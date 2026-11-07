import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { Blueprint, InventoryStub, PlacedPart, Rot } from './types.js';
import { parseBlueprint, validateBlueprint } from './blueprint.js';
import { createShipState, damagePart, rebuildShip } from './state.js';
import { stepTurretAim, pointTurretAim, TurretWindow } from './turret.js';
import { stepGuns } from './guns.js';
import { stepFlight, FlightBody } from './flight.js';
import type { ShipTuning } from './tuning.js';
import { readShipJson, testCatalog, SHIP_DATA_DIR } from './testData.js';
import { encodeInputBinary, decodeInputBinary } from '../network/protocol.js';
import { FRICTION, BOOST_FACTOR, WORLD_SIZE } from '../constants.js';

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');
const inventory: InventoryStub = readShipJson('inventory.json');
const corsair = () => parseBlueprint(readFileSync(join(SHIP_DATA_DIR, 'blueprints/fixtures/corsair.json'), 'utf-8'));
const K = { friction: FRICTION, boostFactor: BOOST_FACTOR, worldSize: WORLD_SIZE };
const DEG = Math.PI / 180;

function p(uid: number, piece: string, fn: string, x: number, y: number, extra: Partial<PlacedPart> = {}): PlacedPart {
  return { uid, piece, fn, material: 'alloy', x, y, rot: 0 as Rot, flip: false, ...extra };
}
const bp = (parts: PlacedPart[]): Blueprint => ({ name: 'test', catalogVersion: 1, parts });
const span = (w: TurretWindow) => w.open.reduce((s, [lo, hi]) => s + (hi - lo), 0) / DEG;

describe('turret windows', () => {
  it('Corsair is valid, with eight broadside turrets', () => {
    expect(validateBlueprint(catalog, corsair(), tuning, inventory).errors).toEqual([]);
    const s = createShipState(catalog, tuning, 1, corsair(), 0);
    const turrets = s.derived.weapons.filter((w) => w.mount === 'turret');
    expect(turrets).toHaveLength(8);
    expect(s.derived.alive.every(Boolean)).toBe(true);
    for (const n of s.derived.networks) expect(n.supply).toBeGreaterThanOrEqual(n.demand);
  });

  it('a flush gunport is limited by the hull above and below it', () => {
    const s = createShipState(catalog, tuning, 1, corsair(), 0);
    for (const w of s.derived.weapons) {
      const deg = span(w.window!);
      expect(deg, `turret ${w.uid}`).toBeGreaterThan(60);
      expect(deg, `turret ${w.uid}`).toBeLessThan(130);
      // Never wider than the base window
      for (const [lo, hi] of w.window!.open) {
        expect(lo).toBeGreaterThanOrEqual(-w.window!.half - 1e-9);
        expect(hi).toBeLessThanOrEqual(w.window!.half + 1e-9);
      }
    }
  });

  it('a turret sticking out on its own gets the full base window', () => {
    const s = createShipState(catalog, tuning, 1, bp([
      p(0, 'sq', 'core', 0, 0),
      p(1, 'sq', 'generator', 0, 1),
      p(2, 'sq', 'weapon', -1, 0, { facing: 'W', mount: 'turret' }),
    ]), 0);
    const w = s.derived.weapons[0].window!;
    expect(w.open).toHaveLength(1);
    expect(span(w)).toBeCloseTo(2 * tuning.turret.halfArcDeg, 6);
  });

  it('a window opens up when the hull blocking it is destroyed', () => {
    const s = createShipState(catalog, tuning, 1, corsair(), 0);
    // Port gunport at y = -2 has hull at (-2,-3) above it
    const gun = s.blueprint.parts.findIndex((q) => q.x === -2 && q.y === -2);
    const hull = s.blueprint.parts.findIndex((q) => q.x === -2 && q.y === -3);
    const before = span(s.derived.weapons.find((w) => w.part === gun)!.window!);
    damagePart(s, hull, 1e9, tuning);
    rebuildShip(s, catalog, tuning);
    const after = span(s.derived.weapons.find((w) => w.part === gun)!.window!);
    expect(after).toBeGreaterThan(before + 20);
  });

  it('turret mounts are only allowed on weapons', () => {
    const b = corsair();
    b.parts.find((q) => q.fn === 'hull')!.mount = 'turret';
    expect(validateBlueprint(catalog, b, tuning, null).errors.map((e) => e.code)).toContain('badMount');
  });
});

describe('turret aiming', () => {
  const s = createShipState(catalog, tuning, 1, corsair(), 0);
  const w = s.derived.weapons.find((x) => x.mount === 'turret')!.window!;

  it('slews at its rate and fires once aligned inside the open window', () => {
    let off = 0;
    const target = w.center + w.open[0][0] / 2; // halfway to the lower edge of the open window
    let res = stepTurretAim(w, off, target, tuning);
    expect(Math.abs(res.offset - off)).toBeLessThanOrEqual(tuning.turret.slewRate + 1e-12);
    for (let i = 0; i < 60; i++) { res = stepTurretAim(w, off, target, tuning); off = res.offset; }
    expect(res.canFire).toBe(true);
  });

  it('never fires into its own hull, even when told to aim there', () => {
    // Aim at the closed sector just past the window's open edge (still inside the base window)
    const blocked = w.center + Math.max(...w.open.map(([, hi]) => hi)) + 10 * DEG;
    let off = 0;
    let fired = false;
    for (let i = 0; i < 120; i++) {
      const r = stepTurretAim(w, off, blocked, tuning);
      off = r.offset;
      fired ||= r.canFire;
    }
    expect(fired).toBe(false);
  });

  it('does not fire at targets behind it', () => {
    let off = 0;
    let fired = false;
    for (let i = 0; i < 120; i++) {
      const r = stepTurretAim(w, off, w.center + Math.PI, tuning);
      off = r.offset;
      fired ||= r.canFire;
    }
    expect(fired).toBe(false);
  });
});

describe('turret slew only while firing (stepGuns)', () => {
  const s = createShipState(catalog, tuning, 1, corsair(), 0);
  const tw = s.derived.weapons.find((x) => x.mount === 'turret')!;
  const w = tw.window!, p = tw.part;
  const pose = { x: 0, y: 0, angle: 0 };
  // (an aim along the window, as a world angle: grid forward is -y)
  const world = (local: number) => local + Math.PI / 2;
  const far = w.center + w.half * 0.8, near = w.center - w.half * 0.8;

  it('pointTurretAim points straight at the aim (clamped to its base window), from anywhere', () => {
    expect(pointTurretAim(w, far, tuning).offset).toBeCloseTo(w.half * 0.8, 12);
    expect(pointTurretAim(w, w.center + w.half + 0.1, tuning).offset).toBeCloseTo(w.half, 12);
  });

  it('idle: the turret points at the aim every tick, carrying nothing; held: it slews at its rate from the trigger-down aim', () => {
    s.triggerHeld = false;
    s.aim[p] = 0;
    // (idle, the aim swung across: on it at once, tick by tick)
    stepGuns(s, pose, { firing: false, aimWorld: world(far), aimDist: 0 }, 1, tuning);
    expect(s.aim[p]).toBeCloseTo(w.half * 0.8, 12);
    stepGuns(s, pose, { firing: false, aimWorld: world(near), aimDist: 0 }, 2, tuning);
    expect(s.aim[p]).toBeCloseTo(-w.half * 0.8, 12);
    // (the trigger goes down on another aim: on it at once, whatever the idle ticks before had)
    stepGuns(s, pose, { firing: true, aimWorld: world(far), aimDist: 0 }, 3, tuning);
    expect(s.aim[p]).toBeCloseTo(w.half * 0.8, 6);
    // (held, the aim swung across: it slews, its rate a tick)
    const was = s.aim[p];
    stepGuns(s, pose, { firing: true, aimWorld: world(near), aimDist: 0 }, 4, tuning);
    expect(was - s.aim[p]).toBeCloseTo(tuning.turret.slewRate, 2);
    // (let go: on the aim again at once)
    stepGuns(s, pose, { firing: false, aimWorld: world(near), aimDist: 0 }, 5, tuning);
    expect(s.aim[p]).toBeCloseTo(-w.half * 0.8, 12);
  });

  it('what fires after a trigger-down depends only on the aim from then, not the idle ticks before it', () => {
    const run = (idle: number[]) => {
      const t = createShipState(catalog, tuning, 1, corsair(), 0);
      idle.forEach((a, i) => stepGuns(t, pose, { firing: false, aimWorld: world(a), aimDist: 900 + 50 * i }, i + 1, tuning));
      const out: number[] = [];
      for (let k = 0; k < 40; k++) {
        const st = stepGuns(t, pose, { firing: true, aimWorld: world(w.center + 0.3 * Math.sin(k / 5)), aimDist: 700 }, 100 + k, tuning);
        out.push(...st.shots.map((x) => x.aimQ * 1000 + x.w.part), ...t.aim);
      }
      return out;
    };
    expect(run([far, near, far])).toEqual(run([near, w.center, near, far, near]));
  });
});

describe('a pilot\'s held aim distance (stepGuns hold, distDue)', () => {
  const pose = { x: 0, y: 0, angle: 0 };
  const aimWorld = -Math.PI / 2 + 0.2;
  // (the cursor's distance moving every tick)
  const cursor = (t: number) => 600 + 4 * ((t * 7) % 50);

  it('held, the guns step on a distance that takes the cursor\'s only on a gun\'s fire tick and halfway to its next', () => {
    const s = createShipState(catalog, tuning, 1, corsair(), 0);
    const guns = s.derived.weapons.filter((x) => x.fire.model === 'cycle' && !x.fire.semi && !tuning.weapons?.[x.kind]?.pointDefence);
    expect(guns.length).toBeGreaterThan(0);
    let takes = 0, prev = -1;
    for (let t = 1; t <= 240; t++) {
      // (each gun's cooldown as the tick begins: due on reaching 0 or crossing half its interval)
      const due = t === 1 || guns.some((w) => { const cd0 = s.cooldown[w.part], cd = cd0 - 1; const half = w.interval / 2; return (cd <= 0 && (cd0 > 0 || t % Math.max(1, Math.round(half)) === 0)) || (cd0 > half && cd <= half); });
      const st = stepGuns(s, pose, { firing: true, aimWorld, aimDist: cursor(t), hold: true }, t, tuning);
      if (due) expect(st.dist).toBe(cursor(t));
      else expect(st.dist).toBe(prev);
      expect(s.heldDist).toBe(st.dist);
      // (every shot fires on its gun's due tick: at the cursor's distance exactly)
      if (st.shots.length) expect(st.dist).toBe(cursor(t));
      if (st.dist !== prev) takes++;
      prev = st.dist;
    }
    // (far fewer than one a tick)
    expect(takes).toBeLessThan(240 / 2);
    expect(takes).toBeGreaterThan(5);
  });

  it('a semi-automatic clip clicked through its reload takes the cursor\'s distance only when it can fire again', () => {
    // (a Sparrow whose Pips are Rail Drivers, clicked as fast as a pilot spams it: down two ticks, up one)
    const sp = parseBlueprint(readFileSync(join(SHIP_DATA_DIR, 'blueprints/sparrow-t.json'), 'utf-8'));
    for (const q of sp.parts) if (q.fn === 'cannon_pip') q.fn = 'railgun_rail_driver';
    const s = createShipState(catalog, tuning, 1, sp, 0);
    const rail = s.derived.weapons.filter((w) => w.fire.semi);
    expect(rail.length).toBe(2);
    const up = { x: 0, y: 0, angle: -Math.PI / 2 };
    let takes = 0, shots = 0, reloadTicks = 0, reloadTakes = 0, prev = -1;
    for (let t = 1; t <= 600; t++) {
      const held = t % 3 !== 0;
      const reloading = rail.every((w) => s.reload[w.part] > 1);
      const st = stepGuns(s, up, { firing: held, aimWorld: -Math.PI / 2, aimDist: cursor(t), hold: true }, t, tuning);
      // (every shot flies at the cursor's distance exactly)
      for (const _ of st.shots) { shots++; expect(st.dist).toBe(cursor(t)); }
      // (a held tick on a distance newly taken: what a gun row would carry)
      const take = held && s.triggerHeld && st.dist !== prev && t % 3 !== 1;
      if (take) takes++;
      if (reloading && held) { reloadTicks++; if (take) reloadTakes++; }
      prev = st.dist;
    }
    expect(shots).toBeGreaterThan(8);
    expect(reloadTicks).toBeGreaterThan(60);
    // (through the reloads, both guns empty: at most the reload's end, not every held tick)
    expect(reloadTakes).toBeLessThanOrEqual(4);
    expect(takes).toBeLessThan(shots * 2);
  });

  it('idle, at a trigger-down and for a ship not holding (an AI\'s), the guns step on the cursor\'s distance', () => {
    const s = createShipState(catalog, tuning, 1, corsair(), 0);
    expect(stepGuns(s, pose, { firing: false, aimWorld, aimDist: 640, hold: true }, 1, tuning).dist).toBe(640);
    expect(stepGuns(s, pose, { firing: true, aimWorld, aimDist: 700, hold: true }, 2, tuning).dist).toBe(700);
    const ai = createShipState(catalog, tuning, 2, corsair(), 0);
    for (let t = 1; t < 60; t++) expect(stepGuns(ai, pose, { firing: true, aimWorld, aimDist: cursor(t) }, t, tuning).dist).toBe(cursor(t));
    expect(ai.heldDist).toBeUndefined();
  });

  it('the same gun state and cursor give the same held distances and shots (a pure rule: every end agrees)', () => {
    const run = () => {
      const s = createShipState(catalog, tuning, 1, corsair(), 0);
      const out: number[] = [];
      for (let t = 1; t < 200; t++) {
        const st = stepGuns(s, pose, { firing: t % 70 < 50, aimWorld: aimWorld + 0.2 * Math.sin(t / 9), aimDist: cursor(t), hold: true }, t, tuning);
        out.push(st.dist, ...st.shots.map((x) => x.aimQ), ...s.aim);
      }
      return out;
    };
    expect(run()).toEqual(run());
  });
});

describe('helm controls', () => {
  const d = createShipState(catalog, tuning, 1, parseBlueprint(readFileSync(join(SHIP_DATA_DIR, 'blueprints/sparrow-t.json'), 'utf-8')), 0).derived;
  const idle = { forward: false, backward: false, left: false, right: false, boost: false, targetAngle: 0, helm: true };
  const fly = (input: object, ticks: number, angle = 0) => {
    const body: FlightBody = { x: 0, y: 0, vx: 0, vy: 0, angle, angVel: 0 };
    for (let i = 0; i < ticks; i++) stepFlight(body, { ...idle, ...input }, d, tuning, { fuel: 0, drainRate: 0 }, K);
    return body;
  };

  it('right turns clockwise, left counter-clockwise, and it ignores the cursor', () => {
    expect(fly({ right: true, targetAngle: -2 }, 30).angle).toBeGreaterThan(0.3);
    expect(fly({ left: true, targetAngle: 2 }, 30).angle).toBeLessThan(-0.3);
    expect(Math.abs(fly({ targetAngle: 2 }, 30).angle)).toBeLessThan(1e-9);
  });

  it('forward thrusts along the nose, whatever the heading', () => {
    const b = fly({ forward: true }, 60, 0); // nose pointing +x
    expect(b.x).toBeGreaterThan(50);
    expect(Math.abs(b.y)).toBeLessThan(1e-6);
  });

  it('strafe left pushes towards the port side', () => {
    const b = fly({ strafeLeft: true }, 60, 0); // nose +x, so port is -y
    expect(b.y).toBeLessThan(-10);
    expect(Math.abs(b.x)).toBeLessThan(1e-6);
  });

  it('input encoding carries strafe and helm bits', () => {
    const msg = { type: 'input' as const, seq: 3, tick: 9, forward: true, backward: false, left: false, right: true, boost: false,
      fireLeft: true, fireRight: false, targetAngle: 1.25, strafeLeft: true, strafeRight: false, helm: true };
    const back = decodeInputBinary(encodeInputBinary(msg));
    expect(back.strafeLeft).toBe(true);
    expect(back.strafeRight).toBe(false);
    expect(back.helm).toBe(true);
    expect(back.right).toBe(true);
  });
});
