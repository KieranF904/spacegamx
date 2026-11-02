// Shipgen page: the form (make ships in a batch, one ship, evolve, compare), the run stream (server-sent events), the
// progress strip, panes, metrics, the saved ships with ratings, the session gallery, and watching command-line runs.
import { CATEGORY_NAMES, COLOURS } from './grid.js';
import { StepLog } from './log.js';
import { Pane } from './pane.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({ error: r.statusText }));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(`shipgen.${k}`) ?? 'null'); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(`shipgen.${k}`, JSON.stringify(v)); } catch { /* (no storage) */ } },
};
const STEP_NAMES = ['power', 'weapons', 'engines', 'fittings', 'armour', 'shape'];

const state = {
  legend: new Map(), roles: [], models: [], library: [], run: null, runMode: null, es: null, mode: 'design',
  panes: new Map(), checks: new Map(), selected: null, start: null, watching: null,
  /** Where the attached run is (the progress strip) */
  progress: null,
};
const log = new StepLog($('log'), () => $('follow').checked);

// ---------------------------------------------------------------------------------------------------------- form
function msg(id, text, cls = '') { const el = $(id); el.textContent = text; el.className = `msg ${cls}`; }

const formMode = () => document.body.className.replace(/^m-/, '');

function setMode(mode) {
  document.body.className = `m-${mode}`;
  for (const b of $('tabs').querySelectorAll('button')) b.classList.toggle('on', b.dataset.mode === mode);
  $('modelLabel').textContent = mode === 'compare' ? 'First model' : 'Model';
  $('go').textContent = mode === 'batch' ? 'Start making ships' : mode === 'design' ? 'Design one ship' : mode === 'evolve' ? 'Start evolving' : 'Compare the models';
  // (The build's "auto" is a batch choice: by role)
  const auto = $('build').querySelector('option[value=auto]');
  auto.hidden = mode !== 'batch';
  if (mode !== 'batch' && $('build').value === 'auto') $('build').value = 'oneshot';
  if (mode === 'batch' && !store.get('build')) $('build').value = 'auto';
  contractHint();
  store.set('mode', mode);
}
for (const b of $('tabs').querySelectorAll('button')) b.onclick = () => setMode(b.dataset.mode);

function modelLabel(m) {
  return `${m.name}${m.params ? `  ${m.params}` : ''}${m.vision ? ' · vision' : ''}${m.cloud ? ' · CLOUD (paid)' : ''}${m.off ? ` · ${m.off}` : ''}`;
}

function fillModels(select, list, { none, pick } = {}) {
  const groups = [
    ['Local: Ollama', list.filter((m) => !m.cloud && m.provider === 'ollama')],
    ['Local: LM Studio', list.filter((m) => !m.cloud && m.provider === 'lmstudio')],
    ['Cloud (runs on an outside service, costs money)', list.filter((m) => m.cloud)],
  ];
  // (No model picked: a placeholder shows, never the first enabled option, which could be a paid cloud one)
  select.innerHTML = (none ? `<option value="">${esc(none)}</option>` : '<option value="" disabled>(pick a model)</option>') + groups.filter(([, ms]) => ms.length)
    .map(([g, ms]) => `<optgroup label="${esc(g)}">${ms.map((m) => `<option value="${esc(m.id)}"${m.off ? ' disabled' : ''}>${esc(modelLabel(m))}</option>`).join('')}</optgroup>`).join('');
  select.value = pick && list.some((m) => m.id === pick && !m.off) ? pick : '';
}

async function loadModels() {
  const { models, lmstudio, lmstudioChat, contracts } = await api('/api/models?fresh');
  state.models = models;
  $('lmsChat').checked = !!lmstudioChat;
  if (contracts && $('contract').options.length < 2) {
    $('contract').innerHTML = '<option value="auto">auto (measured per model)</option>' + contracts.map((c) => `<option value="${esc(c.id)}">${esc(c.id)}: ${esc(c.label)}</option>`).join('');
    const p = store.get('form') ?? {};
    if (p.contract) $('contract').value = p.contract;
  }
  const chat = models.filter((m) => m.chat);
  const local = chat.filter((m) => !m.cloud && !m.off);
  const prefs = store.get('form') ?? {};
  // (Never a cloud model by default: only one the user picked before)
  fillModels($('model'), chat, { pick: prefs.model ?? local[0]?.id });
  if (!prefs.model && local[0]) $('model').value = local[0].id;
  fillModels($('model2'), chat, { pick: prefs.model2 ?? local[1]?.id ?? local[0]?.id });
  fillModels($('critic'), chat.filter((m) => m.vision), { none: '(no critic)', pick: prefs.critic ?? '' });
  contractHint();
  const notes = [];
  if (!local.length) notes.push('No local model is ready: start Ollama, or load a model in LM Studio and tick "let LM Studio chat" under Advanced.');
  else if (!lmstudio) notes.push('LM Studio lists nothing (not running, or no LM_API_TOKEN).');
  if (models.some((m) => m.provider === 'lmstudio' && m.off)) notes.push('LM Studio models are listed only until "let LM Studio chat" is ticked (Advanced).');
  $('modelNote').textContent = notes.join(' ');
}

