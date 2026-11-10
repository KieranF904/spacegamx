/**
 * @contract client.ui.resource-commonness
 * owns:       the one "most commonly met first" order of the field guide grids (Resources within a category, Rocks, Enemies, Systems), computed from game data in buildCommonness below
 * needs:      common/ (MATERIAL_LEVEL), the GameData shape (type only), the source index and the level index (no I/O, no DOM)
 * invariants: a resource ranks by how early a pilot meets it (lowest system level among its sources, a Low-chance drop / refining trace / boss drop / quartermaster-rank sale counting later than ordinary mining), then by how widely it is used (low-level uses weigh more), then level gate, then name — client/src/ui/resources/commonness.test.ts
 *             a rock ranks by its best belt (early system, big share of the belt) then how many systems hold it; a boss ranks after its faction's ordinary entry; a system ranks by level, then danger — client/src/ui/resources/commonness.test.ts
 *             the order is a pure function of the data (same data, same order) — client/src/ui/resources/commonness.test.ts
 * extend:     a new kind of source is one more row in LATE and one more candidate in meetOf; a new kind of use is one more line of uses in buildCommonness
 */

import { MATERIAL_LEVEL } from '@space-game/common';
import type { GameData } from './resourceIndex';
import type { SourceIndex } from './sourceIndex';
import type { LevelIndex, LevelView } from './levels';
import type { Tier } from './tiers';

/** How many levels "later" a way of getting something feels, over ordinary mining in the same system */
const LATE = {
  /** by the share/chance tier of a belt rock or a drop */
  tier: { high: 0, medium: 1, low: 4 } as Record<Tier, number>,
  boss: 8, trace: 10, quartermaster: 12, seam: 3, quest: 3, salvage: 2, salvageRare: 6, station: 1, made: 1,
};
/** An item nobody can get yet sorts last */
const NEVER = 99;

const lvl = (n: number | undefined) => n ?? 1;
/** A use weighs less the higher the level it opens at (level 1 = 1, level 11 = 1/3) */
const weight = (level: number | undefined) => 1 / (1 + Math.max(0, lvl(level) - 1) / 5);
const min = (a: number[], none = NEVER) => (a.length ? Math.min(...a) : none);

export interface CommonnessIndex {
  /** Resources: how early it is met (lower first) and its weighted use count (higher first) */
  res: { meet: Map<string, number>; use: Map<string, number> };
  /** Rocks / enemies / systems: [primary key, secondary]; primary lower first; secondary higher first (systems: lower first) */
  rock: Map<string, [number, number]>;
  enemy: Map<string, [number, number]>;
  sys: Map<string, [number, number]>;
}

