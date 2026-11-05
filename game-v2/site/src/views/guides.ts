/** The guides: the list and one guide */

import { html, raw, SafeHtml } from '../html.js';
import type { Guide } from '../guides.js';
import { empty, fmtDate, layout, type PageCtx } from './layout.js';

/** Group headings in the order they are shown (a guide with another group goes last) */
const GROUPS = ['Basics', 'Ships', 'Economy', 'World'];

function groupsOf(list: Guide[]): { name: string; items: Guide[] }[] {
  const names = [...GROUPS.filter((g) => list.some((x) => x.group === g)), ...[...new Set(list.map((g) => g.group))].filter((g) => !GROUPS.includes(g))];
  return names.map((name) => ({ name, items: list.filter((g) => g.group === name) }));
}

export function guidesIndexPage(ctx: PageCtx, list: Guide[]): SafeHtml {
  const body = html`
<section class="page-head wrap">
  <p class="eyebrow">Guides</p>
  <h1>Guides</h1>
  <p class="lede">How the game works: controls, ships, mining, trading and travel. Each page was checked against the game's code and data, and shows the date.</p>
</section>
<section class="wrap block-tight">
  ${list.length
    ? groupsOf(list).map((g) => html`<div class="guide-group">
      <h2 class="guide-group-h">${g.name}</h2>
      <div class="guide-grid">${g.items.map((x) => html`<a class="guide-card" href="/guides/${x.slug}">
        <span class="guide-n">${String(x.order).padStart(2, '0')}</span>
        <span class="guide-t">${x.title}</span>
        <span class="guide-s">${x.summary}</span>
      </a>`)}</div>
    </div>`)
    : empty('No guides yet', 'Nothing here yet.')}
</section>`;
  return layout(ctx, { title: 'Guides', body, description: 'How the game works: controls, ships, energy, weapons, mining, trading and travel.' });
}

export function guidePage(ctx: PageCtx, d: { guide: Guide; prev: Guide | null; next: Guide | null }): SafeHtml {
  const g = d.guide;
  const body = html`
<article class="post guide">
  <header class="post-head wrap-narrow">
    <p class="meta"><a href="/guides">Guides</a> <span class="sep">/</span> ${g.group}${g.checked ? html` <span class="sep">/</span> Checked ${fmtDate(g.checked)}` : ''}</p>
    <h1>${g.title}</h1>
    ${g.summary ? html`<p class="lede">${g.summary}</p>` : ''}
  </header>
  ${g.toc.length > 2 ? html`<nav class="guide-toc wrap-narrow" aria-label="On this page"><p class="guide-toc-h">On this page</p><ol>${g.toc.map((t) => html`<li><a href="#${t.id}">${t.text}</a></li>`)}</ol></nav>` : ''}
  <div class="prose wrap-narrow">${raw(g.html)}</div>
  <nav class="post-nav wrap-narrow" aria-label="More guides">
    ${d.prev ? html`<a href="/guides/${d.prev.slug}"><small>Previous</small>${d.prev.title}</a>` : html`<span></span>`}
    ${d.next ? html`<a class="next" href="/guides/${d.next.slug}"><small>Next</small>${d.next.title}</a>` : html`<span></span>`}
  </nav>
</article>`;
  return layout(ctx, { title: g.title, body, description: g.summary || undefined, bodyClass: 'post-page' });
}
