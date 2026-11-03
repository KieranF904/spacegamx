/** Searching and filtering the catalog (pure: the pages and the API both use these) */

import type { CatalogBoss, CatalogItem, CatalogKind, CatalogPart, CatalogShip, CatalogStation, PartCategory } from './types.js';
import type { Catalog } from './book.js';

export interface Query { q: string; category: string; rarity: string; sort: string }

const clean = (v: unknown, max = 60) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export function parseQuery(sp: URLSearchParams): Query {
  return { q: clean(sp.get('q')), category: clean(sp.get('category'), 24), rarity: clean(sp.get('rarity'), 16), sort: clean(sp.get('sort'), 16) };
}

const has = (hay: string, needle: string) => hay.toLowerCase().includes(needle.toLowerCase());

export function filterParts(list: CatalogPart[], q: Query): CatalogPart[] {
  return list
    .filter((p) => (!q.category || p.category === q.category) && (!q.rarity || p.rarity === q.rarity))
    .filter((p) => !q.q || has(p.name, q.q) || has(p.family ?? '', q.q) || has(p.id, q.q));
}

export function filterItems(list: CatalogItem[], q: Query): CatalogItem[] {
  const out = list
    .filter((i) => (!q.category || i.category === q.category) && (!q.rarity || i.rarity === q.rarity))
    .filter((i) => !q.q || has(i.name, q.q) || has(i.id, q.q));
  if (q.sort === 'value') out.sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
  else if (q.sort === 'name') out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export const filterShips = (list: CatalogShip[], q: Query): CatalogShip[] => list.filter((s) => !q.q || has(s.name, q.q));
export const filterBosses = (list: CatalogBoss[], q: Query): CatalogBoss[] => list.filter((b) => !q.q || has(b.name, q.q));
export const filterStations = (list: CatalogStation[], q: Query): CatalogStation[] => list.filter((s) => !q.q || has(s.name, q.q));

/** The distinct values of a field, in first-seen order (the filter menus) */
export const distinct = <T>(list: T[], pick: (x: T) => string | null): string[] => [...new Set(list.map(pick).filter((x): x is string => !!x))];

export const PART_CATEGORIES: PartCategory[] = ['weapons', 'engines', 'power', 'shields', 'utility', 'structure', 'core'];
export const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

/** Counts per tab, for the tab bar */
export function counts(c: Catalog): Record<CatalogKind, number> {
  return { parts: c.parts.length, items: c.items.length, ships: c.ships.length, bosses: c.bosses.length, stations: c.stations.length };
}
