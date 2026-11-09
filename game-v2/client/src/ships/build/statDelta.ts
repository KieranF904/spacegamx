/**
 * @contract client.ships.build.stat-delta
 * owns:       what placing the part in hand, or removing the part under the cursor, would change on the ship: mass, acceleration,
 *             top speed, turn, power made against drawn, shield, hull, firepower, build points and cost; the memo that keeps hovering
 *             cheap; which change the cursor means (changeFor). Pure: designs in, numbers and tones out
 * needs:      shipSummary (the hangar's own derivation, one derive per design), common validateBlueprint / buildPoints / buyPrice
 *             (npm: @space-game/common); no DOM, no editor state
 * invariants: a part that joins nothing (not connected) lists no ship stat, only build points and cost — client/src/ships/build/statDelta.test.ts
 *             better and worse follow each stat's direction (a lighter ship is better, extra mass amber) — client/src/ships/build/statDelta.test.ts
 *             the same design and change are derived once, then served from the memo — client/src/ships/build/statDelta.test.ts
 *             a change that does nothing visible lists no line — client/src/ships/build/statDelta.test.ts
 * extend:     a new stat is one entry in STATS below (how to read it from a Measure, its direction and its text)
 */

import { buildPoints, buyPrice, validateBlueprint } from '@space-game/common';
import type { Blueprint, Catalog, Economy, PlacedPart, ShipDerived, ShipTuning } from '@space-game/common';
import { shipSummaryWithDerived, type ShipSummary } from '../shipSummary';

export interface StatCtx { catalog: Catalog; tuning: ShipTuning; econ: Economy }

/** What the cursor means to do: put a part in, or take one out */
export type Change = { kind: 'add'; part: PlacedPart; label: string } | { kind: 'remove'; uid: number; label: string };

/** A design read for the deltas */
export interface Measure {
  summary: ShipSummary | null;
  /** Energy per second the generators make, and what the consumers draw flat out; generators counted */
  made: number;
  drawn: number;
  gens: number;
  points: number;
  /** Credits at station prices for the raw materials of every part but the core */
  cost: number;
}

export type Tone = 'good' | 'bad' | 'flat';

export interface DeltaLine {
  key: string;
  label: string;
  before: number;
  after: number;
  /** The change in words ("+12 m/s", "-3") */
  text: string;
  tone: Tone;
}

export interface StatDelta {
  kind: Change['kind'];
  label: string;
  lines: DeltaLine[];
  /** Added part joins nothing: it changes no ship stat until something joins it */
  loose: boolean;
  /** Removing it leaves this many other parts unconnected */
  cutOff: number;
  /** "N generators short" when the power ends up negative */
  powerNote: string | null;
  /** The ship won't derive (no core) or the like */
  note: string | null;
}

const MINUS = '−';

function signed(v: number, digits: number): string {
  const f = Math.abs(v).toLocaleString('en-GB', { maximumFractionDigits: digits, minimumFractionDigits: digits });
  return `${v < 0 ? MINUS : '+'}${f}`;
}

interface StatDef {
  key: string;
  label: string;
  read(m: Measure): number | null;
  /** Is a bigger number better (null: neither; cost is what it is) */
  bigger: boolean | null;
  digits: number;
  unit: string;
}

const sum = (m: Measure, k: keyof ShipSummary) => (m.summary ? (m.summary[k] as number) : null);

/** The stats, in the order the card lists them */
export const STATS: StatDef[] = [
  { key: 'mass', label: 'Mass', read: (m) => sum(m, 'mass'), bigger: false, digits: 1, unit: '' },
  { key: 'accel', label: 'Acceleration', read: (m) => sum(m, 'accel'), bigger: true, digits: 0, unit: ' m/s²' },
  { key: 'topSpeed', label: 'Top speed', read: (m) => sum(m, 'topSpeed'), bigger: true, digits: 0, unit: ' m/s' },
  { key: 'turn180', label: 'Turn 180°', read: (m) => sum(m, 'turn180'), bigger: false, digits: 1, unit: ' s' },
  { key: 'power', label: 'Power net', read: (m) => (m.summary ? m.made - m.drawn : null), bigger: true, digits: 0, unit: '/s' },
  { key: 'shield', label: 'Shield', read: (m) => sum(m, 'shield'), bigger: true, digits: 0, unit: '' },
  { key: 'hull', label: 'Hull', read: (m) => sum(m, 'hull'), bigger: true, digits: 0, unit: ' hp' },
  { key: 'dps', label: 'Firepower', read: (m) => sum(m, 'dps'), bigger: true, digits: 0, unit: ' dmg/s' },
  { key: 'points', label: 'Build points', read: (m) => m.points, bigger: false, digits: 0, unit: '' },
  { key: 'cost', label: 'Cost', read: (m) => m.cost, bigger: null, digits: 0, unit: ' cr' },
];

/** These two are about the bill and survive a loose part */
const BILL_KEYS = new Set(['points', 'cost']);

/** A design read: one derive, plus the bill */
export function measure(ctx: StatCtx, bp: Blueprint): Measure {
  const { catalog, tuning, econ } = ctx;
  const full = shipSummaryWithDerived(catalog, tuning, econ, bp);
  const flow = full ? flowOf(full.derived) : { made: 0, drawn: 0, gens: 0 };
  let cost = 0;
  const bill = econ.rebuildBill(bp.parts.filter((q) => q.fn !== 'core'));
  for (const [id, n] of Object.entries(bill)) cost += buyPrice(econ.items, id) * n;
  return { summary: full?.summary ?? null, ...flow, points: buildPoints(catalog, bp), cost };
}

