/**
 * @contract power.ports-core
 * owns:       the ports energy core's tick: per-tick offer / accept / apply across shared edges, feed layer (tanks, pipes,
 *             selectors, combiners), guns' gates, beams, mining; re-exports portsTypes / portsBuild / portsState / portsWire
 * needs:      portsTypes, portsState, common/ships types
 * invariants: the reference ships feed every consumer, share power and burn their feeds as designed —
 *             common/src/ships/power/ports.test.ts
 *             feature parts (strafer, gyro, machines) draw through the ports core —
 *             common/src/ships/power/portsFeatures.test.ts
 * extend:     a new port consumer is a part kind constant (P_*) with a case in buildPortsLayout and portsTick;
 *             mechanics first, no ship-level routing
 */

/**
 * The ports energy core (docs/design/energy-ports-2026-11.md; the Energy Lab's prototypes/energy-lab/ports-model.js is
 * the reference): every ship runs on it. Power moves only out of
 * an out port into an in port across a shared cell edge, in a synchronous tick (offer, accept, apply, then the consumers
 * act), so the server, the pilot's prediction and the hangar agree to the eu. On top, the feed layer: tanks of
 * materials joined by pipes, Selectors, Combiners that put a material onto a power line, and feed buffers on the guns and
 * engines that take one; a material reshapes a part's stats (ShipTuning.feeds). Everything that holds material holds one
 * kind until it is empty.
 *
 * Built once a rebuild (buildPortsLayout), run every tick (portsTick), never allocating per tick. Integer eu (units.ts)
 * for energy, hundredths for material, ticks for timers. All lists are in part-index order.
 */

import type { FunctionDef } from '../types.js';
import { PF_LATCH, PF_LIT, PF_SEL, PF_AUG, MAT_UNIT, MAT_RATE, TPS, P_RELAY, P_WEAPON, P_TANK, type PortsLayout, type PortsState } from './portsTypes.js';
import { portsGauge, matOf, effShot, effDischarge, effRest, effSteady, effCap, effThrust } from './portsState.js';

// (The core's pieces, re-exported so importers of this file are unchanged)
export {
  TK_ENGINE, TK_STRAFER, TK_GYRO, MACHINE_FAB, MACHINE_REF, machineBit,
  P_INERT, P_GEN, P_RELAY, P_THRUSTER, P_TOOL, P_WEAPON, P_TANK, P_SELECTOR, P_PIPE,
  PF_LATCH, PF_LIT, PF_SEL, PF_AUG, PF_MASK, MAT_UNIT,
} from './portsTypes.js';
export type { PortSpec, EdgeSpec, FeedDef, PortsWeaponInput, PortsLayoutInput, PortsLayout, PortsState } from './portsTypes.js';
export * from './portsBuild.js';
export {
  createPortsState, fullPorts, remapPorts, remapPortsByIndex, portsGauge, portsGaugePct,
  portsMachinePart, setPortsMachine, portsMachineEu, matOf, effShot, effCap, effThrust,
} from './portsState.js';
export * from './portsWire.js';

