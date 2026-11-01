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
