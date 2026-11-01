// Staged build: start from a valid skeleton (a core and a small, symmetric hull frame sized to the brief) and ask for
// one system a step: power, then weapons, then engines, then armour. A step is accepted only when the ship is still
// valid, keeps every part placed before, and has what the step asked for; otherwise the check goes back to the model
// and it tries that step again. A step that runs out of tries leaves the ship as it was and the build moves on.
// The steps are a registry (STEPS): each says what it asks for and what a ship still lacks for it, from the role.
import type { Blueprint, PlacedPart } from '../../../common/src/ships/index';
import { isEngine, placeGeometry } from '../../../common/src/ships/index';
import {
  type CheckResult, type Concept, type DecodeResult, type Role, type Selector, type ShipgenContext,
  CodeBook, outlineFit, outlinePicture, shipRows, briefLegend, briefText, buildLegend, check, coreLeftEdge, exposedCorners, halfOf, matches, mergeParts, outlineShapes, partAt, partKey, partPower, silhouetteScore, squareCornerWords, systemPrompt,
} from '../core/index';
import { type Attempt, type DesignOptions, type DesignOutcome, type LoopDeps, Session, better, contractFor, passes } from './design';
import type { Emit } from './events';
import type { ChatMessage } from './llm';

type PR = 'generator' | 'store' | 'weapon' | 'engine';

/** The most a role requires (or encourages) of a power role (or function) */
function wants(role: Role | undefined, sel: { role?: PR; fn?: string }, encourage = false): number {
  const list = [...(role?.require ?? []), ...(encourage ? role?.encourage ?? [] : [])];
  let n = 0;
  for (const s of list) {
    const roles = s.role === undefined ? [] : Array.isArray(s.role) ? s.role : [s.role];
    const fns = s.fn === undefined ? [] : Array.isArray(s.fn) ? s.fn : [s.fn];
    if ((sel.role && roles.includes(sel.role)) || (sel.fn && fns.includes(sel.fn))) n = Math.max(n, s.min ?? 1);
  }
  return n;
}

const count = (ctx: ShipgenContext, bp: Blueprint, sel: Selector) => bp.parts.filter((p) => matches(ctx, sel, p)).length;

export interface StepContext {
  ctx: ShipgenContext;
  role?: Role;
  mirror: boolean;
  /** The concept the build follows: its outline is what the armour step fills */
  concept?: Concept;
}

export interface Step {
  id: string;
  title: string;
  /** What to add, in words */
  ask(s: StepContext): string;
  /** What a built ship still lacks for this step (empty: done). `prev`: the ship as the step found it, for a step judged against it */
  lacks(s: StepContext, bp: Blueprint, r: CheckResult, prev?: { bp: Blueprint; r: CheckResult }): string[];
  /** Parts of the ship so far this step may replace (default: the frame's hull) */
  replaces?: (p: PlacedPart) => boolean;
  /** More lines for the step's ask, from the ship so far */
  extra?(s: StepContext, bp: Blueprint): string[];
  /** What counts as a part of the kind this step asks for: a step is accepted only if it added at least one */
  adds?: (ctx: ShipgenContext, p: PlacedPart) => boolean;
  /** Cells worth suggesting: free cells touching these power roles (and, for facing parts, with a clear lane that way) */
  near?: { roles: string[]; lane?: 'N' | 'S' };
}

const isPower = (ctx: ShipgenContext, p: PlacedPart, role: string) => { const fn = ctx.catalog.functions.get(p.fn); return !!fn && partPower(ctx, fn, p.piece, p.material).role === role; };

/** Parts of `after` that `before` doesn't have (same part, same place), counted as a multiset */
export function addedParts(ctx: ShipgenContext, before: Blueprint, after: Blueprint): PlacedPart[] {
  const left = new Map<string, number>();
  for (const p of before.parts) { const k = partKey(ctx, p); left.set(k, (left.get(k) ?? 0) + 1); }
  const out: PlacedPart[] = [];
  for (const p of after.parts) { const k = partKey(ctx, p), n = left.get(k) ?? 0; if (n > 0) left.set(k, n - 1); else out.push(p); }
  return out;
}

