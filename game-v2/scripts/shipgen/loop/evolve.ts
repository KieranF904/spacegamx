// Evolve: a population seeded from a role (fresh designs) or a given blueprint; each generation the model makes children
// by changing a parent ("make it faster", "guard the engines with a Diode": picked from what the parent's check lacks),
// each child gets a few repair rounds, and the top K of parents and children carry on. With build: 'staged' the fresh
// seeds are built in steps (staged.ts); children are always changed whole.
import type { Blueprint } from '../../../common/src/ships/index';
import { briefLegend, feedbackMessage, shapeSuggestion } from '../core/index';
import { type Attempt, type DesignOptions, type LoopDeps, better, designLoop, gridOf, roleOf, scoreGiven } from './design';
import type { Emit, EvolveMetrics } from './events';
import { mutationsFor, pickMutation, rngOf } from './mutations';

export interface EvolveOptions extends Omit<DesignOptions, 'start' | 'rounds' | 'tag' | 'stopWhenValid'> {
  /** Children a generation (default 4), survivors kept (default 2), generations (default 3) */
  population?: number;
  keep?: number;
  generations?: number;
  /** Rounds for each seed design (default 3) and for each child (default 2: the change, then one repair) */
  seedRounds?: number;
  childRounds?: number;
  /** Start from this design instead of fresh ones */
  seed?: Blueprint;
  rngSeed?: number;
  /** Stop early when the best score has not improved for this many generations (default: never) */
  patience?: number;
  /** Offer "shape the outline" as a change, with the square corners named (on a valid parent that has some) */
  shapeHints?: boolean;
}

export interface Individual { id: string; a: Attempt }

export interface EvolveOutcome { survivors: Individual[]; best?: Individual; metrics: EvolveMetrics; cancelled: boolean }

const sub = (emit: Emit, lane: string): Emit => (e) => emit({ ...e, lane: e.lane ? `${lane} ${e.lane}` : lane });

export async function evolveLoop(deps: LoopDeps, o: EvolveOptions, emit: Emit): Promise<EvolveOutcome> {
  const { ctx } = deps;
  const now = deps.now ?? Date.now;
  const t0 = now();
  const P = o.population ?? 4, K = o.keep ?? 2, G = o.generations ?? 3;
  const rng = rngOf(o.rngSeed ?? 1);
  const legend = briefLegend(ctx, o.brief);
  const role = roleOf(ctx, o.brief);
  const metrics: EvolveMetrics = { kind: 'evolve', model: o.model, generations: 0, bestByGen: [], children: 0, validChildren: 0, ms: 0 };
  let pop: Individual[] = [];
  let cancelled = false;
  const rank = (xs: Individual[]) => [...xs].sort((x, y) => (better(x.a, y.a) ? -1 : better(y.a, x.a) ? 1 : 0));
  const report = (gen: number) => {
    emit({ type: 'generation', gen, population: pop.map((i) => ({ id: i.id, score: i.a.score, valid: i.a.valid, name: i.a.bp?.name ?? '' })) });
    metrics.bestByGen.push(pop[0]?.a.score ?? 0);
  };

  // ---- Generation 0: the given design, or fresh ones
  if (o.seed) {
    // (Scored as a child is, brief penalty and all, so it doesn't beat an equal child; and said when it misses the role's size or band)
    const g = scoreGiven(ctx, o.seed, role, o);
    const text = gridOf(ctx, o.seed, g.book);
    const off = (g.brief?.unmet ?? []).filter((x) => /^(size|width|length)|level|band/.test(x));
    if (off.length) emit({ type: 'error', message: `the seed doesn't fit the role${role ? ` ${role.id}` : ''}: ${off.join('; ')}. Pick a role that suits it (--role), or expect the ranking to favour children that do`, fatal: false });
    pop = [{ id: 'seed', a: { round: 0, reply: '', gridText: text, bp: o.seed, result: g.result, brief: g.brief, valid: g.result.valid, score: g.score, ms: 0 } }];
  } else {
    for (let i = 0; i < K && !o.signal?.aborted; i++) {
      const lane = `g0#${i + 1}`;
      const r = await designLoop(deps, { ...o, rounds: o.seedRounds ?? 3, tag: lane }, sub(emit, lane));
      if (r.best) pop.push({ id: lane, a: r.best });
      if (r.cancelled) cancelled = true;
    }
  }
  pop = rank(pop).slice(0, K);
  report(0);

  // ---- Generations
  let stale = 0;
  for (let gen = 1; gen <= G && pop.length && !cancelled && !o.signal?.aborted; gen++) {
    const bestBefore = pop[0]?.a.score ?? 0, wasValid = !!pop[0]?.a.valid;
    const kids: Individual[] = [];
    for (let c = 0; c < P && !o.signal?.aborted; c++) {
      // (Parents by rank: the best more often)
      const parent = pop[Math.min(pop.length - 1, Math.floor(rng() * rng() * pop.length))];
      const menu = mutationsFor(parent.a.result, parent.a.brief, legend);
      // (Square corners left on a valid parent: named, as the shape step does in a staged build)
      const corners = o.shapeHints && parent.a.bp && parent.a.valid ? shapeSuggestion(ctx, parent.a.bp, o.mirror !== false) : null;
      if (corners) menu.push({ instruction: `shape the outline: ${corners.replace(/^Outline: /, '')} Keep every gun, engine and power part exactly as it is`, weight: 3, why: 'square corners' });
      const m = pickMutation(menu, rng);
      const lane = `g${gen}#${c + 1}`;
      emit({ type: 'mutation', gen, child: c + 1, parent: parent.id, instruction: m.instruction });
      const feedback = parent.a.result ? feedbackMessage({ result: parent.a.result, brief: parent.a.brief, maxItems: 5 }) : undefined;
      const r = await designLoop(deps, { ...o, build: 'oneshot', rounds: o.childRounds ?? 2, tag: lane, start: { bp: parent.a.bp, text: parent.a.gridText ?? undefined, instruction: m.instruction, feedback } }, sub(emit, lane));
      if (r.cancelled) { cancelled = true; break; }
      metrics.children++;
      if (r.best) { kids.push({ id: lane, a: r.best }); if (r.best.valid) metrics.validChildren++; }
    }
    pop = rank([...pop, ...kids]).slice(0, K);
    metrics.generations = gen;
    report(gen);
    stale = (pop[0]?.a.score ?? 0) > bestBefore || (!wasValid && pop[0]?.a.valid) ? 0 : stale + 1;
    if (o.patience && stale >= o.patience) break;
  }
  metrics.ms = now() - t0;
  return { survivors: pop, best: pop[0], metrics, cancelled: cancelled || !!o.signal?.aborted };
}
