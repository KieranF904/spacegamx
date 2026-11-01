// The staged build's plan: an outline skeleton (tiled frame, conduit spine), the nose and tail zones, and the frame prune.
import { describe, it, expect } from 'vitest';
import { CodeBook, asymmetricCells, check, findRole, halfOf, mergeParts, mirrorHalf, partsToBlueprint } from '../core/index';
import { loadContext } from '../core/context';
import { placementMenu, pruneFrame, skeleton, zoneOf } from './staged';

const ctx = loadContext();
const CAPITAL = findRole(ctx, 'capital')!;
const GUNSHIP = findRole(ctx, 'gunship')!;

describe('shipgen staged build: the outline skeleton, zones and the prune', () => {
  it('tiles a concept outline with frame hull and a conduit spine: valid, symmetric, the outline\'s own row widths, few parts', () => {
    const outline = [1, 3, 3, 5, 5, 7, 7, 9, 9, 9, 7, 7, 7, 9, 9, 11, 11, 11, 9, 9];
    const s = skeleton(ctx, CAPITAL, 'x', undefined, false, outline);
    const r = check(ctx, s);
    expect(r.valid).toBe(true);
    expect(asymmetricCells(ctx, s)).toEqual([]);
    expect(r.stats.cells).toBe(outline.reduce((a, b) => a + b, 0));
    expect(r.stats.height).toBe(outline.length);
    // 2x2 blocks and 2x1 bars keep the count well under one part a cell (the game allows 255)
    expect(s.parts.length).toBeLessThan(r.stats.cells * 0.6);
    const conduits = s.parts.filter((p) => p.fn === 'power_conduit');
    expect(conduits.length).toBe(outline.length - 3); // (rows 1..len-2, less the core's row)
    expect(conduits.every((p) => p.x === 0)).toBe(true);
    // The core is on the centre line, two fifths of the way down
    const core = s.parts.find((p) => p.fn === 'core')!;
    expect(core.x).toBe(0);
    const ys = s.parts.map((p) => p.y);
    expect(core.y - Math.min(...ys)).toBe(Math.floor(outline.length * 0.4));
  });

  it('a short outline gets no spine; too short an outline falls back to the small frame', () => {
    const short = skeleton(ctx, GUNSHIP, 'x', undefined, false, [3, 5, 5, 3]);
    expect(short.parts.some((p) => p.fn === 'power_conduit')).toBe(false);
    expect(check(ctx, short).stats.cells).toBe(16);
    const tiny = skeleton(ctx, GUNSHIP, 'x', undefined, true, [3, 3]);
    expect(check(ctx, tiny).stats.cells).toBeGreaterThanOrEqual(GUNSHIP.size.cells[0]);
  });

  it('puts guns in the nose third and engines in the tail third of a long ship', () => {
    const outline = [1, 3, 5, 5, 7, 7, 7, 7, 7, 7, 5, 5];
    const s = skeleton(ctx, GUNSHIP, 'x', undefined, false, outline);
    const z = zoneOf(ctx, s);
    const ys = s.parts.map((p) => p.y), y0 = Math.min(...ys), y1 = Math.max(...ys);
    expect(z.nose(y0)).toBe(true); expect(z.nose(y1)).toBe(false);
    expect(z.tail(y1)).toBe(true); expect(z.tail(y0)).toBe(false);
    // With a reactor beside the core (the power step's work), the spine carries its power the length of the ship:
    // the engine menu offers tail cells only, the gun menu nose cells only
    const isGen = (c: typeof ctx, p: { fn: string }) => p.fn === 'power_cell_reactor';
    const gen = placementMenu(ctx, s, ['CR'], [''], true, isGen);
    expect(gen.length).toBeGreaterThan(0);
    const book = new CodeBook(ctx);
    const one = partsToBlueprint(ctx, `name: x\nparts:\n${gen[0]}\nend`, { book }).bp!;
    const powered = mirrorHalf(ctx, mergeParts(ctx, halfOf(ctx, s), one.parts, (p) => p.fn === 'hull', book).bp!, { book }).bp!;
    expect(check(ctx, powered).valid).toBe(true);
    const engines = placementMenu(ctx, powered, ['ID'], ['v'], true, (c, p) => p.fn.startsWith('engine'), { zone: (_x, y) => z.tail(y) });
    expect(engines.length).toBeGreaterThan(0);
    for (const e of engines) expect(z.tail(Number(e.split(/[ ,]/)[2]))).toBe(true);
    const guns = placementMenu(ctx, powered, ['PI'], ['^'], true, (c, p) => !!ctx.catalog.functions.get(p.fn)?.weapon, { zone: (_x, y) => z.nose(y) });
    expect(guns.length).toBeGreaterThan(0);
    for (const g of guns) expect(z.nose(Number(g.split(/[ ,]/)[2]))).toBe(true);
    // A short ship has no zones
    expect(zoneOf(ctx, skeleton(ctx, findRole(ctx, 'starter'), 'x', undefined, false)).len).toBeLessThan(6);
    // An engine a row short of the tail would clear two frame cells behind it: not offered; one at the tail is
    expect(engines).toContain('IDv 0,7');
    expect(engines).not.toContain('IDv -1,5');
  });

  it('prunes frame hull nothing was built on, leaf by leaf, and leaves the rest', () => {
    const s = skeleton(ctx, GUNSHIP, 'x', 40);
    const before = s.parts.length;
    const p = pruneFrame(ctx, s);
    expect(p.removed).toBeGreaterThan(0);
    expect(p.bp.parts.length).toBe(before - p.removed);
    expect(check(ctx, p.bp).valid).toBe(true);
    // Nothing left is a leaf
    expect(pruneFrame(ctx, p.bp).removed).toBe(0);
    // A solid block of frame (every cell with two neighbours or more) is left alone
    const block = { ...s, parts: [{ uid: 0, piece: 'sq', fn: 'core', material: 'alloy', x: 0, y: 0, rot: 0 as const, flip: false }, ...[[-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]].map(([x, y], i) => ({ uid: i + 1, piece: 'sq', fn: 'hull', material: 'alloy', x, y, rot: 0 as const, flip: false }))] };
    expect(pruneFrame(ctx, block).removed).toBe(0);
  });
});
