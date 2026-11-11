/**
 * @contract client.ui.join.news-feed
 * owns:       the join screen's development news: the website's launcher-news JSON (checked), its state (loading, items,
 *             failed), and the feed's HTML (collapsed items that open to their text and a link to the post)
 * needs:      fetch and AbortController (injectable), ../escape; the website's GET /api/v1/launcher-news (site/src/launcherNews.ts)
 * invariants: a slow, failed or malformed reply gives the "News unavailable" state and never throws — client/src/ui/join/newsFeed.test.ts
 *             nothing from the reply reaches the page unescaped, and only http(s) links are used — client/src/ui/join/newsFeed.test.ts
 *             items are shown newest first, at most 10, collapsed until opened — client/src/ui/join/newsFeed.test.ts
 * extend:     a new field on an item goes in parseNews and itemHtml
 */
/**
 * Where the news comes from: the website, which keeps the posts (a post flagged "launcher" in its editor). The page
 * asks once at load with a short timeout and never waits for it: the join screen shows "Loading news..." and then
 * either the items or "News unavailable". Opened items are kept by slug so a re-render keeps them open.
 */

import { esc } from '../escape';

export interface NewsItem {
  slug: string;
  title: string;
  /** ISO time */
  date: string;
  /** Plain text: paragraphs split by a blank line, a paragraph of "- " lines is a bullet list */
  body: string;
  /** The post's page on the website */
  url: string;
}

export type NewsState =
  | { status: 'loading' }
  | { status: 'ok'; items: NewsItem[] }
  | { status: 'failed' };

export const NEWS_MAX = 10;
export const NEWS_TIMEOUT_MS = 4000;

const env = (import.meta as { env?: { VITE_SITE_URL?: string; DEV?: boolean } }).env;

/**
 * The website's address. VITE_SITE_URL overrides it at build/dev time. Without it: the local site (port 5310) on a dev
 * build, else this page's own host (the website and the game share one on the live server; nginx sends /api/ to the site).
 */
export const NEWS_URL: string = `${(env?.VITE_SITE_URL ?? (env?.DEV ? 'http://localhost:5310' : '')).replace(/\/+$/, '')}/api/v1/launcher-news`;

const isHttp = (u: unknown): u is string => typeof u === 'string' && /^https?:\/\//i.test(u);

/** The reply's items, each checked, newest first (as the site sends them), or null if it isn't the expected shape */
export function parseNews(json: unknown): NewsItem[] | null {
  const raw = (json as { items?: unknown } | null)?.items;
  if (!Array.isArray(raw)) return null;
  const items: NewsItem[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (typeof o.title !== 'string' || !o.title.trim()) continue;
    items.push({
      slug: typeof o.slug === 'string' ? o.slug : String(items.length),
      title: o.title,
      date: typeof o.date === 'string' ? o.date : '',
      body: typeof o.body === 'string' ? o.body : '',
      url: isHttp(o.url) ? o.url : '',
    });
    if (items.length >= NEWS_MAX) break;
  }
  return items;
}

/** Ask the website. Any failure (offline, slow, not JSON, wrong shape) is the failed state */
export async function fetchNews(url: string = NEWS_URL, fetchFn: typeof fetch = fetch, timeoutMs: number = NEWS_TIMEOUT_MS): Promise<NewsState> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchFn(url, { signal: ctl.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) return { status: 'failed' };
    const items = parseNews(await r.json());
    return items ? { status: 'ok', items } : { status: 'failed' };
  } catch {
    return { status: 'failed' };
  } finally {
    clearTimeout(timer);
  }
}

/** "2026-11-09" from an ISO time (the day as the site wrote it) */
export const newsDate = (iso: string): string => (/^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : iso);

/** The body's paragraphs and bullet lists */
export type NewsBlock = { p: string } | { ul: string[] };
export function bodyBlocks(body: string): NewsBlock[] {
  return body.replace(/\r\n/g, '\n').split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean).map((b): NewsBlock => {
    const lines = b.split('\n').map((l) => l.trim()).filter(Boolean);
    return lines.every((l) => /^[-*]\s+/.test(l)) ? { ul: lines.map((l) => l.replace(/^[-*]\s+/, '')) } : { p: lines.join(' ') };
  });
}

const blocksHtml = (body: string) => bodyBlocks(body)
  .map((b) => ('p' in b ? `<p>${esc(b.p)}</p>` : `<ul>${b.ul.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`)).join('');

function itemHtml(n: NewsItem, open: boolean): string {
  const id = esc(n.slug);
  return `
    <div class="news-item${open ? ' open' : ''}">
      <button type="button" class="news-head" data-news="${id}" aria-expanded="${open}">
        <span class="news-date">${esc(newsDate(n.date))}</span>
        <span class="news-title">${esc(n.title)}</span>
      </button>
      ${open ? `<div class="news-body">${blocksHtml(n.body)}${n.url ? `<a class="news-link" href="${esc(n.url)}" target="_blank" rel="noopener noreferrer">Open on the website</a>` : ''}</div>` : ''}
    </div>`;
}

/** What goes inside the feed's box. `open`: the slugs of the items that are expanded */
export function newsHtml(state: NewsState, open: ReadonlySet<string>): string {
  if (state.status === 'loading') return '<div class="news-empty">Loading news…</div>';
  if (state.status === 'failed') return '<div class="news-empty">News unavailable</div>';
  if (state.items.length === 0) return '<div class="news-empty">No news yet. Updates from development will show up here.</div>';
  return state.items.map((n) => itemHtml(n, open.has(n.slug))).join('');
}

/** Open or close one item (a new set, so a held one isn't changed under its owner) */
export function toggleNews(open: ReadonlySet<string>, slug: string): Set<string> {
  const next = new Set(open);
  if (!next.delete(slug)) next.add(slug);
  return next;
}
