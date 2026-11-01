// What the design loop reports, in order, for the CLI and the page. Every event carries `t` (ms since the run began)
// and, in compare and evolve runs, a `lane` (the model, or "gen 2 #3") saying which line of work it belongs to.
import type { Blueprint } from '../../../common/src/ships/index';
import type { BriefCheck, CheckResult, GridError } from '../core/index';
import type { Contract } from './contracts';

export type Mode = 'design' | 'evolve' | 'compare';

interface Base { t: number; lane?: string }

export interface StartEvent extends Base { type: 'start'; mode: Mode; model: string; models?: string[]; critic?: string; role?: string; contract: Contract; mirror?: boolean; build?: 'oneshot' | 'staged'; options: Record<string, unknown> }
export interface BriefEvent extends Base { type: 'brief'; role?: string; text: string; legendCodes: number; promptChars: number }
export interface PromptEvent extends Base { type: 'prompt'; round: number; system?: string; user: string; messages: number; chars: number }
export interface TokenEvent extends Base { type: 'token'; round: number; kind: 'content' | 'thinking'; text: string }
export interface ReplyEvent extends Base { type: 'reply'; round: number; text: string; ms: number; outputTokens?: number; tokensPerSec?: number; structured: boolean }
export interface GridEvent extends Base {
  type: 'grid'; round: number;
  /** Still streaming (complete rows so far) */
  partial: boolean;
  /** The ship as a grid (whole: after mirroring), or what was read when it couldn't be built */
  text: string | null;
  /** What the model wrote, as extracted (its half, or its part list), when that isn't `text` */
  drawn?: string;
  /** How the reply was read (final only) */
  via?: 'json' | 'markers' | 'loose' | 'none';
  parts: number;
  errors: GridError[];
  warnings: string[];
  bp?: Blueprint;
}
export interface CheckEvent extends Base { type: 'check'; round: number; valid: boolean; score: number; result: CheckResult; brief?: BriefCheck }
export interface FeedbackEvent extends Base { type: 'feedback'; round: number; text: string }
export interface RenderEvent extends Base { type: 'render'; round: number; path: string; ms: number }
export interface CriticEvent extends Base { type: 'critic'; round: number; model: string; looks: number | null; reason: string; ms: number }
export interface ScoreEvent extends Base { type: 'score'; round: number; score: number; parts: { check: number; briefPenalty: number; asymmetry?: number; looks?: number } }
export interface BestEvent extends Base { type: 'best'; round: number; score: number; valid: boolean; name: string; bp: Blueprint; renderPath?: string }
/** Staged build: a step begins, is accepted, or runs out of tries (the ship stays as it was) */
export interface StepEvent extends Base { type: 'step'; step: string; index: number; of: number; status: 'start' | 'accepted' | 'failed' | 'skipped'; round: number; note?: string }
export interface MutationEvent extends Base { type: 'mutation'; gen: number; child: number; parent: string; instruction: string }
export interface GenerationEvent extends Base { type: 'generation'; gen: number; population: { id: string; score: number; valid: boolean; name: string }[] }
export interface ErrorEvent extends Base { type: 'error'; round?: number; message: string; fatal: boolean }
export interface DoneEvent extends Base { type: 'done'; metrics: DesignMetrics | EvolveMetrics | CompareMetrics; cancelled: boolean }

export type ShipgenEvent =
  | StartEvent | BriefEvent | PromptEvent | TokenEvent | ReplyEvent | GridEvent | CheckEvent | FeedbackEvent
  | RenderEvent | CriticEvent | ScoreEvent | BestEvent | StepEvent | MutationEvent | GenerationEvent | ErrorEvent | DoneEvent;

export type Emit = (e: DistributiveOmit<ShipgenEvent, 't'> & { t?: number }) => void;
export type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;

export interface DesignMetrics {
  kind: 'design';
  model: string;
  rounds: number;
  /** The first round (1-based) whose design was valid, or null */
  firstValidRound: number | null;
  valid: boolean;
  bestScore: number;
  /** Replies that held no readable grid */
  unreadable: number;
  ms: number;
  outputTokens: number;
  tokensPerSec: number | null;
  renderMs: number[];
}

export interface EvolveMetrics {
  kind: 'evolve';
  model: string;
  generations: number;
  /** Best score after each generation (index 0: the seed population) */
  bestByGen: number[];
  children: number;
  validChildren: number;
  ms: number;
}

export interface ModelStats {
  model: string;
  trials: number;
  /** Trials valid within the rounds allowed */
  passes: number;
  passRate: number;
  /** Mean rounds to the first valid design, over passing trials */
  roundsPerValid: number | null;
  validPerMinute: number;
  /** Mean best score over every trial (0 for a trial with nothing readable) */
  meanScore: number;
  ms: number;
  tokensPerSec: number | null;
}

export interface CompareMetrics { kind: 'compare'; rounds: number; models: ModelStats[] }
