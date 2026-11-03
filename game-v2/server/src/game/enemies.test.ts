import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Position, Velocity, Rotation, InSystem, ServerMessage, Station as StationComp, DroppedItem } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';

const dataDir = join(__dirname, '../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);

function world() {
  resetGlobals();
  const server = new GameServer({
    gameData: new GameData(files),
    userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as any,
    scene: 'sectors',
    autoStart: false,
    ships: createShipBridge(loadShipConfigFromDisk(dataDir)),
  });
  const t = new LocalTransport(server);
  const got: ServerMessage[] = [];
  t.onMessage = (m) => got.push(m);
  t.connect();
  t.send({ type: 'join', username: 'hunter' } as any);
  const pid = t.getPlayerId();
  const step = (n = 1) => { for (let i = 0; i < n; i++) server.step(); };
  return { server, t, got, pid, step, bridge: server.getShips(), enemies: server.enemies };
}

const hold = (pid: number, x: number, y: number) => { Position.x[pid] = x; Position.y[pid] = y; Velocity.x[pid] = 0; Velocity.y[pid] = 0; };

describe('enemies', () => {
  it('packs appear while a player is in the system: out of sight, away from stations', () => {
    const { server, pid, step, enemies } = world();
    hold(pid, 20000, 0);
    for (let i = 0; i < 60 * 40 && enemies.count(InSystem.systemId[pid]) === 0; i++) { hold(pid, 20000, 0); step(); }
    expect(enemies.count(InSystem.systemId[pid])).toBeGreaterThan(0);
    const w = server.getWorld();
    const stations = [...Array(8000).keys()].filter((e) => bitecs.entityExists(w, e) && bitecs.hasComponent(w, StationComp, e) && InSystem.systemId[e] === InSystem.systemId[pid]);
    for (const [eid] of server.getShips().bodies) {
      if (!enemies.factionOf(eid)) continue;
      expect(Math.hypot(Position.x[eid] - 20000, Position.y[eid])).toBeGreaterThan(2500);
      for (const s of stations) expect(Math.hypot(Position.x[eid] - Position.x[s], Position.y[eid] - Position.y[s])).toBeGreaterThan(6000);
    }
  });

  it('a pack engages a nearby player and opens fire', () => {
    const { pid, step, enemies, bridge } = world();
    // (Out past inner Sol's safe space, where hostiles leave pilots alone)
    hold(pid, 90000, 90000);
    const [foe] = enemies.spawnPack(InSystem.systemId[pid], { faction: 'pirates', ships: ['pirate_raider'] }, 90000, 89000);
    const ship = bridge.get(pid)!;
    const full = ship.hp.reduce((a, b) => a + b, 0) + ship.shield;
    for (let i = 0; i < 60 * 12; i++) { hold(pid, 90000, 90000); step(); }
    const now = ship.hp.reduce((a, b) => a + b, 0) + ship.shield;
    expect(now).toBeLessThan(full);
    // It closed in to fight
    expect(Math.hypot(Position.x[foe] - 90000, Position.y[foe] - 90000)).toBeLessThan(1600);
  });

  it('a kill pays XP and credits and drops a loot pod', () => {
    const { server, pid, step, enemies, bridge, got } = world();
    hold(pid, 30000, 30000);
    const conn = server.pilots.connOf(pid)!;
    const before = { ...server.pilots.get(conn)! };
    const [foe] = enemies.spawnPack(InSystem.systemId[pid], { faction: 'pirates', ships: ['pirate_skiff'] }, 30000, 28500);
    (bridge as any).lastHitBy.set(foe, pid);
    const core = bridge.get(foe)!.blueprint.parts.findIndex((p) => p.fn === 'core');
    bridge.damagePartFraction(foe, core, 1);
    step(3);
    const after = server.pilots.get(conn)!;
    expect(after.xp).toBeGreaterThan(before.xp);
    expect(after.credits).toBeGreaterThan(before.credits);
    expect(got.some((m) => m.type === 'gained' && String((m as any).source).startsWith('kill:'))).toBe(true);
    const w = server.getWorld();
    const pods = [...Array(8000).keys()].filter((e) => bitecs.entityExists(w, e) && bitecs.hasComponent(w, DroppedItem, e)
      && Math.hypot(Position.x[e] - 30000, Position.y[e] - 28500) < 800);
    expect(pods.length).toBeGreaterThan(0);
  });

  it('armed stations fire on hostiles near them, a turret at a time; unarmed ones don\'t', () => {
    const { server, pid, step, enemies, bridge, got } = world();
    const w = server.getWorld();
    const station = (id: string) => [...Array(8000).keys()].find((e) => bitecs.entityExists(w, e) && bitecs.hasComponent(w, StationComp, e)
      && StationComp.stationId[e] === server['gameData'].getStationNum(id))!;
    // Sentinel Watch: four lasers (at a Mk V skiff: a Mk I one can go down to the first few, by where they land)
    const st = station('sol_station_sentinel');
    // (Near enough to see it: a station's shots, as every effect, go only to pilots within FX_RANGE)
    hold(pid, Position.x[st] + 4000, Position.y[st] + 4000);
    const [foe] = enemies.spawnPack(InSystem.systemId[pid], { faction: 'pirates', ships: ['pirate_skiff'], grade: 5 }, Position.x[st] + 900, Position.y[st]);
    const ship = bridge.get(foe)!;
    const full = ship.hp.reduce((a, b) => a + b, 0);
    for (let i = 0; i < 120; i++) { hold(foe, Position.x[st] + 900, Position.y[st]); Rotation.angle[foe] = 0; step(); }
    const shots = got.filter((m) => m.type === 'stationFire' && (m as any).target === foe && (m as any).station === st) as any[];
    expect(shots.length).toBeGreaterThan(4);
    expect(new Set(shots.map((m) => m.turret)).size).toBe(4);
    expect(!bridge.get(foe) || bridge.get(foe)!.hp.reduce((a, b) => a + b, 0) < full).toBe(true);
    // Sol Central has no guns
    const hub = station('sol_station_central');
    got.length = 0;
    const [other] = enemies.spawnPack(InSystem.systemId[pid], { faction: 'pirates', ships: ['pirate_skiff'] }, Position.x[hub] + 900, Position.y[hub]);
    for (let i = 0; i < 120; i++) { hold(other, Position.x[hub] + 900, Position.y[hub]); step(); }
    expect(got.some((m) => m.type === 'stationFire' && (m as any).station === hub)).toBe(false);
  });

  it('players can\'t hurt each other in safe space, but can in a PvP sector', () => {
    const { server, pid } = world();
    const other = server.getShips().spawnDummy(server.getShips().playerBlueprint, 0, 0, 0, 0);
    // A second player: give the dummy the Player component's stand-in by joining another client
    const t2 = new LocalTransport(server);
    t2.connect();
    t2.send({ type: 'join', username: 'rival' } as any);
    const p2 = t2.getPlayerId();
    void other;
    const sol = server['gameData'].getSystemNum('sol');
    const voidNum = server['gameData'].getSystemNum('void_sector');
    InSystem.systemId[pid] = sol; InSystem.systemId[p2] = sol;
    hold(pid, 30000, 30000); hold(p2, 30500, 30000);
    expect(server.canDamage(pid, p2)).toBe(false);
    InSystem.systemId[pid] = voidNum; InSystem.systemId[p2] = voidNum;
    expect(server.canDamage(pid, p2)).toBe(true);
    // ...but not inside a station's ring
    const w = server.getWorld();
    const st = [...Array(8000).keys()].find((e) => bitecs.entityExists(w, e) && bitecs.hasComponent(w, StationComp, e) && InSystem.systemId[e] === voidNum)!;
    hold(p2, Position.x[st] + 400, Position.y[st]);
    expect(server.canDamage(pid, p2)).toBe(false);
  });

  it('Sol is safe: its packs leave you alone until you shoot one of them', () => {
    const { pid, step, enemies, bridge } = world();
    hold(pid, 30000, 30000);
    const [foe] = enemies.spawnPack(InSystem.systemId[pid], { faction: 'pirates', ships: ['pirate_raider'], passive: true }, 30000, 29200);
    const ship = bridge.get(pid)!;
    const full = () => ship.hp.reduce((a, b) => a + b, 0) + ship.shield;
    const start = full();
    for (let i = 0; i < 60 * 8; i++) { hold(pid, 30000, 30000); step(); }
    expect(full()).toBe(start);
    // Provoke it
    const f = bridge.get(foe)!;
    bridge.hurt(foe, f, f.blueprint.parts.findIndex((p) => p.fn !== 'core'), 5, pid);
    for (let i = 0; i < 60 * 12; i++) { hold(pid, 30000, 30000); step(); }
    expect(full()).toBeLessThan(start);
  });

  it('every Sol spawn group is passive', () => {
    for (const g of (files.factions as any).spawns.sol.groups) expect(g.passive).toBe(true);
  });
});

