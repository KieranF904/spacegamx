import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Position, Velocity, InSystem, ServerMessage, gradeReward } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';

const dataDir = join(__dirname, '../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);

describe('kill pay by grade', () => {
  it('kill credits rise with grade (never an inversion), and XP still scales by gradeReward', () => {
    const rules = (files as any).factions.rules;
    const gc: number[] = rules.gradeCredits;
    expect(gc).toHaveLength(5);
    for (let g = 1; g < 5; g++) expect(gc[g]).toBeGreaterThan(gc[g - 1]);
    // A Mk I kill still pays well over its ship's credits (fighting in Sol earns about what mining there does)
    expect(gc[0]).toBeGreaterThanOrEqual(5);
    const bridge = createShipBridge(loadShipConfigCached(dataDir));
    const xp = [1, 2, 3, 4, 5].map((g) => gradeReward(bridge.catalog, g));
    for (let g = 1; g < 5; g++) expect(xp[g]).toBeGreaterThan(xp[g - 1]);
  });

  it('a Mk I kill in Sol pays its credits × gradeCredits[0]', () => {
    resetGlobals();
    const server = new GameServer({
      gameData: new GameData(files),
      userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as any,
      scene: 'sectors', autoStart: false, ships: createShipBridge(loadShipConfigCached(dataDir)),
    });
    const t = new LocalTransport(server);
    const got: ServerMessage[] = [];
    t.onMessage = (m) => got.push(m);
    t.connect();
    t.send({ type: 'join', username: 'hunter' } as any);
    const pid = t.getPlayerId();
    Position.x[pid] = 30000; Position.y[pid] = 30000; Velocity.x[pid] = 0; Velocity.y[pid] = 0;
    const bridge = server.getShips();
    const [foe] = server.enemies.spawnPack(InSystem.systemId[pid], { faction: 'pirates', ships: ['pirate_skiff'] }, 30000, 28500);
    (bridge as any).lastHitBy.set(foe, pid);
    bridge.damagePartFraction(foe, bridge.get(foe)!.blueprint.parts.findIndex((p) => p.fn === 'core'), 1);
    for (let i = 0; i < 3; i++) server.step();
    const gain = got.find((m) => m.type === 'gained' && String((m as any).source).startsWith('kill:')) as any;
    const f = (files as any).factions;
    const base = f.factions.pirates.ships.pirate_skiff.credits * f.rules.gradeCredits[(f.spawns.sol.grade ?? 1) - 1];
    // Elites pay double
    expect([base, base * f.rules.eliteLoot].map(Math.round)).toContain(Math.round(gain.credits));
  });
});