/** The engines step's extra lines: the count in the whole ship, the exact legal cells aft, and what to do when there are too few */
export function engineHelp(s: StepContext, bp: Blueprint): string[] {
  const need = Math.max(2, wants(s.role, { role: 'engine' }));
  const has = bp.parts.filter((p) => matches(s.ctx, { role: 'engine' }, p) && p.facing === 'S').length;
  const core = bp.parts.find((p) => p.fn === 'core');
  const cx = core ? Math.max(...placeGeometry(s.ctx.catalog, core).cells.map((c) => c[0])) : 0;
  const legal = suggestCells(s.ctx, bp, ['core', 'generator', 'store'], { lane: 'S', mirror: s.mirror, max: 16 });
  // (Mirror mode: a cell left of the centre line takes two engines, one on the centre line takes one)
  const weight = (c: string) => (s.mirror && Number(c.split(',')[0]) < cx ? 2 : 1);
  const room = legal.reduce((a, c) => a + weight(c), 0);
  const out = [
    `Engines now: ${has} facing v; the ship needs at least ${need}${s.mirror ? ` (a new engine LEFT of the centre line counts twice, one ON it once: ${Math.max(1, Math.ceil((need - has) / 2))} left of centre is enough)` : ''}.`,
    'An engine faces v (write v after its code, e.g. a Drive ID as IDv): its flame leaves its bottom edge, so the cell directly below it must be empty.',
    legal.length ? `Legal engine cells (they touch power; the cells behind are clear): ${legal.join('; ')}.` : 'No free cell touching power has a clear lane behind it.',
  ];
  if (room < need - has) {
    const ext = suggestCells(s.ctx, bp, ['core', 'generator', 'store'], { mirror: s.mirror, max: 8 }).filter((c) => !legal.includes(c));
    out.push(`There is not enough room for ${need - has} more engines behind the power parts. Extend the ship aft: put a store or a generator on a free cell touching power (${ext.length ? ext.join('; ') : 'any free cell beside the core'}), then engines in the cells beside or behind THAT part (each engine must touch a store, generator or the core). Hull you add aft needs power too: engines on bare hull get none.`);
  }
  return out;
}

/**
 * The free cells inside the concept's outline, placed where the ship's rows fit it best, centred on the core's column: not
 * in front of a gun or behind an engine (any part's facing lane), and joined to the ship. Left half and centre line in
 * mirror mode. As "col,row", nose to tail
 */
export function outlineFill(ctx: ShipgenContext, bp: Blueprint, outline: number[], mirror: boolean): string[] {
  const rows = shipRows(ctx, bp);
  const core = bp.parts.find((p) => p.fn === 'core');
  if (!rows.length || !core) return [];
  const f = outlineFit(outline, rows.map((r) => r.x1 - r.x0 + 1));
  const cxs = placeGeometry(ctx.catalog, core).cells.map((c) => c[0]);
  const c = Math.round((Math.min(...cxs) + Math.max(...cxs)) / 2);
  const owner = new Set<string>(), blocked = new Set<string>();
  for (const p of bp.parts) for (const k of placeGeometry(ctx.catalog, p).cells) owner.add(`${k[0]},${k[1]}`);
  const D: Record<string, [number, number]> = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] };
  for (const p of bp.parts) {
    const fn = ctx.catalog.functions.get(p.fn);
    if (!p.facing || !(fn?.weapon || isEngine(fn))) continue;
    const [dx, dy] = D[p.facing] ?? [0, 0];
    for (const k of placeGeometry(ctx.catalog, p).cells) for (let n = 1; n <= 40; n++) blocked.add(`${k[0] + dx * n},${k[1] + dy * n}`);
  }
  const want: [number, number][] = [];
  outline.forEach((w, i) => {
    const y = rows[0].y + i + f.offset, half = (w - 1) / 2;
    for (let x = c - half; x <= (mirror ? c : c + half); x++) if (!owner.has(`${x},${y}`) && !blocked.has(`${x},${y}`)) want.push([x, y]);
  });
  // (Only cells joined to the ship, through each other: a mirrored half also touches its mirror across the centre line)
  const ok = new Set<string>(), has = (x: number, y: number) => owner.has(`${x},${y}`) || ok.has(`${x},${y}`) || (mirror && owner.has(`${2 * c - x},${y}`));
  for (let grew = true; grew;) {
    grew = false;
    for (const [x, y] of want) if (!ok.has(`${x},${y}`) && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => has(x + dx, y + dy))) { ok.add(`${x},${y}`); grew = true; }
  }
  return want.filter(([x, y]) => ok.has(`${x},${y}`)).map(([x, y]) => `${x},${y}`);
}

