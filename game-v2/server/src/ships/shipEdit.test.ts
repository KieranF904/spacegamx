import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { readFileSync } from 'fs';
import * as bitecs from 'bitecs';
import { Position, Health, InSystem, ServerMessage, parseBlueprint, Station as StationComp, MAX_STATION_ORBIT_SPEED, countOf, buyPrice, Blueprint, ghostBill, partItemId, isStructural, registeredFunction, MATERIAL_LEVEL } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { MemoryProfileStore } from '../profile/ProfileStore.js';
import { COMBAT_RULES } from '../gameServer/combatLock.js';
import { makeServer } from '../testkits/world.testkit.js';

const dataDir = join(__dirname, '../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const arrow = parseBlueprint(readFileSync(join(dataDir, 'ships/blueprints/arrow.json'), 'utf-8'));

function liveServer(opts: { store?: MemoryProfileStore; user?: any } = {}) {
  resetGlobals();
  const userDB: any = { validateSession: async () => opts.user ?? null, cleanupExpiredSessions: async () => {} };
  const server = makeServer({
    gameData: new GameData(readGameDataFiles(dataDir)),
    userDB,
    profileStore: opts.store,
  });
  const t = new LocalTransport(server);
  const got: ServerMessage[] = [];
  t.onMessage = (m) => got.push(m);
  t.connect();
  t.send({ type: 'join', username: 'pilot', token: opts.user ? 'tok' : undefined } as any);
  return { server, t, got, pid: t.getPlayerId() };
}

const lastEdit = (got: ServerMessage[]) => [...got].reverse().find((m) => m.type === 'shipEditResult') as any;
const connOf = (server: GameServer, pid: number) => server.pilots.connOf(pid)!;
const profileOf = (server: GameServer, pid: number) => server.pilots.get(connOf(server, pid))!;
/** Everything a design takes: its modules, its structure's materials, the core's licence, and the level to fit them (nothing opens early) */
function grantParts(server: GameServer, pid: number, bp: Blueprint) {
  server.pilots.give(connOf(server, pid), ghostBill(server.econ, bp, bp.parts.map((p) => p.uid)), { toStorage: true, quiet: true });
  const p = profileOf(server, pid);
  if (!p.recipes.includes('fn:core')) p.recipes.push('fn:core');
  p.level = Math.max(p.level, ...bp.parts.map((q) => Math.max(registeredFunction(q.fn)?.unlock?.level ?? 0, MATERIAL_LEVEL[q.material] ?? 0)));
}
const settle = () => new Promise((r) => setTimeout(r, 0));

/** Park the player within docking range of a station */
function parkAtStation(server: GameServer, pid: number): boolean {
  const world = server.getWorld();
  for (let e = 0; e < 5000; e++) {
    if (e === pid || !bitecs.entityExists(world, e) || !bitecs.hasComponent(world, StationComp, e)) continue;
    Position.x[pid] = Position.x[e] + 300;
    Position.y[pid] = Position.y[e];
    if ((server as any).isDocked(pid)) return true;
  }
  return false;
}

describe('hangar refits in the live game', () => {
  it('are refused away from a station', () => {
    const { server, t, got, pid } = liveServer();
    Position.x[pid] = 123456; Position.y[pid] = 123456;
    grantParts(server, pid, arrow);
    t.send({ type: 'shipEdit', blueprint: arrow });
    expect(lastEdit(got).ok).toBe(false);
    expect(lastEdit(got).errors[0]).toMatch(/dock/i);
    expect(server.getShips().get(pid)!.blueprint.name).toBe('Sparrow T');
  });

  it("refuse parts you can't make yet, accept them once owned, and send leftover parts to storage", () => {
    const { server, t, got, pid } = liveServer();
    server.step();
    expect(parkAtStation(server, pid)).toBe(true);
    t.send({ type: 'shipEdit', blueprint: arrow });
    expect(lastEdit(got).ok).toBe(false);
    expect(lastEdit(got).errors[0]).toMatch(/can't make|licensed/);

    const sparrow = server.getShips().get(pid)!.blueprint;
    grantParts(server, pid, arrow);
    const before = profileOf(server, pid).storage.map((s) => ({ ...s }));
    t.send({ type: 'shipEdit', blueprint: arrow });
    expect(lastEdit(got).ok).toBe(true);
    expect(server.getShips().get(pid)!.blueprint.name).toBe('Arrow');
    for (let i = 0; i < 4; i++) server.step();
    expect(got.some((m) => m.type === 'shipSync' && (m as any).id === pid && (m as any).blueprint.name === 'Arrow')).toBe(true);
    // Every Sparrow module the Arrow didn't reuse went back to storage; the Arrow's new ones came out of it
    const storage = profileOf(server, pid).storage;
    const reused = (q: { uid: number }, other: Blueprint) => other.parts.some((a) => a.uid === q.uid && partItemId(a) === partItemId(q as any));
    const modules = [...sparrow.parts, ...arrow.parts].filter((q) => !isStructural(q.fn)).map((q) => partItemId(q));
    for (const id of new Set(modules)) {
      const freed = sparrow.parts.filter((q) => partItemId(q) === id && !reused(q, arrow)).length;
      const paid = arrow.parts.filter((q) => partItemId(q) === id && !reused(q, sparrow)).length;
      expect(countOf(storage, id), id).toBe(countOf(before, id) + freed - paid);
    }
  });

  it('an old design that still says it runs on the pool is built as a ports ship, the field ignored', () => {
    const { server, t, got, pid } = liveServer();
    (server as any).shipEditAnywhere = true;
    grantParts(server, pid, arrow);
    t.send({ type: 'shipEdit', blueprint: { ...arrow, power: 'pool' } as any });
    expect(lastEdit(got).ok).toBe(true);
    const ship = server.getShips().get(pid)!;
    expect('power' in ship.blueprint).toBe(false);
    expect(ship.derived.ports).toBeDefined();
  });

  it('a new pilot starts in the ports Sparrow T', () => {
    const { server, pid } = liveServer();
    const ship = server.getShips().get(pid)!;
    expect(ship.blueprint.name).toBe('Sparrow T');
    expect(ship.derived.ports).toBeDefined();
  });

  it('reject an invalid blueprint even when docked', () => {
    const { server, t, got, pid } = liveServer();
    (server as any).shipEditAnywhere = true;
    const bad = { ...arrow, parts: arrow.parts.filter((p) => p.fn !== 'core') };
    t.send({ type: 'shipEdit', blueprint: bad });
    expect(lastEdit(got).ok).toBe(false);
    expect(server.getShips().get(pid)!.blueprint.name).toBe('Sparrow T');
  });
});

describe('death and rebuilding', () => {
  it('a destroyed ship is lost to a plan in the hangar, its hold in a wreck, and the pilot respawns in the starter (death-rework-2026-11.md)', () => {
    const { server, t, pid } = liveServer();
    (server as any).shipEditAnywhere = true;
    grantParts(server, pid, arrow);
    t.send({ type: 'shipEdit', blueprint: arrow });
    server.pilots.give(connOf(server, pid), { iron_ore: 10 });
    expect(countOf(profileOf(server, pid).cargo, 'iron_ore')).toBe(10);
    const slot = profileOf(server, pid).activeSlot;
    const storage = JSON.stringify(profileOf(server, pid).storage);
    const bank = JSON.stringify(profileOf(server, pid).bank!.free);

    // Destroyed in play (the core shot away): the real death path, not a direct call
    Position.x[pid] = 90000; Position.y[pid] = 90000;
    server.getShips().damagePartFraction(pid, arrow.parts.findIndex((p) => p.fn === 'core'), 1);
    for (let i = 0; i < 3; i++) server.step();
    // All of the hold goes in the wreck where the ship died, marked for its pilot; nothing to storage
    expect(profileOf(server, pid).cargo).toEqual([]);
    const world = server.getWorld();
    const pods = [...Array(5000).keys()].filter((e) => bitecs.entityExists(world, e) && (server as any).pods.get(e) && Math.hypot(Position.x[e] - 90000, Position.y[e] - 90000) < 600);
    expect(pods.length).toBe(1);
    expect(((server as any).pods.get(pods[0]) as Record<string, number>).iron_ore).toBeGreaterThanOrEqual(10);
    expect(profileOf(server, pid).wreck?.system).toBe('sol');
    expect(JSON.stringify(profileOf(server, pid).storage)).toBe(storage);

    // The Arrow stays in its slot as its design, every part missing, lost and on order; the bank paid nothing
    const p = profileOf(server, pid);
    const rec = p.hangar[slot]!;
    expect(rec.blueprint.name).toBe('Arrow');
    expect(rec.lost && rec.auto).toBe(true);
    expect(new Set(rec.ghosts)).toEqual(new Set(rec.blueprint.parts.map((q) => q.uid)));
    expect(JSON.stringify(p.bank!.free)).toBe(bank);
    expect(p.activeSlot).not.toBe(slot);
    expect(p.ship.free?.length).toBe(p.ship.blueprint.parts.length);

    t.send({ type: 'respawn' } as any);
    const again = t.getPlayerId();
    expect(Health.current[again]).toBeGreaterThan(0);
    expect(server.getShips().get(again)!.blueprint.name).toBe(server.pilots.opts.starter.blueprint.name);
  });

  it('a station loan is repaid from a quarter of what comes in (docking fees still lend)', () => {
    const { server, pid } = liveServer();
    const conn = connOf(server, pid);
    const profile = profileOf(server, pid);
    profile.credits = 0;
    profile.debt = 1000;
    server.pilots.addCredits(conn, 100);
    expect(profile.credits).toBe(75);
    expect(profile.debt).toBe(975);
    server.pilots.addCredits(conn, -50);
    expect(profile.debt).toBe(975);
    server.pilots.addCredits(conn, 10_000);
    expect(profile.debt).toBeUndefined();
    expect(profile.credits).toBe(25 + 10_000 - 975);
  });
});

describe('saved progress', () => {
  const user = { id: 7, username: 'kieran', email: '', is_admin: false, created_at: '' };

  it('a logged-in pilot keeps their ship, items, credits and place across sessions', async () => {
    const store = new MemoryProfileStore();
    const first = liveServer({ store, user });
    await settle(); // join validates the session asynchronously
    (first.server as any).shipEditAnywhere = true;
    grantParts(first.server, first.pid, arrow);
    first.t.send({ type: 'shipEdit', blueprint: arrow });
    expect(lastEdit(first.got).ok).toBe(true);
    const conn = connOf(first.server, first.pid);
    first.server.pilots.give(conn, { crystal: 3 });
    first.server.pilots.addCredits(conn, 250);
    Position.x[first.pid] = 27300; Position.y[first.pid] = -12600;
    first.t.disconnect();
    await settle();
    await settle();

    // Server restarted: logging in restores it all
    const second = liveServer({ store, user });
    await settle();
    await settle();
    const p = profileOf(second.server, second.pid);
    expect(second.server.getShips().get(second.pid)!.blueprint.name).toBe('Arrow');
    expect(countOf(p.cargo, 'crystal')).toBe(3);
    expect(p.credits).toBe(300 + 250);
    expect(Math.round(Position.x[second.pid])).toBe(27300);
    expect(Math.round(Position.y[second.pid])).toBe(-12600);
  });

  it('guests are not saved', async () => {
    const store = new MemoryProfileStore();
    const g = liveServer({ store });
    (g.server as any).shipEditAnywhere = true;
    grantParts(g.server, g.pid, arrow);
    g.t.send({ type: 'shipEdit', blueprint: arrow });
    expect(lastEdit(g.got).ok).toBe(true);
    g.t.disconnect();
    await settle();
    expect(await store.load(0)).toBeNull();
    expect((store as any).docs.size).toBe(0);
  });

  it('quitting mid-fight leaves the ship in space for a while', async () => {
    const store = new MemoryProfileStore();
    const s = liveServer({ store, user });
    await settle();
    const world = s.server.getWorld();
    s.server.getShips().damagePartFraction(s.pid, 1, 0.1);
    (s.server.getShips() as any).lastDamaged.set(s.pid, (s.server as any).currentTick);
    s.t.disconnect();
    s.server.step();
    expect(bitecs.hasComponent(world, (await import('@space-game/common')).Dead, s.pid)).toBe(false);
    // (It lingers until lock + linger seconds after the last combat event: combatLock.ts)
    for (let i = 0; i < 60 * (COMBAT_RULES.lockSeconds + COMBAT_RULES.lingerSeconds + 1); i++) s.server.step();
    expect(bitecs.hasComponent(world, (await import('@space-game/common')).Dead, s.pid) || !bitecs.entityExists(world, s.pid)).toBe(true);
    await settle();
    expect(await store.load(7)).not.toBeNull();
  }, 30_000);
});

describe('stations and docking', () => {
  it('orbiting stations move slower than a ship can fly', () => {
    const { server } = liveServer();
    const world = server.getWorld();
    const stations = [...Array(5000).keys()].filter((e) => bitecs.entityExists(world, e) && (server as any).stationInRange !== undefined
      && bitecs.hasComponent(world, StationComp, e));
    expect(stations.length).toBeGreaterThan(0);
    const before = stations.map((e) => [Position.x[e], Position.y[e]]);
    server.step();
    stations.forEach((e, i) => {
      const speed = Math.hypot(Position.x[e] - before[i][0], Position.y[e] - before[i][1]);
      expect(speed).toBeLessThanOrEqual(MAX_STATION_ORBIT_SPEED + 1e-6);
    });
  });

  it('a docked ship rides along inside its station, and can refit after it has moved', () => {
    const { server, t, got, pid } = liveServer();
    const world = server.getWorld();
    // Sol Central is the orbiting one
    const central = [...Array(5000).keys()].find((e) => bitecs.entityExists(world, e) && bitecs.hasComponent(world, StationComp, e)
      && StationComp.orbitType[e] !== 255)!;
    expect(central).toBeDefined();
    Position.x[pid] = Position.x[central] + 300;
    Position.y[pid] = Position.y[central];
    t.send({ type: 'dock' } as any);
    expect((got.filter((m) => m.type === 'dockResult').pop() as any).ok).toBe(true);

    const start = [Position.x[central], Position.y[central]];
    for (let i = 0; i < 1200; i++) server.step(); // 20 s: the station travels ~1400 units
    expect(Math.hypot(Position.x[central] - start[0], Position.y[central] - start[1])).toBeGreaterThan(900);
    expect(Math.hypot(Position.x[pid] - Position.x[central], Position.y[pid] - Position.y[central])).toBeLessThan(1); // inside it, at its centre

    grantParts(server, pid, arrow);
    t.send({ type: 'shipEdit', blueprint: arrow });
    expect(lastEdit(got).ok).toBe(true);
    t.send({ type: 'undock' } as any);
    for (let i = 0; i < 60; i++) server.step();
    // Undocked: the station moves on without us
    expect(Math.hypot(Position.x[central] + 300 - Position.x[pid], Position.y[central] - Position.y[pid])).toBeGreaterThan(5);
  });

  it('a docked ship is inside its station: held at its centre, out of every fight, and back out where it came in', () => {
    const { server, t, got, pid } = liveServer();
    const world = server.getWorld();
    const central = [...Array(5000).keys()].find((e) => bitecs.entityExists(world, e) && bitecs.hasComponent(world, StationComp, e)
      && StationComp.orbitType[e] !== 255)!;
    Position.x[pid] = Position.x[central] + 300;
    Position.y[pid] = Position.y[central];
    t.send({ type: 'dock' } as any);
    expect((got.filter((m) => m.type === 'dockResult').pop() as any).ok).toBe(true);
    for (let i = 0; i < 30; i++) server.step();
    expect(Math.hypot(Position.x[pid] - Position.x[central], Position.y[pid] - Position.y[central])).toBeLessThan(1);
    // Nothing can hurt it
    const ships = server.getShips();
    expect(server.canDamage(0, pid)).toBe(false);
    const hp = ships.integrity(pid);
    ships.splashAt(InSystem.systemId[pid], Position.x[pid], Position.y[pid], 400, 500, -1);
    expect(ships.integrity(pid)).toBe(hp);
    t.send({ type: 'undock' } as any);
    server.step();
    expect(Math.hypot(Position.x[pid] - Position.x[central] - 300, Position.y[pid] - Position.y[central])).toBeLessThan(20);
    expect(server.canDamage(0, pid)).toBe(true);
  });

  it('docking is refused out of range', () => {
    const { t, got, pid } = liveServer();
    Position.x[pid] = 200000; Position.y[pid] = 200000;
    t.send({ type: 'dock' } as any);
    expect((got.filter((m) => m.type === 'dockResult').pop() as any).ok).toBe(false);
  });
});
