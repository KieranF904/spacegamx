// The image critic: a vision model looks at a still of the design and scores its looks 1-10 with a one-line reason.
import type { Llm } from './llm';

export const CRITIC_SCHEMA = {
  type: 'object',
  properties: { looks: { type: 'integer', minimum: 1, maximum: 10 }, reason: { type: 'string' } },
  required: ['looks', 'reason'],
  additionalProperties: false,
} as const;

export const CRITIC_PROMPT = [
  'This is a spaceship for a 2D space game, seen from above; its front is at the top.',
  'Judge only how it LOOKS: a clear, purposeful silhouette; balance and symmetry; a tidy, solid hull; guns and engines placed where they make sense.',
  'Score it 1-10 (1 a shapeless jumble, 5 plain but fine, 10 a striking, believable warship).',
  'Reply as JSON only: {"looks": <1-10>, "reason": "<one short line>"}',
].join('\n');

export interface Verdict { looks: number | null; reason: string; ms: number }

/** Reads a verdict however it came: JSON, or "7/10 because..." */
export function parseVerdict(text: string): { looks: number | null; reason: string } {
  const s = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try {
      const o = JSON.parse(s.slice(a, b + 1));
      const n = Number(o.looks ?? o.score);
      if (Number.isFinite(n)) return { looks: Math.max(1, Math.min(10, Math.round(n))), reason: String(o.reason ?? '').trim().slice(0, 200) };
    } catch { /* (fall through) */ }
  }
  const m = /\b(10|[1-9])(?:\s*\/\s*10)?\b/.exec(s);
  return { looks: m ? Number(m[1]) : null, reason: s.split('\n').find((l) => l.trim())?.trim().slice(0, 200) ?? '' };
}

export async function critique(llm: Llm, model: string, png: Buffer, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<Verdict> {
  const r = await llm.chat({
    model, schema: CRITIC_SCHEMA, temperature: 0.2, maxTokens: 300, signal: opts.signal, timeoutMs: opts.timeoutMs ?? 180000,
    messages: [{ role: 'user', content: CRITIC_PROMPT, images: [png.toString('base64')] }],
  });
  return { ...parseVerdict(r.text), ms: r.ms };
}

// ---------------------------------------------------------------------------------------------------------------------
// Pairwise: "which of these two looks more like a real ship". Asked both ways round (A/B, then B/A) so a model that
// always says "the first" shows up as no preference rather than a pick. An experiment (critic-check.ts); off by default.

export const PAIR_SCHEMA = {
  type: 'object',
  properties: { better: { type: 'string', enum: ['first', 'second'] }, reason: { type: 'string' } },
  required: ['better', 'reason'],
  additionalProperties: false,
} as const;

export const PAIR_PROMPT = [
  'These are two spaceships for a 2D space game, seen from above; the front of each is at the top. The first image is the first ship, the second image the second.',
  'Which one looks more like a real, purposeful spaceship: a clear silhouette, balanced and symmetric, a solid hull, guns at the front and engines at the back?',
  'Reply as JSON only: {"better": "first" or "second", "reason": "<one short line>"}',
].join('\n');

export interface PairVerdict {
  /** 'a' or 'b' when both orders agree; null when the model picked by position (or couldn't say) */
  pick: 'a' | 'b' | null;
  /** Each order's answer, as the image it chose */
  answers: ('a' | 'b' | null)[];
  reason: string;
  ms: number;
}

function parsePair(text: string): { better: 'first' | 'second' | null; reason: string } {
  const s = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try {
      const o = JSON.parse(s.slice(a, b + 1));
      const v = String(o.better ?? '').toLowerCase();
      return { better: v.startsWith('f') || v === '1' || v === 'a' ? 'first' : v.startsWith('s') || v === '2' || v === 'b' ? 'second' : null, reason: String(o.reason ?? '').slice(0, 200) };
    } catch { /* (fall through) */ }
  }
  const m = /\b(first|second)\b/i.exec(s);
  return { better: m ? (m[1].toLowerCase() as 'first' | 'second') : null, reason: s.split('\n')[0]?.slice(0, 200) ?? '' };
}

export async function comparePair(llm: Llm, model: string, a: Buffer, b: Buffer, opts: { signal?: AbortSignal; timeoutMs?: number; maxTokens?: number } = {}): Promise<PairVerdict> {
  const t0 = Date.now();
  const answers: ('a' | 'b' | null)[] = [];
  let reason = '';
  for (const [x, y, first] of [[a, b, 'a'], [b, a, 'b']] as const) {
    const r = await llm.chat({
      model, schema: PAIR_SCHEMA, temperature: 0.1, maxTokens: opts.maxTokens ?? 2000, signal: opts.signal, timeoutMs: opts.timeoutMs ?? 300000,
      messages: [{ role: 'user', content: PAIR_PROMPT, images: [x.toString('base64'), y.toString('base64')] }],
    });
    const v = parsePair(r.text || r.thinking.slice(-400));
    reason ||= v.reason;
    answers.push(v.better === null ? null : v.better === 'first' ? first : first === 'a' ? 'b' : 'a');
  }
  const pick = answers[0] && answers[0] === answers[1] ? answers[0] : null;
  return { pick, answers, reason, ms: Date.now() - t0 };
}