/** Power made and drawn flat out, as the hangar's power panel counts them (ports design; else the older pools) */
export function flowOf(d: ShipDerived): { made: number; drawn: number; gens: number } {
  const L = d.ports;
  if (L) return { made: L.supply, drawn: L.weaponDraw + L.engineDraw + L.strafeDraw + L.gyroDraw + L.shieldDraw, gens: L.gens.length };
  return { made: d.networks.reduce((t, n) => t + n.supply, 0), drawn: d.networks.reduce((t, n) => t + n.demand, 0), gens: 0 };
}

/** The design with the change made */
export function applied(bp: Blueprint, change: Change): Blueprint {
  return { ...bp, parts: change.kind === 'add' ? [...bp.parts, change.part] : bp.parts.filter((p) => p.uid !== change.uid) };
}

/** The deltas between two measures. `budget`: build points the pilot may spend (undefined: no limit shown) */
export function diffMeasures(before: Measure, after: Measure, change: Change, opts: { loose?: boolean; cutOff?: number; budget?: number } = {}): StatDelta {
  const loose = !!opts.loose;
  const out: StatDelta = { kind: change.kind, label: change.label, lines: [], loose, cutOff: opts.cutOff ?? 0, powerNote: null, note: null };
  if (!after.summary && !loose) out.note = change.kind === 'add' ? 'The ship would not build.' : 'Without it the ship would not build.';
  for (const s of STATS) {
    if (loose && !BILL_KEYS.has(s.key)) continue;
    const a = s.read(before), b = s.read(after);
    if (a === null || b === null) continue;
    const line = lineOf(s, a, b, s.key === 'points' ? opts.budget : undefined);
    if (line) out.lines.push(line);
  }
  if (!loose && after.summary && after.made - after.drawn < -0.5) {
    const per = after.gens > 0 ? after.made / after.gens : 0;
    const short = after.drawn - after.made;
    if (per > 0) { const n = Math.ceil(short / per - 1e-9); out.powerNote = `${n} generator${n === 1 ? '' : 's'} short`; }
    else out.powerNote = 'no generator to run it';
  }
  return out;
}

function lineOf(s: StatDef, a: number, b: number, budget: number | undefined): DeltaLine | null {
  // (A ship that can't turn has an endless turn time: say so rather than a number)
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    if (Number.isFinite(a) === Number.isFinite(b)) return null;
    return { key: s.key, label: s.label, before: a, after: b, text: Number.isFinite(b) ? 'can turn' : "can't turn", tone: Number.isFinite(b) ? 'good' : 'bad' };
  }
  const diff = b - a;
  const text = signed(diff, s.digits);
  if (/^[+−]0(\.0*)?$/.test(text)) return null;
  let tone: Tone = s.bigger === null ? 'flat' : (diff > 0) === s.bigger ? 'good' : 'bad';
  // (Points: cheap or dear is neither; going over the budget is bad)
  if (s.key === 'points') tone = budget !== undefined && b > budget ? 'bad' : 'flat';
  return { key: s.key, label: s.label, before: a, after: b, text: text + s.unit, tone };
}

/** The change a cursor means: a part in hand that can go here adds it; otherwise a standing part under the cursor would be removed. null: nothing */
export function changeFor(opts: { candidate: PlacedPart | null; problem: string | null; under: PlacedPart | null; name: (p: PlacedPart) => string }): Change | null {
  const { candidate, problem, under, name } = opts;
  if (candidate && !problem) return { kind: 'add', part: candidate, label: name(candidate) };
  if (under && under.fn !== 'core') return { kind: 'remove', uid: under.uid, label: name(under) };
  return null;
}

/** A key naming a change (with the design's revision, the memo's key) */
export function changeKey(c: Change): string {
  if (c.kind === 'remove') return `r${c.uid}`;
  const p = c.part;
  return `a${p.piece}|${p.fn}|${p.material}|${p.x},${p.y}|${p.rot}|${p.flip ? 1 : 0}|${p.facing ?? ''}`;
}

/** Derives the design with and without a change, memoised: the design (by revision) once, each change once */
export class DeltaCache {
  private beforeKey = '';
  private before: Measure | null = null;
  private memo = new Map<string, StatDelta>();
  /** How long the last fresh derive took (ms): a caller may debounce when it is slow */
  lastMs = 0;
  /** Fresh derives made (for tests) */
  derives = 0;

  constructor(private ctx: () => StatCtx, private max = 48) {}

  peek(rev: string, change: Change): StatDelta | undefined {
    return this.memo.get(`${rev}#${changeKey(change)}`);
  }

  get(rev: string, bp: Blueprint, change: Change, budget?: number): StatDelta {
    const key = `${rev}#${changeKey(change)}`;
    const hit = this.memo.get(key);
    if (hit) { this.memo.delete(key); this.memo.set(key, hit); return hit; }
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const ctx = this.ctx();
    if (this.beforeKey !== rev || !this.before) {
      this.before = measure(ctx, bp); this.beforeKey = rev; this.memo.clear(); this.derives++;
    }
    const next = applied(bp, change);
    const after = measure(ctx, next);
    this.derives++;
    let loose = false, cutOff = 0;
    try {
      const was = validateBlueprint(ctx.catalog, bp, ctx.tuning, null).unreachable;
      const now = validateBlueprint(ctx.catalog, next, ctx.tuning, null).unreachable;
      if (change.kind === 'add') loose = now.includes(change.part.uid);
      else cutOff = Math.max(0, now.length - was.length);
    } catch { /* an invalid design: the stats say what they can */ }
    const d = diffMeasures(this.before, after, change, { loose, cutOff, budget });
    this.memo.set(key, d);
    if (this.memo.size > this.max) this.memo.delete(this.memo.keys().next().value as string);
    this.lastMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    return d;
  }
}
