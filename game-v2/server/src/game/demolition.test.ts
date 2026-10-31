/**
 * The Demolition Launcher's charge (tuning weapons.charge.stick): it sticks to the rock it meets, hurts nothing for a second
 * (60 ticks), then blows and the rock takes its damage.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Asteroid, Position, Velocity, InSystem, Dead } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';

const dataDir = join(__dirname, '../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);

describe('Demolition Launcher charge', () => {
  it('sticks to rock, waits 60 ticks, then blows', () => {
    resetGlobals();
    const server = new GameServer({
      gameData: new GameData(files),
      userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as any,
      scene: 'sectors',
      autoStart: false,
      ships: createShipBridge(loadShipConfigFromDisk(dataDir)),
    });
    const t = new LocalTransport(server);
    t.connect();
    t.send({ type: 'join', username: 'blaster' } as any);
    const pid = t.getPlayerId();
    const s = server as any;
    const num = server['gameData'].getSystemNum('sol_scrap_nest');
    InSystem.systemId[pid] = num;
    Position.x[pid] = 0; Position.y[pid] = 18000;
    server.step(); server.step();
    const eid = (s.asteroidIdsBySystem.get(num) as number[])[0];
    s.placeAsteroid(eid);
    const rx = Position.x[eid], ry = Position.y[eid], size = Asteroid.size[eid];
    // Out of the rock's west side, flying east at its centre
    const startX = rx - size - 60, startY = ry;
    Position.x[pid] = startX - 300; Position.y[pid] = startY; Velocity.x[pid] = 0; Velocity.y[pid] = 0;
    const hp = Asteroid.hp[eid];
    const shell = s.weapons.spawn(pid, 'charge', startX, startY, 0, 1, { speedScale: 1, sizeScale: 1, turret: false, noBurst: true }) as number;
    expect(s.weapons.stickTicks(shell)).toBe(60);
    let stuckAt = -1;
    for (let k = 0; k < 40 && stuckAt < 0; k++) {
      server.step();
      if (s.stuckShots.has(shell)) stuckAt = k;
    }
    expect(stuckAt).toBeGreaterThanOrEqual(0);
    expect(Velocity.x[shell]).toBe(0);
    // Stuck: the rock is untouched until the fuse runs out
    for (let k = 0; k < 50; k++) server.step();
    expect(Asteroid.hp[eid]).toBe(hp);
    expect(bitecs.hasComponent(server.world, Dead, shell)).toBe(false);
    for (let k = 0; k < 15; k++) server.step();
    expect(Asteroid.hp[eid]).toBeLessThan(hp);
    expect(s.stuckShots.has(shell)).toBe(false);
  });
});
