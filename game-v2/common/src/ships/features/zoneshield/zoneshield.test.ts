/**
 * Shaped shields (shaped.ts, the `zoneshield` feature): the geometry each shape derives from its part's open edge, the
 * crossing test (a shot is stopped only if its path crosses the shield before the hull), each shield's own HP, break and
 * return, the wire's levels, and a hit's agreement between the shared rule and a copy of the ship built from the wire.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseBlueprint, blueprintGeometry } from '../../blueprint.js';
import { createShipState, type ShipState } from '../../state.js';
import { feedParts, readShipJson, testCatalog, SHIP_DATA_DIR } from '../../testData.js';
import type { ShipTuning } from '../../tuning.js';
import type { Blueprint, PlacedPart, Rot } from '../../types.js';
import { partHit, shipSegmentHit, shapedStopAt, newPartHit, type HitCtx } from '../../hitRules.js';
import {
  crossShaped, ensureShaped, MAX_SHAPED, packShaped, shapedFraction, shapedLevel, shapedOf, shieldHp, shieldUp, soakShaped, stepShaped, unpackShaped,
  SHAPED_IDLE, SHAPED_RETURN, type ShapedCross, type ShapedSoak,
} from './shaped.js';

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');
const ctx: HitCtx = { catalog, tuning, geometry: (s) => blueprintGeometry(catalog, s.blueprint) };

/** The starter with shield parts added on its left (free cells at x -2), each fed by a Cell Reactor across its in port (testData feedParts): [fn, piece, x, y, facing] */
type Add = [fn: string, piece: string, x: number, y: number, facing?: 'N' | 'E' | 'S' | 'W'];
const sparrow = (adds: Add[], cat = catalog): ShipState => {
  const bp = parseBlueprint(readFileSync(join(SHIP_DATA_DIR, 'blueprints/sparrow-t.json'), 'utf-8'));
  adds.forEach(([fn, piece, x, y, facing], k) => bp.parts.push({ uid: 70 + k, piece, fn, material: cat.functions.get(fn)!.material, x, y, rot: 0 as Rot, flip: false, ...(facing ? { facing } : {}) } as PlacedPart));
  feedParts(cat, bp, adds.map((_, k) => 70 + k));
  return createShipState(cat, tuning, 1, bp, 0);
};
const X: ShapedCross = { t: 0, i: -1 };
const SOAK: ShapedSoak = { soak: 0, rest: 0, broke: false };
const up = () => true;

describe('shaped shields: the shapes a part derives', () => {
  it('a Spark Wall is a 2-cell line 1 cell out from its open edge, its ends along the edge', () => {
    const s = shapedOf(sparrow([['shield_spark_wall', 'sq', -2, 0, 'W']]))[0];
    expect(s.kind).toBe('wall');
    // (the edge's middle is (-2, 0.5), the way out is west; the wall stands at x -3, two cells long about y 0.5)
    expect([s.px, s.py, s.dx, s.dy]).toEqual([-2, 0.5, -1, 0]);
    expect(s.ax).toBeCloseTo(-3); expect(s.bx).toBeCloseTo(-3);
    expect(Math.abs(s.by - s.ay)).toBeCloseTo(2);
    expect((s.ay + s.by) / 2).toBeCloseTo(0.5);
    expect([s.cap, s.rate, s.delay]).toEqual([40, 14, 90]);
  });

  it('a Visor is a 60 degree arc round its edge middle, centred on the way out', () => {
    const s = shapedOf(sparrow([['shield_visor', 'sq', -2, 0, 'W']]))[0];
    expect(s.kind).toBe('arc');
    expect([s.cx, s.cy]).toEqual([-2, 0.5]);
    expect(s.r).toBe(2.5);
    expect(s.half).toBeCloseTo((60 * Math.PI) / 360);
    expect(Math.abs(Math.abs(s.mid) - Math.PI)).toBeLessThan(1e-9);
  });

  it('the seven shapes are models with the Lab numbers; the Bubble is not one', () => {
    const lab: Record<string, [number, number, number]> = {
      shield_spark_wall: [40, 14, 1.5], shield_guard_wall: [75, 12, 2.2], shield_rampart: [260, 9, 4.5], shield_visor: [45, 16, 1.2],
      shield_buckler: [60, 13, 2], shield_shell: [160, 8, 3.5], shield_half_dome: [320, 6, 5.5],
    };
    for (const [id, [cap, rate, delay]] of Object.entries(lab)) {
      const f = catalog.functions.get(id)!;
      expect(f.model && f.facing, id).toBe(true);
      expect([f.shaped!.cap, f.shaped!.rate, f.shaped!.delay], id).toEqual([cap, rate, delay]);
      expect(f.shield, id).toBeUndefined();
    }
    expect([...catalog.functions.keys()].some((k) => /bubble/.test(k))).toBe(false);
  });

  it('each shield keeps its own cap; a part with no power adds none; at most eight count', () => {
    const many = sparrow([['shield_spark_wall', 'sq', -2, 0, 'W'], ['shield_visor', 'sq', -2, -1, 'W']]);
    expect(shapedOf(many).map((s) => s.cap)).toEqual([40, 45]);
    expect(shapedOf(sparrow([])).length).toBe(0);
    expect(MAX_SHAPED).toBe(8);
  });
});

