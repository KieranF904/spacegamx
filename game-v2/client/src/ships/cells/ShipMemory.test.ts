/**
 * Ships away on the client (ShipMemory): kept on `k`, put back on `b`, asked for again when it has nothing of one, gone
 * on a removal, let go by age and count as the server lets go (AwayShips).
 */
import { describe, it, expect } from 'vitest';
import { AWAY_TICKS, AWAY_CAP, type ClientMessage } from '@space-game/common';
import { ShipMemory } from './ShipMemory';

function memory() {
  const entities = new Map<number, { id: number; data: number[] }>();
  const sent: ClientMessage[] = [];
  const m = new ShipMemory({
    entity: (id) => entities.get(id),
    restore: (id, e) => entities.set(id, e),
    send: (msg) => sent.push(msg),
  });
  return { m, entities, sent };
}

describe('ShipMemory', () => {
  it('keeps a leaving ship\'s row and puts it back as it was', () => {
    const { m, entities, sent } = memory();
    entities.set(7, { id: 7, data: [1, 2, 3] });
    m.onCells({ type: 'cells', tick: 100, k: [7] });
    // (the snapshot's `out` takes it off the world)
    entities.delete(7);
    expect(m.has(7)).toBe(true);
    m.onCells({ type: 'cells', tick: 4000, b: [7] });
    expect(entities.get(7)?.data).toEqual([1, 2, 3]);
    expect(m.has(7)).toBe(false);
    expect(sent).toEqual([]);
  });

  it('back with nothing kept: it asks for the ship again', () => {
    const { m, sent } = memory();
    m.onCells({ type: 'cells', tick: 100, b: [9] });
    expect(sent).toEqual([{ type: 'shipNeed', id: 9 }]);
    expect(m.stats.missed).toBe(1);
  });

  it('a removal while away takes it out; age and count let go, oldest first', () => {
    const { m, entities } = memory();
    for (let i = 0; i < AWAY_CAP + 3; i++) entities.set(i, { id: i, data: [] });
    m.onCells({ type: 'cells', tick: 10, k: [0, 1] });
    m.onSnapshot(10, [1]);
    expect(m.has(1)).toBe(false);
    m.onCells({ type: 'cells', tick: 20, k: [...Array(AWAY_CAP).keys()].map((i) => i + 2) });
    // (one over the cap: the oldest, 0, goes)
    expect(m.has(0)).toBe(false);
    expect(m.stats.letGo).toBe(1);
    expect(m.size).toBe(AWAY_CAP);
    m.onSnapshot(21 + AWAY_TICKS, []);
    expect(m.size).toBe(0);
  });
});
