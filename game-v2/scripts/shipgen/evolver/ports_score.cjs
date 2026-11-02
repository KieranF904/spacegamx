// Scores ships under the ports rules (docs/design/energy-ports-2026-11.md) with the lab's own model
// (prototypes/energy-lab/ports-model.js), so the evolver and the lab can never disagree. Kept open by ports_evolve.py:
// one JSON request a line on stdin, one answer a line on stdout.
//   {"cmd": "catalogue"}                      -> {"T": {id: part}}
//   {"id", "w", "h", "parts": [[type, x, y, rot, flip], ...], "scenario"}  -> the measures below
// A ship enters the fight charged. Power phase: power_s seconds with the guns on the scenario's firing pattern and the
// engines on, no hits: damage a second (after the enemy's armour), thrust, what's wasted, which conduits carry power.
// Hit runs: the same, with hits from the scenario's directions until the core goes (blasts and chains as the lab's Break).
// Effects: a shot's value is its impact after the enemy's armour (its pen plus its feed's), plus its burn, splash and
// mark as the scenario values them (effects: {burn, splash, mark}); its slow and disrupt build up a suppression that
// stretches the time between incoming hits (at most 60% fewer), fading over 4 s.
// Feed wiring: for every Combiner or feed gun whose feed network holds nothing, the share of the shortest path from its
// feed point to a tank built with pipes (or Passthroughs). Feed used: what the power phase took from the tanks.
// Wiring: for every consumer in port that isn't fed, the shortest path (through empty cells, hull, armour and conduits)
// from it to a power giver's out port; a conduit on such a path that points the right way counts half a cell, a whole
// one when power already reaches it, and the port scores the share of its path built (at most 1). Live conduits: conduits still carrying power at the end of the power phase (a dead end fills up
// and stops, so it doesn't count).
'use strict';
const path = require('path');
const readline = require('readline');
const PM = require(path.join(__dirname, '../../../prototypes/energy-lab/ports-model.js'));
const { T, SIDE_V, OPP } = PM;
const DT = 1 / 20;
const PEN = { 0: 1, 1: 1.15, '-4': 0.05, '-3': 0.1, '-2': 0.25, '-1': 0.55 };
function penMul(gap) {
  if (gap <= -4) return PEN['-4'];
  if (gap >= 1) return PEN[1];
  const lo = Math.floor(gap), hi = Math.ceil(gap), a = PEN[lo] ?? 1, b = PEN[hi] ?? 1;
  return lo === hi ? a : a + (b - a) * (gap - lo);
}
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

function makeShip(req) {
  let uid = 1;
  return req.parts.map(([type, x, y, rot, flip]) => ({ uid: uid++, type, rot: rot || 0, flip: !!flip, cells: PM.rectCells(type, x, y, rot || 0) }));
}
function charge(parts) {
  for (const p of parts) {
    const t = T[p.type]; p.dead = false; p.hp = t.hp; p.cd = 0; p.on = false; p.latched = false; p.flash = 0; p.emaIn = p.emaOut = p.emaWaste = p.emaD = 0;
    p.flav = {}; p.closed = 0; p.frozen = 0; p.collapsed = 0; p.fx = null;
    if (t.kind === 'tank') p.fill = t.fill;
    if (t.kind === 'store') p.held = t.conduit ? 0 : t.hold; else if (t.kind === 'weapon') p.stored = PM.capOf(t); else if (t.kind === 'engine') p.stored = t.buffer; else if (t.kind === 'util') p.stored = t.e;
  }
}
/** Guns with any of the ship in front of them (towards the nose), engines with any behind: they do nothing */
function blockedSet(parts, occ, W, H) {
  const out = new Set();
  for (const p of parts) {
    const k = T[p.type].kind;
    if (k !== 'weapon' && k !== 'engine') continue;
    const cols = new Map();
    for (const [x, y] of p.cells) { const c = cols.get(x); cols.set(x, c === undefined ? y : k === 'weapon' ? Math.min(c, y) : Math.max(c, y)); }
    for (const [x, y] of cols) {
      if (k === 'weapon') { for (let yy = 0; yy < y; yy++) if (occ[yy * W + x] && occ[yy * W + x] !== p) { out.add(p); break; } }
      else for (let yy = y + 1; yy < H; yy++) if (occ[yy * W + x] && occ[yy * W + x] !== p) { out.add(p); break; }
    }
  }
  return out;
}
/** What a shot this tick is worth, and what it does to the enemy's fire (suppression) */
function shotValue(w, sc, armour) {
  const t = T[w.type], fx = w.fx || { pen: 0 }, d = w.dNow, E = sc.effects || {};
  const v = d * penMul(t.pen + (fx.pen || 0) - armour) + d * ((fx.burn || 0) * (E.burn ?? 0.5) + (fx.splash || 0) * (E.splash ?? 0.4) + (fx.mark || 0) * (E.mark ?? 0.3));
  const sup = ((fx.slow || 0) * (E.slow ?? 0.6) + (fx.disrupt || 0) * (E.disrupt ?? 0.6)) * Math.min(1, d / 40);
  return { v, sup, fx: !!(fx.burn || fx.splash || fx.mark || fx.slow || fx.disrupt || fx.pen) };
}
const stockOf = (L) => L.tanks.reduce((s, t) => s + t.fill, 0);
const firing = (sc, t) => { const f = sc.fire; if (!f || !f.off) return true; return t % (f.on + f.off) < f.on; };

