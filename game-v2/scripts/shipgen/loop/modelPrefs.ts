// The reply contract each model does best with, measured (scripts/shipgen/TRIAL.md). `--contract auto` (and the page's
// "auto") uses the first row whose pattern matches the model's name; a model with no row gets grid-json if it takes a
// schema, else grid-text. Add a row when a trial shows a model does better with another contract.
import type { Contract } from './contracts';
import type { ModelInfo } from './llm';

export interface ModelPref {
  /** Matched against the model's name ("qwen2.5-coder:14b") */
  match: RegExp;
  contract: Contract;
  /** What the measurement was */
  why: string;
}

export const MODEL_PREFS: ModelPref[] = [
  // (Trial 2, 2026-11-01: starter, one-shot, mirror on, 2 trials x 5 rounds per contract: few trials, so a weak signal.
  //  Trial 1 (mirror off, 3 trials) had the opposite order for both, so treat these as the current best guess.)
  { match: /qwen2\.5-coder/i, contract: 'grid-json', why: 'trial 2 (2026-11-01, starter, mirror on, 2 trials each): grid-json 2/2 valid (1 on brief) vs grid-text 0/2, parts 0/2' },
  { match: /gemma/i, contract: 'grid-text', why: 'trial 2 (2026-11-01, starter, mirror on, 2 trials each): grid-text 2/2 valid vs parts 1/2, grid-json 0/2' },
];

export function prefFor(model: string): ModelPref | undefined {
  const name = model.replace(/^(ollama|lmstudio|anthropic)\//, '');
  return MODEL_PREFS.find((p) => p.match.test(name));
}

/** The contract "auto" means for a model, and why */
export function autoContract(model: string, info?: ModelInfo): { contract: Contract; why: string } {
  const p = prefFor(model);
  if (p) return { contract: p.contract, why: p.why };
  return info?.structured ? { contract: 'grid-json', why: 'no measurement: it takes a JSON schema' } : { contract: 'grid-text', why: 'no measurement' };
}
