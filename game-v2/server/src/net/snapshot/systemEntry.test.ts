import { describe, it, expect } from 'vitest';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createWorld, addEntity } from 'bitecs';
import { unpackChunks, registerRockTypes, type MiningTable, type ServerMessage, type ServerAsteroidSeedMessage, type ServerAsteroidSpawnMessage } from '@space-game/common';
import { readGameDataFiles } from '../../data/loadGameDataFromDisk.js';
import { Mining, type MiningHost } from '../../game/Mining.js';
import { PayoutDice } from '../../game/payoutDice.js';
import { enterSystem, type EntryHost } from './systemEntry.js';
import type { ClientConnection } from '../ClientConnection.js';

const table = readGameDataFiles(join(dirname(fileURLToPath(import.meta.url)), '../../../../data')).mining as unknown as MiningTable;
registerRockTypes(table);

const ME = 7, THEM = 8;

/** A system with one belt rock (`belt`) and one grown back (`regrown`), a Mining over both, and what entering sends */
function system(withBelt = true) {
  const world = createWorld();
  const belt = addEntity(world), regrown = addEntity(world);
  let tick = 0;
  const host: MiningHost = { spawnChunk: () => {}, awardXp: () => {}, notify: () => {}, tick: () => tick, respawn: () => {}, crumble: () => {}, rockTier: () => 1 };
  const mining = new Mining(host, table, new PayoutDice('entry-test'));
  mining.register(belt, 0, 3, 'asteroid_metal', 'sol:3:0', 1e5, 1);
  mining.register(regrown, 0, 4, 'asteroid_metal', 'sol:4:900', 1e5, 1);
  const enter = (miner: number): ServerMessage[] => {
    const sent: ServerMessage[] = [];
    const h = {
      world, scene: 'sectors', crowd: null, ticks: { currentTick: 5000 },
      gameData: { getSystemByNum: () => ({ id: 'sol', ...(withBelt ? { asteroidBelt: { innerRadius: 1000, outerRadius: 2000, count: 1 } } : {}) }) },
      events: { briefing: () => [] }, surfaces: { briefing: () => [] }, focus: { reset: () => {} }, away: { reset: () => {} },
      asteroidIdsBySystem: new Map([[0, withBelt ? [belt, regrown] : [regrown]]]), asteroidSeedTickBySystem: new Map([[0, 0]]),
      asteroidIndexById: new Map([[belt, 3], [regrown, 4]]), respawnedAsteroids: new Set([regrown]),
      send: (_ws: unknown, m: ServerMessage) => { sent.push(m); },
      asteroidSpawnData: (eid: number) => ({ id: eid }),
      mineState: (m: number, num: number) => mining.partWorked(m, num),
    } as unknown as EntryHost;
    const conn = {
      ws: {}, playerId: miner, knownEntities: new Set(), shipSynced: new Map(), shipHpSent: new Map(), sentNames: new Map(), repKnown: new Map(),
      shipView: new Set(), mapNamed: new Set(), mapSent: new Map(),
    } as unknown as ClientConnection;
    enterSystem(h, conn, 0);
    return sent;
  };
  const work = (rock: number, miner: number, hits: number): void => {
    for (let k = 0; k < hits; k++) { tick += 15; mining.extract(rock, miner, 28, { yield: table.tools.fixed.yield, hardness: 1 }, 0, 0, 1, 0); }
  };
  return { mining, belt, regrown, enter, work };
}

describe('entering a system: your part-worked mining chunks, told once', () => {
  it('ride on the asteroid seed (4 numbers a rock, ~20 B each as JSON), exactly where the server is, and on nothing else', () => {
    const s = system();
    s.work(s.belt, ME, 37);
    s.work(s.regrown, ME, 11);
    s.work(s.belt, THEM, 50);
    const sent = s.enter(ME);
    const seed = sent.find((m) => m.type === 'asteroidSeed') as ServerAsteroidSeedMessage;
    const spawn = sent.find((m) => m.type === 'asteroidSpawn') as ServerAsteroidSpawnMessage;
    expect(seed.mine).toHaveLength(8);
    expect(spawn.mine).toBeUndefined();
    const told = unpackChunks(JSON.parse(JSON.stringify(seed.mine)));
    expect(told.get(s.belt)).toEqual(s.mining.chunkOf(s.belt, ME));
    expect(told.get(s.regrown)).toEqual(s.mining.chunkOf(s.regrown, ME));
    expect(JSON.stringify({ mine: seed.mine }).length).toBeLessThan(90);
  });

  it('a system with no belt seed: on its regrown rocks\' spawn instead', () => {
    const s = system(false);
    s.work(s.regrown, ME, 9);
    const sent = s.enter(ME);
    expect(sent.some((m) => m.type === 'asteroidSeed')).toBe(false);
    const spawn = sent.find((m) => m.type === 'asteroidSpawn') as ServerAsteroidSpawnMessage;
    expect(unpackChunks(spawn.mine!).get(s.regrown)).toEqual(s.mining.chunkOf(s.regrown, ME));
  });

  it('nothing worked (or only by others): no `mine` at all', () => {
    const s = system();
    s.work(s.belt, THEM, 20);
    const seed = s.enter(ME).find((m) => m.type === 'asteroidSeed') as ServerAsteroidSeedMessage;
    expect('mine' in seed).toBe(false);
  });
});
