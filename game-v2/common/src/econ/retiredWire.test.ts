/**
 * The wire spool retired: a save loads with no spools and the credits they were worth.
 */

import { describe, it, expect } from 'vitest';
import { retireWireSpools, WIRE_SPOOL_REFUND } from './retiredWire.js';

const base = () => ({
  credits: 100,
  cargo: [{ id: 'wire_spool', n: 2 }, { id: 'iron_ore', n: 5 }],
  storage: [{ id: 'wire_spool', n: 3 }],
  quickbar: ['wire_spool', 'repair_kit', null] as (string | null)[],
  jobs: [{ out: { wire_spool: 1, steel_plate: 2 } }] as never[],
  fabOrders: [{ id: 1, item: 'wire_spool', n: 5, made: 2 }, { id: 2, item: 'steel_plate', n: 1, made: 0 }],
});

describe('retireWireSpools', () => {
  it('removes every spool and refunds each at its value', () => {
    const p = base();
    const n = retireWireSpools(p);
    expect(n).toBe(2 + 3 + 1 + 3);
    expect(p.credits).toBe(100 + n * WIRE_SPOOL_REFUND);
    expect(p.cargo).toEqual([{ id: 'iron_ore', n: 5 }]);
    expect(p.storage).toEqual([]);
    expect(p.quickbar).toEqual([null, 'repair_kit', null]);
    expect((p.jobs[0] as { out: object }).out).toEqual({ steel_plate: 2 });
    expect(p.fabOrders).toEqual([{ id: 2, item: 'steel_plate', n: 1, made: 0 }]);
  });
  it('is idempotent and leaves a clean profile alone', () => {
    const p = base();
    retireWireSpools(p);
    const credits = p.credits;
    expect(retireWireSpools(p)).toBe(0);
    expect(p.credits).toBe(credits);
  });
});
