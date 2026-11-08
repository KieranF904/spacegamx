import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { TICK_RATE } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';
import { BotManager } from './index.js';
import type { ClientDriver } from './drivers/clientDriver.js';

const dataDir = join(__dirname, '../../../data');

function world() {
  (bitecs as unknown as { resetGlobals: () => void }).resetGlobals();
  const clock = { t: 1_000_000 };
  const server = new GameServer({
    gameData: new GameData(readGameDataFiles(dataDir)), userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as never,
    scene: 'sectors', autoStart: false, devTeleport: true, guestAdmin: true, ships: createShipBridge(loadShipConfigCached(dataDir)), clock: () => clock.t,
  } as never);
  const step = (secs: number) => { for (let i = 0; i < secs * TICK_RATE; i++) { clock.t += 1000 / TICK_RATE; server.step(); } };
  return { server, step };
}

describe('player bots on a test server', () => {
  it('the client-input bot flies one full trip: dock, wait, undock, mine, collect, return, deposit', () => {
    const { server, step } = world();
    const mgr = new BotManager(server, { log: () => {} });
    const bot = mgr.spawn('mine-and-deposit', 'client', { collectWait: 3 });
    // (A real pilot: its ship is the library Prospector, in god mode, and it joined as any player does)
    expect(server.getShips().get(bot.driver.eid)!.blueprint.name).toBe('Prospector');
    expect(server.admin.isGod(bot.driver.eid)).toBe(true);
    const total = () => server.pilots.get((bot.driver as ClientDriver).connection)!.storage.reduce((n, x) => n + x.n, 0);
    const stored0 = total();
    // (An ordinary ship to a real player on the same server)
    const t = new LocalTransport(server);
    t.connect();
    t.send({ type: 'join', username: 'watcher' } as never);
    step(200);
    const s = bot.stats.summary();
    expect(s.trips).toBeGreaterThanOrEqual(1);
    expect(s.oreDeposited).toBeGreaterThan(40);
    expect(s.oreCollected).toBe(s.oreMined);
    expect(s.seconds.docked / s.trips).toBeGreaterThanOrEqual(10);
    expect(s.seconds.mining).toBeGreaterThan(20);
    expect(s.seconds.travelOut).toBeGreaterThan(2);
    expect(s.seconds.travelBack).toBeGreaterThan(1);
    // (Stored at the station through the real message: the ore deposited is in storage)
    expect(total() - stored0).toBe(s.oreDeposited);
    // (Short of power: the Prospector runs its laser on its reactors, no brownout expected)
    expect(s.brownoutSeconds).toBe(0);
    mgr.stop();
  }, 120_000);

  it('the server-NPC bot runs the same task with no connection, and a player is told about its ship', () => {
    const { server, step } = world();
    const mgr = new BotManager(server, { log: () => {} });
    const bot = mgr.spawn('mine-and-deposit', 'npc', { collectWait: 3 });
    const t = new LocalTransport(server);
    t.connect();
    t.send({ type: 'join', username: 'watcher' } as never);
    expect(server.clients.size).toBe(1);
    step(5);
    // (The watcher is in the same system beside it: the NPC's ship is among the ships the server replicates to it)
    const watcher = server.pilots.connOf(t.getPlayerId()) as unknown as { repKnown: Map<number, unknown>; shipView: Set<number> };
    expect(watcher.repKnown.has(bot.driver.eid)).toBe(true);
    step(195);
    const s = bot.stats.summary();
    expect(s.trips).toBeGreaterThanOrEqual(1);
    expect(s.oreDeposited).toBeGreaterThan(40);
    expect(s.oreCollected).toBe(s.oreMined);
    expect((bot.driver as unknown as { stored: Record<string, number> }).stored).toBeTruthy();
    expect(server.getShips().has(bot.driver.eid)).toBe(true);
    mgr.stop();
    expect(server.getShips().has(bot.driver.eid)).toBe(false);
  }, 120_000);

  it('/bot works for an admin in chat, and never exists in production', () => {
    const { server, step } = world();
    const mgr = new BotManager(server, { log: () => {} });
    const t = new LocalTransport(server);
    t.connect();
    t.send({ type: 'join', username: 'dev' } as never);
    t.send({ type: 'chat', text: '/bot spawn mine-and-deposit 2 npc' } as never);
    step(1);
    expect(mgr.bots).toHaveLength(2);
    expect(mgr.list()).toContain('mine-and-deposit (npc)');
    t.send({ type: 'chat', text: '/bot stop all' } as never);
    expect(mgr.bots).toHaveLength(0);
    const was = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => new BotManager(server)).toThrow(/production/);
      expect(() => mgr.spawn('mine-and-deposit', 'npc')).toThrow(/production/);
    } finally {
      process.env.NODE_ENV = was;
    }
  }, 60_000);
});
