/**
 * Docking (DockControl): undock puts the ship back where it came in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientMessage } from '@space-game/common';
import { DockControl, type DockHost } from './DockControl';

// (no DOM here: the hint boxes are plain objects)
beforeEach(() => {
  const el = () => ({ style: {} as Record<string, string>, dataset: {} as Record<string, string> });
  vi.stubGlobal('document', { createElement: el, body: { appendChild: () => {} } });
});
afterEach(() => vi.unstubAllGlobals());

describe('undock puts the ship back where it came in', () => {
  it('out at the station plus the berth offset it came in by, at rest, and the berth cleared', () => {
    const sent: ClientMessage[] = [];
    const station = { x: 4000, y: -2500 }, me = { x: 4000, y: -2500, vx: 3, vy: -2 };
    const entities = new Map<number, unknown>([[9, station], [1, me]]);
    const refreshed: number[] = [];
    const host = {
      state: { playerId: 1, entities },
      send: (m: ClientMessage) => sent.push(m),
      refreshShip: (id: number) => refreshed.push(id),
    } as unknown as DockHost;
    const d = new DockControl(host);
    d.docked = true;
    d.berth = { station: 9, ox: 120, oy: -75 };
    d.undock();
    expect(sent).toEqual([{ type: 'undock' }]);
    expect(me).toEqual({ x: 4120, y: -2575, vx: 0, vy: 0 });
    expect(d.docked).toBe(false);
    expect(d.berth).toBeNull();
    expect(refreshed).toEqual([1]);
  });
});
