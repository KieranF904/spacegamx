import { describe, it, expect } from 'vitest';
import { MINES, SIDE, makeDrop, mineId, minePos, mineRest, type MineBayInfo, type SearchShips } from '@space-game/common';
import { MineStore, PREDICT_HOLD, PREDICT_SLACK, type DrawnShip } from './mines';

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

describe('mine bay client: blasts predicted, found and told, drawn once (stage M2)', () => {
  const OWNER = 99, NPC = 500;
  const drop = makeDrop(OWNER, info.bays[0], 1000, 4, [1, 0.5], 10, pose);
  const armedAt = 1000 + MINES.armTicks;
  /** An exact layer with one pilotless ship (side 0, radius 20) at `spot` from the end of tick `from` on, far off before */
  const layer = (spot: [number, number], from: number): SearchShips => ({
    ids: [NPC], side: () => 0, radius: () => 20,
    at: (_id, t) => (t >= from ? { x: spot[0], y: spot[1] } : { x: 1e6, y: 1e6 }),
  });
  const drawn = (spot: [number, number]): DrawnShip[] => [{ id: NPC, x: spot[0], y: spot[1], radius: 20, side: 0 }];
  // (Mine 0's rest, and a spot whose hull touches it from the far side of the batch, and no other)
  const rest0 = mineRest(drop, 0), next = mineRest(drop, 1);
  const u = Math.hypot(rest0[0] - next[0], rest0[1] - next[1]);
  const touch: [number, number] = [rest0[0] + ((rest0[0] - next[0]) / u) * 55, rest0[1] + ((rest0[1] - next[1]) / u) * 55];
  const id0 = mineId(OWNER, 1000, 0);

  function store() { const s = new MineStore(); s.laid(drop, ME); return s; }

  it('found on the tick layer: the mine ends on the tick the ship came in reach, one blast', () => {
    const s = store();
    s.window(armedAt, armedAt + 3, layer(touch, armedAt + 1), 0);
    // (where it was at the end of armedAt+1 is what tick armedAt+2's pass sees: a pilotless ship moves after it)
    expect(s.drops[0].ends[0]).toEqual({ tick: armedAt + 2, how: 'blast', src: 'found' });
    for (const i of [1, 2, 3]) expect(s.drops[0].ends[i]).toBeUndefined();
    expect(s.blasts).toHaveLength(1);
    expect(s.blasts[0]).toMatchObject({ x: rest0[0], y: rest0[1], tick: armedAt + 2 });
    // Told as well: still one blast
    s.gone({ tick: armedAt + 2, ids: [id0], how: 'blast' }, 0);
    expect(s.blasts).toHaveLength(1);
    // Searched again: found once
    s.window(armedAt + 3, armedAt + 6, layer(touch, armedAt + 1), 0);
    expect(s.blasts).toHaveLength(1);
  });

  it('not armed, the owner itself, or a pilot: nothing found', () => {
    const s = store();
    s.window(1000, armedAt - 1, layer(touch, 1000), 0);
    s.window(armedAt, armedAt + 3, { ...layer(touch, armedAt), ids: [OWNER] }, 0);
    s.window(armedAt + 3, armedAt + 6, { ...layer(touch, armedAt), side: () => SIDE.PILOT }, 0);
    expect(s.drops[0].ends[0]).toBeUndefined();
    expect(s.blasts).toHaveLength(0);
  });

  it('never predicted or found for a pilot, a ward, a berthed ship or a person craft: those are the server job (PvP zones, parties)', () => {
    for (const side of [SIDE.PILOT, SIDE.WARD, SIDE.DOCKED, SIDE.PERSON, SIDE.PILOT | SIDE.WARD]) {
      const s = store();
      expect(s.predict([{ id: NPC, x: touch[0], y: touch[1], radius: 20, side }], armedAt + 5, 0)).toBe(0);
      s.window(armedAt, armedAt + 8, { ...layer(touch, armedAt), side: () => side }, 0);
      expect(s.drops[0].ends[0]).toBeUndefined();
      expect(s.blasts).toHaveLength(0);
    }
    // (the same ship with no side is found and predicted)
    expect(store().predict(drawn(touch), armedAt + 5, 0)).toBe(1);
  });

  it('predicted at once from the drawn ships, confirmed by the find: the same blast, never a second', () => {
    const s = store();
    expect(s.predict(drawn(touch), armedAt + 5, 0)).toBe(1);
    expect(s.blasts).toHaveLength(1);
    const b = s.blasts[0];
    // (its mine hidden at once)
    expect(s.live(() => armedAt + 5, []).length).toBe(3);
    expect(s.predict(drawn(touch), armedAt + 6, 0)).toBe(0);
    s.window(armedAt + 2, armedAt + 8, layer(touch, armedAt + 4), 0);
    expect(s.drops[0].ends[0]).toMatchObject({ tick: armedAt + 5, src: 'found' });
    expect(s.blasts).toEqual([b]);
    expect(s.stats).toMatchObject({ predicted: 1, confirmed: 1, undone: 0 });
  });

  it('predicted, then told: the same blast', () => {
    const s = store();
    s.predict(drawn(touch), armedAt + 5, 0);
    const b = s.blasts[0];
    s.gone({ tick: armedAt + 7, ids: [id0], how: 'blast' }, 0);
    expect(s.blasts).toEqual([b]);
    expect(s.drops[0].ends[0]).toMatchObject({ tick: armedAt + 7, src: 'told' });
  });

  it('a wrong prediction is undone once the windows past it settle with no end: the mine comes back, its blast is cut', () => {
    const s = store();
    s.predict(drawn(touch), armedAt + 5, 0);
    // (the tick layer has the ship elsewhere: nothing found, and not yet settled far enough)
    s.window(armedAt, armedAt + 5 + PREDICT_SLACK - 1, layer([1e6, 1e6], 0), 0);
    expect(s.blasts).toHaveLength(1);
    s.window(armedAt + 5 + PREDICT_SLACK - 1, armedAt + 5 + PREDICT_SLACK, null, 0);
    expect(s.blasts).toHaveLength(0);
    expect(s.live(() => armedAt + 40, []).length).toBe(4);
    expect(s.stats.undone).toBe(1);
    // Held a while: a drawn ship still sitting there doesn't flicker it
    expect(s.predict(drawn(touch), armedAt + 40, 0)).toBe(0);
    expect(s.predict(drawn(touch), armedAt + 5 + PREDICT_HOLD, 0)).toBe(1);
  });

  it('minesKept: a blast found that never happened is taken back, and that mine is then only told', () => {
    const s = store();
    s.window(armedAt, armedAt + 3, layer(touch, armedAt), 0);
    expect(s.drops[0].ends[0]?.src).toBe('found');
    s.kept({ tick: armedAt + 1, ids: [id0] });
    expect(s.drops[0].ends[0]).toBeUndefined();
    expect(s.blasts).toHaveLength(0);
    expect(s.live(() => armedAt + 4, []).length).toBe(4);
    // Searched and predicted no more
    s.window(armedAt + 3, armedAt + 6, layer(touch, armedAt), 0);
    expect(s.drops[0].ends[0]).toBeUndefined();
    expect(s.predict(drawn(touch), armedAt + 7, 0)).toBe(0);
    // Its end is told
    s.gone({ tick: armedAt + 9, ids: [id0], how: 'blast' }, 0);
    expect(s.drops[0].ends[0]).toMatchObject({ tick: armedAt + 9, src: 'told' });
    expect(s.blasts).toHaveLength(1);
  });

  it('minesKept ahead of the search (it comes before its snapshot): never found, nothing to undo', () => {
    const s = store();
    s.kept({ tick: armedAt + 1, ids: [id0] });
    s.window(armedAt, armedAt + 3, layer(touch, armedAt), 0);
    expect(s.drops[0].ends[0]).toBeUndefined();
    expect(s.blasts).toHaveLength(0);
  });

  it('told late that a mine is gone, then the blast found before that: the blast stands, drawn once', () => {
    const s = store();
    s.gone({ tick: armedAt + 10, ids: [id0], how: 'fizzle' }, 0);
    expect(s.blasts).toHaveLength(0);
    s.window(armedAt, armedAt + 3, layer(touch, armedAt), 0);
    expect(s.drops[0].ends[0]).toMatchObject({ tick: armedAt + 1, how: 'blast', src: 'found' });
    expect(s.blasts).toHaveLength(1);
  });
});
