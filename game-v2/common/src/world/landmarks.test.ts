/**
 * Landmark tracking (world/landmarks.ts, docs/design/landmark-tracking-2026-11.md): the weight curve, the records the
 * game's data makes, an idle pilot held by a landmark for a long run, the fade band, the step on both ends, and a
 * save's landmark offset.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { LodestoneData, PlanetData, StationData } from '../data/schemas.js';
import { createShipState } from '../ships/state.js';
import { readShipJson, testCatalog } from '../ships/testData.js';
import type { ShipTuning } from '../ships/tuning.js';
import type { FlightBody } from '../ships/flight.js';
import { jumpTuning, jumpBurnAt } from '../ships/flight.js';
import { FULL_CHARGE } from '../ships/energy.js';
import { replicaStep, ReplicaMode, controlBits } from '../ships/replica.js';
import { lodestonePosition, type FieldEnv } from '../ships/jumpFields.js';
import { corsair } from '../ships/golden/testData.js';
import { stepShip, newSimShip, simAim, simAimQ, type SimEnv, type SimInput, type SimShipState } from '../sim/index.js';
import { calcAsteroidPosition, scaledOrbitTick, stationOrbitTimeScale, MAX_STATION_ORBIT_SPEED } from '../asteroid/orbit.js';
import { stationInteractRadius } from '../constants.js';
import { planetPosition, moonOffset } from './planets.js';
import {
  carryWeight, systemLandmarks, landmarkAt, landmarkPosition, landmarkZoneAt, landmarkCarry, landmarkOffsetAt, landmarkOffsetPoint,
  type Landmark,
} from './landmarks.js';

const data = (f: string) => JSON.parse(readFileSync(join(__dirname, '../../../data', f), 'utf8'));
const systems = data('systems.json').systems as { id: string; planets?: PlanetData[]; lodestones?: LodestoneData[] }[];
const stations = data('stations.json').stations as StationData[];
const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');
const jt = jumpTuning(tuning);
const sol = systems.find((s) => s.id === 'sol')!;
const SOL = systemLandmarks(sol, stations.filter((s) => s.system === 'sol'), jt);
const central = SOL.find((l) => l.id === 'station:sol_station_central')!;

const envAt = (t: number, landmarks: readonly Landmark[]): SimEnv => ({ tick: t, tuning, gravity: null, fields: { central: null, landmarks }, terrain: null });
const IDLE: SimInput = { bits: 0, q: simAimQ(-Math.PI / 2), jumpDist: 0, fire: false, fireAlt: false, aimDist: 0 };

function pilot(x: number, y: number, accounted = true): SimShipState {
  const ship = createShipState(catalog, tuning, 1, corsair(), 0);
  const body: FlightBody = { x, y, vx: 0, vy: 0, angle: -Math.PI / 2, angVel: 0, jump: 0, cargo: 0 };
  return newSimShip({ id: 1, derived: ship.derived, ship, body, charge: FULL_CHARGE, accounted });
}

describe('the weight curve', () => {
  it('is 1 inside the inner radius, 0 at and past the outer, and in between otherwise', () => {
    expect(carryWeight(0, 1000, 2000)).toBe(1);
    expect(carryWeight(1000, 1000, 2000)).toBe(1);
    expect(carryWeight(2000, 1000, 2000)).toBe(0);
    expect(carryWeight(5000, 1000, 2000)).toBe(0);
    expect(carryWeight(1500, 1000, 2000)).toBeCloseTo(0.5, 12);
    for (let d = 1001; d < 2000; d += 7) { const w = carryWeight(d, 1000, 2000); expect(w).toBeGreaterThan(0); expect(w).toBeLessThan(1); }
  });

  it('never rises with distance, and is smooth: no step at either edge, the slope 0 there', () => {
    let last = 1, steepest = 0;
    for (let d = 900; d <= 2100; d += 0.25) {
      const w = carryWeight(d, 1000, 2000);
      expect(w).toBeLessThanOrEqual(last);
      steepest = Math.max(steepest, last - w);
      last = w;
    }
    // (A smoothstep's steepest slope is 1.5 / the band's width: 0.25 units of it here)
    expect(steepest).toBeLessThan(1.5 / 1000 * 0.25 * 1.01);
    expect(1 - carryWeight(1000.5, 1000, 2000)).toBeLessThan(1e-6);
    expect(carryWeight(1999.5, 1000, 2000)).toBeLessThan(1e-6);
  });
});

describe('the game\'s landmarks', () => {
  it('Sol: the orbiting station, every planet, every moon and the orbiting stillstones; nothing that keeps still', () => {
    const ids = SOL.map((l) => l.id);
    expect(ids).toContain('station:sol_station_central');
    expect(ids.filter((i) => i.startsWith('station:'))).toEqual(['station:sol_station_central']);
    for (const p of sol.planets!) {
      expect(ids).toContain(`planet:${p.id}`);
      (p.moons ?? []).forEach((_, i) => expect(ids).toContain(`moon:${p.id}:${i}`));
    }
    const moving = sol.lodestones!.filter((l) => l.orbit?.period);
    expect(moving.length).toBeGreaterThan(0);
    expect(ids.filter((i) => i.startsWith('stone:')).sort()).toEqual(moving.map((l) => `stone:${l.id}`).sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('zones: a station\'s inner radius is its docking ring, a planet\'s 1.5 radii (at least 900 clear), the fade band as wide again; smallest first', () => {
    const st = stations.find((s) => s.id === 'sol_station_central')!;
    expect(central.inner).toBe(stationInteractRadius(st.radius, st.design));
    expect(central.outer).toBe(central.inner * 2);
    const jovan = sol.planets!.find((p) => p.id === 'jovan')!, vesta = sol.planets!.find((p) => p.id === 'vesta')!;
    expect(SOL.find((l) => l.id === 'planet:jovan')!.inner).toBe(jovan.radius * 1.5);
    expect(SOL.find((l) => l.id === 'planet:vesta')!.inner).toBe(vesta.radius + 900);
    const stone = sol.lodestones!.find((l) => l.orbit?.period)!;
    expect(SOL.find((l) => l.id === `stone:${stone.id}`)!.inner).toBe((stone.size ?? jt.lodestoneSize) + jt.lodestoneField);
    for (let i = 1; i < SOL.length; i++) expect(SOL[i].inner).toBeGreaterThanOrEqual(SOL[i - 1].inner);
    for (const l of SOL) expect(l.outer).toBeGreaterThan(l.inner);
  });

  it('data\'s own radii replace the defaults', () => {
    const st = { ...stations.find((s) => s.id === 'sol_station_central')!, tracking: { inner: 5000 } };
    expect(systemLandmarks(null, [st], jt)[0]).toMatchObject({ inner: 5000, outer: 10000 });
    expect(systemLandmarks(null, [{ ...st, tracking: { inner: 5000, outer: 6000 } }], jt)[0]).toMatchObject({ inner: 5000, outer: 6000 });
    const p: PlanetData = { ...sol.planets![0], tracking: { outer: 9000 } };
    expect(systemLandmarks({ planets: [p] }, [], jt)[0]).toMatchObject({ inner: p.radius + 900, outer: 9000 });
  });

  it('each is where its body is placed: planets and moons, stillstones, and the station as the server\'s entity orbits', () => {
    for (const tick of [0, 1, 777, 123456, 5_000_000]) {
      for (const p of sol.planets!) {
        const at = planetPosition(p, tick);
        expect({ ...landmarkAt(SOL.find((l) => l.id === `planet:${p.id}`)!, tick) }).toEqual(at);
        (p.moons ?? []).forEach((_, i) => {
          const o = moonOffset(p, i, tick);
          expect({ ...landmarkAt(SOL.find((l) => l.id === `moon:${p.id}:${i}`)!, tick) }).toEqual({ x: at.x + o.x, y: at.y + o.y });
        });
      }
      for (const l of sol.lodestones!.filter((x) => x.orbit?.period)) expect({ ...landmarkAt(SOL.find((m) => m.id === `stone:${l.id}`)!, tick) }).toEqual(lodestonePosition(l, tick));
      // (The server's station entity: its orbit in single precision, its clock slowed so ships can catch it)
      const o = stations.find((s) => s.id === 'sol_station_central')!.orbit!;
      const scale = Math.fround(stationOrbitTimeScale(o.semiMajorAxis));
      const want = calcAsteroidPosition({ orbitType: o.orbitType, semiMajorAxis: Math.fround(o.semiMajorAxis), eccentricity: Math.fround(o.eccentricity), argPeriapsis: Math.fround(o.argPeriapsis), meanAnomaly0: Math.fround(o.meanAnomaly0), epochTick: o.epochTick ?? 0 },
        scaledOrbitTick(tick, o.epochTick ?? 0, scale));
      expect({ ...landmarkAt(central, tick) }).toEqual(want);
    }
  });

  it('a system where nothing moves has none (the training yard), and every system\'s records are plain data', () => {
    const yard = systems.find((s) => s.id === 'vesta_yard')!;
    expect(systemLandmarks(yard, stations.filter((s) => s.system === 'vesta_yard'), jt)).toEqual([]);
    for (const s of systems) {
      const set = systemLandmarks(s, stations.filter((st) => st.system === s.id), jt);
      expect(JSON.parse(JSON.stringify(set))).toEqual(set);
    }
  });

  it('overlapping zones: the strongest weight wins, a tie going to the smaller zone', () => {
    const big: Landmark = { id: 'planet:big', name: 'Big', inner: 6000, outer: 12000, c: [50000, 0, 300] };
    const small: Landmark = { id: 'moon:big:0', name: 'Small', inner: 1000, outer: 2000, c: [50000, 0, 300, 5500, 0, 10] };
    const set = [small, big];
    const b = landmarkPosition(set, 1, 100), m = landmarkPosition(set, 0, 100);
    // (Inside both inner zones: the moon's)
    expect(landmarkZoneAt(set, 100, m.x + 10, m.y)).toMatchObject({ i: 0, w: 1 });
    // (In the planet's inner zone and the moon's fade band: the planet's)
    expect(landmarkZoneAt(set, 100, m.x - 1500, m.y)).toMatchObject({ i: 1, w: 1 });
    // (Past the planet's inner zone, by the moon: whichever weighs more)
    const z = landmarkZoneAt(set, 100, m.x + 900, m.y)!;
    expect(z.i).toBe(0);
    expect(landmarkZoneAt(set, 100, b.x + 30000, b.y)).toBeNull();
  });
});

describe('a pilot carried by the step', () => {
  it('idle in the inner zone: its offset from the landmark is exactly the same after 12 minutes of ticks', () => {
    const t0 = 1000, at = landmarkPosition(SOL, SOL.indexOf(central), t0);
    const s = pilot(at.x + 1234.56, at.y - 800.25);
    const N = 12 * 60 * 60;
    let moved = 0;
    for (let t = t0 + 1; t <= t0 + N; t++) {
      const bx = s.body.x, by = s.body.y;
      stepShip(s, IDLE, envAt(t, SOL), s);
      moved = Math.max(moved, Math.hypot(s.body.x - bx, s.body.y - by));
      if (t % 3600 === 0) {
        const now = landmarkPosition(SOL, SOL.indexOf(central), t);
        expect(Math.round((s.body.x - now.x) * 100)).toBe(123456);
        expect(Math.round((s.body.y - now.y) * 100)).toBe(-80025);
      }
    }
    const end = landmarkPosition(SOL, SOL.indexOf(central), t0 + N);
    expect(Math.round((s.body.x - end.x) * 100)).toBe(123456);
    expect(Math.round((s.body.y - end.y) * 100)).toBe(-80025);
    // (It went a long way with the station, a tick's worth at a time, and its velocity says none of it)
    expect(Math.hypot(end.x - at.x, end.y - at.y)).toBeGreaterThan(10000);
    expect(moved).toBeLessThan(MAX_STATION_ORBIT_SPEED + 0.02);
    expect(s.body.vx).toBe(0);
    expect(s.body.vy).toBe(0);
  });

  it('without the landmarks the same ship is left behind (what the carry is for)', () => {
    const t0 = 1000, at = landmarkPosition(SOL, SOL.indexOf(central), t0);
    const s = pilot(at.x + 100, at.y);
    for (let t = t0 + 1; t <= t0 + 3600; t++) stepShip(s, IDLE, envAt(t, []), s);
    expect(s.body.x).toBe(Math.round((at.x + 100) * 100) / 100);
    const now = landmarkPosition(SOL, SOL.indexOf(central), t0 + 3600);
    expect(Math.hypot(s.body.x - now.x, s.body.y - now.y)).toBeGreaterThan(central.inner);
  });

  it('idle by a moon: held to it, round its planet, for 12 minutes', () => {
    const i = SOL.findIndex((l) => l.id === 'moon:terra_nova:0'), t0 = 50, at = landmarkPosition(SOL, i, t0);
    const s = pilot(at.x + 300, at.y + 200);
    for (let t = t0 + 1; t <= t0 + 43200; t++) stepShip(s, IDLE, envAt(t, SOL), s);
    const end = landmarkPosition(SOL, i, t0 + 43200);
    expect(Math.round((s.body.x - end.x) * 100)).toBe(30000);
    expect(Math.round((s.body.y - end.y) * 100)).toBe(20000);
  });

  it('the fade band: carried by part of each move, never more than the landmark\'s own, slipping behind until it is let go; no jolt on the way', () => {
    const li = SOL.indexOf(central), t0 = 2000, at = landmarkPosition(SOL, li, t0);
    // (Half way across the band, off to the side of its path)
    const d0 = (central.inner + central.outer) / 2, len = Math.hypot(at.x, at.y);
    const s = pilot(Math.round((at.x + (at.x / len) * d0) * 100) / 100, Math.round((at.y + (at.y / len) * d0) * 100) / 100);
    let prevStep = -1, left = -1, biggestChange = 0;
    for (let t = t0 + 1; t <= t0 + 40000 && left < 0; t++) {
      const a = landmarkPosition(SOL, li, t - 1), b = landmarkPosition(SOL, li, t);
      const w = carryWeight(Math.hypot(s.body.x - a.x, s.body.y - a.y), central.inner, central.outer);
      const bx = s.body.x, by = s.body.y;
      stepShip(s, IDLE, envAt(t, SOL), s);
      const step = Math.hypot(s.body.x - bx, s.body.y - by), full = Math.hypot(b.x - a.x, b.y - a.y);
      // (The landmark's move times the weight where it stood, to the position grid)
      expect(Math.abs(step - w * full)).toBeLessThan(0.011);
      expect(step).toBeLessThanOrEqual(full + 0.011);
      if (t === t0 + 1) { expect(w).toBeCloseTo(0.5, 2); expect(step).toBeGreaterThan(0.3 * full); expect(step).toBeLessThan(0.7 * full); }
      if (prevStep >= 0) biggestChange = Math.max(biggestChange, Math.abs(step - prevStep));
      prevStep = step;
      if (w === 0) left = t;
    }
    // (It fell out of the zone in the end, and its carry faded to nothing rather than stopping: a tick's change is grid noise)
    expect(left).toBeGreaterThan(t0);
    expect(biggestChange).toBeLessThan(0.03);
    const out = { x: s.body.x, y: s.body.y };
    for (let t = left + 1; t <= left + 600; t++) stepShip(s, IDLE, envAt(t, SOL), s);
    expect({ x: s.body.x, y: s.body.y }).toEqual(out);
  });

  it('flying in from open space and out the far side: the carry comes on and goes off without a jump', () => {
    const li = SOL.indexOf(central), t0 = 3000, at = landmarkPosition(SOL, li, t0);
    // (Mouse-steer: forward is up the screen, -y)
    const s = pilot(at.x + 500, at.y + central.outer + 600);
    const fly: SimInput = { ...IDLE, bits: controlBits({ forward: true, backward: false, left: false, right: false, boost: false, targetAngle: 0 }), q: simAimQ(0) };
    let seenFull = false, seenNone = false, lastExtra = 0, worst = 0, t = t0;
    for (; t < t0 + 20000; t++) {
      const bx = s.body.x, by = s.body.y;
      stepShip(s, fly, envAt(t + 1, SOL), s);
      // (What moved it besides its own velocity: the carry)
      const ex = s.body.x - bx - s.body.vx, ey = s.body.y - by - s.body.vy, extra = Math.hypot(ex, ey);
      worst = Math.max(worst, Math.abs(extra - lastExtra));
      lastExtra = extra;
      const z = landmarkZoneAt(SOL, t + 1, s.body.x, s.body.y);
      if (z?.i === li && z.w === 1) seenFull = true;
      if (seenFull && !z) { seenNone = true; break; }
    }
    expect(seenFull && seenNone).toBe(true);
    // (Tick to tick the carry changes by a sliver of the station's 1.2 a tick, even at speed)
    expect(worst).toBeLessThan(0.15);
  });

  it('server and replica agree to the bit, thrusting in through the fade band, across the inner zone and out', () => {
    const li = SOL.indexOf(central), t0 = 4000, at = landmarkPosition(SOL, li, t0);
    const s = pilot(at.x - central.outer - 300, at.y + 250);
    const rep: FlightBody = { ...s.body };
    const fields: FieldEnv = { central: null, landmarks: SOL };
    let inZone = 0, changed = 0;
    const plain = pilot(s.body.x, s.body.y);
    for (let i = 0; i < 6000; i++) {
      const t = t0 + 1 + i;
      // (Thrust, turn, coast and brake by turns: every part of the band at several speeds)
      const ph = Math.floor(i / 240) % 4, aim = ph === 3 ? Math.PI : (i % 900) / 900 - 0.5;
      const inp: SimInput = { ...IDLE, bits: controlBits({ forward: ph !== 2, backward: false, left: false, right: ph === 1, boost: ph === 0 && i % 500 < 60, targetAngle: aim }), q: simAimQ(aim) };
      stepShip(s, inp, envAt(t, SOL), s);
      stepShip(plain, inp, envAt(t, []), plain);
      // (A replica: no stores, the authority's power bits, the aim it flew)
      replicaStep(ReplicaMode.Player, rep, { bits: s.ctl.bits, targetAngle: simAim(s.ctl.q) }, s.structure.derived, tuning, { gravity: null, ...fields }, t, 1);
      expect([rep.x, rep.y, rep.vx, rep.vy, rep.angle, rep.angVel]).toEqual([s.body.x, s.body.y, s.body.vx, s.body.vy, s.body.angle, s.body.angVel]);
      if (landmarkZoneAt(SOL, t, s.body.x, s.body.y)) inZone++;
      if (s.body.x !== plain.body.x || s.body.y !== plain.body.y) changed++;
    }
    expect(inZone).toBeGreaterThan(300);
    expect(changed).toBeGreaterThan(300);
    // (Its velocity is its own: the carry never touched it)
    expect([s.body.vx, s.body.vy]).toEqual([plain.body.vx, plain.body.vy]);
  });

  it('not carried mid-burn, nor anything but a pilot', () => {
    const li = SOL.indexOf(central), t0 = 500, at = landmarkPosition(SOL, li, t0);
    const s = pilot(at.x + 50, at.y + 50), free = pilot(at.x + 50, at.y + 50);
    s.body.jump = free.body.jump = jumpBurnAt(jt);
    stepShip(s, IDLE, envAt(t0 + 1, SOL), s);
    stepShip(free, IDLE, envAt(t0 + 1, []), free);
    expect([s.body.x, s.body.y]).toEqual([free.body.x, free.body.y]);
    const ai = pilot(at.x + 50, at.y + 50, false);
    ai.mode = ReplicaMode.Pilotless;
    stepShip(ai, IDLE, envAt(t0 + 1, SOL), ai);
    expect([ai.body.x, ai.body.y]).toEqual([at.x + 50, at.y + 50]);
  });

  it('the carry is the landmark\'s move on the ships\' grid, from where the ship stood the tick before', () => {
    const li = SOL.indexOf(central), a = landmarkPosition(SOL, li, 900), b = landmarkPosition(SOL, li, 901);
    const out = { dx: 0, dy: 0, i: -1, w: 0 };
    expect(landmarkCarry(SOL, 901, a.x + 10, a.y, out)).toBe(true);
    expect(out).toEqual({ dx: b.x - a.x, dy: b.y - a.y, i: li, w: 1 });
    expect(landmarkCarry(SOL, 901, a.x + central.outer + 1, a.y, out)).toBe(false);
    expect(Math.round(a.x * 100) / 100).toBe(a.x);
  });
});

describe('a save\'s landmark offset', () => {
  it('in a zone: the landmark and the offset; later, the same offset from wherever the landmark has got to', () => {
    const li = SOL.indexOf(central), at = landmarkPosition(SOL, li, 5000);
    const saved = landmarkOffsetAt(SOL, 5000, at.x + 2500, at.y - 1200)!;
    expect(saved.id).toBe('station:sol_station_central');
    expect(Math.abs(saved.dx - 2500)).toBeLessThanOrEqual(1);
    expect(Math.abs(saved.dy + 1200)).toBeLessThanOrEqual(1);
    // (The fade band counts too)
    expect(landmarkOffsetAt(SOL, 5000, at.x + central.inner + 500, at.y)?.id).toBe(central.id);
    for (const later of [5000, 5600, 400000, 17 /* a restarted server's tick */]) {
      const now = landmarkPosition(SOL, li, later), p = landmarkOffsetPoint(SOL, later, saved)!;
      expect(Math.abs(p.x - (now.x + saved.dx))).toBeLessThanOrEqual(0.5);
      expect(Math.abs(p.y - (now.y + saved.dy))).toBeLessThanOrEqual(0.5);
      expect(landmarkZoneAt(SOL, later, p.x, p.y)).toMatchObject({ i: li, w: 1 });
    }
  });

  it('open space: none; a landmark that is gone: none (the saved spot stands)', () => {
    expect(landmarkOffsetAt(SOL, 5000, 250000, 250000)).toBeNull();
    expect(landmarkOffsetAt([], 5000, 0, 0)).toBeNull();
    expect(landmarkOffsetPoint(SOL, 5000, { id: 'station:long_gone', dx: 5, dy: 5 })).toBeNull();
  });
});

