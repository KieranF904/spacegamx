/** The gun range's weapon options (options.ts): every weapon model, whatever the pilot's level. */

import { describe, it, expect } from 'vitest';
import { gunRangeOptions } from './options.js';
import { testCatalog } from '../ships/testData.js';

const catalog = testCatalog();
const level = (id: string) => catalog.functions.get(id)!.unlock!.level;

describe('gun range options', () => {
  it('a new pilot is offered everything: the same as a level 60 one, weapons far above their level too', () => {
    const got = gunRangeOptions(catalog, { level: 0 });
    expect(got).toContain('cannon_pip');
    expect(got).toContain('railgun_spear');
    expect(got.some((id) => level(id) >= 30)).toBe(true);
    expect(got).toEqual(gunRangeOptions(catalog, { level: 60 }));
    expect(got).toEqual(gunRangeOptions(catalog));
  });

  it('every weapon model there is, never a game-only or legacy weapon', () => {
    const got = gunRangeOptions(catalog, { level: 0 });
    expect(got.length).toBeGreaterThanOrEqual(40);
    for (const id of got) { const f = catalog.functions.get(id)!; expect(f.model && f.weapon && !f.exclusive && !f.legacy).toBeTruthy(); }
  });
});
