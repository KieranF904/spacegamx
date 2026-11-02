/**
 * Blueprints: validation, canonical serialisation and part stats.
 */

import type { Blueprint, FunctionDef, InventoryStub, Mount, PlacedPart, Rot, Side, WeaponMods } from './types.js';
import { WEAPON_MOD_NUMBERS, WEAPON_MOD_SETS } from './types.js';
import { type Catalog, SIDE_NORMAL } from './catalog.js';
import type { ShipTuning } from './tuning.js';
import { PlacedGeom, computeJoins, facingEdges, findOverlaps, geomContainsPoint, isEdgeFree, placeGeometry } from './grid.js';
import { partMaterial } from './grades.js';
import { cleanWires } from './wires.js';
import { checkMounting } from './mounting.js';

export type BlueprintErrorCode =
  | 'catalogVersion' | 'unknownPiece' | 'unknownFunction' | 'unknownMaterial' | 'functionNotAllowed'
  | 'badUid' | 'duplicateUid' | 'tooManyParts' | 'coreCount' | 'overlap' | 'unreachable'
  | 'facingMissing' | 'facingBlocked' | 'facingNotJoined' | 'notOwned' | 'materialNotOwned' | 'badPlacement' | 'badMount' | 'exclusive'
  | 'badMounting';

export interface BlueprintError {
  code: BlueprintErrorCode;
  uids: number[];
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: BlueprintError[];
}

/**
 * Every weapon part function (they all fire out of a facing edge and can be
 * turret-mounted): the functions.json entries with a `weapon` kind. Filled by
 * loadCatalog (registerFunctionDefs), so it's empty until a catalog is loaded.
 */
export const WEAPON_FNS = new Set<string>();
export function isWeaponFn(fn: string): boolean {
  return WEAPON_FNS.has(fn);
}

/** Parts that point a facing edge out: weapons, engines (thrust), and any marked `facing` (mining lasers) */
const NEEDS_FACING = new Set<string>();
/** Parts whose facing edge must touch a part instead: a Diode (`oneWay`: its out side, energy-routing-impl.md §3.4) */
const JOINED_FACING = new Set<string>();

/** Every function by id, and the legacy functions of each family (licences: econ/market.ts) */
const FN_DEFS = new Map<string, FunctionDef>();
const LEGACY_OF = new Map<string, string[]>();

/** Note what each function is (called by loadCatalog) */
export function registerFunctionDefs(defs: Iterable<FunctionDef>, legacyFamily?: Map<string, string>): void {
  for (const f of defs) {
    FN_DEFS.set(f.id, f);
    if (f.weapon) WEAPON_FNS.add(f.id);
    if (f.oneWay) JOINED_FACING.add(f.id);
    else if (f.weapon || (f.thrust ?? 0) > 0 || f.facing) NEEDS_FACING.add(f.id);
  }
  if (legacyFamily) {
    LEGACY_OF.clear();
    for (const [fn, fam] of legacyFamily) LEGACY_OF.set(fam, [...(LEGACY_OF.get(fam) ?? []), fn]);
  }
}

/** A function by id, from the last catalog loaded (for rules that have no catalog to hand: licences) */
export function registeredFunction(id: string): FunctionDef | undefined {
  return FN_DEFS.get(id);
}

/**
 * How a weapon part is mounted: its model's own mount when its function has one (a pilot doesn't choose), else the
 * part's (legacy graded weapons on enemies and bosses keep theirs), else 'fixed'.
 */
export function partMount(catalog: Catalog, p: { fn: string; mount?: Mount }): Mount {
  return catalog.functions.get(p.fn)?.mount ?? (p.mount === 'turret' ? 'turret' : 'fixed');
}

/** What a part function looks and breaks like: a model's, the legacy function its family grew from (cannons: 'weapon'); anything else its own */
export function lookFn(fn: string): string {
  const f = FN_DEFS.get(fn);
  return f?.model && f.family ? LEGACY_OF.get(f.family)?.[0] ?? (f.family === 'plating' ? 'armor' : fn) : fn;
}

/** The legacy functions whose parts became a family's models (their licences still teach it) */
export function legacyFunctionsOf(family: string): string[] {
  return LEGACY_OF.get(family) ?? [];
}

/** Does a part of this function carry a facing (whichever rule its edge keeps: partFacingRule) */
export function partNeedsFacing(fn: string): boolean {
  return NEEDS_FACING.has(fn) || JOINED_FACING.has(fn);
}

/**
 * What a part's facing edge must be: 'free' (nothing across it: guns, engines, mining lasers), 'joined' (a part
 * across it: a Diode's out side, which power leaves by), or null (it has no facing). Validation, migration and the
 * hangar's placement all ask this.
 */
