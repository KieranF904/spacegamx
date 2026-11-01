/**
 * The energy tick (docs/design/energy-routing-impl.md §1.3), 60 a second, the same on the server, in the pilot's
 * prediction and in the hangar. Integer eu throughout; allocation-free (module scratch, grown to the largest layout
 * seen, as flight.ts's CTX: not re-entrant).
 *
 * Order: 0 budgets; 1 thrusters take in, then burn; 2 tools; 3 weapons take in (clips only while latched); 4 generators
 * push what's left into the relays they touch; 5 touching relays even out (one pass, in pair order); 6 dynamos; 7 gauge.
 * serve(): each phase's consumers draw from what touches them, generators first (part order), then relays fullest
 * first (ties: lower part index); each source waterfills what it may give across its consumers still wanting, smallest
 * want first. So a thruster comes first only against the sources it shares: local priority, nothing reserved.
 */

import {
  type EnergyLayout, GUN_BEAM, GUN_CLIP, PHASE_THRUST, PHASE_TOOL, PHASE_WEAPON, ROLE_GEN,
} from './layout.js';
import { type EnergyState, FLAG_LATCH, FLAG_LIT, energyGauge } from './state.js';

/** What the ship does this tick, as far as energy cares */
export interface EnergyControls {
  /** By part: 1 for a thruster pushing this tick (a main engine thrusting along the asked direction; a Burst Strafer while its burst runs; a Gyro while the ship turns). null: none */
  active: Uint8Array | null;
  /** Boost held: an active engine that can boost burns its boost when that gives more thrust than cruising */
  boosting: boolean;
  /** By part: eu each tool wants this tick (a full, idle shield 0; a miner or Tow only while working). null: every tool its full rate (tests and the hangar's worst case; the game passes real wants) */
  toolWant: Int32Array | null;
  /** The Reload input (D2): latches every clip gun that isn't full, so it refills the whole clip */
  reload: boolean;
}

/** Nothing pushing, nothing reloading, every tool at its full rate (not a sleeping ship's: settleEnergy has its own) */
export const IDLE_CONTROLS: Readonly<EnergyControls> = Object.freeze({ active: null, boosting: false, toolWant: null, reload: false });

/** Idle ticks settleEnergy simulates before it may snap the rest */
export const SETTLE_TICKS = 600;

// ---- Scratch (by part index, sized to the largest layout seen)
let sFrac = new Float64Array(16), sMul = new Float64Array(16);
let sWant = new Int32Array(16), sGot = new Int32Array(16), sGen = new Int32Array(16), sGLeft = new Int32Array(16), sTLeft = new Int32Array(16);
let sOrd = new Int32Array(16), sList = new Int32Array(16), sLink = new Int32Array(16);
/** Always zero: a sleeping ship's tools' wants (settleEnergy) */
let sZero = new Int32Array(16);
function grow(n: number): void {
  if (sWant.length >= n) return;
  const m = Math.max(n, sWant.length * 2);
  sFrac = new Float64Array(m); sMul = new Float64Array(m);
  sWant = new Int32Array(m); sGot = new Int32Array(m); sGen = new Int32Array(m); sGLeft = new Int32Array(m); sTLeft = new Int32Array(m);
  sOrd = new Int32Array(m); sList = new Int32Array(m); sLink = new Int32Array(m); sZero = new Int32Array(m);
}

// The scratch accessors below are by part index and valid only straight after the tick (energyTick, or
// stepThrustersFree for the thrust pair), and only for that layout's parts of the right role: other entries hold
// whatever the last ship ticked left there, and a bigger layout's first tick replaces the arrays (read them again).

/** Thruster parts: the share of its burn each got this tick (1 when inactive). Module scratch: see above */
export function thrustFrac(): Float64Array { return sFrac; }
/** Thruster parts: × thrust for boosting (its boostMul when boost won this tick, else 1). Module scratch: see above */
export function thrustMul(): Float64Array { return sMul; }
/** Generator parts: eu of this tick's output left over (wasted: nothing touching it wanted it). Module scratch: see above */
export function genLeft(): Int32Array { return sGen; }
/** Relay parts: eu of this tick's Gives left. Module scratch: see above */
export function givesLeft(): Int32Array { return sGLeft; }
/** Relay parts: eu of this tick's Takes left. Module scratch: see above */
export function takesLeft(): Int32Array { return sTLeft; }

