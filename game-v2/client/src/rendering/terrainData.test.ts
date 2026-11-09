/** The client's terrain (terrainData.ts) is the server's, piece for piece: the gun range's walls collide alike on both sides. */

import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { terrainFor, gunRangeFor } from './terrainData';
import { GameData } from '../../../server/src/data/GameData';
import { readGameDataFiles } from '../../../server/src/data/loadGameDataFromDisk';

describe('client terrain', () => {
  it('the gun range: its chamber and walls, exactly the server\'s', () => {
    const server = new GameData(readGameDataFiles(join(__dirname, '../../../data')));
    expect(gunRangeFor('gun_range')).toEqual(server.getSystem('gun_range')!.gunRange);
    const c = terrainFor('gun_range')!, s = server.terrain('gun_range')!;
    expect(c.pieces.length).toBe(4);
    expect(c.pieces).toEqual(s.pieces);
    expect(gunRangeFor('sol')).toBeNull();
  });
});
