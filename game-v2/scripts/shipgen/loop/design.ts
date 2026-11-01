// One design, talked through with a model: generate -> read the grid -> check -> feedback -> retry, for up to N rounds,
// keeping the best by score. Optionally renders each design (native renderer) and has a vision model score its looks.
import { join } from 'path';
import type { Blueprint } from '../../../common/src/ships/index';
import {
  type Brief, type BriefCheck, type CheckResult, type Role, type ShipgenContext,
  CodeBook, briefCheck, briefLegend, briefText, check, feedbackMessage, findRole, gridToBlueprint, systemPrompt,
} from '../core/index';
import type { Emit } from './events';
import type { ChatMessage, Llm, ModelInfo } from './llm';
import { AbortedError } from './llm';
import { CONTRACT_TEXT, type Contract, DESIGN_SCHEMA, extractDesign, partialGrid } from './reply';
import type { Renderer } from './render';
import { critique } from './critic';

export interface LoopDeps {
  ctx: ShipgenContext;
  llm: Llm;
  renderer?: Renderer;
  /** The model list (else asked of llm once) */
  models?: ModelInfo[];
  now?: () => number;
  /** Shared across a run: render times, and whether renders are slow enough to keep for valid designs */
  renderStats?: { ms: number[]; slow: boolean };
}

export interface DesignOptions {
  model: string;
  brief: Brief;
  /** Rounds (model replies) at most (default 4) */
  rounds?: number;
  /** json (a schema, where the model takes one), text (grid between markers), auto (json if the model takes a schema) */
  contract?: Contract | 'auto';
  temperature?: number;
  think?: boolean;
  /** Past exchanges kept in the conversation (default 2; the system prompt and the first ask always stay) */
  keepRounds?: number;
  numCtx?: number;
  maxTokens?: number;
  timeoutMs?: number;
  idleMs?: number;
  /** Stop at the first valid design that meets the brief (compare); always stop once one scores `target` (default 92) */
  stopWhenValid?: boolean;
  target?: number;
  /** A vision model to score looks, and its weight in the score (default 0.1) */
  critic?: string;
  criticWeight?: number;
  /** off | valid | all | auto (all while a still takes under slowRenderMs, valid ones after) (default auto) */
  render?: 'off' | 'valid' | 'all' | 'auto';
  slowRenderMs?: number;
  /** Where renders go (no outDir: no renders) */
  outDir?: string;
  /** File-name prefix for renders */
  tag?: string;
  signal?: AbortSignal;
  /** Begin from a design (evolve): its grid, the change to make, and its check */
  start?: { text: string; instruction: string; feedback?: string };
}

export interface Attempt {
  round: number;
  reply: string;
  gridText: string | null;
  bp?: Blueprint;
  result?: CheckResult;
  brief?: BriefCheck;
  valid: boolean;
  /** Final score (check, less brief penalty, blended with looks) */
  score: number;
  looks?: number | null;
  reason?: string;
  renderPath?: string;
  ms: number;
  outputTokens?: number;
  tokensPerSec?: number;
}

export interface DesignOutcome {
  attempts: Attempt[];
  best?: Attempt;
  firstValidRound: number | null;
  /** First round valid and meeting the brief (a copy of the worked example, or a ship the wrong size, doesn't) */
  firstPassRound: number | null;
  unreadable: number;
  cancelled: boolean;
  ms: number;
}

export function roleOf(ctx: ShipgenContext, brief: Brief): Role | undefined {
  return !brief.role ? undefined : typeof brief.role === 'string' ? findRole(ctx, brief.role) : brief.role;
}

export async function contractFor(deps: LoopDeps, model: string, pref: DesignOptions['contract'] = 'auto'): Promise<Contract> {
  if (pref === 'json' || pref === 'text') return pref;
  deps.models ??= await deps.llm.list().catch(() => []);
  const id = model.includes('/') ? model : `ollama/${model}`;
  return deps.models.find((m) => m.id === id)?.structured ? 'json' : 'text';
}

/** A design meets its brief when it is valid and nothing required is missing */
export const passes = (a: Attempt | undefined) => !!a && a.valid && !a.brief?.unmet.length;

