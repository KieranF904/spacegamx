import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createLlm, defaultModel, splitId } from './llm';
import { lmStudioToken } from './secrets';
import { DESIGN_SCHEMA } from './reply';

// A fake fetch: routes by URL; chat bodies stream out as chunks (with a pause between, so an abort can land mid-stream)
type Route = (url: string, init: RequestInit) => Response | Promise<Response>;
const calls: { url: string; init: RequestInit }[] = [];
function fakeFetch(route: Route): typeof fetch {
  calls.length = 0;
  return (async (u: string | URL, init: RequestInit = {}) => { calls.push({ url: String(u), init }); return route(String(u), init); }) as typeof fetch;
}
function streamOf(chunks: string[], gapMs = 0, signal?: AbortSignal | null): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    async start(c) {
      for (const ch of chunks) {
        if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
        if (signal?.aborted) { c.error(signal.reason); return; }
        c.enqueue(enc.encode(ch));
      }
      c.close();
    },
  });
}
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });

const TAGS = {
  models: [
    { name: 'gemma4:12b', size: 8e9, details: { parameter_size: '11.9B', context_length: 262144 }, capabilities: ['completion', 'vision', 'thinking'] },
    { name: 'nemotron-3-super:cloud', remote_host: 'https://ollama.com', capabilities: ['completion'] },
    { name: 'gpt-oss:20b-cloud', capabilities: ['completion'] },
    { name: 'd3:2b', capabilities: ['decision', 'vision'] },
  ],
};
const ollamaChunks = ['{"message":{"content":"name: A\\n"},"done":false}\n', '{"message":{"thinking":"hm"},"done":false}\n{"message":{"content":"grid:\\n"},"done":false}\n', '{"message":{"content":"end"},"done":true,"prompt_eval_count":50,"eval_count":20,"eval_duration":1000000000}\n'];

