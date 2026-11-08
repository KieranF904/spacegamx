import { describe, expect, it } from 'vitest';
import { MIN_AIM_REACH, type WeaponTuning } from '@space-game/common';
import { burstTravel } from './flakAim';

const def = (over: Partial<WeaponTuning>): WeaponTuning => ({ type: 'projectile', speed: 34, life: 50, splash: { radius: 170, damage: 16 }, endAtAim: true, ...over });

describe('flak burst marker distance', () => {
  it('is the aim distance (to the nearest tick of flight)', () => {
    expect(Math.abs(burstTravel(def({}), 1000) - 1000)).toBeLessThan(34);
  });
  it('stops at the shell life when the cursor is further', () => {
    expect(burstTravel(def({}), 9000)).toBe(34 * 50);
  });
  it('never comes in under the least aim reach, nor under the 10 ticks the server gives any aimed shell', () => {
    expect(burstTravel(def({}), 5)).toBe(10 * 34);
    expect(burstTravel(def({ speed: 10 }), 5)).toBe(MIN_AIM_REACH);
  });
  it('is none for a gun that does not end at the aim, or does not burst', () => {
    expect(burstTravel(def({ endAtAim: false }), 800)).toBe(0);
    expect(burstTravel(def({ splash: undefined }), 800)).toBe(0);
  });
});
