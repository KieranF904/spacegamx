/**
 * The images of a post, for the image viewer and the comments on them.
 *
 * An image is known by its `src` as rendered (the sanitised Markdown output), so a comment's `image` is checked
 * against exactly what the page shows. Images inside a link are left alone (the link wins): they are not in the
 * list, get no badge, and can't be commented on.
 */

import { esc } from './html.js';
import { renderMarkdown } from './markdown.js';

export interface PostImage { src: string; alt: string }
/** How many (visible) comments an image has, and the first one (the badge links to it) */
export interface ImageStat { count: number; firstId: number }

const TAGS = /<a\b[^>]*>|<\/a\s*>|<img\b[^>]*>/gi;
const UNESC: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const BUBBLE = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3h12v8H8l-3 3v-3H2z" fill="currentColor"/></svg>';

function attr(tag: string, name: string): string {
  const m = new RegExp(`\\s${name}="([^"]*)"`, 'i').exec(tag);
  return m ? m[1].replace(/&(amp|lt|gt|quot|#39);/g, (e) => UNESC[e] ?? e) : '';
}

/** The count badge on an image (a link to its first comment; the page's script opens the viewer instead) */
function badge(stat: ImageStat): string {
  const label = `${stat.count} ${stat.count === 1 ? 'comment' : 'comments'} on this image`;
  return `<a class="pic-count" href="#c${stat.firstId}" aria-label="${esc(label)}" title="${esc(label)}">${BUBBLE}<span>${stat.count}</span></a>`;
}

/** Wraps each image of rendered post HTML in `.pic` (with a count badge when it has comments) and lists them, once each */
export function decoratePostImages(rendered: string, stats: ReadonlyMap<string, ImageStat> = new Map()): { html: string; images: PostImage[] } {
  const images: PostImage[] = [];
  const seen = new Set<string>();
  let inLink = 0;
  const out = rendered.replace(TAGS, (tag) => {
    if (/^<a\b/i.test(tag)) { inLink++; return tag; }
    if (/^<\/a/i.test(tag)) { inLink = Math.max(0, inLink - 1); return tag; }
    const src = attr(tag, 'src');
    if (inLink || !src) return tag;
    if (!seen.has(src)) { seen.add(src); images.push({ src, alt: attr(tag, 'alt') }); }
    const stat = stats.get(src);
    return `<span class="pic">${tag}${stat?.count ? badge(stat) : ''}</span>`;
  });
  return { html: out, images };
}

/** The images of a post body that can be commented on */
export function postImages(body: string): PostImage[] {
  return decoratePostImages(renderMarkdown(body, 'post')).images;
}