const twice = (s: StepContext) => (s.mirror ? ' (in the whole ship: a part left of the centre line is mirrored, so it counts twice)' : '');
const unpoweredOf = (r: CheckResult, kind: string) => (r.power?.consumers ?? []).filter((c) => c.kind === kind && !c.linked);

export const STEPS: Step[] = [
  {
    id: 'power', title: 'power',
    ask: (s) => {
      const g = Math.max(1, wants(s.role, { role: 'generator' })), st = Math.max(1, wants(s.role, { role: 'store' }, true));
      return `Add the POWER: at least ${g} GENERATOR(s) and ${st} STORE(s)${twice(s)}, each touching the core or a generator or store that does (a full shared edge). Nothing else yet: no guns, engines or armour.`;
    },
    lacks: (s, bp) => {
      const out: string[] = [];
      const g = Math.max(1, wants(s.role, { role: 'generator' })), st = Math.max(1, wants(s.role, { role: 'store' }, true));
      const ng = count(s.ctx, bp, { role: 'generator' }), ns = count(s.ctx, bp, { role: 'store' });
      if (ng < g) out.push(`needs at least ${g} generator(s) (has ${ng})`);
      if (ns < st) out.push(`needs at least ${st} store(s) (has ${ns})`);
      return out;
    },
    near: { roles: ['core', 'generator', 'store'] },
    adds: (c, p) => isPower(c, p, 'generator') || isPower(c, p, 'store'),
  },
  {
    id: 'weapons', title: 'weapons',
    ask: (s) => `Add the WEAPONS: at least ${Math.max(2, wants(s.role, { role: 'weapon' }))} guns${twice(s)}. Each gun must TOUCH a store, a generator or the core (hull carries no power), face OUT (fixed guns face ^) with NOTHING in the cell it faces, and keep its legend mounting rule.`,
    lacks: (s, bp, r) => {
      const n = Math.max(2, wants(s.role, { role: 'weapon' })), has = count(s.ctx, bp, { role: 'weapon' });
      const out = has < n ? [`needs at least ${n} guns (has ${has})`] : [];
      for (const u of unpoweredOf(r, 'weapon')) out.push(`the ${u.name} (${u.code} at row ${u.row} col ${u.col}) gets no power: put it against a store, generator or the core`);
      return out;
    },
    near: { roles: ['core', 'generator', 'store'], lane: 'N' },
    adds: (c, p) => matches(c, { role: 'weapon' }, p),
  },
  {
    id: 'engines', title: 'engines',
    ask: (s) => `Add the ENGINES: at least ${Math.max(2, wants(s.role, { role: 'engine' }))} engines${twice(s)} at the BACK, facing v (backwards), with NOTHING in the cell behind them. Each must TOUCH a store, a generator or the core.`,
    lacks: (s, bp, r) => {
      const n = Math.max(2, wants(s.role, { role: 'engine' }));
      const back = bp.parts.filter((p) => matches(s.ctx, { role: 'engine' }, p) && p.facing === 'S').length;
      const out = back < n ? [`needs at least ${n} engines facing v (has ${back})`] : [];
      for (const u of unpoweredOf(r, 'thruster')) out.push(`the ${u.name} (${u.code} at row ${u.row} col ${u.col}) gets no power: put it against a store, generator or the core`);
      return out;
    },
    near: { roles: ['core', 'generator', 'store'], lane: 'S' },
    adds: (c, p) => matches(c, { role: 'engine' }, p),
    extra: (s, bp) => engineHelp(s, bp),
  },
  {
    id: 'armour', title: 'armour',
    ask: (s) => {
      const n = wants(s.role, { fn: 'armor' }, true);
      return `Add ARMOUR on the OUTSIDE${n ? `: at least ${n} armour parts${twice(s)}` : ' (optional)'}: across the nose and down the flanks, around the core, generators and stores. Never in front of a gun or behind an engine. Shaped pieces (wedges) at the corners look good.`;
    },
    adds: (_c, p) => p.fn === 'armor' || p.fn === 'hull',
    lacks: (s, bp, _r, prev) => {
      const n = wants(s.role, { fn: 'armor' }, true), has = bp.parts.filter((p) => p.fn === 'armor').length;
      const out = has < n ? [`needs at least ${n} armour parts (has ${has})`] : [];
      const o = s.concept?.outline;
      if (o && prev) {
        const target = outlineFill(s.ctx, prev.bp, o, s.mirror);
        const left = new Set(outlineFill(s.ctx, bp, o, s.mirror));
        const empty = target.filter((k) => left.has(k));
        if (target.length >= 3 && empty.length > target.length / 2) out.push(`the concept's outline still has ${empty.length} of ${target.length} cells empty: fill ${empty.slice(0, 12).join('; ')}`);
      }
      return out;
    },
    extra: (s, bp) => {
      const o = s.concept?.outline;
      if (!o) return [];
      const cells = outlineFill(s.ctx, bp, o, s.mirror);
      return cells.length ? [`The concept's outline (row widths nose to tail ${o.join(',')}):\n${outlinePicture(o)}\nFill it: put armour (or hull) on these free cells (col,row)${s.mirror ? ', left half and centre line' : ''}: ${cells.slice(0, 30).join('; ')}.`] : [];
    },
  },
  {
    id: 'shape', title: 'shape',
    ask: (s) => {
      const o = outlineShapes(s.ctx);
      return `SHAPE the outline: swap the exposed outer corner cells of hull and armour for shaped pieces${o.length ? ` (${o.map((x) => `${x.marks} ${x.words}`).join('; ')})` : ''}, so the ship is not a block. Change only hull and armour; keep every gun, engine and power part, and the same footprint. The power must stay exactly as it is.${twice(s)}`;
    },
    lacks: (s, bp, r, prev) => {
      if (!exposedCorners(s.ctx, bp).length) return [];
      if (!prev) return squareCornerWords(s.ctx, bp, 1, s.mirror ? coreLeftEdge(s.ctx, bp) : undefined).length ? ['the exposed outer corners are still square'] : [];
      const out: string[] = [];
      if ((silhouetteScore(s.ctx, bp) ?? 0) <= (silhouetteScore(s.ctx, prev.bp) ?? 0)) out.push('the outline is no more shaped than before: put shaped pieces on the listed corners');
      const sig = (x: CheckResult) => (x.power?.consumers ?? []).map((c) => `${c.name}:${c.pct}:${c.pctLong}`).sort().join('|');
      if (sig(r) !== sig(prev.r)) out.push('the power changed (a gun or engine now fires or pushes differently): keep the power exactly as it was');
      return out;
    },
    replaces: (p) => p.fn === 'hull' || p.fn === 'armor',
    extra: (s, bp) => { const w = squareCornerWords(s.ctx, bp, 12, s.mirror ? coreLeftEdge(s.ctx, bp) : undefined); return w.length ? [`Exposed corners still square (col,row, open sides): ${w.join('; ')}.`] : []; },
  },
];

