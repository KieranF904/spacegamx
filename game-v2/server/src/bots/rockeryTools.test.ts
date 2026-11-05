import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { TICK_RATE, Position, type ServerMessage } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';
import { BotManager } from './index.js';
import { installRockeryTools } from './rockeryTools.js';

const dataDir = join(__dirname, '../../../data');

describe('Rockery spawn tools (/rockery)', () => {
  it('spawns drones, a still dummy and random-flight bot players beside the asker, and clears them', () => {
    (bitecs as unknown as { resetGlobals: () => void }).resetGlobals();
    const clock = { t: 1_000_000 };
    const server = new GameServer({
      gameData: new GameData(readGameDataFiles(dataDir)), userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as never,
      scene: 'sectors', autoStart: false, devTeleport: true, guestAdmin: true, ships: createShipBridge(loadShipConfigFromDisk(dataDir)), clock: () => clock.t,
    } as never);
    const step = (secs: number) => { for (let i = 0; i < secs * TICK_RATE; i++) { clock.t += 1000 / TICK_RATE; server.step(); } };
    const mgr = new BotManager(server, { log: () => {} });
    const tools = installRockeryTools(server, mgr);
    const t = new LocalTransport(server);
    const said: string[] = [];
    t.onMessage = (m: ServerMessage) => { if ((m as { type: string }).type === 'adminResult') said.push((m as unknown as { text: string }).text); };
    t.connect();
    t.send({ type: 'join', username: 'watcher' } as never);
    step(1);
    const say = (text: string) => { t.send({ type: 'chat', text } as never); step(0.1); return said[said.length - 1]; };

    expect(say('/rockery drones 3')).toMatch(/3 Helios drone/);
    expect(say('/rockery dummy')).toMatch(/Still dummy/);
    expect(tools.dummies).toHaveLength(1);
    expect(say('/rockery bots 2 twitchy shoot')).toMatch(/2 bot player/);
    expect(tools.bots).toHaveLength(2);
    expect(say('/rockery bots 3')).toMatch(/At most 4/);
    const e = tools.bots[0].driver.eid, x0 = Position.x[e], y0 = Position.y[e];
    step(10);
    expect(Math.hypot(Position.x[e] - x0, Position.y[e] - y0)).toBeGreaterThan(5);
    expect(say('/rockery clear')).toMatch(/Cleared 2 bot\(s\), 1 dummy/);
    expect(tools.bots).toHaveLength(0);
    expect(mgr.bots).toHaveLength(0);
  }, 60_000);
});
