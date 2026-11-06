/**
 * The Database's Parts tab, laid out like the game's component guide (client/src/ui/ComponentGuideUI.ts): a tab per
 * category, rows sorted by the level they open at, each row its level, its picture (the game's own drawing:
 * scripts/build-part-images.mjs), its name, what gates it and what making it takes. A row opens (no script needed)
 * to its numbers, mounting and where its rare parts drop. Each row is linkable: /database/parts#<id>.
 *
 * The game's guide is for one pilot (red where you're short); this one is for anyone, so a gate reads plainly.
 */

import type { Catalog } from '../catalog/book.js';
import { filterParts, type Query } from '../catalog/query.js';
import { duration, label, num } from '../catalog/text.js';
import type { Art, CatalogPart, CatalogStructure, GuideTab } from '../catalog/types.js';
import { html, raw, SafeHtml } from '../html.js';

/** The game's tabs (componentGuide.ts COMP_TABS), the core going with structure */
export const GUIDE_TABS: { id: GuideTab; label: string }[] = [
  { id: 'structure', label: 'Structure' },
  { id: 'weapons', label: 'Weapons' },
  { id: 'engines', label: 'Engines & jump' },
  { id: 'power', label: 'Power' },
  { id: 'shields', label: 'Shields & plating' },
  { id: 'utility', label: 'Utility' },
];
const isTab = (v: string): v is GuideTab => GUIDE_TABS.some((t) => t.id === v);

const LOCK = raw('<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4 7V5a4 4 0 1 1 8 0v2h.5A1.5 1.5 0 0 1 14 8.5v5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 13.5v-5A1.5 1.5 0 0 1 3.5 7H4Zm2 0h4V5a2 2 0 1 0-4 0v2Z"/></svg>');
const CHECK = raw('<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8.5 6.5 12 13 4.5"/></svg>');
const CHEVRON = raw('<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 6 8 10.5 12.5 6"/></svg>');

/** One row of the list: a part, or a structure material */
interface Row {
  id: string;
  tab: GuideTab;
  name: string;
  level: number | null;
  order: number;
  part?: CatalogPart;
  structure?: CatalogStructure;
}

/** The guide's tab for a part (from the game's guide, else its category) */
function tabOf(p: CatalogPart): GuideTab {
  if (p.guide) return p.guide.tab;
  return p.category === 'core' ? 'structure' : p.category;
}

/** By level (none last), then order, then name: the game's sort (componentGuide.ts sortRows) */
function sortRows(rows: Row[]): Row[] {
  const lv = (r: Row) => r.level ?? Infinity;
  return rows.sort((a, b) => lv(a) - lv(b) || a.order - b.order || a.name.localeCompare(b.name));
}

/** Every row the query lets through, by tab */
export function guideRows(c: Catalog, q: Query): Map<GuideTab, Row[]> {
  const out = new Map<GuideTab, Row[]>(GUIDE_TABS.map((t) => [t.id, []]));
  const hasStructure = !!c.structure?.length;
  for (const p of filterParts(c.parts, { ...q, category: '' })) {
    // (With structure rows, hull, armour and cargo are in them: one row a material, as in the game)
    if (hasStructure && p.category === 'structure') continue;
    out.get(tabOf(p))!.push({ id: p.id, tab: tabOf(p), name: p.name, level: p.guide ? p.guide.level : p.unlock ?? 0, order: p.guide?.order ?? 0, part: p });
  }
  if (!q.rarity) {
    const needle = q.q.toLowerCase();
    for (const s of c.structure ?? []) {
      if (needle && !s.name.toLowerCase().includes(needle)) continue;
      out.get('structure')!.push({ id: `structure-${s.id}`, tab: 'structure', name: s.name, level: s.level, order: s.order, structure: s });
    }
  }
  for (const rows of out.values()) sortRows(rows);
  return out;
}

// ---------------------------------------------------------------- pieces

const itemHref = (id: string) => `/database/items/${encodeURIComponent(id)}`;
const partHref = (id: string) => `/database/parts/${encodeURIComponent(id)}`;

