// Test-only: a scripted Llm. Each chat() takes the next reply (a string, a function of the request, or an Error to throw),
// streams it in small chunks through onToken (yielding between them, so cancellation can land mid-reply).
import type { ChatRequest, ChatResult, Llm, ModelInfo } from './llm';
import { AbortedError } from './llm';

/** A reply: its text, or the text with how the model stopped (`truncated`: cut off at the token limit) */
export type Scripted = string | Error | { text: string; truncated?: boolean } | ((req: ChatRequest) => string | Error | { text: string; truncated?: boolean });

export interface FakeLlm extends Llm { requests: ChatRequest[]; models: ModelInfo[] }

export const fakeModel = (name: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({
  id: `ollama/${name}`, provider: 'ollama', name, vision: false, cloud: false, chat: true, thinking: false, structured: false, ...extra,
});

export function fakeLlm(script: Scripted[] | ((req: ChatRequest, n: number) => Scripted), models: ModelInfo[] = [fakeModel('fake')], chunk = 7): FakeLlm {
  const requests: ChatRequest[] = [];
  let n = 0;
  return {
    requests, models,
    async list() { return models; },
    async chat(req): Promise<ChatResult> {
      requests.push(req);
      const i = n++;
      let r: Scripted = typeof script === 'function' ? script(req, i) : script[Math.min(i, script.length - 1)];
      if (typeof r === 'function') r = r(req);
      if (r instanceof Error) throw r;
      const cut = typeof r === 'object' ? !!r.truncated : false;
      if (typeof r === 'object') r = r.text;
      const mi = models.find((m) => m.id === req.model || m.name === req.model);
      for (let k = 0; k < r.length; k += chunk) {
        if (req.signal?.aborted) throw new AbortedError();
        await new Promise((ok) => setImmediate(ok));
        req.onToken?.(r.slice(k, k + chunk), 'content');
      }
      if (req.signal?.aborted) throw new AbortedError();
      return { text: r, thinking: '', ms: 5, outputTokens: Math.ceil(r.length / 4), tokensPerSec: 100, structured: !!req.schema && !!mi?.structured, ...(cut ? { stopReason: 'max_tokens', truncated: true } : {}) };
    },
  };
}
