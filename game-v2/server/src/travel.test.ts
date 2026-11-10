import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Position, Velocity, InSystem, Health, Player, Projectile, ServerMessage, jumpBurnAt, jumpTuning } from '@space-game/common';
import { GameServer } from './GameServer.js';
import { GameData } from './data/GameData.js';
import { LocalTransport } from './net/LocalTransport.js';
import { readGameDataFiles } from './data/loadGameDataFromDisk.js';
import { makeServer } from './testkits/world.testkit.js';

const dataDir = join(__dirname, '../../data');
const files = readGameDataFiles(dataDir);
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;

function live(devTeleport = false) {
  resetGlobals();
  const gameData = new GameData(files);
  const server = makeServer({
    gameData, devTeleport,
  });
  const t = new LocalTransport(server);
  const got: ServerMessage[] = [];
  t.onMessage = (m) => got.push(m);
  t.connect();
  t.send({ type: 'join', username: 'traveller' } as any);
  // A veteran: lane clearance, and licensed for the Maw
  server.pilots.get(server.pilots.connOf(t.getPlayerId())!)!.licences.push('outer_lanes', 'the_maw');
  return { server, gameData, t, got, pid: t.getPlayerId() };
}

describe('sectors and travel', () => {
  it('loads all seven systems, and every new gate has a gate back', () => {
    const ids = files.systems.systems.map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining(['sol', 'borealis', 'nebula_prime', 'void_sector', 'cinder_reach', 'the_maw', 'glasswater']));
    const links = new Set(files.systems.systems.flatMap((s) => s.portals.map((p) => `${s.id}>${p.targetSystem}`)));
    for (const [a, b] of [['sol', 'cinder_reach'], ['cinder_reach', 'the_maw'], ['borealis', 'glasswater'], ['sol', 'nebula_prime']]) {
      expect(links.has(`${a}>${b}`), `${a} → ${b}`).toBe(true);
      expect(links.has(`${b}>${a}`), `${b} → ${a}`).toBe(true);
    }
    // (Planet surfaces, pilots' own stations and the training yard have no asteroids)
    for (const s of files.systems.systems.filter((x) => !x.surface && !x.private && !x.tutorial)) {
      expect(s.asteroidField, s.id).toBeDefined();
    }
  });

  it('the Void Sector rift fast-travels a ship to The Maw and keeps its momentum', () => {
    const { server, gameData, got, pid } = live();
    // The Maw's rift is in the Void Sector
    const rift = files.systems.systems.find((s) => s.id === 'void_sector')!.rifts![0];
    InSystem.systemId[pid] = gameData.getSystemNum('void_sector');
    Position.x[pid] = rift.position.x - 100;
    Position.y[pid] = rift.position.y;
    Velocity.x[pid] = 6;
    Velocity.y[pid] = 0;
    server.step();
    expect(InSystem.systemId[pid]).toBe(gameData.getSystemNum('the_maw'));
    expect(Math.hypot(Position.x[pid] - rift.destination.x, Position.y[pid] - rift.destination.y)).toBeLessThan(50);
    expect(Velocity.x[pid]).toBeGreaterThan(3);
    const info = got.filter((m) => m.type === 'systemInfo').pop() as any;
    expect(info.systemId).toBe('the_maw');
    expect(info.centralBody.type).toBe('black_hole');
    // And it doesn't bounce the ship straight back
    for (let i = 0; i < 30; i++) server.step();
    expect(InSystem.systemId[pid]).toBe(gameData.getSystemNum('the_maw'));
  });

  it('jump gates land you beside the gate that leads back', () => {
    const { server, gameData, t, pid } = live();
    const toCinder = files.systems.systems.find((s) => s.id === 'sol')!.portals.find((p) => p.targetSystem === 'cinder_reach')!;
    const back = files.systems.systems.find((s) => s.id === 'cinder_reach')!.portals.find((p) => p.targetSystem === 'sol')!;
    Position.x[pid] = toCinder.position.x;
    Position.y[pid] = toCinder.position.y;
    t.send({ type: 'interact' } as any);
    server.step();
    expect(InSystem.systemId[pid]).toBe(gameData.getSystemNum('cinder_reach'));
    expect(Math.hypot(Position.x[pid] - back.position.x, Position.y[pid] - back.position.y)).toBeLessThan(800);
  });
});

