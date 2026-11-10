import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import {
  Position, Velocity, Rotation, Input, InSystem, ServerMessage, ReplicaMode, replicaAngle, quantizeReplicaAngle,
  jumpTuning, jumpBurnAt, jumpRange, jumpScaleFor, jumpPhase, FRICTION, jumpFieldAt, lodestonePosition, pilotJumpStep, stepShipPhysics, solarRingRadius,
  lodestoneFieldRadius, lodestoneSize, lodestoneLive, primeBoost, PILOT_ROW, type LodestoneData, type Charge,
} from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from './LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../ships/createShipBridge.js';
import { makeServer } from '../testkits/world.testkit.js';

const dataDir = join(__dirname, '../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);

function world() {
  resetGlobals();
  const server = makeServer();
  const t = new LocalTransport(server);
  const got: ServerMessage[] = [];
  t.onMessage = (m) => got.push(m);
  t.connect();
  t.send({ type: 'join', username: 'Ash' } as any);
  const pid = t.getPlayerId();
  const ships = server.getShips();
  const jt = jumpTuning(ships.tuning);
  const sys = server['gameData'].getSystemByNum(InSystem.systemId[pid])!;
  const tick = () => (server as any).currentTick as number;
  /** Hold the ship still at a point (the tick about to run puts it there) */
  const park = (x: number, y: number) => { Position.x[pid] = x; Position.y[pid] = y; Velocity.x[pid] = 0; Velocity.y[pid] = 0; };
  const idle = () => { Input.forward[pid] = 0; Input.boost[pid] = 0; Input.jump[pid] = 0; Input.cursorDist[pid] = 0; };
  return { server, got, pid, ships, jt, sys, tick, park, idle, ship: () => ships.get(pid)! };
}

/** Sol's big inner stillstone (fixed, clear of the asteroid belt) */
const innerLode = (sys: { lodestones?: LodestoneData[] }) => sys.lodestones!.find((l) => l.id === 'sol_lodestone_5')!;
/** Open space in Sol: no field of any kind, now or for a while */
const OPEN = { x: 0, y: -100000 };

describe('stillstones', () => {
  it('Sol has four whole ones and a scarred one: two inner, two middle, the Wardens\' out in the Reaches (camped and still), and they drift slowly', () => {
    const { sys, jt } = world();
    const band = (r: number) => (r <= 76000 ? 'inner' : r <= 140000 ? 'middle' : 'reaches');
    const count: Record<string, number> = {};
    for (const l of sys.lodestones!) {
      const p = lodestonePosition(l, 0);
      count[band(Math.hypot(p.x, p.y))] = (count[band(Math.hypot(p.x, p.y))] ?? 0) + 1;
      // A minute's drift is well inside the field
      const q = lodestonePosition(l, 3600);
      expect(Math.hypot(q.x - p.x, q.y - p.y)).toBeLessThan(jt.lodestoneField / 4);
      // Clear of the star's charging ring
      expect(Math.hypot(p.x, p.y) - lodestoneFieldRadius(l, jt)).toBeGreaterThan(solarRingRadius(sys.starRadius, jt));
    }
    expect(count).toEqual({ inner: 2, middle: 2, reaches: 1 });
    expect(sys.lodestones!.map((l) => l.state ?? 'active').sort()).toEqual(['active', 'active', 'active', 'active', 'scarred']);
    const camped = sys.lodestones!.find((l) => l.zone)!;
    expect(camped.position && !camped.orbit).toBeTruthy();
    expect(files.factions.spawns.sol.zones!.some((z) => z.id === camped.zone)).toBe(true);
  });

  it('charges the drive twice as fast inside the field, and primes the next jump for 60 s after leaving (+20% range)', () => {
    const { server, pid, jt, sys, tick, park, idle, ship } = world();
    const lode = innerLode(sys);
    const cool = ship().derived.jumpCooldown || jt.cooldownTicks;
    const cooled = (at: () => { x: number; y: number }) => {
      ship().jump = jumpBurnAt(jt) + jt.burnTicks;
      let n = 0;
      while (ship().jump !== 0 && n < cool * 2) { idle(); const p = at(); park(p.x, p.y); server.step(); n++; }
      return n;
    };
    expect(cooled(() => OPEN)).toBe(cool);
    expect(cooled(() => lodestonePosition(lode, tick() + 1))).toBe(Math.ceil(cool / (1 + jt.lodestoneCharge)));
    // Primed while inside, then a minute's grace once out
    expect(ship().jumpPrime).toBe(jt.lodestonePrimeTicks);
    for (let i = 0; i < 600; i++) { idle(); park(OPEN.x, OPEN.y); server.step(); }
    expect(ship().jumpPrime).toBe(jt.lodestonePrimeTicks - 600);
    // Jump: the full reach, a quarter more
    const jumpScale = () => {
      for (let i = 0; i < jt.chargeTicks + 2 && jumpPhase(ship().jump, jt).phase !== 'burn'; i++) { idle(); Input.jump[pid] = 1; server.step(); }
      idle();
      return ship().jumpScale!;
    };
    const scale = (boost: number) => jumpScaleFor(jumpRange(ship().derived, jt, boost), jt, FRICTION);
    park(OPEN.x, OPEN.y);
    Rotation.angle[pid] = Math.PI / 2; Input.targetAngle[pid] = Math.PI / 2;
    expect(jumpScale()).toBe(scale(jt.lodestoneRangeBoost));
    // ...and it's spent
    expect(ship().jumpPrime).toBe(0);
    // Unprimed, the next one is plain
    ship().jump = 0;
    park(OPEN.x, OPEN.y);
    expect(jumpScale()).toBe(scale(1));
    // Priming runs out after 60 s
    ship().jump = 0;
    ship().jumpPrime = 2;
    for (let i = 0; i < 3; i++) { idle(); park(OPEN.x, OPEN.y); server.step(); }
    expect(ship().jumpPrime).toBe(0);
  });

  it("doesn't stack above the star ring's own boost (range or charge)", () => {
    const { server, jt, sys, tick, park, idle, ship, pid } = world();
    const ring = solarRingRadius(sys.starRadius, jt);
    // In the ring and primed: the ring's boost, no more
    ship().jump = 0;
    ship().jumpPrime = 1000;
    park(0, -(ring - 2000));
    Rotation.angle[pid] = -Math.PI / 2; Input.targetAngle[pid] = -Math.PI / 2;
    for (let i = 0; i < jt.chargeTicks + 2 && jumpPhase(ship().jump, jt).phase !== 'burn'; i++) { idle(); Input.jump[pid] = 1; Velocity.x[pid] = 0; Velocity.y[pid] = 0; server.step(); }
    expect(ship().jumpScale).toBe(jumpScaleFor(jumpRange(ship().derived, jt, jt.solarRangeBoost), jt, FRICTION));
    // A lodestone's field inside the ring (made up for the test) charges no faster than the ring alone
    const cool = ship().derived.jumpCooldown || jt.cooldownTicks;
    const inRing: LodestoneData = { id: 'test_ring_lode', position: { x: ring - 3000, y: 0 } };
    sys.lodestones = [...sys.lodestones!, inRing];
    (server as any).replicaEnvs.clear();
    ship().jump = jumpBurnAt(jt) + jt.burnTicks;
    let n = 0;
    while (ship().jump !== 0 && n < cool) { idle(); park(ring - 3000, 0); server.step(); n++; }
    expect(jumpFieldAt(ring - 3000, 0, { central: sys.centralBody, lodestones: sys.lodestones }, tick(), jt)).toEqual({ ring: true, lodestone: inRing });
    expect(n).toBe(Math.ceil(cool / (1 + jt.solarCharge)));
  });

  it("the pilot's prediction (the same step the client runs) agrees with the server tick for tick, and the snapshot says so", () => {
    const { server, got, pid, ships, jt, sys, tick, ship } = world();
    const lode = innerLode(sys);
    // Start just outside the field, heading in; fly through it, cool down, fly out and jump
    const at = lodestonePosition(lode, tick() + 1), F = lodestoneFieldRadius(lode, jt);
    const dir = Math.atan2(at.y, at.x) + Math.PI / 2;
    Position.x[pid] = at.x - Math.cos(dir) * (F + 500); Position.y[pid] = at.y - Math.sin(dir) * (F + 500);
    Velocity.x[pid] = 0; Velocity.y[pid] = 0;
    Rotation.angle[pid] = dir;
    ship().jump = jumpBurnAt(jt) + jt.burnTicks; // cooling down
    ship().angVel = 0;
    const s = ship();
    // The client's copy: from the server's state, stepped as ShipClient.predict does
    const me = { x: Position.x[pid], y: Position.y[pid], vx: 0, vy: 0, angle: dir, angVel: 0, jump: s.jump, jumpScale: s.jumpScale };
    let prime = 0;
    let charge: Charge = { ...ships.chargeOf(pid) };
    const env = { central: sys.centralBody, lodestones: sys.lodestones };
    const cool = s.derived.jumpCooldown || jt.cooldownTicks;
    const mismatches: string[] = [];
    let inField = 0, primedJump = false;
    // In along the nose, stop in the field until the drive's cool, out again, then jump
    let stage: 'in' | 'sit' | 'out' | 'jump' = 'in';
    for (let i = 0; i < 60 * 60; i++) {
      const p = lodestonePosition(lode, tick() + 1), d = Math.hypot(me.x - p.x, me.y - p.y);
      if (stage === 'in' && d < 300) stage = 'sit';
      else if (stage === 'sit' && me.jump === 0) stage = 'out';
      else if (stage === 'out' && d > F + 1500) stage = 'jump';
      const controls = {
        forward: stage === 'in' || stage === 'out', backward: false, left: false, right: false, boost: false, helm: true, strafeLeft: false, strafeRight: false,
        targetAngle: replicaAngle(ReplicaMode.Player, quantizeReplicaAngle(dir)), jump: stage === 'jump', jumpDist: 0,
      };
      Input.forward[pid] = controls.forward ? 1 : 0; Input.boost[pid] = 0; Input.jump[pid] = controls.jump ? 1 : 0; Input.helm[pid] = 1;
      Input.targetAngle[pid] = controls.targetAngle; Input.cursorDist[pid] = 0;
      // (Brakes, the same on both sides)
      if (stage === 'sit') { me.vx = 0; me.vy = 0; Velocity.x[pid] = 0; Velocity.y[pid] = 0; }
      server.step();
      prime = pilotJumpStep(me, prime, env, tick(), cool, jt, (rangeBoost) => {
        charge = stepShipPhysics(me, controls, s.derived, ships.tuning, { charge, drainRate: 1 }, null, rangeBoost).charge;
      });
      if (prime === jt.lodestonePrimeTicks) inField++;
      if (jumpPhase(me.jump, jt).phase === 'burn' && (me.jumpScale ?? 1) > jumpScaleFor(jumpRange(s.derived, jt), jt, FRICTION)) primedJump = true;
      const real = { x: Position.x[pid], y: Position.y[pid], vx: Velocity.x[pid], vy: Velocity.y[pid], angle: Rotation.angle[pid], jump: s.jump, jumpScale: s.jumpScale, prime: s.jumpPrime ?? 0 };
      const mine = { x: me.x, y: me.y, vx: me.vx, vy: me.vy, angle: me.angle, jump: me.jump, jumpScale: me.jumpScale, prime };
      if (JSON.stringify(real) !== JSON.stringify(mine)) mismatches.push(`tick ${tick()}: server ${JSON.stringify(real)} vs client ${JSON.stringify(mine)}`);
    }
    expect(mismatches.slice(0, 3)).toEqual([]);
    expect(inField).toBeGreaterThan(100);
    expect(primedJump).toBe(true);
    // The pilot's snapshot rows: data[PILOT_ROW.field] flags (2: a lodestone's field) and data[PILOT_ROW.prime] the priming left
    const rows = got.filter((m) => m.type === 'snapshot').flatMap((m: any) => m.entities.filter((e: any) => e.id === pid && e.data?.length > 12));
    expect(rows.some((e: any) => (e.data[PILOT_ROW.field] & 2) === 2 && e.data[PILOT_ROW.prime] === jt.lodestonePrimeTicks)).toBe(true);
    expect(rows.some((e: any) => (e.data[PILOT_ROW.field] & 2) === 0 && e.data[PILOT_ROW.prime] > 0 && e.data[PILOT_ROW.prime] < jt.lodestonePrimeTicks)).toBe(true);
  });

  it('a watching client replays a pilot charging in a field without needing keyframes', () => {
    const { server, pid, jt, sys, tick, ship } = world();
    const lode = innerLode(sys);
    const t2 = new LocalTransport(server);
    t2.onMessage = () => {};
    t2.connect();
    t2.send({ type: 'join', username: 'Bree' } as any);
    const at = lodestonePosition(lode, tick() + 1);
    Position.x[pid] = at.x; Position.y[pid] = at.y; Velocity.x[pid] = 0; Velocity.y[pid] = 0;
    Position.x[t2.getPlayerId()] = at.x + 3000; Position.y[t2.getPlayerId()] = at.y;
    ship().jump = jumpBurnAt(jt) + jt.burnTicks;
    Input.jump[pid] = 0; // (the input arrays outlive a test's server: nobody's asking for a jump here)
    const reasons = (server as any).replication.reasons as Record<string, number>;
    for (let i = 0; i < 30; i++) server.step();
    const before = reasons['Player:jump'] ?? 0;
    for (let i = 0; i < 300; i++) { Velocity.x[t2.getPlayerId()] = 0; Velocity.y[t2.getPlayerId()] = 0; server.step(); }
    expect(jumpFieldAt(Position.x[pid], Position.y[pid], { central: sys.centralBody, lodestones: sys.lodestones }, tick(), jt).lodestone?.id).toBe(lode.id);
    expect(reasons['Player:jump'] ?? 0).toBe(before);
  });

  it('a scarred one charges and primes for less (the snapshot carries its priming negative)', () => {
    const { server, got, pid, jt, sys, tick, park, idle, ship } = world();
    const scar = sys.lodestones!.find((l) => l.state === 'scarred')!;
    const cool = ship().derived.jumpCooldown || jt.cooldownTicks;
    ship().jump = jumpBurnAt(jt) + jt.burnTicks;
    let n = 0;
    while (ship().jump !== 0 && n < cool * 2) { idle(); const p = lodestonePosition(scar, tick() + 1); park(p.x, p.y); server.step(); n++; }
    expect(Math.abs(n - cool / (1 + jt.lodestoneCharge * jt.lodestoneScarredCharge))).toBeLessThanOrEqual(2);
    expect(ship().jumpPrime).toBe(-jt.lodestonePrimeTicks);
    expect(primeBoost(ship().jumpPrime!, jt)).toBeLessThan(jt.lodestoneRangeBoost);
    expect(primeBoost(ship().jumpPrime!, jt)).toBeGreaterThan(1);
    const rows = got.filter((m) => m.type === 'snapshot').flatMap((m: any) => m.entities.filter((e: any) => e.id === pid && e.data?.length > 12));
    expect(rows.some((e: any) => (e.data[PILOT_ROW.field] & 2) === 2 && e.data[PILOT_ROW.prime] === -jt.lodestonePrimeTicks)).toBe(true);
  });

  it('across the cluster: fewer in dangerous systems, dead and shattered ones there with no field, none overlapping', () => {
    const { jt } = world();
    const systems = files.systems.systems as { id: string; starRadius: number; lodestones?: LodestoneData[] }[];
    const states = (id: string) => (systems.find((s) => s.id === id)!.lodestones ?? []).map((l) => l.state ?? 'active').sort();
    expect(states('cinder_reach')).toEqual(['active', 'dead', 'scarred']);
    expect(states('void_sector')).toEqual(['scarred', 'shattered']);
    expect(states('the_maw')).toEqual(['dead', 'shattered']);
    for (const id of ['ashfall', 'borealis', 'glasswater']) expect(states(id)).toEqual(['active', 'active', 'active']);
    expect(states('nebula_prime')).toEqual(['active', 'active']);
    const knot = systems.find((s) => s.id === 'borealis')!.lodestones!.find((l) => l.id === 'borealis_aurora_knot')!;
    expect(knot.rough && lodestoneSize(knot, jt) < 500).toBe(true);
    for (const s of systems) {
      const list = s.lodestones ?? [];
      for (const l of list) {
        // Dwarfing ships and stations, and clear of the star
        expect(lodestoneSize(l, jt)).toBeGreaterThanOrEqual(300);
        if (!lodestoneLive(l)) expect(lodestoneFieldRadius(l, jt)).toBe(0);
        const r = l.orbit ? l.orbit.radius : Math.hypot(l.position!.x, l.position!.y);
        expect(r - Math.max(lodestoneFieldRadius(l, jt), lodestoneSize(l, jt))).toBeGreaterThan(s.starRadius);
      }
      // No two ever overlap (an orbit's closest pass is the difference in radius; two fixed ones, their distance)
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        const ra = Math.max(lodestoneFieldRadius(a, jt), lodestoneSize(a, jt) * 1.1), rb = Math.max(lodestoneFieldRadius(b, jt), lodestoneSize(b, jt) * 1.1);
        const da = a.orbit ? a.orbit.radius : Math.hypot(a.position!.x, a.position!.y), db = b.orbit ? b.orbit.radius : Math.hypot(b.position!.x, b.position!.y);
        const d = a.position && b.position ? Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y) : Math.abs(da - db);
        expect(d, `${a.id} / ${b.id}`).toBeGreaterThan(ra + rb);
      }
    }
  });
});