// ================================================================ the tick
export interface PortsControls {
  /** By part: 1 for a thruster pushing this tick; null: none */
  active: Uint8Array | null;
  /** By part: the share of its burn an active thruster wants this tick (0..1; a Gyro's by how much of its torque the turn
   * used, a Burst Strafer's by how much of its push goes the dodge's way). Null, or 0 for a part: its whole burn */
  scale?: Float64Array | null;
  boosting: boolean;
  /** By part: eu each tool wants this tick; null: its full rate */
  toolWant: Int32Array | null;
  /** The guns' triggers (beams light and burn in portsBeamStep; this is for the latch of clips): the Reload input */
  reload: boolean;
}
let sOffer = new Int32Array(16), sSend = new Int32Array(16), sInNow = new Int32Array(16), sOutNow = new Int32Array(16), sFrac = new Float64Array(16), sMul = new Float64Array(16), sMatIn = new Int32Array(16), sBurnNow = new Int32Array(16);
let sList = new Int32Array(16), sWant = new Int32Array(16), sAugIn = new Int32Array(16);
function grow(nl: number, np: number): void {
  if (sOffer.length < nl) { const m = Math.max(nl, sOffer.length * 2); sOffer = new Int32Array(m); sSend = new Int32Array(m); }
  if (sInNow.length < np) { const m = Math.max(np, sInNow.length * 2); sInNow = new Int32Array(m); sOutNow = new Int32Array(m); sFrac = new Float64Array(m); sMul = new Float64Array(m); sMatIn = new Int32Array(m); sBurnNow = new Int32Array(m); sAugIn = new Int32Array(m); }
  // (sList and sWant hold link ids as well as part ids)
  const k = Math.max(nl, np);
  if (sList.length < k) { const m = Math.max(k, sList.length * 2); sList = new Int32Array(m); sWant = new Int32Array(m); }
}
/** Thruster parts: the share of its burn each got this tick (1 when inactive), and its boost multiplier. Module scratch, valid straight after portsTick */
export function portsThrustFrac(): Float64Array { return sFrac; }
export function portsThrustMul(): Float64Array { return sMul; }
/** Per part, eu that arrived this tick (the hangar's flow) */
export function portsInflow(): Int32Array { return sInNow; }
/** Per link, eu that crossed it this tick (the hangar's link overlay). Module scratch, valid straight after portsTick */
export function portsLinkSend(): Int32Array { return sSend; }

/** Water-fill `supply` over the wants in sList[0..cnt) (sWant by part), smallest want first; writes the grants back into sWant */
function waterfill(cnt: number, supply: number): void {
  // (insertion sort by want, ties by part index: deterministic)
  for (let y = 1; y < cnt; y++) { const v = sList[y], w = sWant[v]; let x = y; while (x > 0 && (sWant[sList[x - 1]] > w || (sWant[sList[x - 1]] === w && sList[x - 1] > v))) { sList[x] = sList[x - 1]; x--; } sList[x] = v; }
  let left = supply < 0 ? 0 : supply, k = cnt;
  for (let y = 0; y < cnt; y++) { const p = sList[y], share = Math.floor(left / k--), g = sWant[p] < share ? sWant[p] : share; sWant[p] = g > 0 ? g : 0; left -= sWant[p]; }
}
/** A taker's space this tick: its room, or nothing while its ports are shut (discharge, rest, a lit burst beam). Exported as portsSpace for the hangar's load test */
export function portsSpace(L: PortsLayout, e: PortsState, p: number): number { return spaceOf(L, e, p); }
function spaceOf(L: PortsLayout, e: PortsState, p: number): number {
  if (L.role[p] === P_RELAY) return L.cap[p] - e.held[p];
  if (L.role[p] === P_WEAPON && (e.closed[p] > 0 || (L.burst[p] && (e.flags[p] & PF_LIT)))) return 0;
  if (L.gun[p] === 2 && !(e.flags[p] & PF_LATCH)) return 0;
  const c = L.role[p] === P_WEAPON ? effCap(L, e, p) : L.cap[p];
  const r = c - e.held[p];
  return r > 0 ? r : 0;
}
/** What a network can give now: its own tanks' material (the most plentiful kind), else what the live Selector feeding it passes. Returns the feed index, and leaves the giving network in supplyNet */
let supplyNet = -1;
function supplyOf(L: PortsLayout, e: PortsState, net: number, depth = 0): number {
  if (net < 0 || depth > 6) return 0;
  const N = L.nets[net];
  let best = 0, bestAmt = 0;
  for (let f = 1; f < L.feeds.length; f++) { let a = 0; for (const t of N.tanks) if (L.tankFeed[t] === f) a += e.held[t]; if (a > bestAmt) { bestAmt = a; best = f; } }
  if (best) { supplyNet = net; return best; }
  for (const s of N.selectors) { const r = supplyOf(L, e, L.selIn[2 * s + ((e.flags[s] & PF_SEL) ? 1 : 0)], depth + 1); if (r) return r; }
  return 0;
}
function drawMat(L: PortsLayout, e: PortsState, net: number, f: number, u: number): number {
  const N = L.nets[net]; let have = 0;
  for (const t of N.tanks) if (L.tankFeed[t] === f) have += e.held[t];
  if (have <= 0 || u <= 0) return 0;
  const take = u < have ? u : have; let left = take;
  for (const t of N.tanks) { if (L.tankFeed[t] !== f || left <= 0) continue; const g = Math.min(e.held[t], Math.ceil((take * e.held[t]) / have), left); e.held[t] -= g; left -= g; }
  // (rounding: whatever is left comes off the fullest)
  if (left > 0) for (const t of N.tanks) { if (L.tankFeed[t] !== f || left <= 0) continue; const g = Math.min(e.held[t], left); e.held[t] -= g; left -= g; }
  return take - left;
}
const accepts = (L: PortsLayout, e: PortsState, p: number, f: number): boolean => !(e.amt[p] > 0 && e.mat[p] !== f) && (L.takes[p] === -1 || L.role[p] === P_RELAY || (L.takes[p] & (1 << (f - 1))) !== 0);

