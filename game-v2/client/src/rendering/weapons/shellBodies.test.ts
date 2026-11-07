import { describe, expect, it } from 'vitest';
import { WeaponType } from '@space-game/common';
import { fuseFraction, lampPeriod } from './shellBodies';
import { weaponStyle } from './weaponStyles';

describe('shell bodies', () => {
  it("runs the fuse from the shell's own end tick, else the tick it is known to end on", () => {
    expect(fuseFraction(100, 100, 150, Infinity)).toBe(0);
    expect(fuseFraction(125, 100, 150, Infinity)).toBeCloseTo(0.5);
    expect(fuseFraction(150, 100, 150, Infinity)).toBe(1);
    expect(fuseFraction(999, 100, 150, Infinity)).toBe(1);
    // no endTick: the known end
    expect(fuseFraction(110, 100, 0, 120)).toBeCloseTo(0.5);
    // no end known at all: the ring stays full
    expect(fuseFraction(500, 100, 0, Infinity)).toBe(0);
  });

  it('blinks the lamp four times as fast at the burst', () => {
    expect(lampPeriod(0)).toBe(20);
    expect(lampPeriod(1)).toBe(4);
    expect(lampPeriod(2)).toBe(4);
    expect(lampPeriod(-1)).toBe(20);
  });

  it('gives the missile and flak families their bodies, and leaves the Hammerhead its own', () => {
    expect(weaponStyle(WeaponType.Missile).shell?.kind).toBe('dart');
    expect(weaponStyle(WeaponType.Missile, 1, 'missile_dart').shell?.kind).toBe('dart');
    expect(weaponStyle(WeaponType.Missile, 1, 'missile_swarm').shell?.kind).toBe('dart');
    expect(weaponStyle(WeaponType.Missile, 1, 'missile_hammerhead').shell).toBeUndefined();
    expect(weaponStyle(WeaponType.Flak).shell?.kind).toBe('canister');
    expect(weaponStyle(WeaponType.Flak, 1, 'flak_cloudmaker').shell?.kind).toBe('canister');
    expect(weaponStyle(WeaponType.Cannon).shell).toBeUndefined();
  });
});
