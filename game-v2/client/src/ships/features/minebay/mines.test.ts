import { describe, it, expect } from 'vitest';
import { MINES, makeDrop, mineId, minePos, type MineBayInfo } from '@space-game/common';
import { MineStore } from './mines';

const info: MineBayInfo = { bays: [{ part: 1, uid: 7, batch: 4, capacity: 12, cooldown: 120, mouth: [1, 2], dir: [0, 1] }] };
const pose = { x: 500, y: -300, angle: -Math.PI / 2, vx: 2, vy: -1 };
const ME = 11;

describe('mine bay client: what it knows', () => {
  it("draws the server's record exactly as the server derives it", () => {
    const s = new MineStore();
    const d = makeDrop(99, info.bays[0], 1000, 4, [1, 0.5], 10, pose);
    s.laid(d, ME);
    const at = 1000 + MINES.armTicks + 3;
    const live = s.live(() => at, []);
    expect(live.map((m) => [m.x, m.y])).toEqual([0, 1, 2, 3].map((i) => minePos(d, i, at)));
    expect(live.every((m) => m.armed && m.owner === 99)).toBe(true);
    // (Told twice: drawn once)
    s.laid(d, ME);
    expect(s.live(() => at, []).length).toBe(4);
    // A blast takes one away from its tick on, and is drawn where it rested
    s.gone({ tick: at + 5, ids: [mineId(99, 1000, 2)], how: 'blast' });
    expect(s.live(() => at + 4, []).length).toBe(4);
    expect(s.live(() => at + 5, []).length).toBe(3);
    expect(s.blasts[0]).toMatchObject({ x: minePos(d, 2, at + 5)[0], y: minePos(d, 2, at + 5)[1] });
    // Its life's end: gone with nothing told
    expect(s.live(() => 1000 + MINES.lifeTicks, []).length).toBe(0);
  });

  it('the own drop is predicted at once and adopted when the server says', () => {
    const s = new MineStore();
    // (Not told the magazines yet: nothing to predict from)
    expect(s.press(ME, info, [1, 0.5], 10, pose, 2000)).toBeNull();
    s.bayState({ loaded: { 7: 12 }, readyAt: 0 });
    const p = s.press(ME, info, [1, 0.5], 10, pose, 2000)!;
    expect(p).toMatchObject({ owner: ME, bay: 7, tick: 2000, n: 4 });
    expect(s.drops).toHaveLength(1);
    expect(s.drops[0].predicted).toBe(true);
    expect(s.loaded(info)).toBe(8);
    // Cooling down: no second prediction
    expect(s.press(ME, info, [1, 0.5], 10, pose, 2010)).toBeNull();
    // The server's record (the same tick, its own pose) replaces it
    const real = makeDrop(ME, info.bays[0], 2000, 4, [1, 0.5], 10, { ...pose, x: 501 });
    s.laid(real, ME);
    expect(s.drops).toHaveLength(1);
    expect(s.drops[0]).toMatchObject({ predicted: false, d: real });
    expect(s.live(() => 2050, []).map((m) => [m.x, m.y])).toEqual([0, 1, 2, 3].map((i) => minePos(real, i, 2050)));
  });

  it('a refused press takes its prediction away; one never answered goes too', () => {
    const s = new MineStore();
    s.bayState({ loaded: { 7: 12 }, readyAt: 0 });
    s.press(ME, info, [1, 0.5], 10, pose, 2000, 0);
    s.bayState({ loaded: { 7: 12 }, readyAt: 0, refused: true });
    expect(s.drops).toHaveLength(0);
    expect(s.loaded(info)).toBe(12);
    s.press(ME, info, [1, 0.5], 10, pose, 3000, 0);
    s.prune(() => 3001, 100);
    expect(s.drops).toHaveLength(1);
    s.prune(() => 3001, 10_000);
    expect(s.drops).toHaveLength(0);
  });
});
