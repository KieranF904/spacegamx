// Local weapon sound review tool: listen, write notes, and generate better takes with fal.ai (ElevenLabs sound effects v2).
//   npm run sounds:review            then open http://localhost:5455
//   SOUND_REVIEW_FAKE=1 npm run sounds:review   no fal calls at all: "generating" copies the current sound (for testing the page)
// Candidates are saved to review/sounds/<sound-id>/<timestamp>.<ext> (+ a .json sidecar of prompt, settings, endpoint, time);
// notes, drafts, confirmations and discards live in review/sounds/review.json. Nothing goes into the game: whoever integrates
// reads review.json and copies a chosen candidate over client/public/sfx/<id>.mp3 (see the page's footer).
// The fal key (FAL_KEY in the environment or game-v2/.env) is read here and never sent to the page or printed.
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const sfxDir = path.join(root, 'client/public/sfx');
const reviewDir = path.join(root, 'review/sounds');
const manifestFile = path.join(reviewDir, 'review.json');
const partsDir = path.join(root, 'docs/design/guide/img/parts');
const port = Number(process.env.SOUND_REVIEW_PORT ?? 5455);
const FAKE = process.env.SOUND_REVIEW_FAKE === '1';
const ENDPOINT = 'fal-ai/elevenlabs/sound-effects/v2';
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf-8'));

function falKey() {
  if (process.env.FAL_KEY) return process.env.FAL_KEY;
  try {
    const m = fs.readFileSync(path.join(root, '.env'), 'utf-8').match(/^\s*FAL_KEY\s*=\s*(.+?)\s*$/m);
    return m ? m[1].replace(/^["']|["']$/g, '') : '';
  } catch { return ''; }
}

// ---- what the sounds are, who uses them
function buildSounds() {
  const { sounds } = readJson('scripts/sfx-manifest.json');
  const fns = readJson('data/ships/functions.json').functions;
  const models = readJson('data/ships/models.json').models;
  const shots = readJson('data/audio.json').shots ?? {};
  const uses = {}; // sound id -> [{ id, name, role, image }]
  const add = (sid, u) => { if (sid) (uses[sid] ??= []).push(u); };
  const image = (id) => (fs.existsSync(path.join(partsDir, `model_${id}.png`)) ? `/part/model_${id}.png` : null);
  const walk = (list, kind) => {
    for (const p of Array.isArray(list) ? list : Object.values(list)) {
      if (!p.weapon && !p.sfx && !p.sfxLoop) continue;
      const base = { id: p.id, name: p.name ?? p.id, image: image(p.id), family: p.family ?? p.weapon, kind };
      add(p.sfx, { ...base, role: 'shot' });
      add(p.sfxTurret, { ...base, role: 'turret shot' });
      add(p.sfxLoop, { ...base, role: 'beam loop' });
    }
  };
  walk(fns, 'kind');
  walk(models, 'model');
  for (const [kind, s] of Object.entries(shots)) {
    if (kind.startsWith('_') || !s) continue;
    add(typeof s === 'string' ? s : s.sfx, { id: kind, name: kind.replace(/_/g, ' '), role: 'projectile (no part fires it)', image: null, kind: 'projectile' });
  }
  const specials = {
    target_tone: 'Targeting: the soft rising tone when something locks onto you (boss and enemy warnings)',
    suck_whoosh: 'Scrap mite suck: the pull-in whoosh of a scrap mite drawing you in',
  };
  const files = (id) => fs.readdirSync(sfxDir).filter((f) => f === `${id}.mp3` || new RegExp(`^${id}_\\d+\\.mp3$`).test(f)).sort();
  return sounds.map((s) => {
    const used = uses[s.id] ?? [];
    // (A kind and a model of the same name share a sound: list it once)
    const seen = new Set();
    const usedBy = used.filter((u) => { const k = `${u.name}|${u.role}`; if (seen.has(k)) return false; seen.add(k); return true; });
    const cat = specials[s.id] ? 'special' : usedBy.length ? 'weapon' : 'other';
    return {
      id: s.id, category: cat, description: specials[s.id] ?? null, usedBy, files: files(s.id),
      original: { prompt: s.prompt, duration: s.duration, influence: s.influence ?? 0.5, loop: !!s.loop, variants: s.variants ?? 1 },
    };
  });
}
let SOUNDS = buildSounds();

// ---- review manifest: { sounds: { id: { note, draft, chosen, candidates: { file: { status } } } } }
function loadManifest() {
  try { return JSON.parse(fs.readFileSync(manifestFile, 'utf-8')); } catch { return { sounds: {} }; }
}
function saveManifest(m) {
  fs.mkdirSync(reviewDir, { recursive: true });
  const tmp = manifestFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2) + '\n');
  fs.renameSync(tmp, manifestFile);
}
const entry = (m, id) => (m.sounds[id] ??= { note: '', candidates: {} });

