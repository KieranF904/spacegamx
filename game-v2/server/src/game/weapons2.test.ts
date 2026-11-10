import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Input, InSystem, Position, Velocity, isWeaponFn, ServerMessage, replicaAngle, quantizeReplicaAngle, ReplicaMode } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../ships/createShipBridge.js';
import { MemoryProfileStore } from '../profile/ProfileStore.js';
import { makeEmptyServer } from '../testkits/world.testkit.js';

const dataDir = join(__dirname, '../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);

describe('arc projector', () => {
  it('lightning leaps from the ship it hits to others nearby', () => {
    resetGlobals();
    const server = makeEmptyServer({ profileStore: new MemoryProfileStore() });
    const t = new LocalTransport(server);
    const got: ServerMessage[] = [];
    t.onMessage = (m) => got.push(m);
    t.connect();
    t.send({ type: 'join', username: 'pilot' } as any);
    const pid = t.getPlayerId(), conn = server.pilots.connOf(pid)!;
    const p = server.pilots.get(conn)!;
    for (const q of p.ship.blueprint.parts) if (isWeaponFn(q.fn)) q.fn = 'arc';
    server.pilots.reapplyShip(conn);
    Position.x[pid] = 25000; Position.y[pid] = 20000;
    server.enemies.spawnPack(InSystem.systemId[pid], { faction: 'pirates', ships: ['pirate_skiff', 'pirate_skiff', 'pirate_skiff'] }, 25450, 20000);
    // Bunched up, so the lightning has somewhere to go
    const pack = [...server.getShips().bodies.keys()].filter((e) => e !== pid);
    for (let i = 0; i < 60 * 6; i++) {
      Position.x[pid] = 25000; Position.y[pid] = 20000; Velocity.x[pid] = 0; Velocity.y[pid] = 0;
      pack.forEach((e, k) => { Position.x[e] = 25450 + k * 60; Position.y[e] = 20000 + k * 40; Velocity.x[e] = 0; Velocity.y[e] = 0; });
      Input.fireLeft[pid] = 1;
      Input.targetAngle[pid] = replicaAngle(ReplicaMode.Player, quantizeReplicaAngle(0));
      server.step();
      if (got.some((m) => m.type === 'detonation' && (m as any).kind === 'arc' && (m as any).from)) break;
    }
    const arcs = got.filter((m) => m.type === 'detonation' && (m as any).kind === 'arc' && (m as any).from) as any[];
    expect(arcs.length).toBeGreaterThan(0);
    expect(arcs[0].from).toHaveLength(2);
  });
});

describe('mortar', () => {
  it('lobs a shell over everything to burst where it was aimed', () => {
    resetGlobals();
    const server = makeEmptyServer({ profileStore: new MemoryProfileStore() });
    const t = new LocalTransport(server);
    const got: ServerMessage[] = [];
    t.onMessage = (m) => got.push(m);
    t.connect();
    t.send({ type: 'join', username: 'pilot' } as any);
    const pid = t.getPlayerId(), conn = server.pilots.connOf(pid)!;
    const p = server.pilots.get(conn)!;
    for (const q of p.ship.blueprint.parts) if (isWeaponFn(q.fn)) q.fn = 'mortar';
    server.pilots.reapplyShip(conn);
    p.cargo.push({ id: 'mortar_shells', n: 1 });
    for (let i = 0; i < 60 * 4; i++) {
      Position.x[pid] = 25000; Position.y[pid] = 20000; Velocity.x[pid] = 0; Velocity.y[pid] = 0;
      Input.fireLeft[pid] = 1; Input.cursorDist[pid] = 900;
      Input.targetAngle[pid] = replicaAngle(ReplicaMode.Player, quantizeReplicaAngle(0));
      server.step();
      if (got.some((m) => m.type === 'detonation' && (m as any).kind === 'mortar')) break;
    }
    const boom = got.find((m) => m.type === 'detonation' && (m as any).kind === 'mortar') as any;
    expect(boom).toBeTruthy();
    expect(Math.hypot(boom.x - 25000, boom.y - 20000)).toBeGreaterThan(600);
    expect(Math.hypot(boom.x - 25000, boom.y - 20000)).toBeLessThan(1200);
  });
});
