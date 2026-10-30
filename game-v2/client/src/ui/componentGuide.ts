/**
 * The component guide's data (no DOM): every buildable component under one
 * tab (the models by their `category`, structure by material plus the core),
 * sorted by the level it's learned at, and what gates it for this pilot: a
 * level not reached (nothing opens early), a licence not learned (the core's,
 * a job's material's: and the job that teaches it), a rare boss part not in
 * hand (the legendaries).
 */

import {
  JOB_MATERIALS, MATERIAL_LEVEL, partItemId, STARTER_MATERIALS,
  type Bag, type Catalog, type FunctionDef, type ItemDef,
} from '@space-game/common';

export type CompTab = 'structure' | 'weapons' | 'engines' | 'power' | 'shields' | 'utility';

/** The tabs: functions.json / models.json `category` (the core goes with structure) */
export const COMP_TABS: { id: CompTab; label: string }[] = [
  { id: 'structure', label: 'Structure' },
  { id: 'weapons', label: 'Weapons' },
  { id: 'engines', label: 'Engines & jump' },
  { id: 'power', label: 'Power' },
  { id: 'shields', label: 'Shields & plating' },
  { id: 'utility', label: 'Utility' },
];

const TAB_IDS = new Set<string>(COMP_TABS.map((t) => t.id));

/** A function's tab (null: nothing a pilot builds) */
export function tabOf(fn: FunctionDef): CompTab | null {
  if (fn.legacy || fn.exclusive) return null;
  const c = fn.category === 'core' ? 'structure' : fn.category ?? '';
  return TAB_IDS.has(c) ? (c as CompTab) : null;
}

export interface CompRow {
  /** The model's id; 'core'; or 'structure:<material>' */
  id: string;
  tab: CompTab;
  name: string;
  /** The level it's learned at (null: a licence only) */
  level: number | null;
  /** Tie-break within a level (fabricator order, grade) */
  order: number;
  /** The part it draws and costs as */
  fn: string;
  material: string;
  piece: string;
  kind: 'model' | 'structure' | 'core';
}

/** Structure's functions (shown together in each material's row) */
export const STRUCTURE_FNS = ['hull', 'armor', 'cargo'];

/**
 * Every buildable component: each model (not legacy, not a boss's), each
 * material a pilot can build structure in (one with a plate), and the core
 */
export function guideRows(catalog: Catalog, plates: Record<string, string>): CompRow[] {
  const rows: CompRow[] = [];
  for (const fn of catalog.functions.values()) {
    if (!fn.model) continue;
    const tab = tabOf(fn);
    if (!tab) continue;
    const pieces = fn.pieces === '*' ? ['sq'] : fn.pieces;
    rows.push({ id: fn.id, tab, name: fn.name ?? fn.id, level: fn.unlock?.level ?? null, order: fn.fabOrder ?? 0, fn: fn.id, material: fn.material ?? 'alloy', piece: pieces[0], kind: 'model' });
  }
  for (const m of catalog.materials.values()) {
    if (m.exclusive || !plates[m.id]) continue;
    rows.push({ id: `structure:${m.id}`, tab: 'structure', name: `${m.name ?? m.id} structure`, level: MATERIAL_LEVEL[m.id] ?? null, order: 10 + (m.grade ?? 1), fn: 'hull', material: m.id, piece: 'sq', kind: 'structure' });
  }
  if (catalog.functions.has('core')) rows.push({ id: 'core', tab: 'structure', name: 'Ship core', level: 0, order: 0, fn: 'core', material: 'alloy', piece: 'sq', kind: 'core' });
  return sortRows(rows);
}

/** By level (licence-only last), then order, then name */
export function sortRows<T extends Pick<CompRow, 'level' | 'order' | 'name'>>(rows: T[]): T[] {
  const lv = (r: T) => r.level ?? Infinity;
  return [...rows].sort((a, b) => lv(a) - lv(b) || a.order - b.order || a.name.localeCompare(b.name));
}

export function rowsOf(rows: CompRow[], tab: CompTab): CompRow[] {
  return rows.filter((r) => r.tab === tab);
}

// ---------------------------------------------------------------------------
// What gates it
// ---------------------------------------------------------------------------

/** A job that teaches licences (quests.json onStart / rewards `recipes`) */
export interface QuestTeach { id: string; name: string; teaches: string[] }
/** Where a boss drops an item */
export interface BossDrop { boss: string; chance: number; system?: string }

/** Jobs that teach licences, from quests.json (on taking them or as a reward) */
export function questTeaches(file: { quests: { id: string; name: string; onStart?: { recipes?: string[] }; rewards?: { recipes?: string[] } }[] }): QuestTeach[] {
  return file.quests.map((q) => ({ id: q.id, name: q.name, teaches: [...(q.onStart?.recipes ?? []), ...(q.rewards?.recipes ?? [])] })).filter((q) => q.teaches.length);
}

/** Where each boss's loot drops, by item, from bosses.json (systems by name) */
export function bossDrops(file: { bosses: Record<string, { name: string; system?: string; loot?: { item: string; chance: number }[] }> }, systemName: (id: string) => string | undefined = () => undefined): Map<string, BossDrop[]> {
  const out = new Map<string, BossDrop[]>();
  for (const b of Object.values(file.bosses)) {
    for (const l of b.loot ?? []) out.set(l.item, [...(out.get(l.item) ?? []), { boss: b.name, chance: l.chance, system: b.system ? systemName(b.system) ?? b.system : undefined }]);
  }
  return out;
}

