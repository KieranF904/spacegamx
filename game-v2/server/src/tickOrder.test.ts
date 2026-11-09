/**
 * The tick table (tickOrder.ts, built by GameServer.buildTickSystems) is frozen here: names, phases and gates in
 * order. Reordering, regating or regrouping a system is a simulation change and must be done on purpose, here and
 * in golden/tickOrder.json (which pins the guard names an actual tick runs).
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { GameServer } from './GameServer.js';
import { GameData } from './data/GameData.js';
import { readGameDataFiles } from './data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from './ships/loadShipConfig.js';
import { createShipBridge } from './proto/createProtoServer.js';
import { checkTickOrder, type TickSystem } from './tickOrder.js';

const dataDir = join(__dirname, '../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;

const FROZEN: [name: string, phase: string, gate?: string][] = [
  ['stationOrbitSystem', 'pilots-move'],
  ['memory', 'pilots-move', 'sectors'],
  ['spatialGrid', 'pilots-move'],
  ['playerMovementSystem', 'pilots-move'],
  ['towing', 'pilots-move'],
  ['dockingSystem', 'pilots-move'],
  ['riftSystem', 'pilots-move'],
  ['weaponSystem', 'combat'],
  ['projectileSystem', 'combat'],
  ['enemies', 'combat', 'sectors'],
  ['bosses', 'combat', 'sectors'],
  ['mobs', 'combat', 'sectors'],
  ['events', 'combat', 'sectors'],
  ['surfaces', 'combat', 'sectors'],
  ['sieges', 'combat', 'sectors'],
  ['arenas', 'combat', 'sectors'],
  ['collisionSystem', 'combat'],
  ['asteroidDeathSystem', 'combat'],
  ['lod', 'combat'],
  ['ships', 'combat'],
  ['replication.endTick', 'combat'],
  ['recordSelfHashes', 'combat'],
  ['pods', 'world'],
  ['mining', 'world'],
  ['hazards', 'world'],
  ['warmth', 'world'],
  ['homes', 'world'],
  ['tutorial', 'world'],
  // (The gun range, 2026-11-09: only while anyone is in it, or its target stands: game/gunRange)
  ['gunRange', 'world'],
  ['watchComet', 'world'],
  ['outpost', 'world', 'every60 perClient'],
  ['pilots', 'world'],
  ['quests', 'world'],
  ['codex', 'world'],
  ['party', 'world'],
  ['trade', 'world'],
  ['achievements', 'world', 'every60 perClient'],
  ['ops', 'world', 'sectors'],
  ['services', 'world', 'every60 perClient'],
  ['lingerSystem', 'persist'],
  ['derelictRespawnSystem', 'persist'],
  ['trafficSystem', 'persist'],
  ['lifetimeSystem', 'persist'],
  ['cleanupSystem', 'persist'],
];

describe('tick order table', () => {
  it('is frozen: names, phases and gates in order', () => {
    resetGlobals();
    const server = new GameServer({
      gameData: new GameData(readGameDataFiles(dataDir)),
      userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as any,
      scene: 'sectors',
      autoStart: false,
      ships: createShipBridge(loadShipConfigCached(dataDir)),
      clock: () => 1_000_000,
    });
    const got = server.tickSystemList().map((s) => {
      const gate = [s.scene, s.every ? `every${s.every}` : '', s.perClient ? 'perClient' : ''].filter(Boolean).join(' ');
      return gate ? [s.name, s.phase, gate] : [s.name, s.phase];
    });
    expect(got).toEqual(FROZEN);
  }, 120_000);

  it('checkTickOrder rejects phase disorder and duplicate names', () => {
    const run = () => {};
    const ok: TickSystem[] = [{ name: 'a', phase: 'pilots-move', run }, { name: 'b', phase: 'persist', run }];
    expect(() => checkTickOrder(ok)).not.toThrow();
    expect(() => checkTickOrder([{ name: 'a', phase: 'world', run }, { name: 'b', phase: 'combat', run }])).toThrow(/phase order/);
    expect(() => checkTickOrder([{ name: 'a', phase: 'world', run }, { name: 'a', phase: 'world', run }])).toThrow(/twice/);
  });
});