/** What "auto" picks for the chosen designer, and why (the measured table in loop/modelPrefs.ts) */
function contractHint() {
  const m = state.models.find((x) => x.id === $('model').value);
  const a = m?.auto;
  $('contractHint').textContent = a ? `auto = ${$('build').value === 'staged' ? 'parts (steps)' : $('build').value === 'auto' ? 'by build' : a.contract}` : '';
  $('contractHint').title = a ? a.why : '';
}

async function loadStatic() {
  const [{ roles }, { legend }, { ships }] = await Promise.all([api('/api/roles'), api('/api/legend'), api('/api/library')]);
  state.roles = roles;
  for (const r of legend) state.legend.set(r.code, r);
  state.library = ships;
  $('role').innerHTML = `<option value="">(no role: the description only)</option>` + roles.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('');
  const picked = store.get('roles') ?? roles.map((r) => r.id);
  $('roleChecks').innerHTML = roles.map((r) => `<label title="${esc(`${r.summary}. ${r.size.cells[0]}-${r.size.cells[1]} cells`)}"><input type="checkbox" name="roles" value="${esc(r.id)}"${picked.includes(r.id) ? ' checked' : ''}> ${esc(r.name)}</label>`).join('');
  const groups = {};
  for (const s of ships) (groups[s.group] ??= []).push(s);
  $('start').innerHTML = '<option value="">(blank: a new design)</option><option value="sel" disabled>(the selected design)</option>' +
    Object.entries(groups).map(([g, ss]) => `<optgroup label="${esc(g)}">${ss.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</optgroup>`).join('');
  $('key').innerHTML = Object.entries(COLOURS).map(([k, c]) => `<span><i style="background:${c}"></i>${esc(CATEGORY_NAMES[k])}</span>`).join('') +
    '<span><i style="background:transparent;outline:2px dashed #ffd866"></i>changed this round</span><span><i style="background:#ef5050"></i>unpowered</span>' +
    '<span><i style="background:transparent;border:2px solid #f0b64e;border-radius:50%"></i>bottleneck relay</span><span><b style="color:#5fd39a">77%</b>&nbsp;gun sustained</span>';
}

function roleChanged() {
  const r = state.roles.find((x) => x.id === $('role').value);
  $('roleSummary').textContent = r ? `${r.summary}. Size ${r.size.cells[0]}-${r.size.cells[1]} cells, level ${r.band.maxLevel} parts.` : 'No role: the model gets only the rules, the legend and your description.';
  $('maxLevel').placeholder = r ? String(r.band.maxLevel) : '99';
  $('cellsMin').placeholder = r ? String(r.size.cells[0]) : 'min';
  $('cellsMax').placeholder = r ? String(r.size.cells[1]) : 'max';
}

function formBody() {
  const mode = formMode();
  const f = new FormData($('form'));
  const v = (k) => { const x = f.get(k); return x === null || x === '' ? undefined : x; };
  const n = (k) => (v(k) === undefined ? undefined : Number(v(k)));
  const body = {
    mode, model: v('model'), temperature: n('temperature'), rounds: n('rounds'), note: v('note'), think: f.get('think') === 'on',
    build: v('build'), contract: v('contract'), mirror: f.get('mirror') === 'on', concept: f.get('concept') === 'on',
  };
  if (mode === 'batch') {
    body.roles = f.getAll('roles');
    body.maxShips = n('maxShips'); body.shipMinutes = n('shipMinutes'); body.generations = Number($('generationsBatch').value) || 0;
    store.set('roles', body.roles);
  } else {
    body.role = v('role'); body.critic = v('critic'); body.maxLevel = n('maxLevel'); body.trials = n('trials'); body.population = n('population');
    body.generations = Number($('generationsEvolve').value) || undefined;
    if (body.build === 'auto') body.build = 'oneshot';
    if (mode === 'compare') body.models = [v('model'), v('model2')];
    if (n('cellsMin') || n('cellsMax')) {
      const r = state.roles.find((x) => x.id === body.role);
      body.cells = [n('cellsMin') ?? r?.size.cells[0] ?? 10, n('cellsMax') ?? r?.size.cells[1] ?? 200];
    }
    const start = v('start');
    if (start === 'sel' && state.start) body.startBp = state.start.bp;
    else if (start && start !== 'sel') body.startId = start;
  }
  store.set('form', { model: body.model, model2: v('model2'), critic: v('critic') ?? '', role: v('role'), temperature: body.temperature, rounds: body.rounds, build: v('build'), contract: body.contract, mirror: body.mirror, concept: body.concept, think: body.think, shipMinutes: n('shipMinutes'), maxShips: n('maxShips'), generationsBatch: $('generationsBatch').value });
  return body;
}

