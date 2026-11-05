/**
 * The guides: practical pages about how the game works, written as Markdown files in site/guides/.
 *
 *   ---
 *   title: Energy and ports
 *   order: 4                    (position in the list and in previous/next)
 *   group: Ships                (the heading it sits under on /guides)
 *   summary: One line for the list and the page header
 *   checked: 2026-11-04         (when it was last checked against the game's code and data)
 *   sources: common/src/ships/energy.ts, data/ships/tuning.json    (for us: never shown)
 *   ---
 *   The Markdown body. `<!-- TODO: ... -->` comments hold what could not be confirmed in the code; they are
 *   removed before the page is built, so they never show.
 *
 * The file name is `NN-slug.md`; the URL is /guides/slug. Same Markdown renderer and sanitiser as posts.
 */

import fs from 'fs/promises';
import path from 'path';
import { parseFrontMatter } from './frontmatter.js';
import { plainText, renderMarkdown } from './markdown.js';

export interface Guide {
  slug: string;
  title: string;
  order: number;
  group: string;
  summary: string;
  /** ISO date (YYYY-MM-DD) or '' */
  checked: string;
  /** Sanitised HTML, with an id on each h2 */
  html: string;
  /** The h2s, for the contents list */
  toc: { id: string; text: string }[];
  /** Plain text (tests and search) */
  text: string;
}

const FILE = /^(\d+)-([a-z0-9][a-z0-9-]*)\.md$/;

/** HTML comments out (TODO notes in the source); the renderer would show them as text */
export function stripComments(md: string): string {
  return md.replace(/<!--[\s\S]*?-->/g, '');
}

function idOf(text: string, used: Set<string>): string {
  const base = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'section';
  let id = base, n = 2;
  while (used.has(id)) id = `${base}-${n++}`;
  used.add(id);
  return id;
}

const textOf = (h: string) => h.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();

/** Add ids to the headings (the sanitiser drops any the author wrote) and list the h2s */
export function withHeadingIds(htmlIn: string): { html: string; toc: { id: string; text: string }[] } {
  const used = new Set<string>();
  const toc: { id: string; text: string }[] = [];
  const html = htmlIn.replace(/<(h[23])>([\s\S]*?)<\/\1>/g, (_m, tag: string, inner: string) => {
    const text = textOf(inner);
    const id = idOf(text, used);
    if (tag === 'h2') toc.push({ id, text });
    return `<${tag} id="${id}">${inner}</${tag}>`;
  });
  return { html, toc };
}

export function parseGuide(file: string, source: string): Guide | null {
  const m = FILE.exec(file);
  if (!m) return null;
  const { meta, body } = parseFrontMatter(source);
  const md = stripComments(body).trim();
  const title = String(meta.title ?? '').trim();
  if (!title) return null;
  const { html, toc } = withHeadingIds(renderMarkdown(md, 'post'));
  const order = Number.isFinite(Number(meta.order)) && String(meta.order ?? '') !== '' ? Number(meta.order) : Number(m[1]);
  const checked = /^\d{4}-\d{2}-\d{2}$/.test(String(meta.checked ?? '')) ? String(meta.checked) : '';
  return {
    slug: m[2], title, order,
    group: String(meta.group ?? '').trim() || 'Guides',
    summary: String(meta.summary ?? '').trim(),
    checked, html, toc, text: plainText(md),
  };
}

/** The guides on disk, read when asked (re-read when a file changes while developing; kept for good in production) */
export class GuideBook {
  private cache: { sig: string; list: Guide[] } | null = null;

  constructor(private dir: string, private keep = false) {}

  async all(): Promise<Guide[]> {
    let names: string[];
    try { names = (await fs.readdir(this.dir)).filter((f) => FILE.test(f)).sort(); } catch { return []; }
    const stats = await Promise.all(names.map(async (f) => `${f}:${(await fs.stat(path.join(this.dir, f))).mtimeMs}`));
    const sig = stats.join('|');
    if (this.cache && (this.keep || this.cache.sig === sig)) return this.cache.list;
    const list: Guide[] = [];
    for (const f of names) {
      const g = parseGuide(f, await fs.readFile(path.join(this.dir, f), 'utf8'));
      if (g) list.push(g);
    }
    list.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
    this.cache = { sig, list };
    return list;
  }

  async get(slug: string): Promise<{ guide: Guide; prev: Guide | null; next: Guide | null } | null> {
    const list = await this.all();
    const i = list.findIndex((g) => g.slug === slug);
    return i < 0 ? null : { guide: list[i], prev: list[i - 1] ?? null, next: list[i + 1] ?? null };
  }
}
