import { describe, it, expect, vi } from 'vitest';
import { drawCentral } from './layersWorld';
import type { MapHost, MapScene } from './host';

/** drawCentral on a system whose central body is `type`: how many times the body glyph is drawn */
function glyphs(type: string, starRadius: number): number {
  const drawBodyGlyph = vi.fn();
  const host = { drawBodyGlyph, label: vi.fn() } as unknown as MapHost;
  const sc = { ctx: {}, sx: (x: number) => x, sy: (y: number) => y, S: 0.01, time: 0, ox: 100, oy: 100, sys: { starRadius, starColor: '#ffdd44' }, cb: { type } } as unknown as MapScene;
  drawCentral(host, sc);
  return drawBodyGlyph.mock.calls.length;
}

describe("the system map's central body", () => {
  it('draws no sun for a system with no central body (the training yard)', () => {
    expect(glyphs('none', 0)).toBe(0);
  });
  it('still draws it for every other system', () => {
    expect(glyphs('sun', 1000)).toBe(1);
    expect(glyphs('black_hole', 1400)).toBe(1);
  });
});