/** Grant `space` over taker p's in links [a, b) (only those whose augment flag is `aug`; -1 all), water-filled by offer */
function takeOver(L: PortsLayout, a: number, b: number, aug: number, space: number): void {
  const offer = sOffer, send = sSend;
  let cnt = 0;
  for (let x = a; x < b; x++) { const l = L.inLink[x]; if (aug >= 0 && L.linkAug[l] !== aug) continue; sList[cnt++] = l; sWant[l] = offer[l]; }
  if (!cnt) return;
  if (cnt === 1) { const l = sList[0]; send[l] = offer[l] < space ? offer[l] : space; return; }
  waterfill(cnt, space);
  for (let y = 0; y < cnt; y++) { const l = sList[y]; send[l] = sWant[l]; }
}

/** One tick. After it portsThrustFrac()/portsThrustMul() hold each thruster's share and boost; the guns are gated by portsGunReady etc. */
export function portsTick(L: PortsLayout, e: PortsState, ctl: Readonly<PortsControls>): void {
  grow(L.links, L.n);
  const held = e.held, cap = L.cap, nl = L.links, offer = sOffer, send = sSend;
  // 1. Offer: a generator the cap on every link; a relay what it holds, water-filled over its out links
  for (let l = 0; l < nl; l++) offer[l] = 0;
  for (const g of L.gens) {
    if (L.touchClus[g] < 0) { for (let x = L.outStart[g]; x < L.outStart[g + 1]; x++) { const l = L.outLink[x]; offer[l] = L.linkCap[l]; } continue; }
    if (L.touchClus[g] !== g) continue;
    // (A block of touch generators: its output water-filled over all its members' links, each wanting what its taker has
    // room for this tick)
    let cnt = 0;
    for (let m = g; m >= 0; m = L.touchNext[m]) for (let x = L.outStart[m]; x < L.outStart[m + 1]; x++) {
      const l = L.outLink[x], t = L.linkTo[l];
      let room = spaceOf(L, e, t); if (L.role[t] === P_WEAPON && room > L.rate[t]) room = L.rate[t];
      sList[cnt++] = l; sWant[l] = room < L.linkCap[l] ? room : L.linkCap[l];
    }
    if (!cnt) continue;
    waterfill(cnt, L.touchOut[g]);
    for (let m = g; m >= 0; m = L.touchNext[m]) for (let x = L.outStart[m]; x < L.outStart[m + 1]; x++) { const l = L.outLink[x]; offer[l] = sWant[l]; }
  }
  for (const s of L.relays) {
    const a = L.outStart[s], b = L.outStart[s + 1]; if (a === b) continue;
    if (b - a === 1) { const l = L.outLink[a]; offer[l] = held[s] < L.linkCap[l] ? held[s] : L.linkCap[l]; continue; }
    let cnt = 0; for (let x = a; x < b; x++) { const l = L.outLink[x]; sList[cnt++] = l; sWant[l] = L.linkCap[l]; }
    waterfill(cnt, held[s]);
    for (let x = a; x < b; x++) { const l = L.outLink[x]; offer[l] = sWant[l]; }
  }
  // 2. Accept: each taker up to its space, water-filled over its in links. A weapon takes at most its own intake (its
  // rhythm), and into its augment buffer only along its augment lines
  for (let l = 0; l < nl; l++) send[l] = 0;
  for (let p = 0; p < L.n; p++) {
    const a = L.inStart[p], b = L.inStart[p + 1]; if (a === b) continue;
    let space = spaceOf(L, e, p);
    if (L.role[p] === P_WEAPON && space > L.rate[p]) space = L.rate[p];
    if (L.augCap[p] === 0) { takeOver(L, a, b, -1, space); continue; }
    takeOver(L, a, b, 0, space);
    const room = L.augCap[p] - e.aug[p];
    takeOver(L, a, b, 1, room < L.augRate[p] ? (room > 0 ? room : 0) : L.augRate[p]);
  }
  // 3. Apply
  for (let p = 0; p < L.n; p++) { sInNow[p] = 0; sOutNow[p] = 0; sAugIn[p] = 0; }
  for (let l = 0; l < nl; l++) { const s = send[l]; if (s > 0) { sOutNow[L.linkFrom[l]] += s; if (L.linkAug[l]) sAugIn[L.linkTo[l]] += s; else sInNow[L.linkTo[l]] += s; } }
  for (const s of L.relays) held[s] += sInNow[s] - sOutNow[s];
  for (const c of L.consumers) { held[c] += sInNow[c]; e.aug[c] += sAugIn[c]; }
  // 4. Material: drawers pull from their networks; then along the lines, line to line and line into a gun or engine
  const step = Math.round((MAT_RATE * MAT_UNIT) / TPS);
  for (const p of L.drawers) {
    const room = L.matCap[p] - e.amt[p]; if (room <= 0) continue;
    const f = supplyOf(L, e, L.netOf[p]); if (!f || !accepts(L, e, p, f)) continue;
    const got = drawMat(L, e, supplyNet, f, room < step ? room : step);
    if (got > 0) { e.mat[p] = f; e.amt[p] += got; }
  }
  for (const a of L.carriers) {
    if (e.amt[a] <= 0) continue;
    const o0 = L.outStart[a], o1 = L.outStart[a + 1], outs = o1 - o0; if (!outs) continue;
    const f = e.mat[a];
    for (let x = o0; x < o1 && e.amt[a] > 0; x++) {
      const b = L.linkTo[L.outLink[x]];
      if (!L.matCap[b] || (L.role[b] !== P_RELAY && L.feedPort[b]) || !accepts(L, e, b, f)) continue;
      if (L.role[b] === P_RELAY && !L.carrier[b]) continue;
      let mv = Math.floor(e.amt[a] / outs); if (mv < 1) mv = e.amt[a];
      const room = L.matCap[b] - e.amt[b]; if (mv > room) mv = room; if (mv > step) mv = step;
      if (mv <= 0) continue;
      e.mat[b] = f; e.amt[b] += mv; e.amt[a] -= mv;
    }
    if (e.amt[a] <= 0) { e.amt[a] = 0; e.mat[a] = 0; }
  }
  // 5. Consumers act. Thrusters burn (boost as P1: it boosts only when that gives more thrust than cruising)
  const active = ctl.active, scale = ctl.scale ?? null;
  for (const p of L.thrusters) {
    const on = active !== null && active[p] !== 0;
    if (!on) { sFrac[p] = 1; sMul[p] = 1; sBurnNow[p] = 0; continue; }
    const f = matOf(L, e, p), at = p * L.feeds.length + f;
    const sc = scale !== null && scale[p] > 0 && scale[p] < 1 ? scale[p] : 1;
    const bm = (f ? L.mBurn[at] : 1) * sc, tm = f ? L.mThrust[at] : 1, bo = f ? L.boostMul[p] * L.mBoost[at] : L.boostMul[p];
    // (a feature's thruster asked for a sliver of its burn (a gyro's tiny correction) may burn nothing: it's met)
    const b = Math.max(sc < 1 ? 0 : 1, Math.round(L.burn[p] * bm)), bb = Math.max(b, Math.round(L.bBurn[p] * bm * (f ? L.mBoostDrain[at] : 1)));
    const h = held[p];
    let use = h < b ? h : b, frac = b > 0 ? use / b : 1, mulT = tm;
    if (ctl.boosting && bo > 1 && bb > b) {
      const useB = h < bb ? h : bb, tB = (bo * useB) / bb, tC = frac;
      if (tB > tC) { use = useB; frac = useB / bb; mulT = tm * bo; }
    }
    held[p] = h - use; sFrac[p] = frac; sMul[p] = mulT; sBurnNow[p] = use;
    if (f && e.amt[p] >= L.matUse[p]) e.amt[p] -= L.matUse[p];
  }
  // Tools: what each wants this tick, from its one-second buffer
  const tw = ctl.toolWant;
  let shW = 0, shG = 0;
  for (const p of L.tools) {
    // (A mining laser draws by its pulse: portsMineStep)
    if (L.miner[p]) continue;
    // (A field machine draws its rate only while its bit is on: PortsState.mach)
    const mk = L.machine[p];
    const w = mk ? ((e.mach & (1 << (mk - 1))) !== 0 ? L.rate[p] : 0) : tw ? tw[p] : L.rate[p], want = w > 0 ? w : 0, got = held[p] < want ? held[p] : want;
    held[p] -= got;
    e.sat[p] = want > 0 ? Math.round((255 * got) / want) : 255;
    if (mk) e.machEu[mk] += got;
    if (L.shield[p]) { shW += want; shG += got; }
  }
  e.shieldSat = shW > 0 ? Math.round((255 * shG) / shW) : 255;
  // Weapons: timers, the clip latch, the steady collapse, the passive leak (the firing itself is the guns' step)
  for (const p of L.weapons) {
    if (e.closed[p] > 0) e.closed[p]--;
    if (L.gun[p] === 2) {
      // (a clip reloads the whole magazine: latched until full; Reload latches any clip not full)
      const c = effCap(L, e, p);
      if (!(e.flags[p] & PF_LATCH) && ((ctl.reload && held[p] < c) || held[p] < effShot(L, e, p) * L.rounds[p])) e.flags[p] |= PF_LATCH;
      if ((e.flags[p] & PF_LATCH) && held[p] >= c) e.flags[p] &= ~PF_LATCH;
    }
    const st = effSteady(L, e, p), shut = e.closed[p] > 0 || (e.flags[p] & PF_LIT) !== 0 || (L.gun[p] === 2 && !(e.flags[p] & PF_LATCH));
    // (A beam in pieces keeps its whole pieces: only the piece filling collapses)
    if (st > 0 && !shut && held[p] > 0 && held[p] < effCap(L, e, p) - 2 * L.passive[p] - L.rate[p] && sInNow[p] < st) held[p] = L.pieces[p] ? held[p] - (held[p] % L.pieceE[p]) : 0;
    if (L.augSteady[p] > 0 && e.aug[p] > 0 && e.aug[p] < L.augCap[p] - L.augRate[p] && sAugIn[p] < L.augSteady[p]) e.aug[p] = 0;
    // (Its passive leaks while it charges; a beam in pieces, burning or cooling down, holds its whole pieces)
    if (L.passive[p] > 0 && !(L.pieces[p] && shut)) { held[p] -= L.passive[p]; if (held[p] < 0) held[p] = 0; }
    if (e.amt[p] <= 0) { e.amt[p] = 0; e.mat[p] = 0; }
  }
  for (const p of L.thrusters) if (e.amt[p] <= 0) { e.amt[p] = 0; e.mat[p] = 0; }
  e.gauge = portsGauge(L, e);
}

