/**
 * Hostiles of one faction bump without hurting each other (common hitRules.ts contactHurts, GameServer's bridge host):
 * two packmates driven into each other are pushed apart as any two ships are, and take no damage of it; ships of two
 * factions driven together the same way are hurt as ever.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Position, Velocity, contactHurts } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from './loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';
import { makeServer } from '../testkits/world.testkit.js';

const dataDir = join(__dirname, '../../../data');
const files = readGameDataFiles(dataDir);
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;

/** Two ships (each the first of a pack of its faction) set 180 apart and driven at each other, for `ticks` */
function ram(a: { faction: string; ship: string }, b: { faction: string; ship: string }, ticks = 20) {
  resetGlobals();
  const server = makeServer({ clock: () => 0 });
  const ships = server.getShips(), num = server.gameData.getSystemNum('sol');
  const x0 = 140000, y0 = 140000;
  const [ea] = server.enemies.spawnPack(num, { faction: a.faction, ships: [a.ship] } as never, x0, y0);
  const [eb] = server.enemies.spawnPack(num, { faction: b.faction, ships: [b.ship] } as never, x0 + 180, y0);
  const hp = () => [ea, eb].map((e) => ships.get(e)!.hp.reduce((s, h) => s + h, 0));
  for (const [e, x, v] of [[ea, x0, 14], [eb, x0 + 180, -14]] as const) { Position.x[e] = x; Position.y[e] = y0; Velocity.x[e] = v; Velocity.y[e] = 0; }
  const before = hp();
  let apart = false;
  for (let t = 0; t < ticks; t++) {
    server.step();
    if (Velocity.x[ea] < 0 || Velocity.x[eb] > 0) apart = true;
  }
  return { before, after: hp(), apart };
}

describe('collisions between hostiles (hitRules.ts contactHurts)', () => {
  it('the rule: no harm between hostiles of one faction; anything else as ever', () => {
    expect(contactHurts('scrapborn', 'scrapborn')).toBe(false);
    expect(contactHurts('scrapborn', 'pirates')).toBe(true);
    expect(contactHurts(undefined, 'scrapborn')).toBe(true);
    expect(contactHurts(undefined, undefined)).toBe(true);
  });

  it('two of one faction driven together bounce apart unhurt; two of two factions are hurt', () => {
    const same = ram({ faction: 'scrapborn', ship: 'scrap_darter' }, { faction: 'scrapborn', ship: 'scrap_darter' });
    expect(same.apart).toBe(true);
    expect(same.after).toEqual(same.before);
    const two = ram({ faction: 'scrapborn', ship: 'scrap_darter' }, { faction: 'pirates', ship: 'pirate_raider' });
    expect(two.apart).toBe(true);
    expect(two.after[0] + two.after[1]).toBeLessThan(two.before[0] + two.before[1]);
  }, 120_000);
});