// ---------------------------------------------------------------------------------------------------------- panes
function setupPanes(mode, models, title) {
  $('panes').innerHTML = '';
  state.panes.clear();
  const keys = mode === 'compare' ? models : ['main'];
  $('panes').classList.toggle('cols2', keys.length > 1);
  for (const k of keys) state.panes.set(k, new Pane($('panes'), k === 'main' ? title : k, state.legend));
}
const paneFor = (e) => {
  if (state.mode === 'compare' && e.lane) {
    const k = e.lane.replace(/ t\d+$/, '');
    return state.panes.get(k) ?? state.panes.get([...state.panes.keys()].find((x) => k.startsWith(x)));
  }
  return state.panes.get('main') ?? [...state.panes.values()][0];
};
function mainPane() {
  if (!state.panes.size) setupPanes('design', [], 'preview');
  return state.selected?.pane ?? [...state.panes.values()][0];
}

// ---------------------------------------------------------------------------------------------------------- selected design
function select(d) {
  state.selected = d;
  $('selName').textContent = d ? d.name : 'none yet';
  $('selScore').textContent = d ? `${d.valid ? 'valid' : 'not valid'}${d.score !== undefined ? `, score ${d.score}` : ''}${d.saved ? `, saved as ${d.saved}` : ''}` : '';
  for (const id of ['actSave', 'actLab', 'actStart', 'actLapse']) $(id).disabled = !d;
  $('actSave').disabled = !d?.valid || !!d?.saved?.startsWith('dev/gen-');
  $('actLab').disabled = !d?.valid && !d?.saved;
  if (d?.result) metrics(d.result);
}

function bar(pct) {
  const c = pct >= 95 ? 'var(--good)' : pct >= 50 ? 'var(--warn)' : 'var(--bad)';
  return `<span class="bar"><i style="width:${Math.max(0, Math.min(100, pct))}%;background:${c}"></i></span>${Math.round(pct)}%`;
}

const SCORE_WORDS = {
  power: 'power: guns and engines fed', fit: 'fit: what the role is for', lean: 'lean: not mostly power plant', symmetry: 'symmetry', armourOutside: 'shell outside',
  enginesAft: 'engines aft', gunsOut: 'guns out', compactness: 'compact rows', silhouette: 'shaped outline',
};

function metrics(r, extra = '') {
  const s = r.stats, p = r.power;
  const kv = [
    ['score', r.score], ['valid', r.valid ? 'yes' : `no (${r.errors.length} errors)`], ['parts', s.parts], ['size', `${s.width} x ${s.height} (${s.cells} cells)`],
    ['mass', s.mass], ['cost', s.cost ?? 'n/a'], ['thrust / mass', s.thrustToMass], ['makes', `${s.generation} E/s`],
    ...(p ? [['stores', `${p.storage} E`], ['cruise', `${p.thrust.cruisePct}%`], ['boost', `${p.thrust.boostPct}%`], ['unpowered', p.unpowered.length], ['bottlenecks', p.bottlenecks.length]] : []),
  ];
  const sc = Object.entries(r.scores).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => `<div><span>${esc(SCORE_WORDS[k] ?? k)}</span> ${bar(Number(v) * 100)}</div>`).join('');
  const fit = (r.fit ?? []).length ? `<div class="muted small">${r.fit.map((f) => `${esc(f.words)}: ${f.value} of ${f.target}`).join(' · ')}</div>` : '';
  const guns = p?.weapons.length ? `<table><tr><th>weapon</th><th>at</th><th>10 s</th><th>sustained</th></tr>${p.weapons.map((w) => `<tr><td>${esc(w.name)} (${esc(w.code)})</td><td>${w.row}, ${w.col}</td><td>${bar(w.pct)}</td><td>${bar(w.pctLong)}</td></tr>`).join('')}</table>` : '';
  $('metrics').innerHTML = `<h2>Design metrics</h2><div class="kv">${kv.map(([k, v]) => `<div><span>${esc(k)}</span> ${esc(v)}</div>`).join('')}</div><div class="kv">${sc}</div>${fit}${guns}${extra}`;
}