/** The power phase: averages over power_s seconds (charged at the start) */
function powerPhase(parts, req, sc, blocked) {
  const L = PM.build(parts, req.w, req.h), secs = sc.power_s || 30, n = Math.round(secs / DT), armour = sc.enemy_armour ?? 0;
  const flowLate = new Map(), got = new Map(), flowAll = new Map();
  let dealt = 0, thrust = 0, wasted = 0, fxDealt = 0;
  const stock0 = stockOf(L);
  for (let i = 0; i < n; i++) {
    const t = i * DT, F = PM.tick(L, { fire: firing(sc, t), thrust: true, util: true }, i, DT);
    for (const w of L.weapons) if (w.dNow && !blocked.has(w)) { const sv = shotValue(w, sc, armour); dealt += sv.v; if (sv.fx) fxDealt += sv.v; }
    for (const e of L.engines) if (!blocked.has(e)) thrust += e.thrustNow * DT;
    wasted += F.wasted * DT;
    for (const s of L.stores) flowAll.set(s, (flowAll.get(s) || 0) + s.inNow + s.outNow);
    if (i >= n / 2) {
      for (const s of L.stores) if (T[s.type].conduit) flowLate.set(s, (flowLate.get(s) || 0) + s.inNow);
      for (const c of L.consumers) got.set(c, (got.get(c) || 0) + c.inNow / (secs / 2));
    }
  }
  const live = [...flowLate.values()].filter((v) => v / (secs / 2) > 0.5).length;
  // (Stores that power reached: a generator feeds them, directly or down a line)
  const powered = new Set(L.stores.filter((s) => !T[s.type].conduit && s.emaIn > 0.5));
  const reached = new Set(L.stores.filter((s) => T[s.type].conduit && s.emaIn + s.held > 0.01 && (flowLate.get(s) || 0) + s.held > 0.01));
  // (Idle: parts doing nothing over the power phase. A store or line nothing passed through; a generator whose every
  // line is wasted; a pipe or tank on a feed network without both a tank and something that uses it)
  let idle = 0;
  for (const s of L.stores) if (T[s.type].id !== 'core' && (flowAll.get(s) || 0) / secs < 0.5) idle++;
  for (const g of L.gens) if (g.emaWaste >= T[g.type].produce - 0.5) idle++;
  for (const nn of L.feedNets) {
    if (!nn.tanks.length || !nn.users.length) { idle += nn.parts.filter((q) => T[q.type].kind === 'pipe' || T[q.type].kind === 'tank').length; continue; }
    // (A pipe earns its place only on a shortest path, through the network, from a user to its nearest tank: the rest is filler)
    const nb = (q) => q.feeds.map((f) => f.joined).filter((r) => r && r.feedNet === nn);
    const distFrom = (starts) => { const d = new Map(); const qu = []; for (const s0 of starts) { d.set(s0, 0); qu.push(s0); } for (let i = 0; i < qu.length; i++) for (const r of nb(qu[i])) if (!d.has(r)) { d.set(r, d.get(qu[i]) + 1); qu.push(r); } return d; };
    const dT = distFrom(nn.tanks), useful = new Set();
    for (const u of nn.users) {
      const dU = distFrom([u]), D = dT.get(u);
      if (D === undefined) continue;
      for (const q of nn.parts) if (dU.has(q) && dT.has(q) && dU.get(q) + dT.get(q) === D) useful.add(q);
    }
    idle += nn.parts.filter((q) => T[q.type].kind === 'pipe' && !useful.has(q)).length;
  }
  return { L, dps: dealt / secs, thrust: thrust / secs, wasted: wasted / secs, live, reached, powered, got, fxShare: dealt ? fxDealt / dealt : 0, feedUsed: stock0 - stockOf(L), idle };
}

