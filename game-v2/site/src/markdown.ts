/**
 * Markdown to HTML, sanitised every time (admin posts too: defence in depth).
 *
 * Raw HTML in the source is never passed through: marked's html tokens are
 * escaped to text, and the result then goes through an allowlist (sanitize-html)
 * that keeps only plain formatting, safe links (http, https, mailto, site paths)
 * and, in posts, images. Comments and suggestions get a smaller set: no images,
 * no headings, and every link is rel="nofollow ugc".
 */

import { Marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { esc } from './html.js';

export type MarkdownMode = 'post' | 'comment';

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    // Raw HTML in the source shows as text
    html(token: unknown) {
      const text = typeof token === 'string' ? token : (token as { text?: string }).text ?? '';
      return esc(text);
    },
  },
});

const POST_TAGS = ['p', 'br', 'hr', 'h2', 'h3', 'h4', 'strong', 'em', 'del', 'code', 'pre', 'blockquote',
  'ul', 'ol', 'li', 'a', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td'];
const COMMENT_TAGS = ['p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'a'];

/** A URL a link or image may have: http(s), mailto (links only), or a path on this site */
export function safeUrl(url: string, kind: 'link' | 'image'): boolean {
  const u = url.trim();
  if (/^\/(?![/\\])/.test(u)) return true;
  if (kind === 'link' && u.startsWith('#')) return true;
  if (/^https?:\/\//i.test(u)) return true;
  if (kind === 'link' && /^mailto:/i.test(u)) return true;
  return false;
}

function options(mode: MarkdownMode): sanitizeHtml.IOptions {
  return {
    allowedTags: mode === 'post' ? POST_TAGS : COMMENT_TAGS,
    allowedAttributes: {
      a: ['href', 'title', 'rel', 'target'],
      img: ['src', 'alt', 'title', 'loading', 'decoding'],
      code: ['class'],
      th: ['align'], td: ['align'],
    },
    allowedClasses: { code: [/^language-[\w-]+$/] },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['http', 'https'] },
    allowProtocolRelative: false,
    disallowedTagsMode: 'escape',
    transformTags: {
      ...(mode === 'comment' ? { h1: 'p', h2: 'p', h3: 'p', h4: 'p', h5: 'p', h6: 'p' } : { h1: 'h2', h5: 'h4', h6: 'h4' }),
      a: (_tag, attribs) => {
        const href = attribs.href ?? '';
        const external = /^https?:\/\//i.test(href);
        const out: Record<string, string> = { href: safeUrl(href, 'link') ? href : '#' };
        if (attribs.title) out.title = attribs.title;
        if (mode === 'comment') out.rel = 'nofollow ugc noopener noreferrer';
        else if (external) out.rel = 'noopener noreferrer';
        if (external) out.target = '_blank';
        return { tagName: 'a', attribs: out };
      },
      img: (_tag, attribs) => {
        const src = attribs.src ?? '';
        if (!safeUrl(src, 'image')) return { tagName: 'span', attribs: {}, text: attribs.alt ?? '' };
        return { tagName: 'img', attribs: { src, alt: attribs.alt ?? '', ...(attribs.title ? { title: attribs.title } : {}), loading: 'lazy', decoding: 'async' } };
      },
    },
  };
}

export function renderMarkdown(source: string, mode: MarkdownMode = 'post'): string {
  const dirty = marked.parse(source ?? '', { async: false }) as string;
  return sanitizeHtml(dirty, options(mode));
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#x27;': "'", '&nbsp;': ' ' };

/** Plain text from Markdown (excerpts, RSS descriptions, meta tags) */
export function plainText(source: string, max = 0): string {
  const htmlOut = renderMarkdown(source, 'post').replace(/<\/(p|li|h\d|pre|blockquote)>/g, ' ');
  const text = sanitizeHtml(htmlOut, { allowedTags: [], allowedAttributes: {} })
    .replace(/&(amp|lt|gt|quot|#39|#x27|nbsp);/g, (e) => ENTITIES[e] ?? e)
    .replace(/\s+/g, ' ').trim();
  if (!max || text.length <= max) return text;
  const cut = text.slice(0, max);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 20)).replace(/[,.;:\s]+$/, '') + '…';
}

/** The first paragraph of a post as plain text (a summary when none is given) */
export function firstParagraph(source: string, max = 220): string {
  const para = (source ?? '').split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !/^(#|!\[|```|\||>|-{3,})/.test(p));
  return plainText(para ?? '', max);
}

/** The first image in a post's Markdown (a cover when none is set) */
export function firstImage(source: string): string | null {
  const m = /!\[[^\]]*\]\(\s*([^)\s]+)/.exec(source ?? '');
  return m && safeUrl(m[1], 'image') ? m[1] : null;
}
