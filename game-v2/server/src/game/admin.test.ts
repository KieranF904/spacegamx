import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Position, Velocity, InSystem, ServerMessage } from '@space-game/common';
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
  const join = (name: string) => {
    const t = new LocalTransport(server);
    const got: ServerMessage[] = [];
    t.onMessage = (m) => got.push(m);
    t.connect();
    t.send({ type: 'join', username: name } as any);
    const pid = t.getPlayerId();
    const conn = [...(server as any).clients.values()].find((c: any) => c.playerId === pid);
    return { t, got, pid, conn };
  };
  const step = (n = 1) => { for (let i = 0; i < n; i++) server.step(); };
  return { server, join, step };
}

const results = (got: ServerMessage[]) => got.filter((m) => m.type === 'adminResult') as any[];

describe('admin tools', () => {
  it('refuses players who aren\'t admins', () => {
    const { server, join, step } = world();
    const p = join('pilot');
    p.t.send({ type: 'admin', cmd: 'credits', args: { n: 5000 } } as any);
    step();
    const before = server.pilots.get(p.conn)!.credits;
    expect(results(p.got).at(-1)?.ok).toBe(false);
    expect(server.pilots.get(p.conn)!.credits).toBe(before);
    // ...and their chat commands are just chat
    p.t.send({ type: 'chat', text: '/god' } as any);
    step();
    expect(server.admin.isGod(p.pid)).toBe(false);
  });

  it('moves players about: to a point, to each other, to a station', () => {
    const { server, join, step } = world();
    const a = join('boss'); a.conn.isAdmin = true;
    const b = join('rookie');
    a.t.send({ type: 'admin', cmd: 'tp', args: { x: 12345, y: -6789 } } as any);
    step(2);
    expect(Math.round(Position.x[a.pid])).toBe(12345);
    expect(Math.round(Position.y[a.pid])).toBe(-6789);
    a.t.send({ type: 'admin', cmd: 'bring', args: { player: 'rook' } } as any);
    step(2);
    expect(Math.hypot(Position.x[b.pid] - Position.x[a.pid], Position.y[b.pid] - Position.y[a.pid])).toBeLessThan(400);
    a.t.send({ type: 'chat', text: '/goto Ember Forge' } as any);
    step(2);
    expect(server['gameData'].getSystemByNum(InSystem.systemId[a.pid])?.id).toBe('cinder_reach');
    expect(results(a.got).every((r) => r.ok)).toBe(true);
  });

  it('god mode takes no damage; hidden pilots are left alone', () => {
    const { server, join, step } = world();
    const a = join('boss'); a.conn.isAdmin = true;
    a.t.send({ type: 'chat', text: '/god on' } as any);
    a.t.send({ type: 'chat', text: '/hide on' } as any);
    step();
    const ships = server.getShips();
    const ship = ships.get(a.pid)!;
    const core = ship.blueprint.parts.findIndex((p) => p.fn === 'core');
    expect(ships.hurt(a.pid, ship, core, 1e6, -1)).toBe(0);
    expect(server.admin.isHidden(a.pid)).toBe(true);
    // A pack right beside a hidden pilot never goes for them
    Position.x[a.pid] = 90000; Position.y[a.pid] = 90000;
    a.t.send({ type: 'admin', cmd: 'spawn', args: { faction: 'pirates', ships: ['pirate_raider'], x: 90000, y: 89200 } } as any);
    step();
    const foes = [...ships.bodies.keys()].filter((e) => server.enemies.factionOf(e));
    expect(foes.length).toBeGreaterThan(0);
    for (let i = 0; i < 60 * 4; i++) {
      Position.x[a.pid] = 90000; Position.y[a.pid] = 90000; Velocity.x[a.pid] = Velocity.y[a.pid] = 0;
      step();
      for (const f of foes) expect(server.enemies.targetOf(f)).not.toBe(a.pid);
    }
    // Seen again, they go for them
    a.t.send({ type: 'chat', text: '/hide off' } as any);
    step(30);
    expect(foes.some((f) => server.enemies.targetOf(f) === a.pid)).toBe(true);
  });

  it('gives, spawns and clears', () => {
    const { server, join, step } = world();
    const a = join('boss'); a.conn.isAdmin = true;
    const credits = server.pilots.get(a.conn)!.credits;
    a.t.send({ type: 'chat', text: '/credits 2500' } as any);
    a.t.send({ type: 'chat', text: '/give repair_kit 3' } as any);
    step();
    expect(server.pilots.get(a.conn)!.credits).toBe(credits + 2500);
    expect(server.pilots.available(a.conn, 'repair_kit')).toBeGreaterThanOrEqual(3);
    const num = InSystem.systemId[a.pid];
    a.t.send({ type: 'chat', text: '/spawn pirates pirate_skiff x3' } as any);
    step();
    expect(server.enemies.count(num)).toBeGreaterThanOrEqual(3);
    a.t.send({ type: 'admin', cmd: 'clear', args: { quiet: true } } as any);
    step(3);
    expect(server.enemies.count(num)).toBe(0);
    expect(results(a.got).filter((r) => !r.ok)).toEqual([]);
  });
});
