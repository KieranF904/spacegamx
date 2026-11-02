#!/usr/bin/env node
// Weapons in scenarios (docs/design/energy-ports-2026-11.md section 17): how each gun does, on the ports power core,
// against the situations a fight throws up, rather than one number a cell.
//
// For every powered gun it builds rigs of real parts round it (each main input fed by a Cell Reactor, a Battery on a
// reactor, an Overclock Reactor, a Fusion Plant, or Surge Cells on a Fusion Plant; each augment input by none, a Battery,
// an Overclock or a Fusion Plant), runs 70 s of fire through the game's own ports core and guns step (the first 10 s to
// spend its starting charge), and keeps for each gun its cheapest base build and its cheapest augmented build. Then it
// works out, from the gun's own numbers (damage, penetration against armour, splash, chain, pierce, burning, spread,
// shell speed and reach), how long each build takes in six scenarios, alone and as a loadout: as many copies as fit in a
// budget of cells (a cheap gun gets several, a heavy one one or two).
//
//   npm run build:common && node scripts/balance/weapon-scenarios.mjs [--md out.md] [--budget 16] [--points 40] [--only id,id]
//
// A loadout's copies are capped by cells and by build points (grades.ts buildPoints: a Mk IV gun or a steel Fusion Plant
// costs far more a cell than an alloy Pip and Cell Reactor), so cheap guns get more of themselves.
//
// The scenario model is deliberately simple and written out below; it ranks, it doesn't predict a real fight.

import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const C = await import(pathToFileURL(join(ROOT, 'common/dist/index.js')).href);
const SD = join(ROOT, 'data/ships');
const rd = (f) => JSON.parse(readFileSync(join(SD, f), 'utf8'));
const catalog = C.loadCatalog({ pieces: rd('pieces.json'), functions: rd('functions.json'), materials: rd('materials.json'), models: rd('models.json'),
  bespoke: existsSync(join(SD, 'bespoke')) ? readdirSync(join(SD, 'bespoke')).filter((f) => f.endsWith('.json')).map((f) => rd('bespoke/' + f)) : [] });
const tuning = rd('tuning.json');
const MODELS = rd('models.json').models, M = new Map(MODELS.map((m) => [m.id, m]));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const BUDGET = Number(arg('--budget', 16)), POINTS = Number(arg('--points', 40));
const ONLY = arg('--only', '') ? new Set(arg('--only', '').split(',')) : null;
const SKIP = new Set(['point_defence_turret', 'utility_repair_beam', 'utility_demolition_launcher', 'emp_hush', 'emp_blackout']);

