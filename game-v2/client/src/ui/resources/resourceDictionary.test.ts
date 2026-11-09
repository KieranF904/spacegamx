/**
 * The Resources tab: an icon grid per view (resources, rocks, enemies, systems), a preview and a details drawer,
 * clickable icons that show a tier and never a number, and the guide lists the tab.
 */
import { describe, it, expect } from 'vitest';
import { resourcesHtml } from './resourceDictionary';
import { detailHtml, previewHtml } from './entryCards';
import { resourceEntries, sourceIndex } from './resourceData';
import { guideHtml, GUIDE_TABS } from '../fieldGuide';

const deps = { icon: (id: string) => (id === 'iron_ore' ? 'data:image/png;base64,AAAA' : '') };

describe('resource dictionary view', () => {
  const html = resourcesHtml(deps);
  const ix = sourceIndex();

  it('has a tile for every entry and source, and a chip per category', () => {
    for (const [view, n] of [['res', resourceEntries().length], ['rock', ix.rocks.length], ['enemy', ix.enemies.length], ['sys', ix.systems.length]] as const) {
      expect((html.match(new RegExp(`class="rg-tile" data-view-of="${view}"`, 'g')) ?? []).length, view).toBe(n);
    }
    for (const c of ['all', 'ore', 'refined', 'component', 'pack', 'ammo', 'drop']) expect(html).toContain(`data-rcat="${c}"`);
  });

  it('is a grid of icons: no table, no rows, no hint text, nothing clickable inside a tile', () => {
    expect(html).not.toContain('<table');
    expect(html).not.toContain('rt-hint');
    expect(html).not.toContain('sp-row');
    expect(html).not.toContain('data-go="');
  });

  it('uses the icon when there is one, else a colour swatch', () => {
    expect(html).toContain('<img src="data:image/png;base64,AAAA"');
    expect(html).toContain('<i style="background:');
  });

  it('puts the places in the search text, so "void sector" finds platinoid ore', () => {
    const tile = html.split('<button type="button" class="rg-tile"').find((r) => r.includes('<span class="rg-name rd-name">Platinoid Ore</span>'))!;
    expect(tile.match(/data-q="([^"]*)"/)![1]).toContain('void sector');
  });

  it('has the four views', () => {
    for (const v of ['res', 'rock', 'enemy', 'sys']) expect(html).toContain(`data-view-tab="${v}"`);
  });

  it('shows the extended details with icons that open entries, and a preview with none', () => {
    const detail = detailHtml('res', 'iron_ore', deps);
    expect(detail).toContain('data-go="rock:asteroid_metal"');
    expect(detail).toContain('data-go="res:alloy_plate"');
    expect(detail).toContain('data-go="sys:sol"');
    expect(detail).toMatch(/<button type="button" class="gc t-high" data-go="rock:[^"]*" title="[^"]*: High"/);
    const small = previewHtml('res', 'iron_ore', deps);
    expect(small).not.toContain('data-go');
    expect(small).toContain('Mined from');
    expect(detailHtml('enemy', 'boss_rustjaw', deps)).toContain('data-go="res:rustjaw_cog"');
  });

  it('is a tab of the guide and renders through guideHtml', () => {
    expect(GUIDE_TABS.map((t) => t.id)).toContain('resources');
    expect(guideHtml('resources', { ...deps, k: (a: string) => a, threats: () => ({}), myRating: () => 0, level: () => 1, xp: () => 0 })).toContain('data-resources');
  });
});