/** One thruster's burn this tick (after its intake): writes sFrac/sMul */
function burnThruster(L: EnergyLayout, held: Int32Array, p: number, active: boolean, boosting: boolean): void {
  if (!active) { sFrac[p] = 1; sMul[p] = 1; return; }
  const h = held[p], b = L.burn[p], bb = L.bBurn[p];
  if (boosting && bb > b && L.boostMul[p] > 1) {
    // Boost if it gives more thrust than cruising would from the same buffer: holding boost is never slower
    const useB = h < bb ? h : bb, useC = h < b ? h : b;
    const tB = (L.boostMul[p] * useB) / bb, tC = b > 0 ? useC / b : 1;
    if (tB > tC) { held[p] = h - useB; sFrac[p] = useB / bb; sMul[p] = L.boostMul[p]; return; }
  }
  const use = h < b ? h : b;
  held[p] = h - use;
  sFrac[p] = b > 0 ? use / b : 1;
  sMul[p] = 1;
}

/** Phase k's consumers draw on their sources (sWant in, sGot out; sources' budgets spent) */
function serve(L: EnergyLayout, held: Int32Array, k: number, trace: Float64Array | null | undefined): void {
  const s0 = L.srcStart[k], r0 = L.srcRelay[k], s1 = L.srcStart[k + 1];
  if (s0 === s1) return;
  const cap = L.cap, src = L.srcPart, ord = sOrd;
  // Generators first, as listed; then relays, fullest first (insertion sort; equal fills keep the lower part index first)
  let m = 0;
  for (let j = s0; j < r0; j++) ord[m++] = j;
  for (let j = r0; j < s1; j++) {
    const a = src[j], ha = held[a], ca = cap[a];
    let x = m++;
    while (x > r0 - s0) {
      const b = src[ord[x - 1]];
      if (ha * cap[b] > held[b] * ca) { ord[x] = ord[x - 1]; x--; } else break;
    }
    ord[x] = j;
  }
  const want = sWant, got = sGot, feedStart = L.feedStart, feedCons = L.feedCons;
  for (let x = 0; x < m; x++) {
    const j = ord[x], s = src[j];
    const gen = L.role[s] === ROLE_GEN;
    const avail = gen ? sGen[s] : held[s] < sGLeft[s] ? held[s] : sGLeft[s];
    if (avail <= 0) continue;
    // Its consumers still wanting, smallest want first (ties: lower part index)
    let cnt = 0;
    for (let f = feedStart[j]; f < feedStart[j + 1]; f++) {
      const c = feedCons[f], w = want[c];
      if (w <= 0) continue;
      let y = cnt++;
      while (y > 0 && want[sList[y - 1]] > w) { sList[y] = sList[y - 1]; sLink[y] = sLink[y - 1]; y--; }
      sList[y] = c; sLink[y] = f;
    }
    if (cnt === 0) continue;
    let left = avail, kk = cnt;
    for (let y = 0; y < cnt; y++) {
      const c = sList[y], share = Math.floor(left / kk--);
      const g = want[c] < share ? want[c] : share;
      if (g <= 0) continue;
      want[c] -= g; got[c] += g; left -= g;
      if (trace) trace[sLink[y]] += g;
    }
    const used = avail - left;
    if (gen) sGen[s] -= used; else { held[s] -= used; sGLeft[s] -= used; }
  }
}

/**
 * One tick of the ship's energy. `trace` (hangar only): eu moved along each link this tick is added to it (L.links
 * long; a pair's is signed, + from pairA to pairB). After it, thrustFrac()/thrustMul() hold each thruster's share.
 */
