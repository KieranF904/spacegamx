/** The client feature host (host.ts): flattening and order, with stand-in features (none are registered) */
import { describe, it, expect } from 'vitest';
import { ClientFeatures } from './host';
import { CLIENT_FEATURES } from './index';
import type { ClientFeature, ClientFeatureHost, ShipDrawCtx } from './types';

const HOST = {} as ClientFeatureHost;

describe('ClientFeatures', () => {
  it('with no features every loop is empty', () => {
    expect(CLIENT_FEATURES.map((s) => s.id)).toEqual(['strafer', 'tow']);
    const f = new ClientFeatures([], HOST);
    expect(f.onKey('KeyU')).toBe(false);
    expect(f.hasDrawers).toBe(false);
    expect(f.hasParsers).toBe(false);
    f.updateIndicators();
  });

  it('runs keys, parsers, drawers and chips in id order; the first key user wins', () => {
    const log: string[] = [];
    const make = (id: string, key: string): ClientFeature => ({
      id,
      onKey: (code, host) => { log.push(`key ${id} ${code}`); expect(host).toBe(HOST); return code === key; },
      parsePilot: (data, at, fx) => { fx[id] = data[at]; },
      drawShip: () => { log.push(`draw ${id}`); },
      indicator: { update: () => { log.push(`chip ${id}`); } },
    });
    const f = new ClientFeatures([make('b', 'KeyB'), make('a', 'KeyA')], HOST);
    expect(f.onKey('KeyA')).toBe(true);
    expect(f.onKey('KeyB')).toBe(true);
    expect(f.onKey('KeyZ')).toBe(false);
    const fx: { [k: string]: number } = {};
    f.parsePilot([9, 8, 7], 1, fx);
    expect(fx).toEqual({ a: 8, b: 8 });
    f.drawShip({} as ShipDrawCtx);
    f.updateIndicators();
    expect(log).toEqual(['key a KeyA', 'key a KeyB', 'key b KeyB', 'key a KeyZ', 'key b KeyZ', 'draw a', 'draw b', 'chip a', 'chip b']);
    expect(() => new ClientFeatures([make('a', 'x'), make('a', 'y')], HOST)).toThrow(/listed twice/);
  });
});
