import { describe, expect, it } from 'vitest';
import { FX_KINDS, fxKindCode, fxKindName } from './fxKinds.js';
import { WEAPON_KIND_TYPE } from '../ecs/components.js';

describe('FX_KINDS', () => {
  it('lists every weapon kind, once each', () => {
    for (const k of Object.keys(WEAPON_KIND_TYPE)) expect(FX_KINDS).toContain(k);
    expect(new Set(FX_KINDS).size).toBe(FX_KINDS.length);
  });
  it('keeps the weapon kinds first, in WEAPON_KIND_TYPE order', () => {
    const w = Object.keys(WEAPON_KIND_TYPE);
    expect(FX_KINDS.slice(0, w.length)).toEqual(w);
  });
  it('round trips a listed kind as a number and an unlisted kind as itself', () => {
    expect(typeof fxKindCode('cannon')).toBe('number');
    expect(fxKindName(fxKindCode('tesla_arc'))).toBe('tesla_arc');
    expect(fxKindCode('not_a_kind_yet')).toBe('not_a_kind_yet');
    expect(fxKindName('not_a_kind_yet')).toBe('not_a_kind_yet');
  });
});
