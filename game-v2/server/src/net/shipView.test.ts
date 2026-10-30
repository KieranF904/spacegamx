import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Position, Velocity, InSystem, ServerMessage } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from './LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';

const dataDir = join(__dirname, '../../../data');

describe('ships in and out of view', () => {
  it('a ship that left your view is synced afresh when you come back to it (never an invisible hull)', () => {
    (bitecs as unknown as { resetGlobals: () => void }).resetGlobals();
    const server = new GameServer({
      gameData: new GameData(readGameDataFiles(dataDir)), userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as any,
      scene: 'sectors', autoStart: false, ships: createShipBridge(loadShipConfigFromDisk(dataDir)),
    });
    const t = new LocalTransport(server);
    const got: ServerMessage[] = [];
    t.onMessage = (m) => got.push(m);
    t.connect();
    t.send({ type: 'join', username: 'salvager' } as any);
    const pid = t.getPlayerId();
    // A derelict in Sol
    const wreck = (server as any).derelicts.find((d: any) => d.eid >= 0 && InSystem.systemId[d.eid] === InSystem.systemId[pid]);
    expect(wreck).toBeTruthy();
    const at = (x: number, y: number, ticks: number) => { for (let i = 0; i < ticks; i++) { Position.x[pid] = x; Position.y[pid] = y; Velocity.x[pid] = Velocity.y[pid] = 0; server.step(); } };
    const synced = () => got.some((m) => m.type === 'shipSync' && (m as any).id === wreck.eid);
    const wx = Position.x[wreck.eid], wy = Position.y[wreck.eid];
    at(wx + 3000, wy, 30);
    expect(synced()).toBe(true);
    // Far out of view, long enough for the client to forget it
    at(wx + 120000, wy, 30);
    got.length = 0;
    // Back beside it: its structure comes again
    at(wx + 3000, wy, 30);
    expect(synced()).toBe(true);
  });
});
