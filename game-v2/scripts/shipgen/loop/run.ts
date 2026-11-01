// The design loop's front door: run(deps, options, emit) for a callback, runEvents(deps, options) as an async generator
// of the same typed events (events.ts). Modes: design (one ship, rounds of feedback), evolve (a population changed by
// the model and kept by score), compare (the same brief on several models).
import type { Attempt, DesignOptions, DesignOutcome, LoopDeps } from './design';
import { contractFor, designLoop } from './design';
import { type EvolveOptions, type EvolveOutcome, evolveLoop } from './evolve';
import { type CompareOptions, type CompareOutcome, compareLoop } from './compare';
import type { DesignMetrics, Emit, ShipgenEvent } from './events';

export type RunOptions =
  | ({ mode: 'design' } & DesignOptions)
  | ({ mode: 'evolve' } & EvolveOptions)
  | ({ mode: 'compare' } & CompareOptions);

export type RunOutcome =
  | { mode: 'design'; outcome: DesignOutcome }
  | { mode: 'evolve'; outcome: EvolveOutcome }
  | { mode: 'compare'; outcome: CompareOutcome };

const roleName = (o: RunOptions) => (typeof o.brief.role === 'string' ? o.brief.role : o.brief.role?.id);

export async function run(deps: LoopDeps, o: RunOptions, emitRaw: (e: ShipgenEvent) => void): Promise<RunOutcome> {
  const now = deps.now ?? Date.now;
  const t0 = now();
  const emit: Emit = (e) => emitRaw({ ...e, t: now() - t0 } as ShipgenEvent);
  const model = o.mode === 'compare' ? o.models[0] : o.model;
  const { signal: _s, seed: _seed, ...shown } = o as RunOptions & { signal?: unknown; seed?: unknown };
  emit({
    type: 'start', mode: o.mode, model, ...(o.mode === 'compare' ? { models: o.models } : {}), ...(o.critic ? { critic: o.critic } : {}),
    role: roleName(o), contract: await contractFor(deps, model, o.contract), options: { ...shown, brief: { ...o.brief, role: roleName(o) } },
  });
  try {
    if (o.mode === 'design') {
      const r = await designLoop(deps, o, emit);
      emit({ type: 'done', metrics: designMetrics(o.model, r, deps.renderStats?.ms ?? []), cancelled: r.cancelled });
      return { mode: 'design', outcome: r };
    }
    if (o.mode === 'evolve') {
      const r = await evolveLoop(deps, o, emit);
      emit({ type: 'done', metrics: r.metrics, cancelled: r.cancelled });
      return { mode: 'evolve', outcome: r };
    }
    const r = await compareLoop(deps, o, emit);
    emit({ type: 'done', metrics: r.metrics, cancelled: r.cancelled });
    return { mode: 'compare', outcome: r };
  } catch (e) {
    emit({ type: 'error', message: (e as Error).message, fatal: true });
    throw e;
  }
}

export function designMetrics(model: string, r: DesignOutcome, renderMs: number[]): DesignMetrics {
  const tps = r.attempts.map((a: Attempt) => a.tokensPerSec).filter((x): x is number => !!x);
  return {
    kind: 'design', model, rounds: r.attempts.length, firstValidRound: r.firstValidRound, valid: !!r.best?.valid,
    bestScore: r.best?.score ?? 0, unreadable: r.unreadable, ms: r.ms,
    outputTokens: r.attempts.reduce((a, x) => a + (x.outputTokens ?? 0), 0),
    tokensPerSec: tps.length ? Math.round((tps.reduce((a, b) => a + b, 0) / tps.length) * 10) / 10 : null,
    renderMs: [...renderMs],
  };
}

/** The same run as an async generator of events; its return value is the outcome */
export async function* runEvents(deps: LoopDeps, o: RunOptions): AsyncGenerator<ShipgenEvent, RunOutcome> {
  const queue: ShipgenEvent[] = [];
  let wake: (() => void) | null = null;
  let finished = false, failed: unknown = null, result: RunOutcome | undefined;
  const p = run(deps, o, (e) => { queue.push(e); wake?.(); })
    .then((r) => { result = r; }, (e) => { failed = e; })
    .finally(() => { finished = true; wake?.(); });
  for (;;) {
    while (queue.length) yield queue.shift()!;
    if (finished) break;
    await new Promise<void>((r) => { wake = r; });
    wake = null;
  }
  await p;
  if (failed) throw failed;
  return result!;
}