/**
 * A valid, symmetric start: the core on column 0, a hull spine down the centre line and a cross beam behind the core.
 * `fill` (default on): more frame up to the brief's minimum cells (or `target`); off when the armour step will fill an outline
 */
export function skeleton(ctx: ShipgenContext, role: Role | undefined, name = 'Skeleton', target?: number, fill = true): Blueprint {
  const legend = buildLegend(ctx);
  const core = legend.entries.find((e) => e.fn === 'core' && e.level === 0) ?? legend.entries.find((e) => e.fn === 'core')!;
  const hull = legend.entries.find((e) => e.kind === 'structure' && e.fn === 'hull' && e.level === 0) ?? legend.entries.find((e) => e.fn === 'hull')!;
  const h = role?.size?.maxHeight ?? 8, w = role?.size?.maxWidth ?? 10;
  const len = Math.max(3, Math.round(h * 0.6)), front = Math.floor((len - 1) / 2), back = len - 1 - front;
  const span = Math.max(1, Math.floor(w * 0.3));
  const parts: PlacedPart[] = [];
  const add = (fn: string, material: string, x: number, y: number) => parts.push({ uid: parts.length, piece: 'sq', fn, material, x, y, rot: 0, flip: false });
  add(core.fn, core.material, 0, 0);
  for (let y = -front; y <= back; y++) if (y !== 0) add(hull.fn, hull.material, 0, y);
  for (let x = 1; x <= span; x++) { add(hull.fn, hull.material, -x, 1); add(hull.fn, hull.material, x, 1); }
  // (The brief wants at least its minimum cells: more hull frame, row by row outward from the core, until it has that many.
  // The hull is a placeholder the model builds over, so the ship doesn't stay small for want of a frame)
  const want = Math.min(role?.size.cells[1] ?? 0, Math.max(role?.size.cells[0] ?? 0, target ?? 0));
  if (fill && want > parts.length) {
    const have = new Set(parts.map((p) => `${p.x},${p.y}`));
    const H = role?.size.maxHeight ?? 8, up = Math.floor((H - 1) / 2), down = H - 1 - up;
    const half = Math.max(1, Math.floor(((role?.size.maxWidth ?? 10) - 1) / 2));
    const put = (x: number, y: number) => { if (parts.length < want && !have.has(`${x},${y}`)) { have.add(`${x},${y}`); add(hull.fn, hull.material, x, y); } };
    for (let d = 1; d <= Math.max(up, down) && parts.length < want; d++) {
      for (const y of [d, -d]) {
        if (y > down || -y > up) continue;
        put(0, y);
        for (let x = 1; x <= half; x++) { if (parts.length + 2 > want) break; put(-x, y); put(x, y); }
      }
    }
  }
  return { name, catalogVersion: ctx.catalog.version, parts };
}

