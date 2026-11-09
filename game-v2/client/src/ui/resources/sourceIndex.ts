/**
 * @contract client.ui.resource-sources
 * owns:       the guide's source side of the resource index: every rock (what it yields, where it is found), every enemy and boss (what it drops, where it is found), and per item the icon-chip columns (mined, dropped, made from, sold at, rewards, used in)
 * needs:      the GameData shape from resourceIndex.ts (type only), tiers (no I/O, no DOM)
 * invariants: a rock's yields and an item's mined column agree, as do an enemy's drops and an item's dropped column — client/src/ui/resources/sourceIndex.test.ts
 *             no chance or share leaves this file as a number, only as a tier — client/src/ui/resources/sourceIndex.test.ts
 * extend:     a new column is one more list on ItemColumns, filled in buildSourceIndex, and one cell in resourceTable.ts
 */

import type { GameData } from './resourceIndex';
import { tierOf, type Tier } from './tiers';

export interface Place { id: string; name: string; danger: number }
/** A public system: its rocks, the resources obtainable there, and the enemies present (all by id, tiers only) */
export interface SystemEntry {
  id: string; name: string; danger: number; sector: string; color: string;
  rocks: { rock: string; tier: Tier }[];
  items: { item: string; tier: Tier }[];
  /** Bosses first, then factions (ids as in EnemyEntry) */
  enemies: string[];
}
export interface RockEntry {
  id: string; name: string; hardness: number; gas: boolean;
  /** Where its belts are, easiest first */
  systems: Place[];
  /** Every ore it yields, most first */
  yields: { item: string; tier: Tier }[];
  /** The biggest ore's id (the thumbnail's colour) */
  main: string;
}
export interface EnemyEntry {
  id: string; kind: 'boss' | 'faction'; name: string; faction: string; color: string;
  /** The enemy blueprint to draw (data/ships/blueprints/enemy), if any */
  blueprint?: string;
  where: string[];
  /** The public systems it is found in (ids) */
  systemIds: string[];
  drops: { item: string; tier: Tier }[];
}
export interface Recipe { kind: 'refine' | 'fabricate'; inputs: { item: string; n: number }[]; out: number }
export interface ItemColumns {
  mined: { rock: string; tier: Tier }[];
  dropped: { enemy: string; tier: Tier }[];
  madeFrom: Recipe[];
  soldAt: { kind: 'station' | 'quartermaster'; label: string; where: string }[];
  rewards: { job: string; n: number }[];
  /** Items this one goes into (refined, fabricated, or packed) */
  usedIn: string[];
  /** Public systems where it can be got (mined, dropped or in a seam), with the best tier there */
  systems: { id: string; tier: Tier }[];
}
export interface SourceIndex { rocks: RockEntry[]; enemies: EnemyEntry[]; systems: SystemEntry[]; columns: Map<string, ItemColumns> }

const TIER_RANK: Record<Tier, number> = { low: 0, medium: 1, high: 2 };
const better = (a: Tier, b: Tier): Tier => (TIER_RANK[a] >= TIER_RANK[b] ? a : b);

/** A system anyone can fly to: not a private base, the tutorial, the gun range, a planet surface or a siege instance */
export function isPublicSystem(s: GameData['systems'][number]): boolean {
  return !s.private && !s.tutorial && !s.gunRange && s.sector !== 'private' && !s.surface && !s.instance;
}

