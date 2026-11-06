/**
 * The catalog snapshot: valid, and free of the game's prose. The site never shows story, history, origins, factions'
 * backstory, codex text or hints, so none of the game's descriptive fields may get into the snapshot or a page.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { checkCatalog, indexCatalog } from './book.js';
import { drawPlan, planBounds } from './draw.js';
import { distinct, filterItems, filterParts, parseQuery } from './query.js';
import { duration, itemText, partText, shipText } from './text.js';
import type { CatalogFile } from './types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const snapshotPath = path.resolve(here, '../../catalog/catalog.json');
const dataDir = path.resolve(here, '../../../data');

const text = fs.readFileSync(snapshotPath, 'utf8');
const file = JSON.parse(text) as CatalogFile;
const catalog = indexCatalog(file, 'snapshot');

/** Every sentence-length string in the game's descriptive data (what the snapshot must not carry) */
function proseOf(): string[] {
  const out: string[] = [];
  const take = (v: unknown, depth = 0) => {
    if (typeof v === 'string') { if (v.trim().length >= 30) out.push(v.trim()); return; }
    if (depth > 8 || !v || typeof v !== 'object') return;
    for (const x of Object.values(v)) take(x, depth + 1);
  };
  const read = (f: string) => { try { return JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8')); } catch { return null; } };
  for (const f of ['codex.json', 'factions.json', 'people.json', 'strings.json']) take(read(f));
  for (const i of read('items.json')?.items ?? []) take(i.description);
  for (const s of read('systems.json')?.systems ?? []) take(s.description);
  for (const s of read('stations.json')?.stations ?? []) { take(s.description); take(s.market?.note); }
  for (const b of Object.values<any>(read('bosses.json')?.bosses ?? {})) { take(b.intro); take(b.title); take(b.faction); for (const p of b.phases ?? []) take(p.say); }
  for (const f of read('ships/functions.json')?.functions ?? []) take(f.description);
  for (const m of read('ships/models.json')?.models ?? []) take(m.description);
  return out;
}

describe('catalog snapshot', () => {
  it('has the shape the site reads, with something in every list', () => {
    expect(checkCatalog(file)).toBe(true);
    for (const k of ['parts', 'items', 'ships', 'bosses', 'stations', 'systems'] as const) expect(file[k].length, k).toBeGreaterThan(0);
    expect(checkCatalog({ ...file, version: 2 })).toBe(false);
    expect(checkCatalog({ ...file, parts: null })).toBe(false);
    expect(checkCatalog(null)).toBe(false);
  });

  it('carries no prose fields', () => {
    const banned = new Set(['description', 'intro', 'title', 'faction', 'note', 'say', 'codex', 'lore', 'text']);
    const found: string[] = [];
    const walk = (v: unknown, at: string) => {
      if (!v || typeof v !== 'object') return;
      for (const [k, x] of Object.entries(v)) { if (banned.has(k)) found.push(`${at}.${k}`); walk(x, `${at}.${k}`); }
    };
    walk(file, '$');
    expect(found).toEqual([]);
  });

  it('contains none of the game\'s descriptive text', () => {
    const prose = proseOf();
    if (!prose.length) return; // (the game's data folder isn't here)
    expect(prose.length).toBeGreaterThan(100); // (the check is looking at something)
    const hits = prose.filter((p) => text.includes(p.replace(/"/g, '\\"')) || text.includes(p));
    expect(hits).toEqual([]);
  });

  it('the text the site writes contains none of it either', () => {
    const prose = proseOf();
    if (!prose.length) return;
    const all = [
      ...file.parts.map((p) => partText(catalog, p)), ...file.items.map((i) => itemText(catalog, i)), ...file.ships.map((s) => shipText(catalog, s)),
    ].join('\n');
    expect(prose.filter((p) => all.includes(p))).toEqual([]);
  });

  it('every reference points at something that exists', () => {
    for (const i of file.items) {
      for (const s of i.soldAt) expect(catalog.station.has(s), `${i.id} soldAt ${s}`).toBe(true);
      for (const b of i.droppedBy) expect(catalog.boss.has(b.boss), `${i.id} droppedBy ${b.boss}`).toBe(true);
    }
    for (const b of file.bosses) {
      expect(catalog.system.has(b.system), `${b.id} system ${b.system}`).toBe(true);
      for (const l of b.loot) expect(catalog.item.has(l.item), `${b.id} loot ${l.item}`).toBe(true);
    }
    for (const s of file.stations) expect(catalog.system.has(s.system), `${s.id} system`).toBe(true);
    for (const p of file.parts) for (const id of Object.keys(p.craft?.inputs ?? {})) expect(catalog.item.has(id), `${p.id} craft ${id}`).toBe(true);
  });

  it('ids are unique in every list', () => {
    for (const k of ['parts', 'items', 'ships', 'bosses', 'stations', 'systems'] as const) expect(new Set(file[k].map((x) => x.id)).size, k).toBe(file[k].length);
  });

  it('every buildable part has the game\'s picture, and every picture and icon is a file the site serves', () => {
    const pub = path.resolve(here, '../../public');
    for (const p of file.parts) if (p.category !== 'structure') expect(p.guide?.art.src, p.id).toBeTruthy();
    expect(file.structure?.length).toBeGreaterThan(3);
    const srcs = [...file.parts.flatMap((p) => (p.guide ? [p.guide.art.src] : [])), ...(file.structure ?? []).map((s) => s.art.src), ...file.items.flatMap((i) => (i.icon ? [i.icon] : []))];
    expect(srcs.length).toBeGreaterThan(200);
    for (const s of srcs) {
      expect(s, s).toMatch(/^\/static\/img\/(parts|items)\/[a-z0-9_-]+\.webp$/);
      expect(fs.existsSync(path.join(pub, s.slice('/static/'.length))), s).toBe(true);
    }
  });

  it('every ship plan can be drawn', () => {
    for (const s of file.ships) {
      expect(planBounds(s.plan, file.render), s.id).not.toBeNull();
      expect(String(drawPlan(s.plan, file.render, { label: s.name }))).toContain('<polygon');
    }
  });
});

describe('queries and text', () => {
  it('filters parts and items by name, type and rarity', () => {
    expect(filterParts(file.parts, parseQuery(new URLSearchParams('q=pip'))).map((p) => p.id)).toContain('cannon_pip');
    const weapons = filterParts(file.parts, parseQuery(new URLSearchParams('category=weapons')));
    expect(weapons.length).toBeGreaterThan(5);
    expect(weapons.every((p) => p.category === 'weapons')).toBe(true);
    const byValue = filterItems(file.items, parseQuery(new URLSearchParams('sort=value')));
    expect(byValue[0].value).toBeGreaterThanOrEqual(byValue[1].value);
    expect(filterItems(file.items, parseQuery(new URLSearchParams('q=zzzzzz')))).toEqual([]);
    expect(distinct(file.items, (i) => i.category)).toContain('mineral');
  });

  it('writes plain sentences from the numbers', () => {
    const pip = partText(catalog, catalog.part.get('cannon_pip')!);
    expect(pip).toMatch(/Fixed/);
    expect(pip).toMatch(/damage a second/);
    expect(pip).toMatch(/Available from the start/);
    expect(itemText(catalog, catalog.item.get('iron_ore')!)).toMatch(/Base value 2 cr/);
    expect(duration(0)).toBe('instant');
    expect(duration(45)).toBe('45 s');
    expect(duration(600)).toBe('10 min');
  });

  it('uses a blurb the game supplies, in place of its own sentences', () => {
    const p = { ...catalog.part.get('cannon_pip')!, blurb: 'A plain gun.' };
    expect(partText(catalog, p)).toBe('A plain gun.');
  });
});
