/** The Database: parts, items, ships, bosses and stations, as charts. Plain facts from the catalog (src/catalog). */

import type { Catalog } from '../catalog/book.js';
import { KIND_LABEL } from '../catalog/book.js';
import { drawPlan } from '../catalog/draw.js';
import {
  counts, distinct, filterBosses, filterItems, filterParts, filterShips, filterStations, PART_CATEGORIES, RARITIES, type Query,
} from '../catalog/query.js';
import {
  bossText, duration, hazardLabel, itemText, label, num, partText, SERVICE_LABEL, shipText, stationName, stationText, systemName,
} from '../catalog/text.js';
import { CATALOG_KINDS, type CatalogBoss, type CatalogItem, type CatalogKind, type CatalogPart, type CatalogShip, type CatalogStation } from '../catalog/types.js';
import { html, raw, SafeHtml } from '../html.js';
import { empty, fmtDate, layout, type PageCtx } from './layout.js';

const href = (kind: CatalogKind, id: string) => `/database/${kind}/${encodeURIComponent(id)}`;
const rarityChip = (r: string) => html`<span class="rarity r-${r}">${r}</span>`;

export function dataLine(c: Catalog): SafeHtml {
  const when = c.source?.date ?? c.builtAt;
  return html`<p class="db-asof dim small">Data as of ${fmtDate(when)}${c.from === 'game' ? ' (from the game)' : ''}.</p>`;
}

function tabs(c: Catalog | null, active: CatalogKind | null): SafeHtml {
  const n = c ? counts(c) : null;
  return html`<nav class="db-tabs" aria-label="Database">
  <a href="/database"${active === null ? raw(' aria-current="page"') : ''}>All</a>
  ${CATALOG_KINDS.map((k) => html`<a href="/database/${k}"${active === k ? raw(' aria-current="page"') : ''}>${KIND_LABEL[k]}${n ? html` <span class="n">${n[k]}</span>` : ''}</a>`)}
</nav>`;
}

function head(c: Catalog | null, kind: CatalogKind | null, title: string, lede: string): SafeHtml {
  return html`<section class="page-head wrap">
  <p class="eyebrow">Database</p>
  <h1>${title}</h1>
  <p class="lede">${lede}</p>
  ${tabs(c, kind)}
</section>`;
}

function noData(ctx: PageCtx, kind: CatalogKind | null): SafeHtml {
  return layout(ctx, {
    title: 'Database',
    body: html`${head(null, kind, 'Database', 'Parts, items, ships, bosses and stations.')}<section class="wrap block-tight">${empty('No data yet', 'The database has not been built.')}</section>`,
  });
}

function searchBox(action: string, q: Query, extra: SafeHtml | string = ''): SafeHtml {
  return html`<form class="db-filters" method="get" action="${action}" role="search">
  <label class="sr-only" for="db-q">Search by name</label>
  <input id="db-q" type="search" name="q" value="${q.q}" placeholder="Search by name" maxlength="60">
  ${extra}
  <button class="btn btn-primary" type="submit">Search</button>
  ${q.q || q.category || q.rarity || q.sort ? html`<a class="btn btn-ghost" href="${action}">Clear</a>` : ''}
</form>`;
}

const select = (name: string, value: string, options: [string, string][], any: string) =>
  html`<label class="sr-only" for="db-${name}">${any}</label><select id="db-${name}" name="${name}"><option value="">${any}</option>${options.map(([v, l]) => html`<option value="${v}"${v === value ? raw(' selected') : ''}>${l}</option>`)}</select>`;

// ---------------------------------------------------------------- landing

