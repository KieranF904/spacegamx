import { describe, it, expect } from 'vitest';
import { CAPS, DEFAULT_CAPS, TICK_MS, confirmRules, CONFIRM } from '@space-game/common';
import { coalesceDelayMs } from './netCaps';

describe('netCaps', () => {
  it('the full set is every cap (a client joins with all of them)', () => {
    expect(DEFAULT_CAPS).toBe(Object.values(CAPS).reduce((m, b) => m | b, 0));
  });

  it('widens the interpolation delay by the hold and the confirmation level', () => {
    expect(coalesceDelayMs(3)).toBe((3 + confirmRules(undefined).delayTicks) * TICK_MS);
    expect(coalesceDelayMs(99, CONFIRM.STRICT)).toBe((30 + confirmRules(CONFIRM.STRICT).delayTicks) * TICK_MS);
  });
});
