// Watching runs that were not started from the app (the CLI writes out/**/events.jsonl as it goes): list them, and
// replay-then-follow one file, with the same enrichment the app's own runs get.
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'fs';
import { join, relative, sep } from 'path';
import type { ShipgenEvent } from '../loop/index';
import { EngineError, inside } from './errors';
import type { PageEvent, Runs } from './runs';

export interface WatchRun {
  /** Folder under out/, with forward slashes: what the stream route is asked for */
  id: string;
  mode?: string;
  model?: string;
  role?: string;
  /** ms since the epoch: the event file's last write */
  modified: number;
  finished: boolean;
  /** Not finished, and its file hasn't grown for STALE_MS: killed or crashed, most likely */
  stale?: boolean;
}

/** A run that writes nothing for this long (a round takes minutes at most) is taken as stopped */
export const STALE_MS = 15 * 60000;

// (A batch's saved ships hold no events; its attempts do, at <batch>/attempts/<NNN>-<role>[/refine])
const SKIP = new Set(['stills', 'timelapse', 'renders', 'designs', 'trace']);

function readRange(file: string, from: number, to: number): Buffer {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.max(0, to - from));
    const n = readSync(fd, buf, 0, buf.length, from);
    return buf.subarray(0, n);
  } finally { closeSync(fd); }
}

/** Every folder under `root` (a few levels deep) holding an events.jsonl, newest first */
export function listWatchRuns(root: string, maxDepth = 7): WatchRun[] {
  const found: WatchRun[] = [];
  const walk = (dir: string, depth: number) => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    const ev = join(dir, 'events.jsonl');
    if (names.includes('events.jsonl')) {
      try { found.push(describe(root, dir, ev, names.includes('metrics.json'))); } catch { /* (vanished) */ }
    }
    if (depth >= maxDepth) return;
    for (const n of names) {
      if (SKIP.has(n)) continue;
      const sub = join(dir, n);
      try { if (statSync(sub).isDirectory()) walk(sub, depth + 1); } catch { /* (vanished) */ }
    }
  };
  walk(root, 0);
  return found.sort((a, b) => b.modified - a.modified);
}

function describe(root: string, dir: string, ev: string, hasMetrics: boolean): WatchRun {
  const st = statSync(ev);
  const run: WatchRun = { id: relative(root, dir).split(sep).join('/'), modified: st.mtimeMs, finished: hasMetrics };
  const head = readRange(ev, 0, Math.min(st.size, 64 << 10)).toString('utf8');
  for (const line of head.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e.type === 'start') {
        run.mode = e.mode;
        run.model = Array.isArray(e.models) && e.models.length ? e.models.join(' vs ') : e.model;
        run.role = e.role;
      }
    } catch { /* (partial line) */ }
    break;
  }
  if (!run.finished) {
    const tail = readRange(ev, Math.max(0, st.size - 8192), st.size).toString('utf8');
    run.finished = /"type":"done"/.test(tail);
    if (!run.finished && Date.now() - st.mtimeMs > STALE_MS) run.stale = true;
  }
  return run;
}

export interface Follower { stop(): void }

/**
 * Reads a growing JSON-lines file from the start and then as it grows (polling its size): onEvent gets each complete
 * line's object, in order; a partial last line waits for the rest. A shrunk file starts over.
 */
export function followJsonl(file: string, onEvent: (e: ShipgenEvent) => void, intervalMs = 500): Follower {
  let pos = 0;
  let rest: Buffer = Buffer.alloc(0);
  const tick = () => {
    let size: number;
    try { size = statSync(file).size; } catch { return; }
    if (size < pos) { pos = 0; rest = Buffer.alloc(0); }
    if (size === pos) return;
    const chunk = readRange(file, pos, size);
    pos += chunk.length;
    let buf: Buffer = Buffer.concat([rest, chunk]);
    let nl: number;
    while ((nl = buf.indexOf(10)) >= 0) {
      const line = buf.subarray(0, nl).toString('utf8').trim();
      buf = buf.subarray(nl + 1);
      if (!line) continue;
      try { onEvent(JSON.parse(line)); } catch { /* (not an event) */ }
    }
    rest = Buffer.from(buf);
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  return { stop() { clearInterval(timer); } };
}

/** The events file of a listed run, or null when the id points outside out/ or has none */
export function watchFile(root: string, id: string): string | null {
  return inside(root, id.replace(/\/+$/, '') + '/events.jsonl');
}

/**
 * Follows one run's record: replays it, then each event as it is written, through `send`, until the run is done (or has
 * gone quiet for `staleMs`: it was stopped without finishing), then calls `onEnd` once. Returns a stopper.
 */
export function watchRun(runs: Runs, root: string, id: string, send: (e: PageEvent) => void, onEnd: () => void, intervalMs = 500, staleMs = STALE_MS): Follower {
  const file = id ? watchFile(root, id) : null;
  if (!file) throw new EngineError(404, `no run ${id}`);
  const enrich = runs.enricher();
  let ended = false;
  const follower = followJsonl(file, (e) => {
    if (ended) return;
    send(enrich(e));
    // (After this call returns: a finished file is read whole inside followJsonl's first tick, before `follower` is set)
    if (e.type === 'done') setImmediate(end);
  }, intervalMs);
  // (A run that never wrote 'done' and has gone quiet: say so and end, instead of polling for ever)
  const quiet = setInterval(() => {
    let m = 0;
    try { m = statSync(file).mtimeMs; } catch { /* (gone) */ }
    if (ended || Date.now() - m < staleMs) return;
    send({ type: 'error', message: `this run wrote nothing for ${Math.round(staleMs / 60000)} min and never finished: it was probably stopped`, fatal: true, t: 0 });
    end();
  }, Math.min(30000, Math.max(50, Math.floor(staleMs / 2))));
  const stop = () => { clearInterval(quiet); follower.stop(); };
  function end() { if (ended) return; ended = true; stop(); onEnd(); }
  return { stop() { ended = true; stop(); } };
}