export function databaseIndex(ctx: PageCtx, c: Catalog | null, q: Query): SafeHtml {
  if (!c) return noData(ctx, null);
  const found = q.q ? {
    parts: filterParts(c.parts, q), items: filterItems(c.items, q), ships: filterShips(c.ships, q), bosses: filterBosses(c.bosses, q), stations: filterStations(c.stations, q),
  } : null;
  const n = counts(c);
  const body = html`
${head(c, null, 'Database', 'Every part, item, ship plan, boss and station in the game, with its numbers.')}
<section class="wrap block-tight">
  ${searchBox('/database', q)}
  ${found
    ? CATALOG_KINDS.every((k) => !found[k].length)
      ? empty('Nothing found', `No entry matches "${q.q}".`)
      : CATALOG_KINDS.filter((k) => found[k].length).map((k) => html`<div class="db-group">
        <h2 class="guide-group-h">${KIND_LABEL[k]} <span class="n">${found[k].length}</span></h2>
        <ul class="db-hits">${(found[k] as { id: string; name: string }[]).slice(0, 12).map((x) => html`<li><a href="${href(k, x.id)}">${x.name}</a></li>`)}</ul>
        ${found[k].length > 12 ? html`<p class="dim small"><a href="/database/${k}?q=${encodeURIComponent(q.q)}">All ${found[k].length} ${KIND_LABEL[k].toLowerCase()}</a></p>` : ''}
      </div>`)
    : html`<div class="guide-grid">
      ${CATALOG_KINDS.map((k) => html`<a class="guide-card" href="/database/${k}"><span class="guide-n">${n[k]}</span><span class="guide-t">${KIND_LABEL[k]}</span><span class="guide-s">${KIND_BLURB[k]}</span></a>`)}
    </div>`}
  ${dataLine(c)}
</section>`;
  return layout(ctx, { title: 'Database', body, description: 'Every part, item, ship plan, boss and station in the game, with its numbers.' });
}

const KIND_BLURB: Record<CatalogKind, string> = {
  parts: 'Guns, engines, reactors, shields and structure, with HP, mass, power and cost.',
  items: 'Ores, materials, components and loot: value, where it comes from, where it sells.',
  ships: 'The ship plans in the game, drawn, with their totals.',
  bosses: 'Level, rewards, loot and respawn time.',
  stations: 'Services, what each market sells, and what it pays extra for.',
};

// ---------------------------------------------------------------- lists

function keyStat(p: CatalogPart): string {
  if (p.weapon) return p.weapon.dps > 0 ? `${num(p.weapon.dps)} dmg/s, ${num(p.weapon.range)} reach` : `${num(p.weapon.range)} reach`;
  if (p.thrust) return `thrust ${num(p.thrust, 2)}`;
  if (p.supply) return `${num(p.supply, 1)} E/s made`;
  if (p.store) return `holds ${num(p.store)} E`;
  if (p.shield) return `shield ${num(p.shield)}`;
  if (p.cargo) return `${num(p.cargo)} hold space`;
  return '';
}

export function partsList(ctx: PageCtx, c: Catalog | null, q: Query): SafeHtml {
  if (!c) return noData(ctx, 'parts');
  const list = filterParts(c.parts, q);
  const body = html`
${head(c, 'parts', 'Parts', 'Everything a ship is built from. Numbers are for the part at full power in its own material.')}
<section class="wrap block-tight">
  ${searchBox('/database/parts', q, html`${select('category', q.category, PART_CATEGORIES.filter((k) => c.parts.some((p) => p.category === k)).map((k) => [k, label(k)]), 'Any type')}${select('rarity', q.rarity, RARITIES.filter((r) => c.parts.some((p) => p.rarity === r)).map((r) => [r, r]), 'Any rarity')}`)}
  ${list.length ? html`<div class="table-scroll"><table class="db-table">
    <thead><tr><th>Name</th><th>Type</th><th>Mark</th><th class="num">Cells</th><th class="num">HP</th><th class="num">Mass</th><th>Main number</th><th class="num">Opens</th></tr></thead>
    <tbody>${list.map((p) => html`<tr>
      <td><a href="${href('parts', p.id)}">${p.name}</a>${p.family && p.category !== 'structure' ? html` <small class="dim">${p.family.replace(/_/g, ' ')}</small>` : ''}</td>
      <td class="nw">${label(p.category)}</td><td class="nw">${p.mark}</td><td class="num">${p.cells}</td><td class="num">${num(p.hp)}</td><td class="num">${num(p.mass, 1)}</td>
      <td>${keyStat(p)}</td><td class="num">${p.unlock ? `Lv ${p.unlock}` : 'Start'}</td></tr>`)}</tbody></table></div>`
    : empty('Nothing found', 'No part matches.')}
  <p class="dim small">${list.length} of ${c.parts.length} parts.</p>
  ${dataLine(c)}
</section>`;
  return layout(ctx, { title: 'Parts', body, description: 'Every ship part in the game: HP, mass, power, damage and cost.' });
}

