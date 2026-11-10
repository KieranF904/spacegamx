import { describe, it, expect } from 'vitest';
import type { Blueprint } from '../../../common/src/ships/index';
import { validateBlueprint } from '../../../common/src/ships/index';
import { loadContext } from './context';
import { blueprintToGrid, gridToBlueprint, mirrorLeft, partKey, coreAxis2 } from './grid';
import { SAMPLE_SHIPS, bundledShips, ship } from './testShips';

const ctx = loadContext();
const keys = (bp: Blueprint) => bp.parts.map((p) => partKey(ctx, p)).sort();
const errCodes = (bp: Blueprint) => validateBlueprint(ctx.catalog, bp, ctx.tuning, null, { mounting: false }).errors.map((e) => e.code).sort();

describe('shipgen grid', () => {
  const ships = bundledShips();
  it('reads the bundled ships', () => expect(ships.length).toBeGreaterThan(50));

  // The contract: blueprint -> grid -> blueprint keeps every part (its function, material, piece, facing, mount and the
  // very geometry it covers) and validates exactly as before. A part the grid can't draw rides in raw:, and says why
  for (const { path, bp } of ships) {
    it(`round-trips ${path}`, () => {
      const enc = blueprintToGrid(ctx, bp);
      const dec = gridToBlueprint(ctx, enc.text);
      expect(dec.errors).toEqual([]);
      expect(keys(dec.bp!)).toEqual(keys(bp));
      expect(errCodes(dec.bp!)).toEqual(errCodes(bp));
      expect(dec.bp!.name).toBe(bp.name);
      // (only overlapping cells, as two wedges sharing a square or a boss's own shapes, can't be drawn)
      for (const r of enc.raw) expect(r.reason, `${path} part ${r.uid}`).toMatch(/shares cell/);
      const pilotShip = bp.parts.every((p) => !ctx.catalog.pieces.get(p.piece)?.bespoke);
      if (pilotShip) expect(enc.raw.length, path).toBeLessThanOrEqual(2);
    });
  }

  it('draws the review ships with legend codes only, nothing raw', () => {
    for (const path of SAMPLE_SHIPS) {
      const enc = blueprintToGrid(ctx, ship(path));
      expect(enc.raw, path).toEqual([]);
      expect(enc.book.own, path).toEqual([]);
    }
  });

  it('reads a hand-written grid: capitals start parts, small letters continue them, marks face and shape them', () => {
    const text = [
      'name: Tiny',
      'grid:',
      '    -1   0   1   2',
      ' -1 ..  HAt4 HAt1 ..',
      '  0 PI^ CA  ca  PI^',
      '  1 HA  CR  BT  HA',
      '  2 ..  IDv IDv ..',
      'end',
    ].join('\n');
    const d = gridToBlueprint(ctx, text);
    expect(d.errors).toEqual([]);
    const bp = d.bp!;
    expect(bp.name).toBe('Tiny');
    expect(bp.parts).toHaveLength(11);
    const core = bp.parts.find((p) => p.fn === 'core')!;
    expect([core.piece, core.x, core.y]).toEqual(['rect2', 0, 0]);
    expect(bp.parts.filter((p) => p.facing === 'N')).toHaveLength(2);
    expect(bp.parts.filter((p) => p.piece === 'tri')).toHaveLength(2);
    expect(validateBlueprint(ctx.catalog, bp, ctx.tuning).ok).toBe(true);
  });

  it('says where a grid goes wrong', () => {
    const d = gridToBlueprint(ctx, 'grid:\n  0 ZZ  Ha  hm\n  1 .. .. ..\nend');
    expect(d.bp).toBeUndefined();
    const msgs = d.errors.map((e) => `${e.row},${e.col}: ${e.message}`).join('\n');
    expect(msgs).toContain('ZZ');
    expect(msgs).toContain('CAPITALS');
    expect(d.errors.every((e) => e.row !== undefined)).toBe(true);
  });

  it('reads a capital written for a 2-cell part\'s second cell as that cell (with a warning)', () => {
    const two = blueprintToGrid(ctx, ship('samples/review-kestrel')).text;
    // (some 2x1 or 2x2 part's small-letter cell written in capitals)
    const m = /\b([A-Z]{2})([\^>v<]?)( +)([a-z]{2})\b/.exec(two)!;
    expect(m[1].toLowerCase()).toBe(m[4]);
    const sloppy = two.replace(m[0], `${m[1]}${m[2]}${m[3]}${m[4].toUpperCase()}`);
    const d = gridToBlueprint(ctx, sloppy);
    expect(d.errors).toEqual([]);
    expect(d.warnings.length).toBeGreaterThan(0);
    expect(keys(d.bp!)).toEqual(keys(ship('samples/review-kestrel')));
  });

  it('mirrors a left half into the whole ship', () => {
    for (const path of SAMPLE_SHIPS) {
      const bp = ship(path), a2 = coreAxis2(ctx, bp);
      // (each review ship is mirror-symmetric about its core: its left half and centre line, mirrored, are the ship)
      const half: Blueprint = { ...bp, parts: bp.parts.filter((p) => p.x * 2 < a2) };
      expect(keys(mirrorLeft(ctx, bp, a2)), path).toEqual(keys(bp));
      expect(mirrorLeft(ctx, half, a2).parts.length).toBeGreaterThan(half.parts.length);
    }
  });
});
