/**
 * @contract power.ports-build
 * owns:       building a PortsLayout from a ship's parts (buildPortsLayout), its signature and which parts power reaches
 * needs:      portsTypes, common/ships catalog, grades, power/units
 * invariants: the reference ships feed every consumer — common/src/ships/power/ports.test.ts
 * extend:     a new port consumer's layout case is in partRoles (buildPortsLayout's first phase)
 */

import type { FunctionDef, PlacedPart, Side, Vec2, WeaponMods } from '../types.js';
import { fnOutput, isEngine, partDemand, partSupply } from '../grades.js';
import { EU, perTick, perTickUp, toEu } from './units.js';
import { buildPortsMods, portsModsSig } from './portsMods.js';
import { frameOf, placeEdge, type PartFrame } from './portsFrame.js';
export { frameOf, placeEdge, type PartFrame } from './portsFrame.js';
import { MACHINE_FAB, P_INERT, MAT_UNIT, BOOST_DRAW, TOUCH_LINE_RATE, TOUCH_LINE_HOLDS, TPS, TK_STRAFER, TK_GYRO, MACHINE_REF, P_GEN, P_RELAY, P_THRUSTER, P_TOOL, P_WEAPON, P_TANK, P_SELECTOR, P_PIPE, type EdgeSpec, type FeedDef, type PortSpec, type PortsLayout, type PortsLayoutInput, type PortsWeaponInput } from './portsTypes.js';

const OPP: Record<Side, Side> = { N: 'S', S: 'N', E: 'W', W: 'E' };

/**
 * A ports layout, in phases (each its own function below, in the order one function ran them, so the layout is the same
 * to the bit): every part's role and numbers (partRoles), its ports placed and the touch-routed parts' neighbours
 * (placePorts), the links and what each consumer's lines can bring (linkUp), the feed networks (feedNetworks), then the
 * layout and its signature
 */
export function buildPortsLayout(input: PortsLayoutInput): PortsLayout {
  const R = partRoles(input);
  const { n, feeds, feedDefs, thrustKind, role, cap, rate, burn, bBurn, boostMul, gun, shot, rounds, relight, passive, discharge, rest, burst, steady, pieces, pieceE, pieceT, spikeLo, spikeHi, spikeIn, spikeOut, augCap, augCost, augRate, augSteady, augDps, augMods, augName, tierDmg, miner, minePulse, machine, tow, flash, shield, carrier, matCap, matUse, takes, tankFeed, feedPort, mShot, mDamage, mCycle, mDischarge, mRest, mBurn, mSteady, mThrust, mBoost, mBoostDrain, supply, engineDraw, weaponDraw, strafeDraw, gyroDraw, shieldDraw, machineDraw } = R;
  const placed = placePorts(input, R);
  const { ports } = placed;
  const { linkFrom, linkTo, linkCap, linkAug, openIn, openOut, outStart, outLink, inStart, inLink, intake, touchOut, touchClus, touchNext } = linkUp(input, R, placed);
  const { fps, netOf, nets, selIn, selOut, selectors, drawers } = feedNetworks(input, R, placed);

  const list = (r: number) => { const o: number[] = []; for (let i = 0; i < n; i++) if (role[i] === r) o.push(i); return Int32Array.from(o); };
  const relays = list(P_RELAY), consumers: number[] = [];
  for (let i = 0; i < n; i++) if (role[i] === P_THRUSTER || role[i] === P_TOOL || role[i] === P_WEAPON) consumers.push(i);
  let gaugeMax = 0; for (const r of relays) gaugeMax += cap[r];
  const L: PortsLayout = {
    n, sig: 0, role, cap, rate, intake, thrustKind, burn, bBurn, boostMul, tierDmg, gun, shot, rounds, relight, passive, discharge, rest, burst, steady, pieces, pieceE, pieceT, spikeLo, spikeHi, spikeIn, spikeOut, augCap, augCost, augRate, augSteady, augDps, augMods, augName, shield, miner, minePulse, machine, tow, flash, carrier, matCap, matUse, takes, tankFeed, feedPort,
    mShot, mDamage, mCycle, mDischarge, mRest, mBurn, mSteady, mThrust, mBoost, mBoostDrain, feeds, feedDefs,
    links: linkFrom.length, linkFrom: Int32Array.from(linkFrom), linkTo: Int32Array.from(linkTo), linkCap: Int32Array.from(linkCap), linkAug: Uint8Array.from(linkAug),
    outStart, outLink: Int32Array.from(outLink), inStart, inLink: Int32Array.from(inLink), openIn, openOut,
    ports: ports.map((p) => ({ part: p.part, dir: p.dir, x: p.x, y: p.y, side: p.side, rate: p.rate, link: p.link >= 0 ? 1 : 0, l: p.link, aug: p.aug })),
    feedPts: fps.map((f) => ({ part: f.part, x: f.x, y: f.y, side: f.side, joined: f.joined, i: f.i })),
    netOf, nets, selIn, selOut, drawers: Int32Array.from(drawers),
    gens: list(P_GEN), relays, thrusters: list(P_THRUSTER), tools: list(P_TOOL), weapons: list(P_WEAPON), tanks: list(P_TANK), carriers: Int32Array.from([...relays].filter((r) => carrier[r])),
    consumers: Int32Array.from(consumers), selectors: Int32Array.from(selectors), gaugeMax, touchOut, touchClus, touchNext, supply, engineDraw, weaponDraw, strafeDraw, gyroDraw, shieldDraw, machineDraw,
  };
  L.sig = portsSig(L);
  // (Weapon modifiers: nothing at all on a ship with no working mount)
  const mod = buildPortsMods(L, input);
  if (mod) { L.mod = mod; L.sig = portsModsSig(L.sig, mod); }
  return L;
}

