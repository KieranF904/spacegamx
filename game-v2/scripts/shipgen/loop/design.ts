// One design, talked through with a model: generate -> read the reply -> (mirror the half) -> check -> feedback -> retry,
// for up to N rounds, keeping the best by score. Optionally renders each design (native renderer) and has a vision model
// score its looks. The parts shared with the staged build (staged.ts) are the Session: ask() and read().
import { join } from 'path';
import type { Blueprint } from '../../../common/src/ships/index';
import {
  type Brief, type BriefCheck, type CheckResult, type CodeDef, type Concept, conceptBlock, conceptLine, conceptPenalty, rowWidths, type DecodeResult, type GridError, type Role, type ShipgenContext,
  CodeBook, withShape, asymmetricCells, blueprintToGrid, briefCheck, briefLegend, briefText, check, designText, feedbackMessage, findRole, mirrorHalf, shapeSuggestion, systemPrompt,
} from '../core/index';
import type { Emit } from './events';
import type { ChatMessage, Llm, ModelInfo } from './llm';
import { AbortedError } from './llm';
import { CONTRACTS, type Contract, type ContractDef, parseContract } from './contracts';
import { autoContract } from './modelPrefs';
import type { Renderer } from './render';
import { critique } from './critic';
import { stagedLoop } from './staged';
import { conceptStep } from './concept';

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
  /** Rounds (model replies) at most (default 4); in a staged build, tries per step (default 3) */
  rounds?: number;
  /** grid-text, grid-json, parts, or auto (the model's measured best: modelPrefs.ts). "text"/"json" are read as grid-text/grid-json */
  contract?: Contract | 'auto' | 'text' | 'json';
  /** Mirror mode (default on): the model writes the left half and the centre line, the tool adds the right half */
  mirror?: boolean;
  /** oneshot (default): the whole ship each round; staged: a skeleton, then power, weapons, engines, armour, one step at a time */
  build?: 'oneshot' | 'staged';
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
  /** A vision model to score looks (optional), and its weight in the score (default 0: its verdict is recorded, not used) */
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
  /** Which of the role's shapes to ask for (compare: the trial; default: one at random); brief.shape set wins */
  shapeIndex?: number;
  /**
   * The concept step: true asks the model for a short concept before the first round (a design that begins from a given
   * ship doesn't), a Concept is used as given. Off by default here; the CLI and the page turn it on.
   */
  concept?: boolean | Concept;
  /** Variation: a number, and the one-line forms of concepts already used this session (conceptKey) */
  conceptSeed?: number;
  usedConcepts?: string[];
  /** Size the reply budget to the model's loaded context (minus the prompt), and let reasoning models think */
  generous?: boolean;
  /** Begin from a design (evolve): the design (bp, shown in the contract's form; or its grid text), the change to make, and its check */
  start?: { text?: string; bp?: Blueprint; instruction: string; feedback?: string };
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
  /** The reply was cut off at the token limit */
  truncated?: boolean;
  /** outputTokens is an estimate (the reply was stopped as a runaway before the model reported its count) */
  tokensEstimated?: boolean;
}

export interface DesignOutcome {
  attempts: Attempt[];
  best?: Attempt;
  firstValidRound: number | null;
  /** First round valid and meeting the brief (a copy of the worked example, or a ship the wrong size, doesn't) */
  firstPassRound: number | null;
  /** Replies that held no readable design (replies cut off at the token limit are counted in `truncated`, not here) */
  unreadable: number;
  /** Replies cut off at the token limit */
  truncated: number;
  /** Staged build: the steps that were accepted and those that ran out of tries */
  steps?: { accepted: string[]; failed: string[] };
  /** The concept the design followed */
  concept?: Concept;
  cancelled: boolean;
  ms: number;
}

export function roleOf(ctx: ShipgenContext, brief: Brief): Role | undefined {
  return !brief.role ? undefined : typeof brief.role === 'string' ? findRole(ctx, brief.role) : brief.role;
}

const fullId = (model: string) => (model.includes('/') ? model : `ollama/${model}`);

