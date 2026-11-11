// Model providers for the lab's weapon editing: a local Ollama (/api/chat) or LM Studio's OpenAI-compatible API
// (/v1/chat/completions). Base URLs and model names come from lab/config.json (gitignored); defaults are the usual
// local ports. `fetch` is injectable and LAB_FAKE_LLM=1 swaps in a fake provider that never leaves the process: the
// lab's tests (and anyone trying the page without a model running) use these; no real model is called unless asked.
import { existsSync, readFileSync } from 'fs';
import { configFile } from './paths';

export type ProviderName = 'ollama' | 'lmstudio';
export interface ProviderConfig { baseUrl: string; model: string }
export interface LabConfig { provider: ProviderName; ollama: ProviderConfig; lmstudio: ProviderConfig }
export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> }>;

export const DEFAULT_CONFIG: LabConfig = {
  provider: 'ollama',
  ollama: { baseUrl: 'http://localhost:11434', model: 'deepseek-r1' },
  lmstudio: { baseUrl: 'http://localhost:1234', model: 'local-model' },
};

/** Defaults, overridden by lab/config.json (any part of it) */
export function loadConfig(lab?: string): LabConfig {
  let user: Partial<LabConfig> = {};
  if (existsSync(configFile(lab))) { try { user = JSON.parse(readFileSync(configFile(lab), 'utf-8')); } catch { /* a broken config: defaults */ } }
  return { provider: user.provider ?? DEFAULT_CONFIG.provider, ollama: { ...DEFAULT_CONFIG.ollama, ...user.ollama }, lmstudio: { ...DEFAULT_CONFIG.lmstudio, ...user.lmstudio } };
}

export interface Chat { system: string; user: string }

/** The canned reply of the fake provider: the example row in the prompt, a little stronger (so a draft visibly differs) */
export function fakeReply(example: any): string {
  const row = JSON.parse(JSON.stringify(example ?? { id: 'fake', model: true, name: 'Fake', family: 'cannon', pieces: ['sq'], material: 'alloy', grade: 1, weapon: 'cannon', mount: 'fixed', demand: 8, fireInterval: 20 }));
  const set = (row.weaponMods ??= {}).set ??= {};
  set.damage = Math.round(((set.damage ?? 14) as number) * 1.2);
  return JSON.stringify(row);
}

/** Ask the provider; returns the model's text. `example`: what the fake provider answers from */
export async function complete(cfg: LabConfig, chat: Chat, opts: { provider?: ProviderName; fetch?: FetchFn; fake?: boolean; example?: unknown } = {}): Promise<string> {
  if (opts.fake ?? process.env.LAB_FAKE_LLM === '1') return fakeReply(opts.example);
  const name = opts.provider ?? cfg.provider, p = cfg[name], f = opts.fetch ?? (fetch as unknown as FetchFn);
  const messages = [{ role: 'system', content: chat.system }, { role: 'user', content: chat.user }];
  const headers = { 'Content-Type': 'application/json' };
  const signal = AbortSignal.timeout(15 * 60 * 1000);
  if (name === 'ollama') {
    const r = await f(`${p.baseUrl}/api/chat`, { method: 'POST', headers, signal, body: JSON.stringify({ model: p.model, messages, stream: false, format: 'json' }) });
    if (!r.ok) throw new Error(`Ollama answered ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return String((await r.json()).message?.content ?? '');
  }
  const r = await f(`${p.baseUrl}/v1/chat/completions`, { method: 'POST', headers, signal, body: JSON.stringify({ model: p.model, messages, temperature: 0.3, stream: false }) });
  if (!r.ok) throw new Error(`LM Studio answered ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return String((await r.json()).choices?.[0]?.message?.content ?? '');
}
