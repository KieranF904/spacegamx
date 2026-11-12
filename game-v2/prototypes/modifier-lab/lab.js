// The modifier layer of the lab page: wraps the energy lab's own page functions (rebuild, step, draw, explain...) so
// the modifiers of treat.js are linked, ticked, drawn and explained on top of the unmodified ports model. Loaded after
// the page script, whose top-level names (parts, L, CS, cx, T, selected...) it uses directly.
(function () {
  'use strict';
  const { PROPS, COMPS } = MLT;
  const TUNE = JSON.parse(JSON.stringify(MLT.TUNE));

  const base = { rebuild, step, draw, glyph, explain, renderPalette, chargeAll, save, renderLists };
  const PLAIN = '#ffe08a';
  const propsOf = (o) => Object.keys(o).sort((a, b) => o[b] - o[a]);

  // ================================================================ the model hooks
  rebuild = function () { base.rebuild(); MLT.link(L, TUNE); };
  step = function () { MLT.before(L); base.step(); MLT.after(L, TUNE); };
  // (Charge all leaves the hoppers as they are: they are loaded at a station only, the Dock button here)
  chargeAll = function (full) {
    const was = parts.filter((p) => T[p.type].hopper).map((p) => [p, p.fill]);
    base.chargeAll(full); for (const [p, f] of was) p.fill = f;
    if (!full) { MLT.clear(parts); for (const p of parts) if (T[p.type].special) p.buf = 0; }
  };
  const dockBtn = document.createElement('button');
  dockBtn.className = 'b'; dockBtn.id = 'dock'; dockBtn.textContent = 'Dock'; dockBtn.title = 'Dock at a station: reload every hopper';
  document.getElementById('repair').after(dockBtn);
  dockBtn.addEventListener('click', () => { for (const p of parts) if (T[p.type].hopper) p.fill = T[p.type].fill; renderCard(); });

  // ================================================================ symbols (one shape list, drawn on the canvas and in the palette)
  const SYM = {
    coil: [{ pts: [[-0.2, -0.24], [0.2, -0.16], [-0.2, -0.08], [0.2, 0], [-0.2, 0.08], [0.2, 0.16], [-0.2, 0.24]] }],
    resonator: [{ pts: Array.from({ length: 17 }, (_, i) => [-0.26 + i * 0.0325, -0.17 * Math.sin((i / 16) * Math.PI * 4)]) }],
    chamber: [{ r: 0.21 }, { r: 0.07, fill: true }],
    prism: [{ pts: [[0, -0.22], [0.23, 0.18], [-0.23, 0.18]], close: true }],
    arc: [{ pts: [[0.08, -0.26], [-0.14, 0.02], [0.06, 0.02], [-0.08, 0.26]] }],
    condenser: [{ pts: [[-0.2, -0.2], [0.2, -0.2], [0.2, 0.2], [-0.2, 0.2]], close: true }, { r: 0.09, fill: true }],
    brand: [{ pts: [[0, -0.26], [0.19, 0.06], [0.1, 0.22], [-0.1, 0.22], [-0.19, 0.06]], close: true }, { r: 0.05, fill: true }],
    rail: [{ pts: [[-0.24, -0.12], [0.24, -0.12]] }, { pts: [[-0.24, 0.12], [0.24, 0.12]] }, { pts: [[-0.1, -0.05], [0.04, 0], [-0.1, 0.05]] }],
  };
  function drawSym(comp, X, Y, u, col) {
    cx.strokeStyle = col; cx.fillStyle = col; cx.lineWidth = Math.max(1.5, u / 13); cx.lineJoin = 'round'; cx.lineCap = 'round';
    for (const s of SYM[comp]) {
      cx.beginPath();
      if (s.r) { cx.arc(X, Y, s.r * u, 0, 7); if (s.fill) cx.fill(); else cx.stroke(); continue; }
      s.pts.forEach(([x, y], i) => (i ? cx.lineTo(X + x * u, Y + y * u) : cx.moveTo(X + x * u, Y + y * u)));
      if (s.close) cx.closePath(); cx.stroke();
    }
  }
  function svgSym(comp, X, Y, u, col) {
    const w = Math.max(1.2, u / 11).toFixed(1);
    return SYM[comp].map((s) => (s.r ? `<circle cx="${X}" cy="${Y}" r="${(s.r * u).toFixed(1)}" fill="${s.fill ? col : 'none'}" stroke="${col}" stroke-width="${w}"/>`
      : `<${s.close ? 'polygon' : 'polyline'} points="${s.pts.map(([x, y]) => `${(X + x * u).toFixed(1)},${(Y + y * u).toFixed(1)}`).join(' ')}" fill="none" stroke="${col}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"/>`)).join('');
  }
  /** The little rectangle of a socket on a cell's edge, [x, y, w, h] in px for cells of u px (out: on the far side of the edge) */
  function notch(x, y, side, u, out) {
    const [vx, vy] = SIDE_V[side], ex = (x + 0.5 + vx / 2) * u, ey = (y + 0.5 + vy / 2) * u, d = u * 0.14, l = u * 0.5;
    const back = out ? 0 : 1;
    return vx ? [ex - (vx > 0 ? d * back : d * (1 - back)), ey - l / 2, d, l] : [ex - l / 2, ey - (vy > 0 ? d * back : d * (1 - back)), l, d];
  }
  glyph = function (type, r, f, px) {
    const svg = base.glyph(type, r, f, px), t = T[type];
    let extra = '';
    if (t.plug) extra = svgSym(t.plug, px / 2, px / 2, px * 0.95, t.col);
    else if (t.mount) extra = MLT.socketsOf({ type, rot: r || 0, flip: !!f, cells: PM.rectCells(type, 0, 0, r || 0) }).map((k) => { const [X, Y, W, H] = notch(k.x, k.y, k.side, px); return `<rect x="${X.toFixed(1)}" y="${Y.toFixed(1)}" width="${W.toFixed(1)}" height="${H.toFixed(1)}" fill="#0a0e11" stroke="${t.col}" stroke-width="1"/>`; }).join('');
    return extra ? svg.replace('</svg>', extra + '</svg>') : svg;
  };

  // ================================================================ drawing on the grid
  /** The path power takes through a line part, in cells: [in edge, middle, out edge] for each in port, shifted sideways by o */
  function paths(p, o) {
    const outs = p.ports.filter((q) => q.dir === 'out'), res = [];
    for (const a of p.ports) {
      if (a.dir !== 'in' || !outs.length) continue;
      const b = outs.find((q) => q.x === a.x && q.y === a.y) || outs[0];
      const [ax, ay] = SIDE_V[a.side], [bx, by] = SIDE_V[b.side];
      // (Sideways is measured across the direction of flow, so a strand keeps its lane round a corner)
      const pa = [ay, -ax], pb = [-by, bx], same = pa[0] === pb[0] && pa[1] === pb[1];
      res.push([[a.x + 0.5 + ax / 2 + pa[0] * o, a.y + 0.5 + ay / 2 + pa[1] * o],
        [a.x + 0.5 + pa[0] * o + (same ? 0 : pb[0] * o), a.y + 0.5 + pa[1] * o + (same ? 0 : pb[1] * o)],
        [b.x + 0.5 + pb[0] * o + (same || (b.x === a.x && b.y === a.y) ? 0 : pa[0] * o), b.y + 0.5 + pb[1] * o + (same || (b.x === a.x && b.y === a.y) ? 0 : pa[1] * o)],
        [b.x + 0.5 + bx / 2 + pb[0] * o, b.y + 0.5 + by / 2 + pb[1] * o]]);
    }
    return res;
  }
  const box = (p) => { const xs = p.cells.map((c) => c[0]), ys = p.cells.map((c) => c[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs) + 1, Math.max(...ys) + 1]; };

  draw = function () {
    base.draw();
    if (!L || !L.mods) return;
    const u = CS, t0 = performance.now() / 1000;
    for (const s of L.stores) {
      const t = T[s.type], m = MLT.mix(s), props = propsOf(m);
      if (t.conduit && props.length && u >= 12) {
        // Treatment on a line: one moving dashed strand for each property, brighter the more of the guns' load it covers
        cx.lineWidth = Math.max(1.5, u / 16); cx.lineCap = 'butt'; cx.setLineDash([u * 0.16, u * 0.1]); cx.lineDashOffset = -t0 * u * 1.4;
        props.forEach((prop, i) => {
          cx.strokeStyle = PROPS[prop].col; cx.globalAlpha = 0.3 + 0.7 * m[prop];
          for (const path of paths(s, -0.36 + i * 0.105)) { cx.beginPath(); path.forEach(([x, y], k) => (k ? cx.lineTo(x * u, y * u) : cx.moveTo(x * u, y * u))); cx.stroke(); }
        });
        cx.setLineDash([]); cx.globalAlpha = 1;
      } else if (!t.conduit && props.length && u >= 12) {
        // Treatment through a joiner or splitter: a thin bar for each property across its top
        const [x0, y0, x1] = box(s), h = Math.max(2, u / 14);
        props.forEach((prop, i) => { cx.fillStyle = '#0a0e11'; cx.fillRect(x0 * u + 3, y0 * u + 3 + i * (h + 1), (x1 - x0) * u - 6, h); cx.fillStyle = PROPS[prop].col; cx.fillRect(x0 * u + 3, y0 * u + 3 + i * (h + 1), ((x1 - x0) * u - 6) * m[prop], h); });
      }
      // A line part of a higher tier: its mark. One that is full (an effect dropped, or over what it carries): an amber frame
      if (s.tier > 1 && u >= 18) { const [x0, y0, x1] = box(s); cx.fillStyle = '#e8e3d6'; cx.font = `700 ${Math.min(10, u / 3.6)}px "IBM Plex Sans", sans-serif`; cx.textAlign = 'right'; cx.fillText(s.tier === 2 ? 'II' : 'III', x1 * u - 3, y0 * u + Math.min(11, u / 3)); cx.textAlign = 'left'; }
      if (s.fxDrop || s.fxOver) { const [x0, y0, x1, y1] = box(s); cx.strokeStyle = '#ffb454'; cx.lineWidth = 2; cx.setLineDash([5, 3]); cx.strokeRect(x0 * u + 2, y0 * u + 2, (x1 - x0) * u - 4, (y1 - y0) * u - 4); cx.setLineDash([]); }
      if (t.mount) {
        // A mount: its sockets down one side (filled in the colour of what is plugged in), and what it holds in its middle
        const busy = (s.jobs || []).some((j) => j.now > 0.5), col = s.comp ? COMPS[s.comp].col : t.col;
        if (busy) for (const [x, y] of s.cells) { cx.fillStyle = col; cx.globalAlpha = 0.1 + 0.06 * Math.sin(t0 * 5 + s.uid); cx.fillRect(x * u, y * u, u, u); cx.globalAlpha = 1; }
        for (const k of s.sockets || []) {
          const [X, Y, W, H] = notch(k.x, k.y, k.side, u), bad = k.block && !k.ok;
          cx.fillStyle = bad ? '#ff5d5d' : k.block ? col : '#0a0e11'; cx.fillRect(X, Y, W, H);
          cx.strokeStyle = bad ? '#ff5d5d' : col; cx.lineWidth = 1.5; cx.strokeRect(X + 0.5, Y + 0.5, W - 1, H - 1);
        }
        if (s.comp) { const [x0, y0, x1, y1] = box(s); drawSym(s.comp, ((x0 + x1) / 2) * u, ((y0 + y1) / 2) * u, u * 0.55, busy ? '#ffffff' : col); }
      }
    }
    // A modifier block: its symbol, and a plug across the edge into the socket it sits against
    for (const b of L.blocks || []) {
      const t = T[b.type], [x, y] = b.cells[0], k = b.host && b.host.sockets.find((q) => q.block === b), col = b.bad ? '#ff5d5d' : t.col;
      cx.fillStyle = t.col; cx.globalAlpha = k && !b.bad ? 0.24 : 0.08; cx.fillRect(x * u + 1, y * u + 1, u - 2, u - 2); cx.globalAlpha = 1;
      cx.strokeStyle = col; cx.lineWidth = 1.5; if (!k) cx.setLineDash([4, 3]); cx.strokeRect(x * u + 2, y * u + 2, u - 4, u - 4); cx.setLineDash([]);
      drawSym(t.plug, (x + 0.5) * u, (y + 0.5) * u, u * 0.85, k && !b.bad ? t.col : mix(t.col, 0.55));
      if (k) { const [X, Y, W, H] = notch(k.x, k.y, k.side, u, true); cx.fillStyle = col; cx.fillRect(X, Y, W, H); }
      // A special one: what it holds ready along its foot, and an amber frame while it is dry
      if (t.special && k && !b.bad) {
        const cap = t.hold || MLT.SPECIAL.buf, h = Math.max(2, u / 12);
        cx.fillStyle = '#0a0e11'; cx.fillRect(x * u + 4, (y + 1) * u - h - 4, u - 8, h);
        cx.fillStyle = t.col; cx.fillRect(x * u + 4, (y + 1) * u - h - 4, (u - 8) * Math.min(1, (b.buf || 0) / cap), h);
        if (b.dry) { cx.strokeStyle = '#ffb454'; cx.lineWidth = 2; cx.strokeRect(x * u + 2, y * u + 2, u - 4, u - 4); if (u >= 24) { cx.fillStyle = '#ffb454'; cx.font = `700 ${Math.min(11, u / 3.2)}px "IBM Plex Sans", sans-serif`; cx.textAlign = 'center'; cx.fillText('dry', (x + 0.5) * u, y * u + Math.min(12, u / 3)); } }
      }
    }
    // A fused mount: a diamond on it, in the colour of what its modifiers make together
    for (const m of L.mods) {
      if (!m.fused) continue;
      const [x0, y0, x1, y1] = box(m), X = (x0 + x1) / 2 * u, Y = (y0 + y1) / 2 * u, r = Math.max(4, u / 5);
      cx.fillStyle = PROPS[m.fused.prop].col; cx.strokeStyle = '#0a0e11'; cx.lineWidth = 2;
      cx.beginPath(); cx.moveTo(X, Y - r); cx.lineTo(X + r, Y); cx.lineTo(X, Y + r); cx.lineTo(X - r, Y); cx.closePath(); cx.fill(); cx.stroke();
    }
    // A gun's properties: a bar for each, filled to its strength
    if (u >= 14) for (const w of L.weapons) {
      const st = MLT.strengths(w), props = propsOf(st); if (!props.length) continue;
      const [x0, y0] = box(w), h = Math.max(3, u / 9), W = Math.max(14, u * 0.55);
      props.forEach((prop, i) => {
        const X = x0 * u + 4, Y = y0 * u + 4 + i * (h + 2);
        cx.fillStyle = '#0a0e11'; cx.fillRect(X, Y, W, h);
        cx.fillStyle = PROPS[prop].col; cx.fillRect(X, Y, W * st[prop], h);
        cx.strokeStyle = PROPS[prop].col; cx.lineWidth = 1; cx.strokeRect(X + 0.5, Y + 0.5, W - 1, h - 1);
      });
    }
  };

  // ================================================================ words
  const chip = (prop, text) => `<b style="color:${PROPS[prop].col}">${esc(text || PROPS[prop].name)}</b>`;
  /** What a gun fires at these strengths, in words */
  function fireWords(w, lv) {
    const t = T[w.type], s = MLT.spec(w.type, lv, 1, TUNE), b = MLT.spec(w.type, {}, 1, TUNE), out = [];
    if (t.beam) out.push(`A beam of ${n0(s.rate * s.damage)} damage a second lit`);
    else out.push(`${n0(s.rate)} shots a second at full rate, ${n0(s.damage * s.splitTotal)} damage${s.shots > 1 ? ` across ${s.shots} at once` : ''}`);
    if (lv.rapid) out.push(`${chip('rapid')}: ${n0(b.rate)} → ${n0(s.rate)} shots a second for the same power`);
    if (lv.velocity) out.push(`${chip('velocity')}: speed +${pc(s.speed / b.speed - 1)}, reach +${pc(s.range / b.range - 1)}`);
    if (lv.split) out.push(`${chip('split')}: ${s.shots} shots sharing ${pc(s.splitTotal)} of one: ${s.shotDmg.map(n0).join(' / ')}`);
    if (lv.explosive) out.push(`${chip('explosive')}: ${pc(s.direct)} direct and ${pc(s.blast)} as a blast of radius ${n0(s.radius)}`);
    if (lv.pierce) out.push(`${chip('pierce')}: through ${s.fracs.length} cells, ${s.fracs.map(pc).join(' / ')}`);
    if (lv.bounce) out.push(`${chip('bounce')}: up to ${s.bounces} bounces, keeping ${pc(s.bounceKeep)} each time`);
    if (lv.chain) out.push(`${chip('chain')}: arcs to up to ${s.jumps} more targets within ${s.chainReach}, each ${pc(s.chainFrac)} of the one before`);
    if (lv.heavy) out.push(`${chip('heavy')}: damage +${pc(s.heavyDamage - 1)}, speed −${pc(1 - s.heavySpeed)}`);
    if (lv.burn) out.push(`${chip('burn')}: ${pc(s.burnTotal)} of each hit again over ${s.burnSecs} seconds`);
    if (lv.hyper) out.push(`${chip('hyper')}: speed ×${s.hyperSpeed.toFixed(1)}, damage −${pc(1 - s.hyperDamage)}`);
    if (lv.wave) out.push(`${chip('wave')}: ${s.width.toFixed(1)}× as wide, ${pc(s.perTarget)} to each thing it crosses`);
    return { text: out.join('. ') + '.', s, b };
  }

  explain = function (p) {
    const out = base.explain(p);
    if (p.dead || !L || !L.mods) return out;
    const t = T[p.type], add = [];
    if (t.mount) {
      const bad = (p.sockets || []).filter((k) => k.block && !k.ok).length;
      if (!p.n) add.push(`${t.mount === 1 ? 'Its socket is' : `All ${t.mount} sockets are`} empty, so it is only a line. Put a modifier against its socket side (Flip moves the sockets to the other side).`);
      else if (p.fused) add.push(`${p.n} of ${t.mount} sockets filled: ${p.fused.parts.map((k) => esc(COMPS[k].name)).join(' and ')} <b>fuse</b> into ${chip(p.fused.prop)}, an effect of its own, and give up ${p.fused.parts.map((k) => chip(COMPS[k].prop)).join(' and ')}. Each socket treats ${t.treat} a second in this mount, so it treats up to <b>${p.treat}</b> a second and burns ${p.n * t.upkeep}.`);
      else add.push(`${p.n} of ${t.mount} ${t.mount === 1 ? 'socket' : 'sockets'} filled with ${chip(COMPS[p.comp].prop, COMPS[p.comp].name)}. Each treats ${t.treat} a second in this mount, so it treats up to <b>${p.treat}</b> a second and burns ${p.n * t.upkeep}.`);
      if (p.n && COMPS[p.comp].needs && p.ready < p.n) add.push(`<b style="color:#ffb454">${p.n - p.ready} of them ${p.n - p.ready === 1 ? 'is' : 'are'} dry</b>, so it treats up to ${p.ready * t.treat} a second now.`);
      if (bad) add.push(`<b style="color:#ff5d5d">${bad} plugged in of another kind</b>: a mount takes one kind, or the kinds of one recipe, so ${bad === 1 ? 'it does' : 'they do'} nothing.`);
      for (const j of p.jobs || []) add.push(j.reach.length ? `${chip(j.prop)}: <b>${n0(j.now || 0)}</b> of ${j.treat} a second in use, shared by ${j.reach.length === 1 ? 'the gun' : `the ${j.reach.length} guns`} its line leads to, by what ${j.reach.length === 1 ? 'it uses' : 'they use'}.`
        : `<b style="color:#ffb454">${chip(j.prop)} reaches no gun.</b> Treatment travels along lines and through joiners and splitters, never through a battery or a capacitor: put the mount after them.`);
    }
    if (t.plug) add.push(!p.host ? 'Not plugged in, so it does nothing. Put it against the socket side of a mount.' : p.bad ? 'Plugged into a mount that already holds another kind it makes no recipe with, so it does nothing.' : p.host.fused ? `Plugged into the ${esc(nameOf(p.host))}, fused with the other kind in it: the guns that mount's line leads to get ${chip(p.host.fused.prop)} and not ${chip(COMPS[t.plug].prop)}.` : `Plugged into the ${esc(nameOf(p.host))}: the guns that mount's line leads to get ${chip(COMPS[t.plug].prop)}.`);
    if (t.special) {
      const nd = COMPS[t.plug].needs;
      if (nd.mat) add.push(`Uses ${MLT.HOPPERS[nd.mat].name.toLowerCase()} from a hopper joined to its input: ${nd.per} for each unit of power it treats. Holding <b>${(p.buf || 0).toFixed(1)}</b> of ${MLT.SPECIAL.buf}.${p.host && p.dry ? ` <b style="color:#ffb454">Dry: ${p.feedNet && p.feedNet.tanks.length ? 'the hopper is empty or holds something else. Hoppers are loaded at a station (Dock)' : 'no hopper is joined to its input'}.</b>` : ''}`);
      else add.push(`Needs a power line of its own into its input: it burns ${nd.per} for each unit of power it treats.${p.host && p.dry ? ' <b style="color:#ffb454">Dry: no power is reaching its input.</b>' : ''}`);
    }
    if (t.hopper) add.push('Loaded at a station only: <b>Dock</b> refills every hopper. Charge all does not.');
    if (t.kind === 'store' && !t.special) {
      const m = MLT.mix(p), props = propsOf(m), lim = TUNE.lines[p.tier];
      if (lim) add.push(`Tier ${p.tier} line part: carries up to <b>${lim.fx} effects</b> and <b>${lim.cap}</b> treated power a second (counted once for each effect).`);
      else if (!t.mount && !MLT.carries(p)) add.push('Treatment does not pass through it: a mount before it reaches no gun.');
      if (props.length) add.push(`Carrying to the guns after it: ${props.map((prop) => `${chip(prop)} ${pc(m[prop])}`).join(', ')}.`);
      if (p.fxDrop) add.push(`<b style="color:#ffb454">Full: it drops ${p.fxDrop.map((q) => chip(q)).join(' and ')}.</b> A higher tier carries more effects.`);
      if (p.fxOver) add.push(`<b style="color:#ffb454">Over what it carries: ${n0(p.fxOver)} of treated power asked through it, ${lim.cap} carried.</b> Every effect through it is cut to fit.`);
    }
    if (t.kind === 'weapon') {
      const lv = MLT.strengths(p), props = propsOf(p.share || {});
      if (!props.length) add.push(MLT.upstream(p).length ? 'Modifiers sit in its lines, but nothing of theirs reaches it: a battery or capacitor is in between, or a line part dropped it.' : 'No modifier in its lines: it fires plain.');
      else {
        add.push(`Of the power it uses (${n0(p.load || 0)} a second): ${props.map((prop) => `${chip(prop)} ${pc(p.share[prop])} treated`).join('; ')}. Each effect is that share of its full strength.`);
        add.push(fireWords(p, lv).text);
      }
    }
    out.splice(t.say ? 1 : 0, 0, ...add);
    return out;
  };

  // ================================================================ what the guns fire
  let rangeGun = null;
  const fireEl = document.getElementById('fire');
  function renderFire() {
    if (!L || !L.mods) return;
    const cost = (ps) => ps.reduce((s, p) => s + (T[p.type].cost || 0), 0);
    const guns = cost(L.weapons), mods = cost(L.mounts) + cost(L.blocks), all = cost(L.alive), burn = L.mounts.reduce((s, m) => s + (m.burnNow || 0), 0);
    let html = `<p class="sub" style="margin:0 0 4px">Ship cost ${Math.round(all)}: guns ${Math.round(guns)}, modifiers ${Math.round(mods)}, everything else ${Math.round(all - guns - mods)}.${L.blocks.length ? ` Modifiers burn ${n0(burn)} a second.` : ''}</p>`;
    const loose = L.blocks.filter((b) => !b.host).length, wrong = L.blocks.filter((b) => b.bad).length;
    if (loose) html += `<p class="why" style="color:#ffb454">${loose} ${loose === 1 ? 'modifier is' : 'modifiers are'} not plugged into a mount.</p>`;
    if (wrong) html += `<p class="why" style="color:#ff5d5d">${wrong} ${wrong === 1 ? 'modifier sits' : 'modifiers sit'} in a mount holding another kind.</p>`;
    const dry = L.blocks.filter((b) => b.host && !b.bad && b.dry).length, hop = {};
    if (dry) html += `<p class="why" style="color:#ffb454">${dry} special ${dry === 1 ? 'modifier is' : 'modifiers are'} dry: nothing is reaching ${dry === 1 ? 'its' : 'their'} input.</p>`;
    for (const k of L.tanks) { const t = T[k.type]; if (t.hopper) { (hop[t.fluid] ??= [0, 0])[0] += k.fill; hop[t.fluid][1] += t.fill; } }
    if (Object.keys(hop).length) html += `<p class="sub" style="margin:0 0 4px">Hoppers: ${Object.entries(hop).map(([m, [a, b]]) => `<b style="color:${MLT.HOPPERS[m].col}">${esc(MLT.HOPPERS[m].name)}</b> ${n0(a)} of ${b}`).join(', ')}. Loaded at a station only.</p>`;
    const full = L.stores.filter((q) => q.fxDrop || q.fxOver);
    for (const q of full) html += `<p class="why" style="color:#ffb454">${esc(T[q.type].name)}: ${q.fxDrop ? `carries ${TUNE.lines[q.tier].fx} effects, so it drops ${q.fxDrop.map((k) => PROPS[k].name).join(' and ')}` : `carries ${TUNE.lines[q.tier].cap} treated power a second, ${n0(q.fxOver)} asked`}.</p>`;
    const seen = {};
    for (const w of L.weapons) {
      const t = T[w.type], lv = MLT.strengths(w), props = propsOf(w.share || {}), f = fireWords(w, lv), up = MLT.upstream(w);
      const k = (seen[w.type] = (seen[w.type] || 0) + 1), many = L.weapons.filter((q) => q.type === w.type).length > 1;
      const rows = props.map((prop) => `<div class="pr"><span style="color:${PROPS[prop].col}">${PROPS[prop].name}</span>
        <div class="ptrack"><i style="width:${(w.share[prop] * 100).toFixed(1)}%;background:${PROPS[prop].col}"></i></div>
        <span class="plv">${pc(w.share[prop])}</span></div>`).join('');
      const dps = Math.abs(f.s.dps - f.b.dps) > 0.05 ? `${n0(f.b.dps)} → ${n0(f.s.dps)}` : n0(f.b.dps);
      html += `<div class="gun${(selected || rangeGun) === w ? ' sel' : ''}" data-uid="${w.uid}">
        <div class="gh"><span><b>${esc(t.name)}</b>${many ? ` <span class="sub">${k}</span>` : ''} <span class="sub">${w.links.length ? `firing at ${pc(Math.min(1, w.rate))} rate` : 'no feed'}</span></span><span class="val" title="Damage a second on one target at full rate: plain, then with its modifiers">${dps} dps</span></div>
        ${rows}<p class="why">${props.length ? f.text : up.length ? 'Nothing from the modifiers in its lines reaches it.' : 'Plain: no modifier in its lines.'}
        ${up.length ? ` Gun ${Math.round(t.cost)}, mounts and modifiers behind it ${Math.round(up.reduce((a, m) => a + MLT.costOf(m), 0))}${up.some((m) => MLT.upstream && L.weapons.some((q) => q !== w && MLT.upstream(q).includes(m))) ? ' (shared)' : ''}.` : ` Gun ${Math.round(t.cost)}.`}</p></div>`;
    }
    fireEl.innerHTML = L.weapons.length ? html : '<p class="note">No weapons.</p>';
  }
  fireEl.addEventListener('click', (e) => { const el = e.target.closest('[data-uid]'); if (!el) return; const w = L.weapons.find((q) => q.uid === +el.dataset.uid); if (w) { selected = w; renderCard(); renderFire(); } });

  // ================================================================ the firing range
  const range = MLR.create(document.getElementById('range'));
  let rangeKey = '', rangeRate = -1;
  const sustained = {};
  function renderRange() {
    if (!L || !L.mods) return;
    if (selected && !selected.dead && T[selected.type].kind === 'weapon') rangeGun = selected;
    if (!rangeGun || rangeGun.dead || !L.weapons.includes(rangeGun)) rangeGun = L.weapons[0] || null;
    const nameEl = document.getElementById('rangegun'), info = document.getElementById('rangeinfo');
    if (!rangeGun) { nameEl.textContent = 'no gun'; info.textContent = ''; if (rangeKey) { range.setShot(null); rangeKey = ''; } return; }
    const w = rangeGun, lv = MLT.strengths(w), props = propsOf(lv), colour = props.length ? PROPS[props[0]].col : PLAIN;
    // The range fires at the rate the gun's lines keep up on the grid, as last measured with the grid's Fire on. It
    // follows that rate in steps, and never restarts the range for a change of rate, so the shots stay evenly spaced.
    if (firingNow()) sustained[w.uid] = w.links.length ? Math.min(1, w.rate) : 0;
    const want = !w.links.length ? 0 : sustained[w.uid] === undefined ? 1 : sustained[w.uid] < 0.03 ? 0 : sustained[w.uid];
    // (The range follows the strengths in steps of a twentieth, so a share that wanders a little doesn't restart it)
    const key = `${w.uid}|${w.type}`, lkey = JSON.stringify(Object.fromEntries(props.map((q) => [q, Math.round(lv[q] * 20)])));
    const moved = rangeRate < 0 || Math.abs(want - rangeRate) > 0.06 || (want === 0) !== (rangeRate === 0);
    if (key + lkey !== rangeKey || moved) {
      const fresh = !rangeKey.startsWith(key + '{'), rate = moved || fresh ? want : rangeRate;
      const spec = MLT.spec(w.type, lv, rate, TUNE);
      if (fresh) range.setShot(spec, colour); else range.setSpec(spec, colour, key + lkey !== rangeKey);
      rangeKey = key + lkey; rangeRate = rate;
    }
    nameEl.textContent = T[w.type].name + (props.length ? ': ' + props.map((p) => `${PROPS[p].name} ${pc(lv[p])}`).join(', ') : ', plain');
    info.textContent = rangeRate > 0 ? `${pc(rangeRate)} of full rate · landing ${n0(range.measured())} damage a second` : w.links.length ? 'starved: no power is reaching it' : 'no feed';
  }

  renderLists = function () { base.renderLists(); renderFire(); renderRange(); };
  renderPalette = function () {
    base.renderPalette();
    // (Modifiers first in the bin: they are what this lab is about)
    const el = document.getElementById('palette'), cat = el.querySelectorAll('details.cat')[MLT.MOD_CAT];
    if (cat) { cat.open = true; el.prepend(cat); }
  };


  // The range's trigger: hold left click on it, or leave it firing
  const AUTO_KEY = 'modlab-ports-auto-v1', optAuto = document.getElementById('optAuto');
  try { optAuto.checked = localStorage.getItem(AUTO_KEY) === '1'; } catch (e) { /* no storage */ }
  range.setManual(!optAuto.checked);
  optAuto.addEventListener('change', () => { range.setManual(!optAuto.checked); try { localStorage.setItem(AUTO_KEY, optAuto.checked ? '1' : '0'); } catch (e) { /* no storage */ } });

  // ================================================================ undo (every saved change to the layout)
  const layout = () => JSON.stringify({ g: [GW, GH], n: shipName, a: about, p: parts.map((p) => [p.type, Math.min(...p.cells.map((c) => c[0])), Math.min(...p.cells.map((c) => c[1])), p.rot, p.flip]) });
  const undoStack = [], undoBtn = document.getElementById('tUndo');
  let lastLayout = null;
  save = function () {
    const cur = layout();
    if (lastLayout !== null && cur !== lastLayout) { undoStack.push(lastLayout); if (undoStack.length > 80) undoStack.shift(); }
    lastLayout = cur; undoBtn.disabled = !undoStack.length; base.save();
  };
  function undo() {
    const s = undoStack.pop(); if (!s) return;
    const d = JSON.parse(s);
    [GW, GH] = d.g; shipName = d.n; about = d.a; parts = []; selected = null; base.rebuild();
    for (const [type, x, y, r, f] of d.p) if (T[type]) addPart(type, x, y, r, f);
    rebuild(); lastLayout = s; undoBtn.disabled = !undoStack.length; base.save(); sizeCanvas(); renderCard(); renderAbout();
  }
  undoBtn.addEventListener('click', undo);
  window.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.target.matches('input, textarea, select')) { e.preventDefault(); undo(); } });

  // The page loaded its design before this file ran: link it, and show the modifier bin
  rebuild(); lastLayout = layout(); undoBtn.disabled = true; renderPalette(); setTool(tool); renderCard(); renderFire(); renderRange();
})();
