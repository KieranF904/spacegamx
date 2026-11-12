// The modifier lab's page: the parts bin, the grid you build on, the cards that show what each gun became, the firing
// range's feed and the Numbers panel. The rules are derive.js; this only places parts and shows results.
(function () {
  'use strict';

  const DEFAULTS = window.MLC, D = window.MLD, P = window.MLP;
  const GW = 14, GH = 9, CELL = 46, KEY = 'modlab.v1';
  const $ = (id) => document.getElementById(id);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const num = (v, d = 1) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(d));
  const money = (v) => Math.round(v).toLocaleString('en-GB');

  let cfg = clone(DEFAULTS), parts = [], uid = 1, tool = { type: 'conduit' }, modTier = 1, sel = null, out = null;

  const canvas = $('grid'), ctx = canvas.getContext('2d');
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  canvas.width = GW * CELL * dpr; canvas.height = GH * CELL * dpr;
  const range = window.MLR.create($('range'));

  // ---------------------------------------------------------------- state
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify({ parts, cfg, modTier })); } catch (e) { /* private window: nothing kept */ }
  }
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (!s || !Array.isArray(s.parts)) return false;
      parts = s.parts; cfg = s.cfg && s.cfg.TUNE ? s.cfg : clone(DEFAULTS); modTier = s.modTier || 1;
      uid = parts.reduce((m, p) => Math.max(m, p.id), 0) + 1;
      return true;
    } catch (e) { return false; }
  }
  // Undo: the grid as it was before each stroke or example
  const history = [];
  function snap() { history.push(JSON.stringify(parts)); if (history.length > 200) history.shift(); }
  function undo() {
    if (!history.length) return;
    parts = JSON.parse(history.pop());
    uid = parts.reduce((m, p) => Math.max(m, p.id), 0) + 1;
    if (!parts.some((p) => p.id === sel && p.type === 'gun')) { const g = parts.find((p) => p.type === 'gun'); sel = g ? g.id : null; }
    refresh();
  }
  function usePreset(p) {
    snap();
    parts = P.parse(p.rows);
    uid = parts.length + 1;
    const g = parts.find((q) => q.type === 'gun');
    sel = g ? g.id : null;
    refresh();
  }
  const partAt = (x, y) => parts.find((p) => p.x === x && p.y === y);

  function put(x, y) {
    const old = partAt(x, y);
    if (tool.type === 'erase') {
      if (old) { parts = parts.filter((p) => p !== old); if (sel === old.id) sel = null; }
      return;
    }
    if (old && old.type === 'gun') { sel = old.id; return; }
    const want = { type: tool.type, kind: tool.kind, tier: tool.type === 'mod' ? modTier : undefined };
    if (old && old.type === want.type && old.kind === want.kind && old.tier === want.tier) return;
    if (old) parts = parts.filter((p) => p !== old);
    const p = { id: uid++, x, y, ...want };
    parts.push(p);
    if (p.type === 'gun') sel = p.id;
  }

  function refresh() {
    try { out = D.derive(parts, cfg); } catch (e) { out = D.derive(parts, (cfg = clone(DEFAULTS))); $('cfgMsg').textContent = 'Those numbers broke the rules; defaults restored.'; }
    save();
    drawGrid(); renderSummary(); renderGuns(); feedRange();
  }

  // ---------------------------------------------------------------- parts bin
  function sameTool(a, b) { return a.type === b.type && a.kind === b.kind; }
  function renderTools() {
    const btn = (t, label, small, col) => `<button type="button" class="tool${sameTool(tool, t) ? ' on' : ''}" data-tool='${JSON.stringify(t)}'>` +
      `<i class="sw" style="background:${col}"></i>${esc(label)}<small>${esc(small)}</small></button>`;
    const t = cfg.MOD_TIERS.find((m) => m.tier === modTier) || cfg.MOD_TIERS[0];
    let h = '<div class="group"><span>Power</span>';
    for (const [k, r] of Object.entries(cfg.REACTORS)) h += btn({ type: 'reactor', kind: k }, r.name, `${r.supply}/s`, '#f5a83a');
    h += btn({ type: 'conduit' }, 'Conduit', '', '#5d6c77') + '</div>';
    h += `<div class="group"><span>Modifiers: treats ${t.capacity}/s, costs ${money(t.cost)}</span><div class="tiers">`;
    for (const m of cfg.MOD_TIERS) h += `<button type="button" class="${m.tier === modTier ? 'on' : ''}" data-tier="${m.tier}">T${m.tier}</button>`;
    h += '</div>';
    for (const [k, m] of Object.entries(cfg.MODS)) h += btn({ type: 'mod', kind: k }, m.name, cfg.PROPS[m.prop].name, m.col);
    h += '</div><div class="group"><span>Guns</span>';
    for (const [k, g] of Object.entries(cfg.GUNS)) h += btn({ type: 'gun', kind: k }, g.name, `T${g.tier} · ${+(g.rate * g.shotEnergy).toFixed(1)}/s`, '#dde5ea');
    h += '</div><div class="group">' + btn({ type: 'erase' }, 'Erase', '', '#ef6a5a') + '</div>';
    $('tools').innerHTML = h;
  }
  $('tools').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.tier) { modTier = +b.dataset.tier; if (tool.type !== 'mod') tool = { type: 'mod', kind: Object.keys(cfg.MODS)[0] }; }
    else tool = JSON.parse(b.dataset.tool);
    renderTools(); save();
  });

  function renderPresets() {
    $('presets').innerHTML = P.LIST.map((p) => `<button type="button" data-preset="${p.id}" title="${esc(p.say)}">${esc(p.name)}</button>`).join('');
  }
  $('presets').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) usePreset(P.LIST.find((p) => p.id === b.dataset.preset));
  });

  function renderLegend() {
    const mods = Object.values(cfg.MODS).map((m) => `<span><i style="background:${m.col}"></i>${esc(m.name)}: ${esc(cfg.PROPS[m.prop].name)}</span>`);
    const recs = cfg.RECIPES.map((r) => `<span><i style="background:${cfg.PROPS[r.prop].col}"></i>${esc(cfg.MODS[r.a].name)} + ${esc(cfg.MODS[r.b].name)}: ${esc(cfg.PROPS[r.prop].name)}</span>`);
    $('legend').innerHTML = mods.concat(recs).join('');
  }

  // ---------------------------------------------------------------- grid
  const mid = (p) => [p.x * CELL + CELL / 2, p.y * CELL + CELL / 2];
  function drawGrid() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0a0f13'; ctx.fillRect(0, 0, GW * CELL, GH * CELL);
    ctx.strokeStyle = '#172028'; ctx.lineWidth = 1;
    for (let x = 0; x <= GW; x++) { ctx.beginPath(); ctx.moveTo(x * CELL + 0.5, 0); ctx.lineTo(x * CELL + 0.5, GH * CELL); ctx.stroke(); }
    for (let y = 0; y <= GH; y++) { ctx.beginPath(); ctx.moveTo(0, y * CELL + 0.5); ctx.lineTo(GW * CELL, y * CELL + 0.5); ctx.stroke(); }

    const gun = out.guns.find((g) => g.id === sel);
    const lit = new Set(gun ? gun.line : []);
    if (gun) lit.add(gun.id);
    const modOut = new Map(out.mods.map((m) => [m.id, m]));

    // The lines between touching parts, lit along the selected gun's line
    for (const p of parts) for (const [dx, dy] of [[1, 0], [0, 1]]) {
      const n = partAt(p.x + dx, p.y + dy);
      if (!n || !(D.conducts(p) || D.conducts(n))) continue;
      const on = lit.has(p.id) && lit.has(n.id);
      ctx.strokeStyle = on ? '#f5a83a' : '#2a3742'; ctx.lineWidth = on ? 4 : 3;
      ctx.beginPath(); ctx.moveTo(...mid(p)); ctx.lineTo(...mid(n)); ctx.stroke();
    }
    // Fused pairs, joined in the colour of what they make
    const byId = new Map(parts.map((p) => [p.id, p]));
    for (const pr of out.pairs) {
      ctx.strokeStyle = cfg.PROPS[pr.prop].col; ctx.lineWidth = 12; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(...mid(byId.get(pr.a))); ctx.lineTo(...mid(byId.get(pr.b))); ctx.stroke();
      ctx.lineCap = 'butt';
    }

    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const p of parts) {
      const [cx, cy] = mid(p);
      if (p.type === 'conduit') {
        ctx.fillStyle = lit.has(p.id) ? '#f5a83a' : '#5d6c77';
        ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2); ctx.fill();
      } else if (p.type === 'reactor') {
        const r = cfg.REACTORS[p.kind], s = p.kind === 'core' ? 17 : 13;
        ctx.fillStyle = '#f5a83a'; ctx.fillRect(cx - s, cy - s, s * 2, s * 2);
        ctx.fillStyle = '#0e1317'; ctx.font = '500 12px "IBM Plex Mono", monospace'; ctx.fillText(r ? r.supply : '?', cx, cy + 1);
      } else if (p.type === 'mod') {
        const m = cfg.MODS[p.kind], o = modOut.get(p.id), live = o && o.feeds.length > 0;
        ctx.globalAlpha = live ? 1 : 0.4;
        ctx.fillStyle = m ? m.col : '#5d6c77';
        ctx.beginPath(); ctx.moveTo(cx, cy - 17); ctx.lineTo(cx + 17, cy); ctx.lineTo(cx, cy + 17); ctx.lineTo(cx - 17, cy); ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#0e1317'; ctx.font = '600 12px "IBM Plex Mono", monospace'; ctx.fillText((m ? m.glyph : '?') + p.tier, cx, cy + 1);
        ctx.globalAlpha = 1;
      } else if (p.type === 'gun') {
        const g = out.guns.find((q) => q.id === p.id), base = cfg.GUNS[p.kind];
        ctx.fillStyle = '#1d262e'; ctx.strokeStyle = p.id === sel ? '#f5a83a' : g && g.powered ? '#dde5ea' : '#ef6a5a'; ctx.lineWidth = p.id === sel ? 3 : 2;
        ctx.beginPath(); ctx.arc(cx, cy, 16, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#dde5ea'; ctx.font = '600 11px "IBM Plex Mono", monospace'; ctx.fillText(base ? base.name.slice(0, 3) : '?', cx, cy + 1);
        // One pip of colour for each property it carries
        const props = g ? Object.keys(g.levels).filter((k) => g.levels[k] > 0) : [];
        props.forEach((k, i) => { ctx.fillStyle = cfg.PROPS[k].col; ctx.fillRect(cx - props.length * 3.5 + i * 7, cy + 18, 5, 4); });
      }
    }
  }

  let painting = false;
  function cellOf(e) {
    const r = canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - r.left) / r.width * GW), y = Math.floor((e.clientY - r.top) / r.height * GH);
    return x >= 0 && y >= 0 && x < GW && y < GH ? [x, y] : null;
  }
  function act(e, first) {
    const c = cellOf(e);
    if (!c) return;
    const erase = e.buttons === 2 || e.button === 2;
    if (!first && !erase && tool.type !== 'conduit' && tool.type !== 'erase') return;
    const keep = tool;
    if (erase) tool = { type: 'erase' };
    put(c[0], c[1]);
    tool = keep;
    refresh();
  }
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => { snap(); painting = true; canvas.setPointerCapture(e.pointerId); act(e, true); });
  canvas.addEventListener('pointermove', (e) => { if (painting) act(e, false); });
  canvas.addEventListener('pointerup', () => { painting = false; });
  canvas.addEventListener('pointercancel', () => { painting = false; });

  // ---------------------------------------------------------------- what the guns became
  function renderSummary() {
    const t = out.totals, need = t.demand + t.upkeep, short = need > t.supply + 1e-9;
    const stat = (v, label, warn) => `<div class="stat${warn ? ' warn' : ''}"><b>${v}</b><span>${label}</span></div>`;
    $('summary').innerHTML = stat(num(t.dps), 'damage a second, all guns') + stat(money(t.cost), 'credits lost on death') +
      stat(`${num(need)} / ${num(t.supply)}`, short ? 'power wanted / supplied: short' : 'power wanted / supplied', short) +
      stat(num(t.upkeep), 'power burnt by modifiers');
  }

  function propRow(g, k) {
    const p = cfg.PROPS[k], share = g.shares[k], lv = g.levels[k], max = cfg.TUNE.thresholds.length, nx = g.next[k];
    const ticks = cfg.TUNE.thresholds.filter((t) => t < 1).map((t) => `<u style="left:${t * 100}%"></u>`).join('');
    let why = `${Math.round(share * 100)}% of its draw treated.`;
    if (nx && lv < max) why += ` Level ${lv + 1} at ${Math.round(nx.at * 100)}%: ${num(nx.more)} more a second.`;
    return `<div class="prop" title="${esc(p.say)}"><span class="nm"><i style="background:${p.col}"></i>${esc(p.name)}</span>` +
      `<span class="meter"><i style="width:${share * 100}%;background:${p.col};opacity:${lv ? 1 : 0.4}"></i>${ticks}</span>` +
      `<span class="lv">${lv}/${max}</span><span class="why">${why}</span></div>`;
  }

  function shotLine(g) {
    const s = g.stats, bits = [];
    bits.push(s.shots > 1 ? `${s.shots} × ${num(s.perShot)} dmg` : `${num(s.perShot)} dmg`);
    bits.push(`${num(s.rate, 2)}/s`, `${Math.round(s.speed)} px/s`);
    if (s.fracs.length > 1) bits.push('through ' + s.fracs.map((f) => Math.round(f * 100) + '%').join(' / '));
    if (s.blast) bits.push(`blast ${Math.round(s.blast * 100)}% in ${s.radius}px`);
    if (s.bounces) bits.push(`${s.bounces} bounce${s.bounces > 1 ? 's' : ''}`);
    if (s.width > 1) bits.push(`${num(s.width)}× wide`);
    return bits.join(' · ');
  }

  function renderGuns() {
    if (!out.guns.length) { $('guns').innerHTML = '<p class="empty">No guns yet. Place a reactor, then a gun next to it.</p>'; return; }
    $('guns').innerHTML = out.guns.map((g) => {
      const ratio = g.stats.baseDps ? g.stats.dps / g.stats.baseDps : 0, props = Object.keys(g.shares);
      const delta = !g.powered ? '<em class="down">no power</em>' : Math.abs(ratio - 1) < 0.005 ? 'as built' : `<em class="${ratio < 1 ? 'down' : ''}">×${ratio.toFixed(2)}</em> of its plain ${num(g.stats.baseDps)}`;
      const power = g.factor < 1 && g.powered ? ` · <em class="down">fed ${Math.round(g.factor * 100)}%</em>` : '';
      return `<div class="gun${g.id === sel ? ' sel' : ''}${g.powered ? '' : ' dead'}" data-gun="${g.id}" tabindex="0">` +
        `<header><b>${esc(g.name)}</b><span class="tier">T${g.tier}</span><span class="dps">${num(g.stats.dps)} dps</span></header>` +
        `<div class="line mono">${delta} · draws ${num(g.wants)}/s${power}</div>` +
        `<div class="line mono">${shotLine(g)}</div>` +
        (props.length ? `<div class="props">${props.map((k) => propRow(g, k)).join('')}</div>` : '<div class="none">Nothing in its line.</div>') +
        `<div class="line mono">gun ${money(g.cost.gun)} + modifiers ${money(g.cost.mods)} = ${money(g.cost.total)} · ${num(g.stats.dps / g.cost.total * 1000)} dps per 1,000</div></div>`;
    }).join('');
  }
  $('guns').addEventListener('click', (e) => {
    const c = e.target.closest('.gun');
    if (c) { sel = +c.dataset.gun; refresh(); }
  });
  $('guns').addEventListener('keydown', (e) => {
    const c = e.target.closest('.gun');
    if (c && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); sel = +c.dataset.gun; refresh(); }
  });

  // ---------------------------------------------------------------- firing range
  let fed = '';
  function feedRange() {
    const g = out.guns.find((q) => q.id === sel);
    const sig = g ? JSON.stringify(g.stats) : '';
    if (sig === fed) return;
    fed = sig;
    const top = g && Object.keys(g.levels).filter((k) => g.levels[k] > 0).sort((a, b) => g.levels[b] - g.levels[a])[0];
    range.setShot(g && g.powered ? g.stats : null, top ? cfg.PROPS[top].col : '#f5a83a');
  }
  setInterval(() => {
    const g = out && out.guns.find((q) => q.id === sel);
    $('rangeinfo').textContent = g && g.powered ? `${g.name}: ${num(range.measured())} dps landing · ${num(g.stats.dps)} if everything hit one deep target` : '';
  }, 400);

  // ---------------------------------------------------------------- numbers
  function showCfg() { $('cfg').value = JSON.stringify(cfg, null, 2); $('keepSingles').checked = !!cfg.TUNE.fusedKeepsSingles; }
  function applyCfg(next, msg) {
    cfg = next;
    renderTools(); renderLegend(); showCfg(); refresh();
    $('cfgMsg').textContent = msg;
  }
  $('cfgApply').addEventListener('click', () => {
    let next;
    try { next = JSON.parse($('cfg').value); } catch (e) { $('cfgMsg').textContent = 'Not valid JSON: ' + e.message; return; }
    if (!next.GUNS || !next.MODS || !next.TUNE || !next.MOD_TIERS || !next.PROPS || !next.RECIPES || !next.REACTORS) { $('cfgMsg').textContent = 'A section is missing; nothing changed.'; return; }
    applyCfg(next, 'Applied.');
  });
  $('cfgReset').addEventListener('click', () => applyCfg(clone(DEFAULTS), 'Defaults restored.'));
  $('keepSingles').addEventListener('change', (e) => { cfg.TUNE.fusedKeepsSingles = e.target.checked; applyCfg(cfg, ''); });

  $('undo').addEventListener('click', undo);
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); undo(); }
  });

  // ---------------------------------------------------------------- start
  const had = load();
  renderTools(); renderPresets(); renderLegend(); showCfg();
  if (had) { const g = parts.find((p) => p.type === 'gun'); sel = g ? g.id : null; refresh(); } else usePreset(P.LIST[0]);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(drawGrid);
})();