describe('shaped shields: a shot is stopped only if it crosses the shield before the hull', () => {
  const wall = () => shapedOf(sparrow([['shield_spark_wall', 'sq', -2, 0, 'W']]));
  const arc = () => shapedOf(sparrow([['shield_visor', 'sq', -2, 0, 'W']]));

  it('a wall: a shot that crosses its line is caught there, one that passes its end is not', () => {
    const w = wall();
    // (west to east along y 0.5, through the wall at x -3: 7 of 10 along)
    const c = crossShaped(w, up, -10, 0.5, 0, 0.5, X)!;
    expect(c.i).toBe(0);
    expect(c.t).toBeCloseTo(0.7);
    // (the same line below its end, and one going away from it)
    expect(crossShaped(w, up, -10, 3, 0, 3, X)).toBeNull();
    expect(crossShaped(w, up, -2, 0.5, 5, 0.5, X)).toBeNull();
  });

  it('an arc: caught where it enters the span, not from the side or behind', () => {
    const a = arc();
    const c = crossShaped(a, up, -10, 0.5, 0, 0.5, X)!;
    expect(c.t).toBeCloseTo((10 - 4.5) / 10);
    // (30 degrees either side of straight out is in; a shot at 80 degrees off the way out meets the circle outside the span)
    expect(crossShaped(a, up, -2 - 5 * Math.cos(0.5), 0.5 - 5 * Math.sin(0.5), -2, 0.5, X)).not.toBeNull();
    expect(crossShaped(a, up, -2, -6, -2, 0.5, X)).toBeNull();
    expect(crossShaped(a, up, 8, 0.5, 2, 0.5, X)).toBeNull();
  });

  it('a shot missing every shield reaches the hull: the hull cast is the answer', () => {
    const s = sparrow([['shield_spark_wall', 'sq', -2, 0, 'W']]);
    // (world: the ship at the origin facing north; a shot from the east to the hull, nowhere near the west wall)
    const cs = tuning.cellSize, hull = shipSegmentHit(ctx, s, 0, 0, 0, 400, 0, 0, 0, 0, 0);
    const h = shipSegmentHit(ctx, s, 0, 0, 0, 400, 0, 0, 0);
    expect(h).not.toBeNull();
    expect(h!.shield).toBeUndefined();
    expect(h!.part).toBeGreaterThanOrEqual(0);
    expect(hull?.t).toBeCloseTo(h!.t);
    expect(cs).toBeGreaterThan(0);
  });

  it('a shot that crosses a shield on its way to the hull stops at the shield, and goes on to that hull if it breaks', () => {
    const s = sparrow([['shield_spark_wall', 'sq', -2, 0, 'W']]);
    const cs = tuning.cellSize, com = s.derived.com;
    // World at the origin, angle 0: grid (gx, gy) is at ((gx - com0) cs, (gy - com1) cs) turned by angle + 90 degrees; aim along the grid's x axis
    // through the wall's middle (grid y 0.5) from far out west to the ship's centre
    const gy = 0.5, a = Math.PI / 2;
    const toWorld = (gx: number): [number, number] => { const lx = (gx - com[0]) * cs, ly = (gy - com[1]) * cs; return [lx * Math.cos(a) - ly * Math.sin(a), lx * Math.sin(a) + ly * Math.cos(a)]; };
    const [x0, y0] = toWorld(-12), [x1, y1] = toWorld(com[0]);
    const h = shipSegmentHit(ctx, s, 0, 0, 0, x0, y0, x1, y1)!;
    expect(h.shield).toBe(0);
    expect(h.spill).toBe(true);
    // (a hull part further along: the wall at grid x -3 is 9 of the ~12.8 cells along)
    expect(h.t).toBeLessThan(0.8);
    // a shot that ignores shields (scale 0) goes straight past it to the hull
    const g = shipSegmentHit(ctx, s, 0, 0, 0, x0, y0, x1, y1, 0, 0)!;
    expect(g.shield).toBeUndefined();
    expect(g.t).toBeGreaterThan(h.t);
  });

  it('a down shield stops nothing', () => {
    const s = sparrow([['shield_spark_wall', 'sq', -2, 0, 'W']]);
    ensureShaped(s);
    s.shapedHp![shapedOf(s)[0].part] = 0; s.shapedDown![shapedOf(s)[0].part] = 30;
    expect(shieldUp(s, 0)).toBe(false);
    expect(crossShaped(shapedOf(s), (i) => shieldUp(s, i), -10, 0.5, 0, 0.5, X)).toBeNull();
  });
});

