/**
 * A spreading fire's look (damage/fires.ts) over a recording stand-in for the particle field: bounded however much
 * burns (fires kept, parts a ship that throw particles, particles a frame, chars kept), a fire ends with its time or
 * its part and only one that burned out leaves a char, and a fire without `gen` is not drawn here at all.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'path';
import { createShipState, EntityType, type ShipState } from '@space-game/common';
import { loadShipConfigCached } from '../../../../server/src/ships/loadShipConfig';
import { createShipBridge } from '../../../../server/src/ships/createShipBridge';
import { DamageCtx } from './context';
import { AmbientFx } from './ambient';
import { PartFires, FIRE_CAPS } from './fires';

const bridge = createShipBridge(loadShipConfigCached(join(__dirname, '../../../../data')));
const { catalog, tuning } = bridge;

type Call = [string, ...unknown[]];
function recorder(calls: Call[], path = 'p'): unknown {
  return new Proxy(() => {}, {
    get: (_t, name) => (name === 'ps' ? [] : recorder(calls, `${path}.${String(name)}`)),
    apply: (_t, _this, args) => { calls.push([path, ...args]); return undefined; },
  });
}

/** `ships` ships (ids 1..ships), each a hauler with every part standing, a cell apart in the particle field's eyes */
function rig(ships = 1) {
  const calls: Call[] = [];
  const bodies = new Map<number, ShipState>(), entities = new Map<number, unknown>();
  for (let id = 1; id <= ships; id++) {
    bodies.set(id, createShipState(catalog, tuning, id, bridge.library.get('hauler')!, 0) as ShipState);
    entities.set(id, { type: EntityType.ShipBody, renderX: id * 1000, renderY: 50, renderAngle: 0, vx: 1, vy: 0, data: [0, 100, 0] });
  }
  const parts = bodies.get(1)!.hp.length;
  const source = { bodies, get: (id: number) => bodies.get(id), geometry: () => Array.from({ length: parts }, (_, i) => ({ centroid: [i % 6, Math.floor(i / 6)] })), tuning, catalog };
  const c = new DamageCtx(recorder(calls) as never, source as never, { entities, playerId: 1 } as never, () => {}, 100);
  return { c, calls, bodies, parts };
}
/** Particles a run of calls made (a burst of sparks counted by its number) */
const made = (calls: Call[]) => calls.reduce((n, k) => n + (k[0] === 'p.push' || k[0] === 'p.glow' || k[0] === 'p.dustPuff' ? 1 : k[0] === 'p.burstSparks' ? (k[5] as number) : 0), 0);
const discs = (calls: Call[]) => calls.filter((k) => k[0] === 'p.rings.disc' || k[0] === 'p.char').length;

afterEach(() => vi.restoreAllMocks());

describe('a spreading fire\'s look is bounded', () => {
  it('many parts alight on many ships: never more than the frame\'s particles, whatever the dice, flares counted', () => {
    // (every roll says yes: the most it could ever make)
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { c, calls, parts } = rig(12);
    const fx = new PartFires(c);
    for (let id = 1; id <= 12; id++) for (let p = 0; p < parts; p++) fx.onIgnite(id, p, 600, 1 + (p % 4));
    // (all those catching in one frame: their flares are inside the frame's budget too)
    expect(made(calls)).toBeLessThanOrEqual(FIRE_CAPS.perFrame);
    expect(fx.counts.fires).toBeLessThanOrEqual(FIRE_CAPS.fires);
    expect(fx.counts.fires).toBe(Math.min(FIRE_CAPS.fires, 12 * parts));
    for (const frames of [1, 1, 2, 4, 1]) {
      calls.length = 0;
      c.time += frames / 60;
      fx.emit(frames);
      expect(made(calls)).toBeLessThanOrEqual(FIRE_CAPS.perFrame);
      expect(made(calls)).toBeGreaterThan(0);
      expect(fx.lastMade).toBe(made(calls));
    }
  });

  it('one ship with more parts alight than the cap: only that many throw particles; every one still glows', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { c, calls, parts } = rig(1);
    const fx = new PartFires(c), n = Math.min(parts, FIRE_CAPS.perShip + 6);
    expect(n).toBeGreaterThan(FIRE_CAPS.perShip);
    for (let p = 0; p < n; p++) fx.onIgnite(1, p, 600, 1);
    c.time += 1;
    calls.length = 0;
    fx.emit(1);
    // (two tongues, an ember and a wisp at most from each part that throws any)
    expect(made(calls)).toBeLessThanOrEqual(FIRE_CAPS.perShip * 4);
    calls.length = 0;
    fx.draw();
    expect(discs(calls)).toBe(n * 2);
  });

  it('chars: no more than the cap kept, each gone after its seconds', () => {
    const { c, parts } = rig(8);
    const fx = new PartFires(c);
    for (let id = 1; id <= 8; id++) for (let p = 0; p < Math.min(parts, 10); p++) fx.onIgnite(id, p, 30, 2);
    c.time += 1;
    fx.emit(1);
    expect(fx.counts.fires).toBe(0);
    expect(fx.counts.chars).toBe(Math.min(FIRE_CAPS.scorch, 8 * Math.min(parts, 10)));
    c.time += FIRE_CAPS.scorchSecs + 0.1;
    fx.emit(1);
    expect(fx.counts.chars).toBe(0);
  });
});

