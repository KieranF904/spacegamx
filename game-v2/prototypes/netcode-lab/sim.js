// Netcode Lab: the deterministic simulation every network style runs.
//
// Everything in the state is an integer: positions and velocities are fixed point (Q16: 65536 = one world unit), angles
// are "binary angles" (65536 = one turn). Trig comes from a table built with + - * / only, square roots and atan2 are
// done the same way, and the RNG is a seeded xorshift kept in the state. (IEEE + - * / are correctly rounded, so they give
// the same answer in every browser; Math.sin/cos/atan2/exp/pow are not specified that tightly and are never used here.)
// Ships update in id order, then projectiles in spawn order, so two copies fed the same inputs stay bit for bit equal.
(function (NL) {
'use strict';

const FX = 65536;           // Q16 one
const HALF_WORLD = 3000;    // arena is 6000 x 6000 units, walls bounce
const N_PLAYERS = 2;        // ids 0 (you) and 1 (the other player); drones follow

// ---------------------------------------------------------------------------------------------------------------- trig
const SIN_N = 4096, SIN = new Int32Array(SIN_N);
(function buildSin() {
  for (let i = 0; i < SIN_N; i++) {
    const q = (i / 1024) | 0, r = i % 1024;
    const x = r * 1.5707963267948966 / 1024, x2 = x * x;
    // Taylor series to x^13: under 1e-9 off on [0, pi/2], far below a Q16 step
    const s = x * (1 - x2 / 6 * (1 - x2 / 20 * (1 - x2 / 42 * (1 - x2 / 72 * (1 - x2 / 110 * (1 - x2 / 156))))));
    const c = 1 - x2 / 2 * (1 - x2 / 12 * (1 - x2 / 30 * (1 - x2 / 56 * (1 - x2 / 90 * (1 - x2 / 132)))));
    const v = q === 0 ? s : q === 1 ? c : q === 2 ? -s : -c;
    SIN[i] = Math.round(v * FX);
  }
})();
const isin = (ba) => SIN[((ba & 0xFFFF) >> 4)];
const icos = (ba) => SIN[(((ba & 0xFFFF) >> 4) + 1024) & 4095];
/** Signed shortest difference of two binary angles, -32768..32767 */
const wrapBA = (d) => ((d + 32768) & 0xFFFF) - 32768;

/** atan2 to a binary angle (0..65535), from basic arithmetic only (polynomial, ~0.0006 degrees off) */
function iatan2(y, x) {
  if (x === 0 && y === 0) return 0;
  const ax = Math.abs(x), ay = Math.abs(y), swap = ay > ax;
  const t = swap ? ax / ay : ay / ax, t2 = t * t;
  const a = t * (0.9998660 + t2 * (-0.3302995 + t2 * (0.1801410 + t2 * (-0.0851330 + t2 * 0.0208351))));
  let ba = Math.round(a * 10430.378350470453);
  if (swap) ba = 16384 - ba;
  if (x < 0) ba = 32768 - ba;
  if (y < 0) ba = -ba;
  return ba & 0xFFFF;
}

/** Integer square root (Newton, floor) */
function isqrt(n) {
  if (n <= 0) return 0;
  let x = n, y = Math.floor((x + 1) / 2);
  while (y < x) { x = y; y = Math.floor((x + Math.floor(n / x)) / 2); }
  return x;
}
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const qmul = (a, b) => Math.trunc((a * b) / FX);   // Q16 x Q16 (products stay under 2^53)

// ---------------------------------------------------------------------------------------------------------- the RNG
function rngNext(s) { // xorshift32 on s.rng; returns 0..2^32-1
  let x = s.rng;
  x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
  s.rng = x | 0;
  return x >>> 0;
}
const rngRange = (s, lo, hi) => lo + (rngNext(s) % (hi - lo + 1));

// ------------------------------------------------------------------------------------------------------------ inputs
// One input per player per tick. b = bits below, aim = binary angle from the ship to the cursor, dist = cursor distance
// (units), seq = which local sample it came from (bookkeeping for the delay readout; not part of the state hash).
const IN = { W: 1, A: 2, S: 4, D: 8, BOOST: 16, GUN: 32, TURRET: 64, HELM: 128, Q: 256, E: 512 };
const NEUTRAL = Object.freeze({ b: 0, aim: 0, dist: 400, seq: 0 });
const sameInput = (a, b) => a.b === b.b && a.aim === b.aim && a.dist === b.dist;

// ------------------------------------------------------------------------------------------------- tuning (60 Hz feel)
// From the game where it maps (data/ships/tuning.json flight + fixedGun + turret, common/src/constants.ts): friction 0.985
// a tick, boost x2.2, max spin 0.1 rad a tick, steer gain 0.5 with brake margin 0.9, helm gain 0.25, fixed gun gimbal
// +-2 degrees (+0.5 tolerance), turret slew 0.09 rad a tick over a +-90 degree arc (4 degree tolerance). Speeds are per
// 60 Hz tick; makeParams rescales them for other tick rates so the game feels the same.
const BASE = {
  player: { r: 28, hp: 100, accel: 0.42, maxAv: 0.1, brake: 0.014,
    gun: { spd: 34, life: 80, dmg: 12, cd: 8, gimbalDeg: 2, tolDeg: 0.5 },
    tur: { spd: 26, life: 90, dmg: 6, cd: 14, slew: 0.09, arcDeg: 90, tolDeg: 4, off: -8 } },
  drone: { r: 24, hp: 60, accel: 0.30, maxAv: 0.055, brake: 0.006,
    gun: { spd: 15, life: 150, dmg: 10, cd: 45, gimbalDeg: 4, tolDeg: 2 }, tur: null },
};
const RAD = 65536 / (2 * Math.PI);
const DEG = 65536 / 360;

/** Integer parameters for a tick rate (15, 20, 30 or 60: k = 60 / rate whole 60 Hz ticks per tick), for a table of ship
 *  kinds (BASE by default; the open world, world.js, passes its own with freighters and shorter guns) */
function makeParams(rate, base = BASE) {
  const k = 60 / rate;
  if (k !== Math.floor(k)) throw new Error('tick rate must divide 60');
  let fk = 1; for (let i = 0; i < k; i++) fk *= 0.985;             // friction^k (no pow)
  // Same terminal speed per second: a_k = k * a * f * (1 - f^k) / ((1 - f) * f^k)
  const accelK = (a) => Math.round(k * a * 0.985 * (1 - fk) / ((1 - 0.985) * fk) * FX);
  const kind = (b) => ({
    r: b.r, hp: b.hp, accel: accelK(b.accel),
    maxAv: Math.round(b.maxAv * k * RAD), brake: Math.round(b.brake * k * k * RAD),
    gun: b.gun && { spd: b.gun.spd * k * FX, life: Math.max(1, Math.round(b.gun.life / k)), dmg: b.gun.dmg,
      cd: Math.max(1, Math.round(b.gun.cd / k)), gimbal: Math.round(b.gun.gimbalDeg * DEG), tol: Math.round(b.gun.tolDeg * DEG) },
    tur: b.tur && { spd: b.tur.spd * k * FX, life: Math.max(1, Math.round(b.tur.life / k)), dmg: b.tur.dmg,
      cd: Math.max(1, Math.round(b.tur.cd / k)), slew: Math.round(b.tur.slew * k * RAD), arc: Math.round(b.tur.arcDeg * DEG),
      tol: Math.round(b.tur.tolDeg * DEG), off: b.tur.off },
  });
  return {
    rate, k,
    friction: Math.round(fk * FX),
    steerGain: Math.min(FX, 32768 * k),        // turnGain 0.5 a 60 Hz tick
    helmGain: Math.min(FX, 16384 * k),         // helmTurnGain 0.25
    boostMul: 22,                              // /10
    boostMax: 600, boostDrain: 6 * k, boostRegen: 2 * k,
    respawn: Math.round(150 / k),
    kinds: Object.fromEntries(Object.entries(base).map(([name, b]) => [name, kind(b)])),
  };
}

// ------------------------------------------------------------------------------------------------------------- state
function makeShip(id, kind, x, y, a, P) {
  return { id, kind, x: x * FX, y: y * FX, vx: 0, vy: 0, a: a & 0xFFFF, av: 0, tur: 0, gcd: 0, tcd: 0,
    hp: P.kinds[kind].hp, dead: 0, boost: P.boostMax, kills: 0, deaths: 0, seq: 0, aiFlip: 0 };
}

/** A fresh world. Same seed and params = same world on every machine. */
function create(P, seed, opts = {}) {
  const s = { tick: 0, rng: (seed | 0) || 1, ships: [], shots: [], events: [] };
  s.ships.push(makeShip(0, 'player', -600, 120, 0, P));
  s.ships.push(makeShip(1, 'player', 600, -120, 32768, P));
  if (opts.drones !== false) {
    s.ships.push(makeShip(2, 'drone', -150, -750, 16384, P));
    s.ships.push(makeShip(3, 'drone', 150, 750, 49152, P));
  }
  return s;
}

function cloneShip(sh) { return Object.assign({}, sh); }
function clone(s) {
  return { tick: s.tick, rng: s.rng, ships: s.ships.map(cloneShip), shots: s.shots.map((p) => Object.assign({}, p)), events: [] };
}

// ------------------------------------------------------------------------------------------------------------ flight
/** One ship's flight for one tick (the game's stepFlight, cut down: mouse-steer or helm, thrust, boost, friction, walls) */
function fly(sh, inp, P) {
  const K = P.kinds[sh.kind], b = inp.b;
  const helm = (b & IN.HELM) !== 0;
  // --- Rotation: mouse-steer spins towards the aim, braking in time (the game's steerSpin); helm chases +-max spin
  let alpha;
  if (helm) {
    const turn = ((b & IN.D) ? 1 : 0) - ((b & IN.A) ? 1 : 0);
    alpha = Math.trunc((turn * K.maxAv - sh.av) * P.helmGain / FX);
  } else {
    const err = wrapBA(inp.aim - sh.a), e = Math.abs(err), br = K.brake;
    const stop = Math.trunc((isqrt(br * br + 8 * br * e) - br) * 9 / 20);   // x 0.5 x turnBrakeMargin 0.9
    const spin = Math.min(K.maxAv, stop, Math.trunc(e * P.steerGain / FX));
    alpha = (err < 0 ? -spin : spin) - sh.av;
  }
  alpha = clamp(alpha, -K.brake, K.brake);
  sh.av = clamp(sh.av + alpha, -K.maxAv, K.maxAv);
  sh.a = (sh.a + sh.av) & 0xFFFF;

  // --- Thrust: screen-relative WASD in mouse-steer; along the nose (W/S) and sideways (Q/E) in helm
  let dx = 0, dy = 0, axes = 0;
  if (helm) {
    const f = ((b & IN.W) ? 1 : 0) - ((b & IN.S) ? 1 : 0), st = ((b & IN.E) ? 1 : 0) - ((b & IN.Q) ? 1 : 0);
    const c = icos(sh.a), s = isin(sh.a);
    dx = f * c - st * s; dy = f * s + st * c; axes = (f !== 0) + (st !== 0);
  } else {
    const ix = ((b & IN.D) ? 1 : 0) - ((b & IN.A) ? 1 : 0), iy = ((b & IN.S) ? 1 : 0) - ((b & IN.W) ? 1 : 0);
    dx = ix * FX; dy = iy * FX; axes = (ix !== 0) + (iy !== 0);
  }
  if (axes === 2) { dx = qmul(dx, 46341); dy = qmul(dy, 46341); }
  if (axes > 0) {
    let acc = K.accel;
    if ((b & IN.BOOST) && sh.boost >= P.boostDrain) { acc = Math.trunc(acc * P.boostMul / 10); sh.boost -= P.boostDrain; }
    else if (sh.boost < P.boostMax) sh.boost = Math.min(P.boostMax, sh.boost + P.boostRegen);
    sh.vx += qmul(dx, acc); sh.vy += qmul(dy, acc);
  } else if (sh.boost < P.boostMax) sh.boost = Math.min(P.boostMax, sh.boost + P.boostRegen);

  // --- Integrate (the game's: friction, then move), bounce off the arena walls
  sh.vx = qmul(sh.vx, P.friction); sh.vy = qmul(sh.vy, P.friction);
  sh.x += sh.vx; sh.y += sh.vy;
  const W = HALF_WORLD * FX;
  if (sh.x > W) { sh.x = W; sh.vx = -(sh.vx >> 1); } else if (sh.x < -W) { sh.x = -W; sh.vx = -(sh.vx >> 1); }
  if (sh.y > W) { sh.y = W; sh.vy = -(sh.vy >> 1); } else if (sh.y < -W) { sh.y = -W; sh.vy = -(sh.vy >> 1); }
}

// -------------------------------------------------------------------------------------------------------------- guns
/** Cooldowns, turret slew and firing for one tick. New shells go to `out` (they first move next tick). */
function guns(sh, inp, P, tick, out) {
  const K = P.kinds[sh.kind];
  if (sh.gcd > 0) sh.gcd--;
  if (sh.tcd > 0) sh.tcd--;
  // Fixed gun: swivels at most +-gimbal towards the cursor; fires only while the cursor is inside gimbal + tolerance
  const g = K.gun;
  if (g && (inp.b & IN.GUN) && sh.gcd === 0) {
    const rel = wrapBA(inp.aim - sh.a);
    if (Math.abs(rel) <= g.gimbal + g.tol) {
      const dir = (sh.a + clamp(rel, -g.gimbal, g.gimbal)) & 0xFFFF;
      out.push(shell(sh, 0, dir, sh.x + icos(sh.a) * K.r, sh.y + isin(sh.a) * K.r, g, tick));
      sh.gcd = g.cd;
    }
  }
  // Turret: tracks the cursor point from where it sits, at slewRate, within +-arc of the nose
  const t = K.tur;
  if (t) {
    const px = sh.x + icos(sh.a) * t.off, py = sh.y + isin(sh.a) * t.off;
    const cx = sh.x + icos(inp.aim) * inp.dist, cy = sh.y + isin(inp.aim) * inp.dist;
    const want = clamp(wrapBA(iatan2((cy - py) >> 8, (cx - px) >> 8) - sh.a), -t.arc, t.arc);
    const d = want - sh.tur;
    sh.tur += clamp(d, -t.slew, t.slew);
    if ((inp.b & IN.TURRET) && sh.tcd === 0 && Math.abs(want - sh.tur) <= t.tol) {
      out.push(shell(sh, 1, (sh.a + sh.tur) & 0xFFFF, px, py, t, tick));
      sh.tcd = t.cd;
    }
  }
}

/** A shell. Its id is worked out from tick, owner and gun, so every copy (and a predicting client) names it the same. */
function shell(sh, gun, dir, x, y, g, tick) {
  return { id: tick * 16 + sh.id * 2 + gun, o: sh.id, gun, t0: tick,
    x, y, vx: qmul(icos(dir), g.spd) + sh.vx, vy: qmul(isin(dir), g.spd) + sh.vy, life: g.life, dmg: g.dmg };
}

// ---------------------------------------------------------------------------------------------------------- drone AI
/** A drone's input for this tick, from the state alone (nearest living player, lead the shot, hold ~700 units) */
function droneInput(s, sh, P) {
  const K = P.kinds.drone;
  let best = null, bd = Infinity;
  for (let i = 0; i < N_PLAYERS; i++) {
    const p = s.ships[i];
    if (!p || p.dead) continue;
    const dx = (p.x - sh.x) >> 8, dy = (p.y - sh.y) >> 8, d2 = dx * dx + dy * dy;
    if (d2 < bd) { bd = d2; best = p; }
  }
  if (!best) return NEUTRAL;
  const dx = (best.x - sh.x) >> 16, dy = (best.y - sh.y) >> 16;
  const d = isqrt(dx * dx + dy * dy);
  // Lead: where the target will be when the shell gets there
  const tt = Math.min(90, Math.floor(d * FX / K.gun.spd));
  const lx = dx + Math.trunc(best.vx * tt / FX), ly = dy + Math.trunc(best.vy * tt / FX);
  const aim = iatan2(ly, lx);
  // Movement: close in or back off along the line, circle round it (the way flips now and then, from the RNG)
  if (s.tick % 240 === sh.id * 37 % 240) sh.aiFlip = rngNext(s) & 1;
  const want = d > 900 ? 1 : d < 550 ? -1 : 0, side = sh.aiFlip ? 1 : -1;
  const ux = d > 0 ? Math.trunc(dx * FX / d) : 0, uy = d > 0 ? Math.trunc(dy * FX / d) : 0;
  const mx = want * ux - side * uy, my = want * uy + side * ux, thr = 25000;
  let b = 0;
  if (mx > thr) b |= IN.D; else if (mx < -thr) b |= IN.A;
  if (my > thr) b |= IN.S; else if (my < -thr) b |= IN.W;
  if (d < 1500) b |= IN.GUN;
  return { b, aim, dist: Math.min(d, 2000), seq: 0 };
}

// -------------------------------------------------------------------------------------------------------- one tick
/** Shell vs ship: does the segment it covers this tick pass within r of the ship's centre? (Q8 maths, deterministic) */
function sweptHit(p, sh, r) {
  const px = p.x >> 8, py = p.y >> 8, vx = p.vx >> 8, vy = p.vy >> 8;
  const cx = (sh.x >> 8) - px, cy = (sh.y >> 8) - py;
  const vv = vx * vx + vy * vy;
  let t = vv > 0 ? (cx * vx + cy * vy) / vv : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = cx - Math.floor(vx * t), ey = cy - Math.floor(vy * t), rr = r * 256;
  return ex * ex + ey * ey <= rr * rr;
}

/**
 * Step the world one tick. `inputs[i]` is player i's input for this tick (missing = neutral). Fixed order: ships by id
 * (respawn, AI, flight, guns), then shells in spawn order (move, hit, expire), then this tick's new shells join.
 * s.events gets this tick's fire and hit events (the server style sends them on).
 */
function step(s, inputs, P) {
  s.tick++;
  s.events = [];
  const born = [];
  for (const sh of s.ships) {
    const K = P.kinds[sh.kind];
    if (sh.kind !== 'drone') sh.seq = (inputs[sh.id] || NEUTRAL).seq;
    if (sh.dead > 0) {
      if (--sh.dead === 0) {
        sh.x = rngRange(s, -1200, 1200) * FX; sh.y = rngRange(s, -1200, 1200) * FX;
        sh.vx = sh.vy = sh.av = sh.tur = 0; sh.a = rngNext(s) & 0xFFFF; sh.hp = K.hp; sh.boost = P.boostMax;
      }
      continue;
    }
    const inp = sh.kind === 'drone' ? droneInput(s, sh, P) : (inputs[sh.id] || NEUTRAL);
    fly(sh, inp, P);
    guns(sh, inp, P, s.tick, born);
  }
  const keep = [];
  for (const p of s.shots) {
    let hit = null;
    for (const sh of s.ships) {
      if (sh.id === p.o || sh.dead) continue;
      if (sweptHit(p, sh, P.kinds[sh.kind].r + 4)) { hit = sh; break; }
    }
    p.x += p.vx; p.y += p.vy; p.life--;
    if (hit) {
      hit.hp -= p.dmg;
      hit.vx += Math.trunc(p.vx * p.dmg / 300); hit.vy += Math.trunc(p.vy * p.dmg / 300);   // knockback
      if (hit.hp <= 0) {
        hit.hp = 0; hit.dead = P.respawn; hit.deaths++;
        const killer = s.ships[p.o]; if (killer) killer.kills++;
      }
      s.events.push({ k: 'hit', id: p.id, target: hit.id, tick: s.tick, x: p.x, y: p.y });
    } else if (p.life > 0) keep.push(p);
  }
  for (const p of born) { keep.push(p); s.events.push({ k: 'fire', shot: p }); }
  s.shots = keep;
}

/** Step a single ship alone (the current style's client prediction of its own ship). New shells go to `out`. */
function stepOne(sh, inp, P, tick, out) {
  sh.seq = inp.seq;
  if (sh.dead > 0) { if (sh.dead > 1) sh.dead--; return; }   // (respawn needs the server's RNG: wait for it)
  fly(sh, inp, P);
  guns(sh, inp, P, tick, out);
}

// ------------------------------------------------------------------------------------------------------------- hash
function hash(s) {
  let h = 0x811c9dc5 | 0;
  const mix = (v) => { h = Math.imul(h ^ (v | 0), 16777619); h ^= h >>> 15; };
  mix(s.tick); mix(s.rng);
  for (const sh of s.ships) {
    mix(sh.id); mix(sh.x); mix(sh.y); mix(sh.vx); mix(sh.vy); mix(sh.a); mix(sh.av); mix(sh.tur);
    mix(sh.gcd); mix(sh.tcd); mix(sh.hp); mix(sh.dead); mix(sh.boost); mix(sh.kills); mix(sh.deaths); mix(sh.aiFlip);
  }
  mix(s.shots.length);
  for (const p of s.shots) { mix(p.id); mix(p.x); mix(p.y); mix(p.vx); mix(p.vy); mix(p.life); mix(p.dmg); }
  return h >>> 0;
}

/** Do two copies of a ship match exactly (the fields flight, guns and damage touch)? */
function shipEqual(a, b) {
  return a.x === b.x && a.y === b.y && a.vx === b.vx && a.vy === b.vy && a.a === b.a && a.av === b.av && a.tur === b.tur &&
    a.gcd === b.gcd && a.tcd === b.tcd && a.hp === b.hp && a.dead === b.dead && a.boost === b.boost;
}

NL.Sim = { FX, HALF_WORLD, N_PLAYERS, IN, NEUTRAL, sameInput, makeParams, create, clone, cloneShip, step, stepOne, hash,
  shipEqual, iatan2, isin, icos, wrapBA, isqrt, RAD, DEG, BASE,
  // (the pieces the open world, world.js, builds on)
  fly, guns, sweptHit, rngNext, qmul, clamp };
// Shared by the page (a plain <script>) and the Node server (server/shared.js runs it in its global scope; a CommonJS
// require works as well): everything hangs off one NL namespace on the global object.
if (typeof module === 'object' && module.exports) module.exports = NL;
})(globalThis.NL = globalThis.NL || {});