describe('shaped shields: each its own HP, break and return', () => {
  it('a hit takes the shield\'s HP, not the hull\'s; a break lets the rest through and takes it down', () => {
    const s = sparrow([['shield_spark_wall', 'sq', -2, 0, 'W']]);
    const r = soakShaped(s, 0, 25, 1, SOAK);
    expect([r.soak, r.rest, r.broke]).toEqual([25, 0, false]);
    expect(shieldHp(s, 0)).toBe(15);
    const b = soakShaped(s, 0, 30, 1, SOAK);
    expect([b.soak, b.rest, b.broke]).toEqual([15, 15, true]);
    expect(shieldUp(s, 0)).toBe(false);
    expect(s.shapedDown![shapedOf(s)[0].part]).toBe(90);
  });

  it('the weapon\'s multiplier against shields applies (a pulse laser strips them; the rest goes on in the shot\'s own damage)', () => {
    const s = sparrow([['shield_spark_wall', 'sq', -2, 0, 'W']]);
    const r = soakShaped(s, 0, 10, 2, SOAK);
    expect([r.soak, r.rest]).toEqual([20, 0]);
    const r2 = soakShaped(s, 0, 30, 2, SOAK);
    expect([r2.soak, r2.rest]).toEqual([20, 20]);
  });

  it('after the wait it refills at its rate, each shield on its own clock', () => {
    const s = sparrow([['shield_spark_wall', 'sq', -2, 0, 'W'], ['shield_visor', 'sq', -2, -1, 'W']]);
    const [, b] = shapedOf(s);
    stepShaped(s);
    soakShaped(s, 1, 30, 1, SOAK); // the visor takes 30 of 45, holds
    soakShaped(s, 0, 100, 1, SOAK); // the wall breaks
    // the visor: nothing for 1.2 s, then 16 a second; the wall's break does not touch it
    for (let i = 0; i < SHAPED_IDLE * 60 - 1; i++) stepShaped(s);
    expect(shieldHp(s, 1)).toBe(15);
    for (let i = 0; i < 30; i++) stepShaped(s);
    expect(shieldHp(s, 1)).toBeCloseTo(15 + (b.rate / 60) * 30, 0);
  });

  it('broken, a shield is down its delay, returns at a quarter of its cap, and refills from there', () => {
    const s = sparrow([['shield_spark_wall', 'sq', -2, 0, 'W']]);
    stepShaped(s);
    soakShaped(s, 0, 100, 1, SOAK);
    for (let i = 0; i < 89; i++) stepShaped(s);
    expect(shieldUp(s, 0)).toBe(false);
    stepShaped(s);
    expect(shieldUp(s, 0)).toBe(true);
    expect(shieldHp(s, 0)).toBe(40 * SHAPED_RETURN);
    for (let i = 0; i < 60; i++) stepShaped(s);
    expect(shieldHp(s, 0)).toBeCloseTo(40 * SHAPED_RETURN + 14, 0);
    // a hit while it refills starts the wait over
    soakShaped(s, 0, 1, 1, SOAK);
    const held = shieldHp(s, 0);
    for (let i = 0; i < SHAPED_IDLE * 60 - 2; i++) stepShaped(s);
    expect(shieldHp(s, 0)).toBe(held);
  });

  it('a new shield comes up full, and one never over its cap', () => {
    const s = sparrow([['shield_buckler', 'sq', -2, 0, 'W']]);
    expect(shieldHp(s, 0)).toBe(60);
    stepShaped(s);
    expect(shieldHp(s, 0)).toBe(60);
    for (let i = 0; i < 600; i++) stepShaped(s, 1);
    expect(shieldHp(s, 0)).toBe(60);
    expect(shapedFraction(s)).toBe(1);
  });

  it('unfed (share 0) a shield does not refill', () => {
    const s = sparrow([['shield_buckler', 'sq', -2, 0, 'W']]);
    stepShaped(s);
    soakShaped(s, 0, 30, 1, SOAK);
    for (let i = 0; i < 300; i++) stepShaped(s, 0);
    expect(shieldHp(s, 0)).toBe(30);
  });
});

