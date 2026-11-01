// The shipgen page's HTTP routes. Everything the page shows is derived here from the live game data (legend, roles,
// library, checks) or streamed from the loop (server-sent events). Only answers requests addressed to localhost.
import type { IncomingMessage, ServerResponse } from 'http';
import { appendFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { serializeBlueprint } from '../../../common/src/ships/index';
import { type ShipgenContext, blueprintToGrid, check, loadRoles } from '../core/index';
import { type Llm, type ModelInfo, type Renderer, CONTRACTS, CONTRACT_IDS, autoContract, run as loopRun } from '../loop/index';
import { HttpError, json, readJson, sendFile } from './http';
import { labUrl, runLabExporter } from './lab';
import { blueprintFrom, listLibrary, loadLibrary, saveGenerated } from './library';
import { type RunForm, roleFor, runOptions } from './options';
import { legendRows, partCells } from './parts';
import type { Paths } from './paths';
import { type PageEvent, type RunFn, Runs } from './runs';
import { buildUp, renderTimelapse } from './timelapse';
import { listWatchRuns, watchStream } from './watch';

export interface AppDeps {
  ctx: ShipgenContext;
  llm: Llm;
  paths: Paths;
  /** The native renderer, started on first use (undefined: no renders) */
  getRenderer: () => Promise<Renderer | undefined>;
  runFn?: RunFn;
  exportLab?: (exporter: string, cwd: string) => Promise<string>;
  /** POST /api/quit (scripts stopping the server cleanly); absent: no such route */
  onQuit?: () => void;
  /** Settings the page can change, shared with the llm (server.ts): may LM Studio be asked (it loads the model there) */
  settings?: { lmstudioChat: boolean };
}

export interface App {
  handle(req: IncomingMessage, res: ServerResponse): void;
  runs: Runs;
  /** Stops any run and waits for it */
  close(): Promise<void>;
}

const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'ship';

const modelRow = (m: ModelInfo) => ({
  id: m.id, name: m.name, provider: m.provider, cloud: m.cloud, vision: m.vision, chat: m.chat, thinking: m.thinking, structured: m.structured, params: m.params,
  ...(m.off ? { off: m.off } : {}), auto: autoContract(m.id, m),
});

export function createApp(deps: AppDeps): App {
  const { ctx, llm, paths } = deps;
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
    return { bp, grid: enc.text, check: check(ctx, bp, { book: enc.book, weights: r?.weights as never }), cells: partCells(ctx, bp) };
  };

  async function startRun(form: RunForm & { startId?: string; startBp?: unknown }) {
    if (runs.active()) throw new HttpError(409, 'a run is going: stop it first');
    const start = form.startBp ? blueprintFrom(form.startBp) : form.startId ? loadLibrary(paths.blueprints, form.startId) : undefined;
    const ac = new AbortController();
    const id = runs.nextId();
    const outDir = join(paths.out, `${stamp()}-${form.mode ?? 'design'}-${slug(form.role ?? 'free')}-page`);
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
    return { id, outDir };
  }

  function events(req: IncomingMessage, res: ServerResponse, id: string, url: URL) {
    const r = runs.all.get(id);
    if (!r) throw new HttpError(404, `no run ${id}`);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const last = Number(req.headers['last-event-id'] ?? url.searchParams.get('after') ?? -1);
    let i = Number.isFinite(last) ? last + 1 : 0;
    const send = (e: PageEvent) => { res.write(`id: ${i++}\ndata: ${JSON.stringify(e)}\n\n`); };
    const end = () => { res.write('event: end\ndata: {}\n\n'); res.end(); };
    for (const e of r.events.slice(i)) send(e);
    if (r.status !== 'running') { end(); return; }
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    const listener = (e: PageEvent | null) => { if (e) send(e); else { clearInterval(ping); end(); } };
    r.listeners.add(listener);
    req.on('close', () => { clearInterval(ping); r.listeners.delete(listener); });
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const p = url.pathname, m = req.method ?? 'GET';
    if (!LOCAL_HOST.test(req.headers.host ?? '')) throw new HttpError(403, 'localhost only');
    if (m === 'POST' && req.headers.origin && !LOCAL_HOST.test(req.headers.origin.replace(/^https?:\/\//, ''))) throw new HttpError(403, 'cross-site request');

    if (m === 'GET' && p === '/api/models') {
      const list = await models(url.searchParams.has('fresh'));
      return json(res, 200, {
        models: list.map(modelRow), lmstudio: list.some((x) => x.provider === 'lmstudio'), lmstudioChat: settings.lmstudioChat,
        contracts: CONTRACT_IDS.map((id) => ({ id, label: CONTRACTS[id].label })),
      });
    }
    if (m === 'POST' && p === '/api/settings') {
      const b = await readJson(req);
      if (typeof b.lmstudioChat === 'boolean') settings.lmstudioChat = b.lmstudioChat;
      modelCache = null;
      return json(res, 200, { lmstudioChat: settings.lmstudioChat });
    }
    if (m === 'GET' && p === '/api/roles') return json(res, 200, { roles: loadRoles(ctx).roles });
    if (m === 'GET' && p === '/api/legend') return json(res, 200, { legend: legendRows(ctx) });
    if (m === 'GET' && p === '/api/library') return json(res, 200, { ships: listLibrary(paths.blueprints) });
    if (m === 'GET' && p.startsWith('/api/library/')) {
      return json(res, 200, designView(loadLibrary(paths.blueprints, decodeURIComponent(p.slice('/api/library/'.length))), url.searchParams.get('role') ?? undefined));
    }
    if (m === 'POST' && p === '/api/check') {
      const b = await readJson(req);
      return json(res, 200, designView(blueprintFrom(b.bp), b.role));
    }
    if (m === 'GET' && p === '/api/runs') {
      return json(res, 200, { runs: [...runs.all.values()].map((r) => ({ id: r.id, mode: r.mode, model: r.model, role: r.role, status: r.status, events: r.events.length, outDir: r.outDir })) });
    }
    if (m === 'POST' && p === '/api/runs') return json(res, 200, await startRun(await readJson(req)));
    const ev = /^\/api\/runs\/([\w-]+)\/(events|stop)$/.exec(p);
    if (ev && m === 'GET' && ev[2] === 'events') return events(req, res, ev[1], url);
    if (ev && m === 'POST' && ev[2] === 'stop') {
      const r = runs.all.get(ev[1]);
      if (!r) throw new HttpError(404, `no run ${ev[1]}`);
      r.ac.abort();
      return json(res, 200, { stopping: r.status === 'running' });
    }
    if (m === 'GET' && p === '/api/watch') return json(res, 200, { runs: listWatchRuns(paths.out) });
    if (m === 'GET' && p === '/api/watch/events') return watchStream(req, res, runs, paths.out, url);
    if (m === 'GET' && p === '/api/gallery') return json(res, 200, { gallery: runs.gallery });
    if (m === 'POST' && p === '/api/save') {
      const b = await readJson(req);
      const s = saveGenerated(ctx, paths.dev, blueprintFrom(b.bp), String(b.role || 'free'));
      return json(res, 200, { ...s, note: 'Restart the game server to see it in the F9 panel.' });
    }
    if (m === 'POST' && p === '/api/lab') {
      const b = await readJson(req);
      const bp = blueprintFrom(b.bp);
      const saved = b.saved ? { id: String(b.saved), name: bp.name, file: '' } : saveGenerated(ctx, paths.dev, bp, String(b.role || 'free'));
      const log = await exportLab(paths.exporter, paths.root);
      return json(res, 200, { url: labUrl(saved.name), saved, log: log.split('\n').slice(-3).join('\n') });
    }
    if (m === 'POST' && p === '/api/render') {
      const bp = blueprintFrom((await readJson(req)).bp);
      const renderer = await deps.getRenderer();
      if (!renderer) throw new HttpError(503, 'the native renderer is not available');
      const r = await renderer.render(bp, join(paths.out, 'stills', `${slug(bp.name)}-${stamp()}.png`));
      return json(res, 200, { url: runs.urlOf(r.path), ms: r.ms });
    }
    if (m === 'POST' && p === '/api/quit' && deps.onQuit) {
      json(res, 200, { quitting: true });
      deps.onQuit();
      return;
    }
    if (m === 'POST' && p === '/api/timelapse') {
      const b = await readJson(req);
      const bp = blueprintFrom(b.bp);
      const renderer = await deps.getRenderer();
      if (!renderer) throw new HttpError(503, 'the native renderer is not available');
      const dir = join(paths.out, 'timelapse', `${slug(bp.name)}-${stamp()}`);
      const t = await renderTimelapse(renderer, buildUp(ctx, bp, Number(b.maxFrames) || 80), dir);
      return json(res, 200, { dir: t.dir, ms: t.ms, frames: t.frames.map((f) => ({ url: runs.urlOf(f.file), stage: f.stage, parts: f.parts })) });
    }

    if (m !== 'GET' && m !== 'HEAD') throw new HttpError(404, 'not found');
    if (p.startsWith('/out/') && sendFile(res, paths.out, p.slice(5))) return;
    if (p.startsWith('/lab/') && /\.(html|js)$/.test(p) && sendFile(res, paths.lab, p.slice(5))) return;
    if (!p.startsWith('/out/') && !p.startsWith('/lab/') && !p.startsWith('/api/') && sendFile(res, paths.ui, p === '/' ? 'index.html' : p.slice(1))) return;
    throw new HttpError(404, 'not found');
  }

  return {
    runs,
    handle(req, res) {
      route(req, res).catch((e) => {
        const status = e instanceof HttpError ? e.status : 500;
        if (res.headersSent) { res.end(); return; }
        json(res, status, { error: (e as Error).message });
      });
    },
    async close() {
      const r = runs.active();
      if (r) { r.ac.abort(); await r.done; }
    },
  };
}