/** Shortest-path credit for pipes towards each Combiner or feed gun whose network holds no feed */
function feedWiring(L) {
  const { GW: W, GH: H, occ } = L, key = (x, y) => y * W + x;
  const passable = (x, y) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return false; const q = occ[key(x, y)]; if (!q) return true; const t = T[q.type];
    return t.kind === 'inert' || t.kind === 'pipe' || t.id === 'passthrough' || t.id === 'conduit';
  };
  const goal = [];
  for (const tk of L.tanks) if (tk.fill > 1) for (const q of tk.feeds) if (passable(q.nx, q.ny)) goal.push([q.nx, q.ny]);
  // (Every Combiner and feed gun counts: one with feed on its network scores 1, one without the share of its path to a
  // tank built with pipes (at most 0.9); the measure is the mean, 0 when the ship has none)
  const all = L.alive.filter((p) => T[p.type].combiner || T[p.type].feedPort);
  const users = all.filter((p) => !(p.feedNet && p.feedNet.tanks.some((k) => k.fill > 1)));
  const fedN = all.length - users.length;
  if (!all.length) return { credit: 0, users: 0 };
  if (!users.length || !goal.length) return { credit: fedN / all.length, users: users.length };
  const bfs = (starts) => {
    const d = new Int32Array(W * H).fill(-1), qx = [], qy = [];
    for (const [x, y] of starts) if (d[key(x, y)] < 0) { d[key(x, y)] = 0; qx.push(x); qy.push(y); }
    for (let i = 0; i < qx.length; i++) {
      const x = qx[i], y = qy[i], v = d[key(x, y)];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x + dx, ny = y + dy; if (passable(nx, ny) && d[key(nx, ny)] < 0) { d[key(nx, ny)] = v + 1; qx.push(nx); qy.push(ny); } }
    }
    return d;
  };
  const dS = bfs(goal);
  let credit = fedN;
  for (const u of users) for (const q of u.feeds) {
    if (!passable(q.nx, q.ny)) continue;
    const D = dS[key(q.nx, q.ny)]; if (D < 0) continue;
    const dG = bfs([[q.nx, q.ny]]);
    let got = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const k = key(x, y), c = occ[k]; if (!c || dS[k] < 0 || dG[k] < 0 || dS[k] + dG[k] !== D) continue;
      if (T[c.type].kind === 'pipe' || c.type === 'passthrough') got++;
    }
    credit += 0.9 * Math.min(1, got / (D + 1));
  }
  return { credit: credit / all.length, users: users.length };
}

