// The weapons lab's http handler (server.ts listens with it; tests listen on port 0). Every route needs the key from
// the link (?k=<key>, or the x-lab-key header): the lab listens on every interface for the phone, so the key is the gate.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import http from 'http';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { DATA_DIR, LAB_DIR, keyFile } from './paths';
import { draftEntry, getWeapon, listWeapons } from './catalogue';
import { getDraft, listDrafts, saveDraft, ID_RULE, type Draft } from './drafts';
import { validateModel } from './validate';
import { runSim, type Scenario } from './sim';
import { buildPrompt } from './prompt';
import { complete, loadConfig, type FetchFn, type ProviderName } from './llm';
import { interpretReply } from './reply';

export interface LabOptions { lab?: string; dir?: string; fetch?: FetchFn; fake?: boolean }

/** The page's access key (made once; anyone on the network needs it) */
export function accessKey(lab = LAB_DIR): string {
  if (existsSync(keyFile(lab))) return readFileSync(keyFile(lab), 'utf-8').trim();
  mkdirSync(lab, { recursive: true });
  const k = randomBytes(9).toString('base64url');
  writeFileSync(keyFile(lab), k);
  return k;
}

const here = __dirname;
const asset = (name: string) => readFileSync(join(here, name), 'utf-8');
const SCENARIOS = new Set<string>(['dummy', 'moving', 'wall']);

function send(res: http.ServerResponse, code: number, body: unknown, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 256_000) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
  });
}

export function createLab(opts: LabOptions = {}): http.Server {
  const lab = opts.lab ?? LAB_DIR, dir = opts.dir ?? DATA_DIR, key = accessKey(lab);

  /** The model row a sim or check names: the posted draft row, a saved draft, or null (a game weapon) */
  const draftRow = (b: any): Record<string, any> | undefined => (b.model && typeof b.model === 'object' ? b.model : typeof b.draftId === 'string' ? getDraft(b.draftId, lab)?.model : undefined);

  async function llm(b: any) {
    const id = String(b.id ?? ''), request = String(b.request ?? '').trim();
    if (!ID_RULE.test(id)) throw new Error('give the draft an id: lower-case letters, digits and _ (2-48 characters, starting with a letter)');
    if (!request) throw new Error('write a request first');
    const mode = b.mode === 'new' ? 'new' : 'modify';
    const existing = getDraft(id, lab);
    // What the model sees: the draft so far, else the chosen game weapon (or draft), else for a new weapon one example row
    const baseId = typeof b.base === 'string' ? b.base : existing?.base;
    const baseDraft = baseId ? getDraft(baseId, lab) : null;
    const baseRow = existing?.model ?? baseDraft?.model ?? (baseId ? (getWeapon(baseId, dir)?.raw as any) : undefined) ?? (mode === 'new' ? (getWeapon('cannon_pip', dir)?.raw as any) : undefined);
    if (mode === 'modify' && !baseRow) throw new Error('pick a weapon to modify');
    const prompt = buildPrompt({ mode, weapon: baseRow, id, request, history: existing?.history.map((h) => h.request) }, dir);
    const cfg = loadConfig(lab), provider = (b.provider === 'lmstudio' || b.provider === 'ollama' ? b.provider : cfg.provider) as ProviderName;
    const at = new Date().toISOString();
    let reply = '';
    try { reply = await complete(cfg, prompt, { provider, fetch: opts.fetch, fake: opts.fake, example: baseRow }); }
    catch (e) {
      const error = String((e as Error).message ?? e);
      if (existing) saveDraft({ ...existing, history: [...existing.history, { at, request, provider, ok: false, error }] }, lab);
      return { ok: false, problems: [error], prompt };
    }
    const r = interpretReply(reply, id, dir);
    const item = { at, request, provider, ok: r.ok, ...(r.ok ? {} : { problems: r.problems }) };
    // A valid reply makes (or replaces) the draft; an invalid one is only shown, and noted on a draft that already exists
    if (r.ok) {
      const draft: Draft = { id, base: baseId && baseId !== id ? baseId : existing?.base, model: r.model!, history: [...(existing?.history ?? []), item], updated: at };
      return { ok: true, problems: [], draft: saveDraft(draft, lab), reply, prompt };
    }
    if (existing) saveDraft({ ...existing, history: [...existing.history, item] }, lab);
    return { ok: false, problems: r.problems, reply, prompt };
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if ((url.searchParams.get('k') ?? req.headers['x-lab-key']) !== key) return send(res, 403, 'Open the link with its key (?k=...) printed by npm run lab:weapons.', 'text/plain');
    try {
      const get = req.method === 'GET', post = req.method === 'POST', p = url.pathname;
      // (The page's script needs the key too: the link's key is put on its src)
      if (get && p === '/') return send(res, 200, asset('index.html').replace('src="app.js"', `src="app.js?k=${key}"`), 'text/html; charset=utf-8');
      if (get && p === '/app.js') return send(res, 200, asset('app.js'), 'text/javascript; charset=utf-8');
      if (get && p === '/api/weapons') return send(res, 200, listWeapons(dir).map(({ raw, ...w }) => w));
      if (get && p === '/api/weapon') { const w = getWeapon(url.searchParams.get('id') ?? '', dir); return w ? send(res, 200, w) : send(res, 404, { error: 'no such weapon' }); }
      if (get && p === '/api/drafts') return send(res, 200, listDrafts(lab));
      if (get && p === '/api/draft') { const d = getDraft(url.searchParams.get('id') ?? '', lab); return d ? send(res, 200, { ...d, entry: draftEntry(d.model, dir) }) : send(res, 404, { error: 'no such draft' }); }
      if (get && p === '/api/config') { const c = loadConfig(lab); return send(res, 200, { provider: c.provider, ollama: c.ollama, lmstudio: c.lmstudio, fake: opts.fake ?? process.env.LAB_FAKE_LLM === '1' }); }
      if (post && p === '/api/sim') {
        const b = await readBody(req), row = draftRow(b), weapon = String(b.weapon ?? row?.id ?? '');
        if (!SCENARIOS.has(b.scenario)) return send(res, 400, { error: 'scenario must be dummy, moving or wall' });
        if (!row && !getWeapon(weapon, dir)) return send(res, 404, { error: 'no such weapon' });
        return send(res, 200, runSim({ weapon, draft: row, scenario: b.scenario as Scenario, ticks: Number(b.ticks) || undefined }, dir));
      }
      if (post && p === '/api/check') { const b = await readBody(req); return send(res, 200, validateModel(draftRow(b), dir)); }
      if (post && p === '/api/draft') {
        // A hand edit of a draft's JSON: saved only if it validates
        const b = await readBody(req), v = validateModel(b.model, dir);
        if (!v.ok) return send(res, 200, { ok: false, problems: v.problems });
        const old = getDraft(b.model.id, lab);
        return send(res, 200, { ok: true, problems: [], draft: saveDraft({ id: b.model.id, base: old?.base ?? b.base, model: b.model, history: old?.history ?? [], updated: '' }, lab) });
      }
      if (post && p === '/api/llm') return send(res, 200, await llm(await readBody(req)));
      send(res, 404, { error: 'not found' });
    } catch (e) {
      send(res, 400, { error: String((e as Error).message ?? e) });
    }
  });
}