// ---------------------------------------------------------------- rigs
const OPP = { N: 'S', S: 'N', E: 'W', W: 'E' }, NORMAL = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] };
const key = (x, y) => `${x},${y}`;
const partOf = (fn, x, y, rot = 0, extra = {}) => ({ fn, piece: extra.piece ?? M.get(fn)?.pieces[0] ?? 'sq', material: M.get(fn)?.material ?? 'alloy', x, y, rot, flip: false, ...extra });
const cellsOf = (q) => C.placeGeometry(catalog, q).cells.map((c) => [Math.floor(c[0] + 1e-6), Math.floor(c[1] + 1e-6)]);
const fnOf = (id) => catalog.functions.get(id);
/** A part's ports, placed */
function portsOf(q, dirWant) {
  const F = C.frameOf(q, cellsOf(q)), out = [];
  for (const s of fnOf(q.fn).ports ?? []) if (s.dir === dirWant) out.push({ ...C.placeEdge(q, F, s.side, s.cell ?? 0), rate: s.rate });
  return out;
}
/** Place `fn` so it covers (tx, ty) with an out port facing a port at (px, py, side), clear of `taken`. Returns the part or null */
function attach(fn, port, taken) {
  const tx = port.x + NORMAL[port.side][0], ty = port.y + NORMAL[port.side][1];
  for (let rot = 0; rot < 4; rot++) for (let dx = 0; dx >= -2; dx--) for (let dy = 0; dy >= -2; dy--) {
    const q = partOf(fn, 0, 0, rot);
    const cs = cellsOf(q), x0 = Math.min(...cs.map((c) => c[0])), y0 = Math.min(...cs.map((c) => c[1]));
    q.x = tx + dx - x0; q.y = ty + dy - y0;
    const placed = cellsOf(q);
    if (!placed.some((c) => c[0] === tx && c[1] === ty) || placed.some((c) => taken.has(key(c[0], c[1])))) continue;
    if (portsOf(q, 'out').some((o) => o.x === tx && o.y === ty && o.side === OPP[port.side])) { for (const c of placed) taken.add(key(c[0], c[1])); return q; }
  }
  return null;
}
const CHAINS = {
  reactor: ['power_cell_reactor'], battery: ['power_battery', 'power_cell_reactor'], overclock: ['power_overclock_reactor'],
  fusion: ['power_fusion_plant'], surge: ['power_surge_cell', 'power_fusion_plant'],
};
/** A rig: the gun facing N at the origin, each main input fed by `main`, its augment input by `aug` (or nothing), and a core that touches it all and links into nothing */
function rig(m, main, aug) {
  const gun = partOf(m.id, 0, 0, m.pieces[0] === 'round' ? 1 : 0, { facing: 'N' });
  const parts = [gun], taken = new Set(cellsOf(gun).map((c) => key(c[0], c[1])));
  // (Its input ports from the game's own layout of the gun alone)
  const lay = C.createShipState(catalog, tuning, 1, { name: 'probe', catalogVersion: 1, power: 'ports', parts: [{ uid: 0, ...partOf('core', -1, 0) }, { uid: 1, ...gun }] }, 0).derived.ports;
  const ins = lay ? lay.ports.filter((p) => p.part === 1 && p.dir === 0) : [];
  let cells = C.placeGeometry(catalog, gun).area, failed = false, points = C.partBuildPoints(catalog, gun);
  // A gun's own feed: the first material it takes, in a tank at its feed input (required feed only)
  if (m.feedPort?.required) {
    const F = C.frameOf(gun, cellsOf(gun)), e = C.placeEdge(gun, F, m.feedPort.side, m.feedPort.cell ?? 0);
    const tank = partOf(`feed_tank_${m.takes.includes('accelerant') ? 'accelerant' : m.takes[0]}`, e.nx, e.ny);
    parts.push(tank); taken.add(key(e.nx, e.ny)); cells += 1; points += C.partBuildPoints(catalog, tank);
  }
  for (const port of ins) {
    const chain = port.aug ? (aug ? CHAINS[aug] : null) : CHAINS[main];
    if (!chain) continue;
    // (A two-wide supply may already serve this port from the last one)
    let target = port;
    for (const fn of chain) {
      // (Already fed by a part placed for another port: the chain stops here)
      const already = parts.find((q) => q !== gun && portsOf(q, 'out').some((o) => o.x === target.x + NORMAL[target.side][0] && o.y === target.y + NORMAL[target.side][1] && o.side === OPP[target.side]));
      if (already) break;
      const q = attach(fn, target, taken);
      if (!q) { failed = true; break; }
      parts.push(q); cells += C.placeGeometry(catalog, q).area; points += C.partBuildPoints(catalog, q);
      const inn = portsOf(q, 'in')[0];
      if (!inn) break;
      target = inn;
    }
  }
  if (failed) return null;
  // The core: on a free cell touching the rig, linking into nothing and fed by nothing
  const around = [];
  for (const k of taken) { const [x, y] = k.split(',').map(Number); for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (!taken.has(key(x + dx, y + dy))) around.push([x + dx, y + dy]); }
  for (const [x, y] of around) {
    const all = [...parts, partOf('core', x, y)].map((q, uid) => ({ uid, ...q }));
    const bp = { name: `${m.id}:${main}:${aug ?? '-'}`, catalogVersion: 1, power: 'ports', parts: all };
    const v = C.validateBlueprint(catalog, bp, tuning, null, {});
    // (Not in its way: nothing on its firing edge or in its barrel's clearance)
    if (v.errors.some((e) => e.code === 'unreachable' || e.code === 'overlap' || e.code === 'facingBlocked' || (e.code === 'badMounting' && /clear/.test(e.message)))) continue;
    const L = C.createShipState(catalog, tuning, 1, bp, 0).derived.ports;
    const core = all.length - 1;
    let touches = false;
    for (let l = 0; l < L.links; l++) if (L.linkFrom[l] === core || L.linkTo[l] === core) touches = true;
    if (touches) continue;
    return { bp, cells, points };
  }
  return null;
}

