import { describe, it, expect } from 'vitest';
import { wreckFromMessage, wreckLabel, wreckLive } from './wreckMark';

describe('your wreck mark', () => {
  it('is yours alone, then open to all, then gone, and the label says which', () => {
    const w = wreckFromMessage({ type: 'wreck', system: 'sol', x: 10, y: 20, seconds: 300, open: 300 }, 0)!;
    expect(w).toEqual({ system: 'sol', x: 10, y: 20, until: 300_000, gone: 600_000 });
    expect(wreckLabel(w, 0)).toBe('⚑ Your wreck · yours for 5:00');
    expect(wreckLabel(w, 299_500)).toBe('⚑ Your wreck · yours for 0:01');
    expect(wreckLabel(w, 300_000)).toBe('⚑ Your wreck · open to all, 5:00 left');
    expect(wreckLive(w, 599_999)).toBe(true);
    expect(wreckLabel(w, 600_000)).toBeNull();
    expect(wreckFromMessage({ type: 'wreck', gone: true }, 0)).toBeNull();
  });
});
