import { describe, it, expect } from 'vitest';
import { bodyBlocks, fetchNews, newsDate, newsHtml, parseNews, toggleNews, NEWS_MAX, type NewsItem } from './newsFeed';

const item = (over: Partial<NewsItem> = {}): NewsItem => ({
  slug: 'a-post', title: 'A post', date: '2026-11-09T10:00:00.000Z', body: 'First.\n\n- one\n- two', url: 'https://space.example/updates/a-post', ...over,
});
const reply = (json: unknown, ok = true) => (async () => ({ ok, json: async () => json })) as unknown as typeof fetch;

describe('news feed model', () => {
  it('shows date and title collapsed, and the text and the link when opened', () => {
    const state = { status: 'ok' as const, items: [item()] };
    const shut = newsHtml(state, new Set());
    expect(shut).toContain('2026-11-09');
    expect(shut).toContain('A post');
    expect(shut).toContain('aria-expanded="false"');
    expect(shut).not.toContain('news-body');
    const open = newsHtml(state, new Set(['a-post']));
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain('<p>First.</p>');
    expect(open).toContain('<ul><li>one</li><li>two</li></ul>');
    expect(open).toContain('href="https://space.example/updates/a-post"');
    expect(open).toContain('Open on the website');
  });

  it('keeps the order it was given (newest first) and toggles by slug', () => {
    const html = newsHtml({ status: 'ok', items: [item({ slug: 'new', title: 'Newer' }), item({ slug: 'old', title: 'Older' })] }, new Set());
    expect(html.indexOf('Newer')).toBeLessThan(html.indexOf('Older'));
    const a = toggleNews(new Set(), 'x');
    expect([...a]).toEqual(['x']);
    expect([...toggleNews(a, 'x')]).toEqual([]);
  });

  it('escapes everything from the reply and drops non-http links', () => {
    const evil = '<img src=x onerror="alert(1)">';
    const html = newsHtml({ status: 'ok', items: [item({ title: evil, body: evil, slug: evil })] }, new Set([evil]));
    expect(html).not.toContain('<img');
    expect(html).not.toMatch(/onerror="/);
    const parsed = parseNews({ items: [{ title: 'x', url: 'javascript:alert(1)' }] });
    expect(parsed?.[0].url).toBe('');
    expect(newsHtml({ status: 'ok', items: parsed! }, new Set([parsed![0].slug]))).not.toContain('href=');
  });

  it('has a state for loading, empty and failed', () => {
    expect(newsHtml({ status: 'loading' }, new Set())).toContain('Loading news');
    expect(newsHtml({ status: 'failed' }, new Set())).toContain('News unavailable');
    expect(newsHtml({ status: 'ok', items: [] }, new Set())).toContain('No news yet');
  });

  it('reads bodies as paragraphs and bullet lists; dates as a day', () => {
    expect(bodyBlocks('One\ntwo\n\n- a\n- b\n\n\nThree')).toEqual([{ p: 'One two' }, { ul: ['a', 'b'] }, { p: 'Three' }]);
    expect(newsDate('2026-11-09T10:00:00Z')).toBe('2026-11-09');
  });
});

describe('news fetch', () => {
  it('parses a good reply, skipping bad items and capping the count', async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ slug: `s${i}`, title: `T${i}`, date: '2026-11-09', body: '', url: '' }));
    const s = await fetchNews('u', reply({ items: [null, { nope: 1 }, ...many] }));
    expect(s.status).toBe('ok');
    if (s.status === 'ok') { expect(s.items).toHaveLength(NEWS_MAX); expect(s.items[0].title).toBe('T0'); }
  });

  it('a failed, bad, malformed or thrown reply is the failed state', async () => {
    expect((await fetchNews('u', reply({ items: [] }, false))).status).toBe('failed');
    expect((await fetchNews('u', reply({ items: 'x' }))).status).toBe('failed');
    expect((await fetchNews('u', reply(null))).status).toBe('failed');
    expect((await fetchNews('u', (async () => { throw new Error('offline'); }) as unknown as typeof fetch)).status).toBe('failed');
    const notJson = (async () => ({ ok: true, json: async () => { throw new SyntaxError('<!doctype'); } })) as unknown as typeof fetch;
    expect((await fetchNews('u', notJson)).status).toBe('failed');
  });

  it('gives up after the timeout', async () => {
    const hang = ((_u: string, init: RequestInit) => new Promise((_res, rej) => init.signal!.addEventListener('abort', () => rej(new Error('aborted'))))) as unknown as typeof fetch;
    expect((await fetchNews('u', hang, 20)).status).toBe('failed');
  });
});
