/**
 * The dev weapons range (game/WeaponsRange.ts, data/dev/range.json): dummies hold still, never fire, pay nothing and
 * come back whole; the dev messages are refused anywhere but a dev server; "ideal ammo" never spends cargo.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Position, Velocity, Rotation, InSystem, Projectile, encodeServerMessage, serverFrame, decodeServerFrame, type ServerMessage } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { withDevData, loadRangeConfig } from '../data/devData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';

const dataDir = join(__dirname, '../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const config = loadRangeConfig(dataDir)!;
const savedEnv = process.env.NODE_ENV;
afterEach(() => { process.env.NODE_ENV = savedEnv; });

function start(opts: { dev?: boolean; production?: boolean } = {}) {
  const dev = opts.dev ?? true;
  resetGlobals();
  if (opts.production) process.env.NODE_ENV = 'production';
  const server = new GameServer({
    gameData: new GameData(dev ? withDevData(readGameDataFiles(dataDir), dataDir) : readGameDataFiles(dataDir)),
    userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as any,
    scene: 'sectors', autoStart: false, devTeleport: dev, devRange: config, ships: createShipBridge(loadShipConfigCached(dataDir)),
  });
  process.env.NODE_ENV = savedEnv;
  const t = new LocalTransport(server);
  const got: ServerMessage[] = [];
  t.onMessage = (m) => got.push(m);
  t.connect();
  t.send({ type: 'join', username: 'ranger' } as any);
  const pid = t.getPlayerId();
  run(server, 5);
  return { server, t, got, pid, conn: server.pilots.connOf(pid)! };
}

/** GameServer.step runs one tick: this runs n */
const run = (server: GameServer, n: number) => { for (let i = 0; i < n; i++) server.step(); };
/** The readout as the client puts it together: the last head, then every row since (as client devRangeFeed.ts does) */
const lastState = (server: GameServer, got: ServerMessage[]) => {
  server.flushOutbox();
  let state: any;
  for (const m of got) {
    if (m.type === 'rangeHead') state = { ...m, dummies: m.dummies.map((d) => ({ ...d })) };
    else if (m.type === 'rangeRow' && state) Object.assign(state.dummies[m.i], { ...m, ttk: m.ttk ?? null });
  }
  return state;
};
const projectiles = (server: GameServer) => bitecs.defineQuery([Projectile])(server.world as any);
const pose = (server: GameServer, eids: number[]) => eids.map((e) => [Position.x[e], Position.y[e], Velocity.x[e], Velocity.y[e], Rotation.angle[e]]);