describe('debris and loot pods in a zone', () => {
  it('a piece of debris at rest in the inner zone keeps its offset from the station for 12 minutes; without the landmarks it is left behind', async () => {
    const { stepDebrisWorld } = await import('../ships/debris.js');
    const { SHIP_FLIGHT_CONSTANTS } = await import('../ships/physics.js');
    const li = SOL.indexOf(central), t0 = 700, at = landmarkPosition(SOL, li, t0);
    const piece = (x: number, y: number) => ({ id: 5, body: { x, y, vx: 0, vy: 0, angle: 0.3, angVel: 0 } as FlightBody, mass: 10, radius: 20, com: [0, 0] as [number, number], pieces: [] });
    const held = piece(at.x - 700.5, at.y + 1200.25), free = piece(at.x - 700.5, at.y + 1200.25);
    for (let t = t0 + 1; t <= t0 + 43200; t++) {
      stepDebrisWorld([held], SHIP_FLIGHT_CONSTANTS, 20, 0.3, t, SOL);
      stepDebrisWorld([free], SHIP_FLIGHT_CONSTANTS, 20, 0.3, t);
    }
    const end = landmarkPosition(SOL, li, t0 + 43200);
    expect(Math.round((held.body.x - end.x) * 100)).toBe(-70050);
    expect(Math.round((held.body.y - end.y) * 100)).toBe(120025);
    expect([free.body.x, free.body.y]).toEqual([at.x - 700.5, at.y + 1200.25]);
  });

  it('a pod is held by the zone its anchor was laid in, at the weight there: exactly by the station in the inner zone, never by a landmark passing later', async () => {
    const { podHold, podCarry } = await import('./landmarks.js');
    const li = SOL.indexOf(central), at = { ...landmarkAt(central, 900) }, a = { x: at.x + 500, y: at.y - 200 };
    const hold = podHold(SOL, a.x, a.y, 900)!;
    expect(hold).toMatchObject({ i: li, w: 1 });
    for (const t of [900, 901, 5000.5, 90000]) {
      const now = { ...landmarkAt(central, t) }, c = podCarry(SOL, hold, t, { x: 0, y: 0 });
      expect(a.x + c.x - now.x).toBeCloseTo(500, 6);
      expect(a.y + c.y - now.y).toBeCloseTo(-200, 6);
    }
    expect(podHold(SOL, 250000, 250000, 900)).toBeNull();
    expect(podHold(undefined, a.x, a.y, 900)).toBeNull();
    const band = podHold(SOL, at.x + central.inner * 1.5, at.y, 900)!;
    expect(band.w).toBeCloseTo(0.5, 3);
    const moved = { ...landmarkAt(central, 1500) }, c = podCarry(SOL, band, 1500, { x: 0, y: 0 });
    expect(c.x).toBeCloseTo(band.w * (moved.x - at.x), 9);
  });

  it('the rule is in the wire hash: changing it is a protocol bump', async () => {
    const { LANDMARK_CARRY_RULE } = await import('./landmarks.js');
    const src = readFileSync(join(__dirname, '../network/wireHash.ts'), 'utf8');
    expect(LANDMARK_CARRY_RULE.length).toBeGreaterThan(5);
    expect(src).toContain('landmarkCarry: LANDMARK_CARRY_RULE');
  });
});
