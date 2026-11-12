/**
 * The field guide renders every tab, and Progress carries the unlock track
 * (you marked on it).
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
    expect(html).toMatch(/Next: [^<]+ and \d+ more at Lv 12/);
    // Models by family, materials, room; the levels behind faded
    expect(html).toMatch(/<em>Cannon<\/em>Twinlink/);
    expect(html).toContain('Titanium structure');
    expect(html).toContain('Constructor');
    expect(html).toMatch(/Build points \d+/);
    expect(html.indexOf('fg-step you')).toBeLessThan(html.indexOf('<em>Cannon</em>Twinlink'));
  });

  it('Tiers & scaling lists pilots gear and public systems only: no dev material, no private, training, dev or boss-lair system', () => {
    const threats = { sol: 10, vesta_yard: 5, gun_range: 5, dev_rockery: 5, ashfall_cavern: 80, sol_scrap_nest: 9, homestead: 5 };
    const html = guideHtml('tiers', { ...deps(12), threats: () => threats });
    for (const hidden of ['Singularity', 'Dev ', 'Rockery', 'Gun Range', 'Vesta', 'Your Station', 'Scrap Mother', 'Cavern']) expect(html, hidden).not.toContain(hidden);
    // (Dev Singularity would read x60 on the grade chart and table)
    expect(html).not.toContain('×60');
    expect(html).toContain('Sol System');
    expect(html).toContain('Mk grades');
    expect(html).toContain('Weapon size');
    // (Five grades, one material each)
    expect(html.match(/<span class="fg-mk">Mk [IV]+<\/span><\/td><td>/g)?.length).toBe(5);
  });
});