describe('weapons range: dummies', () => {
  it('the data loads: a clear private system and fourteen dummies at 400/800/1400/2600', () => {
    expect(config.system).toBe('dev_range');
    expect(config.dummies.length).toBeGreaterThanOrEqual(10);
    expect([...new Set(config.dummies.map((d) => d.distance))].sort((a, b) => a - b)).toEqual([400, 800, 1400, 2600]);
    const sys = withDevData(readGameDataFiles(dataDir), dataDir).systems.systems.find((s) => s.id === 'dev_range')!;
    expect(sys.hazards).toEqual([]);
    expect(sys.asteroidBelt.count).toBe(0);
  });

  it('stand still, aim and fire nothing, pay nothing, and come back whole at the same spot', () => {
    const { server, t, got, pid, conn } = start();
    t.send({ type: 'devRange', action: 'go' } as any);
    run(server, 5);
    expect(InSystem.systemId[pid]).toBe(server.gameData.getSystemNum('dev_range'));
    run(server, 120);
    const range = server.range!;
    const eids = range.eids();
    expect(eids.every((e) => e >= 0)).toBe(true);
    // Every one is a real enemy ship, named on the radar
    for (const e of eids) expect(server.enemies.isAlive(e)).toBe(true);
    const before = pose(server, eids);
    const myHull = server.getShips().get(pid)!.hp.reduce((a, b) => a + b, 0);
    run(server, 600);
    // Held where they are: no drift, no turning in place, no shots at the pilot (400 u away), none in the air
    expect(pose(server, eids)).toEqual(before);
    expect(projectiles(server).length).toBe(0);
    expect(server.getShips().get(pid)!.hp.reduce((a, b) => a + b, 0)).toBe(myHull);

    // Shoot one dead: it pays nothing and drops nothing, then comes back whole at the same place
    const p = server.pilots.get(conn)!;
    const credits = p.credits, xp = p.xp, storage = JSON.stringify(p.storage), cargo = JSON.stringify(p.cargo);
    const victim = eids[0], ship = server.getShips().get(victim)!;
    const at = [Position.x[victim], Position.y[victim]];
    // (a hit the way a gun's lands, reported to the readout; then the rest of it)
    (server.getShips() as any).damagePartBy(victim, 0, 5, pid);
    run(server, 2);
    ship.hp.forEach((_, i) => server.getShips().hurt(victim, ship, i, 1e9, pid));
    run(server, 3);
    expect(range.eids()[0]).toBe(-1);
    expect(p.credits).toBe(credits);
    expect(p.xp).toBe(xp);
    expect(JSON.stringify(p.storage)).toBe(storage);
    expect(JSON.stringify(p.cargo)).toBe(cargo);
    expect((server as any).pods.near(InSystem.systemId[pid], at[0], at[1], 600)).toEqual([]);
    // (not yet: it waits its few seconds)
    run(server, 60 * (config.respawnSeconds - 1));
    expect(range.eids()[0]).toBe(-1);
    run(server, 60 * 2 + 20);
    const back = range.eids()[0];
    expect(back).toBeGreaterThanOrEqual(0);
    expect([Position.x[back], Position.y[back]]).toEqual(at);
    const fresh = server.getShips().get(back)!;
    expect(fresh.hp.every((h, i) => h === fresh.maxHp[i])).toBe(true);

    // The readout: a kill time, and a state message to the pilot
    const state = lastState(server, got);
    expect(state).toBeTruthy();
    expect(state!.dummies.length).toBe(config.dummies.length);
    expect(state!.dummies[0].ttk).not.toBeNull();
  });

  it('damage shows in the readout, and reset brings everything back', () => {
    const { server, t, got, pid } = start();
    t.send({ type: 'devRange', action: 'go' } as any);
    run(server, 130);
    const range = server.range!;
    const e = range.eids()[2], ship = server.getShips().get(e)!;
    range.onDamage(e, 40);
    run(server, 30);
    const state = lastState(server, got);
    expect(state.dummies[2].dmg5).toBe(40);
    expect(state.dummies[2].dps).toBeGreaterThan(0);
    range.reset();
    run(server, 20);
    const next = lastState(server, got);
    expect(next.dummies[2].dmg5).toBe(0);
    expect(range.eids().every((x) => x >= 0)).toBe(true);
  });

  it('the readout goes as changes only: nothing while idle, one small row for a dummy that is hit', () => {
    const { server, t, got } = start();
    t.send({ type: 'devRange', action: 'go' } as any);
    run(server, 130);
    server.flushOutbox();
    expect(got.filter((m) => m.type === 'rangeHead').length).toBe(1);
    expect(got.filter((m) => m.type === 'rangeRow').length).toBe(config.dummies.length);
    got.length = 0;
    run(server, 120);
    server.flushOutbox();
    expect(got.filter((m) => m.type === 'rangeHead' || m.type === 'rangeRow')).toEqual([]);
    const range = server.range!;
    range.onDamage(range.eids()[3], 25);
    run(server, 15);
    server.flushOutbox();
    const rows = got.filter((m) => m.type === 'rangeRow') as Extract<ServerMessage, { type: 'rangeRow' }>[];
    expect(rows.map((r) => r.i)).toEqual([3]);
    expect(rows[0].dmg5).toBe(25);
    expect(encodeServerMessage(rows[0]).length).toBeLessThan(20);
    expect(decodeServerFrame(serverFrame([encodeServerMessage(rows[0])]))).toEqual([rows[0]]);
  });

  it('moving targets sweep, and switching back puts them on their spots', () => {
    const { server, t } = start();
    t.send({ type: 'devRange', action: 'go' } as any);
    run(server, 130);
    const range = server.range!;
    const home = pose(server, range.eids()).map(([x, y]) => [x, y]);
    t.send({ type: 'devRange', action: 'moving', on: true } as any);
    run(server, 900);
    const now = pose(server, range.eids());
    expect(now.some(([x, y], i) => Math.hypot(x - home[i][0], y - home[i][1]) > 40)).toBe(true);
    t.send({ type: 'devRange', action: 'moving', on: false } as any);
    run(server, 60);
    expect(pose(server, range.eids()).map(([x, y]) => [x, y])).toEqual(home);
  });
});

