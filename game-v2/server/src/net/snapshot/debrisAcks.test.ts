/**
 * Debris a client works out itself (debrisSplit, client ships/debris/DebrisSplits.ts): a piece gone on the server
 * before the client's confirmation arrives still goes to it as removed. The confirmation used to drop the piece from
 * what the client was counted as holding, so its removal never went and the client kept the piece for ever, knocking
 * the pieces round it off their paths.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { readFileSync } from 'fs';
import { Position, Velocity, InSystem, type ReplicaEnv, type ClientMessage, type ServerSnapshotMessage } from '@space-game/common';
import { GameServer } from '../../GameServer.js';
import { GameData } from '../../data/GameData.js';
import { readGameDataFiles } from '../../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../../ships/loadShipConfig.js';
import { createShipBridge } from '../../proto/createProtoServer.js';
import { FakeHitsClient } from '../hits/fakeHitsClient.testkit.js';

const dataDir = join(__dirname, '../../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;

describe('debris a client works out itself', () => {
  it('a piece gone before its confirmation arrives is still removed on the client', () => {
    resetGlobals();
    const clock = { t: 1_000_000 };
    const server = new GameServer({
      gameData: new GameData(readGameDataFiles(dataDir)),
      userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as never,
      scene: 'sectors', autoStart: false,
      ships: createShipBridge(loadShipConfigCached(dataDir)),
      clock: () => clock.t,
    });
    const ships = server.getShips();
    const env = (id: number) => (server.replication as unknown as { host: { env(eid: number): ReplicaEnv } }).host.env(id);
    const A = new FakeHitsClient(server, { name: 'acks', env });
    const step = () => { server.step(); clock.t += 1000 / 60; };
    for (let i = 0; i < 30; i++) step();
    const sys = InSystem.systemId[A.pid];
    const x0 = Position.x[A.pid] + 30000, y0 = Position.y[A.pid] + 30000;
    Position.x[A.pid] = x0; Position.y[A.pid] = y0; Velocity.x[A.pid] = 0; Velocity.y[A.pid] = 0;
    const bp = ships.library.get('hauler') ?? JSON.parse(readFileSync(join(dataDir, 'ships/blueprints/hauler.json'), 'utf8'));
    const hauler = ships.spawnDummy(bp, x0 + 600, y0, 0.3, sys);
    // (Every removal it's sent)
    const removed = new Set<number>();
    const fa = A as unknown as { snapshot(s: ServerSnapshotMessage): void; debris: { takeAcks(): number[] | undefined } };
    const o = fa.snapshot.bind(A);
    fa.snapshot = (s) => { for (const id of s.removed ?? []) removed.add(id); o(s); };
    for (let i = 0; i < 60; i++) step();
    // Parts shot off till a piece breaks away that it works out itself
    const sp = ships.get(hauler)!;
    let acks: number[] | undefined;
    for (let k = 0; k < sp.blueprint.parts.length && !acks; k++) {
      if (!sp.derived.alive[k] || sp.blueprint.parts[k].fn === 'core') continue;
      ships.damagePartFraction(hauler, k, 1);
      for (let i = 0; i < 8 && !acks; i++) { step(); acks = fa.debris.takeAcks(); }
    }
    expect(acks?.length).toBeGreaterThan(0);
    const piece = acks![0];
    expect(A.reps.has(piece)).toBe(true);
    // Gone on the server, then its confirmation arrives before the next snapshot
    ships.removeShip(piece);
    step();
    A.link!.receive({ type: 'input', seq: 1, tick: 0, targetTick: server.getTick() + 1, forward: false, backward: false, left: false, right: false, boost: false, fireLeft: false, fireRight: false, targetAngle: 0, acks } as unknown as ClientMessage);
    for (let i = 0; i < 12; i++) step();
    expect(ships.has(piece)).toBe(false);
    expect(removed.has(piece)).toBe(true);
    expect(A.reps.has(piece)).toBe(false);
  });
});