describe('hazards', () => {
  const toMaw = (server: GameServer, gameData: GameData, pid: number, x: number, y: number) => {
    InSystem.systemId[pid] = gameData.getSystemNum('the_maw');
    Position.x[pid] = x; Position.y[pid] = y;
    Velocity.x[pid] = 0; Velocity.y[pid] = 0;
    void server;
  };

  it("The Maw's gravity pulls an idle ship towards the black hole", () => {
    const { server, gameData, pid } = live();
    // (Just outside the horizon's reach: 4,200 from the centre)
    toMaw(server, gameData, pid, 6800, 0);
    for (let i = 0; i < 60; i++) server.step();
    expect(Position.x[pid]).toBeLessThan(6800 - 50);
    expect(Math.abs(Position.y[pid])).toBeLessThan(5);
  });

  it('crossing the event horizon destroys the ship', () => {
    const { server, gameData, got, pid } = live();
    toMaw(server, gameData, pid, 4100, 0);
    for (let i = 0; i < 3; i++) server.step();
    expect(got.some((m) => m.type === 'death' && (m as any).entityId === pid)).toBe(true);
  });

  it('there is no pull in a system without a well', () => {
    const { server, pid } = live();
    Position.x[pid] = 4000; Position.y[pid] = 0; Velocity.x[pid] = 0; Velocity.y[pid] = 0;
    for (let i = 0; i < 60; i++) server.step();
    expect(Position.x[pid]).toBe(4000);
    expect(Health.current[pid]).toBeGreaterThan(0);
  });

  it('systemInfo tells the client about the well and the hazards', () => {
    const { server, gameData, t, got, pid } = live();
    const rift = files.systems.systems.find((s) => s.id === 'void_sector')!.rifts![0];
    InSystem.systemId[pid] = gameData.getSystemNum('void_sector');
    Position.x[pid] = rift.position.x; Position.y[pid] = rift.position.y;
    server.step();
    const info = got.filter((m) => m.type === 'systemInfo').pop() as any;
    expect(info.centralBody.gravity.horizon).toBe(4200);
    expect(info.hazards).toContain('gravitational_anomalies');
    void gameData; void t;
  });
});

describe('map warp (dev tool)', () => {
  it('warps to a system, arriving beside its station', () => {
    const { server, gameData, t, pid } = live(true);
    t.send({ type: 'devTeleport', systemId: 'glasswater' } as any);
    expect(InSystem.systemId[pid]).toBe(gameData.getSystemNum('glasswater'));
    const relay = files.stations.stations.find((s) => s.id === 'glasswater_station_relay')!;
    expect(Math.hypot(Position.x[pid] - relay.position.x, Position.y[pid] - relay.position.y)).toBeLessThan(1500);
    void server;
  });

  it('warps to a spot, and keeps clear of a black hole when there is no station', () => {
    const { gameData, t, pid } = live(true);
    t.send({ type: 'devTeleport', systemId: 'sol', x: 1234, y: -567 } as any);
    expect([Position.x[pid], Position.y[pid]]).toEqual([1234, -567]);
    t.send({ type: 'devTeleport', systemId: 'the_maw' } as any);
    expect(InSystem.systemId[pid]).toBe(gameData.getSystemNum('the_maw'));
    expect(Math.hypot(Position.x[pid], Position.y[pid])).toBeGreaterThan(6000);
  });

  it('is refused when the server has it off (non-admins)', () => {
    const { gameData, t, got, pid } = live(false);
    t.send({ type: 'devTeleport', systemId: 'glasswater' } as any);
    expect(InSystem.systemId[pid]).toBe(gameData.getSystemNum('sol'));
    expect(got.some((m) => m.type === 'systemMessage' && /dev tool/.test((m as any).text))).toBe(true);
  });
});