/** The contract a run uses: the one asked for, else (auto) parts for a staged build (its steps are lists of new parts), else the model's measured best */
export async function contractFor(deps: LoopDeps, model: string, pref: DesignOptions['contract'] = 'auto', build?: DesignOptions['build']): Promise<Contract> {
  const c = parseContract(pref);
  if (c && c !== 'auto') return c;
  if (build === 'staged') return 'parts';
  deps.models ??= await deps.llm.list().catch(() => []);
  return autoContract(model, deps.models.find((m) => m.id === fullId(model))).contract;
}

/** A design meets its brief when it is valid and nothing required is missing */
export const passes = (a: Attempt | undefined) => !!a && a.valid && !a.brief?.unmet.length;

export function scoreOf(result: CheckResult, brief: BriefCheck | undefined, looks: number | null | undefined, w: number) {
  const penalty = Math.min(20, 5 * (brief?.unmet.length ?? 0));
  const base = Math.max(0, result.score - penalty);
  const score = looks && w > 0 ? base * (1 - w) + looks * 10 * w : base;
  return { score: Math.round(score * 10) / 10, penalty };
}

/** With mirror mode off, symmetry weighs this much, and each cell without a mirror twin costs points (up to a cap) */
export const NO_MIRROR_SYMMETRY_WEIGHT = 0.6;
export const ASYMMETRY_POINTS = { perCell: 4, max: 40 };

/** A ship as a grid for the model to read (never throws: a ship the grid can't draw says so) */
export function gridOf(ctx: ShipgenContext, bp: Blueprint, book?: CodeBook, max?: { w: number; h: number }): string {
  try {
    const text = blueprintToGrid(ctx, bp, { book }).text;
    // (A runaway ship, far past the brief, is no use drawn out: say how big it is instead)
    if (max) {
      const head = text.split('\n').find((l) => /^\s*-?\d+(\s+-?\d+)+\s*$/.test(l));
      const cols = head ? head.trim().split(/\s+/).length : 0, rows = text.split('\n').filter((l) => /^\s*-?\d+\s+\S/.test(l) && l !== head).length;
      if (cols > 2 * max.w + 4 || rows > 2 * max.h + 4) return `(too big to show: ${cols} columns by ${rows} rows, against at most ${max.w} by ${max.h})`;
    }
    return text;
  } catch (e) { return `(can't draw it as a grid: ${(e as Error).message})`; }
}

const isAbort = (e: unknown) => e instanceof Error && (e.name === 'AbortError' || e instanceof AbortedError);

export interface Asked { text: string; thinking: string; ms: number; outputTokens?: number; tokensPerSec?: number; notes: string[]; truncated?: boolean; stopReason?: string; tokensEstimated?: boolean }

/** What read() made of a reply */
export interface Read {
  attempt: Attempt;
  /** The design as the model wrote it decoded (before mirroring), when it read */
  drawn?: Blueprint;
  /** Feedback for the model (without the reply instruction) */
  feedback: string;
  readable: boolean;
  /** The text the model sent, as extracted (for the conversation and the repeat check) */
  said: string | null;
  /** The reply was cut off at the token limit */
  truncated?: boolean;
}

/** One model, one brief: asking, reading and scoring replies, shared by the one-shot loop and the staged build */
export class Session {
  readonly ctx: ShipgenContext;
  readonly role?: Role;
  readonly mirror: boolean;
  readonly C: ContractDef;
  /** Reply budget in tokens (with `generous`, refitted to the context at every ask) */
  budget: number;
  /** The concept the design follows, when it has one */
  readonly concept?: Concept;
  /** Loaded context of the model, when known */
  readonly loadedContext?: number;
  readonly maxRows: number;
  readonly maxCols: number;
  readonly weights: Record<string, number> | undefined;
  readonly stats: { ms: number[]; slow: boolean };
  readonly now: () => number;
  failures = 0;
  /** Raised when the model resends a design it sent before (heat()) */
  temperature: number;

