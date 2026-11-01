// Staged build: start from a valid skeleton (a core and a small, symmetric hull frame sized to the brief) and ask for
// one system a step: power, then weapons, then engines, then armour. A step is accepted only when the ship is still
// valid, keeps every part placed before, and has what the step asked for; otherwise the check goes back to the model
// and it tries that step again. A step that runs out of tries leaves the ship as it was and the build moves on.
// The steps are a registry (STEPS): each says what it asks for and what a ship still lacks for it, from the role.
import type { Blueprint, PlacedPart } from '../../../common/src/ships/index';
import { placeGeometry } from '../../../common/src/ships/index';
import {
  type CheckResult, type DecodeResult, type Role, type Selector, type ShipgenContext,
  CodeBook, briefLegend, briefText, buildLegend, check, halfOf, matches, mergeParts, partAt, partKey, partPower, systemPrompt,
} from '../core/index';
import { type Attempt, type DesignOptions, type DesignOutcome, type LoopDeps, Session, better, contractFor, passes } from './design';
import type { Emit } from './events';
import type { ChatMessage } from './llm';

type PR = 'generator' | 'store' | 'weapon' | 'thruster';

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
}

export interface Step {
  id: string;
  title: string;
  /** What to add, in words */
  ask(s: StepContext): string;
  /** What a built ship still lacks for this step (empty: done) */
  lacks(s: StepContext, bp: Blueprint, r: CheckResult): string[];
  /** Cells worth suggesting: free cells touching these power roles (and, for facing parts, with a clear lane that way) */
  near?: { roles: string[]; lane?: 'N' | 'S' };
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
  },
  {
    id: 'engines', title: 'engines',
    ask: (s) => `Add the ENGINES: at least ${Math.max(2, wants(s.role, { role: 'thruster' }))} engines${twice(s)} at the BACK, facing v (backwards), with NOTHING in the cell behind them. Each must TOUCH a store, a generator or the core.`,
    lacks: (s, bp, r) => {
      const n = Math.max(2, wants(s.role, { role: 'thruster' }));
      const back = bp.parts.filter((p) => matches(s.ctx, { role: 'thruster' }, p) && p.facing === 'S').length;
      const out = back < n ? [`needs at least ${n} engines facing v (has ${back})`] : [];
      for (const u of unpoweredOf(r, 'thruster')) out.push(`the ${u.name} (${u.code} at row ${u.row} col ${u.col}) gets no power: put it against a store, generator or the core`);
      return out;
    },
    near: { roles: ['core', 'generator', 'store'], lane: 'S' },
  },
  {
    id: 'armour', title: 'armour',
    ask: (s) => {
      const n = wants(s.role, { fn: 'armor' }, true);
      return `Add ARMOUR on the OUTSIDE${n ? `: at least ${n} armour parts${twice(s)}` : ' (optional)'}: across the nose and down the flanks, around the core, generators and stores. Never in front of a gun or behind an engine. Shaped pieces (wedges) at the corners look good.`;
    },
    lacks: (s, bp) => {
      const n = wants(s.role, { fn: 'armor' }, true), has = bp.parts.filter((p) => p.fn === 'armor').length;
      return has < n ? [`needs at least ${n} armour parts (has ${has})`] : [];
    },
  },
];

/** A valid, symmetric start: the core on column 0, a hull spine down the centre line and a cross beam behind the core */
export function skeleton(ctx: ShipgenContext, role: Role | undefined, name = 'Skeleton'): Blueprint {
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
  return { name, catalogVersion: ctx.catalog.version, parts };
}

