import { describe, it, expect } from 'vitest';
import type { Blueprint } from '../../../common/src/ships/index';
import { validateBlueprint } from '../../../common/src/ships/index';
import { loadContext } from './context';
import { blueprintToGrid, coreAxis2, gridToBlueprint, partKey } from './grid';
import { asymmetricCells, halfOf, mirrorHalf } from './mirror';
import { blueprintToParts, mergeParts, partsToBlueprint } from './partlist';
import { SAMPLE_SHIPS, ship } from './testShips';

const ctx = loadContext();
const keys = (bp: Blueprint) => bp.parts.map((p) => partKey(ctx, p)).sort();

describe('shipgen mirror mode', () => {
  it('a review ship is the mirror of its own left half', () => {
    for (const path of SAMPLE_SHIPS) {
      const bp = ship(path);
      const half = halfOf(ctx, bp);
      expect(half.parts.length, path).toBeLessThan(bp.parts.length);
      const m = mirrorHalf(ctx, half);
      expect(m.errors, path).toEqual([]);
      expect(keys(m.bp!), path).toEqual(keys(bp));
      expect(asymmetricCells(ctx, bp), path).toEqual([]);
    }
  });

  it('mirrors a half drawn with a 1-wide core on column 0: facings and handed shapes flip', () => {
    const text = ['name: Half', 'grid:', '    -2   -1   0', ' -1 ..   HAt4 HA', '  0 PI^  CR   CA', '  1 HAt4 BS<  BT', '  2 ..   IDv  HA', 'end'].join('\n');
    const d = gridToBlueprint(ctx, text);
    expect(d.errors).toEqual([]);
    const m = mirrorHalf(ctx, d.bp!);
    expect(m.errors).toEqual([]);
    expect(m.axis2).toBe(1);
    const bp = m.bp!;
    const at = (x: number, y: number) => bp.parts.find((p) => p.x === x && p.y === y);
    expect(at(1, 1)!.facing).toBe('E'); // (the side strafer facing W, mirrored, faces E)
    expect(at(2, 0)!.facing).toBe('N');
    expect(asymmetricCells(ctx, bp)).toEqual([]);
    const enc = blueprintToGrid(ctx, bp).text;
    expect(enc).toMatch(/HAt1/); // (the left wing tip's wedge, t4, mirrors to t1)
    expect(bp.parts.length).toBe(d.bp!.parts.length * 2 - 4);
  });

  it('refuses a part across the centre line that is not its own mirror, and a right-half clash', () => {
    const across = gridToBlueprint(ctx, ['grid:', '    -1  0', '  0 CR  CA', '  1 ..  BS<', 'end'].join('\n'));
    const m = mirrorHalf(ctx, across.bp!);
    expect(m.bp).toBeUndefined();
    expect(m.errors[0].message).toMatch(/crosses the centre line/);
    const clash = gridToBlueprint(ctx, ['grid:', '    -1  0  1', '  0 CR  CA BT', 'end'].join('\n'));
    const c = mirrorHalf(ctx, clash.bp!);
    expect(c.errors).toEqual([]);
    expect(c.bp!.parts.length).toBe(3); // (the left half wins: the right-hand battery is dropped, the reactor mirrored)
    expect(c.warnings.join(' ')).toMatch(/dropped; the left half wins/);
    // (a right-half part whose mirror slot is free is mirrored to the left too, with a note)
    const free = gridToBlueprint(ctx, ['grid:', '    -1  0  1', '  0 ..  CA ..', '  1 ..  BT CR', 'end'].join('\n'));
    const f = mirrorHalf(ctx, free.bp!);
    expect(f.errors).toEqual([]);
    expect(f.bp!.parts.length).toBe(4);
    expect(f.warnings.join(' ')).toMatch(/mirrored it to the left/);
  });

  it('names the cells that have no mirror twin', () => {
    const wren = ship('samples/review-wren');
    const tip = wren.parts.reduce((a, p) => (p.x > a.x ? p : a));
    const lop: Blueprint = { ...wren, parts: wren.parts.filter((p) => p !== tip) };
    const asym = asymmetricCells(ctx, lop);
    expect(asym.length).toBe(1);
    expect(asym[0].message).toMatch(new RegExp(`row ${tip.y}: col -?\\d+ is HA.*mirror col ${tip.x} is empty`));
    expect(coreAxis2(ctx, lop)).toBe(2);
  });
});

