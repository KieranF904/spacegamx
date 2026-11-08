import { describe, expect, it } from 'vitest';
import { emptyFilters } from '../paletteFilters';
import { lastSpan, subsHtml, tileColumns } from './paletteSubs';

describe('palette filter area', () => {
  it('fills the grid evenly', () => {
    for (let n = 2; n <= 9; n++) {
      const c = tileColumns(n);
      expect((n - 1 + lastSpan(n)) % c, `n=${n}`).toBe(0);
    }
    expect(tileColumns(7)).toBe(4);
    expect(lastSpan(7)).toBe(2);
  });
  it('keeps the hooks the palette uses', () => {
    const subs = [{ id: 'direct', label: 'Direct' }, { id: 'beam', label: 'Beam' }];
    const html = subsHtml('weapons', subs, new Map([['all', 5], ['direct', 3], ['beam', 2]]), 'direct', emptyFilters());
    expect(html).toContain('role="radio" data-sub="direct" data-key="sub:direct" aria-checked="true"');
    expect(html).toContain('data-needs="turret" data-key="sub:turret" aria-pressed="false"');
    expect(html).toContain('data-group="sub"');
    expect(html).toContain('data-group="needs"');
    expect(subsHtml('power', [{ id: 'make', label: 'Generators' }], new Map(), 'all', emptyFilters())).toBe('');
  });
});