// ---------------------------------------------------------------- firing through the ports core
function fire(bp, semi) {
  const ship = C.createShipState(catalog, tuning, 1, C.parseBlueprint(JSON.stringify(bp)), 0), d = ship.derived, L = d.ports;
  let c = { g: 100, b: [], e: C.createPortsState(L) }, shots = 0, aug = 0, lit = 0, litAug = 0;
  const p = d.weapons[0]?.part;
  if (p === undefined) return null;
  for (let t = 0; t < 70 * 60; t++) {
    c = C.powerTick(d, c, { thrusting: false, boosting: false }, tuning).charge;
    const g = C.stepGuns(ship, { x: 0, y: 0, angle: -Math.PI / 2 }, { firing: !semi || t % 2 === 0, aimWorld: -Math.PI / 2, aimDist: 600, energy: { charge: c } }, t, tuning);
    if (t < 600) continue;
    for (const s of g.shots) { shots++; if (s.aug) aug++; }
    shots += g.pulses.length;
    if (g.beams.length) { lit++; if (c.e.flags[p] & C.PF_AUG) litAug++; }
  }
  return { perSec: shots / 60, augShare: shots ? aug / shots : 0, lit: lit / 3600, litAug: lit ? litAug / lit : 0 };
}

// ---------------------------------------------------------------- the scenarios
// (Targets: hp, armour (grade + plate), radius and lateral speed (units, units a tick: what dodges a slow shell), and the
// range the fight is at: how close a pilot can get. Drones come to you; a kiting ship keeps its distance)
const SCEN = {
  swarm: { name: 'Swarm', say: '8 light drones, 150 hp, armour 1, 250 apart, closing to 450', n: 8, hp: 150, armour: 1, radius: 40, lateral: 8, range: 450, spacing: 250 },
  brick: { name: 'Armoured brick', say: 'one gunboat, 3,000 hp, armour 4, at 500', n: 1, hp: 3000, armour: 4, radius: 150, lateral: 3, range: 500 },
  shield: { name: 'Shielded', say: '800 shield (back at 60/s after 3 s unhit), 2,000 hull, armour 2, at 700', n: 1, hp: 2000, armour: 2, radius: 120, lateral: 4, range: 700, shield: 800, regen: 60, delay: 3 },
  duel: { name: 'Kiter', say: 'one ship keeping to 3,200, 1,500 hp, armour 2, dodging', n: 1, hp: 1500, armour: 2, radius: 90, lateral: 7, range: 3200 },
  line: { name: 'Line', say: 'three ships in a line 200 apart, 1,200 hp each, armour 2, at 900', n: 3, hp: 1200, armour: 2, radius: 120, lateral: 3, range: 900, spacing: 200 },
  boss: { name: 'Boss', say: 'one huge hull, 25,000 hp, armour 3, at 500', n: 1, hp: 25000, armour: 3, radius: 400, lateral: 2, range: 500 },
  // (Trading fire: every 2.5 s a hit somewhere on one of your guns or its rig knocks that gun out. Eight guns lose an eighth a hit; two lose half)
  under: { name: 'Under fire', say: 'one ship, 2,400 hp, armour 2, at 600, knocking out one of your guns every 2.5 s', n: 1, hp: 2400, armour: 2, radius: 120, lateral: 3, range: 600, attrition: 2.5 },
};
const pen = (gap) => C.penetrationMul(gap, tuning);
/** A gun's numbers with its model's mods (and an augment's on top) */
function numbers(m, aug) {
  const def = C.gunDef(tuning, m.weapon, { model: C.stackMods(m.weaponMods ?? {}, aug ? m.augment?.mods : undefined) ?? {} });
  const grade = C.partGrade(catalog, { fn: m.id, material: m.material });
  return { def, grade, beam: m.fire?.model === 'beam' || (def.type === 'beam' && !def.pulse), fixed: m.mount === 'fixed' };
}
/** Chance a shot lands: out of reach none; a beam always; a homing shell mostly; else its spread and the target's dodge over its flight */
function hitChance(N, S) {
  const d = N.def;
  if (N.beam) return (d.range ?? 800) >= S.range ? 1 : 0;
  if (d.pulse) return (d.range ?? 800) >= S.range ? 0.95 : 0;
  const reach = (d.speed ?? 48) * (d.life ?? 150);
  if (d.chain && !d.speed) return 0;
  if (reach < S.range * 0.98) return 0;
  if ((d.homing ?? 0) > 0) return 0.9;
  const flight = S.range / (d.speed ?? 48), dodge = S.lateral * flight * 0.5, cone = S.range * Math.tan(((d.spread ?? 1.8) * Math.PI) / 180);
  return Math.min(1, S.radius / Math.max(S.radius, dodge + cone / 2));
}
/** Damage a second a build does in a scenario, all targets together (what the scenario's hit points fall at) */
function dps(m, N, rate, S) {
  const d = N.def, k = (m.infra?.damage ?? 1), p = hitChance(N, S);
  if (p <= 0) return 0;
  const up = N.fixed && S.n > 4 ? 0.6 : 1;
  const others = S.spacing ? (S.n > 4 ? Math.min(S.n - 1, (Math.PI * 1) / 1) : S.n - 1) : 0;
  const near = (r) => (S.spacing ? Math.min(S.n - 1, S.n > 4 ? (Math.PI * r * r) / (S.spacing * S.spacing) : Math.floor(r / S.spacing)) : 0);
  const cap = (x) => (S.n > 4 ? Math.min(x, S.hp) : x);
  void others;
  if (N.beam) {
    // (A ramping beam, the Cutter's, burns up to ramp.to on one target: most of that, held on a big one; its base on drones)
    const base = d.ramp && S.n <= 3 ? 0.8 * d.ramp.to : d.dps ?? 50;
    const per = base * pen(N.grade + (d.pen ?? 0) - S.armour) * k * (rate.augDps ?? 1);
    // (A zapping beam's arc jumps on too)
    const chain = d.chain ? Array.from({ length: Math.min(d.chain.count - 1, near(d.chain.radius)) }, (_, i) => d.chain.falloff ** (i + 1)).reduce((a, b) => a + b, 0) : 0;
    // (Between drones a beam swings to the next: 0.3 s lost a kill)
    const swing = S.n > 4 ? 1 / (1 + (0.3 * per) / S.hp) : 1;
    return per * (1 + chain) * rate.lit * swing * up;
  }
  const shells = (d.burst ?? 1) * (d.pulse ? 1 : 1);
  const hit = (d.damage ?? 0) * pen(N.grade + (d.pen ?? 0) - S.armour) * k;
  let each = cap(hit);
  if (d.splash) each += cap(d.splash.damage * pen(N.grade - S.armour) * k) * (S.n > 1 ? near(d.splash.radius) : 1) + (S.n === 1 ? 0 : 0);
  if (d.chain) each += Array.from({ length: Math.min(d.chain.count - 1, near(d.chain.radius)) }, (_, i) => cap(hit * d.chain.falloff ** (i + 1))).reduce((a, b) => a + b, 0);
  if (d.pierce) each += S.n > 1 ? (S.n > 4 ? 0.2 * d.pierce * each : Math.min(d.pierce, S.n - 1) * hit * (d.pierceKeep ?? 0.5)) : 0;
  let out = each * shells * p * rate.perSec * up;
  // (Burning: each hit lights the part for ignite.dps over its ticks; a few parts burn at once)
  if (d.ignite) out += d.ignite.dps * k * Math.min(3 * S.n, rate.perSec * p * (d.ignite.ticks / 60));
  return out;
}
/** Seconds to kill the scenario's targets at `rate`; a shield that regrows faster than the gaps let it fall is never broken */
function ttk(m, N, rate, S, copies = 1) {
  const v = dps(m, N, rate, S) * copies;
  if (v <= 0) return Infinity;
  if (S.attrition) {
    // (Guns fall one a period: damage piles up at what's left)
    const one = v / copies;
    let done = 0;
    for (let i = 0; i < copies; i++) {
      const rate = one * (copies - i), need = S.hp - done;
      if (rate * S.attrition >= need) return i * S.attrition + need / rate;
      done += rate * S.attrition;
    }
    return Infinity;
  }
  let t = (S.n * S.hp) / v;
  if (S.shield) {
    // (The shield takes raw damage; between shots longer than its delay it grows back)
    const raw = v / Math.max(0.05, pen(N.grade + (N.def.pen ?? 0) - S.armour));
    const gap = N.beam ? 0 : 1 / Math.max(1e-6, rate.perSec * copies);
    const regen = gap > S.delay ? S.regen * (gap - S.delay) * rate.perSec * copies : 0;
    if (raw - regen <= 0) return Infinity;
    t += S.shield / (raw - regen);
  }
  return t;
}

