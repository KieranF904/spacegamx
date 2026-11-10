/**
 * Rifts pull in any ship that flies into one. Coming out beside the rift back
 * (or drifting into it), you aren't pulled straight back through: not until
 * you've been clear of it a moment, however long you sit in it.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Position, Velocity, InSystem } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';
import { makeServer } from '../testkits/world.testkit.js';

const dataDir = join(__dirname, '../../../data');
const files = readGameDataFiles(dataDir);

describe('rifts', () => {
  it("don't bounce you straight back, however long you sit in the rift you came out by", () => {
    (bitecs as unknown as { resetGlobals: () => void }).resetGlobals();
    const server = makeServer();
    const t = new LocalTransport(server);
    t.connect();
    t.send({ type: 'join', username: 'drifter' } as any);
    const pid = t.getPlayerId(), conn = server.pilots.connOf(pid)! as any;
    const systems = (files.systems as any).systems as any[];
    const borealis = systems.find((s) => s.id === 'borealis').rifts[0], nebula = systems.find((s) => s.id === 'nebula_prime').rifts.find((r: any) => r.destination.system === 'borealis');
    const num = (id: string) => server.gameData.getSystemNum(id);
    // (Licensed for everywhere)
    (server as any).quests.canEnter = () => null;
    const hold = (x: number, y: number, ticks: number) => {
      for (let i = 0; i < ticks; i++) { Position.x[pid] = x; Position.y[pid] = y; Velocity.x[pid] = Velocity.y[pid] = 0; server.step(); }
    };
    (server as any).travelTo(conn, num('borealis'), borealis.position.x, borealis.position.y, false);
    hold(borealis.position.x, borealis.position.y, 3);
    expect(InSystem.systemId[pid]).toBe(num('nebula_prime'));
    // Sitting in the rift back, well past the cooldown: still here
    hold(nebula.position.x, nebula.position.y, 400);
    expect(InSystem.systemId[pid]).toBe(num('nebula_prime'));
    // Out of it a moment, then back in: through you go
    hold(nebula.position.x + 3000, nebula.position.y, 60);
    hold(nebula.position.x, nebula.position.y, 3);
    expect(InSystem.systemId[pid]).toBe(num('borealis'));
  });
});