/** Shortest-path credit for conduits towards each consumer in port that isn't fed */
function wiring(L, reached, powered, fedOf) {
  const { GW: W, GH: H, occ } = L, key = (x, y) => y * W + x;
  const passable = (x, y) => { if (x < 0 || y < 0 || x >= W || y >= H) return false; const q = occ[key(x, y)]; if (!q) return true; const t = T[q.type]; return t.kind === 'inert' || !!t.conduit; };
  // Goals: cells across the out port of a generator, or of a store that power reaches, that a conduit could take from
  const goal = [];
  for (const p of L.alive) {
    const t = T[p.type];
    if (!(t.kind === 'gen' || (t.kind === 'store' && !t.conduit && powered.has(p)))) continue;
    for (const q of p.ports) if (q.dir === 'out' && passable(q.nx, q.ny)) goal.push({ x: q.nx, y: q.ny, from: [q.x, q.y] });
  }
  // (Every consumer in port counts: a fed one (linked, its part getting a quarter of what it wants) scores 1, an unfed one
  // the share of its path built (at most 0.9), so finishing a line always beats leaving it; the measure is the mean)
  const allPorts = L.consumers.reduce((s, p) => s + p.ports.filter((q) => q.dir === 'in').length, 0);
  let fedPorts = 0;
  for (const p of L.consumers) for (const q of p.ports) if (q.dir === 'in' && q.link && fedOf(p) >= 0.25) fedPorts++;
  if (!goal.length) return { credit: allPorts ? fedPorts / allPorts : 0, ports: 0 };
  const bfs = (starts) => {
    const d = new Int32Array(W * H).fill(-1), qx = [], qy = [];
    for (const [x, y] of starts) if (d[key(x, y)] < 0) { d[key(x, y)] = 0; qx.push(x); qy.push(y); }
    for (let i = 0; i < qx.length; i++) {
      const x = qx[i], y = qy[i], v = d[key(x, y)];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x + dx, ny = y + dy; if (passable(nx, ny) && d[key(nx, ny)] < 0) { d[key(nx, ny)] = v + 1; qx.push(nx); qy.push(ny); } }
    }
    return d;
  };
  const dS = bfs(goal.map((g) => [g.x, g.y]));
  const goalFrom = new Map(); for (const g of goal) { const k = key(g.x, g.y); if (!goalFrom.has(k)) goalFrom.set(k, []); goalFrom.get(k).push(g.from); }
  let credit = fedPorts, ports = 0;
  for (const p of L.consumers) for (const q of p.ports) {
    if (q.dir !== 'in' || (q.link && fedOf(p) >= 0.25) || !passable(q.nx, q.ny)) continue;
    const D = dS[key(q.nx, q.ny)]; if (D < 0) continue;
    ports++;
    const dG = bfs([[q.nx, q.ny]]);
    let got = 0;
    for (const c of L.stores) {
      if (!T[c.type].conduit) continue;
      const [cx, cy] = c.cells[0], kc = key(cx, cy);
      if (dS[kc] < 0 || dG[kc] < 0 || dS[kc] + dG[kc] !== D) continue;
      const pin = c.ports.find((r) => r.dir === 'in'), pout = c.ports.find((r) => r.dir === 'out');
      const inOk = dS[kc] === 0 ? (goalFrom.get(kc) || []).some(([fx, fy]) => fx === pin.nx && fy === pin.ny) : passable(pin.nx, pin.ny) && dS[key(pin.nx, pin.ny)] === dS[kc] - 1;
      const outOk = dG[kc] === 0 ? pout.nx === q.x && pout.ny === q.y : passable(pout.nx, pout.ny) && dG[key(pout.nx, pout.ny)] === dG[kc] - 1;
      if (inOk && outOk) got += reached.has(c) ? 2 : 1;
    }
    // (A port is worth at most 1: the share of its D + 1 cells of path built, a cell counting fully once power reaches it)
    credit += 0.9 * Math.min(1, got / (2 * (D + 1)));
  }
  return { credit: allPorts ? credit / allPorts : 0, ports };
}

