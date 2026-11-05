/**
 * The schematics retired: a save loads clean (no schematic items, no dead
 * licences), a boss-legendary schematic as its boss's artefact.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { SHIP_DATA_DIR } from '../ships/testData.js';
import { retireSchematics, retireStacks, LEGENDARY_SCHEMATICS } from './retired.js';

const data = (f: string) => JSON.parse(readFileSync(join(SHIP_DATA_DIR, '..', f), 'utf-8'));

describe('retired schematics', () => {
  it('held ones go, a legendary one as its artefact; dead licences go, the core and leestone stay', () => {
    const p = {
      cargo: [{ id: 'schematic_flak', n: 1 }, { id: 'iron_ore', n: 5 }],
      storage: [{ id: 'schematic_hive', n: 1 }, { id: 'rustjaw_cog', n: 1 }, { id: 'schematic_steel', n: 2 }],
      quickbar: ['schematic_flak', 'repair_kit', null],
      recipes: ['fn:core', 'fn:railgun', 'material:steel', 'material:leestone', 'buoy_frame', 'fn:constructor'],
    };
    retireSchematics(p);
    expect(p.cargo).toEqual([{ id: 'iron_ore', n: 5 }]);
    expect(p.storage).toEqual([{ id: 'rustjaw_cog', n: 2 }]);
    expect(p.quickbar).toEqual([null, 'repair_kit', null]);
    expect(p.recipes).toEqual(['fn:core', 'material:leestone', 'buoy_frame']);
    // (A list with none is left alone)
    const clean = [{ id: 'iron_ore', n: 1 }];
    expect(retireStacks(clean)).toBe(clean);
  });

  it('no schematic is left in the catalogue, and each legendary one became an artefact that is', () => {
    const items = data('items.json').items as { id: string; category: string }[];
    expect(items.filter((i) => i.id.startsWith('schematic_'))).toEqual([]);
    for (const to of Object.values(LEGENDARY_SCHEMATICS)) expect(items.find((i) => i.id === to)?.category, to).toBe('artefact');
  });
});