describe('a spreading fire ends with its time or its part', () => {
  it('its time up: no more flames, a char left where it burned, that glows no more', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { c, calls } = rig();
    const fx = new PartFires(c);
    fx.onIgnite(1, 2, 60, 1);
    c.time = 0.5;
    calls.length = 0;
    fx.emit(1);
    expect(calls.filter((k) => k[0] === 'p.push').length).toBeGreaterThan(0);
    c.time = 1.2;
    calls.length = 0;
    fx.emit(1);
    expect(calls.filter((k) => k[0] === 'p.push')).toEqual([]);
    expect(fx.counts).toEqual({ fires: 0, chars: 1 });
    calls.length = 0;
    fx.draw();
    expect(calls.filter((k) => k[0] === 'p.char')).toHaveLength(1);
  });

  it('its part gone: nothing left, not even a char', () => {
    const { c, bodies } = rig();
    const fx = new PartFires(c);
    fx.onIgnite(1, 2, 600, 1);
    bodies.get(1)!.derived.alive[2] = false;
    c.time = 0.2;
    fx.emit(1);
    expect(fx.counts).toEqual({ fires: 0, chars: 0 });
  });

  it('lit again: as long as the longer, no second fire, no second flare; a part that catches from one beside it gets a lick across', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const { c, calls } = rig();
    const fx = new PartFires(c);
    fx.onIgnite(1, 2, 60, 1);
    const first = calls.length;
    fx.onIgnite(1, 2, 300, 2);
    expect(calls.length).toBe(first);
    expect(fx.counts.fires).toBe(1);
    c.time = 2;
    fx.emit(1);
    expect(fx.counts.fires).toBe(1);
    // (the part beside it catches, a generation on: a flare, and three tongues from the first part to it)
    calls.length = 0;
    fx.onIgnite(1, 3, 120, 2);
    expect(calls.filter((k) => k[0] === 'p.push')).toHaveLength(3);
    expect(calls.filter((k) => k[0] === 'p.glow')).toHaveLength(1);
  });
});

describe('any other fire looks as it always did', () => {
  it('an ignite without `gen` (magma\'s, the Cinder Bloom\'s, a vent\'s) is never one of these; one with it is never the old kind', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { c, calls } = rig();
    const amb = new AmbientFx(c);
    amb.onIgnite(1, 0, 600);
    expect(amb.spread.counts.fires).toBe(0);
    // (the old flash at the part: a glow of 40 and fourteen sparks, as ever)
    expect(calls.filter((k) => k[0] === 'p.glow').map((k) => k[5])).toEqual([40]);
    expect(calls.filter((k) => k[0] === 'p.burstSparks').map((k) => k[5])).toEqual([14]);
    calls.length = 0;
    amb.fires(1);
    amb.drawFires();
    expect(discs(calls)).toBe(0);
    const plain = made(calls);
    expect(plain).toBeGreaterThan(0);
    // A Burn modifier's on another part: drawn by fires.ts, and the old kind's flames no more than before
    amb.onIgnite(1, 1, 600, 1);
    expect(amb.spread.counts.fires).toBe(1);
    c.time += 0.5;
    calls.length = 0;
    amb.fires(1);
    amb.drawFires();
    expect(discs(calls)).toBe(2);
    expect(made(calls)).toBeGreaterThan(plain);
  });
});