export function energyTick(L: EnergyLayout, e: EnergyState, ctl: Readonly<EnergyControls>, trace?: Float64Array | null): void {
  grow(L.n);
  const held = e.held, flags = e.flags, cap = L.cap, rate = L.rate, cons = L.cons, ph = L.phase;
  const want = sWant, got = sGot;

  // 0. Budgets
  for (let x = 0; x < L.gens.length; x++) sGen[L.gens[x]] = rate[L.gens[x]];
  for (let x = 0; x < L.relays.length; x++) { const r = L.relays[x]; sGLeft[r] = L.give[r]; sTLeft[r] = L.take[r]; }

  // 1. Thrusters: take in (to their intake, to full), then burn
  for (let x = ph[PHASE_THRUST]; x < ph[PHASE_THRUST + 1]; x++) {
    const p = cons[x], w = cap[p] - held[p];
    want[p] = w < rate[p] ? (w > 0 ? w : 0) : rate[p]; got[p] = 0;
  }
  serve(L, held, PHASE_THRUST, trace);
  const active = ctl.active;
  for (let x = ph[PHASE_THRUST]; x < ph[PHASE_THRUST + 1]; x++) {
    const p = cons[x];
    held[p] += got[p];
    burnThruster(L, held, p, active !== null && active[p] !== 0, ctl.boosting);
  }

  // 2. Tools: what each wants this tick; sat is the share it got
  const tw = ctl.toolWant;
  for (let x = ph[PHASE_TOOL]; x < ph[PHASE_TOOL + 1]; x++) {
    const p = cons[x], w = tw ? tw[p] : rate[p];
    want[p] = w > 0 ? w : 0; got[p] = 0;
  }
  serve(L, held, PHASE_TOOL, trace);
  let shW = 0, shG = 0;
  for (let x = ph[PHASE_TOOL]; x < ph[PHASE_TOOL + 1]; x++) {
    const p = cons[x], all = got[p] + want[p];
    e.sat[p] = all > 0 ? Math.round((255 * got[p]) / all) : 255;
    if (L.shield[p]) { shW += all; shG += got[p]; }
  }
  e.shieldSat = shW > 0 ? Math.round((255 * shG) / shW) : 255;

  // 3. Weapons take in: a clip only while LATCHED (Reload latches any clip not full; one that can't fire a salvo latches itself)
  const reload = ctl.reload;
  for (let x = ph[PHASE_WEAPON]; x < ph[PHASE_WEAPON + 1]; x++) {
    const p = cons[x], room = cap[p] - held[p];
    let w = room < rate[p] ? room : rate[p];
    if (L.gun[p] === GUN_CLIP) {
      if (!(flags[p] & FLAG_LATCH) && ((reload && room > 0) || held[p] < L.shot[p] * L.rounds[p])) flags[p] |= FLAG_LATCH;
      if (!(flags[p] & FLAG_LATCH)) w = 0;
    }
    want[p] = w > 0 ? w : 0; got[p] = 0;
  }
  serve(L, held, PHASE_WEAPON, trace);
  for (let x = ph[PHASE_WEAPON]; x < ph[PHASE_WEAPON + 1]; x++) {
    const p = cons[x];
    held[p] += got[p];
    if (flags[p] & FLAG_LATCH) {
      const g = L.gun[p];
      if ((g === GUN_CLIP && held[p] >= cap[p]) || (g === GUN_BEAM && held[p] >= L.relight[p])) flags[p] &= ~FLAG_LATCH;
    }
  }

  // 4. Generators push what's left into the relays they touch (each to its Takes left and its room), smallest want first
  for (let gi = 0; gi < L.gens.length; gi++) {
    const s = L.gens[gi];
    let left = sGen[s];
    if (left <= 0) continue;
    let cnt = 0;
    for (let f = L.pushStart[gi]; f < L.pushStart[gi + 1]; f++) {
      const r = L.pushRelay[f], room = cap[r] - held[r], w = room < sTLeft[r] ? room : sTLeft[r];
      if (w <= 0) continue;
      want[r] = w;
      let y = cnt++;
      while (y > 0 && want[sList[y - 1]] > w) { sList[y] = sList[y - 1]; sLink[y] = sLink[y - 1]; y--; }
      sList[y] = r; sLink[y] = f;
    }
    for (let y = 0, kk = cnt; y < cnt; y++) {
      const r = sList[y], share = Math.floor(left / kk--);
      const g = want[r] < share ? want[r] : share;
      if (g <= 0) continue;
      held[r] += g; sTLeft[r] -= g; left -= g;
      if (trace) trace[L.linkPush + sLink[y]] += g;
    }
    sGen[s] = left;
  }

  // 5. Touching relays even out, fuller (by share) to emptier, within Gives and Takes; a one-way pair never runs backwards.
  // The even share rounds down, so a full relay would leave the next one short by up to cap[d]/cap[s] eu for ever: a
  // full relay nearer generation (L.depth) closes that gap. Only downhill, so it never bounces back
  const A = L.pairA, B = L.pairB, dir = L.pairDir, depth = L.depth;
  for (let x = 0; x < A.length; x++) {
    const a = A[x], b = B[x], fa = held[a] * cap[b], fb = held[b] * cap[a];
    if (fa === fb) continue;
    const fwd = fa > fb;
    if ((dir[x] === 1 && !fwd) || (dir[x] === 2 && fwd)) continue;
    const s = fwd ? a : b, d = fwd ? b : a;
    let t = Math.floor((held[s] * cap[d] - held[d] * cap[s]) / (cap[s] + cap[d]));
    if (t <= 0 && held[s] === cap[s] && depth[s] < depth[d]) t = cap[d] - held[d];
    if (sGLeft[s] < t) t = sGLeft[s];
    if (sTLeft[d] < t) t = sTLeft[d];
    if (held[s] < t) t = held[s];
    if (cap[d] - held[d] < t) t = cap[d] - held[d];
    if (t <= 0) continue;
    held[s] -= t; sGLeft[s] -= t; held[d] += t; sTLeft[d] -= t;
    if (trace) trace[L.linkPair + x] += fwd ? t : -t;
  }

  // 6. Dynamos top up each store they touch
  for (let di = 0; di < L.dyns.length; di++) {
    const r0 = rate[L.dyns[di]];
    for (let f = L.dynStart[di]; f < L.dynStart[di + 1]; f++) {
      const r = L.dynRelay[f], room = cap[r] - held[r], g = room < r0 ? room : r0;
      if (g <= 0) continue;
      held[r] += g;
      if (trace) trace[L.linkDyn + f] += g;
    }
  }

  // 7. Gauge
  e.gauge = energyGauge(L, e);
}