/** Systems (with danger) whose belts hold each rock type */
export function rockSystemMap(d: GameData): Map<string, Place[]> {
  const out = new Map<string, Place[]>();
  for (const s of d.systems.filter(isPublicSystem)) {
    const fields = [s.asteroidField, ...(s.asteroidBelt?.extra ?? []).map((e) => e.field)].filter((f): f is string => !!f);
    const seen = new Set<string>();
    for (const f of fields) for (const rock of Object.keys(d.mining.fields[f] ?? {})) {
      if (seen.has(rock)) continue;
      seen.add(rock);
      (out.get(rock) ?? out.set(rock, []).get(rock)!).push({ id: s.id, name: s.name, danger: s.danger });
    }
  }
  for (const list of out.values()) list.sort((a, b) => a.danger - b.danger || a.name.localeCompare(b.name));
  return out;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');
const sum = (b: Record<string, number>) => Object.values(b).reduce((a, c) => a + c, 0);

function rocks(d: GameData): RockEntry[] {
  const where = rockSystemMap(d);
  const out: RockEntry[] = [];
  for (const [id, r] of Object.entries(d.mining.types)) {
    const systems = where.get(id);
    if (!systems?.length) continue; // (a rock no belt holds can't be mined)
    const total = sum(r.ores) || 1;
    const yields = Object.entries(r.ores).filter(([, w]) => w > 0).sort((a, b) => b[1] - a[1]).map(([item, w]) => ({ item, tier: tierOf('rock', w / total) }));
    out.push({ id, name: r.name ?? cap(id), hardness: r.hardness, gas: !!r.gas, systems, yields, main: yields[0]?.item ?? '' });
  }
  return out.sort((a, b) => a.systems[0].danger - b.systems[0].danger || a.name.localeCompare(b.name));
}

function enemies(d: GameData): EnemyEntry[] {
  const out: EnemyEntry[] = [];
  const designs = new Set<string>();
  const dropsOf = (loot: { item: string; chance: number }[]) => [...loot].sort((a, b) => b.chance - a.chance).map((l) => ({ item: l.item, tier: tierOf('drop', l.chance) }));
  for (const [id, b] of Object.entries(d.bosses)) {
    designs.add(b.design ?? id);
    const f = b.faction ? d.factions[b.faction] : undefined;
    const sys = d.systems.find((s) => s.id === b.system && isPublicSystem(s));
    out.push({
      id, kind: 'boss', name: b.name, faction: f?.name ?? '', color: f?.color ?? '#9aa4b2', blueprint: b.design ?? id,
      where: sys ? [sys.name] : [], systemIds: sys ? [sys.id] : [], drops: dropsOf(b.loot ?? []),
    });
  }
  for (const [id, f] of Object.entries(d.factions)) {
    if (!f.loot?.length) continue;
    const ship = Object.keys(f.ships ?? {}).find((s) => !(s in d.bosses) && !designs.has(s));
    const sys = d.systems.filter((s) => isPublicSystem(s) && s.nests?.some((n) => n.faction === id)).sort((a, b) => a.danger - b.danger);
    out.push({
      id: `faction:${id}`, kind: 'faction', name: `${f.name} (any ship)`, faction: f.name, color: f.color ?? '#9aa4b2', blueprint: ship,
      where: sys.map((s) => s.name), systemIds: sys.map((s) => s.id), drops: dropsOf(f.loot),
    });
  }
  return out;
}

/** One entry per public system, built from the rock and enemy lists so every direction agrees */
function systems(d: GameData, rk: RockEntry[], en: EnemyEntry[]): SystemEntry[] {
  const out: SystemEntry[] = [];
  for (const s of d.systems.filter(isPublicSystem)) {
    const fields = [s.asteroidField, ...(s.asteroidBelt?.extra ?? []).map((e) => e.field)].filter((f): f is string => !!f);
    const rocks = rk.filter((r) => r.systems.some((p) => p.id === s.id)).map((r) => {
      // (the rock's share of the belt's weights: a tier, never a number)
      const share = Math.max(...fields.map((f) => { const w = d.mining.fields[f] ?? {}; const tot = sum(w) || 1; return (w[r.id] ?? 0) / tot; }));
      return { rock: r.id, tier: tierOf('rock', share) };
    });
    const items = new Map<string, Tier>();
    const add = (item: string, tier: Tier) => items.set(item, items.has(item) ? better(items.get(item)!, tier) : tier);
    for (const r of rocks) for (const y of rk.find((x) => x.id === r.rock)!.yields) add(y.item, y.tier);
    const here = en.filter((e) => e.systemIds.includes(s.id)).sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'boss' ? -1 : 1));
    for (const e of here) for (const x of e.drops) add(x.item, x.tier);
    if (fields.length) for (const g of d.mining.seams) if (s.danger >= g.minTier) add(g.gem, 'low');
    out.push({
      id: s.id, name: s.name, danger: s.danger, sector: s.sector ?? '', color: s.starColor ?? '#fbbf24',
      rocks: rocks.sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier]),
      items: [...items].map(([item, tier]) => ({ item, tier })).sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier]),
      enemies: here.map((e) => e.id),
    });
  }
  return out.sort((a, b) => a.danger - b.danger || a.name.localeCompare(b.name));
}

export function buildSourceIndex(d: GameData): SourceIndex {
  const rk = rocks(d), en = enemies(d);
  const columns = new Map<string, ItemColumns>();
  const col = (id: string): ItemColumns => columns.get(id) ?? columns.set(id, { mined: [], dropped: [], madeFrom: [], soldAt: [], rewards: [], usedIn: [], systems: [] }).get(id)!;
  for (const r of rk) for (const y of r.yields) col(y.item).mined.push({ rock: r.id, tier: y.tier });
  for (const e of en) for (const x of e.drops) col(x.item).dropped.push({ enemy: e.id, tier: x.tier });
  const bagList = (b: Record<string, number>) => Object.entries(b).map(([item, n]) => ({ item, n }));
  for (const r of d.recipes.refining) {
    col(r.id).madeFrom.push({ kind: 'refine', inputs: bagList(r.inputs), out: r.out });
    for (const i of Object.keys(r.inputs)) col(i).usedIn.push(r.id);
  }
  for (const r of d.recipes.craft) for (const [o, n] of Object.entries(r.out)) {
    col(o).madeFrom.push({ kind: 'fabricate', inputs: bagList(r.inputs), out: n });
    for (const i of Object.keys(r.inputs)) col(i).usedIn.push(o);
  }
  for (const it of d.items) if (it.pack) for (const m of Object.keys(it.pack)) col(m).usedIn.push(it.id);
  const sysName = new Map(d.systems.map((s) => [s.id, s.name]));
  for (const s of d.stations) for (const item of s.market?.sells ?? []) col(item).soldAt.push({ kind: 'station', label: s.name, where: sysName.get(s.system) ?? '' });
  for (const rep of Object.values(d.quests.reputations)) for (const row of rep.vendor?.stock ?? []) col(row.item).soldAt.push({ kind: 'quartermaster', label: rep.name, where: `rank ${row.rank}` });
  for (const q of d.quests.quests) for (const [item, n] of Object.entries(q.rewards?.items ?? {})) col(item).rewards.push({ job: q.name, n });
  for (const c of columns.values()) c.usedIn = [...new Set(c.usedIn)];
  const sy = systems(d, rk, en);
  for (const sys of sy) for (const x of sys.items) {
    const c = col(x.item);
    c.systems.push({ id: sys.id, tier: x.tier });
  }
  for (const c of columns.values()) c.systems.sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier]);
  return { rocks: rk, enemies: en, systems: sy, columns };
}
