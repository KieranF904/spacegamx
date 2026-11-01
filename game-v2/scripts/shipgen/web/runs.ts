// Runs started from the page: one at a time (they share the GPU). Each keeps every event (so a page that opens late, or
// reconnects, replays them) and passes them on to listeners, with what the page needs added: picture URLs instead of
// file paths, and each part's cells on a check (for the energy overlay). The best designs go to a gallery.
import { relative, resolve, sep } from 'path';
import type { Blueprint } from '../../../common/src/ships/index';
import type { ShipgenContext } from '../core/index';
import type { LoopDeps, RunOptions, RunOutcome, ShipgenEvent } from '../loop/index';
import { partCells } from './parts';

export type PageEvent = ShipgenEvent & { url?: string; cells?: Record<number, [number, number][]> };

export interface GalleryItem {
  key: string;
  run: string;
  lane?: string;
  name: string;
  score: number;
  valid: boolean;
  url?: string;
  bp: Blueprint;
  model: string;
  role?: string;
  mode: string;
}

export interface Run {
  id: string;
  mode: string;
  model: string;
  role?: string;
  outDir: string;
  events: PageEvent[];
  status: 'running' | 'done' | 'failed' | 'stopped';
  ac: AbortController;
  listeners: Set<(e: PageEvent | null) => void>;
  done: Promise<RunOutcome | undefined>;
}

export type RunFn = (deps: LoopDeps, o: RunOptions, emit: (e: ShipgenEvent) => void) => Promise<RunOutcome>;

export class Runs {
  readonly all = new Map<string, Run>();
  readonly gallery: GalleryItem[] = [];
  private n = 0;

  constructor(private ctx: ShipgenContext, private outRoot: string, private runFn: RunFn) {}

  active(): Run | undefined {
    return [...this.all.values()].find((r) => r.status === 'running');
  }

  /** A file under the output folder as a page URL */
  urlOf(path: string): string | undefined {
    const rel = relative(resolve(this.outRoot), resolve(path));
    if (!rel || rel.startsWith('..') || rel.includes(`..${sep}`)) return undefined;
    return '/out/' + rel.split(sep).map(encodeURIComponent).join('/');
  }

  /** What the page needs added to each event of one run (call per run: it remembers the last design per lane) */
  enricher(onBest?: (e: Extract<ShipgenEvent, { type: 'best' }>, url?: string) => void): (e: ShipgenEvent) => PageEvent {
    const lastBp = new Map<string, Blueprint>();
    return (e) => {
      const pe: PageEvent = { ...e };
      const lane = e.lane ?? '';
      if (e.type === 'grid' && !e.partial) { if (e.bp) lastBp.set(lane, e.bp); else lastBp.delete(lane); }
      if (e.type === 'check') { const bp = lastBp.get(lane); if (bp) pe.cells = partCells(this.ctx, bp); }
      if (e.type === 'render') pe.url = this.urlOf(e.path);
      if (e.type === 'best') {
        if (e.renderPath) pe.url = this.urlOf(e.renderPath);
        onBest?.(e, pe.url);
      }
      return pe;
    };
  }

  start(deps: LoopDeps, o: RunOptions, meta: { id: string; ac: AbortController; outDir: string }): Run {
    const model = o.mode === 'compare' ? o.models.join(' vs ') : o.model;
    const role = typeof o.brief.role === 'string' ? o.brief.role : o.brief.role?.id;
    const run: Run = {
      id: meta.id, mode: o.mode, model, role, outDir: meta.outDir, events: [], status: 'running', ac: meta.ac, listeners: new Set(),
      done: Promise.resolve(undefined),
    };
    this.all.set(run.id, run);
    const enrich = this.enricher((e, url) => this.addToGallery(run, e, url));
    const emit = (e: ShipgenEvent) => {
      const pe = enrich(e);
      run.events.push(pe);
      for (const l of run.listeners) l(pe);
    };
    run.done = this.runFn(deps, o, emit).then(
      (r) => { run.status = meta.ac.signal.aborted ? 'stopped' : 'done'; return r; },
      (err) => {
        run.status = meta.ac.signal.aborted ? 'stopped' : 'failed';
        if (!run.events.some((e) => e.type === 'error' && e.fatal)) emit({ type: 'error', message: (err as Error).message, fatal: true, t: 0 });
        return undefined;
      },
    ).finally(() => { for (const l of run.listeners) l(null); run.listeners.clear(); });
    return run;
  }

  nextId(): string {
    return `${Date.now().toString(36)}-${++this.n}`;
  }

  private addToGallery(run: Run, e: Extract<ShipgenEvent, { type: 'best' }>, url?: string): void {
    const key = `${run.id}|${e.lane ?? ''}`;
    const item: GalleryItem = {
      key, run: run.id, lane: e.lane, name: e.name, score: e.score, valid: e.valid, url, bp: e.bp,
      model: run.mode === 'compare' ? (e.lane ?? '').replace(/ t\d+$/, '') : run.model, role: run.role, mode: run.mode,
    };
    const i = this.gallery.findIndex((g) => g.key === key);
    if (i >= 0) this.gallery[i] = item; else this.gallery.push(item);
    this.gallery.sort((a, b) => Number(b.valid) - Number(a.valid) || b.score - a.score);
    if (this.gallery.length > 40) this.gallery.length = 40;
  }
}