  constructor(readonly deps: LoopDeps, readonly o: DesignOptions, contract: Contract, readonly emit: Emit) {
    this.ctx = deps.ctx;
    this.now = deps.now ?? Date.now;
    this.role = roleOf(this.ctx, o.brief);
    this.mirror = o.mirror !== false;
    this.C = CONTRACTS[contract];
    // (A thinking model may think even when told not to (qwen3-vl): room for the thinking as well as the grid)
    const thinks = !!deps.models?.find((m) => m.id === fullId(o.model))?.thinking || (!!o.think && fullId(o.model).startsWith('anthropic/'));
    // (8192: a mid-size ship's grid is about 4k tokens, and a capital's more; runaway replies are stopped by the line limit below)
    this.budget = o.maxTokens ?? (thinks ? (o.generous ? 24576 : 12288) : 8192);
    this.loadedContext = deps.models?.find((m) => m.id === fullId(o.model))?.loadedContext;
    if (typeof o.concept === 'object') this.concept = o.concept;
    // (Grid lines, the column-number line included, past which a reply is a runaway; a part list gets more lines)
    const lines = this.C.form === 'parts' ? (this.role?.size?.cells?.[1] ?? 100) + 4 : 2 * (this.role?.size?.maxHeight ?? 20);
    this.maxRows = lines + 6;
    this.temperature = o.temperature ?? 0.6;
    this.maxCols = 2 * (this.role?.size?.maxWidth ?? 20) + 6;
    const rw = this.role?.weights as Record<string, number> | undefined;
    this.weights = this.mirror ? rw : { ...rw, symmetry: NO_MIRROR_SYMMETRY_WEIGHT };
    this.stats = (deps.renderStats ??= { ms: [], slow: false });
  }

  ask(mirrorNote = true): string { return this.C.ask(this.mirror && mirrorNote); }

  /** The concept as a block for the design prompt ('' without one) */
  conceptBlock(): string { return this.concept ? `${conceptBlock(this.concept)}\n` : ''; }

  /** The concept as one line for a feedback message ('' without one) */
  conceptLine(): string { return this.concept ? `${conceptLine(this.concept)} Keep to it.\n` : ''; }

  /** With `generous`: the reply budget that fits the loaded context after this prompt (a thinking model needs room to think and write) */
  private fitBudget(messages: ChatMessage[]): void {
    if (!this.o.generous || this.o.maxTokens !== undefined || !this.loadedContext) return;
    const prompt = Math.ceil(messages.reduce((a, m) => a + m.content.length, 0) / 3);
    this.budget = Math.max(2048, Math.min(32768, this.loadedContext - prompt - 256));
  }

  bounds(): { w: number; h: number } { return { w: this.role?.size?.maxWidth ?? 20, h: this.role?.size?.maxHeight ?? 20 }; }

  /** A model stuck resending the same design gets a hotter next try (+0.3, up to 1.2) */
  heat(): void { this.temperature = Math.min(1.2, Math.round((this.temperature + 0.3) * 100) / 100); }

  /** Codes a shown design needed a key for (a part the legend has no code for): the model's reply may leave the key out, and still means them */
  private carried: CodeDef[] = [];

  /** The design shown to the model in its own form (half in mirror mode) */
  show(bp: Blueprint): string {
    const book = new CodeBook(this.ctx);
    const text = designText(this.ctx, bp, { form: this.C.form, mirror: this.mirror, book });
    this.carried = [...book.own];
    return text;
  }