/** A grid cell as a map key */
const key = (x: number, y: number) => (x + 1024) * 4096 + (y + 1024);

/** Each part's role (generator, relay, tank, weapon, thruster, tool...) and its numbers, and what they add up to */
function partRoles(input: PortsLayoutInput) {
  const { parts, fns, area, mats, alive, tuning } = input;
  const n = parts.length;
  const feedTable = (tuning as { feeds?: Record<string, FeedDef> }).feeds ?? {};
  const feeds = ['', ...Object.keys(feedTable).sort()];
  const feedDefs = feeds.map((id) => (id ? feedTable[id] : null));
  const M = feeds.length - 1, W = M + 1;
  const feedIdx = (id: string | undefined) => (id ? Math.max(0, feeds.indexOf(id)) : 0);
  const health = (i: number) => input.health?.[i] ?? 1;
  const weaponOf = new Map<number, PortsWeaponInput>();
  for (const w of input.weapons ?? []) weaponOf.set(w.part, w);
  const Z = () => new Int32Array(n);
  const thrustKind = new Uint8Array(n);
  const role = new Uint8Array(n), cap = Z(), rate = Z(), burn = Z(), bBurn = Z(), boostMul = new Float64Array(n).fill(1);
  const gun = new Uint8Array(n), shot = Z(), rounds = Z(), relight = Z(), passive = Z(), discharge = Z(), rest = Z(), burst = new Uint8Array(n), steady = Z();
  const pieces = new Uint8Array(n), pieceE = Z(), pieceT = Z(), spikeLo = Z(), spikeHi = Z(), spikeIn = new Float64Array(n).fill(1), spikeOut = new Float64Array(n).fill(1);
  const augCap = Z(), augCost = Z(), augRate = Z(), augSteady = Z(), augDps = new Float64Array(n).fill(1), augMods: (WeaponMods | undefined)[] = new Array(n).fill(undefined), augName: (string | undefined)[] = new Array(n).fill(undefined);
  const tierDmg = new Float64Array(n).fill(1);
  const miner = new Uint8Array(n), minePulse = Z(), machine = new Uint8Array(n), tow = new Uint8Array(n), flash = new Uint8Array(n);
  const shield = new Uint8Array(n), carrier = new Uint8Array(n), matCap = Z(), matUse = Z(), takes = Z(), tankFeed = new Uint8Array(n), feedPort = new Uint8Array(n);
  const mul = () => new Float64Array(n * W).fill(1);
  const mShot = mul(), mDamage = mul(), mCycle = mul(), mDischarge = mul(), mRest = mul(), mBurn = mul(), mSteady = mul(), mThrust = mul(), mBoost = mul(), mBoostDrain = mul();
  let supply = 0, engineDraw = 0, weaponDraw = 0, strafeDraw = 0, gyroDraw = 0, shieldDraw = 0, machineDraw = 0;

  for (let i = 0; i < n; i++) {
    if (!alive[i]) continue;
    const fn = fns[i], a = area[i], m = mats[i];
    const out = fnOutput(fn, m);
    if (i === input.core || ((fn.store ?? 0) > 0 && !fn.tank) || fn.touch === 'relay') {
      role[i] = P_RELAY;
      // (A touch-routed line with no store of its own holds a few ticks' worth, as a Conduit does)
      cap[i] = toEu(i === input.core ? ((tuning as { energy?: { coreCapacity?: number } }).energy?.coreCapacity ?? 240) : (fn.store ?? 0) > 0 ? (fn.store ?? 0) * a * out : TOUCH_LINE_HOLDS * a);
      if (fn.relayOnly || fn.combiner || fn.pipeThrough) { carrier[i] = 1; matCap[i] = (fn.combiner ? 4 : 2) * MAT_UNIT; }
      // (A mount's reserve for its upkeep: power/portsMods.ts portsModsTick)
      if (fn.modMount) augCap[i] = toEu(fn.modMount.hold * fn.modMount.sockets.length);
    } else if (fn.tank) {
      role[i] = P_TANK;
      tankFeed[i] = feedIdx(fn.tank.feed);
      cap[i] = Math.round(fn.tank.holds * a * MAT_UNIT);
      matCap[i] = cap[i];
    } else if (fn.selector) {
      role[i] = P_SELECTOR;
    } else if (fn.pipe) {
      role[i] = P_PIPE;
    } else if (fn.hopper) {
      // (A hopper's material, in eu: no ports and no role, so it is never power; power/portsMods.ts spends it)
      cap[i] = toEu(fn.hopper.holds * a);
    } else if (fn.weapon) {
      const w = weaponOf.get(i);
      if (!w) continue;
      role[i] = P_WEAPON;
      // Its energy is its draw over its cycle (a ports ship's own draw, infra.draw, else what it draws today): a cycle gun its
      // draw over its beat, two shots held; a clip its draw over a whole clip and its reload, the clip held; a charge gun its
      // draw over its charge and cooldown; a beam a tick's draw, two seconds held. It takes 1.5x its draw a tick, so a starved
      // gun catches up; a floored one only a little over (its floor is its pace)
      const f = w.fire, inf = fn.infra, draw = inf?.draw ?? partDemand(fn, a, m), pr = fn.profile ?? {};
      weaponDraw += draw;
      rounds[i] = 1;
      rate[i] = perTickUp((pr.steady ? 1.1 : 1.5) * draw);
      if (f.model === 'beam') {
        gun[i] = 3; shot[i] = draw > 0 ? Math.max(1, perTick(draw)) : 0; cap[i] = toEu(2 * draw);
        relight[i] = Math.floor(cap[i] * (f.relight ?? 0.5));
      } else if (f.model === 'clip') {
        const clip = Math.max(1, Math.round(f.clip ?? 1)), cycle = clip * w.interval + (f.reload ?? 60);
        gun[i] = 2; shot[i] = toEu((draw * cycle) / 60 / clip); cap[i] = shot[i] * clip;
        if (shot[i] > 0) rounds[i] = Math.max(1, Math.min(Math.round(f.rounds ?? 1), clip));
      } else if (f.model === 'charge') {
        gun[i] = 1; shot[i] = toEu((draw * ((f.charge ?? 60) + (f.cooldown ?? 0))) / 60); cap[i] = shot[i];
      } else {
        gun[i] = 1; shot[i] = f.model === 'ammo' ? 0 : toEu((draw * w.interval) / 60); cap[i] = 2 * shot[i];
      }
      passive[i] = perTick(pr.passive ?? 0); discharge[i] = Math.round((pr.discharge ?? 0) * TPS); rest[i] = Math.round((pr.rest ?? 0) * TPS);
      tierDmg[i] = inf?.damage ?? 1;
      burst[i] = pr.burst ? 1 : 0; steady[i] = perTick(pr.steady ?? 0);
      if (gun[i] === 3 && (pr.pieces ?? 0) >= 1 && shot[i] > 0) {
        // (Pieces: N equal shares of the buffer, each burning N-th of the time the whole buffer burns at its draw)
        const N = Math.min(16, Math.round(pr.pieces!)), T = Math.max(1, Math.round(cap[i] / (shot[i] * N)));
        const s = Math.max(0, Math.min(0.95, pr.spike ?? 0)), w = Math.max(1, Math.min(T, Math.round(T * (pr.spikeWidth ?? 0.2))));
        pieces[i] = N; pieceE[i] = Math.floor(cap[i] / N); pieceT[i] = T;
        spikeLo[i] = Math.floor((T - w) / 2); spikeHi[i] = spikeLo[i] + w;
        spikeOut[i] = 1 - s; spikeIn[i] = 1 - s + (s * T) / w;
      }
      const ag = fn.augment;
      if (ag) {
        // (A shot's augment costs `cost` E; a beam's `cost` E a second while it burns. Its buffer holds `buffer` of them (a beam: seconds))
        augCost[i] = gun[i] === 3 ? Math.max(1, perTick(ag.cost)) : toEu(ag.cost);
        augCap[i] = gun[i] === 3 ? toEu(ag.cost * (ag.buffer ?? 2)) : augCost[i] * Math.max(1, Math.round(ag.buffer ?? 2));
        augRate[i] = perTickUp(ag.rate); augSteady[i] = perTick(ag.floor ?? 0);
        augDps[i] = 1 + (ag.mods?.mul?.dps ?? 0); augMods[i] = ag.mods; augName[i] = ag.name;
      }
    } else if (isEngine(fn)) {
      role[i] = P_THRUSTER;
      const burnE = partDemand(fn, a, m), k = (fn.demand ?? 0) > 0 ? burnE / (fn.demand! * a) : 1;
      let mulB = fn.boost ?? 1, bBurnE = burnE * (1 + BOOST_DRAW * (fn.boostDrain ?? 0));
      if (mulB <= 1 || bBurnE <= burnE) { mulB = 1; bBurnE = burnE; }
      burn[i] = perTick(burnE); bBurn[i] = mulB > 1 ? Math.max(burn[i], perTick(bBurnE)) : burn[i]; boostMul[i] = mulB;
      rate[i] = perTick(fn.intake !== undefined ? fn.intake * a * k : burnE); cap[i] = toEu(fn.buffer !== undefined ? fn.buffer * a * k : burnE);
      engineDraw += burnE;
    } else if (fn.strafe || (fn.gyro ?? 0) > 0) {
      // (A Burst Strafer or a Gyro is a thruster too (Kieran, 2026-11-06: "the strafe thruster should require power like all
      // other thrusters, as should shields and gyros"): its `demand` is its burn while it works (a strafer bursting, a gyro
      // turning flat out), from its own buffer filled over its ports. It burns only while its part feature asks (energy.ts
      // portsPowerTick: PowerUse.extra), a gyro by the share of its torque the turn used; no boost)
      role[i] = P_THRUSTER;
      thrustKind[i] = fn.strafe ? TK_STRAFER : TK_GYRO;
      const burnE = partDemand(fn, a, m), k = (fn.demand ?? 0) > 0 ? burnE / (fn.demand! * a) : 1;
      burn[i] = perTick(burnE); bBurn[i] = burn[i];
      rate[i] = perTick(fn.intake !== undefined ? fn.intake * a * k : burnE);
      cap[i] = Math.max(burn[i], toEu(fn.buffer !== undefined ? fn.buffer * a * k : burnE));
      if (fn.strafe) strafeDraw += burnE; else gyroDraw += burnE;
    } else if ((fn.produce ?? 0) > 0) {
      role[i] = P_GEN;
      supply += partSupply(fn, a, m);
    } else if ((fn.demand ?? 0) > 0) {
      role[i] = P_TOOL;
      rate[i] = perTick(partDemand(fn, a, m)); cap[i] = rate[i] * TPS;
      // (A shield's fulfilment is EnergyState.shieldSat, its regen's share (energy.ts shieldShare). A Flash Screen has no
      // slow refill, so it is left out of it, though it draws as a tool)
      if (((fn.shield ?? 0) > 0 || fn.shaped) && !fn.flash) { shield[i] = 1; shieldDraw += partDemand(fn, a, m); }
      if (fn.mining) { miner[i] = 1; minePulse[i] = Math.max(1, Math.round((fn.minePulse ?? 0.9) * TPS)); }
      if (fn.machine) { machine[i] = fn.machine.kind === 'fabricator' ? MACHINE_FAB : MACHINE_REF; machineDraw += partDemand(fn, a, m); }
      if (fn.tow) tow[i] = 1;
      // (A Flash Screen is a store with no draw of its own: it holds flashCost E a shield point, filled over its in port, and a
      // full one pays for the screen's return at once when the shield breaks: features/flash)
      if (fn.flash) { flash[i] = 1; cap[i] = toEu((fn.flashCost ?? 0) * (fn.shield ?? 0) * a * out); }
    }
    // Feed: what it takes, its buffer, and its stats under each material
    if (fn.takes?.length && (role[i] === P_WEAPON || role[i] === P_THRUSTER)) {
      const use = fn.feedUse ?? 1;
      matCap[i] = Math.round((fn.feedBuf ?? 10 * use) * MAT_UNIT);
      matUse[i] = Math.round(use * MAT_UNIT / (role[i] === P_THRUSTER || gun[i] === 3 ? TPS : 1));
      for (const id of fn.takes) {
        const f = feedIdx(id);
        if (!f) continue;
        takes[i] |= 1 << (f - 1);
        const mods = { ...(feedDefs[f]!.mod), ...((fn.feedMods ?? {})[id] ?? {}) }, at = i * W + f;
        if (mods.shot !== undefined) mShot[at] = mods.shot; if (mods.damage !== undefined) mDamage[at] = mods.damage; if (mods.cycle !== undefined) mCycle[at] = mods.cycle;
        if (mods.discharge !== undefined) mDischarge[at] = mods.discharge; if (mods.rest !== undefined) mRest[at] = mods.rest; if (mods.burn !== undefined) mBurn[at] = mods.burn;
        if (mods.steady !== undefined) mSteady[at] = mods.steady;
        if (mods.thrust !== undefined) mThrust[at] = mods.thrust; if (mods.boost !== undefined) mBoost[at] = mods.boost; if (mods.boostDrain !== undefined) mBoostDrain[at] = mods.boostDrain;
      }
      if (fn.feedPort) feedPort[i] = fn.feedPort.required ? 2 : 1;
    }
    if (fn.combiner) takes[i] = -1;
  }

  return {
    n, feeds, feedDefs, health, thrustKind, role, cap, rate, burn, bBurn, boostMul, gun, shot, rounds, relight, passive, discharge, rest, burst, steady,
    pieces, pieceE, pieceT, spikeLo, spikeHi, spikeIn, spikeOut, augCap, augCost, augRate, augSteady, augDps, augMods, augName, tierDmg, miner, minePulse, machine, tow, flash,
    shield, carrier, matCap, matUse, takes, tankFeed, feedPort, mShot, mDamage, mCycle, mDischarge, mRest, mBurn, mSteady, mThrust, mBoost, mBoostDrain,
    supply, engineDraw, weaponDraw, strafeDraw, gyroDraw, shieldDraw, machineDraw,
  };
}
type Roles = ReturnType<typeof partRoles>;