function compareTable(m) {
  return `<h2>Compare</h2><table><tr><th>model</th><th>trials</th><th>valid</th><th>pass rate</th><th>rounds / valid</th><th>valid / min</th><th>mean score</th><th>tok/s</th><th>time</th></tr>` +
    m.models.map((x) => `<tr><td>${esc(x.model)}</td><td>${x.trials}</td><td>${x.passes}</td><td>${Math.round(x.passRate * 100)}%</td><td>${x.roundsPerValid ?? '-'}</td><td>${x.validPerMinute}</td><td>${x.meanScore}</td><td>${x.tokensPerSec ?? '-'}</td><td>${(x.ms / 1000).toFixed(0)} s</td></tr>`).join('') + '</table>';
}

// ---------------------------------------------------------------------------------------------------------- progress
const clock = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

function progressReset(title) {
  state.progress = { title, where: '', since: Date.now(), steps: new Map(), tally: '', round: 0 };
  $('progress').hidden = false;
  progressDraw();
}
function progressDraw() {
  const p = state.progress;
  if (!p) { $('progress').hidden = true; return; }
  $('progressTitle').textContent = p.title;
  $('progressWhere').textContent = [p.where, p.round ? `try ${p.round}` : ''].filter(Boolean).join(' · ');
  $('progressClock').textContent = clock(Date.now() - p.since);
  $('progressBar').innerHTML = p.steps.size ? [...p.steps.entries()].map(([name, st]) => `<span class="${st}" data-name="${esc(name)}"></span>`).join('') : '';
  $('progressTally').textContent = p.tally;
}
setInterval(() => { if (state.progress && $('status').textContent === 'running') $('progressClock').textContent = clock(Date.now() - state.progress.since); }, 1000);

function onBatch(e) {
  const p = state.progress ?? (progressReset('Making ships'), state.progress);
  const per = Object.entries(e.perRole).map(([r, v]) => `${r} ${v.saved}/${v.attempts}`).join(' · ');
  p.tally = `${e.saved} saved of ${e.attempts} attempts${per ? ` · ${per}` : ''}`;
  switch (e.phase) {
    case 'design': p.title = `Ship #${e.attempt}: ${e.role}`; p.where = 'writing the concept'; p.since = Date.now(); p.steps = new Map(); p.round = 0; break;
    case 'refine': p.where = 'refining the design (evolve)'; p.steps = new Map(); p.round = 0; break;
    case 'saved': p.where = `saved "${e.ship?.name}" (score ${e.ship?.score}) in ${e.minutes} min`; refreshShips(); break;
    case 'rejected': p.where = `rejected after ${e.minutes} min: ${(e.why ?? []).join('; ')}`; break;
    case 'error': p.where = `error: ${e.message}`; break;
    case 'waiting': p.where = `waiting ${e.waitS} s (${e.message})`; break;
    case 'stopped': p.title = 'Batch finished'; p.where = `stopped: ${e.reason}`; break;
  }
  progressDraw();
}

// ---------------------------------------------------------------------------------------------------------- the stream
function setStatus(s, info) {
  $('status').textContent = s; $('status').className = `pill ${s}`;
  if (info !== undefined) $('runInfo').textContent = info;
  const running = s === 'running';
  $('stop').disabled = !running || !!state.watching; $('go').disabled = running && !state.watching;
}

