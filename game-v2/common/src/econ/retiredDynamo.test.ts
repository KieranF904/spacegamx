/**
 * The Pulse Dynamo retired: a save loads with no dynamos (held or placed) and the credits they were worth.
 */

import { describe, it, expect } from 'vitest';
import { retirePulseDynamos, PULSE_DYNAMO_REFUND, PULSE_DYNAMO_ID } from './retiredDynamo.js';

const part = (uid: number, fn: string) => ({ uid, fn, piece: 'sq', material: 'titanium', x: uid, y: 0, rot: 0 as const, flip: false });

const base = () => {
  const ship = {
    blueprint: { name: 's', catalogVersion: 1, parts: [part(1, 'core'), part(2, PULSE_DYNAMO_ID), part(3, 'power_battery')] },
    hp: { 2: 0.5, 3: 1 } as Record<number, number>,
    ghosts: [2],
    owed: [2, 3],
    field: { recycle: [2], mines: { 2: 1 }, waiting: [part(9, PULSE_DYNAMO_ID), part(8, 'power_battery')] },
  };
  return {
    credits: 100,
    cargo: [{ id: PULSE_DYNAMO_ID, n: 2 }, { id: 'iron_ore', n: 5 }],
    storage: [{ id: PULSE_DYNAMO_ID, n: 3 }],
    quickbar: [PULSE_DYNAMO_ID, 'boost_cell', null] as (string | null)[],
    jobs: [{ out: { [PULSE_DYNAMO_ID]: 1, steel_plate: 2 } }] as never[],
    fabOrders: [{ id: 1, item: PULSE_DYNAMO_ID, n: 5, made: 2 }, { id: 2, item: 'steel_plate', n: 1, made: 0 }],
    ship: ship as never,
    hangar: [ship, null] as never[],
    designs: [{ name: 'd', catalogVersion: 1, parts: [part(1, 'core'), part(4, PULSE_DYNAMO_ID)] }, null] as never[],
  };
};

describe('retirePulseDynamos', () => {
  it('removes every held and placed dynamo and refunds each at its value', () => {
    const p = base();
    const n = retirePulseDynamos(p);
    // 2 + 3 held, 1 crafted, 3 on order, 1 placed, 1 waiting in the field plan, 1 in a design
    expect(n).toBe(2 + 3 + 1 + 3 + 1 + 1 + 1);
    expect(p.credits).toBe(100 + n * PULSE_DYNAMO_REFUND);
    expect(p.cargo).toEqual([{ id: 'iron_ore', n: 5 }]);
    expect(p.storage).toEqual([]);
    expect(p.quickbar).toEqual([null, 'boost_cell', null]);
    expect(p.fabOrders).toEqual([{ id: 2, item: 'steel_plate', n: 1, made: 0 }]);
    const ship = p.ship as unknown as { blueprint: { parts: { uid: number }[] }; hp: object; ghosts: number[]; owed: number[]; field: { recycle: number[]; mines: object; waiting: { uid: number }[] } };
    expect(ship.blueprint.parts.map((q) => q.uid)).toEqual([1, 3]);
    expect(ship.hp).toEqual({ 3: 1 });
    expect(ship.ghosts).toEqual([]);
    expect(ship.owed).toEqual([3]);
    expect(ship.field.recycle).toEqual([]);
    expect(ship.field.mines).toEqual({});
    expect(ship.field.waiting.map((q) => q.uid)).toEqual([8]);
    expect(p.hangar[0]).toBe(p.ship);
    expect((p.designs[0] as unknown as { parts: unknown[] }).parts).toHaveLength(1);
  });
  it('is idempotent and leaves a clean profile alone', () => {
    const p = base();
    retirePulseDynamos(p);
    const credits = p.credits;
    expect(retirePulseDynamos(p)).toBe(0);
    expect(p.credits).toBe(credits);
  });
  it('never throws on junk', () => {
    expect(retirePulseDynamos({ credits: 5, cargo: [], storage: [], quickbar: [], jobs: [], fabOrders: undefined, hangar: [null], ship: undefined as never, designs: [null] })).toBe(0);
  });
});
