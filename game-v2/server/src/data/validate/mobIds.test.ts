import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { MOB_IDS } from '@space-game/common';
import { readGameDataFiles } from '../loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../../ships/loadShipConfig.js';
import { validateGameData } from '../validateGameData.js';
import type { GameDataFiles } from '../GameData.js';

const dataDir = join(__dirname, '../../../../data');
const files = readGameDataFiles(dataDir);
const ships = loadShipConfigCached(dataDir);

describe('MOB_IDS (the mob ids move code names)', () => {
  it('all exist in mobs.json', () => {
    for (const id of Object.values(MOB_IDS)) expect(Object.keys((files as any).mobs.mobs)).toContain(id);
  });
  it('validation catches one that mobs.json lost', () => {
    const f = structuredClone(files) as any;
    delete f.mobs.mobs[MOB_IDS.rivetMine];
    const p = validateGameData(f as GameDataFiles, { ships: structuredClone(ships) as any });
    expect(p.some((x) => x.level === 'error' && x.path === 'MOB_IDS.rivetMine')).toBe(true);
  });
});