describe('derelicts', () => {
  const wrecksIn = (server: GameServer, gameData: GameData, systemId: string) =>
    [...server.getShips().bodies.entries()]
      .filter(([eid, s]) => s.kind === 'ship' && !bitecs.hasComponent(server.world, Player, eid) && InSystem.systemId[eid] === gameData.getSystemNum(systemId))
      .filter(([eid]) => !server.getTrafficShips().some((t) => t.eid === eid))
      .filter(([eid]) => !(server as any).personCraft.has(eid)) // people's ships (people.json craft)
      .map(([eid]) => eid);

  it('every system with derelicts gets its battered hulks, in that system', () => {
    const { server, gameData } = live();
    for (const sys of files.systems.systems) {
      expect(wrecksIn(server, gameData, sys.id).length, sys.id).toBe(sys.derelicts?.length ?? 0);
    }
    const [eid] = wrecksIn(server, gameData, 'sol');
    const ship = server.getShips().get(eid)!;
    expect(ship.hp.some((h, i) => h < ship.maxHp[i])).toBe(true); // battle damage
  });

  it('wrecks hold their place, even next to a black hole', () => {
    const { server, gameData } = live();
    const [eid] = wrecksIn(server, gameData, 'the_maw');
    const x0 = Position.x[eid], y0 = Position.y[eid];
    for (let i = 0; i < 600; i++) server.step();
    expect(Math.hypot(Position.x[eid] - x0, Position.y[eid] - y0)).toBeLessThan(5);
  });

  it('breaking a wreck pays its salvage to whoever landed the last shot, and throws out plate of its material', () => {
    const { server, gameData, pid, got } = live();
    const [eid] = wrecksIn(server, gameData, 'sol');
    const bridge = server.getShips();
    const credits0 = Player.credits[pid];
    const material = bridge.get(eid)!.blueprint.parts.find((q) => q.fn === 'hull')!.material;
    const plate = (server as any).econ.recipes.parts.plates[material];
    const proj = 60000;
    Projectile.damage[proj] = 1e6;
    // Shoot it to pieces from every side until the core goes
    for (let k = 0; k < 2000 && bridge.has(eid); k++) {
      const a = k * 2.399, cx = Position.x[eid], cy = Position.y[eid];
      bridge.hitProjectile(proj, pid, cx + Math.cos(a) * 600, cy + Math.sin(a) * 600, cx, cy, [{ id: eid }]);
      if (k % 10 === 9) server.step();
    }
    server.step();
    expect(bridge.has(eid)).toBe(false);
    expect(Player.credits[pid]).toBeGreaterThan(credits0);
    expect(got.some((m) => m.type === 'systemMessage' && /Salvaged/.test((m as any).text))).toBe(true);
    // In chunks still drifting, or already pulled into the hold
    const pods = [...((server as any).pods.contents as Map<number, Record<string, number>>).values()];
    const held = server.pilots.get(server.pilots.connOf(pid)!)!.cargo.some((c) => c.id === plate);
    expect(held || pods.some((b) => (b[plate] ?? 0) > 0)).toBe(true);
  });
});

describe('sol traffic', () => {
  it('freighters fly their routes and stop at each station', () => {
    const { server } = live();
    server.step();
    const ships = server.getTrafficShips();
    expect(ships.length).toBe(files.systems.systems.reduce((n, s) => n + (s.traffic?.length ?? 0), 0));
    const f = ships[0];
    const startLeg = f.leg;
    const x0 = Position.x[f.eid], y0 = Position.y[f.eid];
    // Up to 3 minutes of game time: it must move off and reach (then leave) its first stop
    let moved = 0;
    for (let i = 0; i < 60 * 180 && server.getTrafficShips()[0].leg === startLeg; i++) {
      server.step();
      moved = Math.max(moved, Math.hypot(Position.x[f.eid] - x0, Position.y[f.eid] - y0));
    }
    expect(moved).toBeGreaterThan(2000);
    expect(server.getTrafficShips()[0].leg).not.toBe(startLeg);
  });
});

describe('jump drive and stars', () => {
  it("a star's charging ring recharges the drive twice as fast", () => {
    const cool = (x: number) => {
      const { server, pid } = live();
      const ship = server.getShips().get(pid)!;
      const jt = server.getShips().tuning.jump!;
      ship.jump = jumpBurnAt(jumpTuning(server.getShips().tuning)) + jt.burnTicks! + 1; // just into the cooldown
      let ticks = 0;
      while (ship.jump !== 0 && ticks < 5000) { Position.x[pid] = x; Position.y[pid] = 0; Velocity.x[pid] = 0; Velocity.y[pid] = 0; server.step(); ticks++; }
      return ticks;
    };
    const far = cool(30000), near = cool(6000);
    expect(near).toBeLessThan(far / 1.8);
  });
});

