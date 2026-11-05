import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GuideBook, parseGuide, stripComments, withHeadingIds } from './guides.js';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../guides');

describe('guide parsing', () => {
  it('drops HTML comments so TODO notes never show', () => {
    expect(stripComments('a <!-- TODO: x\nmore --> b')).toBe('a  b');
    const g = parseGuide('01-demo.md', '---\ntitle: Demo\nsummary: S\nchecked: 2026-11-04\n---\nHello\n\n<!-- TODO: check this -->\n\n## One\n\ntext');
    expect(g?.html).not.toContain('TODO');
    expect(g?.text).not.toContain('TODO');
    expect(g?.slug).toBe('demo');
  });

  it('puts ids on h2 and h3 headings, and lists the h2s', () => {
    const { html, toc } = withHeadingIds('<h2>Making power</h2><h3>Banks</h3><h2>Making <code>power</code></h2>');
    expect(html).toContain('<h2 id="making-power">');
    expect(html).toContain('<h3 id="banks">');
    expect(toc.map((t) => t.id)).toEqual(['making-power', 'making-power-2']);
  });

  it('needs a title and a NN-slug file name', () => {
    expect(parseGuide('demo.md', '---\ntitle: X\n---\nbody')).toBeNull();
    expect(parseGuide('01-demo.md', 'no front matter')).toBeNull();
  });
});

describe('the guides in site/guides', () => {
  const book = new GuideBook(dir);

  it('all parse, with unique slugs and orders, and each has a summary, a group and a date', async () => {
    const list = await book.all();
    expect(list.length).toBeGreaterThanOrEqual(11);
    expect(new Set(list.map((g) => g.slug)).size).toBe(list.length);
    expect(new Set(list.map((g) => g.order)).size).toBe(list.length);
    for (const g of list) {
      expect(g.summary.length, g.slug).toBeGreaterThan(20);
      expect(['Basics', 'Ships', 'Economy', 'World'], g.slug).toContain(g.group);
      expect(g.checked, g.slug).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(g.toc.length, g.slug).toBeGreaterThan(1);
    }
  });

  it('every internal link points at a real guide or heading', async () => {
    const list = await book.all();
    const ids = new Map(list.map((g) => [g.slug, new Set([...g.html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]))]));
    for (const g of list) {
      for (const m of g.html.matchAll(/href="([^"]+)"/g)) {
        const href = m[1];
        if (href.startsWith('#')) expect(ids.get(g.slug)!.has(href.slice(1)), `${g.slug} ${href}`).toBe(true);
        else if (href.startsWith('/guides/')) {
          const [slug, hash] = href.slice('/guides/'.length).split('#');
          expect(ids.has(slug), `${g.slug} -> ${href}`).toBe(true);
          if (hash) expect(ids.get(slug)!.has(hash), `${g.slug} -> ${href}`).toBe(true);
        } else expect(href.startsWith('/') || href.startsWith('http'), `${g.slug} ${href}`).toBe(true);
      }
    }
  });

  it('no story: nothing about history, origins, codex records, mysteries or hints', async () => {
    const banned = /\b(lore|codex|colony|colonists?|ancient|relic|legend of|backstory|origin story|mystery|mysterious|settlers say|pilots say|geologists|whispers?|rumou?rs of)\b/i;
    for (const g of await book.all()) expect(banned.exec(g.text)?.[0], g.slug).toBeUndefined();
  });

  it('plain voice: no exclamation marks, no emoji', async () => {
    for (const g of await book.all()) {
      expect(g.text.includes('!'), `${g.slug} has an exclamation mark`).toBe(false);
      expect(/\p{Extended_Pictographic}/u.test(g.text), `${g.slug} has an emoji`).toBe(false);
    }
  });

  it('every source comment is a comment, not text: no TODO shows in a page', async () => {
    for (const g of await book.all()) expect(g.html, g.slug).not.toContain('TODO');
    // ...and the source files do carry the notes for what was unconfirmed
    const raw = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
    expect(raw).toContain('<!-- TODO');
  });
});
