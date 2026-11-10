import { describe, it, expect } from 'vitest';
import type { Blueprint } from '../../../common/src/ships/index';
import { validateBlueprint } from '../../../common/src/ships/index';
import { loadContext } from './context';
import { partKey } from './grid';
import { buildLegend } from './legend';
import { blueprintToParts, partsToBlueprint } from './partlist';
import { SAMPLE_SHIPS, bundledShips, ship } from './testShips';

const ctx = loadContext();
const keys = (bp: Blueprint) => bp.parts.map((p) => partKey(ctx, p)).sort();
const errCodes = (bp: Blueprint) => validateBlueprint(ctx.catalog, bp, ctx.tuning, null, { mounting: false }).errors.map((e) => e.code).sort();

describe('shipgen part list', () => {
  // The contract, as the grid's: blueprint -> part list -> blueprint keeps every part (key section, shared-cell pieces and
  // all) and the header (name, paint, drive, rigid), and validates exactly as before
  for (const { path, bp } of bundledShips()) {
    it(`round-trips ${path}`, () => {
      const enc = blueprintToParts(ctx, bp);
      const dec = partsToBlueprint(ctx, enc.text);
      expect(dec.errors).toEqual([]);
      expect(keys(dec.bp!)).toEqual(keys(bp));
      expect(errCodes(dec.bp!)).toEqual(errCodes(bp));
      expect(dec.bp!.name).toBe(bp.name);
      expect(dec.bp!.paint).toBe(bp.paint);
      expect(dec.bp!.drive).toBe(bp.drive);
      expect(!!dec.bp!.rigid).toBe(!!bp.rigid);
      for (const r of enc.raw) expect(r.reason, `${path} part ${r.uid}`).toMatch(/shares cell|mods or gems/);
    });
  }

  it('reads the key section wherever it stands', () => {
    const wren = ship('samples/review-wren');
    const gun = wren.parts.find((p) => p.fn === 'cannon_pip')!;
    const bp: Blueprint = { ...wren, parts: wren.parts.map((p) => (p === gun ? { ...p, material: 'composite' } : p)) };
    const text = blueprintToParts(ctx, bp).text;
    expect(text.indexOf('key:')).toBeGreaterThan(text.indexOf('end'));
    const dec = partsToBlueprint(ctx, text);
    expect(dec.errors).toEqual([]);
    expect(keys(dec.bp!)).toEqual(keys(bp));
  });

  it('carries paint, drive, rigid, mods and gems', () => {
    const wren = ship('samples/review-wren');
    const bp: Blueprint = { ...wren, paint: '#336699', drive: 0.8, rigid: true, parts: wren.parts.map((p, i) => (i === 1 ? { ...p, mods: { x: 1 } as never } : p)) };
    const enc = blueprintToParts(ctx, bp);
    expect(enc.raw.map((r) => r.reason)).toContain('has mods or gems');
    const dec = partsToBlueprint(ctx, enc.text);
    expect(dec.errors).toEqual([]);
    expect([dec.bp!.paint, dec.bp!.drive, dec.bp!.rigid]).toEqual(['#336699', 0.8, true]);
    expect(dec.bp!.parts.some((p) => (p as { mods?: unknown }).mods)).toBe(true);
    expect(keys(dec.bp!)).toEqual(keys(bp));
  });

  it('keeps the uncovered cells of a hull block that a part sits on', () => {
    const hull = buildLegend(ctx).find('hull', 'alloy')!.code;
    const d = partsToBlueprint(ctx, `name: t\nparts:\nCA 0,0\n${hull} -2,0 2x2\nPI^ -2,0\nend\n`);
    expect(d.errors).toEqual([]);
    const cells = d.bp!.parts.filter((p) => p.fn === 'hull').length;
    expect(cells).toBe(3);
    expect(d.warnings.join(' ')).toMatch(/stay hull/);
  });

  it('reads a ship the review set draws', () => {
    for (const path of SAMPLE_SHIPS) expect(partsToBlueprint(ctx, blueprintToParts(ctx, ship(path)).text).errors, path).toEqual([]);
  });
});