describe('shaped shields: through partHit and onto the wire', () => {
  it('partHit with a shaped shield: the shield soaks, a spill goes on to the hull, no spill is lost', () => {
    const s = sparrow([['shield_spark_wall', 'sq', -2, 0, 'W']]);
    const core = s.blueprint.parts.findIndex((p) => p.fn === 'core');
    const hp0 = s.hp[core];
    const r = partHit(ctx, s, core, 30, { shaped: { i: 0, spill: true } }, { tick: 5 }, newPartHit());
    expect(r.soak).toBe(30);
    expect(s.hp[core]).toBe(hp0);
    expect(shieldHp(s, 0)).toBe(10);
    partHit(ctx, s, core, 30, { shaped: { i: 0, spill: true } }, { tick: 6 }, newPartHit());
    expect(shieldUp(s, 0)).toBe(false);
    expect(s.hp[core]).toBeLessThan(hp0);
    const t = sparrow([['shield_spark_wall', 'sq', -2, 0, 'W']]);
    const hpT = t.hp[core];
    partHit(ctx, t, core, 80, { shaped: { i: 0, spill: false } }, { tick: 5 }, newPartHit());
    expect(t.hp[core]).toBe(hpT);
    expect(shieldUp(t, 0)).toBe(false);
  });

  it('a shot that ignores shields (torpedoes: scale 0) is never given a shaped soak', () => {
    const s = sparrow([['shield_spark_wall', 'sq', -2, 0, 'W']]);
    const core = s.blueprint.parts.findIndex((p) => p.fn === 'core');
    const r = partHit(ctx, s, core, 30, { shield: 0, shaped: { i: 0, spill: true } }, { tick: 5 }, newPartHit());
    expect(r.soak).toBe(0);
    expect(shieldHp(s, 0)).toBe(40);
  });

  it('the levels pack a nibble a shield and read back into a copy of the ship that then agrees on which shield is up', () => {
    const s = sparrow([['shield_spark_wall', 'sq', -2, 0, 'W'], ['shield_visor', 'sq', -2, -1, 'W']]);
    stepShaped(s);
    soakShaped(s, 0, 100, 1, SOAK); // wall down
    soakShaped(s, 1, 22.5, 1, SOAK); // visor at half
    const v = packShaped(s);
    expect(shapedLevel(v, 0)).toBe(0);
    expect(shapedLevel(v, 1)).toBeGreaterThan(5);
    expect(shapedLevel(v, 1)).toBeLessThan(11);
    const copy = sparrow([['shield_spark_wall', 'sq', -2, 0, 'W'], ['shield_visor', 'sq', -2, -1, 'W']]);
    unpackShaped(copy, v);
    expect(shieldUp(copy, 0)).toBe(false);
    expect(shieldUp(copy, 1)).toBe(true);
    expect(shieldHp(copy, 1)).toBeCloseTo(22.5, 0);
    expect(packShaped(copy)).toBe(v);
  });

  it('client and server agree on a hit: the same segment gives the same shield and part on the ship and on a copy built from the wire', () => {
    const adds: Add[] = [['shield_spark_wall', 'sq', -2, 0, 'W'], ['shield_guard_wall', 'rect2', -2, 1, 'W']];
    const server = sparrow(adds), client = sparrow(adds);
    stepShaped(server);
    soakShaped(server, 0, 12, 1, SOAK);
    unpackShaped(client, packShaped(server));
    const cs = tuning.cellSize;
    const com = server.derived.com, a = Math.PI / 2 + 0.3;
    for (const gy of [-0.4, 0.2, 0.8, 1.4, 2.2]) {
      const toWorld = (gx: number): [number, number] => { const lx = (gx - com[0]) * cs, ly = (gy - com[1]) * cs; return [lx * Math.cos(a) - ly * Math.sin(a), lx * Math.sin(a) + ly * Math.cos(a)]; };
      const [x0, y0] = toWorld(-14), [x1, y1] = toWorld(com[0]);
      const s = shipSegmentHit(ctx, server, 0, 0, 0.3, x0, y0, x1, y1), c = shipSegmentHit(ctx, client, 0, 0, 0.3, x0, y0, x1, y1);
      expect(c, `y ${gy}`).toEqual(s);
    }
    // and one the shield took a break: both copies now see it down
    soakShaped(server, 0, 100, 1, SOAK);
    unpackShaped(client, packShaped(server));
    expect(shieldUp(client, 0)).toBe(false);
    expect(shapedStopAt(client, cs, 0, 0, 0.3, 0, 0, 1, 1, null)).toEqual(shapedStopAt(server, cs, 0, 0, 0.3, 0, 0, 1, 1, null));
  });
});
