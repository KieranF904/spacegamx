/**
 * The client's gun range state (rangeState.ts) and what gunRangeState does (rangeMessages.ts): in only between an
 * `in: true` and the next `in: false`; going in lets the berth go and puts the station screen away without sending
 * anything; the chamber and its door are the systems.json ones the server's walls come from.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { doorTo, exitDoor, rangeDoor, rangeDoorAt, type ServerGunRangeStateMessage } from '@space-game/common';
import { chamberOf, inGunRange, rangeState, rangeVersion, resetRangeState, roomName, setRangeState } from './rangeState';
import { onGunRangeState, type RangeMessageHost } from './rangeMessages';

const IN: ServerGunRangeStateMessage = {
  type: 'gunRangeState', in: true, weapon: 'cannon_pip', options: ['cannon_pip', 'laser_pulse'], station: 'Sol Central Station',
  door: { x: -3000, y: 0, reach: 420 }, targets: [{ id: 12, x: 1900, y: 0, label: "Mammoth" }],
};

afterEach(() => resetRangeState());

describe('gun range state', () => {
  it('in from an in: true state to the next in: false; the weapon and options kept as sent', () => {
    expect(inGunRange()).toBe(false);
    expect(setRangeState(IN)).toEqual({ entered: true, left: false });
    expect(inGunRange()).toBe(true);
    expect(rangeState().weapon).toBe('cannon_pip');
    // (a later state with only some fields keeps the rest)
    const v = rangeVersion();
    expect(setRangeState({ type: 'gunRangeState', in: true, weapon: 'laser_pulse' })).toEqual({ entered: false, left: false });
    expect(rangeState().options).toEqual(IN.options);
    // (the modifiers too: kept until a state says otherwise)
    expect(rangeState().mods).toEqual([]);
    setRangeState({ type: 'gunRangeState', in: true, mods: ['burn'], modOptions: ['velocity', 'burn'] });
    setRangeState({ type: 'gunRangeState', in: true, weapon: 'laser_pulse' });
    expect(rangeState().mods).toEqual(['burn']);
    expect(rangeState().modOptions).toEqual(['velocity', 'burn']);
    expect(rangeState().weapon).toBe('laser_pulse');
    expect(rangeVersion()).toBeGreaterThan(v);
    expect(setRangeState({ type: 'gunRangeState', in: false, station: 'Sol Central Station' })).toEqual({ entered: false, left: true });
    expect(inGunRange()).toBe(false);
    expect(rangeState().options).toEqual([]);
  });

  it('the room is kept as sent; the library ship flown is whatever the last state said, the list kept until out', () => {
    const SHIPS = [{ id: 'mod-showcase-1', name: 'Modifier showcase', group: 'Dev test ships' }];
    setRangeState({ ...IN, room: 'targets' });
    expect(rangeState().room).toBe('targets');
    // (nobody but an admin is ever sent ships: none, and no ship flown)
    expect(rangeState().ships).toEqual([]);
    expect(rangeState().ship).toBe('');
    expect(chamberOf('gun_range')!.id).toBe('targets');
    setRangeState({ type: 'gunRangeState', in: true, room: 'dark', ship: 'mod-showcase-1', ships: SHIPS });
    expect(rangeState().room).toBe('dark');
    expect(rangeState().ship).toBe('mod-showcase-1');
    // (the chamber follows the room: its door and floor are the dark room's now)
    expect(chamberOf('gun_range')!.id).toBe('dark');
    expect(chamberOf('gun_range')!.light).toBeLessThan(1);
    // (a target going down says no list: kept. A state without `ship` is the cheat ship again)
    setRangeState({ type: 'gunRangeState', in: true, room: 'dark', ship: 'mod-showcase-1', targets: [] });
    expect(rangeState().ships).toEqual(SHIPS);
    setRangeState({ type: 'gunRangeState', in: true, weapon: 'laser_pulse' });
    expect(rangeState().ship).toBe('');
    expect(rangeState().ships).toEqual(SHIPS);
    setRangeState({ type: 'gunRangeState', in: false });
    expect(rangeState().ships).toEqual([]);
    expect(rangeState().room).toBe('');
    expect(chamberOf('gun_range')!.id).toBe('targets');
  });

  it('a refusal never takes you in', () => {
    expect(setRangeState({ type: 'gunRangeState', in: false, error: 'Dock at a station first' })).toEqual({ entered: false, left: false });
    expect(inGunRange()).toBe(false);
  });

  it('a disconnect drops the client\'s side of it', () => {
    setRangeState(IN);
    resetRangeState();
    expect(inGunRange()).toBe(false);
  });

  it('the chamber is the gun range system\'s, and the door prompt shows by the server\'s own rule', () => {
    const def = chamberOf('gun_range');
    expect(def).not.toBeNull();
    expect(chamberOf('sol')).toBeNull();
    const exit = exitDoor(def!), door = rangeDoor(def!);
    expect(rangeDoorAt(def!, door.x + door.nx * (exit.reach - 5), door.y)).toBe(exit);
    expect(rangeDoorAt(def!, door.x + door.nx * (exit.reach + 5), door.y)).toBeUndefined();
    expect(rangeDoorAt(def!, def!.spawn.x, def!.spawn.y)).toBeUndefined();
    // (the door across the room leads to the dark room, and is named for it)
    const on = doorTo(def!, 'dark')!, p = rangeDoor(def!, on);
    expect(rangeDoorAt(def!, p.x + p.nx * 100, p.y)).toBe(on);
    expect(roomName('gun_range', on.to)).toBe('Dark room');
    expect(roomName('gun_range', 'targets')).toBe('Targets');
    expect(roomName('gun_range', 'exit')).toBe('');
    expect(roomName('sol', 'dark')).toBe('');
  });
});

describe('gunRangeState on the client', () => {
  const host = () => {
    const sent: unknown[] = [];
    const close = vi.fn(), leftBerth = vi.fn(), show = vi.fn();
    const h: RangeMessageHost & { sent: unknown[] } = {
      sent,
      shipClient: { leftBerth, hangarOpen: false },
      stationWindow: { value: { isOpen: true, close } },
      toasts: { show },
      audio: { playUI: () => {} },
    };
    return { h, close, leftBerth, show };
  };

  it('going in lets the berth go before the station screen closes, and sends nothing', () => {
    const { h, close, leftBerth } = host();
    onGunRangeState(h, IN);
    expect(leftBerth).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(leftBerth.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0]);
    expect(h.sent).toEqual([]);
    // (a weapon change while in does neither again)
    onGunRangeState(h, { type: 'gunRangeState', in: true, weapon: 'laser_pulse' });
    expect(leftBerth).toHaveBeenCalledOnce();
  });

  it('a refusal is shown, and nothing else changes', () => {
    const { h, close, leftBerth, show } = host();
    onGunRangeState(h, { type: 'gunRangeState', in: false, error: 'Finish or leave training first' });
    expect(show).toHaveBeenCalledWith('Finish or leave training first', 'warn');
    expect(close).not.toHaveBeenCalled();
    expect(leftBerth).not.toHaveBeenCalled();
  });
});