function candidatesOf(id, m) {
  const dir = path.join(reviewDir, id);
  if (!fs.existsSync(dir)) return [];
  const e = m.sounds[id];
  return fs.readdirSync(dir).filter((f) => /\.(mp3|wav|ogg)$/i.test(f)).sort().reverse().map((f) => {
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, f.replace(/\.\w+$/, '.json')), 'utf-8')); } catch { /* sidecar missing */ }
    return { file: f, ...meta, status: e?.candidates?.[f]?.status ?? 'new', chosen: e?.chosen === f };
  });
}

// ---- generation: one in flight per sound, a short cooldown after, a small global cap
const httpErr = (status, message) => Object.assign(new Error(message), { status });
const inflight = new Map(); // id -> { started }
const lastDone = new Map();
const COOLDOWN_MS = 3000, MAX_INFLIGHT = 3;

async function callFal(key, body) {
  const res = await fetch(`https://fal.run/${ENDPOINT}`, {
    method: 'POST', headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`fal answered ${res.status}: ${(await res.text()).slice(0, 300).split(key).join('***')}`);
  const url = (await res.json()).audio?.url;
  if (!url) throw new Error('fal gave no audio url');
  const a = await fetch(url);
  if (!a.ok) throw new Error(`downloading the audio failed (${a.status})`);
  return Buffer.from(await a.arrayBuffer());
}

async function generate(id, { prompt, duration, influence, loop }) {
  const s = SOUNDS.find((x) => x.id === id);
  if (!s) throw httpErr(404, 'Unknown sound');
  prompt = String(prompt ?? '').trim();
  if (!prompt || prompt.length > 1500) throw httpErr(400, 'The prompt must be 1-1500 characters');
  duration = Number(duration); influence = Number(influence);
  if (!(duration >= 0.5 && duration <= 22)) throw httpErr(400, 'Duration must be 0.5-22 seconds');
  if (!(influence >= 0 && influence <= 1)) throw httpErr(400, 'Prompt influence must be 0-1');
  loop = !!loop;
  if (inflight.has(id)) throw httpErr(429, 'A generation for this sound is already running');
  if (inflight.size >= MAX_INFLIGHT) throw httpErr(429, `${MAX_INFLIGHT} generations are already running; wait for one to finish`);
  const wait = COOLDOWN_MS - (Date.now() - (lastDone.get(id) ?? 0));
  if (wait > 0) throw httpErr(429, `Wait ${Math.ceil(wait / 1000)}s before generating this sound again`);
  const key = FAKE ? '' : falKey();
  if (!FAKE && !key) throw httpErr(500, 'No fal key: set FAL_KEY in game-v2/.env (or the environment) and restart the tool');
  inflight.set(id, { started: Date.now() });
  try {
    const settings = { duration_seconds: duration, prompt_influence: influence, loop, output_format: 'mp3_44100_128' };
    let buf;
    if (FAKE) {
      await new Promise((r) => setTimeout(r, 1200));
      if (prompt.includes('FAKE_FAIL')) throw new Error('fake fal failure (the prompt contained FAKE_FAIL)');
      if (!s.files[0]) throw new Error('no current file to copy for the fake client');
      buf = fs.readFileSync(path.join(sfxDir, s.files[0]));
    } else buf = await callFal(key, { text: prompt, ...settings });
    const dir = path.join(reviewDir, id);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
    const file = `${stamp}.mp3`;
    fs.writeFileSync(path.join(dir, file), buf);
    const meta = { prompt, settings, endpoint: ENDPOINT, time: new Date().toISOString(), fake: FAKE || undefined };
    fs.writeFileSync(path.join(dir, `${stamp}.json`), JSON.stringify(meta, null, 2) + '\n');
    return { file, ...meta, status: 'new', chosen: false };
  } catch (e) { throw e.status ? e : httpErr(502, `Generation failed: ${e.message}`); }
  finally { inflight.delete(id); lastDone.set(id, Date.now()); }
}

// ---- http
const TYPES = { '.html': 'text/html; charset=utf-8', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.png': 'image/png', '.json': 'application/json' };
const sendJson = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
function sendFile(res, file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}
const safe = (s) => /^[\w.\-]+$/.test(s) && !s.includes('..');
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > 100_000) { reject(httpErr(413, 'Too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { reject(httpErr(400, 'Bad JSON')); } });
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let m;
    if (p === '/') return sendFile(res, path.join(here, 'index.html'));
    if (p === '/api/state') {
      SOUNDS = buildSounds();
      const man = loadManifest();
      return sendJson(res, 200, {
        fake: FAKE, hasKey: FAKE || !!falKey(), endpoint: ENDPOINT, busy: [...inflight.keys()],
        sounds: SOUNDS.map((s) => ({ ...s, review: { note: man.sounds[s.id]?.note ?? '', draft: man.sounds[s.id]?.draft ?? null, chosen: man.sounds[s.id]?.chosen ?? null }, candidates: candidatesOf(s.id, man) })),
      });
    }
    if ((m = p.match(/^\/part\/([\w.\-]+)$/)) && safe(m[1])) return sendFile(res, path.join(partsDir, m[1]));
    if ((m = p.match(/^\/sfx\/([\w.\-]+)$/)) && safe(m[1])) return sendFile(res, path.join(sfxDir, m[1]));
    if ((m = p.match(/^\/cand\/([\w\-]+)\/([\w.\-]+)$/)) && safe(m[1]) && safe(m[2])) return sendFile(res, path.join(reviewDir, m[1], m[2]));
    if (req.method === 'POST' && (m = p.match(/^\/api\/(note|generate|candidate)\/([\w\-]+)$/))) {
      const id = m[2];
      if (!SOUNDS.some((s) => s.id === id)) throw httpErr(404, 'Unknown sound');
      const body = await readBody(req);
      if (m[1] === 'generate') return sendJson(res, 200, await generate(id, body));
      const man = loadManifest();
      const e = entry(man, id);
      if (m[1] === 'note') {
        if (typeof body.note === 'string') e.note = body.note.slice(0, 5000);
        if (body.draft && typeof body.draft === 'object') e.draft = { prompt: String(body.draft.prompt ?? '').slice(0, 1500), duration: Number(body.draft.duration), influence: Number(body.draft.influence), loop: !!body.draft.loop };
      } else {
        const f = String(body.file ?? '');
        if (!safe(f) || !fs.existsSync(path.join(reviewDir, id, f))) throw httpErr(404, 'Unknown candidate');
        const c = (e.candidates[f] ??= {});
        if (body.action === 'confirm') {
          // One chosen per sound; confirming the chosen one again clears it
          if (e.chosen === f) { delete e.chosen; c.status = 'new'; }
          else { if (e.chosen && e.candidates[e.chosen]) e.candidates[e.chosen].status = 'new'; e.chosen = f; c.status = 'chosen'; c.at = new Date().toISOString(); }
        } else if (body.action === 'discard') {
          if (e.chosen === f) delete e.chosen;
          c.status = 'discarded'; c.at = new Date().toISOString();
        } else if (body.action === 'restore') c.status = 'new';
        else throw httpErr(400, 'Unknown action');
      }
      saveManifest(man);
      return sendJson(res, 200, { ok: true });
    }
    res.writeHead(404); res.end('Not found');
  } catch (e) {
    sendJson(res, e.status ?? 500, { error: e.status ? e.message : `Server error: ${e.message}` });
  }
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Sound review: http://localhost:${port}${FAKE ? '  (FAKE fal: no real calls)' : ''}`);
  console.log(FAKE ? 'fal key not used' : falKey() ? 'fal key found (not shown)' : 'No fal key found: playing and notes work, Generate will not (set FAL_KEY in game-v2/.env)');
});
