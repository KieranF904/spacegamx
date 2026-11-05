import { describe, it, expect } from 'vitest';
import { LIFE } from '@space-game/common';
import { noteBossLife, bossRise, clearBossLives } from './bossLife';

describe('a lair boss rising and sinking (bossLife)', () => {
  it('is drawn from the tick the server stamped: buried, rising, up, sinking, gone', () => {
    clearBossLives();
    expect(bossRise(9, 0)).toBe(1);
    noteBossLife({ type: 'bossLife', boss: 'b', bodyId: 9, state: 'waking', at: 1000 });
    expect(bossRise(9, 1000)).toBe(0);
    expect(bossRise(9, 1000 + LIFE.wake / 2)).toBeCloseTo(0.5);
    expect(bossRise(9, 1000 + LIFE.wake)).toBe(1);
    noteBossLife({ type: 'bossLife', boss: 'b', bodyId: 9, state: 'sleeping', at: 5000 });
    expect(bossRise(9, 5000 + LIFE.sleep)).toBe(0);
    noteBossLife({ type: 'bossLife', boss: 'b', bodyId: 9, state: 'dormant', at: 6000 });
    expect(bossRise(9, 6000)).toBe(1);
    noteBossLife({ type: 'bossLife', boss: 'b', bodyId: 9, state: 'sleeping', at: 5000 });
    clearBossLives();
    expect(bossRise(9, 9000)).toBe(1);
  });
});