export function itemsList(ctx: PageCtx, c: Catalog | null, q: Query): SafeHtml {
  if (!c) return noData(ctx, 'items');
  const list = filterItems(c.items, q);
  const cats = distinct(c.items, (i) => i.category);
  const body = html`
${head(c, 'items', 'Items', 'Ores, materials, components, ammunition and loot. Value is the base price in credits.')}
<section class="wrap block-tight">
  ${searchBox('/database/items', q, html`${select('category', q.category, cats.map((k) => [k, label(k)]), 'Any type')}${select('rarity', q.rarity, RARITIES.filter((r) => c.items.some((i) => i.rarity === r)).map((r) => [r, r]), 'Any rarity')}${select('sort', q.sort, [['name', 'Name'], ['value', 'Value, high first']], 'Default order')}`)}
  ${list.length ? html`<div class="table-scroll"><table class="db-table">
    <thead><tr><th>Name</th><th>Type</th><th>Rarity</th><th class="num">Value</th><th class="num">Tier</th></tr></thead>
    <tbody>${list.map((i) => html`<tr><td><a href="${href('items', i.id)}">${i.name}</a></td><td>${label(i.category)}</td><td>${rarityChip(i.rarity)}</td><td class="num">${num(i.value)} cr</td><td class="num">${i.tier ?? ''}</td></tr>`)}</tbody></table></div>`
    : empty('Nothing found', 'No item matches.')}
  <p class="dim small">${list.length} of ${c.items.length} items.</p>
  ${dataLine(c)}
</section>`;
  return layout(ctx, { title: 'Items', body, description: 'Every ore, material, component and loot item in the game.' });
}

export function shipCard(c: Catalog, s: CatalogShip, to = href('ships', s.id)): SafeHtml {
  return html`<a class="ship-card" href="${to}">
  <div class="ship-art">${drawPlan(s.plan, c.render, { label: `${s.name}, plan view` })}</div>
  <div class="ship-meta"><span class="ship-name">${s.name}</span>
    <span class="dim small">${s.stats.parts} parts, mass ${num(s.stats.mass, 1)}${s.stats.guns.fixed + s.stats.guns.turret ? `, ${s.stats.guns.fixed + s.stats.guns.turret} guns` : ''}</span></div>
</a>`;
}

export function shipsList(ctx: PageCtx, c: Catalog | null, q: Query): SafeHtml {
  if (!c) return noData(ctx, 'ships');
  const list = filterShips(c.ships, q);
  const body = html`
${head(c, 'ships', 'Ships', 'The ship plans in the game, from the starter up. Drawn from above, nose up.')}
<section class="wrap block-tight">
  ${searchBox('/database/ships', q)}
  ${list.length ? html`<div class="ship-grid">${list.map((s) => shipCard(c, s))}</div>` : empty('Nothing found', 'No ship matches.')}
  <p class="dim small">Ships other pilots have shared are in the <a href="/ships">gallery</a>.</p>
  ${dataLine(c)}
</section>`;
  return layout(ctx, { title: 'Ships', body, description: 'The ship plans in the game, drawn, with parts, mass and power totals.' });
}

