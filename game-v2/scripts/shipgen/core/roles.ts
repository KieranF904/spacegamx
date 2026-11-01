// Role templates (data/shipgen/roles.json): the hand-written taste. A selector picks parts by power role (from the power
// core), family or function id, so a new part joins a role's counts with no edit.
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { Blueprint, PlacedGeom } from '../../../common/src/ships/index';
import { parseBlueprint, placeGeometry } from '../../../common/src/ships/index';
import type { ShipgenContext } from './context';
import type { TierBand } from './legend';
import { type PowerRole, partPower } from './partPower';

export interface Selector {
  role?: PowerRole | PowerRole[];
  family?: string | string[];
  fn?: string | string[];
  min?: number;
  max?: number;
  why?: string;
}

export interface Role {
  id: string;
  name: string;
  summary: string;
  size: { cells: [number, number]; maxWidth?: number; maxHeight?: number };
  band: TierBand;
  require?: Selector[];
  encourage?: Selector[];
  style?: string[];
  /** A bundled blueprint (path under data/ships/blueprints, no .json) shown as a worked example */
  example?: string;
  /** Silhouettes to ask for, one per trial: a target that isn't the example */
  shapes?: string[];
  weights?: Record<string, number>;
}

export interface RolesFile { roles: Role[] }

export function loadRoles(ctx: ShipgenContext): RolesFile {
  return JSON.parse(readFileSync(join(ctx.dataDir, 'shipgen/roles.json'), 'utf8'));
}

export function findRole(ctx: ShipgenContext, id: string): Role | undefined {
  return loadRoles(ctx).roles.find((r) => r.id === id);
}

const list = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** Does a part match a selector */
export function matches(ctx: ShipgenContext, sel: Selector, p: { fn: string; piece: string; material: string }): boolean {
  const fn = ctx.catalog.functions.get(p.fn);
  if (!fn) return false;
  if (sel.fn && !list(sel.fn).includes(p.fn)) return false;
  if (sel.family && !list(sel.family).includes(fn.family ?? '')) return false;
  if (sel.role && !list(sel.role).includes(partPower(ctx, fn, p.piece, p.material).role)) return false;
  return !!(sel.fn || sel.family || sel.role);
}

/** "2 weapons", "3 parts of family laser or pulse" */
export function selectorWords(sel: Selector): string {
  const what = sel.fn ? list(sel.fn).join(' or ') : sel.family ? `${list(sel.family).join(' or ')} part(s)` : `${list(sel.role).join(' or ')} part(s)`;
  const n = sel.max !== undefined && sel.min !== undefined ? `${sel.min}-${sel.max}` : sel.max !== undefined ? `at most ${sel.max}` : `at least ${sel.min ?? 1}`;
  return `${n} ${what}`;
}

export interface BriefCheck {
  /** Unmet requirements and size limits, in words */
  unmet: string[];
  /** Encouraged parts missing, in words */
  missing: string[];
}

/** What a design lacks against its role */
export function briefCheck(ctx: ShipgenContext, bp: Blueprint, role: Role): BriefCheck {
  const unmet: string[] = [], missing: string[] = [];
  const count = (s: Selector) => bp.parts.filter((p) => matches(ctx, s, p)).length;
  for (const s of role.require ?? []) {
    const n = count(s);
    if (n < (s.min ?? 1) || (s.max !== undefined && n > s.max)) unmet.push(`needs ${selectorWords(s)} (has ${n})${s.why ? `: ${s.why}` : ''}`);
  }
  for (const s of role.encourage ?? []) {
    const n = count(s);
    if (n < (s.min ?? 1)) missing.push(`${selectorWords(s)} (has ${n})${s.why ? `: ${s.why}` : ''}`);
  }
  const cells = new Set<string>();
  let geoms: PlacedGeom[] = [];
  try { geoms = bp.parts.map((p) => placeGeometry(ctx.catalog, p)); } catch { /* (unknown parts: the check reports them) */ }
  for (const g of geoms) for (const c of g.cells) cells.add(`${c[0]},${c[1]}`);
  const [lo, hi] = role.size.cells;
  if (cells.size < lo || cells.size > hi) unmet.push(`size: ${lo}-${hi} cells (has ${cells.size})`);
  const xs = [...cells].map((k) => Number(k.split(',')[0])), ys = [...cells].map((k) => Number(k.split(',')[1]));
  const w = xs.length ? Math.max(...xs) - Math.min(...xs) + 1 : 0, h = ys.length ? Math.max(...ys) - Math.min(...ys) + 1 : 0;
  if (role.size.maxWidth && w > role.size.maxWidth) unmet.push(`width: at most ${role.size.maxWidth} columns (has ${w})`);
  if (role.size.maxHeight && h > role.size.maxHeight) unmet.push(`length: at most ${role.size.maxHeight} rows (has ${h})`);
  const ex = exampleShip(ctx, role.example);
  const same = ex ? sameness(ctx, bp, ex) : 0;
  if (same >= 0.85) unmet.push(`your own design: ${Math.round(same * 100)}% of its parts are the worked example's, in the same places; make a different ship`);
  return { unmet, missing };
}

const examples = new Map<string, Blueprint | null>();

/** A role's worked example (data/ships/blueprints/<path>.json), or null */
export function exampleShip(ctx: ShipgenContext, path: string | undefined): Blueprint | null {
  if (!path) return null;
  const f = join(ctx.dataDir, 'ships/blueprints', `${path}.json`);
  if (!examples.has(f)) examples.set(f, existsSync(f) ? parseBlueprint(readFileSync(f, 'utf8')) : null);
  return examples.get(f)!;
}

/** Share of parts two designs have in common (same part, same facing, same cells once both are moved to their corner) */
export function sameness(ctx: ShipgenContext, a: Blueprint, b: Blueprint): number {
  const keys = (bp: Blueprint): string[] => {
    let gs: PlacedGeom[];
    try { gs = bp.parts.map((p) => placeGeometry(ctx.catalog, p)); } catch { return []; }
    const all = gs.flatMap((g) => g.cells);
    if (!all.length) return [];
    const x0 = Math.min(...all.map((c) => c[0])), y0 = Math.min(...all.map((c) => c[1]));
    return bp.parts.map((p, i) => [p.fn, p.material, p.piece, p.facing ?? '', gs[i].cells.map((c) => `${c[0] - x0},${c[1] - y0}`).sort().join(';')].join('|'));
  };
  const ka = keys(a), kb = keys(b);
  if (!ka.length || !kb.length) return 0;
  const left = new Map<string, number>();
  for (const k of kb) left.set(k, (left.get(k) ?? 0) + 1);
  let hit = 0;
  for (const k of ka) { const n = left.get(k) ?? 0; if (n) { hit++; left.set(k, n - 1); } }
  return hit / Math.max(ka.length, kb.length);
}