/** One hit run: hits until the core goes (or max_s), the power ticking all the while */
function hitRun(parts, req, sc, blocked0, seed, base) {
  charge(parts);
  const inc = sc.incoming || {}, r = rng(seed * 7919 + 13), armour = sc.enemy_armour ?? 0;
  const dmg = inc.damage ?? 40, pen = inc.pen ?? 2, every = dmg / (inc.dps ?? 120), maxS = inc.max_s ?? 120;
  let L = PM.build(parts, req.w, req.h), blocked = blocked0;
  const cells = parts.flatMap((p) => p.cells), cy = cells.reduce((s, c) => s + c[1] + 0.5, 0) / cells.length, cx = cells.reduce((s, c) => s + c[0] + 0.5, 0) / cells.length;
  const reach = Math.max(...cells.map(([x, y]) => Math.hypot(x + 0.5 - cx, y + 0.5 - cy))) + 2;
  const shares = () => {
    let w = 0, th = 0, g = 0;
    for (const p of L.weapons) if (!blocked.has(p) && p.links.length) w += PM.fullDps(T[p.type]) * penMul(T[p.type].pen - armour);
    for (const p of L.engines) if (!blocked.has(p) && p.links.length) th += T[p.type].thrust;
    for (const p of L.gens) g += T[p.type].produce;
    // (A ship without guns, engines or generators keeps none of them: 0, not left out, or shedding guns would score)
    return [base.w ? w / base.w : 0, base.th ? th / base.th : 0, base.g ? g / base.g : 0];
  };
  let cur = shares(), t = 0, dealt = 0, kept = 0, half = null, next = every, i = 0, coreDead = false, sup = 0;
  const dirOf = (from, spread) => {
    const a0 = { front: -Math.PI / 2, rear: Math.PI / 2, left: Math.PI, right: 0 }[from];
    const a = from === 'all' || a0 === undefined ? r() * Math.PI * 2 : a0 + (r() - 0.5) * (spread * Math.PI / 180);
    // (The direction the shot travels: from the front means travelling towards the stern)
    return [-Math.cos(a), -Math.sin(a)];
  };
  while (t < maxS && !coreDead) {
    PM.tick(L, { fire: firing(sc, t), thrust: true, util: true }, i++, DT);
    sup *= Math.exp(-DT / 4);
    for (const w of L.weapons) if (w.dNow && !blocked.has(w)) { const sv = shotValue(w, sc, armour); dealt += sv.v; sup += sv.sup; }
    // (Firepower counts most: 60%, thrust and generation 20% each)
    kept += DT * (0.6 * cur[0] + 0.2 * cur[1] + 0.2 * cur[2]);
    t += DT;
    let changed = false;
    while (t >= next && !coreDead) {
      next += every / (1 - Math.min(0.6, sup));
      const from = r() < (inc.flank ?? 0) ? 'all' : inc.from ?? 'all';
      const [dx, dy] = dirOf(from, inc.spread ?? 45), off = (r() * 2 - 1) * reach;
      let x = cx - dx * reach - dy * off, y = cy - dy * reach + dx * off, hit = null;
      for (let k = 0; k < (reach * 2) / 0.4 + 2; k++) {
        const gx = Math.floor(x), gy = Math.floor(y);
        if (gx >= 0 && gy >= 0 && gx < req.w && gy < req.h) { const q = L.occ[gy * req.w + gx]; if (q && !q.dead) { hit = q; break; } }
        x += dx * 0.4; y += dy * 0.4;
      }
      if (!hit) continue;
      const ht = T[hit.type];
      hit.hp -= dmg * penMul(pen - ht.armour);
      if (hit.hp <= 0) { const gone = PM.destroy(L, hit); changed = true; if (gone.some((g) => g.part.type === 'core')) coreDead = true; }
    }
    if (changed && !coreDead) {
      L = PM.build(parts, req.w, req.h);
      blocked = new Set([...blocked0].filter((p) => !p.dead));
      cur = shares();
      if (half === null && cur[0] !== null && cur[0] < 0.5) half = t;
    }
  }
  return { alive_s: t, half_s: half ?? t, dealt, kept };
}

