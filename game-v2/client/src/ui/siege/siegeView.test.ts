import { describe, it, expect } from 'vitest';
import type { ServerSiegeStateMessage } from '@space-game/common';
import { focusState, frontMarkers, nextOrders, padName, padsInReach } from './siegeView';
import { compass } from './compass';

const base: ServerSiegeStateMessage = { type: 'siegeState', active: true, phase: 'night' };

describe('siege panel and HUD', () => {
  it('fronts on their way show as markers with a countdown; past or far-off ones do not', () => {
    const m = { ...base, incoming: [{ x: 0, y: -7000, at: 1000 + 12 * 60, ships: 5 }, { x: 7000, y: 0, at: 1000 + 90 * 60, ships: 3 }, { x: 1, y: 1, at: 900, ships: 1, boss: true }] };
    const k = frontMarkers(m, 1000);
    expect(k).toEqual([{ name: 'Front · 12s · 5', x: 0, y: -7000 }]);
    expect(frontMarkers({ ...base, incoming: [{ x: 0, y: 0, at: 1060, ships: 1, boss: true }] }, 1000)[0].name).toMatch(/^Boss front · 1s/);
    expect(frontMarkers({ ...m, active: false }, 1000)).toEqual([]);
  });

  it('at night, only empty pads close to you can be built on', () => {
    const b = { x: 100, y: 100, slots: [{ x: 500, y: 0 }, { x: -500, y: 0 }, { x: 0, y: 500 }] };
    const night = { buildCost: 1.5, buildReach: 400, mendReach: 300, mendSeconds: 3, mendCost: 20, mendHeal: 0.15, bastionReach: 560, bastionCost: 45, bastionHeal: 0.1 };
    const turret = { label: 'Cannon turret I', mark: 1, hull: 100, refund: 50 };
    const m = { ...base, night, turrets: [null, turret, null] };
    expect(padsInReach(m, b, { x: 650, y: 150 })).toEqual([0]);
    // Pad 1's taken
    expect(padsInReach(m, b, { x: -350, y: 100 })).toEqual([]);
    expect(padsInReach(m, b, { x: 100, y: 1000 })).toEqual([2]);
    expect(padsInReach(m, null, { x: 0, y: 0 })).toEqual([]);
  });

  it('orders cycle; focus fire reads on, cooling down or ready', () => {
    const list = [{ id: 'nearest' }, { id: 'bastion' }, { id: 'toughest' }];
    expect(nextOrders(list, 'nearest')).toBe('bastion');
    expect(nextOrders(list, 'toughest')).toBe('nearest');
    expect(nextOrders(list, undefined)).toBe('nearest');
    expect(focusState({ ...base, focus: { readyAt: 2200, target: 5, until: 1480 } }, 1000)).toEqual({ kind: 'on', secs: 8 });
    expect(focusState({ ...base, focus: { readyAt: 2200 } }, 1000)).toEqual({ kind: 'wait', secs: 20 });
    expect(focusState({ ...base, focus: { readyAt: 0 } }, 1000)).toEqual({ kind: 'ready', secs: 0 });
    expect(focusState(base, 1000)).toBeNull();
  });

  it('pads and fronts are named by their side of the bastion (screen up is north)', () => {
    expect(compass(0, -100)).toBe('north');
    expect(compass(100, 0)).toBe('east');
    expect(compass(-100, 100)).toBe('south-west');
    expect(padName({ x: 0, y: 0, slots: [{ x: 0, y: 560 }] }, 0)).toBe('Pad 1 · south');
  });
});
