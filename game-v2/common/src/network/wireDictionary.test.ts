/**
 * The wire dictionary's data-derived part (wire-dictionary.json) is append-only and covers every model,
 * material and piece id. A new part fails here until `npm run wire:sync` (then `npm run wire:bump "reason"`).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DICTIONARY } from './binaryCodec.js';
import manifest from './wire-dictionary.json' with { type: 'json' };
import { SHIP_DATA_DIR } from '../ships/testData.js';

const ships = (f: string) => JSON.parse(readFileSync(join(SHIP_DATA_DIR, f), 'utf-8'));
const ids = [
  ...ships('models.json').models.map((m: { id: string }) => m.id),
  ...ships('materials.json').materials.map((m: { id: string }) => m.id),
  ...ships('pieces.json').pieces.map((m: { id: string }) => m.id),
] as string[];

describe('wire dictionary manifest', () => {
  it('has no duplicates (in itself or against the fixed head)', () => {
    const head = DICTIONARY.slice(0, DICTIONARY.length - manifest.ids.length);
    expect(new Set(manifest.ids).size, 'duplicate ids in wire-dictionary.json').toBe(manifest.ids.length);
    expect(manifest.ids.filter((id) => head.includes(id)), 'ids already in the dictionary head').toEqual([]);
    expect(new Set(manifest.skip).size).toBe(manifest.skip.length);
    expect(manifest.skip.filter((id) => DICTIONARY.includes(id)), 'a skipped id is also on the wire').toEqual([]);
  });

  it('covers every model, material and piece id (or lists it as deliberately skipped)', () => {
    const missing = ids.filter((id) => !DICTIONARY.includes(id) && !manifest.skip.includes(id));
    expect(missing, `Not in the wire dictionary: ${missing.join(', ')}. Run  npm run wire:sync  then  npm run wire:bump "reason"`).toEqual([]);
  });

  it('every skipped id still exists in the data (drop it from "skip" when a part is removed)', () => {
    expect(manifest.skip.filter((id) => !ids.includes(id))).toEqual([]);
  });
});
