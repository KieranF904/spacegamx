import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { createShipState, seededRng, splitRebuild } from '@space-game/common';
import { GameData } from '../data/GameData.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { makeEmptyServer } from '../testkits/world.testkit.js';

const dataDir = join(__dirname, '../../../data');

/**
 * A wreck (bridge/rebuild.ts spawnWreck) starts as a copy of its design's as-built state, not one worked out afresh: it
 * must be the same ship a fresh build (createShipState) given the same damage and rebuild makes, and share nothing
 * changeable with the as-built one or another wreck
 */
describe('wrecks', () => {
  it('a wreck is the ship a fresh build with its damage would be, however many of its design came first', () => {
    (bitecs as unknown as { resetGlobals: () => void }).resetGlobals();
    const server = makeEmptyServer({ gameData: new GameData(readGameDataFiles(dataDir)), userDB: {} as any });
    const ships = server.getShips();
    const designs = ['hauler', 'halberd', 'wisp'].filter((id) => ships.library.has(id));
    expect(designs.length).toBeGreaterThan(0);
    for (const id of designs) {
      const bp = ships.library.get(id)!;
      const made: number[] = [];
      for (let k = 0; k < 3; k++) {
        const seed = 1234 + k;
        const eid = ships.spawnWreck(bp, 1000 * k, 50000, 0.3, 0, seed);
        made.push(eid);
        const wreck = ships.get(eid)!;
        // (The same damage, the same way: spawnWreck's)
        const ref = createShipState(ships.catalog, ships.tuning, eid, bp, wreck.spawnTick);
        const rng = seededRng(seed);
        ref.blueprint.parts.forEach((p, i) => {
          if (p.fn === 'core') return;
          const r = rng();
          if (r < 0.07) ref.hp[i] = 0;
          else if (r < 0.55) ref.hp[i] = ref.maxHp[i] * (0.2 + 0.55 * rng());
        });
        ref.dirty = true;
        splitRebuild(ref, ships.catalog, ships.tuning);
        ref.angVel = (rng() - 0.5) * 0.0006;
        expect(wreck).toEqual(ref);
      }
      // Nothing shared to change: one wreck's HP and guns are its own
      const [a, b] = made.map((e) => ships.get(e)!);
      for (const k of ['hp', 'maxHp', 'rebuildHp', 'detached', 'ghost', 'cooldown', 'aim', 'rounds', 'reload', 'charge', 'spin'] as const) {
        expect(a[k]).not.toBe(b[k]);
      }
    }
  });
});
