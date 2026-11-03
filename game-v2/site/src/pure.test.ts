import { describe, expect, it } from 'vitest';
import { html, raw, esc } from './html.js';
import { renderMarkdown, plainText, firstParagraph, firstImage, safeUrl } from './markdown.js';
import { parseFrontMatter, slugify, normaliseTag } from './frontmatter.js';
import { checkPost } from './posts.js';
import { Csrf, RateLimiter, parseCookies, cookie, newApiToken, hashToken, sameOrigin } from './security.js';
import { injectHandoff, handoffScript, isDevGamePath } from './play.js';
import { cleanShout } from './shoutbox.js';
import { sniffImage } from './uploads.js';
import { toCard, toRankings } from './pilots.js';
import { rssFeed } from './rss.js';
import { decoratePostImages, postImages } from './postImages.js';
import type http from 'http';

describe('html templates escape by default', () => {
  it('escapes values, keeps SafeHtml, joins arrays, drops booleans and nulls', () => {
    const name = '<img src=x onerror=alert(1)>"\'`';
    const out = html`<p title="${name}">${name}${[html`<b>${'&'}</b>`, '<i>']}${null}${false}${raw('<br>')}</p>`.value;
    expect(out).toBe('<p title="&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&#96;">&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&#96;<b>&amp;</b>&lt;i&gt;<br></p>');
    expect(esc(undefined)).toBe('');
  });
});