export function bossesList(ctx: PageCtx, c: Catalog | null, q: Query): SafeHtml {
  if (!c) return noData(ctx, 'bosses');
  const list = filterBosses(c.bosses, q).slice().sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
  const body = html`
${head(c, 'bosses', 'Bosses', 'Level, rewards and respawn time. See the Bosses guide for how the fights work.')}
<section class="wrap block-tight">
  ${searchBox('/database/bosses', q)}
  ${list.length ? html`<div class="table-scroll"><table class="db-table">
    <thead><tr><th>Name</th><th>System</th><th class="num">Level</th><th class="num">Phases</th><th class="num">XP</th><th class="num">Credits</th><th class="num">Respawn</th></tr></thead>
    <tbody>${list.map((b) => html`<tr><td><a href="${href('bosses', b.id)}">${b.name}</a></td><td>${systemName(c, b.system)}</td><td class="num">${b.level}</td><td class="num">${b.phases}</td><td class="num">${num(b.xp)}</td><td class="num">${num(b.credits)}</td><td class="num">${b.respawnSeconds ? duration(b.respawnSeconds) : ''}</td></tr>`)}</tbody></table></div>`
    : empty('Nothing found', 'No boss matches.')}
  ${dataLine(c)}
</section>`;
  return layout(ctx, { title: 'Bosses', body, description: 'Every boss: level, rewards, loot and respawn time.' });
}

export function stationsList(ctx: PageCtx, c: Catalog | null, q: Query): SafeHtml {
  if (!c) return noData(ctx, 'stations');
  const list = filterStations(c.stations, q);
  const body = html`
${head(c, 'stations', 'Stations', 'Where to dock, repair, refine, fabricate and trade.')}
<section class="wrap block-tight">
  ${searchBox('/database/stations', q)}
  ${list.length ? html`<div class="table-scroll"><table class="db-table">
    <thead><tr><th>Name</th><th>System</th><th>Services</th><th class="num">Repair per HP</th></tr></thead>
    <tbody>${list.map((s) => html`<tr><td><a href="${href('stations', s.id)}">${s.name}</a></td><td>${systemName(c, s.system)}</td><td>${s.services.map((x) => SERVICE_LABEL[x] ?? label(x)).join(', ')}</td><td class="num">${s.repairCostPerHp ? `${s.repairCostPerHp} cr` : ''}</td></tr>`)}</tbody></table></div>`
    : empty('Nothing found', 'No station matches.')}
  ${dataLine(c)}
</section>`;
  return layout(ctx, { title: 'Stations', body, description: 'Every station: services, markets and prices.' });
}

// ---------------------------------------------------------------- one entry

function facts(rows: [string, string | number | SafeHtml | null | undefined | false][]): SafeHtml {
  return html`<dl class="facts">${rows.filter(([, v]) => v !== null && v !== undefined && v !== false && v !== '').map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>`;
}

function entry(ctx: PageCtx, c: Catalog, kind: CatalogKind, title: string, eyebrow: string, lead: string, inner: SafeHtml): SafeHtml {
  const body = html`
<article class="wrap db-entry">
  <p class="meta"><a href="/database">Database</a> <span class="sep">/</span> <a href="/database/${kind}">${KIND_LABEL[kind]}</a></p>
  <header class="db-entry-head"><p class="eyebrow">${eyebrow}</p><h1>${title}</h1><p class="lede">${lead}</p></header>
  ${inner}
  ${dataLine(c)}
</article>`;
  return layout(ctx, { title, body, description: lead.slice(0, 200) });
}

const itemLink = (c: Catalog, id: string) => c.item.has(id) ? html`<a href="${href('items', id)}">${c.item.get(id)!.name}</a>` : id;
const stationLink = (c: Catalog, id: string) => c.station.has(id) ? html`<a href="${href('stations', id)}">${stationName(c, id)}</a>` : id;
const bossLink = (c: Catalog, id: string) => c.boss.has(id) ? html`<a href="${href('bosses', id)}">${c.boss.get(id)!.name}</a>` : id;
const join = (items: (string | SafeHtml)[]): SafeHtml => html`${items.map((x, i) => html`${i ? ', ' : ''}${x}`)}`;