/**
 * Thrusters alone, intake assumed met (replicas and the server's shadow of them: P3): each buffer refills at its full
 * intake, then burns as in energyTick. No relays, no guns. Writes thrustFrac()/thrustMul()
 */
export function stepThrustersFree(L: EnergyLayout, e: EnergyState, ctl: Readonly<EnergyControls>): void {
  grow(L.n);
  const held = e.held, active = ctl.active;
  for (let x = L.phase[PHASE_THRUST]; x < L.phase[PHASE_THRUST + 1]; x++) {
    const p = L.cons[x], room = L.cap[p] - held[p];
    held[p] += room < L.rate[p] ? (room > 0 ? room : 0) : L.rate[p];
    burnThruster(L, held, p, active !== null && active[p] !== 0, ctl.boosting);
  }
}

/** A sleeping ship's controls (settleEnergy's default): nothing pushing, nothing reloading, every tool wanting nothing */
const SLEEP: EnergyControls = { active: null, boosting: false, toolWant: sZero, reload: false };

/**
 * Catch a sleeping ship up `ticks` idle ticks (bridge wake): up to SETTLE_TICKS simulated, then, when `ticks` is at
 * least L.fillBound, every buffer a generator or dynamo can reach is snapped full (latched clips and beams unlatched;
 * a clip that isn't latched keeps its rounds: D2, no idle reload). Asleep, by default its tools want nothing (a full,
 * idle shield; L.fillBound assumes it). Returns the ticks simulated
 */
export function settleEnergy(L: EnergyLayout, e: EnergyState, ticks: number, ctl?: Readonly<EnergyControls>): number {
  grow(L.n);
  SLEEP.toolWant = sZero;
  const c = ctl ?? SLEEP;
  const run = Math.max(0, Math.min(ticks, SETTLE_TICKS));
  for (let t = 0; t < run; t++) energyTick(L, e, c);
  if (ticks > run && ticks >= L.fillBound) {
    for (let p = 0; p < L.n; p++) {
      if (L.cap[p] <= 0 || !L.linked[p]) continue;
      if (L.gun[p] === GUN_CLIP && !(e.flags[p] & FLAG_LATCH)) continue;
      e.held[p] = L.cap[p];
      e.flags[p] &= ~FLAG_LATCH;
    }
    e.gauge = energyGauge(L, e);
  }
  return run;
}

