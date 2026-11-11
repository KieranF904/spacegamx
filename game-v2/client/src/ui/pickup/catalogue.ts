/**
 * @contract client.ui.pickup-catalogue
 * owns:       the auto-pickup catalogue's contents: its sections (Mining, Enemy drops by enemy, Components, Refined materials, Salvage), each item's one-line "where it comes from", its level gate, and the search over them
 * needs:      the field guide's resource data (resourceData: entries, source index, levels), drops.ts (the loot tables' chances), tiers; no DOM; npm: @space-game/common
 * invariants: every ore, component and refined material is in its section once; an enemy's drops list only items it can drop, by tier word, never a number — client/src/ui/pickup/catalogue.test.ts
 *             an item found only outside Sol says "Not in Sol"; a den's own table names the den — client/src/ui/pickup/catalogue.test.ts
 * extend:     a new section is one entry in SECTIONS and its filter; a new kind of source is one step in whereFrom
 */

import { dropChances, dropSpecFor } from '@space-game/common';
import { RESOURCE_DATA, levelIndex, resourceEntries, sourceIndex } from '../resources/resourceData';
import { tierOf, type Tier } from '../resources/tiers';
import type { ResourceEntry } from '../resources/resourceIndex';

export type SectionId = 'mining' | 'drops' | 'component' | 'refined' | 'salvage';
export const SECTIONS: { id: SectionId; label: string }[] = [
  { id: 'mining', label: 'Mining' },
  { id: 'drops', label: 'Enemy drops' },
  { id: 'component', label: 'Components' },
  { id: 'refined', label: 'Refined materials' },
  { id: 'salvage', label: 'Salvage' },
];

/** One tile: an item, where it comes from (one short line), the level it opens at (absent: no gate), and the search text */
export interface CatalogueItem { id: string; name: string; from: string; level?: number; q: string; ore: boolean; tier?: Tier }
/** A group in a section: the enemy drops are one group per enemy, the rest one group */
export interface CatalogueGroup { title?: string; items: CatalogueItem[] }
export interface CatalogueSection { id: SectionId; label: string; groups: CatalogueGroup[] }

/** The words a drop tier reads as on a tile */
const RARITY_WORD: Record<Tier, string> = { low: 'rare', medium: 'uncommon', high: 'common' };
const ORE_CATEGORIES = new Set(['mineral', 'gem', 'volatile']);
/** Sol's systems: the system itself and its pockets (the Scrap Nest) */
const inSol = (sys: string) => sys === 'sol' || sys.startsWith('sol_');

let dropperCache: Map<string, { label: string; chance: number; sol: boolean }[]> | undefined;
/**
 * Per item, who drops it and how likely a kill gives one: bosses by name, factions by name, and designs a system rolls
 * differently (the Scrap Nest den) by that system's name
 */
function droppers(): Map<string, { label: string; chance: number; sol: boolean }[]> {
  if (dropperCache) return dropperCache;
  const d = RESOURCE_DATA, tables = d.loot?.tables ?? {};
  const out = new Map<string, { label: string; chance: number; sol: boolean }[]>();
  const add = (label: string, sol: boolean, rows: { item: string; chance: number }[]) => {
    for (const r of rows) (out.get(r.item) ?? out.set(r.item, []).get(r.item)!).push({ label, chance: r.chance, sol });
  };
  const sysName = new Map(d.systems.map((s) => [s.id, s.name]));
  for (const [, b] of Object.entries(d.bosses)) add(b.name, inSol(b.system), dropChances(tables, { drops: b.drops }));
  const factionSystems = new Map<string, string[]>();
  for (const [sid, sp] of Object.entries((d.spawns ?? {}) as Record<string, { groups?: { faction?: string }[]; nests?: { groups?: { faction?: string }[] }[] }>)) {
    for (const g of [...(sp.groups ?? []), ...(sp.nests ?? []).flatMap((n) => n.groups ?? [])]) if (g.faction) (factionSystems.get(g.faction) ?? factionSystems.set(g.faction, []).get(g.faction)!).push(sid);
  }
  for (const [fid, f] of Object.entries(d.factions)) {
    const sol = (factionSystems.get(fid) ?? []).some(inSol);
    const rows = new Map<string, number>();
    for (const [design, s] of Object.entries(f.ships ?? {})) {
      if (design in d.bosses || design.startsWith('boss_') || design.startsWith('giant_')) continue;
      for (const r of dropChances(tables, dropSpecFor(s, f))) rows.set(r.item, Math.max(rows.get(r.item) ?? 0, r.chance));
    }
    add(f.name, sol, [...rows].map(([item, chance]) => ({ item, chance })));
  }
  // (A system that rolls its own for some designs: named after the place)
  for (const [sid, sp] of Object.entries(d.spawns ?? {})) {
    for (const [design, spec] of Object.entries(sp.loot ?? {})) {
      const f = Object.values(d.factions).find((x) => x.ships?.[design]);
      if (!f) continue;
      add(sysName.get(sid) ?? sid, inSol(sid), dropChances(tables, dropSpecFor(spec, f.ships![design], f)));
    }
  }
  return (dropperCache = out);
}