  /** Asks the model, streaming (live previews as lines complete); null when cancelled or after two failures in a row */
  async chat(round: number, messages: ChatMessage[]): Promise<Asked | 'cancelled' | 'failed' | 'retry'> {
    const { o, ctx, emit, C } = this;
    const last = messages[messages.length - 1];
    this.fitBudget(messages);
    emit({ type: 'prompt', round, ...(round === 1 ? { system: messages[0].content } : {}), user: last.content, messages: messages.length, chars: messages.reduce((a, m) => a + m.content.length, 0) });
    let sofar = '', shown = 0, wide = false, runaway = false, far = false, farAt = '';
    const stopper = new AbortController();
    const tAsk = this.now();
    const notes: string[] = [];
    try {
      const reply = await this.deps.llm.chat({
        model: o.model, messages, schema: C.schema,
        temperature: this.temperature, think: o.think, numCtx: o.numCtx ?? numCtxFor(messages, this.budget), maxTokens: this.budget,
        timeoutMs: o.timeoutMs, idleMs: o.idleMs, signal: o.signal ? AbortSignal.any([o.signal, stopper.signal]) : stopper.signal,
        onToken: (d, kind) => {
          emit({ type: 'token', round, kind, text: d });
          if (kind !== 'content') return;
          sofar += d;
          // (One row far wider than the brief: the row so far is what follows the last line break or quote)
          const rowAt = Math.max(sofar.lastIndexOf('\n'), sofar.lastIndexOf('"')) + 1;
          if (!runaway && C.form === 'grid' && sofar.length - rowAt > 4 * this.maxCols && sofar.slice(rowAt).trim().split(/\s+/).length > this.maxCols + 1) { runaway = wide = true; stopper.abort(); return; }
          if (!/[\n"\]]/.test(d)) return;
          const pg = C.partial(sofar);
          if (!pg || pg.lines <= shown) return;
          shown = pg.lines;
          if (pg.lines > this.maxRows && !runaway) { runaway = true; stopper.abort(); return; }
          // (A part list running off far past the brief's bounds: "HA -1,-1", "HA -2,-1", ... "HA -60,-1")
          if (C.form === 'parts' && !runaway) {
            const m = /(-?\d+)\s*[,\s]\s*(-?\d+)[^\n]*\n[^\n]*$/.exec(sofar);
            const W = (this.role?.size?.maxWidth ?? 20) + 4, H = (this.role?.size?.maxHeight ?? 20) + 4;
            if (m && (Math.abs(Number(m[1])) > W || Math.abs(Number(m[2])) > H)) { runaway = far = true; farAt = `col ${m[1]} row ${m[2]}`; stopper.abort(); return; }
          }
          // (A preview only: nothing in it may fail the reply)
          try {
            const dec = C.decode(ctx, pg.text, new CodeBook(ctx));
            let bp = dec.bp;
            if (bp?.parts.length && this.mirror) bp = mirrorHalf(ctx, bp).bp ?? bp;
            emit({ type: 'grid', round, partial: true, text: bp?.parts.length && !dec.errors.length ? blueprintToGrid(ctx, bp).text : pg.text, parts: bp?.parts.length ?? 0, errors: dec.errors, warnings: dec.warnings });
          } catch { /* (a half-written reply) */ }
        },
      });
      this.failures = 0;
      return { ...reply, notes };
    } catch (e) {
      if (runaway && !o.signal?.aborted) {
        const max = C.form === 'parts' ? `${this.maxRows - 6} parts` : `${this.role?.size?.maxHeight ?? this.maxRows - 1} rows`;
        notes.push(far
          ? `you placed a part at ${farAt}, far outside the brief (at most ${this.role?.size?.maxWidth ?? '?'} columns wide and ${this.role?.size?.maxHeight ?? '?'} rows long, around the core at 0,0) and were stopped: keep every part within a few cells of the core, each touching another`
          : wide
          ? `a row ran on past ${this.maxCols} cells and you were stopped: the brief allows at most ${this.role?.size?.maxWidth ?? this.maxCols} columns; every row needs the same few tokens, one per cell`
          : C.form === 'parts' ? `you kept listing parts (more than ${max}) and were stopped: list each part once, then end` : `you kept writing rows (more than ${this.maxRows - 1}) and were stopped: the brief allows at most ${max}; draw each row once, then close the grid`);
        // (The stopped stream never reached the model's own count: about 4 characters a token, marked as an estimate)
        return { text: sofar, thinking: '', ms: this.now() - tAsk, notes, outputTokens: Math.ceil(sofar.length / 4), tokensEstimated: true };
      }
      if (isAbort(e) || o.signal?.aborted) return 'cancelled';
      this.failures++;
      emit({ type: 'error', round, message: `model: ${(e as Error).message}`, fatal: this.failures >= 2 });
      return this.failures >= 2 ? 'failed' : 'retry';
    }
  }

  /**
   * Reads a reply into an attempt: extract, decode, `build` (a staged step merges it into the ship so far), mirror,
   * check, render, score. Emits grid/check/score events; the caller decides about "best".
   */
  async read(round: number, reply: Asked, build?: (drawn: Blueprint, book: CodeBook) => DecodeResult): Promise<Read> {
    const { ctx, emit, C } = this;
    emit({ type: 'reply', round, text: reply.text, ms: reply.ms, outputTokens: reply.outputTokens, tokensPerSec: reply.tokensPerSec, structured: !!C.schema, ...(reply.stopReason ? { stopReason: reply.stopReason } : {}), ...(reply.truncated ? { truncated: true } : {}), ...(reply.tokensEstimated ? { tokensEstimated: true } : {}) });
    const a: Attempt = { round, reply: reply.text, gridText: null, valid: false, score: 0, ms: reply.ms, outputTokens: reply.outputTokens, tokensPerSec: reply.tokensPerSec, ...(reply.truncated ? { truncated: true } : {}), ...(reply.tokensEstimated ? { tokensEstimated: true } : {}) };
    // (Cut off at the token limit: said plainly, not as a mistake of the model's format)
    const cut = reply.truncated ? `Your reply was cut off at the ${this.budget}-token limit before it was finished${reply.thinking.trim() ? ' (part of it went on thinking)' : ''}, so the design in it is incomplete. This is not a format mistake: write a more compact design, and send the design only, with no thinking aloud or explanation.` : '';
    const finish = (r: Read): Read => (reply.truncated ? { ...r, truncated: true, feedback: r.readable ? `${cut}
${r.feedback}` : cut } : r);
    const ex = C.extract(reply.text);
    ex.notes.unshift(...reply.notes);
    if (!ex.text) {
      if (!reply.text.trim() && reply.thinking.trim()) ex.notes.unshift(`you spent the whole reply thinking (${reply.outputTokens ?? this.budget} tokens) and wrote no design: think briefly, then write it`);
      emit({ type: 'grid', round, partial: false, text: null, via: 'none', parts: 0, errors: ex.notes.map((message) => ({ message })), warnings: [] });
      return finish({ attempt: a, feedback: `I couldn't find a design in your reply (${ex.notes.join('; ')}).`, readable: false, said: null });
    }
    a.gridText = ex.text;
    const book = new CodeBook(ctx);
    for (const c of this.carried) book.add({ ...c });
    const dec = C.decode(ctx, ex.text, book);
    const warnings = [...ex.notes, ...dec.warnings];
    const fail = (errors: GridError[], shown?: Blueprint): Read => {
      emit({ type: 'grid', round, partial: false, text: shown ? gridOf(ctx, shown, book) : ex.text, drawn: ex.text ?? undefined, via: ex.via, parts: shown?.parts.length ?? 0, errors, warnings });
      const feedback = shown
        ? feedbackMessage({ buildErrors: errors, gridWarnings: warnings, ship: gridOf(ctx, shown, book, this.bounds()) })
        : feedbackMessage({ gridErrors: errors, gridWarnings: warnings });
      return finish({ attempt: a, feedback, readable: false, said: ex.text ?? null, ...(shown ? { drawn: shown } : {}) });
    };
    if (!dec.bp || dec.errors.length) return fail(dec.errors);
    if (!dec.bp.parts.length) return fail([{ message: C.form === 'parts' ? 'the list has no parts: list the ship\'s parts with the codes in the legend' : 'the grid has no parts: every cell is ".."; draw the ship with the codes in the legend' }]);
    const drawn = dec.bp;
    let bp: Blueprint = drawn;
    if (build) {
      const b = build(bp, book);
      warnings.push(...b.warnings);
      if (!b.bp || b.errors.length) return fail(b.errors, drawn);
      bp = b.bp;
    }
    if (this.mirror) {
      const m = mirrorHalf(ctx, bp, { book });
      warnings.push(...m.warnings);
      if (!m.bp) return fail(m.errors, bp);
      bp = m.bp;
    }
    a.bp = bp;
    const shipGrid = gridOf(ctx, bp, book, this.bounds());
    emit({ type: 'grid', round, partial: false, text: shipGrid, drawn: ex.text ?? undefined, via: ex.via, parts: bp.parts.length, errors: [], warnings, bp });
    const result = check(ctx, bp, { book, weights: this.weights as never });
    const bc = this.role ? briefCheck(ctx, bp, this.role) : undefined;
    // (The game accepts a ship whose guns or engines get no power; nobody could fly it, so it doesn't meet a brief)
    const dark = result.power?.unpowered.length ?? 0;
    if (bc && dark) bc.unmet.push(`every gun, engine and tool powered (${dark} get none)`);
    a.result = result; a.brief = bc; a.valid = result.valid;
    emit({ type: 'check', round, valid: result.valid, score: result.score, result, ...(bc ? { brief: bc } : {}) });
    const asymmetry = this.mirror ? undefined : asymmetricCells(ctx, bp, { book }).map((x) => x.message);
    const asymPoints = asymmetry ? Math.min(ASYMMETRY_POINTS.max, ASYMMETRY_POINTS.perCell * asymmetry.length) : 0;
    let feedback = feedbackMessage({ result, brief: bc, gridWarnings: warnings, ship: shipGrid, mirror: this.mirror, asymmetry, asymmetryPoints: ASYMMETRY_POINTS.perCell });
    // (A valid ship with square exposed corners: a few named, as a suggestion)
    const shape = result.valid ? shapeSuggestion(ctx, bp, this.mirror) : null;
    if (shape) feedback += `
${shape}`;
    await renderAndCritique(this.deps, this.o, a, this.stats, emit);
    const s = scoreOf(result, bc, a.looks, this.o.criticWeight ?? 0);
    // (A small term for keeping to the concept: its size class and cell count against the ship's cells)
    const cp = conceptPenalty(this.role, this.concept, result.stats.cells, rowWidths(ctx, bp));
    if (cp.notes.length) feedback += `
The concept: ${cp.notes.join('; ')}.`;
    a.score = Math.max(0, Math.round((s.score - asymPoints - cp.points) * 10) / 10);
    emit({ type: 'score', round, score: a.score, parts: { check: result.score, briefPenalty: s.penalty, ...(asymPoints ? { asymmetry: asymPoints } : {}), ...(cp.points ? { concept: cp.points } : {}), ...(a.looks ? { looks: a.looks } : {}) } });
    return finish({ attempt: a, drawn, feedback, readable: true, said: ex.text });
  }
}

/** A given design (evolve's seed) scored as Session.read scores a reply: the brief penalty, the unpowered item, and the asymmetry rules with mirror mode off */
export function scoreGiven(ctx: ShipgenContext, bp: Blueprint, role: Role | undefined, o: { mirror?: boolean } = {}): { result: CheckResult; brief?: BriefCheck; score: number; book: CodeBook } {
  const book = new CodeBook(ctx);
  const mirror = o.mirror !== false;
  const rw = role?.weights as Record<string, number> | undefined;
  const result = check(ctx, bp, { book, weights: (mirror ? rw : { ...rw, symmetry: NO_MIRROR_SYMMETRY_WEIGHT }) as never });
  const brief = role ? briefCheck(ctx, bp, role) : undefined;
  // (The seed is no copy of the example when it is the example)
  if (brief) brief.unmet = brief.unmet.filter((x) => !x.startsWith('your own design'));
  const dark = result.power?.unpowered.length ?? 0;
  if (brief && dark) brief.unmet.push(`every gun, engine and tool powered (${dark} get none)`);
  const asym = mirror ? 0 : Math.min(ASYMMETRY_POINTS.max, ASYMMETRY_POINTS.perCell * asymmetricCells(ctx, bp, { book }).length);
  return { result, brief, book, score: Math.max(0, Math.round((scoreOf(result, brief, null, 0).score - asym) * 10) / 10) };
}

export async function designLoop(deps: LoopDeps, o: DesignOptions, emit: Emit): Promise<DesignOutcome> {
  if (!o.start) o = { ...o, brief: withShape(deps.ctx, o.brief, o.shapeIndex ?? Math.floor(Math.random() * 1000)) };
  // (The concept step: once, before the first round; a design begun from a given ship asks for none unless one is given)
  let concept: Concept | undefined;
  if (o.concept && !(o.concept === true && o.start)) {
    concept = await conceptStep(deps, o, emit);
    o = { ...o, concept: concept ?? false };
  } else if (o.concept === true) o = { ...o, concept: false };
  if (o.build === 'staged') {
    const r = await stagedLoop(deps, o, emit);
    return concept ? { ...r, concept } : r;
  }
  const { ctx } = deps;
  const S = new Session(deps, o, await contractFor(deps, o.model, o.contract), emit);
  const t0 = S.now();
  const rounds = o.rounds ?? 4, keep = o.keepRounds ?? 2;
  const system = systemPrompt(ctx, o.brief, { form: S.C.form, mirror: S.mirror });
  emit({ type: 'brief', role: S.role?.id, text: briefText(ctx, o.brief), legendCodes: briefLegend(ctx, o.brief).length, promptChars: system.length });

  const startText = o.start ? (o.start.bp ? S.show(o.start.bp) : o.start.text ?? '') : '';
  const first = o.start
    ? `Here is a design${S.mirror && o.start.bp ? ' (its left half and centre line)' : ''}:\n${startText}\n\n${o.start.feedback ? `Its check:\n${o.start.feedback}\n\n` : ''}Change it: ${o.start.instruction}. Keep what already works.\n${S.conceptBlock()}${S.ask()}`
    : `Design the ship now.\n${S.conceptBlock()}${S.ask()}`;
  const head: ChatMessage[] = [{ role: 'system', content: system }, { role: 'user', content: first }];
  let tail: ChatMessage[] = [];
  const out: DesignOutcome = { attempts: [], firstValidRound: null, firstPassRound: null, unreadable: 0, truncated: 0, cancelled: false, ms: 0 };
  const seen = new Set<string>();

  for (let round = 1; round <= rounds; round++) {
    if (o.signal?.aborted) { out.cancelled = true; break; }
    const reply = await S.chat(round, [...head, ...tail]);
    if (reply === 'cancelled') { out.cancelled = true; break; }
    if (reply === 'failed') break;
    if (reply === 'retry') continue;
    const r = await S.read(round, reply);
    const a = r.attempt;
    out.attempts.push(a);
    if (r.truncated) out.truncated++;
    else if (!r.readable) out.unreadable++;
    if (a.valid && out.firstValidRound === null) out.firstValidRound = round;
    if (a.bp && (!out.best || better(a, out.best))) {
      out.best = a;
      emit({ type: 'best', round, score: a.score, valid: a.valid, name: a.bp.name, bp: a.bp, ...(a.renderPath ? { renderPath: a.renderPath } : {}) });
    }
    if (o.signal?.aborted) { out.cancelled = true; break; }
    if (passes(a) && out.firstPassRound === null) out.firstPassRound = round;
    if ((o.stopWhenValid && passes(a)) || (passes(a) && a.score >= (o.target ?? 92))) break;
    if (round < rounds) {
      // (A model that sends the same design again is stuck: say so, or it keeps sending it)
      const key = r.said?.replace(/^name:.*$/m, '').replace(/[ \t]+/g, ' ').trim();
      const again = !!key && seen.has(key);
      if (key) seen.add(key);
      if (again) S.heat();
      const msg = `${again ? 'You sent this same design before, and it has the same problems: change the parts the errors name.\n' : ''}${r.feedback}\n${S.conceptLine()}${S.ask()}`;
      emit({ type: 'feedback', round, text: msg });
      // (What it said, kept short: the design as read, not the thinking aloud around it)
      const said = r.said ? (S.C.id === 'grid-json' && /^\s*\{/.test(a.reply.trim()) ? a.reply.trim() : r.said) : a.reply.slice(-1500);
      tail = [...tail, { role: 'assistant' as const, content: said }, { role: 'user' as const, content: msg }].slice(-2 * Math.max(1, keep));
    }
  }
  out.ms = S.now() - t0;
  if (concept) out.concept = concept;
  return out;
}

/** Valid beats invalid, then meeting the brief, then the score */
export function better(a: Attempt, b: Attempt): boolean {
  if (a.valid !== b.valid) return a.valid;
  if (passes(a) !== passes(b)) return passes(a);
  return a.score > b.score;
}

/** Ollama's context: room for the prompt (~3 chars a token) and a reply */
export function numCtxFor(messages: ChatMessage[], reply: number): number {
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