// ---- The guns' energy gates (stepGuns calls these: P2.3). Only `held` and the latch gate a shot; nothing scales

/** A shot (`n` rounds of it; default a clip's salvo, L.rounds) is paid for and the gun isn't latched. A charge gun's timer runs only while this holds */
export function gunReady(L: EnergyLayout, e: EnergyState, p: number, n = L.rounds[p] || 1): boolean {
  return !(e.flags[p] & FLAG_LATCH) && e.held[p] >= L.shot[p] * n;
}

/** Pay for `n` rounds (on fire; default a salvo, L.rounds). A clip that can't pay for another `n` latches, and refills the whole clip. Returns eu spent (the SpendLog's) */
export function spendShot(L: EnergyLayout, e: EnergyState, p: number, n = L.rounds[p] || 1): number {
  const s = L.shot[p] * n, h = e.held[p], paid = h < s ? h : s;
  e.held[p] = h - paid;
  if (L.gun[p] === GUN_CLIP && e.held[p] < s) e.flags[p] |= FLAG_LATCH;
  return paid;
}

/** The phase consumer p is served in, or -1 when it isn't a consumer */
function consumerPhase(L: EnergyLayout, p: number): number {
  for (let k = 0; k < 3; k++) {
    for (let x = L.phase[k]; x < L.phase[k + 1]; x++) if (L.cons[x] === p) return k;
  }
  return -1;
}
function feeds(L: EnergyLayout, j: number, p: number): boolean {
  for (let f = L.feedStart[j]; f < L.feedStart[j + 1]; f++) if (L.feedCons[f] === p) return true;
  return false;
}

/**
 * Pay `eu` out of the relays that feed consumer `p` (those it touches and may draw from), fullest first (ties: lower
 * part index), outside the tick: no Gives limit (a one-off discharge: Flash, P2.4). `whole`: all or nothing. Returns
 * the eu paid. Allocation-free
 */
export function drawFromRelays(L: EnergyLayout, e: EnergyState, p: number, eu: number, whole = false): number {
  const k = consumerPhase(L, p);
  if (k < 0 || eu <= 0) return 0;
  const j0 = L.srcRelay[k], j1 = L.srcStart[k + 1], held = e.held, cap = L.cap, src = L.srcPart;
  if (whole) {
    let have = 0;
    for (let j = j0; j < j1; j++) if (feeds(L, j, p)) have += held[src[j]];
    if (have < eu) return 0;
  }
  let need = eu;
  while (need > 0) {
    let best = -1;
    for (let j = j0; j < j1; j++) {
      const r = src[j];
      if (held[r] <= 0 || !feeds(L, j, p)) continue;
      if (best < 0 || held[r] * cap[best] > held[best] * cap[r]) best = r;
    }
    if (best < 0) break;
    const t = held[best] < need ? held[best] : need;
    held[best] -= t; need -= t;
  }
  e.gauge = energyGauge(L, e);
  return eu - need;
}

/** Rounds left in a clip (whole shots held) */
export function clipRounds(L: EnergyLayout, e: EnergyState, p: number): number {
  return L.shot[p] > 0 ? Math.floor(e.held[p] / L.shot[p]) : 0;
}

/**
 * A beam's tick (stepGuns, while it has a target or the trigger's held): it lights when held and its buffer is at least
 * L.relight; while lit it burns L.shot a tick; short of that it goes out and rests (LATCH, cleared at relight by the
 * tick). Let go, it goes out. Returns eu burnt this tick (0: not firing)
 */
export function beamStep(L: EnergyLayout, e: EnergyState, p: number, trigger: boolean): number {
  let f = e.flags[p];
  if (!trigger) { e.flags[p] = f & ~FLAG_LIT; return 0; }
  const h = e.held[p], b = L.shot[p];
  if (!(f & FLAG_LIT) && h >= L.relight[p] && h >= b) f = (f | FLAG_LIT) & ~FLAG_LATCH;
  if (f & FLAG_LIT) {
    if (h >= b) { e.held[p] = h - b; e.flags[p] = f; return b; }
    f = (f & ~FLAG_LIT) | FLAG_LATCH;
  }
  e.flags[p] = f;
  return 0;
}
