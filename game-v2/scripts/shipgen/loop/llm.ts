// Local LLM clients: Ollama (/api/tags, /api/chat) and LM Studio (OpenAI-compatible /v1). Streaming, structured output
// (a JSON schema) where the model can take one, images for vision models, timeouts and cancellation.
// Model ids: "ollama/<name>" or "lmstudio/<name>"; a bare name is Ollama's. Cloud models (Ollama names ending
// ":cloud"/"-cloud", or with a remote host) are listed and labelled, never picked by default.
import { lmStudioToken } from './secrets';

export type Provider = 'ollama' | 'lmstudio';

export interface ModelInfo {
  /** "ollama/gemma4:12b", "lmstudio/qwen3-8b" */
  id: string;
  provider: Provider;
  name: string;
  /** Takes images */
  vision: boolean;
  /** Runs on an outside service */
  cloud: boolean;
  /** Can chat (a completion model) */
  chat: boolean;
  thinking: boolean;
  /** Takes a JSON schema for its reply */
  structured: boolean;
  contextLength?: number;
  params?: string;
  sizeBytes?: number;
  /** Listed but not to be asked: why (LM Studio while its chat is off: asking would load the model there) */
  off?: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** Base64 PNGs (vision models) */
  images?: string[];
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  /** A JSON schema for the reply: used when the model takes one (result.structured says whether it was) */
  schema?: object;
  temperature?: number;
  maxTokens?: number;
  /** Ollama's context window (tokens) */
  numCtx?: number;
  /** Let a thinking model think (default false: faster) */
  think?: boolean;
  seed?: number;
  signal?: AbortSignal;
  /** Whole request (default 10 min), and the longest wait for the next token (default 3 min: the model may be loading) */
  timeoutMs?: number;
  idleMs?: number;
  onToken?: (delta: string, kind: 'content' | 'thinking') => void;
}

export interface ChatResult {
  text: string;
  thinking: string;
  ms: number;
  promptTokens?: number;
  outputTokens?: number;
  tokensPerSec?: number;
  /** The reply was held to the schema */
  structured: boolean;
}

export interface Llm {
  list(): Promise<ModelInfo[]>;
  chat(req: ChatRequest): Promise<ChatResult>;
}

export interface LlmOptions {
  ollamaUrl?: string;
  lmStudioUrl?: string;
  /** For tests: a fake fetch */
  fetch?: typeof fetch;
  /** Overrides the LM Studio token lookup (tests) */
  token?: () => string | undefined;
  /**
   * May chat requests go to LM Studio? Asking an LM Studio model loads it there, so by default its models are only
   * listed: on only with LMSTUDIO_CHAT=1 or when this says so (the page's toggle).
   */
  lmStudioChat?: () => boolean;
}

/** LM Studio chat is on only when asked for: LMSTUDIO_CHAT=1 */
export const lmStudioChatFromEnv = () => process.env.LMSTUDIO_CHAT === '1';

export const LMSTUDIO_OFF = 'LM Studio, not enabled';

export class AbortedError extends Error {
  constructor(m = 'cancelled') { super(m); this.name = 'AbortError'; }
}
export class TimeoutError extends Error {
  constructor(m: string) { super(m); this.name = 'TimeoutError'; }
}

export function splitId(id: string): { provider: Provider; name: string } {
  const m = /^(ollama|lmstudio)\/(.+)$/.exec(id);
  return m ? { provider: m[1] as Provider, name: m[2] } : { provider: 'ollama', name: id };
}

export const isCloudName = (name: string) => /[:-]cloud$/i.test(name);

/** The model to use when none is named: local, chat-capable (vision too when asked) */
export function defaultModel(list: ModelInfo[], opts: { vision?: boolean } = {}): ModelInfo | undefined {
  return list.find((m) => !m.cloud && !m.off && m.chat && (!opts.vision || m.vision));
}

