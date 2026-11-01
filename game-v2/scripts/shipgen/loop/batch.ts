// Batch (overnight) mode: loops over the roles round-robin, designing one ship at a time with a concept step and the build
// that works best for the role, refining each valid on-brief design with a few evolve generations, and saving the ones that
// pass under <out>/<role>/<NNN>-<slug>/ (blueprint, render, concept, metrics, check summary, the first valid draft). Rejected
// attempts are logged, not saved. A running summary.json and a static gallery index.html are rewritten after every ship.
// Every attempt writes its events as it goes to <out>/attempts/<NNN>-<role>/events.jsonl (the refinement's to refine/
// under it), so the page's Watch can follow it live, with trace.jsonl beside them; the log lines go to <out>/batch.log too.
// Built to run unattended: every error is caught and logged, a model server that is down is waited for with a growing
// delay, a stuck ship is cut off after a time cap, the renderer is restarted when it dies and closed on exit, a full disk
// stops the loop cleanly, and only small per-ship records are kept in memory. One model call at a time.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { spawn } from 'child_process';
import { type Blueprint, serializeBlueprint } from '../../../common/src/ships/index';
import { type Concept, briefCheck, check, conceptKey, conceptLine, findRole } from '../core/index';
import { type Attempt, type DesignOptions, type LoopDeps, passes } from './design';
import type { DesignMetrics, EvolveMetrics, ShipgenEvent } from './events';
import { run } from './run';
import type { Renderer } from './render';

/**
 * Which build works best per role (measured: TRIAL.md, and the staged runs since): the one-shot grid is fine for a ship of
 * about 20 parts; a bigger ship needs the staged build (a skeleton, then power, guns, engines, armour, outline). Roles not
 * listed get 'staged'. `--build oneshot|staged` overrides the table.
 */
export const BUILD_BY_ROLE: Record<string, 'oneshot' | 'staged'> = { starter: 'oneshot' };

/** The build for a role: the flag when it names one, else the table */
export const buildFor = (role: string, flag?: string): 'oneshot' | 'staged' => (flag === 'oneshot' || flag === 'staged' ? flag : BUILD_BY_ROLE[role] ?? 'staged');

export const DEFAULT_ROLES = ['starter', 'gunship', 'beam_frigate', 'missile_boat', 'hauler', 'capital'];

export interface BatchOptions {
  model: string;
  roles?: string[];
  build?: 'auto' | 'oneshot' | 'staged';
  outDir: string;
  stopFile?: string;
  maxShips?: number;
  notifyEveryMins?: number;
  /** Rounds a design may take (a staged build: tries per step) (default 5) */
  rounds?: number;
  /** Evolve generations of refinement after the first valid on-brief design (default 4; 0: none), population, survivors, patience (stop after this many generations without a better score) */
  generations?: number;
  population?: number;
  keep?: number;
  patience?: number;
  /** Minutes one ship may take, design and refinement together (default 45) */
  shipMinutes?: number;
  /** The concept step (default on) */
  concept?: boolean;
  /** A line of brief for every ship ("a long, narrow hull") */
  brief?: string;
  /** Let reasoning models think, with a reply budget that fits the loaded context (default on) */
  think?: boolean;
  temperature?: number;
  timeoutMs?: number;
  contract?: DesignOptions['contract'];
  mirror?: boolean;
  signal?: AbortSignal;
  /** Wait after a failed attempt: grows from baseMs by doubling up to capMs, then stays there (defaults 5 s, 5 min) */
  backoff?: { baseMs?: number; capMs?: number };
  /** How often the stop file is looked for while a ship is being designed (default 2 s) */
  stopPollMs?: number;
}

export interface BatchDeps extends LoopDeps {
  /** Starts a renderer (again, after it died); none: no renders */
  makeRenderer?: () => Promise<Renderer>;
  /** Waits (resolves early on abort) */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** A progress ping (default: scripts/notify.mjs); failures are ignored */
  notify?: (title: string, message: string) => Promise<void>;
  log?: (line: string) => void;
}

export interface RoleStats { attempts: number; saved: number }