function onEvent(e) {
  if (e.type === 'batch') { onBatch(e); log.event(e); return; }
  const pane = e.type === 'start' ? null : paneFor(e);
  const p = state.progress;
  switch (e.type) {
    case 'start':
      if (state.watching && e.role && state.roles.some((r) => r.id === e.role)) { $('role').value = e.role; roleChanged(); }
      state.mode = e.mode; state.checks.clear(); $('conceptNote').textContent = '';
      setupPanes(e.mode, e.models ?? [e.model], e.lane ?? e.role ?? e.model);
      if (state.runMode !== 'batch') progressReset(`${e.mode === 'design' ? 'Designing' : e.mode === 'evolve' ? 'Evolving' : 'Comparing'}${e.role ? `: ${e.role}` : ''}`);
      else if (p) { p.where = e.mode === 'evolve' ? 'refining the design (evolve)' : `designing${e.build === 'staged' ? ' in steps' : ''}`; p.steps = new Map(); p.round = 0; }
      if (e.build === 'staged' && p) { for (const s of STEP_NAMES) p.steps.set(s, ''); }
      setStatus('running', `${state.runMode === 'batch' ? 'batch · ' : ''}${e.mode}${e.build === 'staged' ? ' (steps)' : ''} · ${e.models?.join(' vs ') ?? e.model} · ${e.role ?? 'no role'} · ${e.contract}${e.mirror === false ? ' · mirror off' : ''}${e.critic ? ` · critic ${e.critic}` : ''}`);
      progressDraw();
      break;
    case 'concept': $('conceptNote').textContent = e.line; if (p) { p.where = 'designing from the concept'; progressDraw(); } break;
    case 'step':
      if (p) {
        if (e.status === 'start') { for (const [k, v] of p.steps) if (v === 'on') p.steps.set(k, 'done'); p.steps.set(e.step, 'on'); p.where = `step ${e.index}/${e.of}: ${e.step}`; }
        else p.steps.set(e.step, e.status === 'accepted' ? 'done' : e.status);
        progressDraw();
      }
      break;
    case 'prompt': pane?.newRound(e.round, state.mode === 'design' ? '' : e.lane); $('live').textContent = ''; if (p) { p.round = e.round; progressDraw(); } break;
    case 'token':
      if (e.kind === 'content') pane?.token(e.text);
      return;
    case 'progress': {
      const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
      const what = e.content ? `writing: ${k(e.content)} chars${e.thinking ? ` after ${k(e.thinking)} of thinking` : ''}` : `thinking: ${k(e.thinking)} chars`;
      $('live').textContent = `${what}${e.tokensPerSec ? ` · ~${e.tokensPerSec} tok/s` : ''}`;
      if (!e.content) pane?.foot(`the model is thinking (${k(e.thinking)} chars so far)`);
      return;
    }
    case 'grid': if (!e.partial) pane?.gridFinal(e.text); else { if (e.text) pane?.preview(e.text); return; } break;
    case 'reply': $('live').textContent = e.tokensPerSec ? `${e.tokensPerSec} tok/s` : ''; pane?.foot(`reply in ${(e.ms / 1000).toFixed(1)} s${e.outputTokens ? `, ${e.outputTokens} tokens` : ''}`); break;
    case 'check':
      pane?.check(e.result, e.cells);
      state.checks.set(`${e.lane ?? ''}|${e.round}`, { result: e.result, cells: e.cells });
      pane?.foot(`${e.valid ? 'valid' : `not valid: ${e.result.errors[0]?.message ?? ''}`}`);
      if (state.mode !== 'compare') metrics(e.result);
      break;
    case 'render': pane?.still(e.url); break;
    case 'score': pane?.score(`score ${e.score}`); break;
    case 'best': {
      const c = state.checks.get(`${e.lane ?? ''}|${e.round}`);
      if (!state.selected?.live || e.valid || !state.selected.valid) {
        select({ live: true, bp: e.bp, name: e.name, score: e.score, valid: e.valid, url: e.url, role: $('role').value, result: c?.result, cells: c?.cells, pane });
      }
      refreshGallery();
      break;
    }
    case 'done':
      if (e.metrics.kind === 'compare') { $('metrics').innerHTML = compareTable(e.metrics); }
      $('live').textContent = '';
      if (p && state.runMode !== 'batch') { for (const [k, v] of p.steps) if (v === 'on') p.steps.set(k, 'done'); p.where = e.cancelled ? 'stopped' : 'done'; progressDraw(); }
      refreshGallery();
      break;
  }
  log.event(e);
}

function attach(id, mode) {
  state.es?.close();
  state.watching = null;
  state.run = id; state.runMode = mode ?? null;
  state.progress = null; progressDraw();
  const es = new EventSource(`/api/runs/${id}/events`);
  state.es = es;
  es.onmessage = (m) => onEvent(JSON.parse(m.data));
  es.addEventListener('end', async () => {
    es.close();
    const { runs } = await api('/api/runs');
    const r = runs.find((x) => x.id === id);
    setStatus(r?.status ?? 'done');
    refreshShips();
  });
}