type Port = { part: number; dir: 0 | 1; x: number; y: number; side: Side; nx: number; ny: number; rate: number; link: number; aug: 0 | 1 };

/** Ports, placed (and the frames and cells they're placed by); the touch-routed parts' neighbours and what each takes on a link */
function placePorts(input: PortsLayoutInput, R: Roles) {
  const { parts, fns, alive } = input;
  const { n, health, role, rate, bBurn, augCap } = R;
  // ---- Ports, placed; links where an out port faces an in port across a shared edge
  const occ = new Map<number, number>();
  const frames: PartFrame[] = [];
  for (let i = 0; i < n; i++) {
    frames.push(frameOf(parts[i], input.cells[i]));
    if (alive[i]) for (const c of input.cells[i]) occ.set(key(c[0], c[1]), i);
  }
  const ports: Port[] = [];
  const byPart: Port[][] = Array.from({ length: n }, () => []);
  // Touch-routed parts (FunctionDef.touch: the legacy functions enemy designs are built of) have no ports of their own:
  // they join whatever touches them (a shared edge, or a shared cell where bespoke pieces overlap), as the old touch
  // network did. tin: E a second a touch part takes on a link (a relay a line's rate; a consumer its whole intake, a
  // thruster its boosted burn)
  const cellParts = new Map<number, number[]>();
  for (let i = 0; i < n; i++) if (alive[i]) for (const c of input.cells[i]) { const k = key(c[0], c[1]); const a = cellParts.get(k); if (a) { if (!a.includes(i)) a.push(i); } else cellParts.set(k, [i]); }
  const nbCache = new Map<number, number[]>();
  /** Parts touching part i (an edge or an overlapping cell), in index order */
  const nb = (i: number): number[] => {
    let r = nbCache.get(i);
    if (r) return r;
    const s = new Set<number>();
    for (const c of input.cells[i]) for (const d of [[0, 0], [0, -1], [1, 0], [0, 1], [-1, 0]]) for (const j of cellParts.get(key(c[0] + d[0], c[1] + d[1])) ?? []) if (j !== i) s.add(j);
    r = [...s].sort((a, b) => a - b); nbCache.set(i, r);
    return r;
  };
  const tin = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (!alive[i] || !fns[i].touch) continue;
    const E = (eu: number) => (eu * TPS) / EU;
    if (fns[i].touch === 'relay' && role[i] === P_RELAY) tin[i] = TOUCH_LINE_RATE;
    else if (fns[i].touch === 'in') tin[i] = role[i] === P_THRUSTER ? E(Math.max(rate[i], bBurn[i])) : role[i] === P_TOOL ? 1.5 * E(rate[i]) : role[i] === P_WEAPON ? E(rate[i]) : 0;
  }
  for (let i = 0; i < n; i++) {
    if (!alive[i] || role[i] === P_INERT || role[i] === P_TANK || role[i] === P_SELECTOR || role[i] === P_PIPE || fns[i].touch) continue;
    const ag = role[i] === P_WEAPON && augCap[i] > 0 ? fns[i].augment : undefined;
    const specs: (PortSpec & { aug?: 1 })[] = ag ? [...(fns[i].ports ?? []), { dir: 'in', side: ag.side, cell: ag.cell, rate: ag.rate, aug: 1 }] : fns[i].ports ?? [];
    for (const q of specs) {
      const e = placeEdge(parts[i], frames[i], q.side, q.cell ?? 0), dir = q.dir === 'out' ? 1 : 0;
      // (A port past the piece's side lands on its last cell: a second one there is the same port, once. A 1-cell core has one N port, a 2-cell one two.
      // An engine's are one port rated for both: a Torch stood along its thrust (one cell across its back) can still be fed its whole burn, as it pushes
      // with every cell, mounting.ts engineExhaust)
      const same = byPart[i].find((o) => o.x === e.x && o.y === e.y && o.side === e.side && o.dir === dir);
      if (same) { if (role[i] === P_THRUSTER && !q.aug) same.rate += q.rate; continue; }
      const port: Port = { part: i, dir, x: e.x, y: e.y, side: e.side, nx: e.nx, ny: e.ny, rate: q.rate * (role[i] === P_GEN ? health(i) : 1), link: -1, aug: q.aug ? 1 : 0 };
      ports.push(port); byPart[i].push(port);
    }
  }
  // (The core of a touch-routed design is its hub, as it was: it joins every touch part touching it both ways, and its own
  // ports facing them go)
  const C = input.core;
  const coreTouch = C >= 0 && alive[C] && nb(C).some((j) => !!fns[j].touch);
  if (coreTouch) {
    const keep = byPart[C].filter((q) => !(cellParts.get(key(q.nx, q.ny)) ?? []).some((j) => !!fns[j].touch));
    for (const q of byPart[C]) if (!keep.includes(q)) ports.splice(ports.indexOf(q), 1);
    byPart[C] = keep;
    tin[C] = TOUCH_LINE_RATE;
  }
  return { occ, frames, ports, byPart, nb, tin, C, coreTouch };
}
type Placed = ReturnType<typeof placePorts>;

