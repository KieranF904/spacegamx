/**
 * One client's confirmation level (part E, ConfirmLevel.ts): NORMAL to start, ROUGH after a clean stretch, STRICT after
 * a correction, stepping back down a level per clean stretch; a change only at a snapshot's end (apply).
 */
import { describe, it, expect } from 'vitest';
import { CONFIRM, confirmRules } from '@space-game/common';
import { ConfirmLevel, CLEAN_TICKS } from './ConfirmLevel.js';

/** Snapshots every 3 ticks from `from` to `to`: step, then apply at each one's end; the levels it went through */
function run(l: ConfirmLevel, from: number, to: number, at?: (t: number) => void): number[] {
  const seen: number[] = [];
  for (let t = from; t <= to; t += 3) {
    at?.(t);
    l.step(t);
    if (l.apply(t)) seen.push(l.level);
  }
  return seen;
}

describe('confirmation levels (part E)', () => {
  it('starts NORMAL and goes ROUGH after a clean stretch, no sooner', () => {
    const l = new ConfirmLevel(0);
    expect(l.level).toBe(CONFIRM.NORMAL);
    expect(run(l, 3, CLEAN_TICKS - 3)).toEqual([]);
    expect(run(l, CLEAN_TICKS, CLEAN_TICKS + 30)).toEqual([CONFIRM.ROUGH]);
    expect(l.rules.reportEvery).toBe(confirmRules(CONFIRM.ROUGH).reportEvery);
  });

  it('a disagreement starts the clean stretch again', () => {
    const l = new ConfirmLevel(0);
    expect(run(l, 3, 900, (t) => { if (t === 300) l.disagreed(t); })).toEqual([CONFIRM.ROUGH]);
    expect(l.history[0][0]).toBeGreaterThanOrEqual(300 + CLEAN_TICKS);
  });

  it('a correction at any level means STRICT from the next snapshot; then NORMAL, then ROUGH, a clean stretch each', () => {
    const l = new ConfirmLevel(0);
    run(l, 3, 700);
    expect(l.level).toBe(CONFIRM.ROUGH);
    l.corrected(702);
    // (not before the snapshot ends)
    expect(l.level).toBe(CONFIRM.ROUGH);
    expect(l.apply(702)).toBe(true);
    expect(l.level).toBe(CONFIRM.STRICT);
    expect(l.rules.strict).toBe(true);
    expect(l.rules.delayTicks).toBe(2);
    const seen = run(l, 705, 702 + 2 * CLEAN_TICKS + 30);
    expect(seen).toEqual([CONFIRM.NORMAL, CONFIRM.ROUGH]);
    expect(l.history.map((h) => h[1])).toEqual([CONFIRM.ROUGH, CONFIRM.STRICT, CONFIRM.NORMAL, CONFIRM.ROUGH]);
  });

  it('a correction while STRICT keeps it STRICT for a clean stretch more', () => {
    const l = new ConfirmLevel(0);
    l.corrected(3);
    l.apply(3);
    expect(run(l, 6, 500, (t) => { if (t === 450) l.corrected(t); })).toEqual([]);
    expect(run(l, 503, 450 + CLEAN_TICKS - 3)).toEqual([]);
    expect(run(l, 450 + CLEAN_TICKS, 450 + CLEAN_TICKS + 30)).toEqual([CONFIRM.NORMAL]);
  });
});
