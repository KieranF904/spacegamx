/**
 * The field guide renders every tab, and Progress carries the unlock track
 * (you marked on it) and Ships a link to the component guide.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { setUnlockTable, type UnlockTable } from '@space-game/common';
import { guideHtml, GUIDE_TABS } from './fieldGuide';
import unlockData from '../../../data/unlocks.json';

const deps = (level: number) => ({ k: (a: string) => `<kbd>${a}</kbd>`, threats: () => ({}), myRating: () => 0, level: () => level, xp: () => 30000, icon: () => '' });

describe('field guide', () => {
  // (As clientEcon does at start)
  beforeAll(() => setUnlockTable(unlockData as unknown as Partial<UnlockTable>));

  it('every tab renders', () => {
    for (const t of GUIDE_TABS) expect(guideHtml(t.id, deps(12)).length, t.id).toBeGreaterThan(100);
  });

  it('Progress shows the unlock track, you on it, and the next thing to build', () => {
    const html = guideHtml('progress', deps(11));
    expect(html).toContain('Unlock track');
    expect(html).toContain('fg-step you');
    expect(html).toMatch(/Next: Twinlink, Fabrication Bay and \d+ more at Lv 12/);
    // Models by family, materials, room; the levels behind faded
    expect(html).toMatch(/<em>Cannon<\/em>Twinlink/);
    expect(html).toContain('Titanium structure');
    expect(html).toContain('Constructor');
    expect(html).toMatch(/Build points \d+/);
    expect(html.indexOf('fg-step you')).toBeLessThan(html.indexOf('<em>Cannon</em>Twinlink'));
  });

  it('Ships links to the component guide', () => {
    const html = guideHtml('ships', deps(12));
    expect(html).toContain('data-a="components"');
    expect(html).toContain('<kbd>components</kbd>');
  });
});
