/**
 * The client's gun range state (rangeState.ts) and what gunRangeState does (rangeMessages.ts): in only between an
 * `in: true` and the next `in: false`; going in lets the berth go and puts the station screen away without sending
 * anything; the chamber and its door are the systems.json ones the server's walls come from.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { atRangeDoor, rangeDoor, type ServerGunRangeStateMessage } from '@space-game/common';
import { chamberOf, inGunRange, rangeState, rangeVersion, resetRangeState, setRangeState } from './rangeState';
import { onGunRangeState, type RangeMessageHost } from './rangeMessages';

const IN: ServerGunRangeStateMessage = {
  type: 'gunRangeState', in: true, weapon: 'cannon_pip', options: ['cannon_pip', 'laser_pulse'], station: 'Sol Central Station',
  door: { x: -3000, y: 0, reach: 420 }, target: { id: 12, x: 1900, y: 0 },
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
    expect(rangeState().weapon).toBe('laser_pulse');
    expect(rangeVersion()).toBeGreaterThan(v);
    expect(setRangeState({ type: 'gunRangeState', in: false, station: 'Sol Central Station' })).toEqual({ entered: false, left: true });
    expect(inGunRange()).toBe(false);
    expect(rangeState().options).toEqual([]);
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
    const door = rangeDoor(def!);
    expect(atRangeDoor(def!, door.x + door.nx * (def!.door.reach - 5), door.y)).toBe(true);
    expect(atRangeDoor(def!, door.x + door.nx * (def!.door.reach + 5), door.y)).toBe(false);
    expect(atRangeDoor(def!, def!.spawn.x, def!.spawn.y)).toBe(false);
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
