// Shipgen page: the form, the run stream (server-sent events), panes, metrics, gallery and the design actions.
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

const state = {
  legend: new Map(), roles: [], models: [], library: [], run: null, es: null, mode: 'design',
  panes: new Map(), checks: new Map(), selected: null, start: null, watching: null,
};
const log = new StepLog($('log'), () => $('follow').checked);

// ---------------------------------------------------------------------------------------------------------- form
function msg(id, text, cls = '') { const el = $(id); el.textContent = text; el.className = `msg ${cls}`; }

function modelLabel(m) {
  return `${m.name}${m.params ? `  ${m.params}` : ''}${m.vision ? ' · vision' : ''}${m.cloud ? ' · CLOUD' : ''}${m.off ? ` · ${m.off}` : ''}`;
}

function fillModels(select, list, { none, pick } = {}) {
  const groups = [
    ['Local: Ollama', list.filter((m) => !m.cloud && m.provider === 'ollama')],
    ['Local: LM Studio', list.filter((m) => !m.cloud && m.provider === 'lmstudio')],
    ['Cloud (runs on an outside service)', list.filter((m) => m.cloud)],
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
  if (!lmstudio) $('modelLabel').title = 'LM Studio lists nothing: not running, or no LM_API_TOKEN in the environment or game-v2/.env';
}

/** What "auto" picks for the chosen designer, and why (the measured table in loop/modelPrefs.ts) */
function contractHint() {
  const m = state.models.find((x) => x.id === $('model').value);
  const a = m?.auto;
  $('contractHint').textContent = a ? `auto = ${$('build').value === 'staged' ? 'parts (staged)' : a.contract}` : '';
  $('contractHint').title = a ? a.why : '';
}

async function loadStatic() {
  const [{ roles }, { legend }, { ships }] = await Promise.all([api('/api/roles'), api('/api/legend'), api('/api/library')]);
  state.roles = roles;
  for (const r of legend) state.legend.set(r.code, r);
  state.library = ships;
  $('role').innerHTML = `<option value="">(no role: the note only)</option>` + roles.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('');
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
  $('roleSummary').textContent = r ? `${r.summary}. Size ${r.size.cells[0]}-${r.size.cells[1]} cells, level ${r.band.maxLevel} parts.` : 'No role: the model gets only the rules, the legend and your note.';
  $('maxLevel').placeholder = r ? String(r.band.maxLevel) : '99';
  $('cellsMin').placeholder = r ? String(r.size.cells[0]) : 'min';
  $('cellsMax').placeholder = r ? String(r.size.cells[1]) : 'max';
}

function modeChanged() {
  state.mode = $('mode').value;
  document.body.className = `m-${state.mode}`;
  $('modelLabel').textContent = state.mode === 'compare' ? 'First designer' : 'Designer';
}

function formBody() {
  const f = new FormData($('form'));
  const v = (k) => { const x = f.get(k); return x === null || x === '' ? undefined : x; };
  const n = (k) => (v(k) === undefined ? undefined : Number(v(k)));
  const body = {
    mode: v('mode'), model: v('model'), critic: v('critic'), temperature: n('temperature'), rounds: n('rounds'), role: v('role'),
    maxLevel: n('maxLevel'), note: v('note'), think: f.get('think') === 'on', trials: n('trials'), population: n('population'), generations: n('generations'),
    build: v('build'), contract: v('contract'), mirror: f.get('mirror') === 'on',
  };
  if (body.mode === 'compare') body.models = [v('model'), v('model2')];
  if (n('cellsMin') || n('cellsMax')) {
    const r = state.roles.find((x) => x.id === body.role);
    body.cells = [n('cellsMin') ?? r?.size.cells[0] ?? 10, n('cellsMax') ?? r?.size.cells[1] ?? 200];
  }
  const start = v('start');
  if (start === 'sel' && state.start) body.startBp = state.start.bp;
  else if (start && start !== 'sel') body.startId = start;
  store.set('form', { model: body.model, model2: v('model2'), critic: body.critic ?? '', role: body.role, mode: body.mode, temperature: body.temperature, rounds: body.rounds, build: body.build, contract: body.contract, mirror: body.mirror });
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

function metrics(r, extra = '') {
  const s = r.stats, p = r.power;
  const kv = [
    ['score', r.score], ['valid', r.valid ? 'yes' : `no (${r.errors.length} errors)`], ['parts', s.parts], ['size', `${s.width} x ${s.height} (${s.cells} cells)`],
    ['mass', s.mass], ['cost', s.cost ?? 'n/a'], ['thrust / mass', s.thrustToMass], ['makes', `${s.generation} E/s`],
    ...(p ? [['stores', `${p.storage} E`], ['cruise', `${p.thrust.cruisePct}%`], ['boost', `${p.thrust.boostPct}%`], ['unpowered', p.unpowered.length], ['bottlenecks', p.bottlenecks.length]] : []),
    ...Object.entries(r.scores).map(([k, v]) => [k, v === null ? 'n/a' : Number(v).toFixed(2)]),
  ];
  const guns = p?.weapons.length ? `<table><tr><th>weapon</th><th>at</th><th>10 s</th><th>sustained</th></tr>${p.weapons.map((w) => `<tr><td>${esc(w.name)} (${esc(w.code)})</td><td>${w.row}, ${w.col}</td><td>${bar(w.pct)}</td><td>${bar(w.pctLong)}</td></tr>`).join('')}</table>` : '';
  $('metrics').innerHTML = `<h2>Design metrics</h2><div class="kv">${kv.map(([k, v]) => `<div><span>${esc(k)}</span> ${esc(v)}</div>`).join('')}</div>${guns}${extra}`;
}

function compareTable(m) {
  return `<h2>Compare</h2><table><tr><th>model</th><th>trials</th><th>valid</th><th>pass rate</th><th>rounds / valid</th><th>valid / min</th><th>mean score</th><th>tok/s</th><th>time</th></tr>` +
    m.models.map((x) => `<tr><td>${esc(x.model)}</td><td>${x.trials}</td><td>${x.passes}</td><td>${Math.round(x.passRate * 100)}%</td><td>${x.roundsPerValid ?? '-'}</td><td>${x.validPerMinute}</td><td>${x.meanScore}</td><td>${x.tokensPerSec ?? '-'}</td><td>${(x.ms / 1000).toFixed(0)} s</td></tr>`).join('') + '</table>';
}

// ---------------------------------------------------------------------------------------------------------- the stream
function setStatus(s, info) {
  $('status').textContent = s; $('status').className = `pill ${s}`;
  if (info !== undefined) $('runInfo').textContent = info;
  const running = s === 'running';
  $('stop').disabled = !running || !!state.watching; $('go').disabled = running && !state.watching;
}

function onEvent(e) {
  const pane = e.type === 'start' ? null : paneFor(e);
  switch (e.type) {
    case 'start':
      if (state.watching && e.role && state.roles.some((r) => r.id === e.role)) { $('role').value = e.role; roleChanged(); }
      state.mode = e.mode; state.checks.clear();
      setupPanes(e.mode, e.models ?? [e.model], e.model);
      setStatus('running', `${e.mode}${e.build === 'staged' ? ' (staged)' : ''} · ${e.models?.join(' vs ') ?? e.model} · ${e.role ?? 'no role'} · ${e.contract}${e.mirror === false ? ' · mirror off' : ' · mirrored'}${e.critic ? ` · critic ${e.critic}` : ''}`);
      break;
    case 'prompt': pane?.newRound(e.round, state.mode === 'design' ? '' : e.lane); $('live').textContent = ''; break;
    case 'token':
      if (e.kind === 'content') pane?.token(e.text);
      else $('live').textContent = 'thinking...';
      return;
    case 'grid': if (!e.partial) pane?.gridFinal(e.text); else { if (e.text) pane?.preview(e.text); return; } break;
    case 'reply': $('live').textContent = e.tokensPerSec ? `${e.tokensPerSec} tok/s` : ''; pane?.foot(`reply in ${(e.ms / 1000).toFixed(1)} s`); break;
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
      refreshGallery();
      break;
  }
  log.event(e);
}

function attach(id) {
  state.es?.close();
  state.watching = null;
  state.run = id;
  const es = new EventSource(`/api/runs/${id}/events`);
  state.es = es;
  es.onmessage = (m) => onEvent(JSON.parse(m.data));
  es.addEventListener('end', async () => {
    es.close();
    const { runs } = await api('/api/runs');
    const r = runs.find((x) => x.id === id);
    setStatus(r?.status ?? 'done');
  });
}

// ---------------------------------------------------------------------------------------------------------- watch
/** Follows a run started elsewhere (the CLI): the same view, read-only (no Stop) */
function watch(id) {
  state.es?.close();
  state.run = null;
  state.watching = id;
  log.clear();
  state.selected = null;
  const es = new EventSource(`/api/watch/events?run=${encodeURIComponent(id)}`);
  state.es = es;
  es.onmessage = (m) => { if (state.es === es) onEvent(JSON.parse(m.data)); };
  es.addEventListener('end', () => { es.close(); if (state.watching === id) setStatus('done'); });
  es.onerror = () => { if (es.readyState === EventSource.CLOSED && state.watching === id) setStatus('idle'); };
  setStatus('running', `watching ${id}`);
  renderWatch();
}

let watchRuns = [];
function renderWatch() {
  const el = $('watchList');
  $('watchCount').textContent = watchRuns.length ? `(${watchRuns.length})` : '';
  if (!watchRuns.length) { el.innerHTML = '<p class="muted small">No runs in out/ yet.</p>'; return; }
  el.innerHTML = '';
  for (const r of watchRuns) {
    const row = document.createElement('div');
    row.className = `watchRow${state.watching === r.id ? ' on' : ''}`;
    const when = new Date(r.modified).toLocaleString();
    row.innerHTML = `<span class="pill ${r.finished ? 'done' : r.stale ? '' : 'running'}">${r.finished ? 'done' : r.stale ? 'stopped?' : 'live?'}</span> <b>${esc(r.id)}</b> <span class="muted small">${esc([r.mode, r.model, r.role].filter(Boolean).join(' · '))} · ${esc(when)}</span>`;
    row.onclick = () => watch(r.id);
    el.appendChild(row);
  }
}
async function refreshWatch() {
  try { watchRuns = (await api('/api/watch')).runs; renderWatch(); } catch { /* (server gone) */ }
}
setInterval(() => { if ($('watchBox').open) refreshWatch(); }, 4000);
$('watchBox').addEventListener('toggle', () => { if ($('watchBox').open) refreshWatch(); });

// ---------------------------------------------------------------------------------------------------------- gallery
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
$('stop').onclick = () => state.run && api(`/api/runs/${state.run}/stop`, {}).catch((e) => msg('formMsg', e.message, 'err'));

$('form').onsubmit = async (ev) => {
  ev.preventDefault();
  msg('formMsg', '');
  try {
    const body = formBody();
    if (body.mode === 'compare' && body.models[0] === body.models[1]) throw new Error('pick two different designers');
    log.clear();
    const { id } = await api('/api/runs', body);
    attach(id);
  } catch (e) { msg('formMsg', e.message, 'err'); }
};
$('mode').onchange = modeChanged;
$('model').addEventListener('change', contractHint);
$('build').addEventListener('change', contractHint);
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
    if (prefs.mode) $('mode').value = prefs.mode;
    if (prefs.role !== undefined && state.roles.some((r) => r.id === prefs.role)) $('role').value = prefs.role; else $('role').value = 'starter';
    if (prefs.temperature !== undefined) $('temperature').value = prefs.temperature;
    if (prefs.rounds) $('rounds').value = prefs.rounds;
    if (prefs.build) $('build').value = prefs.build;
    if (prefs.mirror === false) $('mirror').checked = false;
    $('temperature').oninput();
    modeChanged(); roleChanged();
    setupPanes('design', [], 'no run yet');
    await loadModels().catch((e) => msg('formMsg', `models: ${e.message}`, 'err'));
    refreshGallery();
    refreshWatch();
    const { runs } = await api('/api/runs');
    const live = runs.find((r) => r.status === 'running') ?? runs.at(-1);
    if (live) attach(live.id);
  } catch (e) { msg('formMsg', e.message, 'err'); }
})();
