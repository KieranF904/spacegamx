import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { SFX_TABLE, SFX_VARIANTS, variantKey } from './sfxMeta';

describe('sfxMeta', () => {
  it('lists exactly the recipes in sfx.ts', () => {
    const src = readFileSync(new URL('./sfx.ts', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('const RECIPES'));
    const ids = [...body.matchAll(/^ {2}([a-z_]+): \{ duration:/gm)].map(m => m[1]).sort();
    expect(Object.keys(SFX_TABLE).sort()).toEqual(ids);
  });
  it('names variants as id, id#1, id#2', () => {
    expect(variantKey('shot', 0)).toBe('shot');
    expect(variantKey('shot', 2)).toBe('shot#2');
    expect(SFX_VARIANTS.shot).toBe(4);
  });
});
