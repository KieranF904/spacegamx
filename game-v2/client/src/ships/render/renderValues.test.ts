/**
 * The render value modules carry no logic: constants.ts is values and text styles only, viewTypes.ts is types only.
 */
import { describe, expect, it } from 'vitest';
import * as constants from './constants';
import * as viewTypes from './viewTypes';

describe('values only (constants.ts)', () => {
  it('every export is a number, a string, a list or a style object: no function, no state-holding class', () => {
    const entries = Object.entries(constants);
    expect(entries.length).toBeGreaterThan(10);
    for (const [name, v] of entries) expect(typeof v, name).not.toBe('function');
  });
});

describe('types only (viewTypes.ts)', () => {
  it('has no runtime exports', () => {
    expect(Object.keys(viewTypes)).toEqual([]);
  });
});