/**
 * Links: where an out port faces an in port across a shared edge, the touch links, the old touch designs' auto-wiring
 * and touch generator blocks; which parts are left open, the links by part, and what each consumer's lines can bring
 * (rate, after intake keeps its own)
 */
function linkUp(input: PortsLayoutInput, R: Roles, placed: Placed) {
  const { fns, area, mats, alive } = input;
  const { n, health, role, rate, bBurn } = R;
  const { occ, ports, byPart, nb, tin, C, coreTouch } = placed;
  const touchGen = (i: number) => alive[i] && role[i] === P_GEN && fns[i].touch === 'gen';
  // (Touch relays pass power only away from the generators: each one's depth is its hops from a generator or the hub
  // through touching touch relays, and a touch relay feeds a touching one only if that is deeper, or as deep and later in
  // the part list. An order, so power flows outward and never bounces back)
  const touchRelay = (i: number) => alive[i] && role[i] === P_RELAY && (fns[i].touch === 'relay' || (coreTouch && i === C));
  const INF = 0x7fffffff;
  const depth = new Int32Array(n).fill(INF);
  {
    let front: number[] = [];
    for (let i = 0; i < n; i++) if (alive[i] && (role[i] === P_GEN || (coreTouch && i === C))) { depth[i] = 0; front.push(i); }
    for (let d = 1; front.length; d++) {
      const next: number[] = [];
      for (const i of front) if (touchGen(i) || touchRelay(i)) for (const j of nb(i)) if (touchRelay(j) && depth[j] > d) { depth[j] = d; next.push(j); }
      front = next;
    }
  }
  const linkFrom: number[] = [], linkTo: number[] = [], linkCap: number[] = [], linkAug: number[] = [];
  const openIn = new Uint8Array(n), openOut = new Uint8Array(n);
  for (const pa of ports) {
    if (pa.dir !== 1) continue;
    const j = occ.get(key(pa.nx, pa.ny));
    const pb = j === undefined || j === pa.part ? undefined : byPart[j].find((q) => q.dir === 0 && q.x === pa.nx && q.y === pa.ny && q.side === OPP[pa.side]);
    if (!pb) { if (role[pa.part] === P_GEN) openOut[pa.part] = 1; continue; }
    const id = linkFrom.length;
    linkFrom.push(pa.part); linkTo.push(pb.part); linkCap.push(perTick(Math.min(pa.rate, pb.rate))); linkAug.push(pb.aug);
    pa.link = id; pb.link = id;
  }
  // (Touch links: a touch generator, or a touch relay, into each touching touch relay further out and each touching touch
  // consumer; one link a pair)
  const touchTaker = (j: number) => tin[j] > 0 && (touchRelay(j) || fns[j].touch === 'in');
  for (let i = 0; i < n; i++) {
    if (!touchGen(i) && !touchRelay(i)) continue;
    for (const j of nb(i)) {
      if (!touchTaker(j)) continue;
      if (touchRelay(j) && touchRelay(i) && !(depth[i] < depth[j] || (depth[i] === depth[j] && i < j))) continue;
      linkFrom.push(i); linkTo.push(j); linkCap.push(perTick(Math.min(touchRelay(i) ? TOUCH_LINE_RATE : Infinity, tin[j]))); linkAug.push(0);
    }
  }
  // (The old touch designs were wired as one network (auto-wiring: a part fed the whole ship, whatever lay between), so a
  // touch consumer with no line of its own is wired to the nearest touch generator or reached relay, through whatever
  // parts lie between (fewest steps; ties to the lowest part index), a link straight to it; and so is a touch relay no
  // generator reaches through touch relays)
  for (let i = 0; i < n; i++) {
    const relay = touchRelay(i) && depth[i] === INF;
    if (!relay && (!alive[i] || fns[i].touch !== 'in' || !(tin[i] > 0) || linkTo.includes(i))) continue;
    const seen = new Set<number>([i]);
    let front = [i], giver = -1;
    while (front.length && giver < 0) {
      const next: number[] = [];
      for (const k of front) for (const j of nb(k)) {
        if (seen.has(j)) continue;
        seen.add(j);
        if (touchGen(j) || (touchRelay(j) && depth[j] !== INF)) { if (giver < 0 || j < giver) giver = j; }
        else next.push(j);
      }
      front = next.sort((a, b) => a - b);
    }
    if (giver < 0) continue;
    linkFrom.push(giver); linkTo.push(i); linkCap.push(perTick(Math.min(touchRelay(giver) ? TOUCH_LINE_RATE : Infinity, tin[i]))); linkAug.push(0);
    if (relay) depth[i] = depth[giver] + 1;
  }
  // (Touching touch generators make one block, as they did in the old network: the block's output, shared every tick over
  // all its members' links by what each taker has room for (portsTick). One touching one part gives it all, one touching
  // three splits it by need; a block never gives more than it makes. touchClus: each member's block (its lowest part),
  // touchNext: the next member, -1 at the end)
  const touchOut = new Int32Array(n), touchClus = new Int32Array(n).fill(-1), touchNext = new Int32Array(n).fill(-1);
  for (let g = 0; g < n; g++) {
    if (!touchGen(g) || touchClus[g] >= 0) continue;
    const mem: number[] = [g]; touchClus[g] = g;
    for (let k = 0; k < mem.length; k++) for (const j of nb(mem[k])) if (touchClus[j] < 0 && touchGen(j)) { touchClus[j] = g; mem.push(j); }
    mem.sort((a, b) => a - b);
    for (let k = 0; k + 1 < mem.length; k++) touchNext[mem[k]] = mem[k + 1];
    let out = 0; for (const j of mem) out += perTick(partSupply(fns[j], area[j], mats[j]) * health(j));
    touchOut[g] = Math.max(1, out);
    if (!mem.some((j) => linkFrom.includes(j))) for (const j of mem) openOut[j] = 1;
  }
  for (const pb of ports) if (pb.dir === 0 && pb.link < 0 && (role[pb.part] === P_WEAPON || role[pb.part] === P_THRUSTER || role[pb.part] === P_TOOL)) openIn[pb.part] = 1;
  // (A touch consumer is open only with no line at all)
  for (let i = 0; i < n; i++) if (alive[i] && fns[i].touch === 'in' && tin[i] > 0) openIn[i] = linkTo.includes(i) ? 0 : 1;
  const outStart = new Int32Array(n + 1), inStart = new Int32Array(n + 1);
  const outLink: number[] = [], inLink: number[] = [];
  for (let i = 0; i < n; i++) {
    outStart[i] = outLink.length; for (let l = 0; l < linkFrom.length; l++) if (linkFrom[l] === i) outLink.push(l);
    inStart[i] = inLink.length; for (let l = 0; l < linkTo.length; l++) if (linkTo[l] === i) inLink.push(l);
  }
  outStart[n] = outLink.length; inStart[n] = inLink.length;
  // (A consumer takes at most what its own lines can bring: its main lines; an augment's are its own. A thruster takes
  // all its lines bring (its in ports are rated for its boosted burn: a store or a strong line in front keeps a boost going,
  // a weak one gives a short dash from its buffer); a gun or a tool no more than its own intake, which keeps its rhythm)
  const intake = Int32Array.from(rate);
  for (let i = 0; i < n; i++) if (role[i] === P_WEAPON || role[i] === P_THRUSTER || role[i] === P_TOOL) {
    let r = 0; for (let x = inStart[i]; x < inStart[i + 1]; x++) if (!linkAug[inLink[x]]) r += linkCap[inLink[x]];
    rate[i] = role[i] === P_THRUSTER ? (fns[i].touch ? Math.min(r, Math.max(rate[i], bBurn[i])) : r) || rate[i] : Math.min(rate[i] || r, r) || rate[i];
  }
  return { linkFrom, linkTo, linkCap, linkAug, openIn, openOut, outStart, outLink, inStart, inLink, intake, touchOut, touchClus, touchNext };
}