export function partFacingRule(fn: string): 'free' | 'joined' | null {
  return JOINED_FACING.has(fn) ? 'joined' : NEEDS_FACING.has(fn) ? 'free' : null;
}

/**
 * What's wrong with part `self`'s facing `side` among `geoms` under its function's rule: 'noEdge' (no straight edge
 * that way), 'blocked' (a 'free' edge with a part across it), 'notJoined' (a 'joined' edge with no part across some
 * of it), or null when it keeps the rule (or the function has none).
 */
export function facingProblem(fn: string, geoms: PlacedGeom[], self: number, side: Side): 'noEdge' | 'blocked' | 'notJoined' | null {
  const rule = partFacingRule(fn);
  if (!rule) return null;
  const edges = facingEdges(geoms[self], side);
  if (!edges.length) return 'noEdge';
  if (rule === 'free') return edges.every((e) => isEdgeFree(geoms, self, e, side)) ? null : 'blocked';
  // (Joined: just past each unit edge's middle lies another part, as power/layout.ts finds a Diode's out part)
  const n = SIDE_NORMAL[side];
  const across = ([a, b]: (typeof edges)[number]) => {
    const x = (a[0] + b[0]) / 2 + n[0] * 0.05, y = (a[1] + b[1]) / 2 + n[1] * 0.05;
    return geoms.some((g, i) => i !== self && geomContainsPoint(g, x, y));
  };
  return edges.every(across) ? null : 'notJoined';
}

export function partMaxHp(catalog: Catalog, p: PlacedPart): number {
  const v = catalog.variants.get(p.piece)![p.rot + (p.flip ? 4 : 0)];
  return v.area * partMaterial(catalog, p)!.toughness * catalog.functions.get(p.fn)!.hpScale * (1 + Math.max(-0.9, p.mods?.mul?.hp ?? 0));
}

export function partMass(catalog: Catalog, p: PlacedPart): number {
  const v = catalog.variants.get(p.piece)![p.rot + (p.flip ? 4 : 0)];
  // (Armour plate: × its function's massScale)
  return (v.area * partMaterial(catalog, p)!.density) * (catalog.functions.get(p.fn)?.massScale ?? 1);
}

/** Flood fill over joins from `root`. Returns a reached flag per index. */
export function floodFill(count: number, joins: [number, number][], root: number, include?: (i: number) => boolean): boolean[] {
  const adj: number[][] = Array.from({ length: count }, () => []);
  for (const [a, b] of joins) {
    if (include && (!include(a) || !include(b))) continue;
    adj[a].push(b);
    adj[b].push(a);
  }
  const reached = new Array<boolean>(count).fill(false);
  if (root < 0 || (include && !include(root))) return reached;
  const stack = [root];
  reached[root] = true;
  while (stack.length) {
    const i = stack.pop()!;
    for (const j of adj[i]) {
      if (!reached[j]) { reached[j] = true; stack.push(j); }
    }
  }
  return reached;
}

export interface ValidateOptions {
  /**
   * Check weapons' mounting rules (ships/mounting.ts: default true). A saved ship is loaded with this off, so one
   * built before a rule changed still flies: only a new design or a refit must keep them.
   */
  mounting?: boolean;
}

/**
 * Validate a blueprint. Pass `inventory` to enforce ownership (null = everything owned).
 * Every rule is checked independently so the editor can show all problems at once.
 */
