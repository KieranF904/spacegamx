/**
 * The detail pages: every entry of every view renders one, with the sections its kind needs, icons that open other pages, and tiers only.
 */
import { describe, it, expect } from 'vitest';
import { entryIds, pageHtml, type View } from './entryCards';
import { sourceIndex } from './resourceData';
import { resourcesHtml } from './resourceDictionary';

const deps = { icon: () => '' };
const VIEWS: View[] = ['res', 'rock', 'enemy', 'sys'];
const ix = sourceIndex();

describe('detail pages', () => {
  it('render for every entry of every view with a big icon, a name and a section grid', () => {
    for (const v of VIEWS) for (const id of entryIds(v)) {
      const h = pageHtml(v, id, deps);
      expect(h, `${v} ${id}`).toContain('class="gc huge"');
      expect(h, `${v} ${id}`).toContain('<h2>');
      expect(h, `${v} ${id}`).toContain('pg-secs');
    }
  });

  it('lay out the sections each kind needs, with icons that open other pages', () => {
    const sections = (v: View, id: string) => [...pageHtml(v, id, deps).matchAll(/<h3>([^<]*)<\/h3>/g)].map((m) => m[1]);
    expect(sections('res', 'iron_ore')).toEqual(expect.arrayContaining(['Mined from', 'Found in systems', 'Used for']));
    expect(sections('rock', ix.rocks[0].id)).toEqual(['Yields', 'Found in systems']);
    expect(sections('enemy', 'boss_rustjaw')).toEqual(['Drops', 'Found in systems']);
    expect(sections('sys', 'sol')).toEqual(['Asteroids', 'Resources here', 'Enemies']);
    expect(pageHtml('res', 'iron_ore', deps)).toContain('data-go="rock:asteroid_metal"');
    expect(pageHtml('sys', 'sol', deps)).toContain('data-go="res:iron_ore"');
  });

  it('show tiers only: no percentage or chance number on any page', () => {
    const noDesc = (x: string) => x.replace(/<div class="ec-(?:desc|hint)[^"]*">.*?<\/div>/g, '');
    for (const v of VIEWS) for (const id of entryIds(v)) expect(noDesc(pageHtml(v, id, deps)), `${v} ${id}`).not.toMatch(/\d\s*%|per 100|chance:? ?\d/i);
  });

  it('the grid shows category icons on the view tabs, chips and group headers', () => {
    const html = resourcesHtml(deps);
    expect((html.match(/<button class="rd-chip view[^>]*><svg class="rd-ic"/g) ?? []).length).toBe(4);
    expect(html).toMatch(/data-rcat="ore" data-res-only><svg class="rd-ic"/);
    expect(html).toMatch(/<h4><svg class="rd-ic"/);
  });
});