/** Frame hull: the placeholder the model may build over */
const isFrame = (p: PlacedPart) => p.fn === 'hull';

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
          for (let yy = y + step; opts.lane === 'N' ? yy >= stop : yy <= stop; yy += step) if (owner.has(`${x},${yy}`)) { clear = false; break; }
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
function lost(ctx: ShipgenContext, before: Blueprint, after: Blueprint): PlacedPart[] {
  const left = new Map<string, number>();
  for (const p of after.parts) { const k = partKey(ctx, p); left.set(k, (left.get(k) ?? 0) + 1); }
  const out: PlacedPart[] = [];
  for (const p of before.parts) {
    if (isFrame(p)) continue;
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
  const sc: StepContext = { ctx, role: S.role, mirror: S.mirror };
  const system = systemPrompt(ctx, o.brief, { form: S.C.form, mirror: S.mirror, staged: true });
  emit({ type: 'brief', role: S.role?.id, text: briefText(ctx, o.brief), legendCodes: briefLegend(ctx, o.brief).length, promptChars: system.length });
  const out: DesignOutcome = { attempts: [], firstValidRound: null, firstPassRound: null, unreadable: 0, cancelled: false, ms: 0 };
  let ship = o.start?.bp ?? skeleton(ctx, S.role, o.brief.name ?? 'Untitled');
  let shipAttempt: Attempt | undefined;
  let round = 0;
  const book = new CodeBook(ctx);
  const codesOf = (r: string) => briefLegend(ctx, o.brief).filter((e) => e.power.role === r).map((e) => e.code).slice(0, 8).join(', ');
  const hint: Record<string, string> = { power: `generators ${codesOf('generator')}; stores ${codesOf('store')}`, weapons: codesOf('weapon'), engines: codesOf('thruster') };

  steps:
  for (const [i, step] of STEPS.entries()) {
    if (o.signal?.aborted) { out.cancelled = true; break; }
    const before = ship;
    const r0 = check(ctx, before, { book });
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
      `Step ${i + 1} of ${STEPS.length}: ${step.ask(sc)}`,
      ...(hint[step.id] ? [`Codes for this step (see the legend): ${hint[step.id]}.`] : []),
      ...(ring.length ? [`Free cells one further out (touching those, for a second generator or store in a chain): ${ring.join('; ')}.`] : []),
      ...(where.length ? [`Free cells that touch power${step.near?.lane === 'N' ? ' with nothing in front' : step.near?.lane === 'S' ? ' with nothing behind' : ''} (col,row): ${where.join('; ')}.`] : []),
      `Keep every part already placed. The frame's hull cells are placeholders: you may build over them.`,
      parts
        ? `Reply with name:, parts:, ONLY THE NEW PARTS (one per line, CODE col,row), and end. A new part placed on a frame hull cell replaces it.${S.mirror ? ' Only on the left half and the centre line.' : ''}`
        : S.ask(),
    ].join('\n');
    const head: ChatMessage[] = [{ role: 'system', content: system }, { role: 'user', content: ask }];
    let tail: ChatMessage[] = [];
    const build = parts ? (drawn: Blueprint, b: CodeBook): DecodeResult => mergeParts(ctx, S.mirror ? halfOf(ctx, before) : before, drawn.parts, isFrame, b) : undefined;
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
      if (!r.readable) out.unreadable++;
      if (a.valid && out.firstValidRound === null) out.firstValidRound = round;
      let problems: string[] = [];
      if (a.bp && a.result) {
        problems = [...step.lacks(sc, a.bp, a.result)];
        for (const p of lost(ctx, before, a.bp)) { const at = partAt(ctx, p); problems.unshift(`you removed the ${ctx.catalog.functions.get(p.fn)?.name ?? p.fn} at row ${at.row} col ${at.col} (placed in an earlier step): keep every part already placed`); }
        if (i > 0) for (const u of a.result.power?.unpowered ?? []) { const m = `the ${u.name} (${u.code} at row ${u.row} col ${u.col}) gets no power`; if (!problems.some((x) => x.startsWith(m))) problems.push(`${m}: it must touch a store, generator or the core`); }
        if (a.valid && !problems.length) {
          accepted = true;
          ship = a.bp; shipAttempt = a;
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
          parts ? `Reply again with name:, parts:, ONLY THE NEW PARTS for this step, and end.` : S.ask(),
        ].filter(Boolean);
        if (r.said && seen.has(r.said)) S.heat();
        if (r.said) seen.add(r.said);
        const msg = lines.join('\n');
        emit({ type: 'feedback', round, text: msg });
        tail = [...tail, { role: 'assistant' as const, content: r.said ?? a.reply.slice(-1500) }, { role: 'user' as const, content: msg }].slice(-2 * Math.max(1, keep));
      }
    }
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