export interface BatchSummary {
  started: string;
  updated: string;
  status: 'running' | 'stopped';
  stopReason?: string;
  model: string;
  roles: string[];
  attempts: number;
  saved: number;
  rejected: number;
  errors: number;
  perRole: Record<string, RoleStats>;
  /** saved / attempts */
  validRate: number;
  /** Wall-clock minutes of the saved ships' own work, on average; and of every attempt */
  avgMinutesPerShip: number | null;
  avgMinutesPerAttempt: number | null;
  elapsedMinutes: number;
  lastError?: string;
  lastSaved?: string;
}

/** What the gallery shows of a saved ship */
export interface ShipRecord {
  role: string;
  /** Folder relative to the output folder, forward slashes */
  dir: string;
  name: string;
  score: number;
  draftScore: number;
  parts: number;
  cells: number;
  concept?: string;
  minutes: number;
  generations: number;
  png: boolean;
  savedAt: string;
}

class ModelDownError extends Error {}

const sleepFor = (ms: number, signal?: AbortSignal) => new Promise<void>((ok) => {
  if (signal?.aborted) { ok(); return; }
  const t = setTimeout(done, ms);
  function done() { clearTimeout(t); signal?.removeEventListener('abort', done); ok(); }
  signal?.addEventListener('abort', done, { once: true });
});

/** The default progress ping: scripts/notify.mjs from game-v2, output ignored, never throws */
export function notifyViaScript(title: string, message: string): Promise<void> {
  return new Promise((ok) => {
    try {
      const p = spawn(process.execPath, ['--env-file=.env', 'scripts/notify.mjs', title, message], { cwd: join(__dirname, '../../..'), stdio: 'ignore', windowsHide: true });
      const t = setTimeout(() => { try { p.kill(); } catch { /* (gone) */ } ok(); }, 30000);
      p.on('exit', () => { clearTimeout(t); ok(); });
      p.on('error', () => { clearTimeout(t); ok(); });
    } catch { ok(); }
  });
}

const slugOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'ship';
const pad = (n: number) => String(n).padStart(3, '0');
const r1 = (x: number) => Math.round(x * 10) / 10;

/** The next number for a role's folder: one past the highest NNN- there */
export function nextNumber(roleDir: string): number {
  let max = 0;
  try { for (const d of readdirSync(roleDir)) { const m = /^(\d+)-/.exec(d); if (m) max = Math.max(max, Number(m[1])); } } catch { /* (no folder yet) */ }
  return max + 1;
}

