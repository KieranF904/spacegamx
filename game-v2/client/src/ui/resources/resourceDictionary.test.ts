/**
 * The Resources tab: one row per resource with icon chips, a chip per category, Rocks and Enemies views,
 * clickable icons that show a tier and never a number, and the guide lists the tab.
 */
import { describe, it, expect } from 'vitest';
import { resourcesHtml } from './resourceDictionary';
import { resourceEntries, sourceIndex } from './resourceData';
import { guideHtml, GUIDE_TABS } from '../fieldGuide';

const deps = { icon: (id: string) => (id === 'iron_ore' ? 'data:image/png;base64,AAAA' : '') };

describe('resource dictionary view', () => {
  const html = resourcesHtml(deps);

  it('has a row for every entry and source, and a chip per category', () => {
    expect((html.match(/class="rd-row"/g) ?? []).length).toBe(resourceEntries().length);
    expect((html.match(/class="sp-row"/g) ?? []).length).toBe(sourceIndex().rocks.length + sourceIndex().enemies.length);
    for (const c of ['all', 'ore', 'refined', 'component', 'pack', 'ammo', 'drop']) expect(html).toContain(`data-rcat="${c}"`);
  });

  it('uses the icon when there is one, else a colour swatch', () => {
    expect(html).toContain('<img src="data:image/png;base64,AAAA"');
    expect(html).toContain('<i style="background:');
  });

  it('puts the places in the search text, so "void sector" finds platinoid ore', () => {
    const row = html.split('<tr ').find((r) => r.includes('<b class="rd-name">Platinoid Ore</b>'))!;
    expect(row.match(/data-q="([^"]*)"/)![1]).toContain('void sector');
  });

  it('has icon chips that open rocks, enemies and resources, with a tier and no number', () => {
    expect(html).toContain('data-go="rock:asteroid_metal"');
    expect(html).toContain('data-go="enemy:boss_rustjaw"');
    expect(html).toContain('data-go="res:iron_ore"');
    expect(html).toMatch(/<button type="button" class="gc t-high" data-go="rock:[^"]*" title="[^"]*: High"/);
    expect(html).not.toMatch(/(title|aria-label)="[^"]*\d\s*%/);
  });

  it('shows a dash for an empty column and has the three views', () => {
    expect(html).toContain('class="dash"');
    for (const v of ['res', 'rock', 'enemy']) expect(html).toContain(`data-view-tab="${v}"`);
  });

  it('is a tab of the guide and renders through guideHtml', () => {
    expect(GUIDE_TABS.map((t) => t.id)).toContain('resources');
    expect(guideHtml('resources', { ...deps, k: (a: string) => a, threats: () => ({}), myRating: () => 0, level: () => 1, xp: () => 0 })).toContain('data-resources');
  });
});
