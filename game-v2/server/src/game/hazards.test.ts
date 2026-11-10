import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { InSystem, Position, ServerMessage } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../ships/createShipBridge.js';
import { MemoryProfileStore } from '../profile/ProfileStore.js';

const dataDir = join(__dirname, '../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
// (The void's own Wraith packs are always out now, pre-placed round their knots: the one near enough kills the pilot
// before the test is done, and a dead ship isn't short of anything. This is about the hazard, so the void is empty)
const files = readGameDataFiles(dataDir);
(files.factions as any).spawns.void_sector.nests = [];

describe('hazards', () => {
  it("a ship short of a system's radiation wears down, and its pilot is told what and why", () => {
    resetGlobals();
    const gameData = new GameData(files);
    const server = new GameServer({ profileStore: new MemoryProfileStore(), gameData,
      userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as any,
      scene: 'sectors', autoStart: false, ships: createShipBridge(loadShipConfigCached(dataDir)) });
    const t = new LocalTransport(server);
    const got: ServerMessage[] = [];
    t.onMessage = (m) => got.push(m);
    t.connect();
    t.send({ type: 'join', username: 'pilot' } as any);
    const pid = t.getPlayerId();
    const ships = server.getShips();
    const hp0 = ships.get(pid)!.hp.reduce((a, b) => a + b, 0);
    const voidNum = gameData.getSystemByNum ? [...Array(30).keys()].find((n) => gameData.getSystemByNum(n)?.id === 'void_sector')! : -1;
    for (let i = 0; i < 60 * 5; i++) {
      InSystem.systemId[pid] = voidNum; Position.x[pid] = 30000; Position.y[pid] = 30000;
      server.step();
    }
    const hazards = (server as any).hazards;
    expect(hazards.deficit(pid).radiation).toBeGreaterThan(4);
    expect(ships.get(pid)!.hp.reduce((a, b) => a + b, 0)).toBeLessThan(hp0);
    expect(got.some((m) => m.type === 'toast' && /Radiation 5 against your 0\.0/.test((m as any).text))).toBe(true);
  });
});
