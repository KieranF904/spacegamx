/** Keys in the gun range (rangeKeys.ts): the picker folds on I; build, hangar, jump and items are refused; the rest flies. */

import { describe, expect, it } from 'vitest';
import { ACTIONS } from '../../input/keybindings';
import { rangeKey } from './rangeKeys';

const off = { digitGroups: false }, on = { digitGroups: true };
const key = (id: string) => ACTIONS.find((a) => a.id === id)?.key;

describe('gun range keys', () => {
  it('the inventory key folds the weapon picker', () => {
    expect(rangeKey(key('inventory')!, off)).toEqual({ fold: true });
  });

  it('the build view, the field machines, the hangar and the jump drive are refused with a reason', () => {
    for (const code of ['Digit7', 'Digit8', 'Digit9', key('dock')!, key('jump')!]) expect(rangeKey(code, off)).toHaveProperty('say');
  });

  it('the quick bar is refused, unless the digits pick weapon groups', () => {
    for (const code of ['Digit1', 'Digit5']) {
      expect(rangeKey(code, off)).toHaveProperty('say');
      expect(rangeKey(code, on)).toBeNull();
    }
  });

  it('flying, firing, groups, targeting, the map, chat, respawn and X (the door) are never taken', () => {
    for (const id of ['forward', 'backward', 'left', 'right', 'strafeLeft', 'strafeRight', 'boost', 'helm', 'targetNext', 'groupPrev', 'groupNext',
      'groupRight', 'targetCursor', 'ping', 'interact', 'respawn', 'map', 'menu', 'chat', 'nav', 'camera']) {
      const code = key(id);
      expect(code, id).toBeTruthy();
      expect(rangeKey(code!, off), id).toBeNull();
    }
  });
});