export function scoreOf(result: CheckResult, brief: BriefCheck | undefined, looks: number | null | undefined, w: number) {
  const penalty = Math.min(20, 5 * (brief?.unmet.length ?? 0));
  const base = Math.max(0, result.score - penalty);
  const score = looks ? base * (1 - w) + looks * 10 * w : base;
  return { score: Math.round(score * 10) / 10, penalty };
}

const isAbort = (e: unknown) => e instanceof Error && (e.name === 'AbortError' || e instanceof AbortedError);

export async function designLoop(deps: LoopDeps, o: DesignOptions, emit: Emit): Promise<DesignOutcome> {
  const { ctx, llm } = deps;
  const now = deps.now ?? Date.now;
  const t0 = now();
  const rounds = o.rounds ?? 4, keep = o.keepRounds ?? 2, w = o.criticWeight ?? 0.1;
  const stats = (deps.renderStats ??= { ms: [], slow: false });
  const role = roleOf(ctx, o.brief);
  const contract = await contractFor(deps, o.model, o.contract);
  // (A thinking model may think even when told not to (qwen3-vl): room for the thinking as well as the grid)
  const thinks = !!deps.models?.find((m) => m.id === (o.model.includes('/') ? o.model : `ollama/${o.model}`))?.thinking;
  const budget = o.maxTokens ?? (thinks ? 12288 : 4096);
  const system = systemPrompt(ctx, o.brief);
  // (Grid lines, the column-number line included, past which a reply is a runaway)
  const maxRows = 2 * (role?.size?.maxHeight ?? 20) + 6, maxCols = 2 * (role?.size?.maxWidth ?? 20) + 6;
  emit({ type: 'brief', role: role?.id, text: briefText(ctx, o.brief), legendCodes: briefLegend(ctx, o.brief).length, promptChars: system.length });

  const first = o.start
    ? `Here is a design:\n${o.start.text}\n\n${o.start.feedback ? `Its check:\n${o.start.feedback}\n\n` : ''}Change it: ${o.start.instruction}. Keep what already works.\n${CONTRACT_TEXT[contract]}`
    : `Design the ship now.\n${CONTRACT_TEXT[contract]}`;
  const head: ChatMessage[] = [{ role: 'system', content: system }, { role: 'user', content: first }];
  let tail: ChatMessage[] = [];
  const out: DesignOutcome = { attempts: [], firstValidRound: null, firstPassRound: null, unreadable: 0, cancelled: false, ms: 0 };
  let failures = 0;
  const seen = new Set<string>();

  for (let round = 1; round <= rounds; round++) {
    if (o.signal?.aborted) { out.cancelled = true; break; }
    const messages = [...head, ...tail];
    const last = messages[messages.length - 1];
    emit({ type: 'prompt', round, ...(round === 1 ? { system } : {}), user: last.content, messages: messages.length, chars: messages.reduce((a, m) => a + m.content.length, 0) });

    // ---- Ask, streaming (a live grid preview as rows complete)
    let sofar = '', shown = 0, runawayNote = '', wide = false;
    let reply;
    // (A model that loops, writing row after row, is stopped once its grid is far past the brief's length)
    const stopper = new AbortController();
    let runaway = false;
    const tAsk = now();
    try {
      reply = await llm.chat({
        model: o.model, messages, schema: contract === 'json' ? DESIGN_SCHEMA : undefined,
        temperature: o.temperature ?? 0.6, think: o.think, numCtx: o.numCtx ?? numCtxFor(messages, budget), maxTokens: budget,
        timeoutMs: o.timeoutMs, idleMs: o.idleMs, signal: o.signal ? AbortSignal.any([o.signal, stopper.signal]) : stopper.signal,
        onToken: (d, kind) => {
          emit({ type: 'token', round, kind, text: d });
          if (kind !== 'content') return;
          sofar += d;
          // (Or one row far wider than the brief: the row so far is what follows the last line break or quote)
          const rowAt = Math.max(sofar.lastIndexOf('\n'), sofar.lastIndexOf('"')) + 1;
          if (!runaway && sofar.length - rowAt > 4 * maxCols && sofar.slice(rowAt).trim().split(/\s+/).length > maxCols + 1) { runaway = wide = true; stopper.abort(); return; }
          if (!/[\n"\]]/.test(d)) return;
          const pg = partialGrid(sofar, contract);
          if (!pg || pg.lines <= shown) return;
          shown = pg.lines;
          if (pg.lines > maxRows && !runaway) { runaway = true; stopper.abort(); return; }
          const dec = gridToBlueprint(ctx, pg.text);
          emit({ type: 'grid', round, partial: true, text: pg.text, parts: dec.bp?.parts.length ?? 0, errors: dec.errors, warnings: dec.warnings });
        },
      });
      failures = 0;
    } catch (e) {
      if (runaway && !o.signal?.aborted) {
        reply = { text: sofar, thinking: '', ms: now() - tAsk, structured: contract === 'json' };
        runawayNote = wide
          ? `a row ran on past ${maxCols} cells and you were stopped: the brief allows at most ${role?.size?.maxWidth ?? maxCols} columns; every row needs the same few tokens, one per cell`
          : `you kept writing rows (more than ${maxRows - 1}) and were stopped: the brief allows at most ${role?.size?.maxHeight ?? maxRows - 1} rows; draw each row once, then close the grid`;
      } else if (isAbort(e) || o.signal?.aborted) {
        out.cancelled = true; break;
      } else {
        failures++;
        emit({ type: 'error', round, message: `model: ${(e as Error).message}`, fatal: failures >= 2 });
        if (failures >= 2) break;
        continue;
      }
    }
    emit({ type: 'reply', round, text: reply.text, ms: reply.ms, outputTokens: reply.outputTokens, tokensPerSec: reply.tokensPerSec, structured: reply.structured });

    // ---- Read and check
    const a: Attempt = { round, reply: reply.text, gridText: null, valid: false, score: 0, ms: reply.ms, outputTokens: reply.outputTokens, tokensPerSec: reply.tokensPerSec };
    out.attempts.push(a);
    const ex = extractDesign(reply.text);
    if (runawayNote) ex.notes.unshift(runawayNote);
    let feedback: string;
    if (!ex.text) {
      out.unreadable++;
      if (!reply.text.trim() && reply.thinking.trim()) ex.notes.unshift(`you spent the whole reply thinking (${reply.outputTokens ?? budget} tokens) and wrote no design: think briefly, then write the grid`);
      emit({ type: 'grid', round, partial: false, text: null, via: 'none', parts: 0, errors: ex.notes.map((message) => ({ message })), warnings: [] });
      feedback = `I couldn't find a design in your reply (${ex.notes.join('; ')}).\n${CONTRACT_TEXT[contract]}`;
    } else {
      a.gridText = ex.text;
      const book = new CodeBook(ctx);
      const dec = gridToBlueprint(ctx, ex.text, { book });
      const warnings = [...ex.notes, ...dec.warnings];
      emit({ type: 'grid', round, partial: false, text: ex.text, via: ex.via, parts: dec.bp?.parts.length ?? 0, errors: dec.errors, warnings, ...(dec.bp?.parts.length && !dec.errors.length ? { bp: dec.bp } : {}) });
      if (!dec.bp || dec.errors.length || !dec.bp.parts.length) {
        out.unreadable++;
        feedback = feedbackMessage({ gridErrors: dec.errors.length ? dec.errors : [{ message: 'the grid has no parts: every cell is ".."; draw the ship with the codes in the legend' }], gridWarnings: warnings });
      } else {
        a.bp = dec.bp;
        const result = check(ctx, dec.bp, { book, weights: role?.weights as never });
        const bc = role ? briefCheck(ctx, dec.bp, role) : undefined;
        // (The game accepts a ship whose guns or engines get no power; nobody could fly it, so it doesn't meet a brief)
        const dark = result.power?.unpowered.length ?? 0;
        if (bc && dark) bc.unmet.push(`every gun, engine and tool powered (${dark} get none)`);
        a.result = result; a.brief = bc; a.valid = result.valid;
        emit({ type: 'check', round, valid: result.valid, score: result.score, result, ...(bc ? { brief: bc } : {}) });
        feedback = feedbackMessage({ result, brief: bc, gridWarnings: warnings });
        if (result.valid && out.firstValidRound === null) out.firstValidRound = round;
        await renderAndCritique(deps, o, a, stats, emit);
        const s = scoreOf(result, bc, a.looks, w);
        a.score = s.score;
        emit({ type: 'score', round, score: a.score, parts: { check: result.score, briefPenalty: s.penalty, ...(a.looks ? { looks: a.looks } : {}) } });
        if (!out.best || better(a, out.best)) {
          out.best = a;
          emit({ type: 'best', round, score: a.score, valid: a.valid, name: a.bp.name, bp: a.bp, ...(a.renderPath ? { renderPath: a.renderPath } : {}) });
        }
      }
    }
    if (o.signal?.aborted) { out.cancelled = true; break; }
    if (passes(a) && out.firstPassRound === null) out.firstPassRound = round;
    if ((o.stopWhenValid && passes(a)) || (passes(a) && a.score >= (o.target ?? 92))) break;
    if (round < rounds) {
      // (A model that sends the same grid again is stuck: say so, or it keeps sending it)
      const key = ex.text?.replace(/^name:.*$/m, '').replace(/[ \t]+/g, ' ').trim();
      const again = !!key && seen.has(key);
      if (key) seen.add(key);
      const msg = `${again ? 'You sent this same grid before, and it has the same problems: change the rows the errors name.\n' : ''}${feedback}\n${CONTRACT_TEXT[contract]}`;
      emit({ type: 'feedback', round, text: msg });
      // (What it said, kept short: the design as read, not the thinking aloud around it)
      const said = ex.text ? (contract === 'json' && ex.via === 'json' ? reply.text.trim() : ex.text) : reply.text.slice(-1500);
      tail = [...tail, { role: 'assistant' as const, content: said }, { role: 'user' as const, content: msg }].slice(-2 * Math.max(1, keep));
    }
  }
  out.ms = now() - t0;
  return out;
}

/** Valid beats invalid, then meeting the brief, then the score */
export function better(a: Attempt, b: Attempt): boolean {
  if (a.valid !== b.valid) return a.valid;
  if (passes(a) !== passes(b)) return passes(a);
  return a.score > b.score;
}

/** Ollama's context: room for the prompt (~3 chars a token) and a reply */
function numCtxFor(messages: ChatMessage[], reply: number): number {
  const need = Math.ceil(messages.reduce((a, m) => a + m.content.length, 0) / 3) + reply;
  return Math.min(40960, Math.max(8192, Math.ceil(need / 2048) * 2048));
}

async function renderAndCritique(deps: LoopDeps, o: DesignOptions, a: Attempt, stats: { ms: number[]; slow: boolean }, emit: Emit): Promise<void> {
  const mode = o.render ?? 'auto';
  if (!deps.renderer || !o.outDir || mode === 'off' || !a.bp) return;
  if ((mode === 'valid' || (mode === 'auto' && stats.slow)) && !a.valid) return;
  const path = join(o.outDir, 'renders', `${o.tag ? `${o.tag}-` : ''}r${a.round}.png`);
  let png: Buffer;
  try {
    const r = await deps.renderer.render(a.bp, path, o.signal);
    stats.ms.push(r.ms);
    const sorted = [...stats.ms].sort((x, y) => x - y);
    stats.slow = sorted[Math.floor(sorted.length / 2)] > (o.slowRenderMs ?? 1500);
    a.renderPath = r.path; png = r.png;
    emit({ type: 'render', round: a.round, path: r.path, ms: r.ms });
  } catch (e) {
    if (!isAbort(e)) emit({ type: 'error', round: a.round, message: `render: ${(e as Error).message}`, fatal: false });
    return;
  }
  if (!o.critic || !a.valid) return;
  try {
    const v = await critique(deps.llm, o.critic, png, { signal: o.signal, timeoutMs: o.timeoutMs });
    a.looks = v.looks; a.reason = v.reason;
    emit({ type: 'critic', round: a.round, model: o.critic, looks: v.looks, reason: v.reason, ms: v.ms });
  } catch (e) {
    if (!isAbort(e)) emit({ type: 'error', round: a.round, message: `critic: ${(e as Error).message}`, fatal: false });
  }
}
