/** Simple mode's kept stats and the power balance line. */
import { describe, expect, it } from 'vitest';
import { SIMPLE_STAT_KEYS, powerBalance } from './simpleStats';
import { STATS } from './statDelta';

describe('simple stats', () => {
  it('keeps only stats the delta card knows', () => {
    const known = new Set(STATS.map((s) => s.key));
    for (const k of SIMPLE_STAT_KEYS) expect(known.has(k)).toBe(true);
    expect(SIMPLE_STAT_KEYS.has('mass')).toBe(false);
  });
  it('power balance: made vs used, and generators short', () => {
    expect(powerBalance(100, 80, 2)).toEqual({ text: '100 made · 80 used', short: null });
    expect(powerBalance(100, 160, 2).short).toBe('2 generators short');
    expect(powerBalance(100, 140, 2).short).toBe('1 generator short');
    expect(powerBalance(0, 40, 0).short).toBe('no generator to run it');
  });
});
