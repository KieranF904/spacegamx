// Weapons lab page: weapon list and filters, a weapon's page (stats, live sim preview, AI editing, raw data), drafts.
// Plain browser JS, no build. The sim runs on the lab server (the game's own code); the page replays its frames.
const K = new URLSearchParams(location.search).get('k') || '';
const $ = (s, el = document) => el.querySelector(s);
const view = $('#view');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const api = async (path, body) => {
  const r = await fetch(`${path}${path.includes('?') ? '&' : '?'}k=${encodeURIComponent(K)}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
};
let player = null; // the running preview (stopped when the view changes)
const stopPlayer = () => { if (player) { player.stop(); player = null; } };

// ---- weapon list ----
const filt = { q: '', tag: 'all' };
const TAGS = [['all', 'All'], ['player', 'Player'], ['enemy', 'Enemy'], ['model', 'Models'], ['legacy', 'Legacy'], ['kind', 'Kinds']];
const tagOf = (w, t) => t === 'all' || w.owner === t || w.source === t;

async function showList() {
  stopPlayer();
  $('#tabW').className = 'on'; $('#tabD').className = '';
  const list = await api('/api/weapons');
  view.innerHTML = `<div class="card"><input id="q" placeholder="Search name, id, kind, family" value="${esc(filt.q)}">
    <div class="row">${TAGS.map(([t, n]) => `<button data-t="${t}" class="${filt.tag === t ? 'on' : ''}">${n}</button>`).join('')}</div></div><div id="items"></div>`;
  const draw = () => {
    const q = filt.q.toLowerCase();
    const rows = list.filter((w) => tagOf(w, filt.tag) && (!q || [w.id, w.name, w.kind, w.family, w.description].some((s) => (s || '').toLowerCase().includes(q))));
    $('#items').innerHTML = rows.map((w) => `<div class="card item" data-id="${esc(w.id)}"><span><b>${esc(w.name)}</b> <span class="dim">${esc(w.id)}</span></span>
      <span><span class="chip">${esc(w.kind)}</span> <span class="chip">${w.owner}</span> <span class="chip">${w.source}</span></span>
      ${w.description ? `<div class="dim" style="flex-basis:100%">${esc(w.description)}</div>` : ''}</div>`).join('') || '<p class="dim">Nothing matches.</p>';
  };
  $('#q').oninput = (e) => { filt.q = e.target.value; draw(); };
  view.querySelectorAll('[data-t]').forEach((b) => (b.onclick = () => { filt.tag = b.dataset.t; showList(); }));
  $('#items').onclick = (e) => { const c = e.target.closest('[data-id]'); if (c) showWeapon(c.dataset.id); };
  draw();
}

// ---- a weapon's (or draft's) page ----
async function showWeapon(id, draftId) {
  stopPlayer();
  const draft = draftId ? await api(`/api/draft?id=${draftId}`) : null;
  const w = draft ? draft.entry : await api(`/api/weapon?id=${encodeURIComponent(id)}`);
  const row = draft ? draft.model : w.raw;
  view.onclick = null;
  const cfg = await api('/api/config');
  view.innerHTML = `<p><button id="back">&larr; Back</button></p>
  <div class="card"><h2>${esc(draft ? draft.model.name || draft.id : w.name)} <span class="dim">${esc(draft ? 'draft ' + draft.id : w.id)}</span></h2>
    <p class="dim">${esc(w.description || '')}${draft && draft.base ? ` Copied from ${esc(draft.base)}.` : ''}</p><table>${w.stats.map((s) => `<tr><td>${esc(s.label)}</td><td>${esc(s.value)}</td></tr>`).join('')}
      ${w.audio.sfx ? `<tr><td>Audio</td><td>${esc([w.audio.sfx, w.audio.sfxTurret].filter(Boolean).join(', '))}${w.audio.known.length ? '' : ' <span class="dim">(not in audio.json)</span>'}</td></tr>` : ''}</table></div>
  <div class="card"><h2>How it works</h2>
    <div class="row"><select id="scn"><option value="dummy">Stationary dummy</option><option value="moving">Moving target</option><option value="wall">Block wall</option></select>
    <button id="run" class="primary">Fire</button><button id="pause">Pause</button><select id="spd"><option value="1">1x</option><option value="0.5">0.5x</option><option value="0.25">0.25x</option></select>
    <input type="range" id="seek" min="0" max="0" value="0" style="flex:1;min-width:120px;padding:0"></div>
    <canvas id="cv" width="960" height="540"></canvas><div id="simInfo" class="dim"></div></div>
  <div class="card"><h2>Edit with a model</h2>
    <div class="row"><label><input type="radio" name="mode" value="modify" checked> Modify this</label><label><input type="radio" name="mode" value="new"> New weapon, based on this</label></div>
    <div class="row"><input id="did" style="flex:1" value="${esc(draft ? draft.id : suggestId(id))}" aria-label="Draft id">
      <select id="prov"><option value="ollama">Ollama (${esc(cfg.ollama.model)})</option><option value="lmstudio">LM Studio (${esc(cfg.lmstudio.model)})</option></select></div>
    <textarea id="req" placeholder="What should change? e.g. fire twice as fast but halve the damage"></textarea>
    <div class="row"><button id="send" class="primary">Ask the model</button><span id="busy" class="dim">${cfg.fake ? 'Fake model: no prompt leaves the lab.' : ''}</span></div><div id="out"></div></div>
  <div class="card"><h2>${draft ? 'Draft data' : 'Raw data'}</h2>
    ${draft ? `<textarea id="json" class="json">${esc(JSON.stringify(draft.model, null, 1))}</textarea><div class="row"><button id="check">Check</button><button id="save" class="primary">Save draft</button></div><div id="chk"></div>
      <h2>Prompt history</h2>${draft.history.map((h) => `<div class="dim">${esc(h.at.slice(0, 16))} ${h.ok ? '<span class="ok">ok</span>' : '<span class="bad">failed</span>'} (${esc(h.provider)}): ${esc(h.request)}</div>`).join('') || '<p class="dim">None.</p>'}`
      : `<pre>${esc(JSON.stringify(row, null, 1))}</pre>`}</div>`;
  $('#back').onclick = () => (draft ? showDrafts() : showList());
  const currentDraft = () => { try { return JSON.parse($('#json').value); } catch { return draft.model; } };
  setupPreview(() => ({ weapon: draft ? draft.id : id, ...(draft ? { model: currentDraft() } : {}) }));
  $('#send').onclick = async () => {
    const out = $('#out'), btn = $('#send');
    btn.disabled = true; $('#busy').textContent = 'Waiting for the model...';
    try {
      const mode = view.querySelector('input[name=mode]:checked').value;
      const r = await api('/api/llm', { mode, id: $('#did').value.trim(), base: draft ? draft.base : id, request: $('#req').value, provider: $('#prov').value });
      out.innerHTML = r.ok ? `<p class="ok">Valid. Saved as draft <b>${esc(r.draft.id)}</b>.</p><button id="open" class="primary">Open the draft</button>` : `<p class="bad">The reply was rejected:</p><ul>${r.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>${r.reply ? `<details><summary>The reply</summary><pre>${esc(r.reply)}</pre></details>` : ''}`;
      out.insertAdjacentHTML('beforeend', `<details><summary>The prompt that was sent</summary><pre>${esc(r.prompt.system + '\n\n' + r.prompt.user)}</pre></details>`);
      if (r.ok) $('#open').onclick = () => showWeapon(r.draft.id, r.draft.id);
    } catch (e) { out.innerHTML = `<p class="bad">${esc(e.message)}</p>`; }
    btn.disabled = false; $('#busy').textContent = '';
  };
  if (draft) {
    $('#check').onclick = async () => { const r = await api('/api/check', { model: currentDraft() }); $('#chk').innerHTML = r.ok ? '<p class="ok">Valid.</p>' : `<ul class="bad">${r.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`; };
    $('#save').onclick = async () => { const r = await api('/api/draft', { model: currentDraft() }); $('#chk').innerHTML = r.ok ? '<p class="ok">Saved.</p>' : `<ul class="bad">${r.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`; };
  }
}
const suggestId = (id) => `${id.replace(/^kind:/, '')}_mk2`.replace(/[^a-z0-9_]/g, '_');

// ---- drafts ----
async function showDrafts() {
  stopPlayer();
  $('#tabW').className = ''; $('#tabD').className = 'on';
  const list = await api('/api/drafts');
  view.innerHTML = `<p class="dim">Drafts live in lab/weapons/ and are never loaded by the game. Nothing joins the game until Claude reviews and adds it.</p>` +
    (list.map((d) => `<div class="card item" data-id="${esc(d.id)}"><span><b>${esc(d.model.name || d.id)}</b> <span class="dim">${esc(d.id)}</span></span><span class="dim">${d.base ? 'from ' + esc(d.base) + ', ' : ''}${d.history.length} prompt${d.history.length === 1 ? '' : 's'}, ${esc((d.updated || '').slice(0, 10))}</span></div>`).join('') || '<p class="dim">No drafts yet: open a weapon and ask the model for a change.</p>');
  view.onclick = (e) => { const c = e.target.closest('[data-id]'); if (c) showWeapon(c.dataset.id, c.dataset.id); };
}

// ---- the sim preview: replay the server's frames on a canvas ----
function setupPreview(request) {
  const cv = $('#cv'), ctx = cv.getContext('2d'), info = $('#simInfo');
  let res = null, tick = 0, playing = false, raf = 0, last = 0, acc = 0;
  const X0 = -90, X1 = 820, S = cv.width / (X1 - X0), CY = cv.height / 2, sx = (x) => (x - X0) * S, sy = (y) => CY + y * S;
  const ship = (sh, x, y, ang, fill) => {
    const c = Math.cos(ang + Math.PI / 2), s = Math.sin(ang + Math.PI / 2), cs = res.cellSize;
    ctx.fillStyle = fill; ctx.strokeStyle = '#0b1220'; ctx.lineWidth = 1;
    for (const poly of sh.polys) {
      ctx.beginPath();
      poly.forEach(([gx, gy], i) => { const lx = (gx - sh.com[0]) * cs, ly = (gy - sh.com[1]) * cs; const px = sx(x + lx * c - ly * s), py = sy(y + lx * s + ly * c); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
      ctx.closePath(); ctx.fill(); ctx.stroke();
    }
  };
  const draw = () => {
    ctx.fillStyle = '#050a14'; ctx.fillRect(0, 0, cv.width, cv.height);
    if (!res) return;
    const f = res.frames[Math.min(tick, res.frames.length - 1)];
    ctx.strokeStyle = '#1c2740'; ctx.lineWidth = 1; for (let x = 0; x <= 800; x += 100) { ctx.beginPath(); ctx.moveTo(sx(x), 0); ctx.lineTo(sx(x), cv.height); ctx.stroke(); }
    ctx.fillStyle = '#8b98b0'; ctx.font = '14px system-ui'; for (let x = 100; x <= 800; x += 100) ctx.fillText(x, sx(x) + 3, 16);
    f.tg.forEach((t, i) => ship(res.target, t[0], t[1], t[2], f.hit.includes(i) ? '#f87171' : '#4a5d82'));
    ship(res.pilot, f.p[0], f.p[1], f.p[2], '#fbbf24');
    // Beams: a line out of the ship along its aim while the trigger is held (bright when it struck a target this tick)
    if (res.beam && f.p[3]) { ctx.strokeStyle = f.hit.length ? '#fff7d6' : '#fbbf2488'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(sx(0), sy(0)); ctx.lineTo(sx(Math.cos(f.p[2]) * 760), sy(Math.sin(f.p[2]) * 760)); ctx.stroke(); }
    for (const b of res.frames.slice(Math.max(0, tick - 12), tick + 1).flatMap((g, k, a) => g.bl.map(([x, y, r]) => [x, y, r, 1 - (a.length - 1 - k) / 12]))) {
      ctx.strokeStyle = `rgba(251,146,60,${b[3]})`; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(sx(b[0]), sy(b[1]), Math.max(2, b[2] * S), 0, 7); ctx.stroke();
    }
    ctx.fillStyle = '#e6ecf6';
    for (const [x, y, vx, vy] of f.sh) { ctx.strokeStyle = '#e6ecf688'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(sx(x - vx * 2), sy(y - vy * 2)); ctx.lineTo(sx(x), sy(y)); ctx.stroke(); ctx.beginPath(); ctx.arc(sx(x), sy(y), 3, 0, 7); ctx.fill(); }
    ctx.fillStyle = '#e6ecf6'; ctx.font = '16px system-ui';
    ctx.fillText(`${(tick / 60).toFixed(1)}s   damage dealt: ${f.tg.map((t) => Math.round(t[3])).join(' / ')}${f.p[3] ? '   firing' : ''}`, 10, cv.height - 12);
    $('#seek').value = tick;
  };
  const loop = (now) => {
    raf = requestAnimationFrame(loop);
    if (!playing || !res) { last = now; return; }
    acc += (now - last) * Number($('#spd').value) / (1000 / 60); last = now;
    while (acc >= 1) { acc -= 1; if (tick < res.frames.length - 1) tick++; else playing = false; }
    draw();
  };
  $('#run').onclick = async () => {
    info.textContent = 'Running the sim...';
    try {
      res = await api('/api/sim', { ...request(), scenario: $('#scn').value });
      tick = 0; playing = true; $('#seek').max = res.frames.length - 1;
      info.textContent = `${res.kind}${res.beam ? ' (beam)' : ''}: ${res.frames.length} ticks run in the game's own sim. Damage dealt to targets: ${res.dealt.join(' / ')}.${res.note ? ' ' + res.note : ''}`;
    } catch (e) { info.textContent = e.message; }
    draw();
  };
  $('#pause').onclick = () => { playing = !playing; };
  $('#seek').oninput = (e) => { playing = false; tick = Number(e.target.value); draw(); };
  raf = requestAnimationFrame(loop);
  draw();
  player = { stop: () => cancelAnimationFrame(raf) };
}

$('#tabW').onclick = showList;
$('#tabD').onclick = showDrafts;
showList().catch((e) => { view.innerHTML = `<p class="bad">${esc(e.message)}</p>`; });
