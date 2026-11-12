/**
 * The gun range weapon picker's choice (GunRangeHud.choose): it sends only weapons on offer, never the one already
 * flown, and nothing outside the range; a modifier chip sends the weapon flown with the effects left on (chooseMod).
 * The Ships tab (chooseShip) sends only what the server offered. Nothing in the HUD changes room: a door does, and its
 * prompt (doorHint) says where it leads.
 * The HUD's DOM is not built here (the choice does not read it).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ServerGunRangeStateMessage } from '@space-game/common';
import { testCatalog } from '../../../../common/src/ships/testData';
import { resetRangeState, setRangeState } from './rangeState';
import { GunRangeHud, doorHint } from './GunRangeHud';

const IN: ServerGunRangeStateMessage = {
  type: 'gunRangeState', in: true, weapon: 'cannon_pip', options: ['cannon_pip', 'laser_pulse'], station: 'Sol', door: { x: 0, y: 0, reach: 400 }, targets: [],
};
afterEach(() => resetRangeState());

function hud() {
  const sent: unknown[] = [];
  const sounds: string[] = [];
  const h = Object.create(GunRangeHud.prototype) as { h: unknown; choose(fn: string): void; chooseMod(e: string): void; chooseShip(id: string): void };
  h.h = { send: (m: unknown) => sent.push(m), sound: (id: string) => sounds.push(id), catalog: testCatalog() };
  return { choose: (fn: string) => h.choose(fn), chooseMod: (e: string) => h.chooseMod(e), chooseShip: (id: string) => h.chooseShip(id), sent, sounds };
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

describe('a modifier chip sends the weapon flown with the effects it leaves on', () => {
  const MODS = { ...IN, mods: ['burn'], modOptions: ['velocity', 'rapid', 'burn'] };

  it('one turned on joins the ones on, one turned off leaves; nothing for an effect not on offer or outside the range', () => {
    const t = hud();
    t.chooseMod('velocity'); // outside the range
    expect(t.sent).toEqual([]);
    setRangeState(MODS);
    t.chooseMod('chain'); // not on offer
    expect(t.sent).toEqual([]);
    t.chooseMod('velocity');
    t.chooseMod('burn');
    expect(t.sent).toEqual([
      { type: 'gunRangeWeapon', model: 'cannon_pip', mods: ['velocity', 'burn'] },
      { type: 'gunRangeWeapon', model: 'cannon_pip', mods: [] },
    ]);
  });

  it('a gun that fires on ammunition alone takes none: its chips send nothing', () => {
    const t = hud();
    setRangeState({ ...MODS, weapon: 'flak_burst' });
    t.chooseMod('velocity');
    expect(t.sent).toEqual([]);
  });
});

describe('the Ships tab sends only what the server offered; rooms are changed at their doors', () => {
  const ROOMS = { ...IN, room: 'targets', mods: ['burn'], modOptions: ['velocity', 'burn'] };
  const SHIPS = [{ id: 'starter', name: 'Starter', group: 'Library' }, { id: 'mod-showcase-1', name: 'Modifier showcase', group: 'Dev test ships' }];

  it('the HUD has no room switch: no way to ask for a room, no control for one, and no room message in what it can send', () => {
    expect((GunRangeHud.prototype as unknown as Record<string, unknown>).chooseRoom).toBeUndefined();
    const src = [GunRangeHud.toString(), doorHint.toString()].join('\n');
    expect(src).not.toMatch(/gunRangeRoom|gr-rooms|data-room/);
  });

  it('the door prompt says where the door leads: the station at the exit, the room at any other', () => {
    expect(doorHint('X', 'exit', 'Sol Central')).toBe('Press <kbd>X</kbd> to leave the range · back to <b>Sol Central</b>');
    expect(doorHint('X', 'exit', '')).toBe('Press <kbd>X</kbd> to leave the range');
    expect(doorHint('F', 'dark', 'Dark room')).toBe('Press <kbd>F</kbd> to go through · <b>Dark room</b>');
    expect(doorHint('X', 'targets', 'Targets')).toContain('<b>Targets</b>');
    expect(doorHint('<', 'dark', '<i>')).not.toMatch(/<i>|<kbd><</);
  });

  it('a pilot who was sent no ships can ask for none', () => {
    const t = hud();
    setRangeState(ROOMS);
    t.chooseShip('mod-showcase-1');
    t.chooseShip('starter');
    expect(t.sent).toEqual([]);
  });

  it('an admin: a ship on the list is sent, the one flown and one not listed are not; flying it, chips send nothing and any weapon on offer goes back', () => {
    const t = hud();
    setRangeState({ ...ROOMS, ships: SHIPS });
    t.chooseShip('no-such-ship');
    expect(t.sent).toEqual([]);
    t.chooseShip('mod-showcase-1');
    expect(t.sent).toEqual([{ type: 'gunRangeShip', ship: 'mod-showcase-1' }]);
    // (the server says it is flown now)
    setRangeState({ type: 'gunRangeState', in: true, ship: 'mod-showcase-1' });
    t.chooseShip('mod-showcase-1');
    t.chooseMod('velocity');
    expect(t.sent).toHaveLength(1);
    // (the weapon it last carried is a way back, like any other on offer)
    t.choose('cannon_pip');
    t.choose('railgun_rail_driver'); // not on offer, as ever
    expect(t.sent.slice(1)).toEqual([{ type: 'gunRangeWeapon', model: 'cannon_pip' }]);
  });
});
