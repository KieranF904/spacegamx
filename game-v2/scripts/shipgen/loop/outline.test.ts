// The concept's outline (row widths, nose to tail): read from a reply, the name cleaned, the fit against a ship's rows, the
// score term, and the free cells the staged armour step is asked to fill.
import { describe, it, expect } from 'vitest';
import { cleanName, conceptPenalty, findRole, loadContext, outlineFit, parseConcept, parseOutline, rowWidths } from '../core/index';
import { outlineFill, skeleton } from './staged';

const ctx = loadContext();
const STARTER = findRole(ctx, 'starter')!;

describe('shipgen concept outline', () => {
  it('reads the outline from the text block, makes widths odd within the box, and takes the cells from it', () => {
    const c = parseConcept(['concept:', 'name: Dart', 'size: small', 'silhouette: needle', 'layout: x', 'character: y', 'cells: 40', 'outline: 1, 2, 3, 5, 5, 99', 'end'].join('\n'), STARTER)!;
    const W = STARTER.size.maxWidth!;
    expect(c.outline).toEqual([1, 3, 3, 5, 5, W % 2 ? W : W - 1]);
    expect(c.cells).toBe(Math.min(STARTER.size.cells[1], Math.max(STARTER.size.cells[0], c.outline!.reduce((a, b) => a + b, 0))));
    expect(parseOutline('7')).toBeUndefined();
  });

  it('reads the block after the last "concept:" line, and cleans a sentence in the name', () => {
    const c = parseConcept(['name: thinking aloud', 'silhouette: draft', 'concept:', 'name: This cheap starter craft bears the simple name Piercer.', 'size: small', 'silhouette: dart', 'layout: x', 'character: y', 'end'].join('\n'))!;
    expect(c.name).toBe('Piercer');
    expect(c.silhouette).toBe('dart');
    expect(cleanName('"Budget Scout"')).toBe('Budget Scout');
    expect(cleanName('A ship with the designation of Grey Heron for patrol work')).toBe('Grey Heron');
  });

  it('fits a ship to the outline at the best offset, and costs points when the rows are off', () => {
    expect(outlineFit([1, 3, 5], [1, 3, 5]).diff).toBe(0);
    expect(outlineFit([1, 3, 5], [7, 1, 3, 5]).offset).toBe(1);
    const box = conceptPenalty(STARTER, { name: 'D', sizeClass: 'small', silhouette: 's', layout: '', character: '', outline: [1, 3, 5, 5], source: 'model' }, 14, [7, 7]);
    expect(box.points).toBeGreaterThan(0);
    expect(box.notes.join(' ')).toMatch(/planned 1,3,5,5; this ship 7,7/);
    const fits = conceptPenalty(STARTER, { name: 'D', sizeClass: 'small', silhouette: 's', layout: '', character: '', outline: [1, 3, 5, 5], source: 'model' }, 14, [1, 3, 5, 5]);
    expect(fits.notes.join(' ')).not.toMatch(/outline/);
  });

  it('lists the free cells inside the outline, joined to the ship, left half in mirror mode', () => {
    const bp = skeleton(ctx, STARTER);
    const w = rowWidths(ctx, bp);
    const outline = w.map((x) => Math.min(x + 4, 9) | 1);
    const cells = outlineFill(ctx, bp, outline, true);
    expect(cells.length).toBeGreaterThan(0);
    for (const k of cells) expect(Number(k.split(',')[0])).toBeLessThanOrEqual(0);
    expect(outlineFill(ctx, bp, w, true)).toEqual([]);
  });
});