// ---------------------------------------------------------------------------------------------------------- watch
/** Follows a run started elsewhere (the CLI): the same view, read-only (no Stop) */
function watch(id) {
  state.es?.close();
  state.run = null; state.runMode = null;
  state.watching = id;
  log.clear();
  state.selected = null;
  state.progress = null; progressDraw();
  watchEnded = false;
  const es = new EventSource(`/api/watch/events?run=${encodeURIComponent(id)}`);
  state.es = es;
  es.onmessage = (m) => { if (state.es === es) onEvent(JSON.parse(m.data)); };
  es.addEventListener('end', () => {
    es.close();
    if (state.watching !== id) return;
    setStatus('done'); watchEnded = true;
    refreshShips();
    follow();
  });
  es.onerror = () => { if (es.readyState === EventSource.CLOSED && state.watching === id) { setStatus('idle'); watchEnded = true; } };
  setStatus('running', `live: ${short(id)}`);
  renderWatch();
}
const short = (id) => id.replace(/^runs\//, '');

// (Always live: whatever run did something last, from this page or the command line. A page run is attached, so its
// tokens stream; a command-line run is read from its record as it grows. When the one shown ends, the next one that
// starts takes its place (a batch's next attempt, its refinement). A run picked by hand stays until it ends.)
let watchEnded = false, pinned = null;
const isPageRecord = (id) => /-page(\/|$)/.test(id);
async function follow() {
  let pageRuns;
  try { pageRuns = (await api('/api/runs')).runs; } catch { return; }
  const pageLive = pageRuns.find((r) => r.status === 'running');
  if (pageLive) { if (state.run !== pageLive.id) attach(pageLive.id, pageLive.mode); return; }
  if (state.run && $('status').textContent === 'running') return;
  try { watchRuns = (await api('/api/watch')).runs; } catch { return; }
  if ($('watchBox').open) renderWatch();
  const cli = watchRuns.filter((r) => !isPageRecord(r.id));
  const cur = state.watching ? cli.find((r) => r.id === state.watching) : undefined;
  const curLive = !!cur && !cur.finished && !cur.stale && !watchEnded;
  if (pinned && pinned === state.watching && curLive) return;
  pinned = null;
  // (Newest activity first; a second run going at once takes over only once it is a minute ahead, so the view doesn't flicker)
  const newest = cli.find((r) => !r.finished && !r.stale);
  if (newest && newest.id !== state.watching && (!curLive || newest.modified - cur.modified > 60000)) watch(newest.id);
  else if (!state.watching && !state.run && cli[0]) watch(cli[0].id);
}
setInterval(follow, 3000);

let watchRuns = [];
function renderWatch() {
  const el = $('watchList');
  $('watchCount').textContent = watchRuns.length ? `(${watchRuns.length})` : '';
  if (!watchRuns.length) { el.innerHTML = '<p class="muted small">No runs in out/ yet.</p>'; return; }
  el.innerHTML = '';
  for (const r of watchRuns.slice(0, 60)) {
    const row = document.createElement('div');
    row.className = `watchRow${state.watching === r.id ? ' on' : ''}`;
    const when = new Date(r.modified).toLocaleString();
    row.innerHTML = `<span class="pill ${r.finished ? 'done' : r.stale ? '' : 'running'}">${r.finished ? 'done' : r.stale ? 'stopped?' : 'live?'}</span> <b>${esc(short(r.id))}</b> <span class="muted small">${esc([r.mode, r.model, r.role].filter(Boolean).join(' · '))} · ${esc(when)}</span>`;
    // (A run picked by hand stays on screen until it ends; then the view goes back to the newest)
    row.onclick = () => { pinned = r.id; watch(r.id); };
    el.appendChild(row);
  }
}
async function refreshWatch() {
  try { watchRuns = (await api('/api/watch')).runs; renderWatch(); } catch { /* (server gone) */ }
}
setInterval(() => { if ($('watchBox').open) refreshWatch(); }, 4000);
$('watchBox').addEventListener('toggle', () => { if ($('watchBox').open) refreshWatch(); });

// ---------------------------------------------------------------------------------------------------------- session gallery
async function refreshGallery() {
  const { gallery } = await api('/api/gallery');
  const el = $('gallery');
  if (!gallery.length) { el.innerHTML = '<p class="muted small">Nothing yet.</p>'; return; }
  el.innerHTML = '';
  for (const g of gallery) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `${g.url ? `<img src="${esc(g.url)}" alt="" loading="lazy">` : '<div class="noimg">no still</div>'}<b>${esc(g.name)}</b><span class="${g.valid ? '' : 'muted'}">${g.score}${g.valid ? '' : ' (invalid)'}</span> <span class="muted">${esc(g.model.replace(/^\w+\//, ''))}${g.lane ? ` · ${esc(g.lane.replace(/^.* (t\d+)$/, '$1'))}` : ''}</span>`;
    card.onclick = () => openDesign(g.bp, { name: g.name, url: g.url, role: g.role, score: g.score });
    el.appendChild(card);
  }
}