function measure(req) {
  const sc = req.scenario || {}, parts = makeShip(req);
  charge(parts);
  const L0 = PM.build(parts, req.w, req.h), blocked = blockedSet(parts, L0.occ, req.w, req.h);
  const mass = parts.reduce((s, p) => s + T[p.type].mass, 0);
  const pw = powerPhase(parts, req, sc, blocked);
  const fedOf = (p) => { const t = T[p.type]; return Math.min(1, (pw.got.get(p) || 0) / Math.max(1e-9, t.kind === 'weapon' ? t.intake : t.kind === 'engine' ? Math.min(t.intake, t.burn) : t.e)); };
  const wire = wiring(pw.L, pw.reached, pw.powered, fedOf), fw = feedWiring(L0);
  // (Engines near the back: thrust-weighted, zones of 3 rows up from the ship's last row)
  const last = Math.max(...parts.flatMap((p) => p.cells.map((c) => c[1])));
  let zw = 0, zt = 0;
  for (const e of L0.engines) if (!blocked.has(e)) { const b = Math.max(...e.cells.map((c) => c[1])); zw += T[e.type].thrust * Math.max(0, 1 - 0.25 * Math.floor((last - b) / 3)); zt += T[e.type].thrust; }
  const unfed = L0.consumers.filter((p) => !p.links.length).length, armour = sc.enemy_armour ?? 0;
  const base = { w: L0.weapons.filter((p) => !blocked.has(p) && p.links.length).reduce((s, p) => s + PM.fullDps(T[p.type]) * penMul(T[p.type].pen - armour), 0),
    th: L0.engines.filter((p) => !blocked.has(p) && p.links.length).reduce((s, p) => s + T[p.type].thrust, 0), g: L0.gens.reduce((s, p) => s + T[p.type].produce, 0) };
  const runs = (sc.seeds || [1, 2]).map((seed) => hitRun(parts, req, sc, blocked, seed, base));
  const avg = (k) => runs.reduce((s, x) => s + x[k], 0) / runs.length;
  // Open ports on the intact ship, for the evolver's aimed changes
  const open = [];
  for (const p of L0.alive) for (const q of p.ports) if (!q.link) open.push([q.dir, T[p.type].kind, T[p.type].conduit ? 1 : 0, q.x, q.y, q.nx, q.ny, q.side]);
  // (Feed points joined to nothing: where a pipe or tank could go)
  const openFeed = [];
  for (const p of L0.alive) for (const q of p.feeds) if (!q.joined) openFeed.push([T[p.type].kind, q.x, q.y, q.nx, q.ny, q.side]);
  // (Consumers under a quarter of what they want over the second half of the power phase: a dead line feeds nothing)
  const fedShare = {};
  for (const p of pw.L.consumers) { const t = T[p.type]; fedShare[p.uid - 1] = Math.min(1, (pw.got.get(p) || 0) / Math.max(1e-9, t.kind === 'weapon' ? t.intake : t.kind === 'engine' ? Math.min(t.intake, t.burn) : t.e)); }
  const unpowered = Object.values(fedShare).filter((v) => v < 0.25).length;
  // (Diagnostics for the meta: the share of guns' power links that come straight from a generator, and how many guns
  // sit within 1.5 cells of a generator or charged store, where its blast reaches them)
  const gunLinks = L0.weapons.flatMap((w) => w.inL);
  const direct = gunLinks.length ? gunLinks.filter((l) => T[l.from.type].kind === 'gen').length / gunLinks.length : 0;
  const nearBlast = L0.weapons.filter((w) => L0.alive.some((q) => q !== w && (T[q.type].kind === 'gen' || (T[q.type].kind === 'store' && !T[q.type].conduit && q.type !== 'core')) && Math.hypot(q.cx - w.cx, q.cy - w.cy) < 1.6)).length;
  return {
    id: req.id, sustained_dps: pw.dps, thrust: pw.thrust, thrust_to_mass: mass ? pw.thrust / mass : 0, mass, wasted: pw.wasted,
    damage_before_down: avg('dealt'), alive_s: avg('alive_s'), half_s: avg('half_s'), systems_kept: avg('kept'),
    wiring: wire.credit, open_in: wire.ports, live_conduits: pw.live, unfed, unpowered, feed_wiring: fw.credit, feed_users: fw.users, idle: pw.idle, direct_share: direct, guns_near_blast: nearBlast, guns: L0.weapons.length, feed_used: pw.feedUsed, fx_share: pw.fxShare, open_feed: openFeed, blocked: blocked.size, blocked_ids: [...blocked].map((p) => p.uid - 1),
    engines_working: L0.engines.filter((e) => !blocked.has(e) && e.links.length).length, engine_zone: zt ? zw / zt : 0,
    no_engines: L0.engines.some((e) => !blocked.has(e) && e.links.length) ? 0 : 1, clashes: L0.clashes.length, open, fed: fedShare,
  };
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  try {
    if (req.cmd === 'catalogue') process.stdout.write(JSON.stringify({ T }) + '\n');
    else process.stdout.write(JSON.stringify(measure(req)) + '\n');
  } catch (e) { process.stdout.write(JSON.stringify({ id: req.id, error: String(e && e.stack || e) }) + '\n'); }
});
process.stdout.write(JSON.stringify({ ready: true }) + '\n');
