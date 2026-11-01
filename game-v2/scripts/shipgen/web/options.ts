// The page's run form -> the loop's RunOptions. Role, tier (max pilot level) and size come in as overrides of the role
// in roles.json; "start from" is a library ship (or a design from this page) to change rather than start blank.
import type { Blueprint } from '../../../common/src/ships/index';
import {
  type Brief, type Role, type ShipgenContext, blueprintToGrid, briefCheck, check, feedbackMessage, findRole,
} from '../core/index';
import type { ModelInfo, RunOptions } from '../loop/index';
import { HttpError } from './http';

export interface RunForm {
  mode?: 'design' | 'evolve' | 'compare';
  model?: string;
  /** compare: the models side by side */
  models?: string[];
  critic?: string;
  temperature?: number;
  rounds?: number;
  role?: string;
  maxLevel?: number;
  cells?: [number, number];
  note?: string;
  think?: boolean;
  trials?: number;
  population?: number;
  keep?: number;
  generations?: number;
  render?: 'off' | 'valid' | 'all' | 'auto';
}

const num = (x: unknown, lo: number, hi: number, d?: number) => {
  const n = Number(x);
  return x === undefined || x === null || x === '' || !Number.isFinite(n) ? d : Math.min(hi, Math.max(lo, n));
};

export function roleFor(ctx: ShipgenContext, f: RunForm): Role | undefined {
  if (!f.role) return undefined;
  const base = findRole(ctx, f.role);
  if (!base) throw new HttpError(400, `no role ${f.role}`);
  const maxLevel = num(f.maxLevel, 1, 99);
  const cells = Array.isArray(f.cells) && f.cells.length === 2 ? f.cells.map((c) => num(c, 1, 2000)!) as [number, number] : undefined;
  if (maxLevel === undefined && !cells) return base;
  return {
    ...base,
    ...(maxLevel !== undefined ? { band: { ...base.band, maxLevel } } : {}),
    ...(cells ? { size: { ...base.size, cells: [Math.min(...cells), Math.max(...cells)] as [number, number] } } : {}),
  };
}

function known(models: ModelInfo[], id: string, what: string, vision = false): string {
  const full = id.includes('/') ? id : `ollama/${id}`;
  const m = models.find((x) => x.id === full);
  if (!m) throw new HttpError(400, `no ${what} model ${id}`);
  if (vision && !m.vision) throw new HttpError(400, `the critic must take images: ${id} doesn't`);
  return full;
}

export function runOptions(ctx: ShipgenContext, f: RunForm, models: ModelInfo[], opts: { outDir: string; signal: AbortSignal; start?: Blueprint }): RunOptions {
  const mode = f.mode ?? 'design';
  if (!['design', 'evolve', 'compare'].includes(mode)) throw new HttpError(400, `bad mode ${mode}`);
  const role = roleFor(ctx, f);
  const note = typeof f.note === 'string' ? f.note.trim().slice(0, 2000) : '';
  const brief: Brief = { ...(role ? { role } : {}), ...(note ? { text: note } : {}) };
  const common = {
    brief, rounds: num(f.rounds, 1, 20, 4), temperature: num(f.temperature, 0, 2, 0.6), think: !!f.think,
    ...(f.critic ? { critic: known(models, f.critic, 'critic', true) } : {}),
    render: f.render ?? 'auto', outDir: opts.outDir, signal: opts.signal, contract: 'auto' as const,
  };
  if (mode === 'compare') {
    const ms = (f.models ?? []).filter(Boolean).map((m) => known(models, m, 'designer'));
    if (ms.length < 2) throw new HttpError(400, 'compare needs two models');
    return { mode, ...common, models: ms, trials: num(f.trials, 1, 10, 2) };
  }
  if (!f.model) throw new HttpError(400, 'pick a designer model');
  const model = known(models, f.model, 'designer');
  if (mode === 'evolve') {
    return {
      mode, ...common, model, population: num(f.population, 1, 12, 3), keep: num(f.keep, 1, 6, 2), generations: num(f.generations, 1, 10, 2),
      ...(opts.start ? { seed: opts.start } : {}),
    };
  }
  if (!opts.start) return { mode: 'design', ...common, model };
  const text = blueprintToGrid(ctx, opts.start).text;
  const result = check(ctx, opts.start);
  const bc = role ? briefCheck(ctx, opts.start, role) : undefined;
  return {
    mode: 'design', ...common, model,
    start: { text, instruction: note || 'improve it for the brief', feedback: feedbackMessage({ result, brief: bc, maxItems: 6 }) },
  };
}
