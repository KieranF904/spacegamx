/**
 * Build orders at a glance: for each hangar slot, what its unbuilt parts
 * still take, all the way down to ore. Orders share storage and the jobs in
 * progress in priority order (the order the hangar works them: Hangar.ts),
 * then slots not on order are costed against whatever's left.
 *
 * Every line is one item at one stage: the parts themselves (modules, and the
 * plate structure is built from), the materials the missing modules are
 * fabricated from, and the ore the missing materials are refined from. Each
 * says how much is ready in storage, how much is being made, how much is
 * still to make (waiting on its inputs, or a free queue), and how much can't
 * be made at all (gather or buy it).
 */

import type { Bag, Stack } from './stacks.js';
import type { Economy } from './economy.js';
import type { Blueprint } from '../ships/types.js';
import type { Catalog } from '../ships/catalog.js';
import { buildableGhosts } from './hangar.js';
import { canCraft } from './market.js';
import { ghostBill } from './salvage.js';

export type OrderStage = 'part' | 'material' | 'ore';

export interface OrderLine {
  id: string;
  stage: OrderStage;
  need: number;
  /** In storage, set aside for this order */
  ready: number;
  /** Being refined or fabricated */
  coming: number;
  /** Still to make: it can be, once its inputs (or a queue slot) are there */
  waiting: number;
  /** Can't be made: gather or buy it (or, with `blocked: 'schematic'`, it opens at a later level: the name is old) */
  short: number;
  /** What it's for: item names, or 'structure' */
  for: string[];
  /** Why what's waiting hasn't started: its inputs are short, or the queue is full */
  blocked?: 'inputs' | 'queue' | 'schematic';
}

export interface OrderPlan {
  slot: number;
  name: string;
  /** On order (the hangar works it) */
  auto: boolean;
  paused: boolean;
  lines: OrderLine[];
  /** Raw shortfall: what to mine, salvage or buy */
  gather: Bag;
}

export interface OrderSource {
  storage: Stack[];
  jobs: { out: Bag; count: number; done: number }[];
  recipes: string[];
  /** The pilot's level (models unlock by it) */
  level?: number;
  hangar: ({ blueprint: Blueprint; ghosts?: number[]; auto?: boolean; paused?: boolean; rank?: number } | null)[];
}

/** The order the hangar works its slots in: on order first, by rank, then by slot */
export function orderRanking(hangar: OrderSource['hangar'], catalog?: Catalog): number[] {
  return hangar.map((rec, slot) => ({ rec, slot }))
    .filter((x) => x.rec && (catalog ? buildableGhosts(catalog, x.rec.blueprint, x.rec.ghosts ?? []) : x.rec.ghosts ?? []).length)
    .sort((a, b) => Number(!!b.rec!.auto) - Number(!!a.rec!.auto) || (a.rec!.rank ?? 0) - (b.rec!.rank ?? 0) || a.slot - b.slot)
    .map((x) => x.slot);
}

export function planOrders(econ: Economy, src: OrderSource): OrderPlan[] {
  const ready: Bag = {};
  const coming: Bag = {};
  for (const s of src.storage) ready[s.id] = (ready[s.id] ?? 0) + s.n;
  for (const j of src.jobs) for (const [id, n] of Object.entries(j.out)) coming[id] = (coming[id] ?? 0) + n * (j.count - j.done);
  const take = (id: string, n: number) => {
    const r = Math.min(ready[id] ?? 0, n);
    ready[id] = (ready[id] ?? 0) - r;
    const c = Math.min(coming[id] ?? 0, n - r);
    coming[id] = (coming[id] ?? 0) - c;
    return { r, c, left: n - r - c };
  };
  const out: OrderPlan[] = [];
  for (const slot of orderRanking(src.hangar, econ.ships)) {
    const rec = src.hangar[slot]!;
    const lines = new Map<string, OrderLine>();
    const line = (stage: OrderStage, id: string, n: number, why: string) => {
      const k = `${stage}:${id}`;
      let l = lines.get(k);
      if (!l) { l = { id, stage, need: 0, ready: 0, coming: 0, waiting: 0, short: 0, for: [] }; lines.set(k, l); }
      l.need += n;
      if (!l.for.includes(why)) l.for.push(why);
      return l;
    };
    const gather: Bag = {};
    const materials: [string, number, string][] = [];
    // Parts: modules as items, structure as plate
    for (const [id, n] of Object.entries(ghostBill(econ, rec.blueprint, buildableGhosts(econ.ships, rec.blueprint, rec.ghosts ?? [])))) {
      if (econ.recipes.refining.has(id)) { materials.push([id, n, 'structure']); continue; }
      const l = line('part', id, n, rec.blueprint.name);
      const t = take(id, n);
      l.ready += t.r; l.coming += t.c;
      if (t.left <= 0) continue;
      const r = econ.recipes.recipeFor(id);
      if (!r || !canCraft(r, src.recipes, src.level)) { l.short += t.left; l.blocked = 'schematic'; continue; }
      l.waiting += t.left;
      const runs = Math.ceil(t.left / Math.max(1, r.out[id] ?? 1));
      for (const [m, k] of Object.entries(r.inputs)) materials.push([m, k * runs, econ.items.name(id)]);
    }
    // Materials: refined from ore, or (components) gathered
    const ores: [string, number, string][] = [];
    const lacking = new Set<string>();
    for (const [id, n, why] of materials) {
      const l = line('material', id, n, why);
      const t = take(id, n);
      l.ready += t.r; l.coming += t.c;
      if (t.left <= 0) continue;
      lacking.add(id);
      const r = econ.recipes.refining.get(id);
      if (!r) { l.short += t.left; gather[id] = (gather[id] ?? 0) + t.left; continue; }
      l.waiting += t.left;
      const batches = Math.ceil(t.left / Math.max(1, r.out));
      for (const [o, k] of Object.entries(r.inputs)) ores.push([o, k * batches, econ.items.name(id)]);
    }
    const oreShort = new Set<string>();
    for (const [id, n, why] of ores) {
      const l = line('ore', id, n, why);
      const t = take(id, n);
      l.ready += t.r; l.coming += t.c;
      if (t.left <= 0) continue;
      l.short += t.left;
      oreShort.add(why);
      gather[id] = (gather[id] ?? 0) + t.left;
    }
    // Why what's waiting hasn't started
    for (const l of lines.values()) {
      if (!l.waiting) continue;
      if (l.stage === 'material') l.blocked = oreShort.has(econ.items.name(l.id)) ? 'inputs' : 'queue';
      else if (l.stage === 'part') {
        const r = econ.recipes.recipeFor(l.id);
        l.blocked = r && Object.keys(r.inputs).some((m) => lacking.has(m)) ? 'inputs' : 'queue';
      }
    }
    out.push({ slot, name: rec.blueprint.name, auto: !!rec.auto, paused: !!rec.paused, lines: [...lines.values()], gather });
  }
  return out;
}
