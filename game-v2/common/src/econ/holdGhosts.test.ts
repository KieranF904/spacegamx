import { describe, it, expect } from 'vitest';
import { autoRoom, autoTake, manualRoom, settleGhosts, cleanGhosts, cleanPickup, reservedSpace, miningMode, GHOST_RESERVE, type HoldView } from './holdGhosts.js';
import type { Stack } from './stacks.js';

const CAT: Record<string, string> = { iron_ore: 'mineral', ruby: 'gem', helium3: 'volatile', servo_motor: 'component', alloy_plate: 'refined' };
const hold = (cargo: Stack[], capacity = 30): HoldView => ({ cargo, capacity, volume: (id) => (id === 'alloy_plate' ? 2 : 1), category: (id) => CAT[id] });
const ON = { on: true }, OFF = { on: false };

describe('auto pickup', () => {
  it('ore comes in in mining mode; nothing else without a ghost', () => {
    const h = hold([]);
    expect(autoRoom(h, [], ON, 'iron_ore')).toBe(30);
    expect(autoRoom(h, [], ON, 'ruby')).toBe(30);
    expect(autoRoom(h, [], ON, 'helium3')).toBe(30);
    expect(autoRoom(h, [], OFF, 'iron_ore')).toBe(0);
    expect(autoRoom(h, [], ON, 'servo_motor')).toBe(0);
  });

  it('mining mode leaves blacklisted ores; a ghost of one collects it anyway, mode on or off', () => {
    const h = hold([]);
    const mode = { on: true, blacklist: ['iron_ore'] };
    expect(autoRoom(h, [], mode, 'iron_ore')).toBe(0);
    expect(autoRoom(h, [], mode, 'ruby')).toBe(30);
    expect(autoRoom(h, [{ item: 'iron_ore' }], mode, 'iron_ore')).toBe(30);
    expect(autoRoom(h, [{ item: 'iron_ore' }], OFF, 'iron_ore')).toBe(30);
    expect(miningMode(undefined)).toEqual({ on: true, blacklist: [] });
    expect(miningMode({ miningOff: true, blacklist: ['ice'] })).toEqual({ on: false, blacklist: ['ice'] });
  });

  it('an unlimited ghost always collects and keeps GHOST_RESERVE units that ore cannot use', () => {
    const h = hold([{ id: 'iron_ore', n: 20 }, { id: 'servo_motor', n: 40 }], 70);
    const ghosts = [{ item: 'servo_motor' }];
    // 10 free, 5 of them kept for servos
    expect(reservedSpace(h, ghosts)).toBe(GHOST_RESERVE);
    expect(autoRoom(h, ghosts, ON, 'iron_ore')).toBe(5);
    expect(autoRoom(h, ghosts, ON, 'servo_motor')).toBe(10);
  });

  it('a ghost with a target reserves what is still to come, collects up to it, then settles into the real stack', () => {
    const ghosts = [{ item: 'alloy_plate', n: 6 }];
    const h = hold([{ id: 'alloy_plate', n: 2 }, { id: 'iron_ore', n: 10 }], 30);
    // 30 - 4 - 10 = 16 free; 4 plates to come at volume 2 = 8 kept
    expect(autoRoom(h, ghosts, ON, 'iron_ore')).toBe(8);
    expect(autoRoom(h, ghosts, ON, 'alloy_plate')).toBe(4);
    expect(autoTake(h, ghosts, ON, { alloy_plate: 9, iron_ore: 20 })).toEqual({ alloy_plate: 4, iron_ore: 8 });
    expect(settleGhosts(ghosts, [{ id: 'alloy_plate', n: 6 }])).toEqual([]);
    expect(settleGhosts(ghosts, [{ id: 'alloy_plate', n: 5 }])).toEqual(ghosts);
    expect(settleGhosts([{ item: 'servo_motor' }], [{ id: 'servo_motor', n: 999 }])).toHaveLength(1);
  });

  it('a manual take may use reserved space, and says how much of it would', () => {
    const h = hold([{ id: 'iron_ore', n: 24 }], 30);
    expect(manualRoom(h, [{ item: 'servo_motor' }], 'ruby')).toEqual({ fit: 6, reserved: 5 });
    // (A ghost's own item is no warning)
    expect(manualRoom(h, [{ item: 'servo_motor' }], 'servo_motor')).toEqual({ fit: 6, reserved: 0 });
  });
});

describe('saved shapes', () => {
  it('ghosts: one per item, whole targets, junk dropped', () => {
    expect(cleanGhosts([{ item: 'a' }, { item: 'a', n: 3 }, { item: 'b', n: 2.7 }, { item: 'c', n: -1 }, null, { n: 4 }])).toEqual([{ item: 'a' }, { item: 'b', n: 2 }, { item: 'c' }]);
  });
  it('pickup settings: defaults leave nothing; templates named and unique', () => {
    expect(cleanPickup({})).toBeUndefined();
    expect(cleanPickup({ miningOff: true, blacklist: ['ice', 'ice', 3] })).toEqual({ miningOff: true, blacklist: ['ice'] });
    expect(cleanPickup({ templates: [{ name: ' Mining ', ghosts: [{ item: 'ruby' }] }, { name: 'Mining', ghosts: [] }, { name: '', ghosts: [] }] }))
      .toEqual({ templates: [{ name: 'Mining', ghosts: [{ item: 'ruby' }] }] });
  });
});
