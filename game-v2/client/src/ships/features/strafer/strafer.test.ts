/** The Burst Strafer's client half: its key binding's place and text, and the dodge control it sends */
import { describe, it, expect } from 'vitest';
import { ACTIONS } from '../../../input/keybindings';
import { ClientFeatures } from '../host';
import { clientFeature } from './index';
import type { ClientFeatureHost } from '../types';

describe('the strafer feature (client)', () => {
  it('its Dodge binding sits after the helm switch (and the Tow Beam\'s after it), as it always has', () => {
    const ids = ACTIONS.map((a) => a.id);
    expect(ids.slice(ids.indexOf('helm'), ids.indexOf('helm') + 4)).toEqual(['helm', 'dodge', 'tow', 'aim']);
    expect(ACTIONS.find((a) => a.id === 'dodge')).toEqual({
      id: 'dodge', label: 'Dodge (Burst Strafer)', category: 'Flight', key: 'Space', after: 'helm',
      hint: 'One hard burst a press, the way you are steering (WASD, diagonals too; forward, back and Q/E at the helm), with whichever strafers push that way; with nothing held, back the other way from last time. Ready again in under half a second; every burst costs a lot of energy',
    });
  });

  it('a press with no strafer fitted sends nothing and says so, once', () => {
    let down = false;
    const said: string[] = [];
    const host = {
      playerId: () => 1, hangarOpen: () => false, inputEnabled: () => true, isKeyDown: (c: string) => down && c === 'Space',
      ship: () => ({ kind: 'ship', derived: {}, blueprint: { parts: [] } }), entity: () => ({ dodge: 0 }),
      catalog: { functions: new Map() }, showMessage: (t: string) => said.push(t),
    } as unknown as ClientFeatureHost;
    const ctl = new ClientFeatures([clientFeature], host).controlFor('dodge');
    expect(ctl()).toBe(false);
    down = true;
    expect(ctl()).toBe(false);
    expect(ctl()).toBe(false);
    expect(said).toEqual(['No Burst Strafer fitted: build one in the hangar to dodge']);
    expect(new ClientFeatures([], host).controlFor('dodge')()).toBe(false);
  });
});
