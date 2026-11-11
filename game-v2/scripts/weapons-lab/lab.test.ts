// The weapons lab: the weapon list, the prompt, reply checking, drafts kept apart, the key gate, the providers (a fake
// fetch: no model is ever called) and one short sim preview.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { listWeapons, getWeapon } from './catalogue';
import { buildPrompt } from './prompt';
import { extractJson, interpretReply } from './reply';
import { complete, DEFAULT_CONFIG, type FetchFn } from './llm';
import { createLab, accessKey } from './lab';
import { runSim } from './sim';
import { DATA_DIR } from './paths';

const modelsFile = join(DATA_DIR, 'ships', 'models.json');
const cannon = () => getWeapon('cannon_pip')!.raw as any;
let servers: Server[] = [];
const tmpLab = () => mkdtempSync(join(tmpdir(), 'weapons-lab-'));
afterEach(() => { for (const s of servers) s.close(); servers = []; });

async function boot(opts: Parameters<typeof createLab>[0] = {}) {
  const lab = opts.lab ?? tmpLab(), server = createLab({ ...opts, lab });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`, k = accessKey(lab);
  const call = async (path: string, body?: unknown, key = k) => {
    const r = await fetch(`${base}${path}${path.includes('?') ? '&' : '?'}k=${key}`, body ? { method: 'POST', body: JSON.stringify(body) } : undefined);
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { lab, base, k, call };
}

describe('weapons lab: weapon list', () => {
  it('lists the game\'s player models, legacy guns and kinds, with stats and raw data', () => {
    const all = listWeapons();
    expect(all.some((w) => w.source === 'model' && w.owner === 'player')).toBe(true);
    expect(all.some((w) => w.source === 'legacy')).toBe(true);
    expect(all.some((w) => w.id === 'kind:flak')).toBe(true);
    const pip = all.find((w) => w.id === 'cannon_pip')!;
    expect(pip.stats.find((s) => s.label === 'Damage')!.value).toBe('18');
    expect((pip.raw as any).weapon).toBe('cannon');
  });
});

describe('weapons lab: the prompt', () => {
  it('carries the schema, the house rules, the selected weapon and the request', () => {
    const { system, user } = buildPrompt({ mode: 'modify', weapon: cannon(), id: 'pip_fast', request: 'fire twice as fast' });
    expect(system).toContain('interface FireSpec');
    expect(system).toContain('interface WeaponMods');
    expect(system).toContain('deterministic');
    expect(system).toContain('flak'); // the live kind list
    expect(system).toContain('JSON');
    expect(user).toContain('"id": "cannon_pip"');
    expect(user).toContain('pip_fast');
    expect(user).toContain('fire twice as fast');
  });
});

describe('weapons lab: reading a reply', () => {
  it('rejects text with no JSON, broken JSON and arrays', () => {
    expect(extractJson('I would make it faster.').error).toMatch(/no JSON/);
    expect(extractJson('{"a": 1,}').error).toMatch(/not valid JSON/);
    expect(extractJson('[1]').error).toBeTruthy();
  });

  it('strips think blocks and code fences', () => {
    expect(extractJson('<think>hmm {x}</think>\n```json\n{"a":1}\n```').value).toEqual({ a: 1 });
  });

  it('rejects a weapon the game\'s validators would (unknown kind, bad grade, unknown piece)', () => {
    const bad = (patch: object) => interpretReply(JSON.stringify({ ...cannon(), ...patch }), 'pip_x');
    expect(bad({ weapon: 'no_such_kind' }).ok).toBe(false);
    expect(bad({ grade: 9 }).problems.join(' ')).toMatch(/grade/);
    expect(bad({ pieces: ['nope'] }).ok).toBe(false);
    expect(bad({}).ok).toBe(true);
  });

  it('renames a reply to the draft\'s id', () => {
    expect(interpretReply(JSON.stringify(cannon()), 'pip_renamed').model!.id).toBe('pip_renamed');
  });
});

describe('weapons lab: providers', () => {
  const chat = { system: 'S', user: 'U' };
  it('Ollama: posts to /api/chat with the configured model and reads message.content', async () => {
    let seen: { url: string; body: any } | null = null;
    const fetch: FetchFn = async (url, init) => { seen = { url, body: JSON.parse(init.body) }; return { ok: true, status: 200, json: async () => ({ message: { content: '{"a":1}' } }), text: async () => '' }; };
    expect(await complete(DEFAULT_CONFIG, chat, { provider: 'ollama', fetch, fake: false })).toBe('{"a":1}');
    expect(seen!.url).toBe('http://localhost:11434/api/chat');
    expect(seen!.body.model).toBe(DEFAULT_CONFIG.ollama.model);
    expect(seen!.body.messages.map((m: any) => m.content)).toEqual(['S', 'U']);
  });

  it('LM Studio: posts to /v1/chat/completions and reads choices[0]', async () => {
    let url = '';
    const fetch: FetchFn = async (u) => { url = u; return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'x' } }] }), text: async () => '' }; };
    expect(await complete(DEFAULT_CONFIG, chat, { provider: 'lmstudio', fetch, fake: false })).toBe('x');
    expect(url).toBe('http://localhost:1234/v1/chat/completions');
  });

  it('a provider error is thrown with its status', async () => {
    const fetch: FetchFn = async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => 'boom' });
    await expect(complete(DEFAULT_CONFIG, chat, { provider: 'ollama', fetch, fake: false })).rejects.toThrow(/500/);
  });
});

describe('weapons lab: the server', () => {
  it('needs the key in the link', async () => {
    const { call, base } = await boot({ fake: true });
    expect((await call('/api/weapons', undefined, 'wrong')).status).toBe(403);
    expect((await fetch(`${base}/`)).status).toBe(403);
    expect((await call('/api/weapons')).status).toBe(200);
  });

  it('keeps a drafted weapon in lab/weapons/, with its prompt history, and leaves the game data alone', async () => {
    const before = readFileSync(modelsFile, 'utf-8');
    const { call, lab } = await boot({ fake: true });
    const r = await call('/api/llm', { mode: 'modify', id: 'pip_hot', base: 'cannon_pip', request: 'hit harder' });
    expect(r.body.ok).toBe(true);
    expect(r.body.prompt.user).toContain('hit harder');
    const file = join(lab, 'weapons', 'pip_hot.json');
    expect(existsSync(file)).toBe(true);
    const saved = JSON.parse(readFileSync(file, 'utf-8'));
    expect(saved.model.id).toBe('pip_hot');
    expect(saved.base).toBe('cannon_pip');
    expect(saved.history.map((h: any) => h.request)).toEqual(['hit harder']);
    expect(readFileSync(modelsFile, 'utf-8')).toBe(before);
    expect(listWeapons().some((w) => w.id === 'pip_hot')).toBe(false);
    // A second request lands on the same draft, history kept
    await call('/api/llm', { mode: 'modify', id: 'pip_hot', request: 'again' });
    expect((await call('/api/draft?id=pip_hot')).body.history).toHaveLength(2);
    expect((await call('/api/drafts')).body.map((d: any) => d.id)).toEqual(['pip_hot']);
    rmSync(lab, { recursive: true, force: true });
  });

  it('shows a rejected reply and saves nothing', async () => {
    const fetch: FetchFn = async () => ({ ok: true, status: 200, json: async () => ({ message: { content: 'sure, here you go' } }), text: async () => '' });
    const { call, lab } = await boot({ fake: false, fetch });
    const r = await call('/api/llm', { mode: 'new', id: 'nothing', request: 'a gun', provider: 'ollama' });
    expect(r.body.ok).toBe(false);
    expect(r.body.problems[0]).toMatch(/no JSON/);
    expect(existsSync(join(lab, 'weapons', 'nothing.json'))).toBe(false);
  });

  it('refuses an id that is not a plain name', async () => {
    const { call } = await boot({ fake: true });
    expect((await call('/api/llm', { mode: 'new', id: '../evil', request: 'x' })).status).toBe(400);
  });
});

describe('weapons lab: the sim preview', () => {
  it('runs the game\'s own sim: a Pip hits the dummy, and a draft row can be fired', () => {
    const r = runSim({ weapon: 'cannon_pip', scenario: 'dummy', ticks: 200 });
    expect(r.frames).toHaveLength(200);
    expect(r.dealt[0]).toBeGreaterThan(0);
    expect(r.frames.some((f) => f.sh.length > 0)).toBe(true);
    const draft = { ...cannon(), id: 'pip_lab', name: 'Lab Pip' };
    const d = runSim({ weapon: 'pip_lab', draft, scenario: 'moving', ticks: 120 });
    expect(d.frames.some((f) => f.sh.length > 0)).toBe(true);
  });
});