function picture(art: Art | undefined, alt: string, scale = 0.8): SafeHtml {
  if (!art) return html`<span class="cg-nopic" aria-hidden="true"></span>`;
  return html`<img src="${art.src}" width="${Math.round(art.w * scale)}" height="${Math.round(art.h * scale)}" alt="${alt}" loading="lazy" decoding="async">`;
}

/** A cost as the game's chips: the item's icon and the count (the name on hover, and in full where there's room) */
export function costChips(c: Catalog, cost: Record<string, number>, full = false): SafeHtml {
  return html`${Object.entries(cost).map(([id, n]) => {
    const it = c.item.get(id);
    const name = it?.name ?? id.replace(/_/g, ' ');
    const icon = it?.icon ? html`<img src="${it.icon}" width="16" height="16" alt="">` : '';
    return full
      ? html`<a class="cg-mat" href="${itemHref(id)}">${icon}<span>${n} ${name}</span></a>`
      : html`<span class="cg-mat" title="${name}">${icon}x ${n}</span>`;
  })}`;
}

interface Gate { text: string; kind: 'start' | 'level' | 'licence' | 'part' | 'none'; drops?: SafeHtml }

/** What it takes to build: its level (nothing opens early), a licence, rare parts a boss drops */
function gates(c: Catalog, r: Row): Gate[] {
  const out: Gate[] = [];
  const licence = r.part?.guide?.licence ?? r.structure?.licence ?? false;
  if (r.level === null) out.push({ kind: 'none', text: 'No pilot can make this' });
  else if (r.level > 0) out.push({ kind: 'level', text: `Opens at level ${r.level}` });
  else if (!licence) out.push({ kind: 'start', text: 'Starter: every pilot can build it' });
  if (licence) out.push({ kind: 'licence', text: 'Needs a licence from a job' });
  const cost = r.part ? r.part.guide?.cost ?? r.part.craft?.inputs ?? {} : {};
  for (const [id, n] of Object.entries(cost)) {
    const it = c.item.get(id);
    if (!it || !it.droppedBy.length || (it.rarity !== 'legendary' && it.category !== 'artefact')) continue;
    const bosses = [...new Set(it.droppedBy.map((d) => c.boss.get(d.boss)?.name ?? d.boss))];
    out.push({
      kind: 'part', text: `Needs ${it.name}${n > 1 ? ` x${n}` : ''}: dropped by ${bosses.join(' or ')}`,
      drops: html`<a href="${itemHref(id)}">${it.name}</a>: ${it.droppedBy.map((d, i) => html`${i ? '; ' : ''}dropped by <a href="/database/bosses/${encodeURIComponent(d.boss)}">${c.boss.get(d.boss)?.name ?? d.boss}</a>${d.chance < 1 ? `, ${Math.round(d.chance * 100)}% a kill` : ''}`)}`,
    });
  }
  return out;
}

function reqLine(g: Gate[]): SafeHtml {
  const open = g.length === 1 && g[0].kind === 'start';
  return html`<div class="cg-req${open ? ' met' : g.some((x) => x.kind === 'part' || x.kind === 'licence') ? ' rare' : ''}">${open ? CHECK : LOCK}<span>${g.map((x) => x.text).join(' · ')}</span></div>`;
}

const kv = (k: string, v: string | number | SafeHtml | null | undefined | false) =>
  v === null || v === undefined || v === false || v === '' ? '' : html`<div class="cg-kv"><span>${k}</span><b>${v}</b></div>`;

// ---------------------------------------------------------------- a row

