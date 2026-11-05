// check(bp): everything the generator tells a model about a design. The rules are the game's validateBlueprint (its
// messages, pointed at grid cells); power is the touch-routed core run flat out (sim.ts); stats come from rebuild and the
// recipes; taste is scores.ts. Nothing here knows a part by name.
import type { Blueprint, PlacedPart } from '../../../common/src/ships/index';
import {
  ROLE_RELAY, ROLE_THRUSTER, ROLE_TOOL, ROLE_WEAPON, ROLE_GEN, ROLE_DYNAMO, blueprintGeometry, fromEu, isEngine, partMass, validateBlueprint,
} from '../../../common/src/ships/index';
import { partItemId } from '../../../common/src/econ/index';
import type { ShipgenContext } from './context';
import { CodeBook, partAt } from './grid';
import { type ShipEnergy, runEnergy, shipEnergy } from './sim';
import { type DesignScores, designScores } from './scores';

export interface PartRef {
  uid: number;
  code: string;
  name: string;
  /** Its first cell on the grid */
  row: number;
  col: number;
}

export interface CheckError {
  /** The validator's error code */
  code: string;
  message: string;
  /** The part it is about (one part), and where */
  part?: PartRef;
  row?: number;
  col?: number;
}

export interface ConsumerPower extends PartRef {
  kind: 'weapon' | 'thruster' | 'tool';
  /** Touches a source (a generator, store, conduit, diode or the core) */
  fed: boolean;
  /** Its sources reach a generator or dynamo */
  linked: boolean;
  /** % of what it could do with unlimited power over the run (weapons: shots or beam time; thrusters: thrust; tools: supply); 0 when nothing feeds it */
  pct: number;
  /** The same over the long run (sustained: once the stores have run down) */
  pctLong: number;
}

export interface PowerReport {
  consumers: ConsumerPower[];
  /** Sustained fire % per weapon (10 s, every gun firing, engines cruising) */
  weapons: ConsumerPower[];
  thrust: { cruisePct: number; boostPct: number; othersPct: number | null };
  /** Relays that gave all they can give (Gives-limited) or ran empty in most of the run */
  bottlenecks: (PartRef & { limitedPct: number; emptyPct: number })[];
  unpowered: PartRef[];
  /** E/s made, E stored */
  generation: number;
  storage: number;
}

export interface CheckStats {
  parts: number;
  cells: number;
  width: number;
  height: number;
  mass: number;
  /** Credits (recipe value of every part), when the data has recipes */
  cost: number | null;
  /** Forward thrust / mass */
  thrustToMass: number;
  generation: number;
}

export interface CheckResult {
  valid: boolean;
  errors: CheckError[];
  power: PowerReport | null;
  stats: CheckStats;
  scores: DesignScores & { power: number; fit: number | null };
  /** The role's targets (CheckOptions.targets) against the ship: what each measured, and how far it got (1: met) */
  fit: FitItem[];
  /** 0..100 */
  score: number;
}

export interface FitItem { key: string; value: number; target: number; share: number; words: string }

/** What a role's targets may name: a measure of the ship (0..) that is good when it is at least the target */
export const FIT_WORDS: Record<string, string> = {
  weaponShare: 'share of the cells that are guns', cargoShare: 'share of the cells that are cargo', thrustToMass: 'thrust for its mass',
  generationPerCell: 'E/s made per cell', armourShare: 'share of the cells that are armour',
};

export interface CheckOptions {
  /** The role's targets (roles.json targets: weaponShare, cargoShare, thrustToMass, generationPerCell, armourShare): the fit score is how far each is met */
  targets?: Record<string, number>;
  /** Seconds to run the power core (default 10), and the long run that shows what it sustains (default 60) */
  seconds?: number;
  longSeconds?: number;
  /** Score weights (default: DEFAULT_WEIGHTS) */
  weights?: Partial<Record<keyof CheckResult['scores'], number>>;
  /** Codes for messages (the grid's own book, so a design's key codes read the same) */
  book?: CodeBook;
  /** Check mounting rules (default true: a new design must keep them) */
  mounting?: boolean;
}