describe('weapons range: dev gate', () => {
  it('is refused on a server that is not a dev server', () => {
    const { server, t, got, pid } = start({ dev: false });
    expect(server.range).toBeNull();
    const sys = InSystem.systemId[pid];
    t.send({ type: 'devRange', action: 'go' } as any);
    t.send({ type: 'devRange', action: 'arm', guns: ['cannon_pip'] } as any);
    t.send({ type: 'devRange', action: 'ideal', on: true } as any);
    run(server, 10);
    expect(InSystem.systemId[pid]).toBe(sys);
    expect(server.ammo.isIdeal(server.pilots.connOf(pid)!)).toBe(false);
    expect(server.getShips().get(pid)!.blueprint.name).not.toMatch(/^Range rig/);
    expect(got.some((m) => m.type === 'systemMessage' && /dev tool/.test(m.text))).toBe(true);
  });

  it('is refused under NODE_ENV=production even if everything else is set', () => {
    const { server, t, pid } = start({ production: true });
    expect(server.range).toBeNull();
    t.send({ type: 'devRange', action: 'arm', guns: ['cannon_pip'] } as any);
    t.send({ type: 'devRange', action: 'ideal', on: true } as any);
    run(server, 10);
    expect(server.getShips().get(pid)!.blueprint.name).not.toMatch(/^Range rig/);
    expect(server.ammo.isIdeal(server.pilots.connOf(pid)!)).toBe(false);
  });

  it('arms the rig with one or two chosen guns, never saved, and refuses a non-weapon', () => {
    const { server, t, pid, conn } = start();
    const own = server.pilots.get(conn)!.ship.blueprint.name;
    t.send({ type: 'devRange', action: 'arm', guns: ['railgun_needle'] } as any);
    run(server, 3);
    expect(server.getShips().get(pid)!.derived.weapons.map((w) => w.kind)).toEqual(['railgun', 'railgun']);
    expect((server.pilots as any).persistable(conn, server.pilots.get(conn)!).ship.blueprint.name).toBe(own);
    t.send({ type: 'devRange', action: 'arm', guns: ['cannon_pip', 'laser_cutter'] } as any);
    run(server, 3);
    expect(server.getShips().get(pid)!.derived.weapons.map((w) => w.kind).sort()).toEqual(['cannon', 'laser']);
    t.send({ type: 'devRange', action: 'arm', guns: ['hull'] } as any);
    run(server, 3);
    expect(server.getShips().get(pid)!.derived.weapons.map((w) => w.kind).sort()).toEqual(['cannon', 'laser']);
    t.send({ type: 'devShip' } as any);
    run(server, 3);
    expect(server.getShips().get(pid)!.blueprint.name).toBe(own);
  });
});

describe('weapons range: ideal ammo', () => {
  it('fires unlimited rounds of the best crate, never dry, and never touches the hold', () => {
    const { server, t, conn } = start();
    t.send({ type: 'devRange', action: 'arm', guns: ['railgun_needle', 'missile_dart'] } as any);
    run(server, 3);
    const p = server.pilots.get(conn)!;
    const cargo = JSON.stringify(p.cargo), open = JSON.stringify(p.ammo ?? null);
    // Without it, an empty hold means plain rounds
    expect(server.ammo.spend(conn, 'railgun').dry).toBe(true);
    t.send({ type: 'devRange', action: 'ideal', on: true } as any);
    run(server, 1);
    expect(server.ammo.isIdeal(conn)).toBe(true);
    for (let i = 0; i < 1000; i++) {
      const r = server.ammo.spend(conn, 'railgun');
      expect(r.dry).toBe(false);
      expect(r.scale).toBe(1);
      expect(r.item).toBe('railgun_tungsten');
      expect(r.mods?.mul?.damage).toBeGreaterThan(0);
    }
    for (let i = 0; i < 300; i++) expect(server.ammo.spend(conn, 'missile').item).toBe('missile_shaped');
    expect(JSON.stringify(p.cargo)).toBe(cargo);
    expect(JSON.stringify(p.ammo ?? null)).toBe(open);
    // Off again: back to the hold's own crates
    t.send({ type: 'devRange', action: 'ideal', on: false } as any);
    run(server, 1);
    expect(server.ammo.spend(conn, 'railgun').dry).toBe(true);
  });

  it('the readout names each gun and the crate it uses', () => {
    const { server, t, got } = start();
    t.send({ type: 'devRange', action: 'go' } as any);
    t.send({ type: 'devRange', action: 'arm', guns: ['railgun_needle', 'cannon_pip'] } as any);
    run(server, 130);
    const state = lastState(server, got);
    expect(state.ideal).toBe(true);
    const needle = state.guns.find((g: any) => g.kind === 'railgun');
    expect(needle.crate).toMatch(/tungsten/i);
  });
});
