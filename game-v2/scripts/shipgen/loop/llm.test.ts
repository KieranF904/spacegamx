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
    const llm = createLlm({ token: () => undefined, fetch: fakeFetch((u) => (u.endsWith('/api/tags') ? json(TAGS) : json({}, 404))) });
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
      token: () => undefined,
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
    const llm = createLlm({ token: () => undefined, fetch: fakeFetch((u) => (u.endsWith('/api/tags') ? json(tags) : new Response(streamOf(ollamaChunks)))) });
    const r = await llm.chat({ model: 'old:1b', schema: DESIGN_SCHEMA, messages: [{ role: 'user', content: 'hi' }] });
    expect(r.structured).toBe(false);
    expect(JSON.parse(String(calls.find((c) => c.url.endsWith('/api/chat'))!.init.body)).format).toBeUndefined();
  });

  it('talks to LM Studio with the bearer token, json_schema and SSE; the token goes nowhere but the header', async () => {
    const SECRET = 'sk-test-secret-123';
    const sse = ['data: {"choices":[{"delta":{"content":"{\\"name\\""}}]}\n\n', 'data: {"choices":[{"delta":{"content":":\\"B\\"}"}}]}\n\n', 'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":4}}\n\n', 'data: [DONE]\n\n'];
    const llm = createLlm({
      token: () => SECRET,
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

  it('refuses LM Studio without a token (and says where to put it)', async () => {
    const llm = createLlm({ token: () => undefined, fetch: fakeFetch(() => json({}, 500)) });
    await expect(llm.chat({ model: 'lmstudio/x', messages: [] })).rejects.toThrow(/LM_API_TOKEN/);
    await expect(llm.list()).rejects.toThrow(/LM_API_TOKEN/);
  });

  it('cancels mid-stream with an AbortController', async () => {
    const llm = createLlm({ token: () => undefined, fetch: fakeFetch((u, init) => (u.endsWith('/api/tags') ? json(TAGS) : new Response(streamOf(ollamaChunks, 30, init.signal)))) });
    const ac = new AbortController();
    const p = llm.chat({ model: 'gemma4:12b', messages: [], signal: ac.signal, onToken: () => ac.abort() });
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    const pre = new AbortController(); pre.abort();
    await expect(llm.chat({ model: 'gemma4:12b', messages: [], signal: pre.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('times out when the model goes quiet', async () => {
    const llm = createLlm({ token: () => undefined, fetch: fakeFetch((u, init) => (u.endsWith('/api/tags') ? json(TAGS) : new Response(streamOf(ollamaChunks, 200, init.signal)))) });
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
