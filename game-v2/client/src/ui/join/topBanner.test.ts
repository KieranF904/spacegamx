import { describe, it, expect } from 'vitest';
import { mountTopBanner, TOP_BANNER_H } from './topBanner';

/** A page with just what the banner asks of one */
function page() {
  const made: { tag: string; className: string; innerHTML: string; textContent: string }[] = [];
  const el = (tag: string) => { const e = { tag, className: '', innerHTML: '', textContent: '', addEventListener() {} }; made.push(e); return e; };
  const doc = {
    made,
    querySelector: (sel: string) => made.find((e) => sel === '.' + e.className) ?? null,
    createElement: el,
    head: { appendChild() {} },
    body: { appendChild() {} },
  };
  return doc;
}

describe('the banner along the top of the game', () => {
  it('is put on the page once, however often it is asked for, with the support link in it', () => {
    const doc = page();
    const a = mountTopBanner(doc as never), b = mountTopBanner(doc as never);
    expect(a).toBe(b);
    expect(doc.made.filter((e) => e.className === 'sg-topbar').length).toBe(1);
    expect(a.innerHTML).toContain('>Support the game</a>');
    // (the address at the left is out of the flow, so the links stay in the middle)
    expect(a.innerHTML).toMatch(/<a class="sg-site" href="[^"]+" target="_blank" rel="noopener">space\.brotherk3d\.com<\/a>/);
    expect(doc.made.find((e) => e.tag === 'style')!.textContent).toMatch(/\.sg-topbar \.sg-site \{[^}]*position: absolute/);
    expect(TOP_BANNER_H).toBeLessThanOrEqual(20);
  });

  it('only its links take the pointer: the bar itself lets a click through to the game', () => {
    const doc = page();
    mountTopBanner(doc as never);
    const css = doc.made.find((e) => e.tag === 'style')!.textContent;
    expect(css).toMatch(/\.sg-topbar \{[^}]*pointer-events: none/);
    expect(css).toMatch(/\.sg-topbar \.support-link \{[^}]*pointer-events: auto/);
  });
});