function partMore(c: Catalog, r: Row, p: CatalogPart, g: Gate[]): SafeHtml {
  const gd = p.guide;
  const w = p.weapon;
  const cost = gd?.cost ?? p.craft?.inputs ?? {};
  const seconds = gd?.seconds ?? p.craft?.seconds;
  const left = html`
    ${gd?.tradeOff ? html`<p class="trade">${gd.tradeOff.replace(/^./, (x) => x.toUpperCase())}.</p>` : ''}
    <h3>At a glance</h3>
    ${kv('Family', gd?.family)}
    ${kv('Size', gd?.size ?? p.size)}
    ${kv('Grade', `${p.mark} · ${label(p.material)}${p.rarity !== 'common' ? ` · ${p.rarity}` : ''}`)}
    ${kv('Key numbers', gd?.keyNumbers)}
    ${kv('Mounting', gd?.mounting?.join(' · '))}
    ${kv('Fabricating', seconds !== undefined ? duration(seconds) : '')}
    <h3>Getting it</h3>
    ${g.map((x) => html`<div class="cg-gate${x.kind === 'start' ? ' met' : ''}">${x.kind === 'start' ? CHECK : LOCK}<span>${x.drops ?? x.text}</span></div>`)}`;
  const right = html`
    <h3>Numbers</h3>
    ${kv('HP', num(p.hp))}${kv('Mass', num(p.mass, 2))}${kv('Cells', p.cells)}
    ${kv('Damage a second', w && w.dps > 0 ? num(w.dps) : '')}${kv('Reach', w ? `${num(w.range)} units` : '')}
    ${kv('Damage type', w?.damageType ? label(w.damageType) : '')}${kv('Mount', w ? (w.mount === 'turret' ? 'Turret' : 'Fixed') : '')}
    ${kv('Thrust', p.thrust ? num(p.thrust, 2) : '')}${kv('Boost', p.boost ? `x${num(p.boost, 2)}` : '')}
    ${kv('Makes', p.supply ? `${num(p.supply, 1)} E/s` : '')}${kv('Holds', p.store ? `${num(p.store)} E` : '')}
    ${kv('Shield', p.shield ? num(p.shield) : '')}${kv('Hold space', p.cargo ? num(p.cargo) : '')}
    ${kv('Uses', p.draw ? `${num(p.draw, 1)} E/s` : '')}${kv('Ports', p.ports?.length ? `${p.ports.filter((x) => x.dir === 'in').length} in, ${p.ports.filter((x) => x.dir === 'out').length} out` : '')}
    <h3>Making one</h3>
    ${Object.keys(cost).length ? html`<div class="cg-cost">${costChips(c, cost, true)}</div>` : html`<p class="dim">Nothing to fabricate.</p>`}`;
  return html`<div class="cg-more"><div>${left}</div><div>${right}</div><p class="cg-open"><a href="${partHref(p.id)}">${p.name}: full entry</a></p></div>`;
}

function structureMore(c: Catalog, s: CatalogStructure, g: Gate[]): SafeHtml {
  const m = s.material;
  const left = html`
    <h3>The material</h3>
    ${kv('Grade', `${m.mark} · ${m.name}`)}
    ${kv('Toughness · density', `${m.toughness} HP a cell · ${m.density}`)}
    ${kv('Traits', m.traits.join(', '))}
    ${kv('Insulation', m.insulation ? `keeps out ${Math.round(m.insulation * 100)}% of the cold, by its share of the hull` : '')}
    <h3>Getting it</h3>
    ${g.map((x) => html`<div class="cg-gate${x.kind === 'start' ? ' met' : ''}">${x.kind === 'start' ? CHECK : LOCK}<span>${x.text}</span></div>`)}`;
  const right = html`
    <h3>Built in ${m.name} (a square)</h3>
    <div class="table-scroll"><table class="cg-t"><thead><tr><th>Part</th><th class="n">HP</th><th class="n">Armour</th><th class="n">Mass</th><th>Takes</th></tr></thead>
    <tbody>${s.parts.map((x) => html`<tr><td>${c.part.has(x.fn) ? html`<a href="${partHref(x.fn)}">${x.name}</a>` : x.name}</td><td class="n">${num(x.hp)}</td><td class="n">${x.armour}</td><td class="n">${num(x.mass, 1)}</td><td><span class="cg-mats">${costChips(c, x.cost)}</span></td></tr>`)}</tbody></table></div>
    <p class="small dim">Structure is built from plate as it goes in: no fabricator.</p>`;
  return html`<div class="cg-more"><div>${left}</div><div>${right}</div></div>`;
}

