import { describe, it, expect } from 'vitest';
import { crumbsOf, popPage, pushPage, type Page } from './pageNav';

describe('detail page history', () => {
  it('pushes, ignores the page already showing, and pops back to the grid', () => {
    const s: Page[] = [];
    expect(pushPage(s, { view: 'res', id: 'iron_ore' })).toBe(true);
    expect(pushPage(s, { view: 'res', id: 'iron_ore' })).toBe(false);
    pushPage(s, { view: 'sys', id: 'sol' });
    expect(s.length).toBe(2);
    expect(popPage(s)).toEqual({ view: 'res', id: 'iron_ore' });
    expect(popPage(s)).toBeUndefined();
    expect(s.length).toBe(0);
  });

  it('builds breadcrumbs: view, category for a resource, then the entry', () => {
    expect(crumbsOf({ view: 'res', id: 'iron_ore' }).map((c) => c.label)).toEqual(['Resources', 'Ore', 'Iron Ore']);
    expect(crumbsOf({ view: 'sys', id: 'sol' }).map((c) => c.label)).toEqual(['Systems', 'Sol System']);
    expect(crumbsOf({ view: 'sys', id: 'sol' })[1].to).toBeUndefined();
  });
});
