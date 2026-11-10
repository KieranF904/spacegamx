// Pins client.predict.kind.shells: a tick whose lane records changed has its drawn shells taken back and the new ones drawn.
// The gun lanes are faked (laneRecords passes the "events" through as records) so only the kind's bookkeeping is under test.
import { describe, it, expect, vi } from 'vitest';

vi.mock('@space-game/common', async (orig) => ({
  ...(await orig<typeof import('@space-game/common')>()),
  laneRecords: (events: unknown[], _s: unknown, _t: unknown, out: unknown[] = []) => { out.length = 0; out.push(...events); return out; },
}));

import { ShellsKind } from './kinds/shellsKind';

const rec = (tick: number, n: number) => ({ tick, part: 0, code: 0, aimQ: 0, aug: 0, n });

function setup() {
  const events = new Map<number, unknown[]>();
  const drawn: number[] = [], retracted: number[] = [];
  let handle = 0, confirmed = 10;
  const host = {
    layer: { addTrack: () => {}, head: 20, ids: () => new Set([1]), ring: { get: (_id: number, t: number) => ({ body: { x: t, y: 0, angle: 0 } }) } },
    kind: () => 'ai',
    ship: () => ({}),
    guns: { has: () => true, eventsAt: (_id: number, t: number) => events.get(t) ?? [], stateAt: () => undefined, ctlAt: () => undefined, hashAt: () => undefined },
    tuning: {},
    env: () => ({}),
    confirmed: () => confirmed,
    pose: (_id: number, t: number) => ({ x: t, y: 0, angle: 0 }),
    draw: () => { const h = ++handle; drawn.push(h); return [h]; },
    retract: (h: number) => { retracted.push(h); },
  };
  return { k: new ShellsKind(host as never), events, drawn, retracted, setConfirmed: (c: number) => { confirmed = c; } };
}

describe('ShellsKind', () => {
  it('draws a fired record once, however many advances see it', () => {
    const s = setup();
    s.events.set(12, [rec(12, 1)]);
    s.k.advance(15);
    s.k.advance(15);
    s.k.advance(16);
    expect(s.drawn).toEqual([1]);
    expect(s.retracted).toEqual([]);
    expect(s.k.stats.ahead).toBe(1);
  });

  it('a tick whose records changed has its shells taken back and the new ones drawn', () => {
    const s = setup();
    s.events.set(12, [rec(12, 1)]);
    s.k.advance(15);
    // (a re-stepped ship fires two now)
    s.events.set(12, [rec(12, 2)]);
    s.k.advance(15);
    expect(s.retracted).toEqual([1]);
    expect(s.drawn).toEqual([1, 2]);
    expect(s.k.stats.wrong).toBe(1);
    // (a trigger let go: taken back, nothing drawn in its place)
    s.events.set(12, []);
    s.k.advance(15);
    expect(s.retracted).toEqual([1, 2]);
    expect(s.drawn).toEqual([1, 2]);
  });

  it('the snapshots making a tick final take back what was drawn otherwise than the tick layer fired it', () => {
    const s = setup();
    s.k.confirm(10);
    s.events.set(12, [rec(12, 1)]);
    s.k.advance(15);
    // The tick layer's lane fired something else on 12
    s.events.set(12, [rec(12, 3)]);
    s.setConfirmed(13);
    s.k.confirm(13);
    expect(s.retracted).toEqual([1]);
    expect(s.k.stats.wrong).toBe(1);
  });

  it('and one that agrees is kept', () => {
    const s = setup();
    s.k.confirm(10);
    s.events.set(12, [rec(12, 1)]);
    s.k.advance(15);
    s.k.confirm(13);
    expect(s.retracted).toEqual([]);
  });
});