describe('shipgen part list', () => {
  it('round-trips every review ship', () => {
    for (const path of SAMPLE_SHIPS) {
      const bp = ship(path);
      const t = blueprintToParts(ctx, bp).text;
      const d = partsToBlueprint(ctx, t);
      expect(d.errors, path).toEqual([]);
      expect(keys(d.bp!), path).toEqual(keys(bp));
      expect(d.bp!.name).toBe(bp.name);
    }
  });

  it('places multi-cell pieces by their anchor and size, and names overlaps exactly', () => {
    const d = partsToBlueprint(ctx, 'name: T\nparts:\nCA 0,0 ; CR -1,0 ; HB -3,-1 2x2\nTOv 1,1 1x2\nend');
    expect(d.errors).toEqual([]);
    const hb = d.bp!.parts.find((p) => p.fn !== 'core' && p.piece === 'block2')!;
    expect(hb).toBeTruthy();
    const to = d.bp!.parts.find((p) => p.facing === 'S')!;
    expect(to.piece).toBe('rect2');
    const bad = partsToBlueprint(ctx, 'parts:\nCA 0,0\nHB -1,-1 2x2\nend');
    expect(bad.bp).toBeUndefined();
    expect(bad.errors[0].message).toMatch(/"HB -1,-1 2x2" overlaps "CA 0,0": both cover col 0 row 0/);
    expect(partsToBlueprint(ctx, 'parts:\nZZ 0,0\nend').errors[0].message).toMatch(/ZZ/);
    // (hull listed under a part is dropped, with a note; a bare shape gets a hint)
    const under = partsToBlueprint(ctx, 'parts:\nCA 0,0\nHA -1,0\nCR -1,0\nPI^ -1,-1\nHA -1,-1\nend');
    expect(under.errors).toEqual([]);
    expect(under.bp!.parts.map((p) => p.fn).filter((f) => f === 'hull')).toEqual([]);
    expect(under.warnings.join(' ')).toMatch(/dropped/);
    expect(partsToBlueprint(ctx, 'parts:\nn3 0,0\nend').errors[0].message).toMatch(/HAn3, not n3/);
    expect(partsToBlueprint(ctx, 'parts:\nCR 0,0 2x2\nend').errors[0].message).toMatch(/comes 1x1/);
  });

  it('merges a step\'s new parts, replacing frame hull and refusing other overlaps', () => {
    const base = partsToBlueprint(ctx, 'parts:\nCA 0,0\nHA 0,-1\nHA -1,0\nend').bp!;
    const add = partsToBlueprint(ctx, 'parts:\nCR -1,0\nCA 0,0\nend').bp!.parts;
    const m = mergeParts(ctx, base, add, (p) => p.fn === 'hull');
    expect(m.errors).toEqual([]);
    expect(m.bp!.parts.map((p) => p.fn).sort()).toEqual(['core', 'hull', 'reactor'].sort().map((f) => (f === 'reactor' ? add[0].fn : f)).sort());
    const no = mergeParts(ctx, base, partsToBlueprint(ctx, 'parts:\nCR 0,0\nend').bp!.parts, (p) => p.fn === 'hull');
    expect(no.errors[0].message).toMatch(/overlaps "CA 0,0"/);
    expect(validateBlueprint(ctx.catalog, m.bp!, ctx.tuning).ok).toBe(true);
  });
});
