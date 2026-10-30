/**
 * Weapon mounting rules (docs/parts-redesign.md §Mounting): how each weapon model may be fitted.
 *
 * A gun fires out of its `facing` (a free straight edge) and its base bolts on at its attach edge: the edge opposite
 * (a straight mount) or one at right angles (a right-angle mount, the part's flip mirroring which). A rule set may
 * ask that the attach edge be the one holding it on ('back'), that cells ahead stay empty for the barrel, and a
 * turret turns only within its arc. Legacy weapons (enemies', bosses') carry no rules and go anywhere.
 *
 * The checker reports every rule a part breaks. Validation (blueprint.ts) refuses a new design or refit that breaks
 * one; a saved ship that does still loads and flies (validateBlueprint with `mounting: false`), its broken parts
 * flagged in the hangar until the pilot fixes them.
 */

import type { Catalog } from './catalog.js';
import { SIDE_NORMAL, connectorEndpoints } from './catalog.js';
import type { FunctionDef, Mount, MountingRules, PlacedPart, Side, Vec2 } from './types.js';
import type { PlacedGeom } from './grid.js';
import { facingEdges } from './grid.js';
import type { ShipTuning } from './tuning.js';

/** A weapon's mounting with every default filled in */
export interface Mounting {
  /** It has rules of its own (a model): false for legacy weapons, which mount anywhere */
  rules: boolean;
  mount: Mount;
  attach: 'back' | 'any';
  angle: 'straight' | 'right';
  /** A turret's traverse (degrees, centred on where it fires); 0 for a fixed gun (it keeps its gimbal) */
  arc: number;
  clear: [number, number][];
}

/** A turret's traverse when its rules don't say: the tuning's (halfArcDeg × 2), else 180° */
export const DEFAULT_TURRET_ARC = 180;

const OPPOSITE: Record<Side, Side> = { N: 'S', E: 'W', S: 'N', W: 'E' };
const CW: Record<Side, Side> = { N: 'E', E: 'S', S: 'W', W: 'N' };
const CCW: Record<Side, Side> = { N: 'W', E: 'N', S: 'E', W: 'S' };

/**
 * A weapon function's mounting, defaults filled in (null: not a weapon). Takes the function's id or its definition;
 * `tuning` gives a turret without an arc of its own the tuning's.
 */
export function mountingOf(catalog: Catalog, fn: string | FunctionDef | undefined, tuning?: ShipTuning, partMount?: Mount): Mounting | null {
  const f = typeof fn === 'string' ? catalog.functions.get(fn) : fn;
  if (!f?.weapon) return null;
  const r: MountingRules = f.mounting ?? {};
  const mount: Mount = f.mount ?? (partMount === 'turret' ? 'turret' : 'fixed');
  const defArc = tuning?.turret?.halfArcDeg !== undefined ? tuning.turret.halfArcDeg * 2 : DEFAULT_TURRET_ARC;
  return {
    rules: !!f.mounting,
    mount,
    attach: r.attach ?? 'any',
    angle: r.angle ?? 'straight',
    arc: mount === 'turret' ? Math.max(1, Math.min(360, r.arc ?? defArc)) : 0,
    clear: (r.clear ?? []).map(([x, y]) => [x, y] as [number, number]),
  };
}

/** The side a gun bolts on at, from where it fires: opposite, or (right-angle) to its left, or right when flipped */
export function attachSide(fire: Side, angle: 'straight' | 'right', flip: boolean): Side {
  return angle === 'straight' ? OPPOSITE[fire] : flip ? CW[fire] : CCW[fire];
}

/**
 * Where a weapon part fires out of and the edge its base bolts on at (the renderer draws its base there). Null when
 * it isn't a weapon or has no facing yet.
 */
export function weaponSides(catalog: Catalog, part: Pick<PlacedPart, 'fn' | 'facing' | 'flip' | 'mount'>): { fire: Side; attach: Side } | null {
  const m = mountingOf(catalog, part.fn, undefined, part.mount);
  if (!m || !part.facing) return null;
  return { fire: part.facing, attach: attachSide(part.facing, m.angle, !!part.flip) };
}

/**
 * The grid cells a gun's barrel needs empty: its `clear` cells from each cell of its firing edge, in the ship's grid
 * (deduplicated, in rule order). Empty when it has none or no firing edge.
 */
export function clearCells(catalog: Catalog, g: PlacedGeom): Vec2[] {
  const m = mountingOf(catalog, g.part.fn, undefined, g.part.mount);
  const side = g.part.facing as Side | undefined;
  if (!m || !m.clear.length || !side) return [];
  const n = SIDE_NORMAL[side], r: Vec2 = [-n[1], n[0]], s = g.part.flip ? -1 : 1;
  const out: Vec2[] = [], seen = new Set<string>();
  const edges = facingEdges(g, side);
  for (const [right, ahead] of m.clear) {
    for (const [a, b] of edges) {
      const mx = (a[0] + b[0]) / 2 + n[0] * (ahead - 0.5) + r[0] * right * s;
      const my = (a[1] + b[1]) / 2 + n[1] * (ahead - 0.5) + r[1] * right * s;
      const c: Vec2 = [Math.floor(mx), Math.floor(my)], k = `${c[0]},${c[1]}`;
      if (!seen.has(k)) { seen.add(k); out.push(c); }
    }
  }
  return out;
}

