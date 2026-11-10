/**
 * Shared gun looks (gunLooks.ts): a look is destroyed only when no ship uses it and the idle cache is full.
 */
import { describe, expect, it, vi } from 'vitest';
import { GUN_LOOKS, GUNS_IDLE, GUNS_IDLE_KEPT, gunLook, dropGun, flushGuns } from './gunLooks';

const make = () => ({ shapes: [{ pts: [0, 0, 4, 0, 4, 4], color: 0x888888 }] as never, outline: [] as number[][], k: 1 });

describe('a look is destroyed only when no ship uses it and the idle cache is full', () => {
  it('a look in use is never destroyed, an idle one is kept until the cache overflows, then the oldest goes', () => {
    const inUse = gunLook('in-use', make), inUseAgain = gunLook('in-use', make);
    expect(inUseAgain).toBe(inUse); // shared
    const gone = vi.spyOn(inUse.metal, 'destroy');
    dropGun('in-use'); // one ship still has it
    expect(GUNS_IDLE.has('in-use')).toBe(false);
    expect(gone).not.toHaveBeenCalled();

    // fill the idle cache exactly: nothing is destroyed yet
    const first = gunLook('idle-0', make);
    const firstGone = vi.spyOn(first.metal, 'destroy');
    dropGun('idle-0');
    for (let i = 1; i < GUNS_IDLE_KEPT; i++) { gunLook(`idle-${i}`, make); dropGun(`idle-${i}`); }
    expect(GUNS_IDLE.size).toBe(GUNS_IDLE_KEPT);
    expect(firstGone).not.toHaveBeenCalled();
    expect(GUN_LOOKS.has('idle-0')).toBe(true);

    // a reused idle look leaves the idle set, and is not destroyed by later overflow
    const again = gunLook('idle-1', make);
    expect(GUNS_IDLE.has('idle-1')).toBe(false);
    const againGone = vi.spyOn(again.metal, 'destroy');

    // one more idle past the cap: the oldest idle one is destroyed, the in-use and reused ones are not
    gunLook('idle-extra', make); dropGun('idle-extra');
    gunLook('idle-extra2', make); dropGun('idle-extra2');
    expect(firstGone).toHaveBeenCalledTimes(1);
    expect(GUN_LOOKS.has('idle-0')).toBe(false);
    expect(GUNS_IDLE.size).toBeLessThanOrEqual(GUNS_IDLE_KEPT);
    expect(gone).not.toHaveBeenCalled();
    expect(againGone).not.toHaveBeenCalled();

    flushGuns();
    expect(GUNS_IDLE.size).toBe(0);
    expect(GUN_LOOKS.has('in-use')).toBe(true);
  });
});