describe('shipgen llm client', () => {
  it('splits model ids', () => {
    expect(splitId('gemma4:12b')).toEqual({ provider: 'ollama', name: 'gemma4:12b' });
    expect(splitId('lmstudio/qwen/qwen3-8b')).toEqual({ provider: 'lmstudio', name: 'qwen/qwen3-8b' });
  });

  it('lists Ollama models with vision, chat and cloud flags; never defaults to a cloud model', async () => {
    const llm = createLlm({ anthropicKey: () => undefined, token: () => undefined, fetch: fakeFetch((u) => (u.endsWith('/api/tags') ? json(TAGS) : json({}, 404))) });
    const l = await llm.list();
    const by = Object.fromEntries(l.map((m) => [m.name, m]));
    expect(by['gemma4:12b']).toMatchObject({ id: 'ollama/gemma4:12b', vision: true, cloud: false, chat: true, thinking: true, structured: true, params: '11.9B' });
    expect(by['nemotron-3-super:cloud'].cloud).toBe(true);
    expect(by['gpt-oss:20b-cloud'].cloud).toBe(true);
    expect(by['d3:2b'].chat).toBe(false);
    expect(defaultModel([by['nemotron-3-super:cloud'], by['d3:2b'], by['gemma4:12b']])?.name).toBe('gemma4:12b');
    expect(defaultModel([by['nemotron-3-super:cloud']])).toBeUndefined();
    expect(defaultModel(l, { vision: true })?.name).toBe('gemma4:12b');
  });

  it('streams an Ollama chat, sends the schema as format, turns thinking off, passes images', async () => {
    const llm = createLlm({
      anthropicKey: () => undefined, token: () => undefined,
      fetch: fakeFetch((u) => (u.endsWith('/api/tags') ? json(TAGS) : new Response(streamOf(ollamaChunks)))),
    });
    const toks: string[] = [];
    const r = await llm.chat({ model: 'gemma4:12b', schema: DESIGN_SCHEMA, numCtx: 8192, messages: [{ role: 'user', content: 'hi', images: ['AAAA'] }], onToken: (d, k) => toks.push(`${k}:${d}`) });
    expect(r.text).toBe('name: A\ngrid:\nend');
    expect(r.thinking).toBe('hm');
    expect(r.structured).toBe(true);
    expect(r.outputTokens).toBe(20);
    expect(r.tokensPerSec).toBe(20);
    expect(toks).toContain('thinking:hm');
    const body = JSON.parse(String(calls.find((c) => c.url.endsWith('/api/chat'))!.init.body));
    expect(body.format).toEqual(DESIGN_SCHEMA);
    expect(body.think).toBe(false);
    expect(body.stream).toBe(true);
    expect(body.options.num_ctx).toBe(8192);
    expect(body.messages[0].images).toEqual(['AAAA']);
  });

  it("doesn't send a schema to a model that can't take one", async () => {
    const tags = { models: [{ name: 'old:1b', capabilities: ['tools'] }] };
    const llm = createLlm({ anthropicKey: () => undefined, token: () => undefined, fetch: fakeFetch((u) => (u.endsWith('/api/tags') ? json(tags) : new Response(streamOf(ollamaChunks)))) });
    const r = await llm.chat({ model: 'old:1b', schema: DESIGN_SCHEMA, messages: [{ role: 'user', content: 'hi' }] });
    expect(r.structured).toBe(false);
    expect(JSON.parse(String(calls.find((c) => c.url.endsWith('/api/chat'))!.init.body)).format).toBeUndefined();
  });

  it('talks to LM Studio with the bearer token, json_schema and SSE; the token goes nowhere but the header', async () => {
    const SECRET = 'sk-test-secret-123';
    const sse = ['data: {"choices":[{"delta":{"content":"{\\"name\\""}}]}\n\n', 'data: {"choices":[{"delta":{"content":":\\"B\\"}"}}]}\n\n', 'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":4}}\n\n', 'data: [DONE]\n\n'];
    const llm = createLlm({
      anthropicKey: () => undefined, token: () => SECRET, lmStudioChat: () => true,
      fetch: fakeFetch((u) => (u.endsWith('/api/tags') ? json({}, 500) : u.endsWith('/api/v0/models') ? json({ data: [{ id: 'qwen3-vl', type: 'vlm' }, { id: 'nomic-embed', type: 'embeddings' }] }) : new Response(streamOf(sse)))),
    });
    const l = await llm.list();
    expect(l.map((m) => m.id)).toEqual(['lmstudio/qwen3-vl']);
    expect(l[0].vision).toBe(true);
    const r = await llm.chat({ model: 'lmstudio/qwen3-vl', schema: DESIGN_SCHEMA, messages: [{ role: 'user', content: 'x', images: ['QQ=='] }] });
    expect(r.text).toBe('{"name":"B"}');
    expect(r.outputTokens).toBe(4);
    const c = calls.find((x) => x.url.endsWith('/v1/chat/completions'))!;
    expect((c.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${SECRET}`);
    const body = JSON.parse(String(c.init.body));
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.schema).toEqual(DESIGN_SCHEMA);
    expect(body.messages[0].content[1].image_url.url).toBe('data:image/png;base64,QQ==');
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it('only LISTS LM Studio models by default: no chat request ever goes to it unless LMSTUDIO_CHAT=1 or the toggle is on', async () => {
    const old = process.env.LMSTUDIO_CHAT;
    delete process.env.LMSTUDIO_CHAT;
    try {
      const route = (u: string) => (u.endsWith('/api/tags') ? json(TAGS) : u.endsWith('/api/v0/models') ? json({ data: [{ id: 'qwen3-8b', type: 'llm' }] }) : new Response(streamOf(['data: [DONE]\n\n'])));
      const llm = createLlm({ anthropicKey: () => undefined, token: () => 'sk-x', fetch: fakeFetch(route) });
      const l = await llm.list();
      const lm = l.find((m) => m.provider === 'lmstudio')!;
      expect(lm.off).toBe('LM Studio, not enabled');
      expect(defaultModel(l.filter((m) => m.provider === 'lmstudio'))).toBeUndefined();
      await expect(llm.chat({ model: 'lmstudio/qwen3-8b', messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(/not enabled[\s\S]*LMSTUDIO_CHAT=1/);
      expect(calls.filter((c) => /lmstudio|:1234/.test(c.url) && /chat|completions/.test(c.url))).toEqual([]);
      expect(calls.some((c) => c.url.includes('/v1/chat/completions'))).toBe(false);
      // (Ollama still chats)
      expect(l.find((m) => m.provider === 'ollama')!.off).toBeUndefined();
      // The environment switch turns it on
      process.env.LMSTUDIO_CHAT = '1';
      const on = createLlm({ anthropicKey: () => undefined, token: () => 'sk-x', fetch: fakeFetch(route) });
      expect((await on.list()).find((m) => m.provider === 'lmstudio')!.off).toBeUndefined();
      await on.chat({ model: 'lmstudio/qwen3-8b', messages: [{ role: 'user', content: 'hi' }] });
      expect(calls.some((c) => c.url.endsWith('/v1/chat/completions'))).toBe(true);
    } finally {
      if (old === undefined) delete process.env.LMSTUDIO_CHAT; else process.env.LMSTUDIO_CHAT = old;
    }
  });

  it('lists every downloaded LM Studio model from /api/v1/models (loaded or not), without loading any', async () => {
    const v1 = { models: [{ type: 'llm', key: 'qwen3.6-27b', params_string: '27B', capabilities: { vision: false, reasoning: { default: 'on' } } }, { type: 'embedding', key: 'nomic' }] };
    const llm = createLlm({ anthropicKey: () => undefined, token: () => 'sk-x', lmStudioChat: () => false, fetch: fakeFetch((u) => (u.endsWith('/api/tags') ? json({ models: [] }) : u.endsWith('/api/v1/models') ? json(v1) : json({ data: [] }))) });
    const l = await llm.list();
    expect(l.map((m) => [m.id, m.off, m.params])).toEqual([['lmstudio/qwen3.6-27b', 'LM Studio, not enabled', '27B']]);
    expect(calls.every((c) => !c.init.method || c.init.method === 'GET')).toBe(true);
  });

  it('refuses LM Studio without a token (and says where to put it)', async () => {
    const llm = createLlm({ anthropicKey: () => undefined, token: () => undefined, lmStudioChat: () => true, fetch: fakeFetch(() => json({}, 500)) });
    await expect(llm.chat({ model: 'lmstudio/x', messages: [] })).rejects.toThrow(/LM_API_TOKEN/);
    await expect(llm.list()).rejects.toThrow(/LM_API_TOKEN/);
  });

  it('cancels mid-stream with an AbortController', async () => {
    const llm = createLlm({ anthropicKey: () => undefined, token: () => undefined, fetch: fakeFetch((u, init) => (u.endsWith('/api/tags') ? json(TAGS) : new Response(streamOf(ollamaChunks, 30, init.signal)))) });
    const ac = new AbortController();
    const p = llm.chat({ model: 'gemma4:12b', messages: [], signal: ac.signal, onToken: () => ac.abort() });
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    const pre = new AbortController(); pre.abort();
    await expect(llm.chat({ model: 'gemma4:12b', messages: [], signal: pre.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('times out when the model goes quiet', async () => {
    const llm = createLlm({ anthropicKey: () => undefined, token: () => undefined, fetch: fakeFetch((u, init) => (u.endsWith('/api/tags') ? json(TAGS) : new Response(streamOf(ollamaChunks, 200, init.signal)))) });
    await expect(llm.chat({ model: 'gemma4:12b', messages: [], idleMs: 50 })).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('reads the LM Studio token from the environment, else .env', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shipgen-'));
    const f = join(dir, '.env');
    writeFileSync(f, '# x\r\nOTHER=1\r\nLM_API_TOKEN="abc def"\r\n');
    const old = process.env.LM_API_TOKEN;
    delete process.env.LM_API_TOKEN;
    try {
      expect(lmStudioToken(f)).toBe('abc def');
      expect(lmStudioToken(join(dir, 'missing'))).toBeUndefined();
      process.env.LM_API_TOKEN = 'from-env';
      expect(lmStudioToken(f)).toBe('from-env');
    } finally {
      if (old === undefined) delete process.env.LM_API_TOKEN; else process.env.LM_API_TOKEN = old;
    }
  });
});

describe('anthropic provider', () => {
  const sse = (events: object[]) => new Response(events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join(''));
  it('is listed only with a key, as a cloud model, and never loads anything', async () => {
    const f = (async (u: any) => { if (String(u).includes('11434')) return new Response(JSON.stringify({ models: [] })); throw new Error('down'); }) as typeof fetch;
    const none = await createLlm({ fetch: f, token: () => undefined, anthropicKey: () => undefined }).list().catch(() => []);
    expect(none.some((m) => m.provider === 'anthropic')).toBe(false);
    const withKey = await createLlm({ fetch: f, token: () => undefined, anthropicKey: () => 'k' }).list();
    const m = withKey.find((x) => x.provider === 'anthropic')!;
    expect(m).toMatchObject({ id: 'anthropic/claude-haiku-5-5', cloud: true, chat: true, structured: false });
  });
  it('sends the key in a header, system as a top-level field, and reads the streamed text and usage', async () => {
    let seen: any;
    const f = (async (u: any, init: any) => {
      if (String(u).includes('11434')) return new Response(JSON.stringify({ models: [] }));
      seen = { url: String(u), headers: init.headers, body: JSON.parse(init.body) };
      return sse([{ type: 'message_start', message: { usage: { input_tokens: 12 } } }, { type: 'content_block_delta', delta: { type: 'text_delta', text: 'he' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'llo' } }, { type: 'message_delta', usage: { output_tokens: 3 } }]);
    }) as typeof fetch;
    const llm = createLlm({ fetch: f, token: () => undefined, anthropicKey: () => 'secret-key' });
    const r = await llm.chat({ model: 'anthropic/claude-haiku-5-5', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }], temperature: 0.7 });
    expect(r.text).toBe('hello');
    expect(r.promptTokens).toBe(12); expect(r.outputTokens).toBe(3);
    expect(seen.url).toBe('https://api.anthropic.com/v1/messages');
    expect(seen.headers['x-api-key']).toBe('secret-key');
    expect(seen.body.system).toBe('sys');
    expect(seen.body.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(JSON.stringify(r)).not.toContain('secret-key');
  });
  it('refuses without a key, before any request', async () => {
    const f = (async () => { throw new Error('no network expected'); }) as typeof fetch;
    await expect(createLlm({ fetch: f, token: () => undefined, anthropicKey: () => undefined }).chat({ model: 'anthropic/claude-haiku-5-5', messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});
