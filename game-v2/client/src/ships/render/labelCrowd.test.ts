import { describe, expect, it } from 'vitest';
import { LabelCrowd, LABEL_HALF_W } from './labelCrowd';

/** Run frames of the same labels until what shows has settled; returns each ship's share shown */
function settle(spots: [number, number, number, boolean?][], focus: { x: number; y: number } | null = null, k = 1, ang = 0): Map<number, number> {
  const lc = new LabelCrowd(), out = new Map<number, number>();
  for (let f = 0; f < 30; f++) {
    lc.begin();
    for (const [eid, x, y, pinned] of spots) out.set(eid, lc.add(eid, x, y, !!pinned));
    lc.end(1 / 60, k, ang, focus);
  }
  return out;
}

describe('name labels in a bunch of ships', () => {
  it('a ship on its own keeps its name; ships well apart all keep theirs', () => {
    expect(settle([[1, 0, 0]]).get(1)).toBe(1);
    const far = settle([[1, 0, 0], [2, LABEL_HALF_W * 4, 0], [3, 0, 400]]);
    expect([...far.values()]).toEqual([1, 1, 1]);
  });

  it('ships bunched together lose their names, but the one under the cursor and a pinned one', () => {
    const bunch: [number, number, number, boolean?][] = [[1, 0, 0], [2, 60, 20], [3, -50, -30], [4, 30, -10, true], [9, 2000, 0]];
    const none = settle(bunch);
    expect([none.get(1), none.get(2), none.get(3)]).toEqual([0, 0, 0]);
    expect(none.get(4)).toBe(1);
    expect(none.get(9)).toBe(1);
    const hover = settle(bunch, { x: 58, y: 22 });
    expect(hover.get(2)).toBe(1);
    expect([hover.get(1), hover.get(3)]).toEqual([0, 0]);
  });

  it('zoomed out the labels are drawn larger, so ships must be further apart to keep their names', () => {
    const pair: [number, number, number][] = [[1, 0, 0], [2, 200, 0]];
    expect(settle(pair, null, 1).get(1)).toBe(1);
    expect(settle(pair, null, 2).get(1)).toBe(0);
  });

  it('the bunch is judged across and down the screen, however the camera is rolled', () => {
    // (side by side in the world, one above the other on a screen rolled a quarter turn)
    const pair: [number, number, number][] = [[1, 0, 0], [2, 120, 0]];
    expect(settle(pair, null, 1, 0).get(1)).toBe(0);
    expect(settle(pair, null, 1, Math.PI / 2).get(1)).toBe(1);
  });

  it('a name eases out, never blinks: a frame after bunching up it is part shown', () => {
    const lc = new LabelCrowd();
    const frame = (x2: number) => { lc.begin(); const a = lc.add(1, 0, 0, false); lc.add(2, x2, 0, false); lc.end(1 / 60, 1, 0, null); return a; };
    frame(1000); frame(1000);
    frame(40);
    const part = frame(40);
    expect(part).toBeGreaterThan(0);
    expect(part).toBeLessThan(1);
  });
});