/** ---- Feed points and networks (union-find; a Selector's points join nothing, they look across) */
function feedNetworks(input: PortsLayoutInput, R: Roles, placed: Placed) {
  const { parts, fns, alive } = input;
  const { n, role, tankFeed, feedPort } = R;
  const { occ, frames } = placed;
  type FP = { part: number; x: number; y: number; side: Side; nx: number; ny: number; joined: number; i: number };
  const fps: FP[] = [], fpBy: FP[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    if (!alive[i]) continue;
    const fn = fns[i];
    const pts: EdgeSpec[] = fn.feedPoints ? [...fn.feedPoints] : [];
    if (fn.feedPort) pts.push({ side: fn.feedPort.side, cell: fn.feedPort.cell });
    pts.forEach((q, k) => { const e = placeEdge(parts[i], frames[i], q.side, q.cell ?? 0); const fp: FP = { part: i, x: e.x, y: e.y, side: e.side, nx: e.nx, ny: e.ny, joined: 0, i: k }; fps.push(fp); fpBy[i].push(fp); });
  }
  const parent = new Int32Array(n); for (let i = 0; i < n; i++) parent[i] = i;
  const find = (p: number): number => { while (parent[p] !== p) { parent[p] = parent[parent[p]]; p = parent[p]; } return p; };
  const hasFeed = (i: number) => fpBy[i].length > 0 && role[i] !== P_SELECTOR;
  for (const fa of fps) {
    const j = occ.get(key(fa.nx, fa.ny));
    if (j === undefined || j === fa.part || !fpBy[j].some((q) => q.x === fa.nx && q.y === fa.ny && q.side === OPP[fa.side])) continue;
    if (role[fa.part] === P_TANK && role[j] === P_TANK && tankFeed[fa.part] !== tankFeed[j]) continue;
    fa.joined = 1;
    if (role[fa.part] === P_SELECTOR || role[j] === P_SELECTOR) continue;
    const ra = find(fa.part), rb = find(j); if (ra !== rb) parent[ra] = rb;
  }
  const netOf = new Int32Array(n).fill(-1), nets: PortsLayout['nets'] = [], netIndex = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    if (!alive[i] || !hasFeed(i)) continue;
    const r = find(i);
    let k = netIndex.get(r); if (k === undefined) { k = nets.length; netIndex.set(r, k); nets.push({ tanks: [], selectors: [], users: [] }); }
    netOf[i] = k;
    if (role[i] === P_TANK) nets[k].tanks.push(i); else if (fns[i].combiner || feedPort[i]) nets[k].users.push(i);
  }
  const selectors: number[] = [], selIn = new Int32Array(2 * n).fill(-1), selOut = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    if (!alive[i] || role[i] !== P_SELECTOR) continue;
    selectors.push(i);
    const across = (k: number) => { const fp = fpBy[i][k]; if (!fp || !fp.joined) return -1; const j = occ.get(key(fp.nx, fp.ny)); return j === undefined ? -1 : netOf[j]; };
    selIn[2 * i] = across(0); selIn[2 * i + 1] = across(1); selOut[i] = across(2);
    if (selOut[i] >= 0) nets[selOut[i]].selectors.push(i);
  }
  const drawers: number[] = [];
  for (let i = 0; i < n; i++) if (alive[i] && netOf[i] >= 0 && (fns[i].combiner || feedPort[i])) drawers.push(i);
  return { fps, netOf, nets, selIn, selOut, selectors, drawers };
}

