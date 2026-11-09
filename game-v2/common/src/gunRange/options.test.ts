/** The gun range's weapon options (options.ts): what the pilot may fit at their level, plus what they already have. */

import { describe, it, expect } from 'vitest';
import { gunRangeOptions } from './options.js';
import { partItemId } from '../econ/items.js';
import { testCatalog } from '../ships/testData.js';

const catalog = testCatalog();
const level = (id: string) => catalog.functions.get(id)!.unlock!.level;

describe('gun range options', () => {
  it('a new pilot gets the level-0 weapons only', () => {
    const got = gunRangeOptions(catalog, { level: 0 });
    expect(got).toContain('cannon_pip');
    expect(got.every((id) => level(id) <= 0)).toBe(true);
  });

  it('more open as the level rises, never a game-only or legacy weapon', () => {
    const at10 = gunRangeOptions(catalog, { level: 10 }), at50 = gunRangeOptions(catalog, { level: 50 });
    expect(at10.length).toBeGreaterThan(gunRangeOptions(catalog, { level: 0 }).length);
    expect(at10.every((id) => level(id) <= 10)).toBe(true);
    expect(at50.length).toBeGreaterThanOrEqual(40);
    for (const id of at50) { const f = catalog.functions.get(id)!; expect(f.model && f.weapon && !f.exclusive && !f.legacy).toBeTruthy(); }
  });

  it('a weapon above their level they already have (fitted, held or stored) is theirs to try', () => {
    const spear = catalog.functions.get('railgun_spear')!;
    expect(gunRangeOptions(catalog, { level: 0 })).not.toContain('railgun_spear');
    const part = { uid: 0, piece: spear.pieces[0] as string, fn: spear.id, material: spear.material!, x: 0, y: 0, rot: 0 as const, flip: false };
    expect(gunRangeOptions(catalog, { level: 0, ship: { blueprint: { name: 'x', catalogVersion: 1, parts: [part] } } })).toContain('railgun_spear');
    expect(gunRangeOptions(catalog, { level: 0, storage: [{ id: partItemId(part), n: 1 }] })).toContain('railgun_spear');
    expect(gunRangeOptions(catalog, { level: 0, cargo: [{ id: partItemId(part), n: 0 }] })).not.toContain('railgun_spear');
  });
});