export function createLlm(opts: LlmOptions = {}): Llm {
  const ollama = (opts.ollamaUrl ?? process.env.OLLAMA_URL ?? 'http://localhost:11434').replace(/\/$/, '');
  const lms = (opts.lmStudioUrl ?? process.env.LMSTUDIO_URL ?? 'http://localhost:1234').replace(/\/$/, '');
  const f = opts.fetch ?? fetch;
  const token = opts.token ?? (() => lmStudioToken());
  const lmsChat = opts.lmStudioChat ?? lmStudioChatFromEnv;
  const auth = (): Record<string, string> => { const t = token(); return t ? { Authorization: `Bearer ${t}` } : {}; };
  let cache: Promise<ModelInfo[]> | null = null;

  async function listOllama(): Promise<ModelInfo[]> {
    const r = await f(`${ollama}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`ollama /api/tags: HTTP ${r.status}`);
    const j = (await r.json()) as { models?: any[] };
    return (j.models ?? []).map((m) => {
      const caps: string[] = m.capabilities ?? ['completion'];
      const cloud = isCloudName(m.name) || !!m.remote_host;
      return {
        id: `ollama/${m.name}`, provider: 'ollama' as const, name: m.name, cloud,
        vision: caps.includes('vision'), chat: caps.includes('completion'), thinking: caps.includes('thinking'),
        structured: caps.includes('completion'),
        contextLength: m.details?.context_length, params: m.details?.parameter_size, sizeBytes: cloud ? undefined : m.size,
      };
    });
  }

  async function listLmStudio(): Promise<ModelInfo[]> {
    if (!token()) throw new Error('LM Studio: no LM_API_TOKEN (environment or game-v2/.env)');
    const off = lmsChat() ? {} : { off: LMSTUDIO_OFF };
    // (/api/v1/models lists every downloaded model, loaded or not; the older lists show only what is loaded. Listing
    // never loads anything)
    const v1 = await f(`${lms}/api/v1/models`, { headers: auth(), signal: AbortSignal.timeout(5000) }).catch(() => null);
    const all = v1?.ok ? ((await v1.json().catch(() => ({}))) as { models?: any[] }).models : undefined;
    if (all?.length) {
      return all.filter((m) => m.type !== 'embedding' && m.type !== 'embeddings' && m.key).map((m) => ({
        id: `lmstudio/${m.key}`, provider: 'lmstudio' as const, name: m.key, cloud: false,
        vision: !!m.capabilities?.vision, chat: true, thinking: !!m.capabilities?.reasoning, structured: true,
        contextLength: m.max_context_length, params: m.params_string, sizeBytes: m.size_bytes, ...off,
      }));
    }
    // (/api/v0/models says vlm/llm/embeddings; the OpenAI list doesn't)
    let r = await f(`${lms}/api/v0/models`, { headers: auth(), signal: AbortSignal.timeout(5000) });
    let rich = true;
    if (!r.ok) { rich = false; r = await f(`${lms}/v1/models`, { headers: auth(), signal: AbortSignal.timeout(5000) }); }
    if (!r.ok) throw new Error(`LM Studio /v1/models: HTTP ${r.status}`);
    const j = (await r.json()) as { data?: any[] };
    return (j.data ?? []).filter((m) => !rich || m.type !== 'embeddings').map((m) => ({
      id: `lmstudio/${m.id}`, provider: 'lmstudio' as const, name: m.id, cloud: false,
      vision: rich ? m.type === 'vlm' : /vl|vision|llava/i.test(m.id), chat: !/embed/i.test(m.id), thinking: false, structured: true,
      contextLength: m.max_context_length ?? m.loaded_context_length,
      ...(lmsChat() ? {} : { off: LMSTUDIO_OFF }),
    }));
  }

  async function list(): Promise<ModelInfo[]> {
    const [a, b] = await Promise.allSettled([listOllama(), listLmStudio()]);
    if (a.status === 'rejected' && b.status === 'rejected') throw new Error(`no model server: ${a.reason?.message ?? a.reason}; ${b.reason?.message ?? b.reason}`);
    return [...(a.status === 'fulfilled' ? a.value : []), ...(b.status === 'fulfilled' ? b.value : [])];
  }

  async function info(id: string): Promise<ModelInfo | undefined> {
    cache ??= list().catch(() => []);
    const l = await cache;
    const { provider, name } = splitId(id);
    return l.find((m) => m.provider === provider && m.name === name);
  }

  async function chat(req: ChatRequest): Promise<ChatResult> {
    const { provider, name } = splitId(req.model);
    // (Before anything else: asking LM Studio would load the model there)
    if (provider === 'lmstudio' && !lmsChat()) throw new Error(`${LMSTUDIO_OFF}: asking ${name} would load it in LM Studio. Set LMSTUDIO_CHAT=1 (or tick "let LM Studio chat" on the page) to allow it`);
    const mi = await info(req.model);
    const structured = !!req.schema && (mi ? mi.structured : true);
    const t0 = Date.now();
    return withTimeouts(req, async (signal, touch) => {
      const out: ChatResult = { text: '', thinking: '', ms: 0, structured };
      const emit = (d: string | undefined, kind: 'content' | 'thinking') => {
        if (!d) return;
        touch();
        if (kind === 'content') out.text += d; else out.thinking += d;
        req.onToken?.(d, kind);
      };
      if (provider === 'ollama') {
        const body: Record<string, unknown> = {
          model: name, stream: true,
          messages: req.messages.map((m) => ({ role: m.role, content: m.content, ...(m.images?.length ? { images: m.images } : {}) })),
          options: { ...(req.temperature !== undefined ? { temperature: req.temperature } : {}), ...(req.numCtx ? { num_ctx: req.numCtx } : {}), ...(req.maxTokens ? { num_predict: req.maxTokens } : {}), ...(req.seed !== undefined ? { seed: req.seed } : {}) },
          ...(structured ? { format: req.schema } : {}),
          ...(mi?.thinking ? { think: !!req.think } : {}),
        };
        const r = await f(`${ollama}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
        if (!r.ok || !r.body) throw new Error(`ollama ${name}: HTTP ${r.status} ${(await r.text().catch(() => '')).slice(0, 300)}`);
        for await (const line of lines(r.body)) {
          if (!line.trim()) continue;
          const j = JSON.parse(line);
          if (j.error) throw new Error(`ollama ${name}: ${j.error}`);
          emit(j.message?.thinking, 'thinking');
          emit(j.message?.content, 'content');
          if (j.done) {
            out.promptTokens = j.prompt_eval_count; out.outputTokens = j.eval_count;
            if (j.eval_count && j.eval_duration) out.tokensPerSec = Math.round((j.eval_count / (j.eval_duration / 1e9)) * 10) / 10;
          }
        }
      } else {
        const body: Record<string, unknown> = {
          model: name, stream: true,
          messages: req.messages.map((m) => ({
            role: m.role,
            content: m.images?.length ? [{ type: 'text', text: m.content }, ...m.images.map((b) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${b}` } }))] : m.content,
          })),
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}), ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}), ...(req.seed !== undefined ? { seed: req.seed } : {}),
          ...(structured ? { response_format: { type: 'json_schema', json_schema: { name: 'reply', strict: true, schema: req.schema } } } : {}),
          stream_options: { include_usage: true },
        };
        if (!token()) throw new Error('LM Studio: no LM_API_TOKEN (environment or game-v2/.env)');
        const r = await f(`${lms}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth() }, body: JSON.stringify(body), signal });
        if (!r.ok || !r.body) throw new Error(`LM Studio ${name}: HTTP ${r.status} ${(await r.text().catch(() => '')).slice(0, 300)}`);
        for await (const line of lines(r.body)) {
          const m = /^data:\s?(.*)$/.exec(line);
          if (!m || m[1].trim() === '[DONE]') continue;
          const j = JSON.parse(m[1]);
          if (j.error) throw new Error(`LM Studio ${name}: ${j.error.message ?? j.error}`);
          const d = j.choices?.[0]?.delta ?? {};
          emit(d.reasoning_content ?? d.reasoning, 'thinking');
          emit(d.content, 'content');
          if (j.usage) { out.promptTokens = j.usage.prompt_tokens; out.outputTokens = j.usage.completion_tokens; }
        }
        if (out.outputTokens) out.tokensPerSec = Math.round((out.outputTokens / ((Date.now() - t0) / 1000)) * 10) / 10;
      }
      out.ms = Date.now() - t0;
      return out;
    });
  }

  return { list, chat };
}

/** Runs `fn` under the request's signal, its whole-request timeout and its idle timeout (reset by `touch`) */
async function withTimeouts<T>(req: ChatRequest, fn: (signal: AbortSignal, touch: () => void) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  let why: Error | null = null;
  const stop = (e: Error) => { if (!why) { why = e; ac.abort(e); } };
  const onAbort = () => stop(new AbortedError());
  if (req.signal?.aborted) throw new AbortedError();
  req.signal?.addEventListener('abort', onAbort, { once: true });
  const total = setTimeout(() => stop(new TimeoutError(`no full reply in ${Math.round((req.timeoutMs ?? 600000) / 1000)} s`)), req.timeoutMs ?? 600000);
  const idleMs = req.idleMs ?? 180000;
  let idle = setTimeout(() => stop(new TimeoutError(`nothing from the model for ${Math.round(idleMs / 1000)} s`)), idleMs);
  const touch = () => { clearTimeout(idle); idle = setTimeout(() => stop(new TimeoutError(`nothing from the model for ${Math.round(idleMs / 1000)} s`)), idleMs); };
  try {
    return await fn(ac.signal, touch);
  } catch (e) {
    throw why ?? e;
  } finally {
    clearTimeout(total); clearTimeout(idle);
    req.signal?.removeEventListener('abort', onAbort);
  }
}

/** A byte stream as text lines */
export async function* lines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader(), dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) { yield buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1); }
    }
    buf += dec.decode();
    if (buf) yield buf;
  } finally {
    reader.releaseLock();
  }
}