export function buildCommonness(d: GameData, ix: SourceIndex, lv: LevelIndex): CommonnessIndex {
  const sysLevel = (id: string) => lvl(lv.sys.get(id));

  // --- Rocks: best belt = early system + the rock's share of that belt
  const rock = new Map<string, [number, number]>();
  for (const r of ix.rocks) {
    const best = min(ix.systems.flatMap((s) => s.rocks.filter((x) => x.rock === r.id).map((x) => sysLevel(s.id) + LATE.tier[x.tier])));
    rock.set(r.id, [best, r.systems.length]);
  }

  // --- Enemies: early systems first; a boss after its faction's ordinary entry
  const enemy = new Map<string, [number, number]>();
  for (const e of ix.enemies.filter((x) => x.kind === 'faction')) enemy.set(e.id, [e.systemIds.length ? min(e.systemIds.map(sysLevel)) : NEVER, e.systemIds.length]);
  for (const e of ix.enemies.filter((x) => x.kind === 'boss')) {
    const own = (e.systemIds.length ? min(e.systemIds.map(sysLevel)) : NEVER) + LATE.boss;
    const facId = d.bosses[e.id]?.faction;
    const fac = facId ? enemy.get(`faction:${facId}`) : undefined;
    enemy.set(e.id, [fac ? Math.max(own, fac[0] + 0.5) : own, 0]);
  }

  // --- Systems: progression outward from Sol
  const sys = new Map<string, [number, number]>();
  const order = new Map(d.systems.map((s, n) => [s.id, n]));
  for (const s of ix.systems) sys.set(s.id, [sysLevel(s.id), (s.danger + 1) * 1000 + (order.get(s.id) ?? 0)]);

  // --- Resources: how early it is met
  const meetMemo = new Map<string, number>();
  const visiting = new Set<string>();
  const meetOf = (id: string): number => {
    const got = meetMemo.get(id);
    if (got !== undefined) return got;
    if (visiting.has(id)) return NEVER;
    visiting.add(id);
    const c = ix.columns.get(id);
    const cand: number[] = [];
    for (const m of c?.mined ?? []) {
      const r = ix.rocks.find((x) => x.id === m.rock);
      if (r) cand.push(...r.systems.map((p) => sysLevel(p.id) + LATE.tier[m.tier]));
    }
    for (const dr of c?.dropped ?? []) {
      const e = ix.enemies.find((x) => x.id === dr.enemy);
      if (e) cand.push(...e.systemIds.map((s) => sysLevel(s) + LATE.tier[dr.tier] + (e.kind === 'boss' ? LATE.boss : 0)));
    }
    const sm = d.mining.seams.find((x) => x.gem === id);
    if (sm) for (const s of ix.systems) if (s.danger >= sm.minTier && s.rocks.length) cand.push(sysLevel(s.id) + LATE.seam);
    const tr = d.mining.traces[id];
    if (tr) {
      const first = Math.max(0, tr.per100.findIndex((v) => v > 0));
      cand.push(min(ix.systems.filter((s) => s.danger >= first).map((s) => sysLevel(s.id)), 1) + LATE.trace + (tr.megaOnly ? 2 : 0));
    }
    for (const st of d.stations) if (st.market?.sells?.includes(id)) cand.push(sysLevel(st.system) + LATE.station);
    for (const rep of Object.values(d.quests.reputations)) {
      const ranks = (rep.vendor?.stock ?? []).filter((x) => x.item === id).map((x) => x.rank);
      if (ranks.length) cand.push(LATE.quartermaster + Math.min(...ranks));
    }
    for (const q of d.quests.quests) if (q.rewards?.items?.[id]) cand.push(lvl(q.level) + LATE.quest);
    const sv = d.rules.events?.salvage;
    if (sv?.goods?.includes(id)) cand.push(1 + LATE.salvage);
    if (sv?.rare?.includes(id)) cand.push(1 + LATE.salvageRare);
    // made from other things: as late as the latest input of a recipe, and its own level
    const recipes = [...d.recipes.refining.filter((r) => r.id === id), ...d.recipes.craft.filter((r) => id in r.out)];
    for (const r of recipes) cand.push(Math.max(lvl(r.level), ...Object.keys(r.inputs).map(meetOf)) + LATE.made);
    visiting.delete(id);
    const out = min(cand);
    meetMemo.set(id, out);
    return out;
  };

  // --- Resources: how widely it is used, low-level uses weighing more
  const use = new Map<string, number>();
  const bump = (id: string, w: number) => use.set(id, (use.get(id) ?? 0) + w);
  for (const r of d.recipes.refining) for (const i of Object.keys(r.inputs)) bump(i, weight(r.level ?? lv.res.get(r.id)));
  for (const r of d.recipes.craft) {
    const outLevel = Math.max(0, ...Object.keys(r.out).map((o) => lv.res.get(o) ?? 0));
    for (const i of Object.keys(r.inputs)) bump(i, weight(r.starter ? 1 : r.level ?? outLevel));
  }
  for (const m of Object.values(d.recipes.models ?? {})) for (const i of Object.keys(m.inputs)) bump(i, 1);
  for (const [m, item] of Object.entries(d.recipes.parts.plates)) bump(item, 100 * weight(MATERIAL_LEVEL[m]));
  for (const b of Object.values(d.recipes.parts.extras)) for (const i of Object.keys(b)) bump(i, 1);
  for (const t of Object.values(d.station.tracks)) t.tiers.forEach((x, n) => { for (const i of Object.keys(x.cost ?? {})) bump(i, weight(n * 3 + 1)); });
  for (const c of Object.values(d.gems.cuts)) for (const i of Object.keys(c.inputs)) bump(i, 1);
  for (const it of d.items) if (it.pack) for (const i of Object.keys(it.pack)) bump(i, weight(lv.res.get(it.id)));

  const meet = new Map<string, number>();
  for (const it of d.items) meet.set(it.id, meetOf(it.id));
  return { res: { meet, use }, rock, enemy, sys };
}

/** Entries in the guide's order for a view (resources: pass the entries of one category); the sort is total, so it is deterministic */
export function sortByCommonness<T extends { id: string }>(ci: CommonnessIndex, lv: LevelIndex, view: LevelView, items: T[], nameFor: (t: T) => string): T[] {
  const level = (t: T) => lv[view].get(t.id) ?? 0;
  const name = (a: T, b: T) => nameFor(a).localeCompare(nameFor(b));
  if (view === 'res') {
    return [...items].sort((a, b) =>
      (ci.res.meet.get(a.id) ?? NEVER) - (ci.res.meet.get(b.id) ?? NEVER)
      || (ci.res.use.get(b.id) ?? 0) - (ci.res.use.get(a.id) ?? 0)
      || level(a) - level(b) || name(a, b));
  }
  const keys = ci[view];
  const asc = view === 'sys';
  return [...items].sort((a, b) => {
    const ka = keys.get(a.id) ?? [NEVER, 0], kb = keys.get(b.id) ?? [NEVER, 0];
    return ka[0] - kb[0] || (asc ? ka[1] - kb[1] : kb[1] - ka[1]) || level(a) - level(b) || name(a, b);
  });
}
