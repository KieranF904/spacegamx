// The legend: a stable two-letter code for every part a pilot can build (each model; each structure function in each
// material), with a line of what it is built from the catalog, describePart, mounting rules and the power core.
// Codes are derived (initials first, collisions resolved in catalog order), so they only move if the catalog reorders.
import type { FunctionDef } from '../../../common/src/ships/index';
import { describePart, getVariant, mountingWords, partFacingRule, registeredFunction } from '../../../common/src/ships/index';
import { JOB_MATERIALS, MATERIAL_LEVEL, STARTER_MATERIALS, partLicensed } from '../../../common/src/econ/index';
import type { ShipgenContext } from './context';
import { type PartPower, partPower } from './partPower';
import { pieceShapes } from './shapes';

export interface CodeDef {
  /** Two capital letters (a part's other cells write it in small letters) */
  code: string;
  fn: string;
  material: string;
  /** Fixes the piece (bespoke pieces, in a design's own key); otherwise the cells and shape mark say it */
  piece?: string;
  mount?: 'turret';
  kind: 'model' | 'structure' | 'extra';
}

export interface LegendEntry extends CodeDef {
  name: string;
  /** Pilot level it opens at */
  level: number;
  rarity: string;
  /** Needs a job's licence too (structure materials) */
  job?: boolean;
  /** Pieces it may be (catalog order) */
  pieces: string[];
  facing: 'free' | 'joined' | null;
  power: PartPower;
  /** The legend line the model reads */
  line: string;
}

export interface Legend {
  entries: LegendEntry[];
  byCode: Map<string, LegendEntry>;
  /** The legend code for a part's function and material (and turret mount), if it has one */
  find(fn: string, material: string): LegendEntry | undefined;
}