/**
 * Which parts power can reach at all (1): a generator, and anything its links lead to, through relays and lines, as the
 * layout is built. What a passive part with no store of its own (a jump coil) counts by: fed, it works; cut off, it doesn't
 */
export function portsFed(L: PortsLayout): Uint8Array {
  const fed = new Uint8Array(L.n);
  const front: number[] = [];
  for (let k = 0; k < L.gens.length; k++) { fed[L.gens[k]] = 1; front.push(L.gens[k]); }
  while (front.length) {
    const p = front.pop()!;
    for (let k = L.outStart[p]; k < L.outStart[p + 1]; k++) {
      const q = L.linkTo[L.outLink[k]];
      if (!fed[q]) { fed[q] = 1; front.push(q); }
    }
  }
  return fed;
}

/** FNV-1a over the graph and the caps (not the health-scaled generator rates), 16 bits, never 0 */
export function portsSig(L: PortsLayout): number {
  let h = 0x811c9dc5 | 0;
  const mix = (v: number) => { h = Math.imul(h ^ (v | 0), 0x01000193); };
  const all = (a: ArrayLike<number>) => { mix(a.length); for (let i = 0; i < a.length; i++) mix(a[i]); };
  mix(L.n); all(L.role); all(L.thrustKind); all(L.cap); all(L.burn); all(L.bBurn); all(L.gun); all(L.shot); all(L.rounds); all(L.passive); all(L.discharge); all(L.rest); all(L.steady); all(L.pieces); all(L.pieceE); all(L.pieceT); all(L.miner); all(L.minePulse); all(L.augCap); all(L.augCost); all(L.augSteady); all(L.linkAug);
  all(L.matCap); all(L.takes); all(L.tankFeed); all(L.linkFrom); all(L.linkTo); all(L.netOf); all(L.selOut);
  const s = ((h >>> 16) ^ (h & 0xffff)) & 0xffff;
  return s === 0 ? 1 : s;
}
