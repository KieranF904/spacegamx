/** The updates as an RSS 2.0 feed (/rss.xml) */

import { esc } from './html.js';
import { firstParagraph, renderMarkdown } from './markdown.js';
import type { Post } from './store/types.js';

/** Absolute URLs for site paths inside a post (feed readers need them) */
function absolutise(htmlText: string, origin: string): string {
  return htmlText.replace(/(src|href)="\/(?!\/)/g, `$1="${origin}/`);
}

export function rssFeed(posts: Post[], opts: { origin: string; siteName: string }): string {
  const items = posts.map((p) => {
    const url = `${opts.origin}/updates/${encodeURIComponent(p.slug)}`;
    const date = new Date(p.publishedAt ?? p.updatedAt).toUTCString();
    const body = absolutise(renderMarkdown(p.body, 'post'), opts.origin);
    return `    <item>
      <title>${esc(p.title)}</title>
      <link>${esc(url)}</link>
      <guid isPermaLink="true">${esc(url)}</guid>
      <pubDate>${date}</pubDate>
${p.tags.map((t) => `      <category>${esc(t)}</category>`).join('\n')}
      <description>${esc(p.summary || firstParagraph(p.body, 300))}</description>
      <content:encoded><![CDATA[${body.replace(/\]\]>/g, ']]]]><![CDATA[>')}]]></content:encoded>
    </item>`;
  }).join('\n');
  const latest = posts[0] ? new Date(posts[0].publishedAt ?? posts[0].updatedAt).toUTCString() : new Date().toUTCString();
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${esc(opts.siteName)}: updates</title>
    <link>${esc(opts.origin)}/updates</link>
    <atom:link href="${esc(opts.origin)}/rss.xml" rel="self" type="application/rss+xml"/>
    <description>Patch notes and news from ${esc(opts.siteName)}</description>
    <language>en</language>
    <lastBuildDate>${latest}</lastBuildDate>
${items}
  </channel>
</rss>
`;
}