/** Thrusters alone, intake assumed met (replicas): each buffer refills at its full intake, then burns */
function portsThrustersFree(L: PortsLayout, e: PortsState, ctl: Readonly<PortsControls>): void {
  grow(L.links, L.n);
  for (const p of L.thrusters) { const room = L.cap[p] - e.held[p]; e.held[p] += room < L.rate[p] ? (room > 0 ? room : 0) : L.rate[p]; }
  const active = ctl.active;
  for (const p of L.thrusters) {
    const on = active !== null && active[p] !== 0;
    if (!on) { sFrac[p] = 1; sMul[p] = 1; continue; }
    const b = L.burn[p], h = e.held[p], use = h < b ? h : b;
    e.held[p] = h - use; sFrac[p] = b > 0 ? use / b : 1; sMul[p] = effThrust(L, e, p);
  }
}

// ---- The guns' gates (guns.ts)
/** A shot's worth is held, the gun isn't latched and its ports aren't shut; a gun that needs feed has it */
export function portsGunReady(L: PortsLayout, e: PortsState, p: number, n = L.rounds[p] || 1): boolean {
  if (e.flags[p] & PF_LATCH) return false;
  if (L.feedPort[p] === 2 && !matOf(L, e, p)) return false;
  return e.held[p] >= effShot(L, e, p) * n;
}
let lastAug = false;
/** Whether the shot portsSpendShot last paid for was augmented (its augment buffer held the cost, and paid it) */
export function portsShotAugmented(): boolean { return lastAug; }
/** Pay for a shot: eu off the buffer, material off the feed buffer, the ports shut for the discharge; the augment off its own buffer when it holds it. Returns the damage multiplier its material and tier give */
export function portsSpendShot(L: PortsLayout, e: PortsState, p: number, n = L.rounds[p] || 1): number {
  const f = matOf(L, e, p), s = effShot(L, e, p) * n, h = e.held[p], paid = h < s ? h : s;
  const dmg = (f ? L.mDamage[p * L.feeds.length + f] : 1) * L.tierDmg[p];
  lastAug = L.augCap[p] > 0 && e.aug[p] >= L.augCost[p] * n;
  if (lastAug) e.aug[p] -= L.augCost[p] * n;
  e.held[p] = h - paid;
  const d = effDischarge(L, e, p); if (d > 0) e.closed[p] = d > 32000 ? 32000 : d;
  if (f) { e.amt[p] -= L.matUse[p] * n; if (e.amt[p] <= 0) { e.amt[p] = 0; e.mat[p] = 0; } }
  if (L.gun[p] === 2 && e.held[p] < s) e.flags[p] |= PF_LATCH;
  return dmg;
}
/** What a gun's hits are worth on a ports ship: its tier's damage and its material's (beams and pulses: the server's fireBeam) */
export function portsDamageMul(L: PortsLayout, e: PortsState, p: number): number {
  const f = matOf(L, e, p);
  return (f ? L.mDamage[p * L.feeds.length + f] : 1) * L.tierDmg[p] * ((e.flags[p] & PF_AUG) !== 0 ? L.augDps[p] : 1) * portsPieceSpike(L, p, portsPiecePhase(L, e, p));
}
/** A beam's tick while the trigger's held: lights when it may (a burst beam only when full), burns a tick's worth, goes out and rests when it can't. Returns eu burnt
 * (a beam in pieces: piecesStep, called whatever the trigger while a piece burns) */
