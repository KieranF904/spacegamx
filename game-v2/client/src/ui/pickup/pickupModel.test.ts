import { describe, it, expect } from 'vitest';
import type { HoldView, LootNearPod, Stack } from '@space-game/common';
import { pickupRows } from './pickupModel';

const hold = (cargo: Stack[], capacity = 20): HoldView => ({ cargo, capacity, volume: () => 1, category: (id) => (id.endsWith('_ore') ? 'mineral' : 'component') });

describe('the pickup panel rows', () => {
  it('sum each item over the pods in reach, most first, with how much fits', () => {
    const { rows } = pickupRows([{ id: 1, items: { servo_motor: 2, copper_wire: 9 } }, { id: 2, items: { servo_motor: 3 } }], hold([{ id: 'iron_ore', n: 12 }]), []);
    expect(rows).toEqual([
      { item: 'copper_wire', n: 9, fit: 8, reserved: false },
      { item: 'servo_motor', n: 5, fit: 5, reserved: false },
    ]);
  });

  it('a full hold fits none; space the whitelist keeps is flagged', () => {
    expect(pickupRows([{ id: 1, items: { servo_motor: 2 } }], hold([{ id: 'iron_ore', n: 20 }]), []).rows[0].fit).toBe(0);
    const r = pickupRows([{ id: 1, items: { copper_wire: 2 } }], hold([{ id: 'iron_ore', n: 14 }]), [{ item: 'servo_motor' }]).rows[0];
    expect(r).toEqual({ item: 'copper_wire', n: 2, fit: 2, reserved: true });
  });

  it("someone else's wreck: listed with its lock, its items offered only once it opens; your own at once", () => {
    const near: LootNearPod[] = [{ id: 5, items: { crystal_lens: 2 }, lock: 30 }, { id: 6, items: { ruby: 1 }, mine: true }];
    const now = pickupRows(near, hold([]), []);
    expect(now.wrecks).toEqual([{ id: 5, mine: false, lock: 30, count: 2 }, { id: 6, mine: true, lock: 0, count: 1 }]);
    expect(now.rows.map((x) => x.item)).toEqual(['ruby']);
    const later = pickupRows(near, hold([]), [], 31_000);
    expect(later.wrecks[0].lock).toBe(0);
    expect(later.rows.map((x) => x.item).sort()).toEqual(['crystal_lens', 'ruby']);
  });
});