/** Frame hull: the placeholder the model may build over */
const isFrame = (p: PlacedPart) => p.fn === 'hull';

/**
 * Frame hull out of the way: hull in front of a gun or behind an engine (any part's facing lane: it would block the shot or
 * the flame), then hull no longer joined to the core
 */
export function clearLanes(ctx: ShipgenContext, bp: Blueprint): { bp: Blueprint; removed: number } {
  const D: Record<string, [number, number]> = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] };
  const lane = new Set<string>();
  for (const p of bp.parts) {
    const fn = ctx.catalog.functions.get(p.fn);
    if (!p.facing || !(fn?.weapon || isEngine(fn))) continue;
    const [dx, dy] = D[p.facing] ?? [0, 0];
    for (const c of placeGeometry(ctx.catalog, p).cells) for (let n = 1; n <= 40; n++) lane.add(`${c[0] + dx * n},${c[1] + dy * n}`);
  }
  const cellsOf = bp.parts.map((p) => placeGeometry(ctx.catalog, p).cells.map((c) => `${c[0]},${c[1]}`));
  let keep = bp.parts.map((p, i) => !(isFrame(p) && cellsOf[i].some((k) => lane.has(k))));
  // (Then what is still joined to the core, through the parts kept)
  const core = bp.parts.findIndex((p) => p.fn === 'core');
  if (core >= 0) {
    const owner = new Map<string, number>();
    cellsOf.forEach((ks, i) => { if (keep[i]) for (const k of ks) owner.set(k, i); });
    const seen = new Set<number>([core]), todo = [core];
    while (todo.length) {
      const i = todo.pop()!;
      for (const k of cellsOf[i]) {
        const [x, y] = k.split(',').map(Number);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const j = owner.get(`${x + dx},${y + dy}`); if (j !== undefined && !seen.has(j)) { seen.add(j); todo.push(j); } }
      }
    }
    keep = keep.map((k, i) => k && (seen.has(i) || !isFrame(bp.parts[i])));
  }
  const removed = keep.filter((k) => !k).length;
  return removed ? { bp: { ...bp, parts: bp.parts.filter((_, i) => keep[i]).map((p, uid) => ({ ...p, uid })) }, removed } : { bp, removed: 0 };
}