/** Saved ships found on disk (a batch resumed in the same folder keeps its gallery) */
export function scanShips(outDir: string): ShipRecord[] {
  const out: ShipRecord[] = [];
  let roles: string[] = [];
  try { roles = readdirSync(outDir); } catch { return out; }
  for (const role of roles) {
    let dirs: string[] = [];
    try { dirs = readdirSync(join(outDir, role)); } catch { continue; }
    for (const d of dirs) {
      try {
        const m = JSON.parse(readFileSync(join(outDir, role, d, 'metrics.json'), 'utf8'));
        if (m?.record) out.push({ ...m.record, dir: `${role}/${d}` });
      } catch { /* (not a saved ship) */ }
    }
  }
  return out;
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** A static page (no external assets; opens from file://): a grid of the saved ships, newest first */
export function galleryHtml(ships: ShipRecord[], s: BatchSummary): string {
  const cards = [...ships].sort((a, b) => b.savedAt.localeCompare(a.savedAt)).map((x) => {
    const src = x.dir.split('/').map(encodeURIComponent).join('/');
    const gain = x.score - x.draftScore;
    return `<figure class="card">${x.png ? `<img src="${src}/render.png" alt="${esc(x.name)}" loading="lazy">` : '<div class="none">no render</div>'}
<figcaption><b>${esc(x.name)}</b> <span class="role">${esc(x.role)}</span>
<div>score <b>${x.score}</b>${x.generations ? ` <span class="muted">(draft ${x.draftScore}${gain > 0 ? `, +${r1(gain)}` : ''}, ${x.generations} gen)</span>` : ''}</div>
<div class="muted">${x.parts} parts, ${x.cells} cells, ${x.minutes} min</div>
${x.concept ? `<div class="concept">${esc(x.concept)}</div>` : ''}
<div class="muted"><a href="${src}/">${esc(x.dir)}</a></div></figcaption></figure>`;
  }).join('\n');
  const per = Object.entries(s.perRole).map(([r, v]) => `${esc(r)} ${v.saved}/${v.attempts}`).join(' &middot; ');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ship batch: ${esc(s.model)}</title>
<style>
body{font:14px/1.4 system-ui,sans-serif;margin:0;padding:16px;background:#10131a;color:#dfe5f0}
h1{font-size:18px;margin:0 0 4px}.muted{color:#8b95a8}.head{margin-bottom:16px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}
.card{margin:0;background:#1a1f2b;border:1px solid #2a3142;border-radius:6px;overflow:hidden}
.card img,.none{display:block;width:100%;aspect-ratio:1;object-fit:contain;background:#0b0d13}.none{display:grid;place-items:center;color:#8b95a8}
figcaption{padding:8px 10px}.role{color:#8b95a8;font-size:12px}.concept{margin-top:4px;font-size:12px}a{color:#7fb0ff}
</style></head><body>
<div class="head"><h1>Ship batch: ${esc(s.model)}</h1>
<div class="muted">${s.saved} saved in ${s.attempts} attempts (${Math.round(s.validRate * 100)}%) &middot; ${per} &middot; ${s.avgMinutesPerShip ?? '-'} min per ship &middot; updated ${esc(s.updated)} &middot; ${esc(s.status)}</div></div>
<div class="grid">
${cards || '<p class="muted">Nothing saved yet.</p>'}
</div></body></html>
`;
}

/** Writes a file by way of a temporary one, so a reader (or a crash) never sees half of it */
function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

interface Capture {
  concept?: Concept;
  done?: DesignMetrics | EvolveMetrics;
  modelErrors: number;
  lastModelError?: string;
  errors: string[];
  /** The design's steps, replies, grids and feedback, trimmed: written to the attempt's trace.jsonl, to see why one failed */
  trace: Record<string, unknown>[];
}

/** `events`: a file every event but the tokens is appended to as it comes (what the page's Watch follows) */
const capture = (events?: string): { cap: Capture; emit: (e: ShipgenEvent) => void } => {
  const cap: Capture = { modelErrors: 0, errors: [], trace: [] };
  const cut = (t: string, n: number) => (t.length > n ? `${t.slice(0, n / 2)}\n...\n${t.slice(-n / 2)}` : t);
  if (events) try { mkdirSync(dirname(events), { recursive: true }); } catch { events = undefined; }
  return {
    cap,
    // (Only what the batch needs: tokens, previews and the rest are dropped as they come, so memory stays flat)
    emit: (e) => {
      if (events && e.type !== 'token') try { appendFileSync(events, JSON.stringify(e) + '\n'); } catch { /* (the live record is a view only) */ }
      if (e.type === 'step') cap.trace.push({ type: e.type, step: e.step, status: e.status, round: e.round, note: e.note });
      else if (e.type === 'reply') cap.trace.push({ type: e.type, round: e.round, ms: e.ms, tokens: e.outputTokens, stop: e.stopReason, text: cut(e.text, 4000) });
      else if (e.type === 'grid' && !e.partial) cap.trace.push({ type: e.type, round: e.round, via: e.via, parts: e.parts, text: e.text, errors: e.errors.slice(0, 5) });
      else if (e.type === 'check') cap.trace.push({ type: e.type, round: e.round, valid: e.valid, score: e.score, unmet: e.brief?.unmet });
      else if (e.type === 'feedback') cap.trace.push({ type: e.type, round: e.round, text: cut(e.text, 3000) });
      if (e.type === 'concept') { cap.concept = e.concept; cap.trace.push({ type: e.type, line: e.line, note: e.note }); }
      else if (e.type === 'done') cap.done = e.metrics as DesignMetrics | EvolveMetrics;
      else if (e.type === 'error') {
        if (/^model:/.test(e.message)) { cap.modelErrors++; cap.lastModelError = e.message; }
        if (cap.errors.length < 10) cap.errors.push(e.message);
      }
    },
  };
};

export async function runBatch(deps: BatchDeps, o: BatchOptions): Promise<BatchSummary> {
  const now = deps.now ?? Date.now;
  const say = deps.log ?? ((l: string) => console.log(l));
  const log = (l: string) => {
    say(l);
    try { appendFileSync(join(o.outDir, 'batch.log'), `${new Date(now()).toISOString()} ${l}\n`); } catch { /* (no folder yet) */ }
  };
  const sleep = deps.sleep ?? sleepFor;
  const notify = deps.notify ?? notifyViaScript;
  const ctx = deps.ctx;
  const roles = (o.roles?.length ? o.roles : DEFAULT_ROLES).map((r) => r.trim()).filter(Boolean);
  for (const r of roles) if (!findRole(ctx, r)) throw new Error(`no role "${r}" in data/shipgen/roles.json`);
  // (A model listed but not to be asked (LM Studio while its chat is off): refuse before anything runs)
  deps.models ??= await deps.llm.list().catch(() => []);
  const mi = deps.models.find((x) => x.id === (o.model.includes('/') ? o.model : `ollama/${o.model}`));
  if (mi?.off) throw new Error(`${o.model}: ${mi.off} (asking it would load it there; set LMSTUDIO_CHAT=1)`);

  mkdirSync(o.outDir, { recursive: true });
  const startedAt = now();
  const master = new AbortController();
  const stopped = () => master.signal.aborted || !!o.signal?.aborted;
  const onOuter = () => master.abort();
  o.signal?.addEventListener('abort', onOuter, { once: true });
  if (o.signal?.aborted) master.abort();
  const stopFileSeen = () => !!o.stopFile && existsSync(o.stopFile);
  const watcher = setInterval(() => { if (stopFileSeen()) { stopReason ??= 'stop file'; master.abort(); } }, o.stopPollMs ?? 2000);
  watcher.unref?.();
  let stopReason: string | undefined;

  let renderer: Renderer | undefined = deps.renderer;
  const ownRenderer = !!deps.makeRenderer;
  const startRenderer = async () => {
    if (!deps.makeRenderer) return;
    try { renderer = await deps.makeRenderer(); } catch (e) { renderer = undefined; log(`[batch] no renderer: ${(e as Error).message}`); }
  };
  const stopRenderer = async () => {
    const r = renderer; renderer = undefined;
    if (r && ownRenderer) await Promise.race([r.close().catch(() => {}), new Promise((ok) => setTimeout(ok, 5000))]);
  };

  const ships = scanShips(o.outDir);
  const sum: BatchSummary = {
    started: new Date(startedAt).toISOString(), updated: new Date(startedAt).toISOString(), status: 'running', model: o.model, roles,
    attempts: 0, saved: 0, rejected: 0, errors: 0, perRole: Object.fromEntries(roles.map((r) => [r, { attempts: 0, saved: 0 }])),
    validRate: 0, avgMinutesPerShip: null, avgMinutesPerAttempt: null, elapsedMinutes: 0,
  };
  let shipMs = 0, attemptMs = 0;
  const used: string[] = ships.slice(-6).map((s) => s.concept ?? '').filter(Boolean).map((c) => c.replace(/^Concept /, ''));
  const writeSummary = () => {
    sum.updated = new Date(now()).toISOString();
    sum.elapsedMinutes = r1((now() - startedAt) / 60000);
    sum.validRate = sum.attempts ? Math.round((sum.saved / sum.attempts) * 1000) / 1000 : 0;
    sum.avgMinutesPerShip = sum.saved ? r1(shipMs / sum.saved / 60000) : null;
    sum.avgMinutesPerAttempt = sum.attempts ? r1(attemptMs / sum.attempts / 60000) : null;
    try {
      writeAtomic(join(o.outDir, 'summary.json'), JSON.stringify(sum, null, 2) + '\n');
      writeAtomic(join(o.outDir, 'index.html'), galleryHtml(ships, sum));
    } catch (e) { log(`[batch] could not write the summary: ${(e as Error).message}`); if (isDiskFull(e)) { stopReason ??= 'disk full'; master.abort(); } }
  };
  const logAttempt = (rec: Record<string, unknown>) => {
    try { appendFileSync(join(o.outDir, 'attempts.jsonl'), JSON.stringify({ at: new Date(now()).toISOString(), ...rec }) + '\n'); } catch (e) { if (isDiskFull(e)) { stopReason ??= 'disk full'; master.abort(); } }
  };
  const ping = async (title: string) => {
    const per = Object.entries(sum.perRole).map(([r, v]) => `${r} ${v.saved}`).join(', ');
    await notify(title, `${sum.saved} ships in ${sum.attempts} attempts (${Math.round(sum.validRate * 100)}%); ${per}; ${sum.avgMinutesPerShip ?? '-'} min/ship${sum.lastError ? `; last error: ${sum.lastError.slice(0, 120)}` : ''}`).catch(() => {});
  };

  let turn = 0, errorRun = 0, lastPing = now();
  const perRoleN: Record<string, number> = {};
  try {
    if (renderer === undefined) await startRenderer();
    log(`[batch] ${o.model}: roles ${roles.join(', ')} -> ${o.outDir}${o.stopFile ? ` (stop file ${o.stopFile})` : ''}`);
    while (!stopped() && !stopFileSeen() && (o.maxShips === undefined || sum.saved < o.maxShips)) {
      const role = roles[turn % roles.length];
      const n = (perRoleN[role] = (perRoleN[role] ?? 0) + 1);
      turn++;
      sum.attempts++; sum.perRole[role].attempts++;
      const t0 = now();
      try {
        const res = await oneShip(role, sum.attempts, n);
        attemptMs += now() - t0;
        if (res === 'saved') { sum.saved++; sum.perRole[role].saved++; shipMs += now() - t0; errorRun = 0; } else { sum.rejected++; errorRun = 0; }
      } catch (e) {
        attemptMs += now() - t0;
        sum.errors++;
        const msg = (e as Error).message ?? String(e);
        sum.lastError = `${role}: ${msg}`;
        log(`[batch] ${role}: error: ${msg}`);
        logAttempt({ n: sum.attempts, role, outcome: 'error', error: msg });
        if (isDiskFull(e)) { stopReason = 'disk full'; master.abort(); } else if (!stopped()) {
          errorRun++;
          const base = o.backoff?.baseMs ?? 5000, cap = o.backoff?.capMs ?? 300000;
          const wait = Math.min(cap, base * 2 ** Math.min(20, errorRun - 1));
          log(`[batch] waiting ${Math.round(wait / 1000)} s${e instanceof ModelDownError ? ' (model server not answering)' : ''} before the next try`);
          writeSummary();
          await sleep(wait, master.signal);
        }
      }
      writeSummary();
      if (o.notifyEveryMins && now() - lastPing >= o.notifyEveryMins * 60000) { lastPing = now(); await ping('Ship batch'); }
    }
    stopReason ??= stopFileSeen() ? 'stop file' : o.signal?.aborted || master.signal.aborted ? 'interrupted' : o.maxShips !== undefined && sum.saved >= o.maxShips ? `${o.maxShips} ships` : 'done';
  } finally {
    clearInterval(watcher);
    o.signal?.removeEventListener('abort', onOuter);
    await stopRenderer();
    sum.status = 'stopped';
    sum.stopReason = stopReason ?? 'stopped';
    writeSummary();
    if (o.notifyEveryMins !== undefined) await ping(`Ship batch stopped (${sum.stopReason})`);
    log(`[batch] stopped (${sum.stopReason}): ${sum.saved} saved in ${sum.attempts} attempts`);
  }
  return sum;

  /** One ship: concept and design, refinement, then saved when it passes. 'saved' or 'rejected'; throws for a model that is down or any other fault */
  async function oneShip(role: string, no: number, perRole: number): Promise<'saved' | 'rejected'> {
    const t0 = now();
    const build = buildFor(role, o.build);
    const cap = new AbortController();
    const timer = setTimeout(() => cap.abort(), (o.shipMinutes ?? 45) * 60000);
    timer.unref?.();
    const signal = AbortSignal.any([master.signal, cap.signal]);
    try {
      const common = {
        model: o.model, brief: { role, ...(o.brief ? { text: o.brief } : {}) }, signal, temperature: o.temperature, timeoutMs: o.timeoutMs, contract: o.contract, mirror: o.mirror,
        think: o.think !== false, generous: true, render: 'off' as const,
      };
      // ---- Design: concept step, then the build
      const attempts = join(o.outDir, 'attempts');
      const adir = join(attempts, `${pad(nextNumber(attempts))}-${role}`);
      const d = capture(join(adir, 'events.jsonl'));
      const dr = await run(deps, {
        mode: 'design', ...common, build, rounds: o.rounds ?? 5, concept: o.concept !== false, conceptSeed: no, usedConcepts: used, shapeIndex: perRole - 1,
      }, d.emit);
      if (dr.mode !== 'design') throw new Error('mode');
      const out = dr.outcome;
      try { mkdirSync(adir, { recursive: true }); writeFileSync(join(adir, 'trace.jsonl'), d.cap.trace.map((x) => JSON.stringify(x)).join('\n') + '\n'); } catch { /* (a trace is a diagnostic only) */ }
      const concept = out.concept ?? d.cap.concept;
      if (concept) { used.push(conceptKey(concept)); if (used.length > 6) used.shift(); }
      if (!out.attempts.length && !stopped()) throw new ModelDownError(d.cap.lastModelError ?? 'the model gave no reply');
      const metrics = d.cap.done as DesignMetrics | undefined;
      const draft = out.best;
      const ok = !!draft?.bp && passes(draft) && metrics?.valid !== false;
      if (!ok || !draft?.bp) {
        const why = draft ? [...(draft.brief?.unmet ?? []), ...(draft.valid ? [] : [`invalid (${draft.result?.errors[0]?.message ?? '?'})`])].slice(0, 4) : ['nothing readable'];
        log(`[batch] ${role}: rejected (${why.join('; ')})`);
        logAttempt({ n: no, role, build, outcome: 'rejected', why, valid: !!draft?.valid, score: draft?.score ?? 0, minutes: r1((now() - t0) / 60000), concept: concept && conceptLine(concept) });
        return 'rejected';
      }
      // ---- Refinement: evolve from the draft, the concept kept, until the score stops improving
      let best: Attempt = draft;
      let gens = 0, draftScore = draft.score, children = 0;
      const G = o.generations ?? 4;
      if (G > 0 && !signal.aborted) {
        const e = capture(join(adir, 'refine', 'events.jsonl'));
        try {
          const er = await run(deps, {
            mode: 'evolve', ...common, build: 'oneshot', seed: draft.bp, generations: G, population: o.population ?? 3, keep: o.keep ?? 2, patience: o.patience ?? 2,
            shapeHints: true, childRounds: 3, concept: concept ?? false, rngSeed: no,
          }, e.emit);
          if (er.mode === 'evolve') {
            const em = er.outcome.metrics;
            gens = em.generations; children = em.children;
            draftScore = em.bestByGen[0] ?? draftScore;
            const top = er.outcome.best?.a;
            if (top?.bp && passes(top) && top.valid && top.score >= draftScore) best = top;
          }
        } catch (err) {
          // (The draft stands: refinement is a bonus)
          log(`[batch] ${role}: refinement failed (${(err as Error).message}); keeping the draft`);
        }
      }
      if (!best.bp) return 'rejected';
      // ---- Save
      const minutes = r1((now() - t0) / 60000);
      const rec = await save(role, no, best, draft, { concept, build, minutes, gens, children, draftScore, rounds: metrics?.rounds ?? out.attempts.length, designMetrics: metrics, cappedByTime: cap.signal.aborted });
      log(`[batch] ${role}: saved ${rec.dir} "${rec.name}" score ${rec.score}${rec.generations ? ` (draft ${rec.draftScore})` : ''}, ${minutes} min`);
      logAttempt({ n: no, role, build, outcome: 'saved', dir: rec.dir, score: rec.score, draftScore: rec.draftScore, minutes, concept: rec.concept });
      sum.lastSaved = rec.dir;
      return 'saved';
    } finally {
      clearTimeout(timer);
    }
  }

  async function renderTo(bp: Blueprint, path: string): Promise<boolean> {
    for (let tries = 0; tries < 2; tries++) {
      if (!renderer) await startRenderer();
      if (!renderer) return false;
      try { await renderer.render(bp, path); return true; } catch (e) {
        if (isDiskFull(e)) throw e;
        log(`[batch] render failed (${(e as Error).message}); restarting the renderer`);
        await stopRenderer();
        renderer = undefined;
        if (!deps.makeRenderer) return false;
      }
    }
    return false;
  }

  async function save(role: string, no: number, best: Attempt, draft: Attempt, x: { concept?: Concept; build: string; minutes: number; gens: number; children: number; draftScore: number; rounds: number; designMetrics?: DesignMetrics; cappedByTime: boolean }): Promise<ShipRecord> {
    const roleDir = join(o.outDir, role);
    mkdirSync(roleDir, { recursive: true });
    // (A ship the model left "Untitled" takes its concept's name)
    const named = (bp: Blueprint) => (/^untitled$/i.test(bp.name.trim()) && x.concept && x.concept.name !== 'Untitled' ? { ...bp, name: x.concept.name } : bp);
    const bp = named(best.bp!);
    const dir = join(roleDir, `${pad(nextNumber(roleDir))}-${slugOf(bp.name)}`);
    mkdirSync(dir, { recursive: true });
    const res = best.result ?? check(ctx, bp);
    const role_ = findRole(ctx, role);
    const bc = role_ ? briefCheck(ctx, bp, role_) : undefined;
    const cells = res.stats.cells;
    writeFileSync(join(dir, 'blueprint.json'), serializeBlueprint(bp) + '\n');
    const png = await renderTo(bp, join(dir, 'render.png'));
    if (x.concept) writeFileSync(join(dir, 'concept.json'), JSON.stringify({ ...x.concept, line: conceptLine(x.concept) }, null, 2) + '\n');
    if (best !== draft && draft.bp) {
      writeFileSync(join(dir, 'draft.json'), serializeBlueprint(named(draft.bp)) + '\n');
      await renderTo(named(draft.bp), join(dir, 'draft.png'));
    }
    writeFileSync(join(dir, 'check.json'), JSON.stringify({
      valid: res.valid, score: res.score, errors: res.errors.slice(0, 10).map((e) => e.message), stats: res.stats,
      power: res.power ? { generation: res.power.generation, storage: res.power.storage, unpowered: res.power.unpowered.length, thrust: res.power.thrust } : undefined,
      brief: bc ? { unmet: bc.unmet, missing: bc.missing } : undefined, scores: res.scores,
    }, null, 2) + '\n');
    const rec: ShipRecord = {
      role, dir: `${role}/${dir.split(/[\\/]/).pop()}`, name: bp.name, score: best.score, draftScore: x.gens ? x.draftScore : best.score, parts: bp.parts.length, cells,
      ...(x.concept ? { concept: conceptLine(x.concept).replace(/^Concept /, '') } : {}), minutes: x.minutes, generations: x.gens, png, savedAt: new Date(now()).toISOString(),
    };
    writeFileSync(join(dir, 'metrics.json'), JSON.stringify({
      record: rec, role, model: o.model, build: x.build, minutes: x.minutes, rounds: x.rounds, generations: x.gens, children: x.children,
      scoreBeforeRefinement: rec.draftScore, scoreAfterRefinement: rec.score, improvement: r1(rec.score - rec.draftScore), cappedByTime: x.cappedByTime,
      concept: x.concept, design: x.designMetrics, attempt: no,
    }, null, 2) + '\n');
    ships.push(rec);
    return rec;
  }
}

function isDiskFull(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOSPC' || code === 'EDQUOT';
}
