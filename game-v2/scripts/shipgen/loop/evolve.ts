// Evolve: a population seeded from a role (fresh designs) or a given blueprint; each generation the model makes children
// by changing a parent ("make it faster", "guard the engines with a Diode": picked from what the parent's check lacks),
// each child gets a few repair rounds, and the top K of parents and children carry on.
import type { Blueprint } from '../../../common/src/ships/index';
import { CodeBook, blueprintToGrid, briefCheck, briefLegend, check, feedbackMessage } from '../core/index';
import { type Attempt, type DesignOptions, type LoopDeps, better, designLoop, roleOf } from './design';
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
    const book = new CodeBook(ctx);
    const text = blueprintToGrid(ctx, o.seed, { book }).text;
    const result = check(ctx, o.seed, { book, weights: role?.weights as never });
    const bc = role ? briefCheck(ctx, o.seed, role) : undefined;
    pop = [{ id: 'seed', a: { round: 0, reply: '', gridText: text, bp: o.seed, result, brief: bc, valid: result.valid, score: result.score, ms: 0 } }];
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
  for (let gen = 1; gen <= G && pop.length && !cancelled && !o.signal?.aborted; gen++) {
    const kids: Individual[] = [];
    for (let c = 0; c < P && !o.signal?.aborted; c++) {
      // (Parents by rank: the best more often)
      const parent = pop[Math.min(pop.length - 1, Math.floor(rng() * rng() * pop.length))];
      const m = pickMutation(mutationsFor(parent.a.result, parent.a.brief, legend), rng);
      const lane = `g${gen}#${c + 1}`;
      emit({ type: 'mutation', gen, child: c + 1, parent: parent.id, instruction: m.instruction });
      const feedback = parent.a.result ? feedbackMessage({ result: parent.a.result, brief: parent.a.brief, maxItems: 5 }) : undefined;
      const r = await designLoop(deps, { ...o, rounds: o.childRounds ?? 2, tag: lane, start: { text: parent.a.gridText!, instruction: m.instruction, feedback } }, sub(emit, lane));
      if (r.cancelled) { cancelled = true; break; }
      metrics.children++;
      if (r.best) { kids.push({ id: lane, a: r.best }); if (r.best.valid) metrics.validChildren++; }
    }
    pop = rank([...pop, ...kids]).slice(0, K);
    metrics.generations = gen;
    report(gen);
  }
  metrics.ms = now() - t0;
  return { survivors: pop, best: pop[0], metrics, cancelled: cancelled || !!o.signal?.aborted };
}