/** Free cells (empty, or frame hull) touching a part of these power roles; on the left half and centre line in mirror mode */
export function suggestCells(ctx: ShipgenContext, bp: Blueprint, roles: string[], opts: { lane?: 'N' | 'S'; mirror?: boolean; max?: number } = {}): string[] {
  const owner = new Map<string, PlacedPart>();
  for (const p of bp.parts) for (const c of placeGeometry(ctx.catalog, p).cells) owner.set(`${c[0]},${c[1]}`, p);
  const sources = bp.parts.filter((p) => { const fn = ctx.catalog.functions.get(p.fn); return !!fn && roles.includes(partPower(ctx, fn, p.piece, p.material).role); });
  const core = bp.parts.find((p) => p.fn === 'core');
  const cx = core ? Math.max(...placeGeometry(ctx.catalog, core).cells.map((c) => c[0])) : 0;
  const ys = [...owner.keys()].map((k) => Number(k.split(',')[1]));
  const out = new Map<string, string>();
  for (const s of sources) {
    for (const c of placeGeometry(ctx.catalog, s).cells) {
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const x = c[0] + dx, y = c[1] + dy, k = `${x},${y}`;
        const o = owner.get(k);
        if (o && !isFrame(o)) continue;
        if (opts.mirror && x > cx) continue;
        if (opts.lane) {
          const step = opts.lane === 'N' ? -1 : 1, stop = opts.lane === 'N' ? Math.min(...ys) : Math.max(...ys);
          let clear = true;
          for (let yy = y + step; opts.lane === 'N' ? yy >= stop : yy <= stop; yy += step) { const q = owner.get(`${x},${yy}`); if (q && !isFrame(q)) { clear = false; break; } }
          if (!clear) continue;
        }
        out.set(k, `${x},${y}${o ? ' (frame hull)' : ''}`);
      }
    }
  }
  return [...out.entries()].sort((a, b) => { const [ax, ay] = a[0].split(',').map(Number), [bx, by] = b[0].split(',').map(Number); return (opts.lane === 'S' ? by - ay : ay - by) || ax - bx; }).slice(0, opts.max ?? 10).map((e) => e[1]);
}

/** Empty cells next to these cells (not among them), on the left half and centre line in mirror mode */
export function ringAround(ctx: ShipgenContext, bp: Blueprint, cells: string[], mirror: boolean, max = 8): string[] {
  const owner = new Set<string>();
  for (const p of bp.parts) for (const c of placeGeometry(ctx.catalog, p).cells) owner.add(`${c[0]},${c[1]}`);
  const core = bp.parts.find((p) => p.fn === 'core');
  const cx = core ? Math.max(...placeGeometry(ctx.catalog, core).cells.map((c) => c[0])) : 0;
  const out: string[] = [];
  for (const k of cells) {
    const [x, y] = k.split(',').map(Number);
    for (const [dx, dy] of [[-1, 0], [0, -1], [0, 1], [1, 0]]) {
      const n = `${x + dx},${y + dy}`;
      if (owner.has(n) || cells.includes(n) || out.includes(n) || (mirror && x + dx > cx)) continue;
      out.push(n);
    }
  }
  return out.slice(0, max);
}

/** Parts placed before (not frame hull) that a step's ship no longer has */
function lost(ctx: ShipgenContext, before: Blueprint, after: Blueprint, replaces: (p: PlacedPart) => boolean = isFrame): PlacedPart[] {
  const left = new Map<string, number>();
  for (const p of after.parts) { const k = partKey(ctx, p); left.set(k, (left.get(k) ?? 0) + 1); }
  const out: PlacedPart[] = [];
  for (const p of before.parts) {
    if (replaces(p)) continue;
    const k = partKey(ctx, p), n = left.get(k) ?? 0;
    if (n > 0) left.set(k, n - 1); else out.push(p);
  }
  return out;
}