export const DEFAULT_WEIGHTS: Record<keyof CheckResult['scores'], number> = {
  // (Power first; then what the role is for (fit) and whether the ship is mostly ship, not power plant (lean); the
  // placement terms are near 1 on any finished design, so they weigh less; the outline terms are taste)
  power: 0.3, fit: 0.2, lean: 0.1, symmetry: 0.15, armourOutside: 0.1, enginesAft: 0.1, gunsOut: 0.1, compactness: 0.05,
  silhouette: 0.05,
};

const pct = (a: number, b: number) => (b > 0 ? Math.round(Math.min(1, a / b) * 1000) / 10 : 0);

export function check(ctx: ShipgenContext, bp: Blueprint, opts: CheckOptions = {}): CheckResult {
  const { catalog, tuning } = ctx;
  const book = opts.book ?? new CodeBook(ctx);
  const byUid = new Map(bp.parts.map((p) => [p.uid, p]));
  const ref = (p: PlacedPart): PartRef => {
    const fn = catalog.functions.get(p.fn);
    let code = '??';
    try { code = book.codeFor(p).code; } catch { /* (an unknown function has no code) */ }
    return { uid: p.uid, code, name: fn?.name ?? p.fn, ...partAt(ctx, p) };
  };

  // ---- Rules: the game's validator, its messages pointed at cells
  const v = validateBlueprint(catalog, bp, tuning, null, { mounting: opts.mounting !== false });
  const errors: CheckError[] = v.errors.map((e) => friendlyError(e.code, e.message, e.uids.map((u) => byUid.get(u)).filter((p): p is PlacedPart => !!p), ref));

  // ---- Power: the core run flat out, against the same graph with unlimited power
  let power: PowerReport | null = null, se: ShipEnergy | null = null;
  try { se = shipEnergy(ctx, bp); } catch { se = null; }
  if (se) power = powerReport(se, bp, ref, opts.seconds ?? 10, Math.max(opts.seconds ?? 10, opts.longSeconds ?? 60));

  // ---- Stats
  const geoms = (() => { try { return blueprintGeometry(catalog, bp); } catch { return null; } })();
  const cellSet = new Set<string>();
  for (const g of geoms ?? []) for (const c of g.cells) cellSet.add(`${c[0]},${c[1]}`);
  const xs = [...cellSet].map((k) => Number(k.split(',')[0])), ys = [...cellSet].map((k) => Number(k.split(',')[1]));
  let mass = 0;
  for (const p of bp.parts) { try { mass += partMass(catalog, p); } catch { /* (unknown part) */ } }
  let cost: number | null = null;
  if (ctx.econ) {
    cost = 0;
    for (const p of bp.parts) { try { cost += ctx.econ.recipes.partValue(partItemId(p), ctx.econ.items); } catch { /* (no recipe) */ } }
    cost = Math.round(cost);
  }
  const d = se?.derived;
  const stats: CheckStats = {
    parts: bp.parts.length, cells: cellSet.size,
    width: xs.length ? Math.max(...xs) - Math.min(...xs) + 1 : 0, height: ys.length ? Math.max(...ys) - Math.min(...ys) + 1 : 0,
    mass: Math.round(mass * 10) / 10, cost,
    thrustToMass: d && d.fullMass > 0 ? Math.round((d.maxThrust.forward / d.fullMass) * 1000) / 1000 : 0,
    generation: power?.generation ?? 0,
  };

  // ---- Scores
  const taste = geoms ? designScores(ctx, bp, geoms) : { symmetry: 0, armourOutside: 0, enginesAft: 0, gunsOut: null, compactness: 0, lean: 0, silhouette: null };
  const consumers = power?.consumers ?? [];
  const powerScore = consumers.length ? consumers.reduce((s, c) => s + (c.linked ? (c.pct + c.pctLong) / 200 : 0), 0) / consumers.length : 0;
  const fit = fitItems(ctx, bp, geoms ?? [], stats, opts.targets);
  const scores = { ...taste, power: Math.round(powerScore * 1000) / 1000, fit: fit.length ? Math.round((fit.reduce((a, f) => a + f.share, 0) / fit.length) * 1000) / 1000 : null };
  const w = { ...DEFAULT_WEIGHTS, ...opts.weights };
  let sum = 0, wsum = 0;
  for (const k of Object.keys(w) as (keyof typeof w)[]) {
    const s = scores[k];
    if (s === null || s === undefined || !(w[k] > 0)) continue;
    sum += w[k] * s; wsum += w[k];
  }
  const base = wsum > 0 ? sum / wsum : 0;
  const score = Math.round((v.ok ? base : base * 0.3) * 1000) / 10;
  return { valid: v.ok, errors, power, stats, scores, fit, score };
}

