/**
 * The launcher's development news: posts flagged "launcher" as plain-text items (no images, no markup).
 *
 *   in:  Post[] (any order, any status); { origin, limit }
 *   out: LauncherNewsItem[], newest first, published and flagged only, at most `limit` (default 10, never more than 20)
 *   body format: paragraphs separated by a blank line; a paragraph whose every line starts "- " is a bullet list.
 *
 * Pure (no I/O). Served by routes/launcherNews.ts; read by client/src/ui/join/newsFeed.ts.
 */

import { Marked, type Token, type Tokens } from 'marked';
import type { Post } from './store/types.js';

export interface LauncherNewsItem {
  slug: string;
  title: string;
  /** ISO time it first went out */
  date: string;
  /** Plain text: see the format above */
  body: string;
  /** The post's page on the website */
  url: string;
}

const marked = new Marked({ gfm: true });
const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const tidy = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Inline tokens (bold, links, code...) as their visible text; images are dropped */
function inlineText(tokens: Token[] | undefined, fallback: string): string {
  if (!tokens) return decode(fallback);
  return tokens.map((t) => {
    if (t.type === 'image') return '';
    if (t.type === 'br') return ' ';
    if ('tokens' in t && t.tokens) return inlineText(t.tokens, '');
    return decode('text' in t ? String(t.text) : '');
  }).join('');
}

/** A post's Markdown as the launcher's plain text: headings and paragraphs become paragraphs, lists become "- " lines */
export function plainBody(markdown: string): string {
  const blocks: string[] = [];
  for (const t of marked.lexer(markdown)) {
    if (t.type === 'paragraph' || t.type === 'heading') {
      const text = tidy(inlineText((t as Tokens.Paragraph).tokens, (t as Tokens.Paragraph).text));
      if (text) blocks.push(text);
    } else if (t.type === 'list') {
      const lines = (t as Tokens.List).items
        .map((i) => tidy(inlineText(i.tokens.flatMap((x) => ('tokens' in x && x.tokens ? x.tokens : [])), i.text)))
        .filter(Boolean);
      if (lines.length) blocks.push(lines.map((l) => `- ${l}`).join('\n'));
    } else if (t.type === 'blockquote') {
      const text = tidy(inlineText((t as Tokens.Blockquote).tokens?.flatMap((x) => ('tokens' in x && x.tokens ? x.tokens : [])), (t as Tokens.Blockquote).text));
      if (text) blocks.push(text);
    }
  }
  return blocks.join('\n\n');
}

export function launcherNewsItems(posts: Post[], o: { origin: string; limit?: number }): LauncherNewsItem[] {
  const limit = Math.max(1, Math.min(20, o.limit ?? 10));
  return posts
    .filter((p) => p.launcher && p.status === 'published' && p.publishedAt)
    .sort((a, b) => b.publishedAt!.localeCompare(a.publishedAt!))
    .slice(0, limit)
    .map((p) => ({ slug: p.slug, title: p.title, date: p.publishedAt!, body: plainBody(p.body), url: `${o.origin}/updates/${encodeURIComponent(p.slug)}` }));
}
