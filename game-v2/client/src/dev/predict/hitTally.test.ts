import { describe, expect, it } from 'vitest';
import { HitTally } from './hitTally';

describe('hit tally', () => {
  it('drawn strikes against told hits: agreed, drawn only, told only', () => {
    let now = 0;
    const t = new HitTally((o) => o === 1, (id) => id >= 100, () => now, 1000);
    t.tally('struck', 11, 1, 100); t.tally('confirmed', 11, 1, -1); // agreed
    t.tally('struck', 12, 1, 100); // never told: drawn only
    t.tally('landed', 13, 1, -1); // told, not drawn
    t.tally('struck', 14, 2, 100); t.tally('landed', 15, 2, -1); // someone else's
    t.tally('struck', 16, 1, 5); // a rock
    now = 1500;
    t.read();
    expect(t.totals).toEqual({ agreed: 1, drawnOnly: 1, toldOnly: 1, shield: 0 });
    expect(t.read().agreement).toBeCloseTo(1 / 3, 6);
  });
});