describe('markdown is sanitised', () => {
  it('keeps formatting, images and safe links in posts', () => {
    const out = renderMarkdown('## Head\n\n**bold** [site](/updates) [ext](https://example.com) ![alt](/uploads/x.png)');
    expect(out).toContain('<h2>Head</h2>');
    expect(out).toContain('<strong>bold</strong>');
    expect(out).toContain('<a href="/updates">site</a>');
    expect(out).toMatch(/<a href="https:\/\/example.com" rel="noopener noreferrer" target="_blank">ext<\/a>/);
    expect(out).toContain('<img src="/uploads/x.png" alt="alt" loading="lazy" decoding="async" />');
  });

  it('never passes raw HTML or script URLs, even in posts', () => {
    const evil = [
      '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '[x](javascript:alert(1))', '[x](JaVaScRiPt:alert(1))',
      '![x](javascript:alert(1))', '<a href="javascript:alert(1)">y</a>', '[x](data:text/html,<script>alert(1)</script>)',
      '<iframe src="https://evil"></iframe>', '[x](//evil.example/path)', '<svg onload=alert(1)>', '<style>body{}</style>',
    ];
    for (const src of evil) {
      for (const mode of ['post', 'comment'] as const) {
        const out = renderMarkdown(src, mode);
        expect(out, src).not.toMatch(/<(script|iframe|svg|style)\b/i);
        expect(out, src).not.toMatch(/<[^>]*\son\w+=/i); // (as escaped text it's harmless)
        // (checked inside real tags: as escaped text these are harmless)
        expect(out, src).not.toMatch(/<[a-z][^>]*(href|src)="(javascript|data):/i);
        expect(out, src).not.toMatch(/<a [^>]*href="\/\//);
      }
    }
  });

  it('comments get a smaller set: no images or headings, links are nofollow ugc', () => {
    const out = renderMarkdown('# Big\n\n![pic](/uploads/a.png) [l](https://e.com)', 'comment');
    expect(out).not.toMatch(/<h\d|<img/);
    expect(out).toContain('rel="nofollow ugc noopener noreferrer"');
  });

  it('plain text, first paragraph and first image', () => {
    expect(plainText('Hello **there** & <b>you</b>', 0)).toBe('Hello there & <b>you</b>');
    expect(plainText('one two three four five six', 12)).toBe('one two…');
    expect(firstParagraph('![a](/x.png)\n\n## H\n\nThe *real* start.\n\nMore')).toBe('The real start.');
    expect(firstImage('text ![a](/uploads/a.png) ![b](/b.png)')).toBe('/uploads/a.png');
    expect(firstImage('![a](javascript:x)')).toBeNull();
    expect(safeUrl('//evil', 'link')).toBe(false);
    expect(safeUrl('/\\evil', 'link')).toBe(false);
    expect(safeUrl('#top', 'image')).toBe(false);
  });
});

describe('front matter', () => {
  it('reads title, tags, status and the body', () => {
    const { meta, body } = parseFrontMatter('---\r\ntitle: "Wires: a guide"\r\ntags: [Ships, parts!, ships]\r\ndraft: true\r\nslug: wires\r\n---\r\n\r\nBody **here**\r\n');
    expect(meta).toEqual({ title: 'Wires: a guide', tags: ['ships', 'parts'], status: 'draft', slug: 'wires' });
    expect(body).toBe('Body **here**');
  });
  it('status spellings and no front matter', () => {
    expect(parseFrontMatter('---\nstatus: publish\n---\nx').meta.status).toBe('published');
    expect(parseFrontMatter('---\npublish: yes\n---\nx').meta.status).toBe('published');
    expect(parseFrontMatter('---\ntags: a, b c\n---\nx').meta.tags).toEqual(['a', 'b-c']);
    expect(parseFrontMatter('# Just text')).toEqual({ meta: {}, body: '# Just text' });
  });
  it('slugs and tags', () => {
    expect(slugify("The Scrap Mother's Nest!")).toBe('the-scrap-mothers-nest');
    expect(slugify('Café   déjà vu')).toBe('cafe-deja-vu');
    expect(slugify('!!!')).toBe('post');
    expect(normaliseTag('  Big Boss!! ')).toBe('big-boss');
  });
});

describe('post checks', () => {
  it('a whole post: tidied, slug from title, draft by default', () => {
    const r = checkPost({ title: '  Hello   world ', body: ' Text ', tags: 'A, b, a' }, false);
    expect(r).toEqual({ ok: true, value: { title: 'Hello world', body: 'Text', slug: 'hello-world', summary: '', tags: ['a', 'b'], cover: null, status: 'draft' } });
  });
  it('refuses missing title or body, bad status, unsafe cover', () => {
    expect(checkPost({ body: 'x' }, false).ok).toBe(false);
    expect(checkPost({ title: 'x' }, false).ok).toBe(false);
    expect(checkPost({ title: 'x', body: 'y', status: 'live!' }, false).ok).toBe(false);
    expect(checkPost({ title: 'x', body: 'y', cover: 'javascript:alert(1)' }, false).ok).toBe(false);
  });
  it('a partial update only touches what was sent', () => {
    expect(checkPost({ status: 'published' }, true)).toEqual({ ok: true, value: { status: 'published' } });
    expect(checkPost({ tags: ['X Y'] }, true)).toEqual({ ok: true, value: { tags: ['x-y'] } });
  });
});

describe('security helpers', () => {
  it('CSRF tokens verify only for their own seed and secret', () => {
    const c = new Csrf('secret');
    const seed = Csrf.seed();
    const t = c.token(seed);
    expect(c.verify(seed, t)).toBe(true);
    expect(c.verify(Csrf.seed(), t)).toBe(false);
    expect(new Csrf('other').verify(seed, t)).toBe(false);
    expect(c.verify(seed, undefined)).toBe(false);
    expect(c.verify(seed, t.slice(1))).toBe(false);
  });
  it('rate limiter: a sliding window per key', () => {
    let now = 0;
    const r = new RateLimiter(() => now);
    expect([1, 2, 3].map(() => r.hit('k', 2, 1000))).toEqual([true, true, false]);
    expect(r.hit('other', 2, 1000)).toBe(true);
    expect(r.retryAfter('k', 2, 1000)).toBe(1);
    now = 1001;
    expect(r.hit('k', 2, 1000)).toBe(true);
  });
  it('cookies: parse and set with HttpOnly, SameSite and Secure', () => {
    expect(parseCookies('a=1; b=hello%20there; a=2; bad')).toEqual({ a: '1', b: 'hello there' });
    expect(cookie('s', 'v', { secure: true, maxAge: 10 })).toBe('s=v; Path=/; SameSite=Lax; HttpOnly; Secure; Max-Age=10');
    expect(cookie('s', 'v', { secure: false })).not.toContain('Secure');
  });
  it('API tokens: shown once, kept as a hash', () => {
    const t = newApiToken();
    expect(t.token).toMatch(/^sgs_[A-Za-z0-9_-]{40,}$/);
    expect(t.hash).toBe(hashToken(t.token));
    expect(t.hash).not.toContain(t.token.slice(4));
    expect(t.token.startsWith(t.prefix)).toBe(true);
  });
  it('same-origin check', () => {
    const req = (h: Record<string, string>) => ({ headers: { host: 'localhost:5310', ...h } }) as unknown as http.IncomingMessage;
    expect(sameOrigin(req({ origin: 'http://localhost:5310' }), 'http://localhost:5310')).toBe(true);
    expect(sameOrigin(req({ origin: 'https://evil.example' }), 'http://localhost:5310')).toBe(false);
    expect(sameOrigin(req({ referer: 'https://evil.example/x' }), 'http://localhost:5310')).toBe(false);
    expect(sameOrigin(req({}), 'http://localhost:5310')).toBe(true);
  });
});

describe('play handoff', () => {
  const index = '<!DOCTYPE html><html><head><script type="module" src="/@vite/client"></script></head><body></body></html>';
  it('puts the token first in <head>, only when signed in', () => {
    const out = injectHandoff(index, 'a'.repeat(96));
    expect(out.indexOf("localStorage.setItem('authToken'")).toBeLessThan(out.indexOf('/@vite/client'));
    expect(out.indexOf('<head>')).toBeLessThan(out.indexOf('localStorage'));
    expect(injectHandoff(index, null)).toBe(index);
  });
  it("won't inject anything that isn't token-shaped", () => {
    expect(handoffScript('abc</script><script>alert(1)')).toBe('');
    expect(handoffScript('short')).toBe('');
  });
  it("knows the dev server's paths", () => {
    expect(isDevGamePath('/src/main.ts')).toBe(true);
    expect(isDevGamePath('/@vite/client')).toBe(true);
    expect(isDevGamePath('/sfx/index.json')).toBe(true);
    expect(isDevGamePath('/suggestions')).toBe(false);
    expect(isDevGamePath('/srcery')).toBe(false);
  });
});

describe('small parts', () => {
  it('shouts are cleaned of control and direction characters', () => {
    expect(cleanShout('  hi\n\tthere‮!\u0000 ')).toBe('hi there !');
    expect(cleanShout('​​')).toBe('');
  });
  it('images are sniffed by their bytes', () => {
    const pad = Buffer.alloc(16);
    expect(sniffImage(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), pad]))).toBe('png');
    expect(sniffImage(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), pad]))).toBe('jpg');
    expect(sniffImage(Buffer.concat([Buffer.from('RIFF0000WEBP'), pad]))).toBe('webp');
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'))).toBeNull();
  });
  it('pilot cards from profiles of any shape', () => {
    const card = toCard({ level: 7, xp: 900, credits: 1200, ship: { blueprint: { name: 'Stubborn' } }, hangar: [{}, null, {}],
      stats: { kills: 41, bosses: 2, 'boss:boss_scrap_mother': 2, 'sys:sol': 1, 'sys:vesta': 1, 'ach:first_blood': 1700000000 }, codex: { found: ['a', 'b'] }, createdAt: '2026-10-01T00:00:00Z' });
    expect(card).toMatchObject({ level: 7, shipName: 'Stubborn', ships: 2, systemsVisited: 2, ribbons: 1, codexFound: 2, bossKills: { boss_scrap_mother: 2 } });
    expect(card.stats.kills).toBe(41);
    expect(toCard({}).level).toBe(1);
  });
  it('rankings: sorted, zeroes dropped, top N', () => {
    const r = toRankings({ week: 3, weekly: {}, allTime: { 1: { name: 'a', v: { kills: 5 } }, 2: { name: 'b', v: { kills: 9, bosses: 1 } }, 3: { name: 'c', v: { kills: 0 } } } });
    expect(r!.allTime.kills.map((x) => x.name)).toEqual(['b', 'a']);
    expect(r!.allTime.bosses).toEqual([{ userId: '2', name: 'b', value: 1 }]);
    expect(toRankings(null)).toBeNull();
  });
  it('RSS: escaped, absolute links, CDATA safe', () => {
    const xml = rssFeed([{ id: 1, slug: 'a-b', title: 'Fish & <chips>', summary: '', body: 'Hi ![x](/uploads/a.png) ]]> end', tags: ['t'], cover: null, status: 'published', authorId: 1, authorName: 'k', createdAt: '2026-10-30T00:00:00Z', updatedAt: '2026-10-30T00:00:00Z', publishedAt: '2026-10-30T00:00:00Z' }], { origin: 'https://space.example', siteName: 'Space Game' });
    expect(xml).toContain('<title>Fish &amp; &lt;chips&gt;</title>');
    expect(xml).toContain('src="https://space.example/uploads/a.png"');
    expect(xml).toContain('<link>https://space.example/updates/a-b</link>');
    expect(xml.match(/<content:encoded><!\[CDATA\[[\s\S]*?\]\]><\/content:encoded>/)).not.toBeNull();
  });
});

describe('post images', () => {
  const md = '![One & two](/uploads/a.png?x=1&y=2)\n\n![](/uploads/b.png)\n\n![One again](/uploads/a.png?x=1&y=2)\n\n[![Linked](/uploads/c.png)](/somewhere)';
  it('lists each image once, by its rendered src, and leaves linked ones alone', () => {
    expect(postImages(md)).toEqual([{ src: '/uploads/a.png?x=1&y=2', alt: 'One & two' }, { src: '/uploads/b.png', alt: '' }]);
    expect(postImages('No pictures here')).toEqual([]);
  });
  it('wraps them, with a count badge linking to the first comment on the image', () => {
    const { html: out } = decoratePostImages(renderMarkdown(md, 'post'), new Map([['/uploads/b.png', { count: 2, firstId: 7 }]]));
    expect(out.match(/<span class="pic">/g)).toHaveLength(3);
    expect(out).toContain('<a class="pic-count" href="#c7" aria-label="2 comments on this image"');
    expect(out).not.toContain('<span class="pic"><img src="/uploads/c.png"');
  });
});
