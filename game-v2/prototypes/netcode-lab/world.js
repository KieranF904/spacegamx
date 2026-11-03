// Netcode Lab: the open world that the lab server (Node) and every browser client run, built on sim.js (fixed-point
// flight, guns, shells, table trig, integer square root). The same rules as sim.js: integers only, no Math.sin/cos/atan2/
// sqrt/pow, every random number from an RNG kept in the state (here one per entity, so a client that holds only part of
// the world draws the same numbers), and a fixed update order (ships by uid, shells by (fire tick, owner, gun), loot by uid).
//
// The world is 6000 x 6000 units: ~120 asteroids placed by the world seed (they never move; their state is the default
// unless the override table says otherwise), freighters flying routes, pirate drones that hunt anything that is not a
// drone, and players: people, whose inputs come from outside the simulation, and the server's bots.
//
// A client holds only the entities the server has told it about (its awareness set). step() runs the same on a part of the
// world as on the whole of it; it is the server's job (awareness plus interaction pull-in) to make sure that everything a
// tracked entity touches is tracked too, and the event reports and hashes catch it when that wasn't enough.
//
// Every ship keeps the input it flew with this tick in sh.inp: a person's comes from outside, an AI's from its pilot.
// An AI (drone, freighter, bot) has two halves. The commander, on the server only, decides what it is after: its target
// (sh.target), set at the end of a tick and sent to clients as an order when it changes. The pilot, here, turns the order
// into controls every 4 ticks on every copy, reading only the ship itself and its target, so a client that holds an AI
// and its target flies it exactly; the server makes sure every client that holds an AI holds its target too.
(function (NL) {
'use strict';
const S = NL.Sim;
const { FX, IN, NEUTRAL, iatan2, isqrt, isin, icos, wrapBA, clamp, qmul, rngNext } = S;
const HALF = S.HALF_WORLD;
const RATE = 60;

// ------------------------------------------------------------------------------------------------------- kinds, tuning
// Players fly as in sim.js, with shorter shell lives so a shot reaches ~1,500 units (the awareness radius), not 2,700.
const KINDS = {
  player: { r: 28, hp: 100, accel: 0.42, maxAv: 0.1, brake: 0.014,
    gun: { spd: 34, life: 45, dmg: 12, cd: 8, gimbalDeg: 2, tolDeg: 0.5 },
    tur: { spd: 26, life: 55, dmg: 6, cd: 14, slew: 0.09, arcDeg: 90, tolDeg: 4, off: -8 } },
  drone: { r: 24, hp: 60, accel: 0.30, maxAv: 0.055, brake: 0.006,
    gun: { spd: 15, life: 100, dmg: 10, cd: 45, gimbalDeg: 4, tolDeg: 2 }, tur: null },
  freighter: { r: 60, hp: 400, accel: 0.10, maxAv: 0.025, brake: 0.004, gun: null,
    tur: { spd: 18, life: 70, dmg: 5, cd: 30, slew: 0.06, arcDeg: 180, tolDeg: 6, off: 0 } },
};
const P = S.makeParams(RATE, KINDS);
const KIND_ID = { player: 0, drone: 1, freighter: 2 }, KIND_NAME = ['player', 'drone', 'freighter'];

const C = {
  VIEW: 1200,            // what the screen shows around you
  AWARE: 1500,           // a ship or loot inside this radius of you is tracked (view + 300 margin)...
  AWARE_OUT: 1700,       // ...and stays tracked until it is past this one (no flapping at the edge)
  ROCK_AWARE: 1700, ROCK_OUT: 1900,
  SENSE: 1600,           // a drone hunts within this; a freighter's turret looks out to FR_SENSE
  FR_SENSE: 900,
  RESPAWN: P.respawn,    // ticks dead
  LOOT_LIFE: 1200, LOOT_BASE: 0x100000, LOOT_FR: Math.round(0.97 * FX),
  ROCK_RESPAWN: 5400,    // a destroyed rock comes back 90 s later, worked out from its destruction tick (no message)
  CELL: 500, GRID: 12,   // asteroids: one per 500-unit cell at most
};

const rngRange = (s, lo, hi) => lo + (rngNext(s) % (hi - lo + 1));
const team = (sh) => (sh.kind === 'player' ? 16 + sh.uid : sh.kind === 'drone' ? 1 : 2);
/** Is b within R units of a? (Q8 so the squares stay well inside 2^53) */
const within = (a, b, R) => { const dx = (a.x - b.x) >> 8, dy = (a.y - b.y) >> 8, rr = R * 256; return dx * dx + dy * dy <= rr * rr; };
const d2u = (a, b) => { const dx = (a.x - b.x) >> 16, dy = (a.y - b.y) >> 16; return dx * dx + dy * dy; };

// ------------------------------------------------------------------------------------------------------------ rocks
const rockCache = new Map();
/** The asteroid field for a seed: every machine builds the same one, so a rock is named by its index and never sent */
function rocksFor(seed) {
  if (rockCache.has(seed)) return rockCache.get(seed);
  const r = { rng: (seed ^ 0x5bd1e995) | 0 || 1 }, list = [], grid = new Int32Array(C.GRID * C.GRID).fill(-1);
  for (let gy = 0; gy < C.GRID; gy++) for (let gx = 0; gx < C.GRID; gx++) {
    const v = rngNext(r), rad = 25 + rngNext(r) % 61, ox = 100 + rngNext(r) % 301, oy = 100 + rngNext(r) % 301, spin = rngNext(r) % 201 - 100;
    if (v % 100 < 15) continue;
    const id = list.length;
    list.push({ id, x: -HALF + gx * C.CELL + ox, y: -HALF + gy * C.CELL + oy, r: rad, hp: rad * 2, spin });
    grid[gy * C.GRID + gx] = id;
  }
  const out = { list, grid };
  rockCache.set(seed, out);
  return out;
}
const cellOf = (u) => clamp(Math.floor((u + HALF) / C.CELL), 0, C.GRID - 1);
/** Rock ids in the cells under a box (units), in id order */
function rocksIn(W, x0, y0, x1, y1) {
  const g = W.rocks.grid, out = [];
  for (let cy = cellOf(y0); cy <= cellOf(y1); cy++) for (let cx = cellOf(x0); cx <= cellOf(x1); cx++) {
    const id = g[cy * C.GRID + cx]; if (id >= 0) out.push(id);
  }
  return out.sort((a, b) => a - b);
}
const rockHp = (W, id) => { const o = W.rockOv.get(id); return o ? o.hp : W.rocks.list[id].hp; };
const rockAlive = (W, id) => { const o = W.rockOv.get(id); return !o || !o.dead; };

// ------------------------------------------------------------------------------------------------------------ world
function createWorld(seed, authority) {
  return { seed, tick: 0, authority: !!authority, rocks: rocksFor(seed), ships: [], loot: [], shells: [],
    rockOv: new Map(), events: [], byUid: new Map() };
}
function makeShip(uid, kind, x, y, a) {
  return { uid, id: uid, kind, x: x * FX, y: y * FX, vx: 0, vy: 0, a: a & 0xFFFF, av: 0, tur: 0, gcd: 0, tcd: 0,
    hp: P.kinds[kind].hp, dead: 0, boost: P.boostMax, kills: 0, deaths: 0, seq: 0, shots: 0,
    rng: Math.imul(uid, 0x9E3779B1) | 0 || 1, target: 0, aiFlip: 0, hx: x, hy: y, wpx: x, wpy: y, cargo: 0, bot: 0, inp: NEUTRAL };
}
function index(W) { W.byUid.clear(); for (const s of W.ships) W.byUid.set(s.uid, s); for (const l of W.loot) W.byUid.set(l.uid, l); }
const isLoot = (uid) => uid >= C.LOOT_BASE;
/** Put an entity in (or replace it), keeping uid order */
function insertEntity(W, e) {
  const list = isLoot(e.uid) ? W.loot : W.ships;
  let i = list.findIndex((o) => o.uid >= e.uid);
  if (i < 0) list.push(e); else if (list[i].uid === e.uid) list[i] = e; else list.splice(i, 0, e);
  W.byUid.set(e.uid, e);
}
function removeEntity(W, uid) {
  const list = isLoot(uid) ? W.loot : W.ships, i = list.findIndex((o) => o.uid === uid);
  if (i >= 0) list.splice(i, 1);
  W.byUid.delete(uid);
}
/** Shells in canonical order: fire tick, then owner, then gun (the order step() makes them in) */
const shellOrder = (a, b) => a.t0 - b.t0 || a.o - b.o || a.gun - b.gun;
function setShellsOf(W, uid, shells) {
  W.shells = W.shells.filter((p) => p.o !== uid).concat(shells).sort(shellOrder);
}
function cloneWorld(W) {
  const c = { seed: W.seed, tick: W.tick, authority: W.authority, rocks: W.rocks,
    ships: W.ships.map((s) => Object.assign({}, s)), loot: W.loot.map((l) => Object.assign({}, l)),
    shells: W.shells.map((p) => Object.assign({}, p)), rockOv: new Map(), events: [], byUid: new Map() };
  for (const [k, v] of W.rockOv) c.rockOv.set(k, Object.assign({}, v));
  index(c);
  return c;
}

// ------------------------------------------------------------------------------------------------------------ brains
function moveBits(mx, my, thr) {
  let b = 0;
  if (mx > thr) b |= IN.D; else if (mx < -thr) b |= IN.A;
  if (my > thr) b |= IN.S; else if (my < -thr) b |= IN.W;
  return b;
}
/** The order's target, if it is still there to fly against (the commander replaces a dead or lost one) */
const orderTarget = (W, sh) => { const tg = sh.target ? W.byUid.get(sh.target) : null; return tg && !tg.dead ? tg : null; };
/** Pirate drone: circles its target at 450-800 and leads its shots; with none, goes home */
function dronePilot(W, sh) {
  const K = P.kinds.drone, tg = orderTarget(W, sh);
  if (!tg) {
    const dx = sh.hx - (sh.x >> 16), dy = sh.hy - (sh.y >> 16), d = isqrt(dx * dx + dy * dy);
    if (d < 150) return { b: 0, aim: sh.a, dist: 400, seq: 0 };
    return { b: moveBits(Math.trunc(dx * FX / d), Math.trunc(dy * FX / d), 25000), aim: iatan2(dy, dx), dist: 400, seq: 0 };
  }
  const dx = (tg.x - sh.x) >> 16, dy = (tg.y - sh.y) >> 16, d = isqrt(dx * dx + dy * dy);
  const tt = Math.min(90, Math.floor(d * FX / K.gun.spd));
  const aim = iatan2(dy + Math.trunc(tg.vy * tt / FX), dx + Math.trunc(tg.vx * tt / FX));
  if ((W.tick + sh.uid) % 240 === 0) sh.aiFlip = rngNext(sh) & 1;
  const want = d > 800 ? 1 : d < 450 ? -1 : 0, side = sh.aiFlip ? 1 : -1;
  const ux = d > 0 ? Math.trunc(dx * FX / d) : 0, uy = d > 0 ? Math.trunc(dy * FX / d) : 0;
  let b = moveBits(want * ux - side * uy, want * uy + side * ux, 25000);
  if (d < 1100) b |= IN.GUN;
  return { b, aim, dist: Math.min(d, 2000), seq: 0 };
}
/** Freighter: flies to a waypoint (helm controls), picks the next from its RNG; its turret shoots its target */
function freighterPilot(W, sh) {
  let dx = sh.wpx - (sh.x >> 16), dy = sh.wpy - (sh.y >> 16);
  if (dx * dx + dy * dy < 250 * 250) {
    sh.wpx = rngRange(sh, -2600, 2600); sh.wpy = rngRange(sh, -2600, 2600);
    dx = sh.wpx - (sh.x >> 16); dy = sh.wpy - (sh.y >> 16);
  }
  const err = wrapBA(iatan2(dy, dx) - sh.a);
  let b = IN.HELM;
  if (err > 1200) b |= IN.D; else if (err < -1200) b |= IN.A;
  if (Math.abs(err) < 12000) b |= IN.W;
  const tg = orderTarget(W, sh);
  if (!tg) return { b, aim: sh.a, dist: 400, seq: 0 };
  const tx = (tg.x - sh.x) >> 16, ty = (tg.y - sh.y) >> 16;
  return { b: b | IN.TURRET, aim: iatan2(ty, tx), dist: Math.min(isqrt(tx * tx + ty * ty), 2000), seq: 0 };
}
/** Server bot (a player's ship): circles its target at ~500 on a slow orbit, leads its shots, boosts now and then */
function botPilot(W, sh) {
  const tg = orderTarget(W, sh);
  if (!tg) return { b: 0, aim: sh.inp.aim, dist: 400, seq: 0 };
  const dx = (tg.x - sh.x) >> 16, dy = (tg.y - sh.y) >> 16, d = isqrt(dx * dx + dy * dy);
  // (orbit 0.45 rad/s = 78 binary-angle units a tick, its phase from the uid)
  const th = (W.tick * 78 + sh.uid * 17732) & 0xFFFF, rad = tg.kind === 'freighter' ? 520 : 480;
  const wx = dx + Math.trunc(icos(th) * rad / FX), wy = dy + Math.trunc(isin(th) * rad / FX);
  let b = moveBits(wx, wy, 60);
  const lead = Math.min(40, Math.floor(d / 34));
  const aim = iatan2(dy + Math.trunc(tg.vy * lead / FX), dx + Math.trunc(tg.vx * lead / FX));
  if (d < 1000 && Math.abs(wrapBA(aim - sh.a)) < 1500) b |= IN.GUN;
  if (d < 1100) b |= IN.TURRET;
  if ((W.tick + sh.uid * 102) % 540 < 36) b |= IN.BOOST;
  return { b, aim, dist: Math.min(d, 2000), seq: 0 };
}
const pilot = (W, sh) => (sh.bot ? botPilot : sh.kind === 'drone' ? dronePilot : freighterPilot)(W, sh);
/** A pilot's output on the wire's grid (aim 13 bits, distance in 4s), so its held input survives an entity snapshot */
const onGrid = (inp) => ({ b: inp.b, aim: ((inp.aim >> 3) << 3) & 0xFFFF, dist: (inp.dist >> 2) << 2, seq: 0 });
function respawn(sh) {
  const K = P.kinds[sh.kind];
  let x, y;
  if (sh.kind === 'drone') { x = sh.hx + rngRange(sh, -300, 300); y = sh.hy + rngRange(sh, -300, 300); }
  else if (sh.kind === 'freighter') { x = rngRange(sh, -2500, 2500); y = rngRange(sh, -2500, 2500); sh.wpx = x; sh.wpy = y; }
  else { x = clamp((sh.x >> 16) + rngRange(sh, -700, 700), -2800, 2800); y = clamp((sh.y >> 16) + rngRange(sh, -700, 700), -2800, 2800); }
  sh.x = x * FX; sh.y = y * FX; sh.vx = sh.vy = sh.av = sh.tur = 0; sh.a = rngNext(sh) & 0xFFFF;
  sh.hp = K.hp; sh.boost = P.boostMax; sh.target = 0; sh.gcd = sh.tcd = 0; sh.dead = 0;
}

// ------------------------------------------------------------------------------------------------------------ one tick
function addShot(sh, p, out) {
  sh.shots = (sh.shots + 1) & 0xFFFF;
  p.o = sh.uid; p.n = sh.shots; p.id = sh.uid * 65536 + p.n; p.tm = team(sh);
  out.push(p);
}
function rockHit(W, p) {
  const x0 = Math.min(p.x, p.x + p.vx) >> 16, x1 = Math.max(p.x, p.x + p.vx) >> 16;
  const y0 = Math.min(p.y, p.y + p.vy) >> 16, y1 = Math.max(p.y, p.y + p.vy) >> 16;
  for (const id of rocksIn(W, x0 - 90, y0 - 90, x1 + 90, y1 + 90)) {
    const R = W.rocks.list[id];
    if (rockAlive(W, id) && S.sweptHit(p, { x: R.x * FX, y: R.y * FX }, R.r)) return id;
  }
  return -1;
}
/** Loot from a destroyed rock. Only the authority makes it: clients get it in an entry snapshot after the same tick. */
function spawnLoot(W, R, T, out) {
  const r = { rng: (Math.imul(R.id + 1, 0x85EBCA6B) ^ T) | 0 || 1 }, n = 1 + (R.id % 3);
  for (let i = 0; i < n; i++) {
    out.push({ uid: C.LOOT_BASE + R.id * 4 + i, x: R.x * FX, y: R.y * FX,
      vx: (rngNext(r) % 257 - 128) * 1024, vy: (rngNext(r) % 257 - 128) * 1024, life: C.LOOT_LIFE });
  }
}

/**
 * Step the world one tick. `inputs` maps a person's uid to its input from this tick on (people hold their last input;
 * one with no entry keeps it). Order: rock respawns; ships by uid (input or brain, flight, guns); shells in order
 * (hit a ship, else a rock; move; expire); loot (drift, pickup, expire); then this tick's new shells and loot join.
 * W.events gets this tick's hits and pickups.
 */
function step(W, inputs) {
  const T = ++W.tick;
  W.events = [];
  index(W);
  for (const [id, o] of W.rockOv) if (o.dead && T - o.dead >= C.ROCK_RESPAWN) W.rockOv.delete(id);
  const born = [], bornLoot = [], back = [];
  for (const sh of W.ships) {
    const driven = sh.kind === 'player' && !sh.bot;
    if (driven) { const n = inputs && inputs.get(sh.uid); if (n) sh.inp = n; }
    if (sh.kind === 'player') sh.seq = sh.inp.seq || 0;   // (bookkeeping for the delay readout, dead or alive; not hashed)
    if (sh.dead > 0) { if (--sh.dead === 0) { sh.dead = 1; back.push(sh); } continue; }
    // (AI pilots think at 15 Hz, staggered by uid, and hold their output between)
    const think = !driven && (W.tick + sh.uid) % 4 === 0;
    const inp = driven || !think ? sh.inp : onGrid(pilot(W, sh));
    if (!driven) sh.inp = inp;
    S.fly(sh, inp, P);
    const out = [];
    S.guns(sh, inp, P, T, out);
    for (const p of out) addShot(sh, p, born);
  }
  const keep = [], W2 = HALF * FX;
  for (const p of W.shells) {
    let hs = null, hr = -1;
    for (const sh of W.ships) {
      if (sh.dead || sh.uid === p.o || team(sh) === p.tm) continue;
      if (S.sweptHit(p, sh, P.kinds[sh.kind].r + 4)) { hs = sh; break; }
    }
    if (!hs) hr = rockHit(W, p);
    p.x += p.vx; p.y += p.vy; p.life--;
    if (hs) {
      hs.hp -= p.dmg;
      const m = hs.kind === 'freighter' ? 1500 : 300;
      hs.vx += Math.trunc(p.vx * p.dmg / m); hs.vy += Math.trunc(p.vy * p.dmg / m);
      let kill = 0;
      if (hs.hp <= 0) {
        hs.hp = 0; hs.dead = C.RESPAWN; hs.deaths++; kill = 1;
        const k = W.byUid.get(p.o); if (k && !isLoot(k.uid)) k.kills++;
      }
      W.events.push({ k: 'hit', T, tgt: hs.uid, rock: -1, by: p.o, n: p.n, dmg: p.dmg, hp: hs.hp, kill, x: p.x, y: p.y });
    } else if (hr >= 0) {
      const R = W.rocks.list[hr], o = W.rockOv.get(hr) || { hp: R.hp, dead: 0 };
      o.hp = Math.max(0, o.hp - p.dmg);
      let kill = 0;
      if (o.hp === 0) { o.dead = T; kill = 1; if (W.authority) spawnLoot(W, R, T, bornLoot); }
      W.rockOv.set(hr, o);
      W.events.push({ k: 'hit', T, tgt: -1, rock: hr, by: p.o, n: p.n, dmg: p.dmg, hp: o.hp, kill, x: p.x, y: p.y });
    } else if (p.life > 0 && p.x > -W2 && p.x < W2 && p.y > -W2 && p.y < W2) keep.push(p);
  }
  const keepL = [];
  for (const l of W.loot) {
    l.x += l.vx; l.y += l.vy; l.vx = qmul(l.vx, C.LOOT_FR); l.vy = qmul(l.vy, C.LOOT_FR); l.life--;
    let by = null;
    for (const sh of W.ships) if (sh.kind === 'player' && !sh.dead && within(sh, l, 40)) { by = sh; break; }
    if (by) { by.cargo = (by.cargo + 1) & 0xFFFF; W.events.push({ k: 'pick', T, tgt: l.uid, rock: -1, by: by.uid, dmg: 0, hp: by.cargo, kill: 0, x: l.x, y: l.y }); }
    else if (l.life > 0) keepL.push(l);
  }
  W.loot = bornLoot.length ? keepL.concat(bornLoot).sort((a, b) => a.uid - b.uid) : keepL;
  W.shells = keep.concat(born);
  // Ships back from the dead reappear at the end of the tick: nothing sees them until the next, by when the server has
  // put them in the awareness of everyone near their new spot
  for (const sh of back) respawn(sh);
  index(W);
}

/** One ship alone, for the current style's prediction of your own ship (no hits, no respawn: those wait for the server) */
function stepAlone(sh, inp, T, out) {
  sh.seq = inp.seq || 0;
  if (sh.dead > 0) { if (sh.dead > 1) sh.dead--; return; }
  S.fly(sh, inp, P);
  const o = [];
  S.guns(sh, inp, P, T, o);
  for (const p of o) addShot(sh, p, out);
}

// ------------------------------------------------------------------------------------------------------------- hashes
function hasher() {
  let h = 0x811c9dc5 | 0;
  const mix = (v) => { h = Math.imul(h ^ (v | 0), 16777619); h ^= h >>> 15; };
  return { mix, get: () => h >>> 0 };
}
const fold8 = (h) => (h ^ (h >>> 8) ^ (h >>> 16) ^ (h >>> 24)) & 255;
const FIELDS = ['uid', 'x', 'y', 'vx', 'vy', 'a', 'av', 'tur', 'gcd', 'tcd', 'hp', 'dead', 'boost', 'kills', 'deaths', 'shots', 'cargo',
  'rng', 'target', 'aiFlip', 'wpx', 'wpy', 'bot'];
function mixShip(m, sh) {
  for (const k of FIELDS) m.mix(sh[k]);
  m.mix(sh.inp.b); m.mix(sh.inp.aim); m.mix(sh.inp.dist);
}
function mixShell(m, p) { m.mix(p.o); m.mix(p.n); m.mix(p.gun); m.mix(p.t0); m.mix(p.x); m.mix(p.y); m.mix(p.vx); m.mix(p.vy); m.mix(p.life); m.mix(p.dmg); }
function mixLoot(m, l) { m.mix(l.uid); m.mix(l.x); m.mix(l.y); m.mix(l.vx); m.mix(l.vy); m.mix(l.life); }
/** One entity's state hash (a ship's includes its live shells), 32 bits */
function entityHash(W, e) {
  const m = hasher();
  if (isLoot(e.uid)) mixLoot(m, e);
  else { mixShip(m, e); for (const p of W.shells) if (p.o === e.uid) mixShell(m, p); }
  return m.get();
}
/** The whole world (determinism checks) */
function worldHash(W) {
  const m = hasher();
  m.mix(W.tick);
  for (const s of W.ships) mixShip(m, s);
  for (const l of W.loot) mixLoot(m, l);
  for (const p of W.shells) mixShell(m, p);
  for (const id of [...W.rockOv.keys()].sort((a, b) => a - b)) { const o = W.rockOv.get(id); m.mix(id); m.mix(o.hp); m.mix(o.dead); }
  return m.get();
}
/** An event's report hash: 8 bits of (tick, what, who, by whom, damage, HP after, kill) */
function eventHash8(e) {
  const m = hasher();
  m.mix(e.T); m.mix(e.k === 'hit' ? 1 : 2); m.mix(e.tgt); m.mix(e.rock); m.mix(e.by); m.mix(e.dmg); m.mix(e.hp); m.mix(e.kill);
  return fold8(m.get());
}

NL.World = { P, C, KINDS, KIND_ID, KIND_NAME, RATE, rocksFor, rocksIn, rockHp, rockAlive, createWorld, makeShip, insertEntity,
  removeEntity, setShellsOf, shellOrder, cloneWorld, index, step, stepAlone, team, within, isLoot, entityHash, worldHash,
  eventHash8, fold8, rngRange, d2u };
if (typeof module === 'object' && module.exports) module.exports = NL;
})(globalThis.NL = globalThis.NL || {});