/** Each target measured on the ship: value, target and the share met (capped at 1) */
function fitItems(ctx: ShipgenContext, bp: Blueprint, geoms: { cells: [number, number][] }[], stats: CheckStats, targets?: Record<string, number>): FitItem[] {
  if (!targets || !stats.cells) return [];
  const cellsOf = (pick: (fn: NonNullable<ReturnType<typeof ctx.catalog.functions.get>>, fnId: string) => boolean) =>
    bp.parts.reduce((a, p, i) => { const fn = ctx.catalog.functions.get(p.fn); return fn && pick(fn, p.fn) ? a + (geoms[i]?.cells.length ?? 0) : a; }, 0);
  const measure: Record<string, () => number> = {
    weaponShare: () => cellsOf((fn) => !!fn.weapon) / stats.cells,
    cargoShare: () => cellsOf((_fn, id) => id === 'cargo') / stats.cells,
    armourShare: () => cellsOf((_fn, id) => id === 'armor') / stats.cells,
    thrustToMass: () => stats.thrustToMass,
    generationPerCell: () => stats.generation / stats.cells,
  };
  const out: FitItem[] = [];
  for (const [key, target] of Object.entries(targets)) {
    const m = measure[key];
    if (!m || !(target > 0)) continue;
    const value = Math.round(m() * 1000) / 1000;
    out.push({ key, value, target, share: Math.min(1, Math.round((value / target) * 1000) / 1000), words: FIT_WORDS[key] ?? key });
  }
  return out;
}

function powerReport(se: ShipEnergy, bp: Blueprint, ref: (p: PlacedPart) => PartRef, seconds: number, longSeconds: number): PowerReport {
  const L = se.L, fns = se.input.fns;
  // (One long run each, its totals kept at `seconds` too; each against the same graph with unlimited power)
  const cruise = { seconds: longSeconds, earlyAt: seconds, guns: true, engines: 'cruise' as const, others: false };
  const boost = { ...cruise, seconds, engines: 'boost' as const };
  const others = { ...cruise, guns: false, engines: 'off' as const, others: true };
  const [rc, ic] = [runEnergy(se, cruise), runEnergy(se, cruise, true)];
  const [rb, ib] = [runEnergy(se, boost), runEnergy(se, boost, true)];
  const hasOthers = Array.from(L.role).some((r, p) => r === ROLE_THRUSTER && !isEngine(fns[p]));
  const [ro, io] = hasOthers ? [runEnergy(se, others), runEnergy(se, others, true)] : [null, null];
  const ec = rc.early!, eic = ic.early!;

  const consumers: ConsumerPower[] = [];
  let eng = 0, engI = 0, bst = 0, bstI = 0, oth = 0, othI = 0;
  for (let p = 0; p < L.n; p++) {
    const r = L.role[p];
    if (r !== ROLE_WEAPON && r !== ROLE_THRUSTER && r !== ROLE_TOOL) continue;
    const fed = !!L.fed[p], base = { ...ref(bp.parts[p]), fed, linked: !!L.linked[p] };
    // (Nothing feeding it: it runs only on what it starts with, as it would with unlimited power: 0)
    const two = (a: Float64Array, ai: Float64Array, b: Float64Array, bi: Float64Array) => (fed ? { pct: pct(a[p], ai[p]), pctLong: pct(b[p], bi[p]) } : { pct: 0, pctLong: 0 });
    if (r === ROLE_WEAPON) consumers.push({ ...base, kind: 'weapon', ...two(ec.fired, eic.fired, rc.fired, ic.fired) });
    else if (r === ROLE_TOOL) consumers.push({ ...base, kind: 'tool', ...two(ec.sat, eic.sat, rc.sat, ic.sat) });
    else if (isEngine(fns[p])) {
      if (fed) { eng += ec.thrust[p]; bst += rb.thrust[p]; }
      engI += eic.thrust[p]; bstI += ib.thrust[p];
      consumers.push({ ...base, kind: 'thruster', ...two(ec.thrust, eic.thrust, rc.thrust, ic.thrust) });
    } else {
      const eo = ro!.early!, eio = io!.early!;
      if (fed) oth += eo.thrust[p];
      othI += eio.thrust[p];
      consumers.push({ ...base, kind: 'thruster', ...two(eo.thrust, eio.thrust, ro!.thrust, io!.thrust) });
    }
  }
  const bottlenecks: PowerReport['bottlenecks'] = [];
  let storage = 0, generation = 0;
  for (let p = 0; p < L.n; p++) {
    if (L.role[p] === ROLE_GEN || L.role[p] === ROLE_DYNAMO) generation += fromEu(L.rate[p]) * 60;
    if (L.role[p] !== ROLE_RELAY) continue;
    storage += fromEu(L.cap[p]);
    const limitedPct = pct(rc.limited[p], rc.ticks), emptyPct = pct(rc.empty[p], rc.ticks);
    // (Over the long run: a relay that empties or gives flat out most of the time is where power runs short)
    if (limitedPct >= 30 || emptyPct >= 50) bottlenecks.push({ ...ref(bp.parts[p]), limitedPct, emptyPct });
  }
  return {
    consumers,
    weapons: consumers.filter((c) => c.kind === 'weapon'),
    thrust: { cruisePct: pct(eng, engI), boostPct: pct(bst, bstI), othersPct: hasOthers ? pct(oth, othI) : null },
    bottlenecks,
    unpowered: consumers.filter((c) => !c.linked).map(({ uid, code, name, row, col }) => ({ uid, code, name, row, col })),
    generation: Math.round(generation * 10) / 10,
    storage: Math.round(storage),
  };
}

