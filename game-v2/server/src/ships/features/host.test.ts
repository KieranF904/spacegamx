/**
 * The server feature host (host.ts): flattening, order, refusals, and that the generated list is empty-safe.
 * Stand-in features only (the Tow Beam is the one registered feature).
 */
import { describe, it, expect } from 'vitest';
import { ServerFeatures } from './host.js';
import { SERVER_FEATURES } from './index.js';
import type { FeatureHost, ServerFeature } from './types.js';

const HOST = {} as FeatureHost;

describe('ServerFeatures', () => {
  it('with no features every call is a no-op', () => {
    const f = new ServerFeatures([], HOST);
    f.tick(); f.onShipRebuilt(1); f.onLeave(1);
    expect(f.cargoMass(1)).toBe(0);
    expect(f.wire(1, [])).toBe(0);
    expect(f.status('tow', 1)).toBe(0);
    expect(f.messages.size).toBe(0);
    expect(SERVER_FEATURES.map((s) => s.id)).toEqual(['flash', 'machines', 'strafer', 'support', 'tow', 'weaponry']);
  });

  it('runs hooks in id order, sums cargo, concatenates wire values', () => {
    const log: string[] = [];
    const make = (id: string, mass: number, wire: number[]): ServerFeature => ({
      id,
      create: (host) => {
        expect(host).toBe(HOST);
        return {
          tick: () => { log.push(`tick ${id}`); },
          cargoMass: (eid) => mass * eid,
          wire: (_eid, out) => { for (let i = 0; i < wire.length; i++) out[i] = wire[i]; return wire.length; },
          status: () => mass,
          onShipRebuilt: (eid) => { log.push(`rebuilt ${id} ${eid}`); },
          onLeave: (eid) => { log.push(`leave ${id} ${eid}`); },
        };
      },
    });
    const f = new ServerFeatures([make('b', 2, [7, 8]), make('a', 1, [5])], HOST);
    expect(f.list()).toEqual(['a', 'b']);
    f.tick(); f.onShipRebuilt(3); f.onLeave(4);
    expect(log).toEqual(['tick a', 'tick b', 'rebuilt a 3', 'rebuilt b 3', 'leave a 4', 'leave b 4']);
    expect(f.cargoMass(10)).toBe(30);
    const out: number[] = [];
    expect(f.wire(1, out)).toBe(3);
    expect(out).toEqual([5, 7, 8]);
    expect(f.wire(1, out, 2)).toBe(5);
    expect(out).toEqual([5, 7, 5, 7, 8]);
    expect(f.status('b', 1)).toBe(2);
  });

  it('collects messages and refuses a clash with another feature or the game', () => {
    const got: [number, unknown][] = [];
    const a: ServerFeature = { id: 'a', create: () => ({ messages: { zap: (eid, m) => { got.push([eid, m]); } } }) };
    const f = new ServerFeatures([a], HOST, new Set(['chat']));
    f.messages.get('zap')!(5, { on: true });
    expect(got).toEqual([[5, { on: true }]]);
    const b: ServerFeature = { id: 'b', create: () => ({ messages: { zap: () => {} } }) };
    expect(() => new ServerFeatures([a, b], HOST)).toThrow(/two handlers/);
    const c: ServerFeature = { id: 'c', create: () => ({ messages: { chat: () => {} } }) };
    expect(() => new ServerFeatures([c], HOST, new Set(['chat']))).toThrow(/already handled/);
    expect(() => new ServerFeatures([a, a], HOST)).toThrow(/listed twice/);
  });
});