/** The one line a tile says about where an item comes from */
export function whereFrom(e: ResourceEntry): string {
  const rows = (droppers().get(e.id) ?? []).sort((a, b) => b.chance - a.chance);
  const solTag = (sol: boolean) => (sol ? '' : ' · Not in Sol');
  const rocks = e.cols.mined;
  if (rocks.length) {
    const ix = sourceIndex();
    const rock = ix.rocks.find((r) => r.id === rocks[0].rock);
    const sol = rocks.some((m) => ix.rocks.find((r) => r.id === m.rock)?.systems.some((s) => inSol(s.id)));
    return `${rock?.name ?? rocks[0].rock} rocks${solTag(sol)}`;
  }
  if (rows.length) {
    const best = rows.find((r) => r.sol) ?? rows[0];
    return `${best.label} · ${RARITY_WORD[tierOf('drop', best.chance)]}${solTag(rows.some((r) => r.sol))}`;
  }
  const kinds = new Set(e.sources.map((s) => s.kind));
  if (kinds.has('refine')) return 'Refined from ore';
  if (kinds.has('fabricate')) return 'Fabricated';
  if (kinds.has('salvage')) return 'Salvage fields';
  if (kinds.has('bought')) return 'Bought at stations';
  if (kinds.has('quest')) return 'Job reward';
  return 'Not obtainable yet';
}

const item = (e: ResourceEntry, tier?: Tier): CatalogueItem => {
  const from = whereFrom(e);
  return { id: e.id, name: e.name, from, level: levelIndex().res.get(e.id), q: `${e.name} ${e.id} ${from}`.toLowerCase(), ore: ORE_CATEGORIES.has(RESOURCE_DATA.items.find((i) => i.id === e.id)?.category ?? ''), ...(tier ? { tier } : {}) };
};

let cached: CatalogueSection[] | undefined;
/** Every section with its groups and tiles (built once) */
export function catalogue(): CatalogueSection[] {
  if (cached) return cached;
  const entries = resourceEntries();
  const byId = new Map(entries.map((e) => [e.id, e]));
  const salvage = new Set(entries.filter((e) => e.category === 'drop' || e.sources.some((s) => s.kind === 'salvage')).map((e) => e.id));
  const groups: Record<SectionId, CatalogueGroup[]> = {
    mining: [{ items: entries.filter((e) => e.category === 'ore').map((e) => item(e)) }],
    drops: sourceIndex().enemies.map((en) => ({
      title: en.name,
      items: en.drops.map((x) => byId.get(x.item)).filter((e): e is ResourceEntry => !!e).map((e) => item(e, en.drops.find((x) => x.item === e.id)!.tier)),
    })).filter((g) => g.items.length),
    component: [{ items: entries.filter((e) => e.category === 'component' || e.category === 'pack').map((e) => item(e)) }],
    refined: [{ items: entries.filter((e) => e.category === 'refined').map((e) => item(e)) }],
    salvage: [{ items: entries.filter((e) => salvage.has(e.id)).map((e) => item(e)) }],
  };
  return (cached = SECTIONS.map((s) => ({ ...s, groups: groups[s.id] })));
}

/** The tiles a search shows: every word of it in a tile's name, id or where-from line */
export function matches(t: CatalogueItem, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return words.every((w) => t.q.includes(w));
}
