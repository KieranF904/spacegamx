/**
 * The hangar palette's rows (no DOM): the component guide's categories and rows (componentGuide.ts), as a builder
 * picks them. A model is one row; structure is one row per function (Hull, Armour, Cargo Hold) whatever it's built
 * in, since the material is picked beside its shape; the core one row; and spare parts you own that no row covers
 * (an old function's) a row each, under their category. Each row knows its shapes; the part it puts in hand comes
 * from the selection (the shape in hand when it's that function's, else its default).
 */

import { partItemId, type Catalog, type FunctionDef } from '@space-game/common';
import { sortRows, STRUCTURE_FNS, type CompRow, type CompTab } from '../ui/componentGuide';
import { defaultShape, shapesOf } from '../ui/componentShapes';

export interface PaletteRow {
  /** The model's id, 'core', 'fn:<structure function>', or 'spare:<item id>' */
  id: string;
  tab: CompTab;
  name: string;
  level: number | null;
  order: number;
  fn: string;
  /** A model's own material; structure's is the one picked */
  material: string;
  kind: 'model' | 'structure' | 'core' | 'spare';
  /** Shapes it comes in (a spare: the one it is) */
  shapes: string[];
}

const TAB_OF_CATEGORY: Record<string, CompTab> = { core: 'structure', structure: 'structure', weapons: 'weapons', engines: 'engines', power: 'power', shields: 'shields', utility: 'utility' };

/** The rows: the guide's models and core, plus one row per structure function */
export function paletteRows(catalog: Catalog, guide: readonly CompRow[]): PaletteRow[] {
  const rows: PaletteRow[] = [];
  const shapes = (fn: string) => {
    const f = catalog.functions.get(fn);
    return f ? shapesOf(catalog, f) : ['sq'];
  };
  for (const r of guide) {
    if (r.kind === 'structure') continue;
    rows.push({ id: r.id, tab: r.tab, name: r.name, level: r.level, order: r.order, fn: r.fn, material: r.material, kind: r.kind, shapes: shapes(r.fn) });
  }
  STRUCTURE_FNS.forEach((fn, i) => {
    const f = catalog.functions.get(fn);
    if (!f || f.legacy || f.exclusive) return;
    rows.push({ id: `fn:${fn}`, tab: 'structure', name: f.name ?? fn, level: 0, order: 1 + i, fn, material: 'alloy', kind: 'structure', shapes: shapes(fn) });
  });
  return sortRows(rows);
}

/** Spare parts you own (item ids with a count) that no row covers: a row each, in their function's category */
export function spareRows(catalog: Catalog, owned: readonly string[], rows: readonly PaletteRow[], part: (id: string) => { fn: string; material: string; piece: string } | null, name: (id: string) => string): PaletteRow[] {
  const covered = new Set(rows.map((r) => r.fn));
  const out: PaletteRow[] = [];
  for (const id of owned) {
    const q = part(id);
    const f: FunctionDef | undefined = q ? catalog.functions.get(q.fn) : undefined;
    if (!q || !f || covered.has(q.fn) || f.exclusive) continue;
    out.push({ id: `spare:${id}`, tab: TAB_OF_CATEGORY[f.category ?? ''] ?? 'structure', name: name(id), level: null, order: 999, fn: q.fn, material: q.material, kind: 'spare', shapes: [q.piece] });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The tab a function's row sits under (null: no row has it) */
export function tabOfFn(rows: readonly PaletteRow[], fn: string): CompTab | null {
  return rows.find((r) => r.fn === fn)?.tab ?? null;
}

/** The selection a builder holds */
export interface HandSel { fn: string; piece: string; material: string }

/**
 * The part a row stands for given what's in hand: its shape is the one in hand when the row's function is (and it
 * comes in it), else the one you last used it in (`remembered`), else its default; structure is in the picked material
 */
export function rowPart(row: PaletteRow, sel: HandSel, remembered?: string): { fn: string; piece: string; material: string } {
  const piece = sel.fn === row.fn && row.shapes.includes(sel.piece) ? sel.piece : defaultShape(row.shapes, remembered);
  return { fn: row.fn, piece, material: row.kind === 'structure' || row.kind === 'core' ? sel.material : row.material };
}

function rowPartId(row: PaletteRow, sel: HandSel, remembered?: string): string {
  return partItemId(rowPart(row, sel, remembered));
}

/** The row holding what's in hand (a spare's by its exact part) */
export function rowInHand(rows: readonly PaletteRow[], sel: HandSel): PaletteRow | undefined {
  return rows.find((r) => r.kind !== 'spare' && r.fn === sel.fn)
    ?? rows.find((r) => r.kind === 'spare' && r.fn === sel.fn && r.shapes[0] === sel.piece && r.material === sel.material);
}