export function portsBeamStep(L: PortsLayout, e: PortsState, p: number, trigger: boolean): number {
  if (L.pieces[p]) return piecesStep(L, e, p, trigger);
  let fl = e.flags[p];
  if (!trigger) { e.flags[p] = fl & ~(PF_LIT | PF_AUG); return 0; }
  const f = matOf(L, e, p), b = f ? Math.max(1, Math.round(L.shot[p] * L.mBurn[p * L.feeds.length + f])) : L.shot[p], h = e.held[p];
  if (L.feedPort[p] === 2 && !f) { e.flags[p] = fl & ~PF_LIT; return 0; }
  const light = L.burst[p] ? L.cap[p] - 2 * L.passive[p] - 1 : L.relight[p];
  if (!(fl & PF_LIT) && e.closed[p] === 0 && h >= light && h >= b) fl = (fl | PF_LIT) & ~PF_LATCH;
  if (fl & PF_LIT) {
    if (h >= b) {
      e.held[p] = h - b;
      // (Augmented while its augment buffer pays a tick's cost)
      if (L.augCap[p] > 0 && e.aug[p] >= L.augCost[p]) { e.aug[p] -= L.augCost[p]; fl |= PF_AUG; } else fl &= ~PF_AUG;
      e.flags[p] = fl;
      if (f) { e.amt[p] -= L.matUse[p]; if (e.amt[p] <= 0) { e.amt[p] = 0; e.mat[p] = 0; } }
      return b;
    }
    fl = (fl & ~(PF_LIT | PF_AUG)) | PF_LATCH;
    const r = effRest(L, e, p); if (r > 0) e.closed[p] = r > 32000 ? 32000 : r;
  }
  e.flags[p] = fl;
  return 0;
}
// ---- Beams in pieces (FunctionDef.profile.pieces; Kieran, 2026-11-04). The buffer is N equal pieces. A press with a whole
// piece held spends it at once and burns for pieceT ticks, whatever the trigger does meanwhile; held when it ends, with
// another whole piece, the next starts on that tick (a chain); otherwise the beam goes out and its ports stay shut `rest`
// ticks (the cooldown) before it charges again. A piece only part full never fires, and spending a whole piece throws the
// part-filled one away. Its ports are shut from the press to the cooldown's end. While lit, `closed` counts the piece's
// ticks left (so the wire's closed field carries it: PORTS_SLOT_LAYOUT); after, the cooldown's
/** Whole pieces a beam holds (with a passive's slack: a full buffer leaking its passive each tick still holds them all) */
export function portsPiecesHeld(L: PortsLayout, e: PortsState, p: number): number {
  const pe = L.pieceE[p];
  if (!L.pieces[p] || pe <= 0) return 0;
  const k = Math.floor((e.held[p] + 2 * L.passive[p] + 1) / pe);
  return k < L.pieces[p] ? k : L.pieces[p];
}
/** Ticks into the piece burning now (0 on the tick it was spent), or -1 */
export function portsPiecePhase(L: PortsLayout, e: PortsState, p: number): number {
  return L.pieces[p] && (e.flags[p] & PF_LIT) ? L.pieceT[p] - e.closed[p] : -1;
}
/** A piece is burning (portsBeamStep must be called this tick, trigger or not, to burn it, end it or chain the next) */
export function portsPieceLit(L: PortsLayout, e: PortsState, p: number): boolean {
  return L.pieces[p] !== 0 && (e.flags[p] & PF_LIT) !== 0;
}
/** A piece's damage x at `phase` ticks in: the centre spike, the same total a piece (1 outside a piece) */
export function portsPieceSpike(L: PortsLayout, p: number, phase: number): number {
  if (!L.pieces[p] || phase < 0) return 1;
  return phase >= L.spikeLo[p] && phase < L.spikeHi[p] ? L.spikeIn[p] : L.spikeOut[p];
}
function piecesStep(L: PortsLayout, e: PortsState, p: number, trigger: boolean): number {
  let fl = e.flags[p];
  if (fl & PF_LIT) {
    if (e.closed[p] > 0) return pieceBurn(L, e, p, fl);
    // (The piece is spent: the next, if held and there is one; else out, and the cooldown)
    if (trigger && pieceSpend(L, e, p)) return pieceBurn(L, e, p, e.flags[p]);
    fl &= ~(PF_LIT | PF_AUG);
    e.flags[p] = fl | PF_LATCH;
    const r = effRest(L, e, p); e.closed[p] = r > 32000 ? 32000 : r;
    return 0;
  }
  if (!trigger || e.closed[p] > 0 || !pieceSpend(L, e, p)) { if (e.closed[p] === 0) e.flags[p] = fl & ~PF_LATCH; return 0; }
  return pieceBurn(L, e, p, e.flags[p]);
}
/** Spend a whole piece (the part-filled one goes with it) and light: false when it holds none */
function pieceSpend(L: PortsLayout, e: PortsState, p: number): boolean {
  if (L.feedPort[p] === 2 && !matOf(L, e, p)) return false;
  const k = portsPiecesHeld(L, e, p);
  if (k < 1) return false;
  e.held[p] = (k - 1) * L.pieceE[p];
  e.closed[p] = L.pieceT[p];
  e.flags[p] = (e.flags[p] | PF_LIT) & ~PF_LATCH;
  return true;
}
/** A tick of a lit piece: its energy was paid when it was spent; its augment and material pay by the tick. Returns 1 (it burns) */
function pieceBurn(L: PortsLayout, e: PortsState, p: number, fl: number): number {
  if (L.augCap[p] > 0 && e.aug[p] >= L.augCost[p]) { e.aug[p] -= L.augCost[p]; fl |= PF_AUG; } else fl &= ~PF_AUG;
  e.flags[p] = fl;
  if (matOf(L, e, p)) { e.amt[p] -= L.matUse[p]; if (e.amt[p] <= 0) { e.amt[p] = 0; e.mat[p] = 0; } }
  return 1;
}
// ---- Mining lasers (Kieran, 2026-11-04): "constant feed usage, their effectiveness augmented by their energy fulfilment,
// fixed duration pulses rather than on/off as you like". A mining laser is a tool with a one-second buffer filled over its
// ports. A press starts a pulse of minePulse ticks that runs to its end whatever the button does; held when it ends, the
// next starts on the next tick. While a pulse runs it draws its rate every tick from its buffer, as a thruster burns, and
// cuts by the share of that it got (e.sat, 0..255: its fulfilment). State: PF_LIT while a pulse runs, `closed` its ticks left
/**
 * A mining laser's tick (after portsTick, with the guns): a pulse ended last tick goes out, one starts if `on`, and a
 * running one draws. Returns its fulfilment this tick (0..1, what it got of its draw), or -1 when no pulse runs
 */
