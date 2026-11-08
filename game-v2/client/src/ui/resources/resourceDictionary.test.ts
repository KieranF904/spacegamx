/**
 * The Resources tab: one escaped row per resource, a chip per category, and the guide lists the tab.
 */
import { describe, it, expect } from 'vitest';
import { resourcesHtml } from './resourceDictionary';
import { resourceEntries } from './resourceData';
import { guideHtml, GUIDE_TABS } from '../fieldGuide';

const deps = { icon: (id: string) => (id === 'iron_ore' ? 'data:image/png;base64,AAAA' : '') };

describe('resource dictionary view', () => {
  const html = resourcesHtml(deps);

  it('has a row for every entry and a chip per category', () => {
    expect((html.match(/class="rd-row"/g) ?? []).length).toBe(resourceEntries().length);
    for (const c of ['all', 'ore', 'refined', 'component', 'pack', 'ammo', 'drop']) expect(html).toContain(`data-rcat="${c}"`);
  });

  it('uses the icon when there is one, else a colour swatch', () => {
    expect(html).toContain('<img src="data:image/png;base64,AAAA"');
    expect(html).toContain('<i style="background:');
  });

  it('puts the places in the search text, so "void sector" finds platinoid ore', () => {
    const row = html.split('<details').find((r) => r.includes('<span class="rd-name">Platinoid Ore</span>'))!;
    expect(row.match(/data-q="([^"]*)"/)![1]).toContain('void sector');
  });

  it('is a tab of the guide and renders through guideHtml', () => {
    expect(GUIDE_TABS.map((t) => t.id)).toContain('resources');
    expect(guideHtml('resources', { ...deps, k: (a: string) => a, threats: () => ({}), myRating: () => 0, level: () => 1, xp: () => 0 })).toContain('data-resources');
  });
});