const HINTS: Partial<Record<string, string>> = {
  overlap: 'two parts cover the same cell: move one',
  unreachable: 'every part must touch the rest of the ship (share a full edge) back to the core',
  facingMissing: 'it needs a facing mark (^ > v <) towards a straight edge of its piece',
  facingBlocked: 'nothing may sit across the edge it faces: put it on the outside, or turn it',
  facingNotJoined: "a Diode's out side (its mark) must touch the part it feeds",
  coreCount: 'a ship has exactly one core',
  functionNotAllowed: "that part doesn't come in that shape",
  exclusive: "that part isn't for pilots' ships",
  badMounting: 'see the legend for how this weapon must be mounted',
  tooManyParts: 'use fewer, bigger parts',
};

/** A validator error, its uids replaced by "Name (CODE at row r col c)" */
function friendlyError(code: string, message: string, parts: PlacedPart[], ref: (p: PlacedPart) => PartRef): CheckError {
  const refs = parts.map(ref);
  const label = (r: PartRef) => `${r.name} (${r.code} at row ${r.row} col ${r.col})`;
  let msg = message;
  for (const [i, p] of parts.entries()) {
    msg = msg.replace(new RegExp(`\\b${p.fn} ${p.uid}\\b`), label(refs[i]));
  }
  if (refs.length === 2) msg = msg.replace(new RegExp(`parts ${parts[0].uid} and ${parts[1].uid}`), `${label(refs[0])} and ${label(refs[1])}`);
  if (code === 'unreachable') msg = `${refs.length} part(s) not connected to the core: ${refs.slice(0, 6).map(label).join(', ')}${refs.length > 6 ? ', ...' : ''}`;
  else if (refs.length === 1 && !msg.includes(label(refs[0]))) {
    // (mounting's messages start "Pip 3: ...", the rest "part 3 ...": the label says which part)
    const esc = refs[0].name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    msg = `${label(refs[0])}: ${msg.replace(new RegExp(`^(part |${esc} )?${parts[0].uid}\\b:? ?`), '')}`;
  }
  const hint = HINTS[code];
  return { code, message: hint ? `${msg} (${hint})` : msg, ...(refs.length === 1 ? { part: refs[0], row: refs[0].row, col: refs[0].col } : {}) };
}