export function portsMineStep(L: PortsLayout, e: PortsState, p: number, on: boolean): number {
  if (!L.miner[p]) return -1;
  let fl = e.flags[p];
  if ((fl & PF_LIT) && e.closed[p] <= 0) fl &= ~PF_LIT;
  if (!(fl & PF_LIT)) {
    if (!on) { e.flags[p] = fl; e.sat[p] = 255; return -1; }
    fl |= PF_LIT; e.closed[p] = L.minePulse[p];
  }
  e.flags[p] = fl;
  e.closed[p]--;
  const want = L.rate[p], h = e.held[p], got = h < want ? h : want;
  e.held[p] = h - got;
  e.sat[p] = want > 0 ? Math.round((255 * got) / want) : 255;
  return e.sat[p] / 255;
}
/** Ticks into the mining laser's pulse running now (0 its first), or -1 */
export function portsMinePhase(L: PortsLayout, e: PortsState, p: number): number {
  return L.miner[p] && (e.flags[p] & PF_LIT) ? L.minePulse[p] - 1 - e.closed[p] : -1;
}
/** Stop every mining laser's pulse (a jump, an EMP) */
export function portsMineStop(L: PortsLayout, e: PortsState): void {
  for (const p of L.tools) if (L.miner[p]) { e.flags[p] &= ~PF_LIT; e.closed[p] = 0; e.sat[p] = 255; }
}
/** Flip a Selector (or every one with part < 0) to its other input */
export function portsSwitchFeeds(L: PortsLayout, e: PortsState, part = -1): void {
  for (const s of L.selectors) if (part < 0 || s === part) e.flags[s] ^= PF_SEL;
}
/** Empty every feed buffer and line (what was in them is lost) */
function portsPurge(L: PortsLayout, e: PortsState): void {
  for (let p = 0; p < L.n; p++) if (L.role[p] !== P_TANK) { e.amt[p] = 0; e.mat[p] = 0; }
}