// ---------------------------------------------------------------- run
const MAINS = ['reactor', 'battery', 'overclock', 'fusion', 'surge'], AUGS = ['battery', 'overclock', 'fusion'];
const builds = [];
for (const m of MODELS) {
  if (!m.weapon || SKIP.has(m.id) || m.rarity === 'legendary' || !m.infra || (ONLY && !ONLY.has(m.id))) continue;
  const semi = !!m.fire?.semi;
  const tried = [];
  for (const main of MAINS) {
    const r = rig(m, main, null); if (!r) continue;
    const f = fire(r.bp, semi); if (!f) continue;
    tried.push({ main, aug: null, cells: r.cells, points: r.points, ...f, bp: r.bp });
  }
  const score = (t) => (m.fire?.model === 'beam' ? t.lit : t.perSec);
  const best = Math.max(0, ...tried.map(score));
  if (!best) { console.log(`never fires on any rig: ${m.id}`); continue; }
  const base = tried.filter((t) => score(t) >= 0.85 * best).sort((a, b) => a.cells - b.cells)[0];
  const weakest = tried.find((t) => t.main === 'reactor');
  builds.push({ m, label: 'base', ...base, augDps: 1, starved: weakest && score(weakest) < 0.5 * best ? score(weakest) / best : null });
  if (m.augment) {
    const augTried = [];
    for (const a of AUGS) {
      const r = rig(m, base.main, a); if (!r) continue;
      const f = fire(r.bp, semi); if (!f) continue;
      augTried.push({ main: base.main, aug: a, cells: r.cells, points: r.points, ...f, bp: r.bp });
    }
    const share = (t) => (m.fire?.model === 'beam' ? t.litAug : t.augShare);
    const ok = augTried.filter((t) => share(t) >= 0.8).sort((a, b) => a.cells - b.cells)[0] ?? augTried.sort((a, b) => share(b) - share(a))[0];
    if (ok) builds.push({ m, label: 'augmented', ...ok, augDps: m.fire?.model === 'beam' ? 1 + (m.augment.mods?.mul?.dps ?? 0) * share(ok) : 1 });
  }
}