function rowHtml(c: Catalog, r: Row): SafeHtml {
  const g = gates(c, r);
  const p = r.part, s = r.structure;
  const art = p?.guide?.art ?? s?.art;
  const cost = p ? p.guide?.cost ?? p.craft?.inputs ?? {} : s?.parts.find((x) => x.fn === 'hull')?.cost ?? {};
  // (Rare and up get a chip on the row, as a cue; every rarity shows in the opened row)
  const rarity = p && !['common', 'uncommon'].includes(p.rarity) ? p.rarity : '';
  return html`<details class="cg-row${rarity ? ` cg-${rarity}` : ''}" id="${r.id}">
  <summary class="cg-main">
    <span class="cg-lv" title="${r.level === null ? 'No level' : `Learned at level ${r.level}`}"><small>LV</small>${r.level === null ? html`<b class="none">-</b>` : html`<b>${r.level}</b>`}</span>
    <span class="cg-gfx">${picture(art, '')}</span>
    <span class="cg-det">
      <span class="cg-top"><span class="cg-name">${r.name}</span>${rarity ? html`<span class="rarity r-${rarity}">${rarity}</span>` : ''}</span>
      ${reqLine(g)}
      <span class="cg-mats">${Object.keys(cost).length ? costChips(c, cost) : html`<span class="per">nothing to fabricate</span>`}${s ? html`<span class="per">a hull cell</span>` : ''}</span>
    </span>
    <span class="cg-key">${p?.guide?.keyNumbers ?? (s ? `${s.material.mark} · ${s.material.toughness} HP a cell` : '')}</span>
    <span class="cg-x" aria-hidden="true">${CHEVRON}</span>
  </summary>
  ${p ? partMore(c, r, p, g) : s ? structureMore(c, s, g) : ''}
</details>`;
}

// ---------------------------------------------------------------- the list

/** The category chips (the game's tab bar) and the rows of the chosen one, or of all of them */
export function componentGuide(c: Catalog, q: Query): SafeHtml {
  const rows = guideRows(c, q);
  const tab = isTab(q.category) ? q.category : null;
  const keep = (k: string) => [q.q && `q=${encodeURIComponent(q.q)}`, q.rarity && `rarity=${encodeURIComponent(q.rarity)}`, k].filter(Boolean).join('&');
  const all = [...rows.values()].reduce((n, r) => n + r.length, 0);
  const chip = (id: GuideTab | null, text: string, n: number) => {
    const qs = keep(id ? `category=${id}` : '');
    return html`<a class="cg-cat${tab === id ? ' on' : ''}" href="/database/parts${qs ? `?${qs}` : ''}"${tab === id ? raw(' aria-current="true"') : ''}>${text}<span class="badge">${n}</span></a>`;
  };
  const shown = GUIDE_TABS.filter((t) => (tab ? t.id === tab : true) && rows.get(t.id)!.length);
  return html`<nav class="cg-cats" aria-label="Component categories">
  ${chip(null, 'All', all)}${GUIDE_TABS.map((t) => chip(t.id, t.label, rows.get(t.id)!.length))}
</nav>
${shown.map((t) => html`<section class="cg-group" aria-labelledby="cg-h-${t.id}">
  <h2 class="cg-group-h" id="cg-h-${t.id}">${t.label} <span class="n">${rows.get(t.id)!.length}</span></h2>
  <div class="cg-cols" aria-hidden="true"><span>Level</span><span>Graphic</span><span>Detail</span></div>
  <div class="cg-list">${rows.get(t.id)!.map((r) => rowHtml(c, r))}</div>
</section>`)}`;
}

/** How many rows a query shows (the count line under the list) */
export function guideCount(c: Catalog, q: Query): { shown: number; total: number } {
  const rows = guideRows(c, q);
  const tab = isTab(q.category) ? q.category : null;
  const totalRows = guideRows(c, { q: '', category: '', rarity: '', sort: '' });
  const sum = (m: Map<GuideTab, Row[]>) => [...m.entries()].filter(([k]) => !tab || k === tab).reduce((n, [, r]) => n + r.length, 0);
  return { shown: sum(rows), total: sum(totalRows) };
}