export interface PilotView {
  level: number;
  /** Learned licences and recipes (profile.recipes) */
  learned: string[];
  /** Cargo plus storage */
  have(id: string): number;
}

export interface GateCtx {
  items: ItemDef[];
  quests: QuestTeach[];
  /** By item id */
  drops: Map<string, BossDrop[]>;
  /** What fabricating it takes (models: their recipe's inputs) */
  inputs: Bag;
}

export interface Gate {
  kind: 'level' | 'licence' | 'part' | 'none';
  met: boolean;
  /** What it takes (shown while unmet) */
  text: string;
  /** How it was met (calm) */
  done: string;
}

/** The licence a row needs on top of its level (the core's, a job's material's); none for a model */
export function teachKeys(row: CompRow): string[] {
  if (row.kind === 'structure') return JOB_MATERIALS.includes(row.material) ? [`material:${row.material}`] : [];
  return row.kind === 'core' ? ['fn:core'] : [];
}

/** Where a licence is learned: schematics by name, jobs as “Name” */
export function teachSources(keys: string[], ctx: Pick<GateCtx, 'items' | 'quests'>): { schematics: string[]; jobs: string[] } {
  const want = new Set(keys);
  return {
    schematics: ctx.items.filter((d) => d.teaches?.some((t) => want.has(t))).map((d) => d.name),
    jobs: ctx.quests.filter((q) => q.teaches.some((t) => want.has(t))).map((q) => q.name),
  };
}

const listOr = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`);
const sourceText = (s: { schematics: string[]; jobs: string[] }) => listOr([...s.schematics.slice(0, 2).map((n) => `the ${n}`), ...s.jobs.slice(0, 2).map((n) => `the job “${n}”`)]);

/** Rare parts in its recipe: inputs a boss drops (artefacts and the like) */
export function rareParts(ctx: Pick<GateCtx, 'items' | 'drops' | 'inputs'>): { id: string; n: number; name: string; drops: BossDrop[] }[] {
  const byId = new Map(ctx.items.map((d) => [d.id, d]));
  return Object.entries(ctx.inputs).flatMap(([id, n]) => {
    const d = byId.get(id), drops = ctx.drops.get(id);
    if (!d || !drops?.length || (d.rarity !== 'legendary' && d.category !== 'artefact')) return [];
    return [{ id, n, name: d.name, drops }];
  });
}

/**
 * Every gate on a row for this pilot, in order: its level (nothing opens
 * early), a licence (the core's, a job's material's), rare parts
 */
export function rowGates(row: CompRow, fn: FunctionDef | undefined, pilot: PilotView, ctx: GateCtx): Gate[] {
  const keys = teachKeys(row);
  const taught = keys.some((k) => pilot.learned.includes(k));
  const from = sourceText(teachSources(keys, ctx));
  const lv = row.level;
  const gates: Gate[] = [];
  const level = (n: number): Gate => ({ kind: 'level', met: pilot.level >= n, text: `Reach level ${n} (you're ${pilot.level})`, done: n > 0 ? `Unlocked at level ${n}` : 'Starter: every pilot can build it' });
  const licence: Gate = { kind: 'licence', met: taught, text: from ? `Learned from ${from}` : 'Needs its licence', done: 'licence learned' };
  if (row.kind === 'model' && fn) {
    // (a legendary's gate past its level is the boss part in its recipe)
    gates.push(lv === null ? { kind: 'none', met: false, text: 'No pilot can make this', done: '' } : level(lv));
  } else if (row.kind === 'structure') {
    if (lv !== null && !STARTER_MATERIALS.includes(row.material)) gates.push(level(lv));
    else if (lv === null) gates.push({ kind: 'none', met: false, text: 'No pilot can build in this', done: '' });
    else gates.push(level(0));
    if (JOB_MATERIALS.includes(row.material)) gates.push(licence);
  } else if (row.kind === 'core') gates.push(licence);
  for (const p of rareParts(ctx)) {
    const bosses = [...new Set(p.drops.map((d) => d.boss))];
    gates.push({ kind: 'part', met: pilot.have(p.id) >= p.n, text: `Needs ${p.name}${p.n > 1 ? ` ×${p.n}` : ''}: dropped by ${listOr(bosses)}`, done: `${p.name} in hand` });
  }
  return gates;
}

/** The row's requirement line: what still gates it (red), or that it's open (calm) */
export function requirementLine(gates: Gate[]): { met: boolean; text: string } {
  const unmet = gates.filter((g) => !g.met);
  if (unmet.length) return { met: false, text: unmet.map((g) => g.text).join(' · ') };
  const t = gates.map((g) => g.done).filter(Boolean).join(', ') || 'Unlocked';
  return { met: true, text: t.charAt(0).toUpperCase() + t.slice(1) };
}

/** The part a row costs as (structure: a hull square in its material) */
export function rowItemId(row: CompRow): string {
  return partItemId({ material: row.material, fn: row.fn, piece: row.piece });
}