/** Which parts a design may use: pilots' levels and rarities */
export interface TierBand {
  maxLevel: number;
  /** Rarities allowed (default: every one but legendary) */
  rarities?: string[];
  /** Job materials (licences) allowed */
  jobMaterials?: boolean;
  /** Function ids always left out / always kept */
  exclude?: string[];
  include?: string[];
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const wordsOf = (s: string) => s.toUpperCase().replace(/[^A-Z ]+/g, ' ').split(' ').filter(Boolean);

/** Code candidates for a name: initials, then first letter with each later letter, then any pair */
function* candidates(name: string): Generator<string> {
  const w = wordsOf(name), all = w.join('');
  if (!all.length) { for (const a of LETTERS) for (const b of LETTERS) yield a + b; return; }
  if (w.length >= 2) yield w[0][0] + w[1][0];
  for (let j = 1; j < all.length; j++) yield all[0] + all[j];
  for (let i = 1; i < all.length; i++) for (let j = i + 1; j < all.length; j++) yield all[i] + all[j];
  for (const b of LETTERS) yield all[0] + b;
  for (const a of LETTERS) for (const b of LETTERS) yield a + b;
}

/** Pick the first free letter of a name (letter codes for structure functions and materials) */
function letterFor(name: string, used: Set<string>): string {
  const pick = [...wordsOf(name).join('')].find((c) => !used.has(c)) ?? [...LETTERS].find((c) => !used.has(c)) ?? 'X';
  used.add(pick);
  return pick;
}

export function allocateCode(name: string, used: Set<string>): string {
  for (const c of candidates(name)) if (!used.has(c)) { used.add(c); return c; }
  throw new Error('out of codes');
}

const legends = new WeakMap<ShipgenContext, Legend>();

export function buildLegend(ctx: ShipgenContext): Legend {
  const hit = legends.get(ctx);
  if (hit) return hit;
  const { catalog } = ctx;
  const used = new Set<string>(), entries: LegendEntry[] = [];
  const fns = [...catalog.functions.values()];
  // Structure first (core, hull, armour, cargo: functions that aren't models, legacy or exclusive), a letter for the function and one for the material
  const structure = fns.filter((f) => !f.model && !f.legacy && !f.exclusive);
  const mats = [...catalog.materials.values()].filter((m) => !m.exclusive);
  const fnUsed = new Set<string>(), matUsed = new Set<string>();
  const fnLetter = new Map(structure.map((f) => [f.id, letterFor(f.name ?? f.id, fnUsed)]));
  const matLetter = new Map(mats.map((m) => [m.id, letterFor(m.name ?? m.id, matUsed)]));
  // (a material whose letter is its initial is "natural": its structure codes come before the models', the rest after)
  const natural = (m: { id: string; name?: string }) => wordsOf(m.name ?? m.id).join('')[0] === matLetter.get(m.id);
  const addStructure = (f: FunctionDef, m: (typeof mats)[number]) => {
    let code = fnLetter.get(f.id)! + matLetter.get(m.id)!;
    const label = `${f.name ?? f.id} (${m.name ?? m.id})`;
    if (used.has(code)) code = allocateCode(label, used);
    used.add(code);
    const level = STARTER_MATERIALS.includes(m.id) ? 0 : MATERIAL_LEVEL[m.id] ?? 99;
    entries.push(entry(ctx, { code, fn: f.id, material: m.id, kind: 'structure' }, label, level, f.rarity ?? 'common', JOB_MATERIALS.includes(m.id)));
  };
  for (const f of structure) for (const m of mats) if (natural(m)) addStructure(f, m);
  // Then every model, in catalog order
  for (const f of fns.filter((x) => x.model && !x.exclusive)) {
    const code = allocateCode(f.name ?? f.id, used);
    entries.push(entry(ctx, { code, fn: f.id, material: f.material ?? 'alloy', kind: 'model' }, f.name ?? f.id, f.unlock?.level ?? 99, f.rarity ?? 'common'));
  }
  for (const f of structure) for (const m of mats) if (!natural(m)) addStructure(f, m);
  const byCode = new Map(entries.map((e) => [e.code, e]));
  const byFn = new Map(entries.map((e) => [`${e.fn}|${e.material}`, e]));
  const legend: Legend = { entries, byCode, find: (fn, material) => byFn.get(`${fn}|${material}`) };
  legends.set(ctx, legend);
  return legend;
}

function entry(ctx: ShipgenContext, def: CodeDef, name: string, level: number, rarity: string, job = false): LegendEntry {
  const fn = ctx.catalog.functions.get(def.fn)!;
  const pieces = fn.pieces === '*' ? ctx.catalog.pieceIds : fn.pieces;
  const power = partPower(ctx, fn, pieces[0], def.material);
  const e: LegendEntry = { ...def, name, level, rarity, ...(job ? { job } : {}), pieces: [...pieces], facing: partFacingRule(def.fn), power, line: '' };
  e.line = legendLine(ctx, e, fn);
  return e;
}

/** "2x1" (a box piece), "1x1 wedge t1-t4" (a shaped one: its letter and shape digits) */
export function pieceWords(ctx: ShipgenContext, piece: string): string {
  const v = getVariant(ctx.catalog, piece, 0, false), s = pieceShapes(ctx.catalog, piece);
  const xs = v.cells.map((c) => c[0]), ys = v.cells.map((c) => c[1]);
  const size = `${Math.max(...xs) - Math.min(...xs) + 1}x${Math.max(...ys) - Math.min(...ys) + 1}`;
  if (s.box) return size;
  const tag = s.letter ?? '';
  return `${size} ${piece} shape ${tag}1-${tag}${s.classes.length}`;
}

const num = (v: number) => (Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10);

/** What a part does with power, in few words ("E" is energy, "/s" per second: the legend's header says so) */
function powerWords(p: PartPower, facing: LegendEntry['facing']): string {
  switch (p.role) {
    case 'generator': return `GEN makes ${num(p.makes!)}E/s`;
    case 'dynamo': return `DYNAMO tops up stores ${num(p.makes!)}E/s`;
    case 'store': return `STORE holds ${num(p.holds!)}E, gives ${num(p.gives!)}/s, takes ${num(p.takes!)}/s`;
    case 'conduit': return `CONDUIT ${num(p.gives!)}/s between touching parts, both ways`;
    case 'diode': return `DIODE one way, out of its mark${facing === 'joined' ? ' (that side must touch a part)' : ''}, ${num(p.gives!)}/s`;
    case 'core': return `CORE store: holds ${num(p.holds!)}E, gives ${num(p.gives!)}/s`;
    case 'weapon': return `uses ${num(p.uses!)}E/s (${p.gun})`;
    case 'thruster': return `uses ${num(p.uses!)}E/s${p.boostUses ? ` (${num(p.boostUses)} boosting)` : ''}`;
    case 'tool': return `uses ${num(p.uses!)}E/s`;
    default: return '';
  }
}

/** One legend line: code, name, then size, facing, mounting, power and the numbers that matter. No prose. */
function legendLine(ctx: ShipgenContext, e: LegendEntry, fn: FunctionDef): string {
  const parts: string[] = [];
  const isStructure = e.kind === 'structure';
  if (!isStructure) parts.push(e.pieces.map((p) => pieceWords(ctx, p)).join(' or '));
  if (e.facing === 'free') parts.push('face');
  else if (e.facing === 'joined') parts.push('face (out side)');
  const mw = mountingWords(ctx.catalog, fn, ctx.tuning)
    .filter((w) => !/^Mounts anywhere$|^Bolts on any side$/.test(w))
    .map((w) => w.replace(/^Fixed: aims with the ship$/, 'fixed').replace(/ clear cells? ahead/, ' clear ahead').replace(/^Bolts on /, 'bolts on '));
  if (mw.length) parts.push(mw.join(', '));
  if (!isStructure) { const pw = powerWords(e.power, e.facing); if (pw) parts.push(pw); }
  const d = describePart(ctx.catalog, ctx.tuning, { fn: e.fn, material: e.material, piece: e.pieces[0] });
  if (d) {
    const b = d.base, stats: string[] = [];
    if (b.dps) stats.push(`${num(b.dps)}dps`);
    if (b.range) stats.push(`r${num(b.range)}`);
    if (b.thrust) stats.push(`thrust ${num(b.thrust)}${b.boost && b.boost > 1 ? `x${num(b.boost)}` : ''}`);
    if (b.shield) stats.push(`shield ${num(b.shield)}`);
    if (b.cargo) stats.push(`cargo ${num(b.cargo)}`);
    if (b.heal) stats.push(`heals ${num(b.heal)}/s`);
    stats.push(`hp${num(b.hp)}`, `m${num(b.mass)}`);
    if (b.armour > 1) stats.push(`ar${num(b.armour)}`);
    parts.push(stats.join(' '));
  }
  return `${e.code} ${e.name}: ${parts.join(', ')}`;
}

/** The entries a tier band allows (the game's own licensing: see partInBand) */
export function legendFor(legend: Legend, band: TierBand): LegendEntry[] {
  return legend.entries.filter((e) => partInBand(e, band));
}

const DEFAULT_RARITIES = ['common', 'uncommon', 'rare', 'epic'];

/**
 * May a design of this band carry this part: the game's own licensing (econ partLicensed: a model at its unlock level, a
 * structure by its material's level, the core with its licence, a job's material with the job's) at the band's level, a
 * model of an allowed rarity, and the band's include/exclude lists
 */
export function partInBand(p: { fn: string; material: string }, band: TierBand): boolean {
  if (band.include?.includes(p.fn)) return true;
  if (band.exclude?.includes(p.fn)) return false;
  const fn = registeredFunction(p.fn);
  if (!fn) return false;
  const learned = ['fn:core', ...(band.jobMaterials ? JOB_MATERIALS.map((m) => `material:${m}`) : [])];
  if (!partLicensed({ fn: p.fn, material: p.material }, learned, band.maxLevel)) return false;
  return !fn.model || (band.rarities ?? DEFAULT_RARITIES).includes(fn.rarity ?? 'common');
}

/** The legend as the model reads it: structure (one line a function, a code a material), then by power role */
export function legendText(entries: LegendEntry[]): string {
  const out: string[] = ['(E = energy, /s = per second, hp = hit points, m = mass, ar = armour, r = range. "face" = needs a ^ > v < mark, and the cell it faces left free)'];
  const structure = entries.filter((e) => e.kind === 'structure');
  if (structure.length) {
    out.push('# Structure: any shape. One line a part, a code a material');
    const fns = [...new Set(structure.map((e) => e.fn))];
    for (const f of fns) {
      const es = structure.filter((e) => e.fn === f);
      const core = es[0].power.role === 'core';
      const mat = (e: LegendEntry) => /\((.*)\)$/.exec(e.name)?.[1] ?? e.material;
      const base = es[0].name.replace(/ \(.*\)$/, '');
      out.push(`${base}${core ? ` (${powerWords(es[0].power, null)})` : ' (no power)'}: ${es.map((e) => `${e.code} ${mat(e)} ${e.line.slice(e.line.indexOf(': ') + 2)}`).join('; ')}`);
    }
  }
  const groups: [string, (e: LegendEntry) => boolean][] = [
    ['Power: generators, stores, conduits, diodes', (e) => ['generator', 'store', 'conduit', 'diode', 'dynamo'].includes(e.power.role)],
    ['Engines and thrusters', (e) => e.power.role === 'thruster'],
    ['Weapons', (e) => e.power.role === 'weapon'],
    ['Tools, shields and the rest', () => true],
  ];
  const done = new Set<LegendEntry>(structure);
  for (const [title, test] of groups) {
    const list = entries.filter((e) => !done.has(e) && test(e));
    if (!list.length) continue;
    out.push(`# ${title}`);
    for (const e of list) { done.add(e); out.push(e.line); }
  }
  return out.join('\n');
}