function costLinks(c: Catalog, inputs: Record<string, number>): SafeHtml {
  return join(Object.entries(inputs).map(([id, n]) => html`${n} ${itemLink(c, id)}`));
}

export function partPage(ctx: PageCtx, c: Catalog, p: CatalogPart): SafeHtml {
  const usedBy = c.ships.filter((s) => s.plan.some((x) => x.fn === p.id));
  const inner = html`
<div class="db-cols">
  <section class="panel">
    <div class="panel-head"><h2>Numbers</h2></div>
    ${facts([
      ['Type', label(p.category)], ['Family', p.family?.replace(/_/g, ' ')], ['Mark', `${p.mark} ${p.material}`], ['Size', p.size], ['Rarity', rarityChip(p.rarity)],
      ['Cells', p.cells], ['HP', num(p.hp)], ['Mass', num(p.mass, 1)],
      ['Mount', p.weapon?.mount === 'turret' ? 'Turret' : p.weapon ? 'Fixed' : ''],
      ['Damage a second', p.weapon && p.weapon.dps > 0 ? num(p.weapon.dps) : ''], ['Reach', p.weapon ? `${num(p.weapon.range)} units` : ''],
      ['Damage type', p.weapon?.damageType ? label(p.weapon.damageType) : ''],
      ['Thrust', p.thrust ? num(p.thrust, 2) : ''], ['Boost', p.boost ? `x${num(p.boost, 2)}` : ''],
      ['Makes', p.supply ? `${num(p.supply, 1)} E/s` : ''], ['Holds', p.store ? `${num(p.store)} E` : ''], ['Shield', p.shield ? num(p.shield) : ''], ['Hold space', p.cargo ? num(p.cargo) : ''],
      ['Uses', p.draw ? `${num(p.draw, 1)} E/s` : ''],
      ['Opens at', p.unlock ? `Level ${p.unlock}` : 'Start'],
    ])}
  </section>
  <section class="panel">
    <div class="panel-head"><h2>Shapes</h2></div>
    <div class="shape-row">${p.shapes.slice(0, 12).map((id) => html`<figure class="shape">${drawPlan([{ fn: p.id, piece: id, x: 0, y: 0, rot: 0 }], c.render, { label: `${id} shape` })}<figcaption>${id}</figcaption></figure>`)}</div>
    ${p.craft ? html`<p class="mt">Fabricated from ${costLinks(c, p.craft.inputs)} (${duration(p.craft.seconds)}).</p>` : html`<p class="mt dim">Not fabricated: it is paid for in materials when placed.</p>`}
  </section>
</div>
${p.ports?.length ? html`<section class="panel mt"><div class="panel-head"><h2>Ports</h2></div>
  <div class="table-scroll"><table class="db-table"><thead><tr><th>Direction</th><th>Side</th><th class="num">Cell</th><th class="num">Rate</th></tr></thead>
  <tbody>${p.ports.map((x) => html`<tr><td>${x.dir === 'in' ? 'In' : 'Out'}</td><td>${x.side}</td><td class="num">${(x.cell ?? 0) + 1}</td><td class="num">${num(x.rate)} E/s</td></tr>`)}</tbody></table></div></section>` : ''}
${usedBy.length ? html`<section class="panel mt"><div class="panel-head"><h2>Used in</h2></div><p>${join(usedBy.map((s) => html`<a href="${href('ships', s.id)}">${s.name}</a>`))}</p></section>` : ''}`;
  return entry(ctx, c, 'parts', p.name, `${label(p.category)}${p.family && p.category !== 'structure' ? `, ${p.family.replace(/_/g, ' ')}` : ''}`, partText(c, p), inner);
}