/** The unit edges of a part's side that another part's connector joins */
function joinedEdges(geoms: PlacedGeom[], self: number, side: Side): [Vec2, Vec2][] {
  const opp = OPPOSITE[side], out: [Vec2, Vec2][] = [];
  const key = (a: Vec2, b: Vec2) => `${a[0]},${a[1]}:${b[0]},${b[1]}`;
  const mine = new Map<string, [Vec2, Vec2]>();
  for (const c of geoms[self].connectors) if ('side' in c && c.side === side) { const [a, b] = connectorEndpoints(c); mine.set(key(a, b), [a, b]); }
  if (!mine.size) return out;
  for (let i = 0; i < geoms.length; i++) {
    if (i === self) continue;
    for (const c of geoms[i].connectors) {
      if (!('side' in c) || c.side !== opp) continue;
      const [a, b] = connectorEndpoints(c), e = mine.get(key(a, b));
      if (e) { out.push(e); mine.delete(key(a, b)); }
    }
  }
  return out;
}

export type MountingRule = 'angle' | 'attach' | 'clear';

/** One mounting rule a part breaks */
export interface MountingProblem {
  uid: number;
  rule: MountingRule;
  message: string;
  /** 'clear': the cells in the way */
  cells?: Vec2[];
}

/** What a part is called in a message */
const nameOf = (catalog: Catalog, fn: string) => catalog.functions.get(fn)?.name ?? fn;

/**
 * Every mounting rule part `i` of these placed parts breaks (none for a part with no rules, or no facing: that's
 * validation's facingMissing).
 */
export function partMountingProblems(catalog: Catalog, geoms: PlacedGeom[], i: number): MountingProblem[] {
  const g = geoms[i], p = g.part;
  const m = mountingOf(catalog, p.fn, undefined, p.mount);
  if (!m?.rules || !p.facing || g.bespoke) return [];
  const out: MountingProblem[] = [];
  const name = nameOf(catalog, p.fn);
  const fire = p.facing as Side, attach = attachSide(fire, m.angle, !!p.flip);
  if (m.attach === 'back') {
    if (!facingEdges(g, attach).length) {
      out.push({ uid: p.uid, rule: 'angle', message: m.angle === 'right'
        ? `${name} ${p.uid}: a side mount bolts on at its ${attach} edge, and this piece has none there: turn it (R), mirror it (F) or fire another way (T)`
        : `${name} ${p.uid}: it bolts on from behind, and firing ${fire} leaves no straight ${attach} edge: fire another way (T)` });
    } else if (!joinedEdges(geoms, i, attach).length) {
      out.push({ uid: p.uid, rule: 'attach', message: m.angle === 'right'
        ? `${name} ${p.uid}: a side mount: its ${attach} edge must bolt to the ship (F mirrors which side)`
        : `${name} ${p.uid}: bolts on from behind only: its ${attach} edge must join the ship` });
    }
  }
  if (m.clear.length) {
    const want = clearCells(catalog, g);
    const taken = new Set<string>();
    geoms.forEach((o, j) => { if (j !== i) for (const c of o.cells) taken.add(`${c[0]},${c[1]}`); });
    const blocked = want.filter((c) => taken.has(`${c[0]},${c[1]}`));
    if (blocked.length) {
      const ahead = Math.max(...m.clear.map(([, a]) => a));
      out.push({ uid: p.uid, rule: 'clear', cells: blocked, message: `${name} ${p.uid}: its barrel needs ${ahead} clear cell${ahead === 1 ? '' : 's'} ahead (${blocked.length} in the way)` });
    }
  }
  return out;
}

/** Every mounting rule every part of these placed parts breaks */
export function checkMounting(catalog: Catalog, geoms: PlacedGeom[]): MountingProblem[] {
  const out: MountingProblem[] = [];
  for (let i = 0; i < geoms.length; i++) out.push(...partMountingProblems(catalog, geoms, i));
  return out;
}

/** Mounting rules in plain words, for the palette card and tooltip ("Turret, 270°", "Needs 3 clear cells ahead"...) */
export function mountingWords(catalog: Catalog, fn: string | FunctionDef, tuning?: ShipTuning): string[] {
  const m = mountingOf(catalog, fn, tuning);
  if (!m) return [];
  const out: string[] = [m.mount === 'turret' ? `Turret, ${m.arc}°` : 'Fixed: aims with the ship'];
  if (m.angle === 'right') out.push('Side mount (flippable)');
  if (m.attach === 'back') out.push(m.angle === 'right' ? 'Bolts on at its side only' : 'Bolts on from behind only');
  if (m.clear.length) {
    const ahead = Math.max(...m.clear.map(([, a]) => a));
    out.push(`Needs ${ahead} clear cell${ahead === 1 ? '' : 's'} ahead`);
  }
  if (!m.rules) out.push('Mounts anywhere');
  else if (m.attach === 'any' && m.angle === 'straight' && !m.clear.length) out.push('Bolts on any side');
  return out;
}