const rows = [];
for (const b of builds) {
  const aug = b.label === 'augmented';
  const N = numbers(b.m, aug && b.m.fire?.model !== 'beam' && b.augShare >= 0.5);
  const rate = { perSec: b.perSec, lit: b.lit, augDps: b.augDps };
  const copies = Math.max(1, Math.min(Math.floor(BUDGET / b.cells), Math.floor(POINTS / b.points)));
  const t = {}, tl = {};
  for (const [k, S] of Object.entries(SCEN)) { t[k] = ttk(b.m, N, rate, S); tl[k] = ttk(b.m, N, rate, S, copies); }
  rows.push({ id: b.m.id, name: b.m.name + (aug ? ` + ${b.m.augment.name}` : ''), tier: b.m.infra.tier, rig: b.main + (b.aug ? ` + ${b.aug}` : ''), cells: b.cells, points: b.points, copies, t, tl, starved: b.starved, aug: aug ? (b.m.fire?.model === 'beam' ? b.litAug : b.augShare) : null });
}

// ---------------------------------------------------------------- report
const fmt = (s) => (Number.isFinite(s) ? (s >= 100 ? s.toFixed(0) : s.toFixed(1)) : '—');
const lines = [];
const out = (s = '') => lines.push(s);
out(`Budget for a loadout: ${BUDGET} cells and ${POINTS} build points (gun and its rig; the core and the rest of the ship are not counted).`);
out('');
out('| Build | Role | Rig | Cells | Points | Copies | ' + Object.values(SCEN).map((S) => S.name).join(' | ') + ' |');
out('|---|---|---|---|---|---|' + Object.keys(SCEN).map(() => '---').join('|') + '|');
for (const r of rows) out(`| ${r.name} | ${r.tier} | ${r.rig}${r.aug !== null ? ` (${Math.round(r.aug * 100)}% augmented)` : ''} | ${r.cells.toFixed(1)} | ${r.points.toFixed(1)} | ${r.copies} | ` + Object.keys(SCEN).map((k) => fmt(r.tl[k])).join(' | ') + ' |');
out('');
out('Seconds for the whole loadout to kill the scenario\'s targets (— : it can\'t: out of reach, or a shield it never breaks).');
out('');
for (const [k, S] of Object.entries(SCEN)) {
  const best = rows.filter((r) => Number.isFinite(r.tl[k]) && M.get(r.id).fire?.model !== 'ammo').sort((a, b) => a.tl[k] - b.tl[k]).slice(0, 6);
  out(`**${S.name}** (${S.say}): ` + best.map((r, i) => `${i + 1}. ${r.name} ×${r.copies} ${fmt(r.tl[k])} s`).join(', '));
  out('');
}
// (Where each gun stands: its best rank in any scenario, and how many scenarios it is in the top 6)
const rank = {};
// (Ammunition guns are listed but not ranked: they pay in rounds, which this doesn't count)
const powered = rows.filter((r) => M.get(r.id).fire?.model !== 'ammo');
for (const k of Object.keys(SCEN)) powered.filter((r) => Number.isFinite(r.tl[k])).sort((a, b) => a.tl[k] - b.tl[k]).forEach((r, i) => { (rank[r.id] ??= []).push({ k, i: i + 1 }); });
out('| Gun | Best scenario (rank) | Top-6 in |');
out('|---|---|---|');
for (const id of [...new Set(powered.map((r) => r.id))]) {
  const rs = (rank[id] ?? []).sort((a, b) => a.i - b.i);
  const top = rs.filter((x) => x.i <= 6).map((x) => SCEN[x.k].name);
  out(`| ${M.get(id).name} | ${rs[0] ? `${SCEN[rs[0].k].name} (${rs[0].i})` : '—'} | ${[...new Set(top)].join(', ') || '—'} |`);
}
const starved = rows.filter((r) => r.starved !== null && r.starved !== undefined);
if (starved.length) { out(''); out('On a lone Cell Reactor a heavy gun fires at: ' + starved.map((r) => `${M.get(r.id).name} ${Math.round(r.starved * 100)}%`).join(', ') + ' of its pace.'); }
const text = lines.join('\n');
console.log(text);
const md = arg('--md', '');
if (md) writeFileSync(md, text + '\n');
