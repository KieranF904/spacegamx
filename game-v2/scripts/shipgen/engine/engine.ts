// The shipgen engine: everything the desktop app asks of the generator, as calls (call(cmd, args) -> result) and a stream
// of messages (runs' and watched runs' events). No transport here: main.ts speaks it over stdin/stdout as JSON lines.
// Everything shown is derived from the live game data (legend, roles, library, checks) or streamed from the loop.
// The renderer is started with the engine (or a running one is used) and closed with it, if the engine started it.
import { appendFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { serializeBlueprint } from '../../../common/src/ships/index';
import { type ShipgenContext, blueprintToGrid, check, loadRoles, roleCheckOptions } from '../core/index';
import { type Llm, type ModelInfo, type Renderer, CONTRACTS, CONTRACT_IDS, autoContract, run as loopRun, runBatch } from '../loop/index';
import { EngineError } from './errors';
import { labUrl, runLabExporter } from './lab';
import { blueprintFrom, listLibrary, loadLibrary, saveGenerated } from './library';
import { type RunForm, batchOptions, roleFor, runOptions } from './options';
import { legendRows, partCells } from './parts';
import type { Paths } from './paths';
import { type PageEvent, type RunFn, Runs } from './runs';
import { listSavedShips, rateShip } from './ships';
import { buildUp, renderTimelapse } from './timelapse';
import { type Follower, listWatchRuns, watchRun } from './watch';

export interface EngineDeps {
  ctx: ShipgenContext;
  llm: Llm;
  paths: Paths;
  /** The renderer, started on first use or at once (undefined: no renders) */
  getRenderer: () => Promise<Renderer | undefined>;
  runFn?: RunFn;
  exportLab?: (exporter: string, cwd: string) => Promise<string>;
  /** Settings the app can change, shared with the llm: may LM Studio be asked (it loads the model there) */
  settings?: { lmstudioChat: boolean };
  /** Every message: a run's event, a watched run's event, or the end of either */
  send: (m: EngineMessage) => void;
  /** Ms between reads of a watched run's record, and the quiet after which an unfinished one counts as stopped */
  watchIntervalMs?: number;
  watchStaleMs?: number;
}

export type EngineMessage =
  | { type: 'event'; channel: 'run' | 'watch'; id: string; e: PageEvent }
  | { type: 'end'; channel: 'run' | 'watch'; id: string; status?: string };

export interface Engine {
  call(cmd: string, args?: Record<string, any>): Promise<unknown>;
  runs: Runs;
  /** Stops any run and any watch, and waits for the run */
  close(): Promise<void>;
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'ship';

const modelRow = (m: ModelInfo) => ({
  id: m.id, name: m.name, provider: m.provider, cloud: m.cloud, vision: m.vision, chat: m.chat, thinking: m.thinking, structured: m.structured, params: m.params,
  ...(m.off ? { off: m.off } : {}), auto: autoContract(m.id, m),
});

export function createEngine(deps: EngineDeps): Engine {
  const { ctx, llm, paths, send } = deps;
  const settings = deps.settings ?? { lmstudioChat: false };
  const runs = new Runs(ctx, paths.out, deps.runFn ?? loopRun);
  const exportLab = deps.exportLab ?? runLabExporter;
  let modelCache: { at: number; list: ModelInfo[] } | null = null;
  const models = async (fresh = false) => {
    if (!fresh && modelCache && Date.now() - modelCache.at < 5000) return modelCache.list;
    const list = await llm.list().catch(() => [] as ModelInfo[]);
    modelCache = { at: Date.now(), list };
    return list;
  };

  const designView = (bp: ReturnType<typeof blueprintFrom>, role?: string) => {
    const r = role ? roleFor(ctx, { role }) : undefined;
    const enc = blueprintToGrid(ctx, bp);
    return { bp, grid: enc.text, check: check(ctx, bp, { book: enc.book, ...(roleCheckOptions(r, true) as object) }), cells: partCells(ctx, bp) };
  };

  // (The slot is taken before the first await: two starts at once can't both pass the check)
  let starting = false;
  let timelapses = 0;
  const busy = () => starting || !!runs.active() || timelapses > 0;

  /** A run's events go out as they come, and its end once it is over */
  function stream(id: string) {
    const r = runs.all.get(id)!;
    r.listeners.add((e) => {
      if (e) send({ type: 'event', channel: 'run', id, e });
      else send({ type: 'end', channel: 'run', id, status: r.status });
    });
  }

  async function startRun(form: RunForm & { startId?: string; startBp?: unknown }) {
    if (busy()) throw new EngineError(409, 'a run is going: stop it first');
    starting = true;
    try { return await (form.mode === 'batch' ? startBatch(form) : startDesign(form)); } finally { starting = false; }
  }

  /** A batch: the same loop as the CLI's --mode batch, as one run (each ship's events in its own lane) */
  async function startBatch(form: RunForm) {
    const ac = new AbortController();
    const id = runs.nextId();
    const list = await models(true);
    const outDir = join(paths.out, 'runs', `${stamp()}-batch-${slug((form.model ?? 'model').split('/').pop() ?? 'model')}-${id}-app`);
    const o = batchOptions(ctx, form, list, { outDir, signal: ac.signal });
    mkdirSync(outDir, { recursive: true });
    const renderer = await deps.getRenderer();
    runs.startJob({ id, ac, outDir, mode: 'batch', model: o.model, role: o.roles!.join('+') }, (emit) => runBatch({ ctx, llm, models: list, renderer, tap: emit, log: (l) => console.error(l), notify: async () => {} }, o));
    stream(id);
    return { id, outDir };
  }

  async function startDesign(form: RunForm & { startId?: string; startBp?: unknown }) {
    const start = form.startBp ? blueprintFrom(form.startBp) : form.startId ? loadLibrary(paths.blueprints, form.startId) : undefined;
    const ac = new AbortController();
    const id = runs.nextId();
    const outDir = join(paths.out, 'runs', `${stamp()}-${form.mode ?? 'design'}-${slug(form.role ?? 'free')}-${id}-app`);
    const list = await models(true);
    const o = runOptions(ctx, form, list, { outDir, signal: ac.signal, start });
    mkdirSync(outDir, { recursive: true });
    const renderer = o.render === 'off' ? undefined : await deps.getRenderer();
    const r = runs.start({ ctx, llm, models: list, renderer }, o, { id, ac, outDir });
    // (A record on disk, like the CLI's: events without tokens, and the designs that came best)
    const log = join(outDir, 'events.jsonl');
    r.listeners.add((e) => {
      if (!e || e.type === 'token') return;
      try {
        const { cells: _c, ...rest } = e as PageEvent;
        appendFileSync(log, JSON.stringify(rest) + '\n');
        if (e.type === 'best') {
          mkdirSync(join(outDir, 'designs'), { recursive: true });
          writeFileSync(join(outDir, 'designs', `${slug(`${e.lane ?? ''}-best`)}.json`), serializeBlueprint(e.bp));
        }
        if (e.type === 'done') writeFileSync(join(outDir, 'metrics.json'), JSON.stringify(e.metrics, null, 2) + '\n');
      } catch { /* (the record is a convenience) */ }
    });
    stream(id);
    return { id, outDir };
  }

  /** Command-line runs being followed: one at a time (a new watch ends the last) */
  let watching: { id: string; f: Follower } | null = null;
  function watch(id: string) {
    unwatch();
    const f = watchRun(runs, paths.out, id, (e) => send({ type: 'event', channel: 'watch', id, e }), () => {
      if (watching?.id === id) watching = null;
      send({ type: 'end', channel: 'watch', id });
    }, deps.watchIntervalMs, deps.watchStaleMs);
    watching = { id, f };
    return { watching: id };
  }
  function unwatch() {
    if (!watching) return;
    const w = watching;
    watching = null;
    w.f.stop();
  }

  const calls: Record<string, (a: Record<string, any>) => unknown> = {
    info: () => ({ roles: loadRoles(ctx).roles, legend: legendRows(ctx), library: listLibrary(paths.blueprints), contracts: CONTRACT_IDS.map((id) => ({ id, label: CONTRACTS[id].label })), out: paths.out }),
    models: async (a) => {
      const list = await models(!!a.fresh);
      return { models: list.map(modelRow), lmstudio: list.some((x) => x.provider === 'lmstudio'), lmstudioChat: settings.lmstudioChat };
    },
    settings: (a) => {
      if (typeof a.lmstudioChat === 'boolean') settings.lmstudioChat = a.lmstudioChat;
      modelCache = null;
      return { lmstudioChat: settings.lmstudioChat };
    },
    library: (a) => designView(loadLibrary(paths.blueprints, String(a.id ?? '')), a.role),
    check: (a) => designView(blueprintFrom(a.bp), a.role),
    runs: () => ({ runs: [...runs.all.values()].map((r) => ({ id: r.id, mode: r.mode, model: r.model, role: r.role, status: r.status, events: r.events.length, outDir: r.outDir })) }),
    start: (a) => startRun(a.form ?? {}),
    stop: (a) => {
      const r = runs.all.get(String(a.id));
      if (!r) throw new EngineError(404, `no run ${a.id}`);
      r.ac.abort();
      return { stopping: r.status === 'running' };
    },
    /** A run's stored events so far (a view opened late), then its live ones keep coming as messages */
    replay: (a) => {
      const r = runs.all.get(String(a.id));
      if (!r) throw new EngineError(404, `no run ${a.id}`);
      return { status: r.status, events: r.events };
    },
    watchList: () => ({ runs: listWatchRuns(paths.out) }),
    watch: (a) => watch(String(a.id ?? '')),
    unwatch: () => { unwatch(); return {}; },
    gallery: () => ({ gallery: runs.gallery }),
    ships: () => ({ ships: listSavedShips(paths.out) }),
    rate: (a) => { try { return rateShip(paths.out, String(a.dir ?? ''), Number(a.rating)); } catch (e) { throw new EngineError(400, (e as Error).message); } },
    save: (a) => ({ ...saveGenerated(ctx, paths.dev, blueprintFrom(a.bp), String(a.role || 'free')), note: 'Restart the game server to see it in the F9 panel.' }),
    lab: async (a) => {
      const bp = blueprintFrom(a.bp);
      const saved = a.saved ? { id: String(a.saved), name: bp.name, file: '' } : saveGenerated(ctx, paths.dev, bp, String(a.role || 'free'));
      const log = await exportLab(paths.exporter, paths.root);
      return { url: labUrl(paths.lab, saved.name), saved, log: log.split('\n').slice(-3).join('\n') };
    },
    render: async (a) => {
      if (busy()) throw new EngineError(409, 'a run is going: stills wait for it');
      const bp = blueprintFrom(a.bp);
      const renderer = await deps.getRenderer();
      if (!renderer) throw new EngineError(503, 'the renderer is not available');
      const r = await renderer.render(bp, join(paths.out, 'stills', `${slug(bp.name)}-${stamp()}.png`));
      return { file: r.path, ms: r.ms };
    },
    timelapse: async (a) => {
      const bp = blueprintFrom(a.bp);
      // (Not alongside a model run or another timelapse: they share the GPU and the render queue)
      if (busy()) throw new EngineError(409, 'a run or a timelapse is going: wait for it');
      timelapses++;
      try {
        const renderer = await deps.getRenderer();
        if (!renderer) throw new EngineError(503, 'the renderer is not available');
        const dir = join(paths.out, 'timelapse', `${slug(bp.name)}-${stamp()}`);
        const t = await renderTimelapse(renderer, buildUp(ctx, bp, Number(a.maxFrames) || 80), dir);
        return { dir: t.dir, ms: t.ms, frames: t.frames.map((f) => ({ file: f.file, stage: f.stage, parts: f.parts })) };
      } finally { timelapses--; }
    },
  };

  return {
    runs,
    async call(cmd, args = {}) {
      const f = calls[cmd];
      if (!f) throw new EngineError(404, `no command ${cmd}`);
      return f(args);
    },
    async close() {
      unwatch();
      const r = runs.active();
      if (r) { r.ac.abort(); await r.done; }
    },
  };
}
