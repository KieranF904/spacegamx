// Compare: the same brief on two (or more) models, one after another (they share the GPU), a few trials each, each trial
// stopping at its first valid design that meets the brief. Reports pass rate (valid and on brief within the rounds), rounds per such ship, ships per
// minute and mean score.
import { type Attempt, type DesignOptions, type LoopDeps, designLoop } from './design';
import type { CompareMetrics, Emit, ModelStats } from './events';

export interface CompareOptions extends Omit<DesignOptions, 'model' | 'start' | 'tag' | 'stopWhenValid'> {
  models: string[];
  /** Trials per model (default 3) */
  trials?: number;
}

export interface CompareOutcome { metrics: CompareMetrics; best: Map<string, Attempt[]>; cancelled: boolean }

export async function compareLoop(deps: LoopDeps, o: CompareOptions, emit: Emit): Promise<CompareOutcome> {
  const now = deps.now ?? Date.now;
  const trials = o.trials ?? 3, rounds = o.rounds ?? 4;
  const models: ModelStats[] = [];
  const best = new Map<string, Attempt[]>();
  let cancelled = false;
  for (const model of o.models) {
    const t0 = now();
    let passes = 0, roundsToValid = 0, scoreSum = 0, tps: number[] = [], done = 0;
    best.set(model, []);
    for (let t = 1; t <= trials && !cancelled; t++) {
      const lane = `${model} t${t}`;
      const r = await designLoop(deps, { ...o, model, rounds, stopWhenValid: true, tag: `${model.replace(/[^\w.-]+/g, '_')}-t${t}` }, (e) => emit({ ...e, lane }));
      if (r.cancelled) { cancelled = true; break; }
      done++;
      if (r.firstPassRound !== null) { passes++; roundsToValid += r.firstPassRound; }
      scoreSum += r.best?.score ?? 0;
      if (r.best) best.get(model)!.push(r.best);
      for (const a of r.attempts) if (a.tokensPerSec) tps.push(a.tokensPerSec);
    }
    const ms = now() - t0;
    models.push({
      model, trials: done, passes, passRate: done ? round2(passes / done) : 0,
      roundsPerValid: passes ? round2(roundsToValid / passes) : null,
      validPerMinute: ms > 0 ? round2(passes / (ms / 60000)) : 0,
      meanScore: done ? round2(scoreSum / done) : 0, ms,
      tokensPerSec: tps.length ? round2(tps.reduce((a, b) => a + b, 0) / tps.length) : null,
    });
    if (cancelled) break;
  }
  return { metrics: { kind: 'compare', rounds, models }, best, cancelled };
}

const round2 = (x: number) => Math.round(x * 100) / 100;