export function itemPage(ctx: PageCtx, c: Catalog, i: CatalogItem): SafeHtml {
  const MORE = 16;
  const inner = html`
<div class="db-cols">
  <section class="panel">
    <div class="panel-head"><h2>Numbers</h2></div>
    ${facts([['Type', label(i.category)], ['Rarity', rarityChip(i.rarity)], ['Base value', `${num(i.value)} cr`], ['Tier', i.tier], ['Mass per unit', i.mass]])}
  </section>
  <section class="panel">
    <div class="panel-head"><h2>Where it comes from</h2></div>
    ${i.foundIn.length ? html`<p class="small dim">Share of the rock's ore mix.</p><ul class="plain">${i.foundIn.map((f) => html`<li>${f.name} <span class="dim">${f.share}%</span></li>`)}</ul>` : ''}
    ${i.madeBy.map((r) => html`<p>${r.kind === 'refine' ? 'Refined' : 'Fabricated'} from ${costLinks(c, r.inputs)}${r.out > 1 ? ` (makes ${r.out})` : ''}, ${duration(r.seconds)}${r.level ? `, from level ${r.level}` : ''}.</p>`)}
    ${i.droppedBy.length ? html`<p>Dropped by ${join(i.droppedBy.map((d) => html`${bossLink(c, d.boss)} <span class="dim">${Math.round(d.chance * 100)}%</span>`))}.</p>` : ''}
    ${!i.foundIn.length && !i.madeBy.length && !i.droppedBy.length ? html`<p class="dim">No source listed.</p>` : ''}
  </section>
</div>
<div class="db-cols mt">
  <section class="panel">
    <div class="panel-head"><h2>Where to sell and buy</h2></div>
    ${i.soldAt.length ? html`<p>Sold at ${join(i.soldAt.map((s) => stationLink(c, s)))}.</p>` : html`<p class="dim">No station sells it.</p>`}
    ${i.paidMoreAt.length ? html`<p>Stations paying extra: ${join(i.paidMoreAt.map((p) => html`${stationLink(c, p.station)} <span class="dim">x${p.mult}</span>`))}.</p>` : ''}
  </section>
  <section class="panel">
    <div class="panel-head"><h2>Used in</h2></div>
    ${i.usedIn.length ? html`<ul class="plain cols">${i.usedIn.slice(0, MORE).map((u) => html`<li><a href="${href(u.kind === 'part' ? 'parts' : 'items', u.id)}">${u.name}</a></li>`)}</ul>${i.usedIn.length > MORE ? html`<p class="dim small">and ${i.usedIn.length - MORE} more.</p>` : ''}` : html`<p class="dim">Not used in any recipe.</p>`}
  </section>
</div>`;
  return entry(ctx, c, 'items', i.name, label(i.category), itemText(c, i), inner);
}

export function shipPage(ctx: PageCtx, c: Catalog, s: CatalogShip): SafeHtml {
  const byFn = new Map<string, number>();
  for (const p of s.plan) byFn.set(p.fn, (byFn.get(p.fn) ?? 0) + 1);
  const st = s.stats;
  const inner = html`
<div class="db-cols">
  <section class="panel ship-big">${drawPlan(s.plan, c.render, { label: `${s.name}, plan view`, className: 'plan-big' })}</section>
  <section class="panel">
    <div class="panel-head"><h2>Totals</h2></div>
    ${facts([
      ['Parts', st.parts], ['Cells', num(st.cells, 1)], ['Mass', num(st.mass, 1)], ['HP', num(st.hp)],
      ['Guns', `${st.guns.fixed} fixed, ${st.guns.turret} turret`], ['Power made', `${num(st.gen)} E/s`], ['Power used', `${num(st.draw)} E/s`],
      ['Thrust', num(st.thrust, 1)], ['Shield', st.shield ? num(st.shield) : ''], ['Hold space', st.cargo ? num(st.cargo) : ''],
      ['Power system', s.power === 'ports' ? 'Ports' : 'Pool and banks'],
    ])}
    <p class="small dim mt">Sold at: ${s.soldAt.length ? join(s.soldAt.map((x) => stationLink(c, x))) : 'not sold at a station'}.</p>
  </section>
</div>
<section class="panel mt"><div class="panel-head"><h2>Parts</h2></div>
  <ul class="plain cols">${[...byFn].sort((a, b) => b[1] - a[1]).map(([fn, n]) => html`<li>${n} x ${c.part.has(fn) ? html`<a href="${href('parts', fn)}">${c.part.get(fn)!.name}</a>` : fn.replace(/_/g, ' ')}</li>`)}</ul></section>`;
  return entry(ctx, c, 'ships', s.name, 'Ship plan', shipText(c, s), inner);
}

export function bossPage(ctx: PageCtx, c: Catalog, b: CatalogBoss): SafeHtml {
  const inner = html`
<div class="db-cols">
  <section class="panel"><div class="panel-head"><h2>Numbers</h2></div>
    ${facts([['Level', b.level], ['System', systemName(c, b.system)], ['Phases', b.phases], ['XP', num(b.xp)], ['Credits', `${num(b.credits)} cr`], ['Respawn', b.respawnSeconds ? duration(b.respawnSeconds) : '']])}</section>
  <section class="panel"><div class="panel-head"><h2>Loot</h2></div>
    ${b.loot.length ? html`<div class="table-scroll"><table class="db-table"><thead><tr><th>Item</th><th class="num">Amount</th><th class="num">Chance</th></tr></thead>
    <tbody>${b.loot.map((l) => html`<tr><td>${itemLink(c, l.item)}</td><td class="num">${l.min === l.max ? l.min : `${l.min}-${l.max}`}</td><td class="num">${Math.round(l.chance * 100)}%</td></tr>`)}</tbody></table></div>` : html`<p class="dim">No loot listed.</p>`}</section>
</div>`;
  return entry(ctx, c, 'bosses', b.name, 'Boss', bossText(c, b), inner);
}

export function stationPage(ctx: PageCtx, c: Catalog, s: CatalogStation): SafeHtml {
  const sys = c.system.get(s.system);
  const inner = html`
<div class="db-cols">
  <section class="panel"><div class="panel-head"><h2>Station</h2></div>
    ${facts([
      ['System', sys ? systemName(c, s.system) : s.system], ['Danger level', sys?.danger], ['Hazards', sys?.hazards.length ? sys.hazards.map(hazardLabel).join(', ') : ''],
      ['Services', s.services.map((x) => SERVICE_LABEL[x] ?? label(x)).join(', ')],
      ['Repair', s.repairCostPerHp ? `${s.repairCostPerHp} cr per HP` : ''], ['Refuel', s.refuelCostPerUnit ? `${s.refuelCostPerUnit} cr per unit` : ''],
    ])}</section>
  <section class="panel"><div class="panel-head"><h2>Pays extra for</h2></div>
    ${s.pays.length ? html`<ul class="plain">${s.pays.map((p) => html`<li>${itemLink(c, p.item)} <span class="dim">x${p.mult}</span></li>`)}</ul>` : html`<p class="dim">Standard prices.</p>`}</section>
</div>
<section class="panel mt"><div class="panel-head"><h2>Sells</h2></div>
  ${s.sells.items.length || s.sells.plans.length || s.sells.parts.length
    ? html`<ul class="plain cols">${s.sells.items.map((id) => html`<li>${itemLink(c, id)}</li>`)}${s.sells.parts.map((p) => html`<li>${c.part.has(p.part) ? html`<a href="${href('parts', p.part)}">${p.label}</a>` : p.label}</li>`)}${s.sells.plans.map((id) => html`<li>${c.ship.has(id) ? html`<a href="${href('ships', id)}">${c.ship.get(id)!.name} plan</a>` : `${id} plan`}</li>`)}</ul>`
    : html`<p class="dim">Nothing for sale.</p>`}</section>`;
  return entry(ctx, c, 'stations', s.name, 'Station', stationText(c, s), inner);
}

export function entryNotFound(ctx: PageCtx, kind: CatalogKind): SafeHtml {
  return layout(ctx, { title: 'Not found', body: html`<section class="page-head wrap"><p class="eyebrow">Database</p><h1>Not found</h1><p class="lede">There is no such entry. <a href="/database/${kind}">Back to ${KIND_LABEL[kind].toLowerCase()}</a>.</p></section>` });
}