export function validateBlueprint(
  catalog: Catalog,
  bp: Blueprint,
  tuning: ShipTuning,
  inventory: InventoryStub | null = null,
  opts: ValidateOptions = {},
): ValidationResult {
  const errors: BlueprintError[] = [];
  const err = (code: BlueprintErrorCode, uids: number[], message: string) => errors.push({ code, uids, message });

  if (bp.catalogVersion !== catalog.version) {
    err('catalogVersion', [], `blueprint is for catalog v${bp.catalogVersion}, loaded catalog is v${catalog.version}`);
  }
  if (bp.parts.length > tuning.maxParts) err('tooManyParts', [], `${bp.parts.length} parts (max ${tuning.maxParts})`);

  const uids = new Set<number>();
  const usable: PlacedPart[] = [];
  for (const p of bp.parts) {
    if (!Number.isInteger(p.uid) || p.uid < 0 || p.uid > 255) err('badUid', [p.uid], `uid ${p.uid} must be an integer 0..255`);
    else if (uids.has(p.uid)) err('duplicateUid', [p.uid], `uid ${p.uid} is used twice`);
    uids.add(p.uid);

    const piece = catalog.pieces.get(p.piece);
    const fn = catalog.functions.get(p.fn);
    const mat = catalog.materials.get(p.material);
    if (!piece) err('unknownPiece', [p.uid], `unknown piece "${p.piece}"`);
    if (!fn) err('unknownFunction', [p.uid], `unknown function "${p.fn}"`);
    if (!mat) err('unknownMaterial', [p.uid], `unknown material "${p.material}"`);
    // The game's own ships' parts (bosses', factions'), and designs' own shapes, are never a pilot's
    if (mat?.exclusive) err('exclusive', [p.uid], `"${p.material}" isn't for pilots' ships`);
    if (piece?.bespoke || fn?.exclusive) err('exclusive', [p.uid], `${piece?.bespoke ? `"${p.piece}"` : `"${p.fn}"`} isn't for pilots' ships`);
    if (fn?.model && fn.material !== p.material) err('unknownMaterial', [p.uid], `a ${fn.name ?? p.fn} is made of ${fn.material}, not "${p.material}"`);
    if (piece && fn && fn.pieces !== '*' && !fn.pieces.includes(p.piece)) {
      err('functionNotAllowed', [p.uid], `"${p.fn}" can't go on a "${p.piece}"`);
    }
    if (p.mount !== undefined && p.mount !== 'fixed' && !(p.mount === 'turret' && isWeaponFn(p.fn))) {
      err('badMount', [p.uid], `mount "${p.mount}" only works on weapons ('fixed' or 'turret')`);
    }
    if (!Number.isInteger(p.x) || !Number.isInteger(p.y) || ![0, 1, 2, 3].includes(p.rot)) {
      err('badPlacement', [p.uid], `part ${p.uid} needs integer x/y and rot 0..3`);
      continue;
    }
    if (piece && fn && mat) usable.push(p);
  }

  const cores = bp.parts.filter((p) => p.fn === 'core');
  if (cores.length !== 1) err('coreCount', cores.map((p) => p.uid), `needs exactly one core (has ${cores.length})`);

  const geoms = usable.map((p) => placeGeometry(catalog, p));
  for (const [i, j] of findOverlaps(geoms)) {
    err('overlap', [usable[i].uid, usable[j].uid], `parts ${usable[i].uid} and ${usable[j].uid} overlap`);
  }

  const joins = computeJoins(geoms);
  const coreIdx = usable.findIndex((p) => p.fn === 'core');
  if (coreIdx >= 0) {
    const reached = floodFill(usable.length, joins, coreIdx);
    const lost = usable.filter((_, i) => !reached[i]).map((p) => p.uid);
    if (lost.length) err('unreachable', lost, `${lost.length} part(s) not connected to the core`);
  }

  usable.forEach((p, i) => {
    if (!partNeedsFacing(p.fn)) return;
    if (!p.facing) { err('facingMissing', [p.uid], `${p.fn} ${p.uid} needs a facing`); return; }
    const problem = facingProblem(p.fn, geoms, i, p.facing as Side);
    if (problem === 'noEdge') err('facingMissing', [p.uid], `${p.fn} ${p.uid} has no straight edge facing ${p.facing}`);
    else if (problem === 'blocked') err('facingBlocked', [p.uid], `${p.fn} ${p.uid}: its ${p.facing} edge must be free`);
    else if (problem === 'notJoined') err('facingNotJoined', [p.uid], `${p.fn} ${p.uid}: its ${p.facing} edge must touch a part`);
  });

  // Weapons' mounting rules (attach edge, right-angle side, barrel clearance)
  if (opts.mounting !== false) for (const m of checkMounting(catalog, geoms)) err('badMounting', [m.uid], m.message);

  if (inventory) {
    const used = new Map<string, number[]>();
    for (const p of bp.parts) used.set(p.piece, [...(used.get(p.piece) ?? []), p.uid]);
    for (const [piece, list] of used) {
      const owned = inventory.pieces[piece] ?? 0;
      if (list.length > owned) err('notOwned', list, `uses ${list.length} × ${piece}, owns ${owned}`);
    }
    for (const p of bp.parts) {
      if (!inventory.materials.includes(p.material)) err('materialNotOwned', [p.uid], `material "${p.material}" not owned`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/** Geometry for every part of a blueprint, in blueprint order. */
export function blueprintGeometry(catalog: Catalog, bp: Blueprint): PlacedGeom[] {
  return bp.parts.map((p) => placeGeometry(catalog, p));
}

// ---------------------------------------------------------------------------
// Serialisation: canonical key order, parts sorted by uid, one part per line
// ---------------------------------------------------------------------------

function canonicalPart(p: PlacedPart): PlacedPart {
  const out: PlacedPart = {
    uid: p.uid, piece: p.piece, fn: p.fn, material: p.material,
    x: p.x, y: p.y, rot: p.rot, flip: p.flip,
  };
  if (p.facing) out.facing = p.facing;
  // (A model's mount is its own: the part's would only mislead)
  if (p.mount === 'turret' && !FN_DEFS.get(p.fn)?.mount) out.mount = 'turret';
  const mods = cleanMods(p.mods);
  if (mods) out.mods = mods;
  if (Array.isArray(p.gems) && p.gems.length) out.gems = p.gems.filter((g) => typeof g === 'string').slice(0, 4);
  return out;
}

/** A gun's mods, kept only where they're well formed (numbers where numbers go, known fields) */
export function cleanMods(m: unknown): WeaponMods | undefined {
  if (!m || typeof m !== 'object') return undefined;
  const r = m as Record<string, unknown>, out: WeaponMods = {};
  const nums = (v: unknown, keys: readonly string[]) => {
    if (!v || typeof v !== 'object') return undefined;
    const o: Record<string, number> = {};
    for (const [k, x] of Object.entries(v)) if (keys.includes(k) && typeof x === 'number' && Number.isFinite(x)) o[k] = x;
    return Object.keys(o).length ? o : undefined;
  };
  const mul = nums(r.mul, WEAPON_MOD_NUMBERS), add = nums(r.add, ['burst', 'pierce', 'pierceKeep']);
  if (mul) out.mul = mul;
  if (add) out.add = add;
  if (r.set && typeof r.set === 'object') {
    const set: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r.set)) if (WEAPON_MOD_SETS.includes(k)) set[k] = v;
    if (Object.keys(set).length) out.set = set;
  }
  return Object.keys(out).length ? out : undefined;
}

export function serializeBlueprint(bp: Blueprint): string {
  const parts = [...bp.parts].sort((a, b) => a.uid - b.uid).map((p) => '    ' + JSON.stringify(canonicalPart(p)));
  // (Wires a dozen segments a line)
  const wires = bp.wires ? cleanWires(bp.wires) : undefined, rows: string[] = [];
  for (let i = 0; wires && i < wires.length; i += 12) rows.push('    ' + wires.slice(i, i + 12).map((w) => JSON.stringify(w)).join(', '));
  const wired = !wires ? '' : rows.length ? `,\n  "wires": [\n${rows.join(',\n')}\n  ]` : ',\n  "wires": []';
  const power = bp.power === 'ports' ? ',\n  "power": "ports"' : '';
  return `{\n  "name": ${JSON.stringify(bp.name)},\n  "catalogVersion": ${bp.catalogVersion},\n  "parts": [\n${parts.join(',\n')}\n  ]${wired}${power}\n}\n`;
}

export function parseBlueprint(json: string): Blueprint {
  const raw = JSON.parse(json);
  if (typeof raw?.name !== 'string' || !Array.isArray(raw.parts)) throw new Error('not a blueprint');
  return {
    name: raw.name,
    catalogVersion: raw.catalogVersion,
    ...(typeof raw.paint === 'string' && /^#[0-9a-f]{6}$/i.test(raw.paint) ? { paint: raw.paint.toLowerCase() } : {}),
    ...(typeof raw.drive === 'number' && raw.drive > 0 && raw.drive < 1 ? { drive: Math.max(0.1, raw.drive) } : {}),
    ...(raw.rigid === true ? { rigid: true } : {}),
    ...(Array.isArray(raw.wires) ? { wires: cleanWires(raw.wires) } : {}),
    ...(raw.power === 'ports' ? { power: 'ports' as const } : {}),
    parts: raw.parts.map((p: any) => canonicalPart({
      uid: p.uid, piece: p.piece, fn: p.fn, material: p.material,
      x: p.x, y: p.y, rot: p.rot as Rot, flip: !!p.flip, facing: p.facing, mount: p.mount, mods: p.mods, gems: p.gems,
    })),
  };
}

/** A design with each model part in its model's own material and mount (whatever a client said), in place */
export function fixModelMaterials(catalog: Catalog, bp: Blueprint): Blueprint {
  for (const p of bp.parts) {
    const fn = catalog.functions.get(p.fn);
    if (fn?.model && fn.material) p.material = fn.material;
    if (fn?.mount) delete p.mount;
  }
  return bp;
}

/** Lowest uid not used by the blueprint, or -1 when full. */
export function nextFreeUid(bp: Blueprint): number {
  const used = new Set(bp.parts.map((p) => p.uid));
  for (let i = 0; i <= 255; i++) if (!used.has(i)) return i;
  return -1;
}
