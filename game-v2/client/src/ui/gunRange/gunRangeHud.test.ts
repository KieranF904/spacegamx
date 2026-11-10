/**
 * The gun range weapon picker's choice (GunRangeHud.choose): it sends only weapons on offer, never the one already
 * flown, and nothing outside the range. The HUD's DOM is not built here (the choice does not read it).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ServerGunRangeStateMessage } from '@space-game/common';
import { resetRangeState, setRangeState } from './rangeState';
import { GunRangeHud } from './GunRangeHud';

const IN: ServerGunRangeStateMessage = {
  type: 'gunRangeState', in: true, weapon: 'cannon_pip', options: ['cannon_pip', 'laser_pulse'], station: 'Sol', door: { x: 0, y: 0, reach: 400 }, targets: [],
};
afterEach(() => resetRangeState());

function hud() {
  const sent: unknown[] = [];
  const sounds: string[] = [];
  const h = Object.create(GunRangeHud.prototype) as { h: unknown; choose(fn: string): void };
  h.h = { send: (m: unknown) => sent.push(m), sound: (id: string) => sounds.push(id) };
  return { choose: (fn: string) => h.choose(fn), sent, sounds };
}

describe('the picker sends only weapons on offer, and never the one already flown', () => {
  it('a weapon on offer is sent; the flown one, one not on offer, and anything outside the range are not', () => {
    const t = hud();
    t.choose('laser_pulse'); // outside the range: nothing
    expect(t.sent).toEqual([]);
    setRangeState(IN);
    t.choose('cannon_pip'); // the one flown
    t.choose('railgun_rail_driver'); // not on offer
    expect(t.sent).toEqual([]);
    t.choose('laser_pulse');
    expect(t.sent).toEqual([{ type: 'gunRangeWeapon', model: 'laser_pulse' }]);
    expect(t.sounds).toEqual(['ui_click']);
  });
});