// ---------------------------------------------------------------------------------------------------------- saved ships
let savedShips = [];
function stars(s) {
  const el = document.createElement('div');
  el.className = 'stars';
  el.title = 'rate it (click a star again to clear)';
  for (let i = 1; i <= 5; i++) {
    const st = document.createElement('i');
    st.textContent = '★'; st.className = i <= (s.rating ?? 0) ? 'on' : '';
    st.onclick = async (ev) => {
      ev.stopPropagation();
      const rating = s.rating === i ? 0 : i;
      try { await api('/api/ships/rate', { dir: s.dir, rating }); s.rating = rating || undefined; drawShips(); } catch (e) { msg('actMsg', e.message, 'err'); }
    };
    el.appendChild(st);
  }
  return el;
}
function drawShips() {
  const sel = $('shipsRole'), role = sel.value;
  const roles = [...new Set(savedShips.map((s) => s.role))].sort();
  sel.innerHTML = `<option value="">all roles</option>${roles.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join('')}`;
  sel.value = roles.includes(role) ? role : '';
  const sort = $('shipsSort').value;
  const list = savedShips.filter((s) => !sel.value || s.role === sel.value).sort((a, b) =>
    sort === 'score' ? b.score - a.score : sort === 'rating' ? (b.rating ?? 0) - (a.rating ?? 0) || b.score - a.score : b.savedAt.localeCompare(a.savedAt));
  $('shipsCount').textContent = `(${list.length})`;
  const el = $('ships');
  if (!list.length) { el.innerHTML = '<p class="muted small">No saved ships yet. Start a batch and the ones that pass appear here.</p>'; return; }
  el.innerHTML = '';
  for (const s of list) {
    const card = document.createElement('div');
    card.className = 'card';
    card.title = `${s.dir}${s.concept ? `\n${s.concept}` : ''}`;
    card.innerHTML = `${s.png ? `<img src="${esc(s.png)}" alt="" loading="lazy">` : '<div class="noimg">no render</div>'}<b>${esc(s.name)}</b><span>score ${s.score}</span> <span class="muted">${esc(s.role)}</span><div class="muted">${esc((s.model ?? '').replace(/^\w+\//, ''))} · ${esc(s.savedAt.slice(0, 16).replace('T', ' '))}</div>`;
    card.appendChild(stars(s));
    card.onclick = async () => {
      try { await openDesign(await (await fetch(s.bp)).json(), { name: s.name, url: s.png, role: s.role, score: s.score }); } catch (e) { msg('actMsg', e.message, 'err'); }
    };
    el.appendChild(card);
  }
}
async function refreshShips() {
  try { savedShips = (await api('/api/ships')).ships; } catch { return; }
  drawShips();
}
$('shipsRole').onchange = drawShips;
$('shipsSort').onchange = drawShips;
setInterval(() => { if ($('shipsBox').open) refreshShips(); }, 30000);

/** Shows a design (library or gallery) in the main pane, with its check, and selects it */
async function openDesign(bp, { name, url, role, score, saved } = {}) {
  const v = await api('/api/check', { bp, role: role || $('role').value || undefined });
  if (state.run && $('status').textContent === 'running') { msg('actMsg', 'A run is going: its panes stay; the design is selected below.', ''); }
  else {
    if (state.panes.size !== 1) setupPanes('design', [], name);
    const p = [...state.panes.values()][0];
    p.show(v.grid, v.check, v.cells, url, name ?? bp.name);
    p.score(`score ${v.check.score}`);
    if (!url) api('/api/render', { bp }).then((r) => p.still(r.url)).catch(() => {});
  }
  select({ bp, name: name ?? bp.name, url, role, score: score ?? v.check.score, valid: v.check.valid, result: v.check, cells: v.cells, saved });
}

