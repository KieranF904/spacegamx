import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { mkdtempSync, writeFileSync, existsSync, readdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as bitecs from 'bitecs';
import { Position, Velocity, InSystem, ServerMessage } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';
import { worldFileStore, MEMORY_VERSION, type WorldStore, type MemoryFile } from './SystemMemory.js';
import type { BossesFile } from './Bosses.js';

const dataDir = join(__dirname, '../../../data');
const files = readGameDataFiles(dataDir);
const bossFile = files.bosses as BossesFile;

/** A store that keeps what's written in memory (a restart reads it back as a fresh copy) */
function memStore() {
  let data: MemoryFile | null = null;
  const store: WorldStore = { load: () => (data ? structuredClone(data) : null), save: async (d) => { data = structuredClone(d); } };
  return { store, written: () => data };
}

/** A server with a pilot in Sol (god mode), on a clock that's ours to move; `store`: what it keeps the world in */
function world(store?: WorldStore, clock = { t: 1_000_000 }) {
  (bitecs as unknown as { resetGlobals: () => void }).resetGlobals();
  const server = new GameServer({
    gameData: new GameData(files), userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as any,
    scene: 'sectors', autoStart: false, ships: createShipBridge(loadShipConfigFromDisk(dataDir)), worldStore: store, clock: () => clock.t,
  });
  const t = new LocalTransport(server);
  const got: ServerMessage[] = [];
  t.onMessage = (m) => got.push(m);
  t.connect();
  t.send({ type: 'join', username: 'rememberer' } as any);
  const pid = t.getPlayerId();
  server['admin'].god.add(server.pilots.connOf(pid) as any);
  const num = (id: string) => server.gameData.getSystemNum(id);
  const hold = (x: number, y: number) => { Position.x[pid] = x; Position.y[pid] = y; Velocity.x[pid] = 0; Velocity.y[pid] = 0; };
  /** Somewhere, held still for `s` seconds (the clock keeping time with the ticks) */
  const at = (system: string, x: number, y: number, s = 0) => {
    if (InSystem.systemId[pid] !== num(system)) (server as any).travelTo(server.pilots.connOf(pid), num(system), x, y, false);
    for (let i = 0; i < s * 60; i++) { hold(x, y); clock.t += 1000 / 60; server.step(); }
  };
  /** Away from a system long enough for it to be put away */
  const away = () => at('sol', 120000, 0, server.memory.rules.evictAfterSeconds + 2);
  const bridge = server.getShips();
  const shipsIn = (system: string) => [...bridge.bodies.keys()].filter((e) => InSystem.systemId[e] === num(system) && e !== pid && bridge.get(e)!.kind === 'ship');
  return { server, t, got, pid, num, hold, at, away, bridge, shipsIn, clock, enemies: server.enemies, bosses: server.bosses, memory: server.memory };
}

const killBoss = (w: ReturnType<typeof world>, id: string) => {
  const eid = w.bosses.eidOf(id);
  const ship = w.bridge.get(eid)!;
  w.bridge.hurt(eid, ship, 0, 10, w.pid);
  w.bridge.hurt(eid, ship, ship.blueprint.parts.findIndex((p) => p.fn === 'core'), 1e9, w.pid);
};

describe('system memory', () => {
  it('a boss killed stays dead when you leave and come straight back, and after a restart, until it is due', async () => {
    const { store } = memStore();
    const clock = { t: 1_000_000 };
    const w = world(store, clock);
    const def = bossFile.bosses.boss_rustjaw;
    const lairAt = (ww: typeof w, s: number) => ww.at(def.system, def.lair.x + 6000, def.lair.y, s);
    lairAt(w, 2);
    expect(w.bosses.isAlive('boss_rustjaw')).toBe(true);
    killBoss(w, 'boss_rustjaw');
    lairAt(w, 1);
    expect(w.bosses.isAlive('boss_rustjaw')).toBe(false);
    // Out and back (its system put away and brought back): still dead
    w.away();
    expect(w.memory.remembers(def.system)).toBe(true);
    lairAt(w, 3);
    expect(w.bosses.isAlive('boss_rustjaw')).toBe(false);
    await w.server.saveAll();
    // A restart a minute later: still dead
    clock.t += 60_000;
    const w2 = world(store, clock);
    lairAt(w2, 3);
    expect(w2.bosses.isAlive('boss_rustjaw')).toBe(false);
    await w2.server.saveAll();
    // ...until its respawnSeconds are up (the world's clock ran on while the server was down)
    clock.t += def.respawnSeconds * 1000;
    const w3 = world(store, clock);
    lairAt(w3, 3);
    expect(w3.bosses.isAlive('boss_rustjaw')).toBe(true);
  }, 60000);

  it("a living boss survives a restart as hurt as it was, and isn't announced as newly sighted", async () => {
    const { store } = memStore();
    const clock = { t: 1_000_000 };
    const w = world(store, clock);
    const def = bossFile.bosses.boss_prism_colossus;
    w.at(def.system, def.lair.x + 6000, def.lair.y, 2);
    const eid = w.bosses.eidOf('boss_prism_colossus');
    const ship = w.bridge.get(eid)!;
    for (let i = 0; i < ship.hp.length && w.bridge.integrity(eid) > 0.7; i++) if (ship.blueprint.parts[i].fn !== 'core') w.bridge.hurt(eid, ship, i, ship.hp[i] + 1, w.pid);
    w.at(def.system, def.lair.x + 6000, def.lair.y, 1);
    const hurt = w.bridge.integrity(eid);
    await w.server.saveAll();
    const w2 = world(store, clock);
    w2.at(def.system, def.lair.x + 6000, def.lair.y, 2);
    expect(w2.bosses.isAlive('boss_prism_colossus')).toBe(true);
    expect(w2.bridge.integrity(w2.bosses.eidOf('boss_prism_colossus'))).toBeLessThan(hurt + 0.03);
    expect(w2.got.some((m) => m.type === 'systemMessage' && /sighted/.test((m as any).text ?? ''))).toBe(false);
  }, 60000);

  it("a system left empty is taken out of the world whole, and comes back moved on and mended; events' packs don't", () => {
    const w = world();
    const ash = w.num('ashfall');
    w.at('ashfall', 0, 60000, 1);
    // One of the system's own packs (hurt), and one an event sent
    const own = w.enemies.spawnPack(ash, { faction: 'pirates', ships: ['pirate_raider', 'pirate_skiff'] }, -20000, -40000);
    w.enemies.own(own, 'system');
    const visitor = w.enemies.spawnPack(ash, { faction: 'pirates', ships: ['pirate_raider'] }, 30000, -40000);
    const ship = w.bridge.get(own[0])!;
    const part = ship.blueprint.parts.findIndex((p) => p.fn !== 'core');
    w.bridge.damagePartBy(own[0], part, ship.maxHp[part] * 0.5, -1);
    const was = { x: w.server.lod.where(own[0]).x, y: w.server.lod.where(own[0]).y };
    w.away();
    // Out of the world: nothing of Ashfall's costs a tick
    expect(w.memory.isResident(ash)).toBe(false);
    expect(own.concat(visitor).some((e) => w.bridge.has(e))).toBe(false);
    expect(w.enemies.count(ash)).toBe(0);
    // Ten minutes go by (the world's clock), and a pilot comes back
    w.memory.offset += 60 * 60 * 10;
    w.at('ashfall', 0, 60000, 1);
    expect(w.memory.isResident(ash)).toBe(true);
    const back = w.shipsIn('ashfall').filter((e) => w.enemies.factionOf(e) === 'pirates');
    expect(back.length).toBe(2);
    const raider = back.find((e) => w.enemies.info(e)?.name.startsWith(ship.blueprint.name ?? '') || w.bridge.get(e)!.blueprint.parts.length === ship.blueprint.parts.length)!;
    const hp = w.bridge.get(raider)!.hp[part] / w.bridge.get(raider)!.maxHp[part];
    // Mended by memory.healPerMinute a minute (from half)
    expect(hp).toBeGreaterThan(0.5 + 10 * w.memory.rules.healPerMinute - 0.05);
    expect(hp).toBeLessThan(1);
    // Flown on along its patrol while it was away (not where it was left, not far off its home)
    const now = w.server.lod.where(raider);
    expect(Math.hypot(now.x - was.x, now.y - was.y)).toBeGreaterThan(100);
    expect(Math.hypot(now.x + 20000, now.y + 40000)).toBeLessThan(6000);
  }, 60000);

  it("Sol's freighters and derelicts go with it and come back where they were", () => {
    const w = world();
    w.at('sol', 120000, 0, 2);
    const solFreighters = () => w.server.getTrafficShips().filter((f) => InSystem.systemId[f.eid] === w.num('sol')).length;
    const freighters = solFreighters(), wrecks = (w.server as any).derelicts.filter((d: any) => d.eid >= 0 && d.systemNum === w.num('sol')).length;
    expect(freighters).toBeGreaterThan(0);
    expect(wrecks).toBeGreaterThan(0);
    w.at('ashfall', 0, 60000, w.memory.rules.evictAfterSeconds + 2);
    expect(solFreighters()).toBe(0);
    expect(w.shipsIn('sol').length).toBe(w.shipsIn('sol').filter((e) => (w.server as any).personCraft.has(e) || (w.server as any).wards.has(e)).length);
    w.at('sol', 120000, 0, 1);
    expect(solFreighters()).toBe(freighters);
    expect((w.server as any).derelicts.filter((d: any) => d.eid >= 0 && d.systemNum === w.num('sol')).length).toBe(wrecks);
  }, 60000);

  it('a nest cleared out stays cleared through a restart, while it rebuilds', async () => {
    const { store } = memStore();
    const clock = { t: 1_000_000 };
    const w = world(store, clock);
    const ash = w.num('ashfall');
    const DIG = 'ashfall_dig_cinderjack';
    const near = (ww: typeof w, s: number) => { const n = ww.enemies.nest(ash, DIG)!; ww.at('ashfall', n.x + 20000, n.y, s); };
    w.at('ashfall', 0, 60000, 1);
    near(w, 3);
    const packs = w.enemies.nest(ash, DIG)!.packs;
    expect(packs.length).toBeGreaterThan(0);
    // Every ship of it shot down
    for (const e of packs.flat()) { const s = w.bridge.get(e)!; w.bridge.hurt(e, s, s.blueprint.parts.findIndex((p) => p.fn === 'core'), 1e9, w.pid); }
    near(w, 2);
    expect(w.enemies.nest(ash, DIG)!.packs.length).toBe(0);
    await w.server.saveAll();
    const w2 = world(store, clock);
    w2.at('ashfall', 0, 60000, 1);
    near(w2, 5);
    expect(w2.enemies.nest(ash, DIG)!.packs.length).toBe(0);
  }, 60000);

  it("a pilot at a gate's mouth has where it goes brought back before they're through", () => {
    const w = world();
    const ash = w.num('ashfall');
    w.away();
    w.at('sol', 120000, 0, w.memory.rules.evictAfterSeconds + 2);
    // (Ashfall was left at the start: Sol's pilot never went)
    expect(w.memory.isResident(ash)).toBe(false);
    const gate = (files.systems as any).systems.find((s: any) => s.id === 'sol').portals.find((p: any) => p.targetSystem === 'ashfall').position;
    w.at('sol', gate.x + 1500, gate.y, 1);
    expect(InSystem.systemId[w.pid]).toBe(w.num('sol'));
    expect(w.memory.isResident(ash)).toBe(true);
  }, 60000);
});

describe('world file', () => {
  it('is written whole (swapped in), read back, and one that cannot be read is kept aside for a fresh world', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'world-'));
    try {
      const file = join(dir, 'world', 'memory.json');
      const store = worldFileStore(file);
      expect(store.load()).toBeNull();
      const data: MemoryFile = { version: MEMORY_VERSION, savedAt: 5, worldTick: 9, timers: { enemies: {}, bosses: { boss_rustjaw: 100 } }, systems: {} };
      await store.save(data);
      expect(existsSync(`${file}.tmp`)).toBe(false);
      expect(store.load()).toEqual(data);
      writeFileSync(file, '{"version": 1, "systems": {');
      expect(store.load()).toBeNull();
      expect(readdirSync(join(dir, 'world')).some((f) => f.startsWith('memory.json.bad-'))).toBe(true);
      // A server on that store starts fresh (and says so), then writes a good one
      const w = world(store);
      w.at('sol', 120000, 0, 1);
      await w.server.saveAll();
      expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(MEMORY_VERSION);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});