export async function stagedLoop(deps: LoopDeps, o: DesignOptions, emit: Emit): Promise<DesignOutcome> {
  const { ctx } = deps;
  const S = new Session(deps, o, await contractFor(deps, o.model, o.contract, 'staged'), emit);
  const t0 = S.now();
  const tries = o.rounds ?? 3, keep = o.keepRounds ?? 2;
  const sc: StepContext = { ctx, role: S.role, mirror: S.mirror, ...(S.concept ? { concept: S.concept } : {}) };
  const system = systemPrompt(ctx, o.brief, { form: S.C.form, mirror: S.mirror, staged: true });
  emit({ type: 'brief', role: S.role?.id, text: briefText(ctx, o.brief), legendCodes: briefLegend(ctx, o.brief).length, promptChars: system.length });
  const out: DesignOutcome = { attempts: [], firstValidRound: null, firstPassRound: null, unreadable: 0, truncated: 0, cancelled: false, ms: 0, steps: { accepted: [], failed: [] } };
  // (With an outline the armour step fills it: the frame stays small so guns and engines have clear lanes)
  let ship = o.start?.bp ?? skeleton(ctx, S.role, o.brief.name ?? 'Untitled', S.concept?.cells, !S.concept?.outline);
  let shipAttempt: Attempt | undefined;
  let round = 0;
  const book = new CodeBook(ctx);
  const codesOf = (r: string) => briefLegend(ctx, o.brief).filter((e) => (r === 'engine' ? isEngine(ctx.catalog.functions.get(e.fn)) : e.power.role === r)).map((e) => e.code).slice(0, 8).join(', ');
  const hint: Record<string, string> = { power: `generators ${codesOf('generator')}; stores ${codesOf('store')}`, weapons: codesOf('weapon'), engines: codesOf('engine') };

  steps:
  for (const [i, step] of STEPS.entries()) {
    if (o.signal?.aborted) { out.cancelled = true; break; }
    const before = ship;
    const r0 = check(ctx, before, { book });
    const replaces = step.replaces ?? isFrame;
    if (!step.lacks(sc, before, r0).length && step.id !== 'armour' && i > 0) {
      emit({ type: 'step', step: step.id, index: i + 1, of: STEPS.length, status: 'skipped', round, note: 'already done' });
      continue;
    }
    emit({ type: 'step', step: step.id, index: i + 1, of: STEPS.length, status: 'start', round });
    const where = step.near ? suggestCells(ctx, before, step.near.roles, { lane: step.near.lane, mirror: S.mirror }) : [];
    const ring = step.id === 'power' ? ringAround(ctx, before, where.map((w) => w.split(' ')[0]), S.mirror) : [];
    const parts = S.C.form === 'parts';
    const ask = [
      `Here is the ship so far${S.mirror ? ' (its left half and centre line: the tool mirrors it)' : ''}:`,
      S.show(before),
      '',
      ...(S.concept ? [S.conceptBlock().trimEnd(), ''] : []),
      `Step ${i + 1} of ${STEPS.length}: ${step.ask(sc)}`,
      ...(hint[step.id] ? [`Codes for this step (see the legend): ${hint[step.id]}.`] : []),
      ...(ring.length ? [`Free cells one further out (touching those, for a second generator or store in a chain): ${ring.join('; ')}.`] : []),
      ...(where.length ? [`Free cells that touch power${step.near?.lane === 'N' ? ' with nothing in front' : step.near?.lane === 'S' ? ' with nothing behind' : ''} (col,row): ${where.join('; ')}. Put each new part ON one of them (frame hull there is replaced), not behind hull.`] : []),
      ...(step.extra ? step.extra(sc, before) : []),
      step.replaces ? `Keep every other part already placed: this step may replace hull and armour.` : `Keep every part already placed. The frame's hull cells are placeholders: you may build over them.`,
      parts
        ? `Reply with name:, parts:, ONLY THE NEW PARTS (one per line, CODE col,row), and end. A new part placed on a frame hull cell replaces it.${S.mirror ? ' Only on the left half and the centre line.' : ''}`
        : S.ask(),
    ].join('\n');
    const head: ChatMessage[] = [{ role: 'system', content: system }, { role: 'user', content: ask }];
    let tail: ChatMessage[] = [];
    const build = parts ? (drawn: Blueprint, b: CodeBook): DecodeResult => {
      const m = mergeParts(ctx, S.mirror ? halfOf(ctx, before) : before, drawn.parts, replaces, b);
      if (!m.bp) return m;
      const c = clearLanes(ctx, m.bp);
      return c.removed ? { ...m, bp: c.bp, warnings: [...m.warnings, `${c.removed} frame hull part(s) in front of a gun, behind an engine or cut off were removed`] } : m;
    } : undefined;
    let accepted = false;
    const seen = new Set<string>();
    for (let t = 1; t <= tries; t++) {
      if (o.signal?.aborted) { out.cancelled = true; break steps; }
      round++;
      const reply = await S.chat(round, [...head, ...tail]);
      if (reply === 'cancelled') { out.cancelled = true; break steps; }
      if (reply === 'failed') break steps;
      if (reply === 'retry') continue;
      const r = await S.read(round, reply, build);
      const a = r.attempt;
      out.attempts.push(a);
      if (r.truncated) out.truncated++;
      else if (!r.readable) out.unreadable++;
      let problems: string[] = [];
      if (a.bp && a.result) {
        problems = [...step.lacks(sc, a.bp, a.result, { bp: before, r: r0 })];
        for (const p of lost(ctx, before, a.bp, replaces)) { const at = partAt(ctx, p); problems.unshift(`you removed the ${ctx.catalog.functions.get(p.fn)?.name ?? p.fn} at row ${at.row} col ${at.col} (placed in an earlier step): keep every part already placed`); }
        if (i > 0) for (const u of a.result.power?.unpowered ?? []) { const m = `the ${u.name} (${u.code} at row ${u.row} col ${u.col}) gets no power`; if (!problems.some((x) => x.startsWith(m))) problems.push(`${m}: it must touch a store, generator or the core`); }
        // (A step that added nothing of its kind changed nothing that matters: not accepted)
        if (step.adds && !addedParts(ctx, before, a.bp).some((p) => step.adds!(ctx, p))) problems.unshift(`you added no ${step.title} part: this step must add at least one new part of that kind`);
        if (a.valid && !problems.length) {
          accepted = true;
          ship = a.bp; shipAttempt = a;
          out.steps!.accepted.push(step.id);
          // (The power-only skeleton is valid almost every time: a staged build counts as valid from the first step after it)
          if (i > 0 && out.firstValidRound === null) out.firstValidRound = round;
          emit({ type: 'step', step: step.id, index: i + 1, of: STEPS.length, status: 'accepted', round });
          emit({ type: 'best', round, score: a.score, valid: a.valid, name: a.bp.name, bp: a.bp, ...(a.renderPath ? { renderPath: a.renderPath } : {}) });
          if (passes(a) && out.firstPassRound === null && i === STEPS.length - 1) out.firstPassRound = round;
          break;
        }
      }
      if (t < tries) {
        const lines = [
          problems.length ? `Step ${i + 1} (${step.title}) is not done yet:\n${problems.map((x) => `- ${x}`).join('\n')}` : '',
          r.feedback,
          ...(step.extra ? step.extra(sc, before) : []),
          S.conceptLine().trimEnd(),
          parts ? `Reply again with name:, parts:, ONLY THE NEW PARTS for this step, and end.` : S.ask(),
        ].filter(Boolean);
        if (r.said && seen.has(r.said)) S.heat();
        if (r.said) seen.add(r.said);
        const msg = lines.join('\n');
        emit({ type: 'feedback', round, text: msg });
        tail = [...tail, { role: 'assistant' as const, content: r.said ?? a.reply.slice(-1500) }, { role: 'user' as const, content: msg }].slice(-2 * Math.max(1, keep));
      }
    }
    if (!accepted) out.steps!.failed.push(step.id);
    if (!accepted) emit({ type: 'step', step: step.id, index: i + 1, of: STEPS.length, status: 'failed', round, note: `no try in ${tries} kept the ship valid with the ${step.title} in place; going on without it` });
  }
  // (The ship the steps built, scored against the whole brief; a run that never got past the skeleton keeps its best try)
  if (shipAttempt) {
    out.best = shipAttempt;
    if (passes(shipAttempt) && out.firstPassRound === null) out.firstPassRound = shipAttempt.round;
  } else {
    for (const a of out.attempts) if (a.bp && (!out.best || better(a, out.best))) out.best = a;
  }
  out.ms = S.now() - t0;
  return out;
}