// ---------------------------------------------------------------------------------------------------------- actions
$('actSave').onclick = async () => {
  const d = state.selected;
  try {
    const r = await api('/api/save', { bp: d.bp, role: d.role || $('role').value || 'free' });
    d.saved = r.id; select(d);
    msg('actMsg', `Saved as ${r.id} (${r.file}). ${r.note}`, 'ok');
  } catch (e) { msg('actMsg', e.message, 'err'); }
};
$('actLab').onclick = async () => {
  const d = state.selected;
  msg('actMsg', 'Exporting ships to the Energy Lab...');
  try {
    const r = await api('/api/lab', { bp: d.bp, role: d.role || $('role').value || 'free', saved: d.saved });
    d.saved = r.saved.id; select(d);
    window.open(r.url, '_blank');
    msg('actMsg', `In the lab as "${r.saved.name}" (${r.saved.id}). ${r.log}`, 'ok');
  } catch (e) { msg('actMsg', e.message, 'err'); }
};
$('actStart').onclick = () => {
  state.start = { bp: state.selected.bp, name: state.selected.name };
  const o = $('start').querySelector('option[value=sel]');
  o.disabled = false; o.textContent = `(the selected design: ${state.start.name})`;
  $('start').value = 'sel';
  if (formMode() === 'batch') setMode('design');
  msg('actMsg', `The next run starts from "${state.start.name}".`, 'ok');
};
$('actLapse').onclick = async () => {
  const d = state.selected;
  msg('actMsg', 'Rendering the build-up...');
  $('actLapse').disabled = true;
  try {
    const r = await api('/api/timelapse', { bp: d.bp });
    (d.pane && [...state.panes.values()].includes(d.pane) ? d.pane : mainPane()).lapse(r.frames, r.dir);
    msg('actMsg', `${r.frames.length} frames in ${(r.ms / 1000).toFixed(1)} s, saved in ${r.dir}`, 'ok');
  } catch (e) { msg('actMsg', e.message, 'err'); }
  $('actLapse').disabled = false;
};
$('stop').onclick = () => {
  if (!state.run) return;
  $('stop').disabled = true;
  msg('formMsg', state.runMode === 'batch' ? 'Stopping after this step...' : 'Stopping...', '');
  api(`/api/runs/${state.run}/stop`, {}).catch((e) => msg('formMsg', e.message, 'err'));
};

$('form').onsubmit = async (ev) => {
  ev.preventDefault();
  msg('formMsg', '');
  try {
    const body = formBody();
    if (body.mode === 'compare' && body.models[0] === body.models[1]) throw new Error('pick two different models');
    if (body.mode === 'batch' && !body.roles.length) throw new Error('tick at least one role');
    if (!body.model) throw new Error('pick a model');
    log.clear();
    const { id } = await api('/api/runs', body);
    attach(id, body.mode);
  } catch (e) { msg('formMsg', e.message, 'err'); }
};
$('model').addEventListener('change', contractHint);
$('build').addEventListener('change', () => { contractHint(); store.set('build', $('build').value); });
$('lmsChat').onchange = async () => {
  try {
    await api('/api/settings', { lmstudioChat: $('lmsChat').checked });
    msg('formMsg', $('lmsChat').checked ? 'LM Studio may chat now: a run with an LM Studio model will LOAD it there.' : 'LM Studio models are listed only again.', '');
    await loadModels();
  } catch (e) { msg('formMsg', e.message, 'err'); }
};
$('role').onchange = roleChanged;
$('temperature').oninput = () => { $('tempOut').textContent = Number($('temperature').value).toFixed(2); };
$('start').onchange = async () => {
  const id = $('start').value;
  if (!id || id === 'sel') return;
  try {
    const v = await api(`/api/library/${encodeURIComponent(id)}?role=${encodeURIComponent($('role').value)}`);
    await openDesign(v.bp, { name: v.bp.name, saved: id });
  } catch (e) { msg('formMsg', e.message, 'err'); }
};

// ---------------------------------------------------------------------------------------------------------- boot
(async () => {
  try {
    await loadStatic();
    const prefs = store.get('form') ?? {};
    if (prefs.role !== undefined && state.roles.some((r) => r.id === prefs.role)) $('role').value = prefs.role; else $('role').value = 'starter';
    if (prefs.temperature !== undefined) $('temperature').value = prefs.temperature;
    if (prefs.rounds) $('rounds').value = prefs.rounds;
    if (prefs.mirror === false) $('mirror').checked = false;
    if (prefs.concept === false) $('concept').checked = false;
    if (prefs.think === false) $('think').checked = false;
    if (prefs.shipMinutes) $('shipMinutes').value = prefs.shipMinutes;
    if (prefs.maxShips) $('maxShips').value = prefs.maxShips;
    if (prefs.generationsBatch !== undefined) $('generationsBatch').value = prefs.generationsBatch;
    if (store.get('build')) $('build').value = store.get('build');
    $('temperature').oninput();
    setMode(store.get('mode') ?? 'batch');
    roleChanged();
    setupPanes('design', [], 'no run yet');
    await loadModels().catch((e) => msg('formMsg', `models: ${e.message}`, 'err'));
    refreshGallery();
    refreshWatch();
    refreshShips();
    follow();
  } catch (e) { msg('formMsg', e.message, 'err'); }
})();
