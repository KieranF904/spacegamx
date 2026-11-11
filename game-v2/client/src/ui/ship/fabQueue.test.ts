/**
 * The fabricator queue the Ship window shows, and what "Queue repairs" sends: the job under way first, the pilot's
 * priority list next in its order, then repairs, recycles and builds by distance from the core; held parts last.
 */
import { describe, expect, it } from 'vitest';
import { fabQueue, repairMessages, shortOf, type QueuePart } from './fabQueue';

const part = (uid: number, o: Partial<QueuePart> = {}): QueuePart => ({
  uid, name: `P${uid}`, alive: true, missing: 0, wanted: false, recycle: false, makeable: true, depth: 1, bill: {}, ...o,
});
const hold: Record<string, number> = { plate: 4 };
const base = { first: [] as number[], paused: [] as number[], busy: undefined as number | undefined, have: (id: string) => hold[id] ?? 0, itemName: (id: string) => id === 'plate' ? 'Alloy Plate' : id };

describe('fabQueue', () => {
  it('lists only parts with work: repairs, recycles, builds, nearest the core first (recycles deepest first)', () => {
    const parts = [
      part(0, { depth: 0 }),
      part(1, { alive: false, wanted: true, depth: 1, bill: { plate: 2 } }),
      part(2, { missing: 0.5, depth: 2, bill: { plate: 1 } }),
      part(3, { missing: 0.2, depth: 1, bill: { plate: 1 } }),
      part(4, { recycle: true, depth: 1 }),
      part(5, { recycle: true, depth: 3 }),
    ];
    const rows = fabQueue({ ...base, parts });
    expect(rows.map((r) => [r.uid, r.kind])).toEqual([[3, 'repair'], [2, 'repair'], [5, 'recycle'], [4, 'recycle'], [1, 'build']]);
    expect(rows.every((r) => r.state === 'ready')).toBe(true);
  });

  it('the job under way first, the priority list next in its order, held parts last and saying so', () => {
    const parts = [part(1, { missing: 0.5 }), part(2, { alive: false, wanted: true }), part(3, { alive: false, wanted: true }), part(4, { missing: 0.1 })];
    const rows = fabQueue({ ...base, parts, busy: 4, first: [3, 2], paused: [1] });
    expect(rows.map((r) => [r.uid, r.state, r.first])).toEqual([[4, 'working', 0], [3, 'ready', 1], [2, 'ready', 2], [1, 'held', 0]]);
    expect(rows[3].waits).toBe('Held');
    expect(rows[0].waits).toBe('Under way');
  });

  it('says what a part is short of, or that it needs a better fabricator', () => {
    const parts = [part(1, { alive: false, wanted: true, bill: { plate: 6, wire: 2, gem: 1 } }), part(2, { alive: false, wanted: true, makeable: false })];
    const rows = fabQueue({ ...base, parts });
    expect(rows[0]).toMatchObject({ uid: 1, state: 'short', waits: 'Short: 2 alloy plate, 2 wire +1' });
    expect(rows[1]).toMatchObject({ uid: 2, state: 'grade', waits: 'Needs a better fabricator' });
    expect(shortOf({ plate: 3 }, base.have)).toEqual({});
  });
});

describe('repairMessages ("Queue repairs" in the field)', () => {
  it('switches the fabricator on, lets held parts go, and puts repairs then rebuilds first (sent last first), never recycles', () => {
    const parts = [part(1, { alive: false, wanted: true, depth: 1 }), part(2, { missing: 0.5, depth: 2 }), part(3, { recycle: true }), part(4, { missing: 0.3, depth: 1 })];
    const rows = fabQueue({ ...base, parts, paused: [1] });
    const msgs = repairMessages(rows, false);
    expect(msgs[0]).toEqual({ type: 'machine', kind: 'fabricator', on: true });
    expect(msgs).toContainEqual({ type: 'fieldOrder', action: 'resume', uid: 1 });
    const tops = msgs.filter((m) => m.type === 'fieldOrder' && m.action === 'top').map((m) => (m as { uid: number }).uid);
    // (Each top goes to the front: the last sent ends first, so the list ends up 4, 2, 1)
    expect(tops.reverse()).toEqual([4, 2, 1]);
    expect(repairMessages(rows, true)[0]).not.toMatchObject({ type: 'machine' });
  });
});
