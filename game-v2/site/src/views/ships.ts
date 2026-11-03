/** The ship gallery: ships pilots have shared, with the game's own plans beside them */

import type { Catalog } from '../catalog/book.js';
import { drawPlan } from '../catalog/draw.js';
import { num } from '../catalog/text.js';
import type { RenderData } from '../catalog/types.js';
import { html, SafeHtml } from '../html.js';
import type { SharedShip } from '../store/types.js';
import { shipCard } from './database.js';
import { layout, sectionHead, when, type PageCtx } from './layout.js';

const gunCount = (s: SharedShip) => s.stats.guns.fixed + s.stats.guns.turret;

export function sharedCard(s: SharedShip, render: RenderData | null): SafeHtml {
  return html`<a class="ship-card" href="/ships/${s.id}">
  <div class="ship-art">${render ? drawPlan(s.plan, render, { label: `${s.name}, plan view` }) : ''}</div>
  <div class="ship-meta"><span class="ship-name">${s.name}</span>
    <span class="dim small">${s.ownerName}, ${s.stats.parts} parts, mass ${num(s.stats.mass, 1)}${gunCount(s) ? `, ${gunCount(s)} guns` : ''}</span></div>
</a>`;
}

export function galleryPage(ctx: PageCtx, d: { catalog: Catalog | null; shared: SharedShip[] }): SafeHtml {
  const body = html`
<section class="page-head wrap">
  <p class="eyebrow">Gallery</p>
  <h1>Ships</h1>
  <p class="lede">Ships pilots have shared, and the plans that come with the game.</p>
</section>
<section class="wrap block-tight">
  ${sectionHead('Pilots', 'Shared by pilots')}
  ${d.shared.length ? html`<div class="ship-grid">${d.shared.map((s) => sharedCard(s, d.catalog?.render ?? null))}</div>` : html`<p class="dim">No shared ships yet.</p>`}
</section>
<section class="wrap block-tight">
  ${sectionHead('Game', 'Plans in the game', html`<a class="link-quiet" href="/database/ships">Database</a>`)}
  ${d.catalog?.ships.length ? html`<div class="ship-grid">${d.catalog.ships.map((s) => shipCard(d.catalog!, s))}</div>` : html`<p class="dim">No plans to show.</p>`}
</section>`;
  return layout(ctx, { title: 'Ships', body, description: 'Ships pilots have shared, and the ship plans in the game.' });
}

export function sharedShipPage(ctx: PageCtx, d: { catalog: Catalog | null; ship: SharedShip }): SafeHtml {
  const s = d.ship, st = s.stats;
  const rows: [string, string][] = [
    ['Parts', String(st.parts)], ['Cells', num(st.cells, 1)], ['Mass', num(st.mass, 1)], ['HP', num(st.hp)],
    ['Guns', `${st.guns.fixed} fixed, ${st.guns.turret} turret`], ['Power made', `${num(st.gen)} E/s`], ['Power used', `${num(st.draw)} E/s`],
    ['Thrust', num(st.thrust, 1)], ...(st.shield ? [['Shield', num(st.shield)] as [string, string]] : []), ...(st.cargo ? [['Hold space', num(st.cargo)] as [string, string]] : []),
    ['Power system', s.power === 'ports' ? 'Ports' : 'Pool and banks'],
  ];
  const body = html`
<article class="wrap db-entry">
  <p class="meta"><a href="/ships">Ships</a> <span class="sep">/</span> ${s.ownerName}</p>
  <header class="db-entry-head"><p class="eyebrow">Shared ship</p><h1>${s.name}</h1>
    <p class="lede">Shared by <a href="/pilots/${encodeURIComponent(s.ownerName)}">${s.ownerName}</a>, ${when(s.updatedAt)}.</p></header>
  <div class="db-cols">
    <section class="panel ship-big">${d.catalog ? drawPlan(s.plan, d.catalog.render, { label: `${s.name}, plan view`, className: 'plan-big' }) : ''}</section>
    <section class="panel"><div class="panel-head"><h2>Totals</h2></div>
      <dl class="facts">${rows.map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>
      ${ctx.user?.isAdmin ? html`<p class="small mt"><a href="/admin/ships">Moderate</a></p>` : ''}
    </section>
  </div>
</article>`;
  return layout(ctx, { title: s.name, body, description: `${s.name}, a ship shared by ${s.ownerName}.` });
}

/** The panel on a pilot's profile */
export function pilotShips(ships: SharedShip[], render: RenderData | null): SafeHtml {
  return html`<section class="panel pilot-ships" aria-labelledby="ps-h">
  <div class="panel-head"><h2 id="ps-h">Shared ships</h2></div>
  ${ships.length ? html`<div class="ship-grid">${ships.map((s) => sharedCard(s, render))}</div>` : html`<p class="dim">No shared ships yet.</p>`}
</section>`;
}

