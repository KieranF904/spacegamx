/**
 * The ports energy core (docs/design/energy-ports-2026-11.md; the Energy Lab's prototypes/energy-lab/ports-model.js is
 * the reference): a ship whose blueprint says `power: 'ports'` runs on this instead of energy.ts. Power moves only out of
 * an out port into an in port across a shared cell edge, in a synchronous tick (offer, accept, apply, then the consumers
 * act), so the server, the pilot's prediction and the hangar agree to the eu. On top, the feed layer: tanks of
 * materials joined by pipes, Selectors, Combiners that put a material onto a power line, and feed buffers on the guns and
 * engines that take one; a material reshapes a part's stats (ShipTuning.feeds). Everything that holds material holds one
 * kind until it is empty.
 *
 * Built once a rebuild (buildPortsLayout), run every tick (portsTick), never allocating per tick. Integer eu (units.ts)
 * for energy, hundredths for material, ticks for timers. All lists are in part-index order.
 */

import type { FireSpec, FunctionDef, MaterialDef, PlacedPart, Rot, Side, Vec2 } from '../types.js';
import type { ShipTuning } from '../tuning.js';
import { SIDE_NORMAL, transformPoint, transformSide } from '../catalog.js';
import { fnOutput, isEngine, partDemand, partSupply } from '../grades.js';
import { EU, perTick, perTickUp, toEu } from './units.js';

// ---- Roles
export const P_INERT = 0, P_GEN = 1, P_RELAY = 2, P_THRUSTER = 3, P_TOOL = 4, P_WEAPON = 5, P_TANK = 6, P_SELECTOR = 7, P_PIPE = 8;
// ---- Flags (PortsState.flags; three bits on the wire)
/** A clip reloading, or a burst beam resting */
export const PF_LATCH = 1;
/** A beam lit */
export const PF_LIT = 2;
/** A Selector passing its second input */
export const PF_SEL = 4;
export const PF_MASK = 7;

/** Material amounts are kept in hundredths */
export const MAT_UNIT = 100;
/** Material moves at most this much a second across a link or out of a network */
const MAT_RATE = 30;
const BOOST_DRAW = 2.2;
/** Ticks a second */
const TPS = 60;

export interface PortSpec { dir: 'in' | 'out'; side: Side; cell?: number; rate: number }
export interface EdgeSpec { side: Side; cell?: number }
/** A material the feed layer carries (ShipTuning.feeds[id]) */
export interface FeedDef {
  name: string;
  short?: string;
  /** What it is for */
  on: 'weapon' | 'engine';
  /** The stats it multiplies: shot, damage, cycle, discharge, rest, burn, threshold, steady, thrust, boost, boostDrain */
  mod: Record<string, number>;
  color?: string;
  say?: string;
}

export interface PortsWeaponInput { part: number; fire: FireSpec; interval: number }
export interface PortsLayoutInput {
  parts: readonly PlacedPart[];
  fns: readonly FunctionDef[];
  area: readonly number[];
  mats: readonly (MaterialDef | undefined)[];
  alive: readonly boolean[];
  /** Each part's cells as placed (PlacedGeom.cells, grid coordinates) */
  cells: readonly (readonly Vec2[])[];
  core: number;
  tuning: ShipTuning;
  weapons?: readonly PortsWeaponInput[];
  health?: readonly number[];
}

/** A material's index in the layout's feed table (0: none) */
export interface PortsLayout {
  n: number;
  sig: number;
  role: Uint8Array;
  /** eu: a store's holds, a weapon's buffer, a thruster's buffer; a tank's: its material (hundredths) */
  cap: Int32Array;
  /** eu a tick: a generator's output per out port is on the links; a consumer's intake sums its in links */
  rate: Int32Array;
  /** Thrusters: burn a tick, boosted burn, boost multiplier */
  burn: Int32Array;
  bBurn: Int32Array;
  boostMul: Float64Array;
  /** Weapons: 1 shot gun, 2 clip, 3 beam; eu a shot (a beam: a tick's burn); rounds a salvo; relight eu */
  gun: Uint8Array;
  shot: Int32Array;
  rounds: Int32Array;
  relight: Int32Array;
  /** Weapons' power profiles: passive eu a tick, discharge and rest in ticks, burst 0/1, threshold and steady in eu a tick */
  passive: Int32Array;
  discharge: Int32Array;
  rest: Int32Array;
  burst: Uint8Array;
  threshold: Int32Array;
  steady: Int32Array;
  /** Tools: 1 for a shield generator */
  shield: Uint8Array;
  /** Lines (conduit-like stores: they carry material too) */
  carrier: Uint8Array;
  /** Material a part may hold, hundredths (a tank: its cap; a gun or engine: its feed buffer; a line: a little); 0: none */
  matCap: Int32Array;
  /** Material a shot or a tick of thrust/beam uses, hundredths */
  matUse: Int32Array;
  /** Per part, a bit per feed index (1 << (idx - 1)): what it takes; a combiner takes everything */
  takes: Int32Array;
  /** A tank's feed index (0: not a tank) */
  tankFeed: Uint8Array;
  /** A gun or engine with a feed port of its own (1), required (2) */
  feedPort: Uint8Array;
  /** Per part, per feed index (1..M): the multipliers of its stats under that material (n × (M + 1), index p * (M + 1) + f) */
  mShot: Float64Array;
  mDamage: Float64Array;
  mCycle: Float64Array;
  mDischarge: Float64Array;
  mRest: Float64Array;
  mBurn: Float64Array;
  mThreshold: Float64Array;
  mSteady: Float64Array;
  mThrust: Float64Array;
  mBoost: Float64Array;
  mBoostDrain: Float64Array;
  /** The feed table: ids in index order (index 0 is "none") */
  feeds: readonly string[];
  feedDefs: readonly (FeedDef | null)[];

  /** Links: power may cross from linkFrom to linkTo, up to linkCap eu a tick (the lower of the two ports' rates) */
  links: number;
  linkFrom: Int32Array;
  linkTo: Int32Array;
  linkCap: Int32Array;
  /** Per part: its out links are links[outStart[p] .. outStart[p+1]], its in links inStart[p] .. (link ids) */
  outStart: Int32Array;
  outLink: Int32Array;
  inStart: Int32Array;
  inLink: Int32Array;
  /** Per part: open in ports (a consumer's with nothing across) and open out ports (a generator's), for the hangar */
  openIn: Uint8Array;
  openOut: Uint8Array;
  /** Every port, placed, for the hangar: part, dir (0 in, 1 out), x, y (its cell), side, rate (E/s), linked (0/1) */
  ports: { part: number; dir: 0 | 1; x: number; y: number; side: Side; rate: number; link: number }[];
  /** Every feed point, placed: part, x, y, side, joined (0/1) */
  feedPts: { part: number; x: number; y: number; side: Side; joined: number; i: number }[];

  /** Feed networks: per part its network (-1 none); per network its tanks and its selectors (those whose output joins it) */
  netOf: Int32Array;
  nets: { tanks: number[]; selectors: number[]; users: number[] }[];
  /** Selectors: per selector part, its two input networks and output network (-1 none) */
  selIn: Int32Array;
  selOut: Int32Array;
  /** Parts that draw material from their network: combiners and parts with a feed port */
  drawers: Int32Array;
  gens: Int32Array;
  relays: Int32Array;
  thrusters: Int32Array;
  tools: Int32Array;
  weapons: Int32Array;
  tanks: Int32Array;
  carriers: Int32Array;
  consumers: Int32Array;
  selectors: Int32Array;
  gaugeMax: number;
  /** Totals for ShipDerived.energy and the hangar (E a second) */
  supply: number;
  engineDraw: number;
  weaponDraw: number;
}

export interface PortsState {
  sig: number;
  /** eu held (a tank: material in hundredths) */
  held: Int32Array;
  flags: Uint8Array;
  /** Material held, hundredths, and which (feed index, 0 none) */
  amt: Int32Array;
  mat: Uint8Array;
  /** Ticks a gun's ports stay shut (discharge, rest) */
  closed: Int16Array;
  /** Tools: the share of what each wanted that it got this tick, 0..255 */
  sat: Uint8Array;
  shieldSat: number;
  gauge: number;
}

const SIDE_ORDER: readonly Side[] = ['N', 'E', 'S', 'W'];
const OPP: Record<Side, Side> = { N: 'S', S: 'N', E: 'W', W: 'E' };

/**
 * The frame a part's ports and feed points are given in: its piece's own (rot, flip), or, for a part with a facing (a gun,
 * an engine), the frame whose N is that facing, so "S" is always its back. `cells` are the part's cells in that frame
 * (the piece's cells, un-placed: a rectangle from its own origin for the rectangular pieces)
 */
export interface PartFrame { rot: Rot; flip: boolean; cells: Vec2[] }
export function frameOf(part: PlacedPart, placed: readonly Vec2[]): PartFrame {
  const rot = (part.facing ? SIDE_ORDER.indexOf(part.facing) : part.rot) as Rot, flip = part.flip, inv = ((4 - rot) % 4) as Rot;
  const cells: Vec2[] = placed.map((c) => {
    const p = transformPoint([c[0] - part.x + 0.5, c[1] - part.y + 0.5], inv, false);
    return [Math.floor(flip ? 1 - p[0] : p[0]), Math.floor(p[1])];
  });
  return { rot, flip, cells };
}
/** A part's edge point (its frame) placed: the cell it sits on, its side and the cell across, in grid coordinates */
export function placeEdge(part: PlacedPart, F: PartFrame, side: Side, cell: number): { x: number; y: number; side: Side; nx: number; ny: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of F.cells) { if (c[0] < x0) x0 = c[0]; if (c[0] > x1) x1 = c[0]; if (c[1] < y0) y0 = c[1]; if (c[1] > y1) y1 = c[1]; }
  const k = Math.max(0, cell);
  const lx = side === 'W' ? x0 : side === 'E' ? x1 : Math.min(x1, x0 + k), ly = side === 'N' ? y0 : side === 'S' ? y1 : Math.min(y1, y0 + k);
  const c = transformPoint([lx + 0.5, ly + 0.5], F.rot, F.flip);
  const x = Math.floor(c[0]) + part.x, y = Math.floor(c[1]) + part.y;
  const ws = transformSide(side, F.rot, F.flip), nrm = SIDE_NORMAL[ws];
  return { x, y, side: ws, nx: x + nrm[0], ny: y + nrm[1] };
}

export function buildPortsLayout(input: PortsLayoutInput): PortsLayout {
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
  const role = new Uint8Array(n), cap = Z(), rate = Z(), burn = Z(), bBurn = Z(), boostMul = new Float64Array(n).fill(1);
  const gun = new Uint8Array(n), shot = Z(), rounds = Z(), relight = Z(), passive = Z(), discharge = Z(), rest = Z(), burst = new Uint8Array(n), threshold = Z(), steady = Z();
  const shield = new Uint8Array(n), carrier = new Uint8Array(n), matCap = Z(), matUse = Z(), takes = Z(), tankFeed = new Uint8Array(n), feedPort = new Uint8Array(n);
  const mul = () => new Float64Array(n * W).fill(1);
  const mShot = mul(), mDamage = mul(), mCycle = mul(), mDischarge = mul(), mRest = mul(), mBurn = mul(), mThreshold = mul(), mSteady = mul(), mThrust = mul(), mBoost = mul(), mBoostDrain = mul();
  let supply = 0, engineDraw = 0, weaponDraw = 0;

  for (let i = 0; i < n; i++) {
    if (!alive[i]) continue;
    const fn = fns[i], a = area[i], m = mats[i];
    const out = fnOutput(fn, m);
    if (i === input.core || ((fn.store ?? 0) > 0 && !fn.tank)) {
      role[i] = P_RELAY;
      cap[i] = toEu(i === input.core ? ((tuning as { energy?: { coreCapacity?: number } }).energy?.coreCapacity ?? 240) : (fn.store ?? 0) * a * out);
      if (fn.relayOnly || fn.combiner || fn.pipeThrough) { carrier[i] = 1; matCap[i] = (fn.combiner ? 4 : 2) * MAT_UNIT; }
    } else if (fn.tank) {
      role[i] = P_TANK;
      tankFeed[i] = feedIdx(fn.tank.feed);
      cap[i] = Math.round(fn.tank.holds * a * MAT_UNIT);
      matCap[i] = cap[i];
    } else if (fn.selector) {
      role[i] = P_SELECTOR;
    } else if (fn.pipe) {
      role[i] = P_PIPE;
    } else if (fn.weapon) {
      const w = weaponOf.get(i);
      if (!w) continue;
      role[i] = P_WEAPON;
      // (Its energy is what it draws today, as energy.ts gunDraw has it: a beam its draw a second from two seconds' worth; a
      // cycle gun its draw over its beat, two shots held; a clip its reload's energy over the clip; a charge gun its charge's.
      // The routing data's own shot/intake/burn (fire.shot...) is another scale and is left alone)
      const f = w.fire, draw = partDemand(fn, a, m);
      weaponDraw += draw;
      rounds[i] = 1;
      rate[i] = perTickUp(1.5 * draw);
      if (f.model === 'beam') {
        gun[i] = 3; shot[i] = draw > 0 ? Math.max(1, perTick(draw)) : 0; cap[i] = toEu(2 * draw);
        relight[i] = Math.floor(cap[i] * (f.relight ?? 0.5));
      } else if (f.model === 'clip') {
        const clip = Math.max(1, Math.round(f.clip ?? 1)), reloadE = f.reloadE ?? (draw * (f.reload ?? 60)) / 60;
        gun[i] = 2; shot[i] = toEu(reloadE / clip); cap[i] = shot[i] * clip;
        if (shot[i] > 0) rounds[i] = Math.max(1, Math.min(Math.round(f.rounds ?? 1), clip));
      } else if (f.model === 'charge') {
        gun[i] = 1; shot[i] = toEu(f.chargeE ?? (draw * ((f.charge ?? 60) + (f.cooldown ?? 0))) / 60); cap[i] = shot[i];
      } else {
        gun[i] = 1; shot[i] = f.model === 'ammo' ? 0 : toEu((draw * w.interval) / 60); cap[i] = 2 * shot[i];
      }
      const pr = fn.profile ?? {};
      passive[i] = perTick(pr.passive ?? 0); discharge[i] = Math.round((pr.discharge ?? 0) * TPS); rest[i] = Math.round((pr.rest ?? 0) * TPS);
      // (A threshold rounds down, so a line rated exactly at it passes)
      burst[i] = pr.burst ? 1 : 0; threshold[i] = Math.floor(((pr.threshold ?? 0) * EU) / TPS); steady[i] = perTick(pr.steady ?? 0);
    } else if (isEngine(fn)) {
      role[i] = P_THRUSTER;
      const burnE = partDemand(fn, a, m), k = (fn.demand ?? 0) > 0 ? burnE / (fn.demand! * a) : 1;
      let mulB = fn.boost ?? 1, bBurnE = burnE * (1 + BOOST_DRAW * (fn.boostDrain ?? 0));
      if (mulB <= 1 || bBurnE <= burnE) { mulB = 1; bBurnE = burnE; }
      burn[i] = perTick(burnE); bBurn[i] = mulB > 1 ? Math.max(burn[i], perTick(bBurnE)) : burn[i]; boostMul[i] = mulB;
      rate[i] = perTick(fn.intake !== undefined ? fn.intake * a * k : burnE); cap[i] = toEu(fn.buffer !== undefined ? fn.buffer * a * k : burnE);
      engineDraw += burnE;
    } else if ((fn.produce ?? 0) > 0) {
      role[i] = P_GEN;
      supply += partSupply(fn, a, m);
    } else if ((fn.demand ?? 0) > 0) {
      role[i] = P_TOOL;
      rate[i] = perTick(partDemand(fn, a, m)); cap[i] = rate[i] * TPS;
      if ((fn.shield ?? 0) > 0) shield[i] = 1;
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
        if (mods.threshold !== undefined) mThreshold[at] = mods.threshold; if (mods.steady !== undefined) mSteady[at] = mods.steady;
        if (mods.thrust !== undefined) mThrust[at] = mods.thrust; if (mods.boost !== undefined) mBoost[at] = mods.boost; if (mods.boostDrain !== undefined) mBoostDrain[at] = mods.boostDrain;
      }
      if (fn.feedPort) feedPort[i] = fn.feedPort.required ? 2 : 1;
    }
    if (fn.combiner) takes[i] = -1;
  }

  // ---- Ports, placed; links where an out port faces an in port across a shared edge
  const occ = new Map<number, number>();
  const key = (x: number, y: number) => (x + 1024) * 4096 + (y + 1024);
  const frames: PartFrame[] = [];
  for (let i = 0; i < n; i++) {
    frames.push(frameOf(parts[i], input.cells[i]));
    if (alive[i]) for (const c of input.cells[i]) occ.set(key(c[0], c[1]), i);
  }
  type Port = { part: number; dir: 0 | 1; x: number; y: number; side: Side; nx: number; ny: number; rate: number; link: number };
  const ports: Port[] = [];
  const byPart: Port[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    if (!alive[i] || role[i] === P_INERT || role[i] === P_TANK || role[i] === P_SELECTOR || role[i] === P_PIPE) continue;
    for (const q of fns[i].ports ?? []) {
      const e = placeEdge(parts[i], frames[i], q.side, q.cell ?? 0);
      // (A port past the piece's side lands on its last cell: a second one there is the same port, once. A 1-cell core has one N port, a 2-cell one two)
      if (byPart[i].some((o) => o.x === e.x && o.y === e.y && o.side === e.side && o.dir === (q.dir === 'out' ? 1 : 0))) continue;
      const port: Port = { part: i, dir: q.dir === 'out' ? 1 : 0, x: e.x, y: e.y, side: e.side, nx: e.nx, ny: e.ny, rate: q.rate * (role[i] === P_GEN ? health(i) : 1), link: -1 };
      ports.push(port); byPart[i].push(port);
    }
  }
  const linkFrom: number[] = [], linkTo: number[] = [], linkCap: number[] = [];
  const openIn = new Uint8Array(n), openOut = new Uint8Array(n);
  for (const pa of ports) {
    if (pa.dir !== 1) continue;
    const j = occ.get(key(pa.nx, pa.ny));
    const pb = j === undefined || j === pa.part ? undefined : byPart[j].find((q) => q.dir === 0 && q.x === pa.nx && q.y === pa.ny && q.side === OPP[pa.side]);
    if (!pb) { if (role[pa.part] === P_GEN) openOut[pa.part] = 1; continue; }
    const id = linkFrom.length;
    linkFrom.push(pa.part); linkTo.push(pb.part); linkCap.push(perTick(Math.min(pa.rate, pb.rate)));
    pa.link = id; pb.link = id;
  }
  for (const pb of ports) if (pb.dir === 0 && pb.link < 0 && (role[pb.part] === P_WEAPON || role[pb.part] === P_THRUSTER || role[pb.part] === P_TOOL)) openIn[pb.part] = 1;
  const outStart = new Int32Array(n + 1), inStart = new Int32Array(n + 1);
  const outLink: number[] = [], inLink: number[] = [];
  for (let i = 0; i < n; i++) {
    outStart[i] = outLink.length; for (let l = 0; l < linkFrom.length; l++) if (linkFrom[l] === i) outLink.push(l);
    inStart[i] = inLink.length; for (let l = 0; l < linkTo.length; l++) if (linkTo[l] === i) inLink.push(l);
  }
  outStart[n] = outLink.length; inStart[n] = inLink.length;
  for (let i = 0; i < n; i++) if (role[i] === P_WEAPON || role[i] === P_THRUSTER || role[i] === P_TOOL) { let r = 0; for (let x = inStart[i]; x < inStart[i + 1]; x++) r += linkCap[inLink[x]]; rate[i] = Math.min(rate[i] || r, r) || rate[i]; }

  // ---- Feed points and networks (union-find; a Selector's points join nothing, they look across)
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

  const list = (r: number) => { const o: number[] = []; for (let i = 0; i < n; i++) if (role[i] === r) o.push(i); return Int32Array.from(o); };
  const relays = list(P_RELAY), consumers: number[] = [];
  for (let i = 0; i < n; i++) if (role[i] === P_THRUSTER || role[i] === P_TOOL || role[i] === P_WEAPON) consumers.push(i);
  let gaugeMax = 0; for (const r of relays) gaugeMax += cap[r];
  const L: PortsLayout = {
    n, sig: 0, role, cap, rate, burn, bBurn, boostMul, gun, shot, rounds, relight, passive, discharge, rest, burst, threshold, steady, shield, carrier, matCap, matUse, takes, tankFeed, feedPort,
    mShot, mDamage, mCycle, mDischarge, mRest, mBurn, mThreshold, mSteady, mThrust, mBoost, mBoostDrain, feeds, feedDefs,
    links: linkFrom.length, linkFrom: Int32Array.from(linkFrom), linkTo: Int32Array.from(linkTo), linkCap: Int32Array.from(linkCap),
    outStart, outLink: Int32Array.from(outLink), inStart, inLink: Int32Array.from(inLink), openIn, openOut,
    ports: ports.map((p) => ({ part: p.part, dir: p.dir, x: p.x, y: p.y, side: p.side, rate: p.rate, link: p.link >= 0 ? 1 : 0 })),
    feedPts: fps.map((f) => ({ part: f.part, x: f.x, y: f.y, side: f.side, joined: f.joined, i: f.i })),
    netOf, nets, selIn, selOut, drawers: Int32Array.from(drawers),
    gens: list(P_GEN), relays, thrusters: list(P_THRUSTER), tools: list(P_TOOL), weapons: list(P_WEAPON), tanks: list(P_TANK), carriers: Int32Array.from([...relays].filter((r) => carrier[r])),
    consumers: Int32Array.from(consumers), selectors: Int32Array.from(selectors), gaugeMax, supply, engineDraw, weaponDraw,
  };
  L.sig = portsSig(L);
  return L;
}

/** FNV-1a over the graph and the caps (not the health-scaled generator rates), 16 bits, never 0 */
export function portsSig(L: PortsLayout): number {
  let h = 0x811c9dc5 | 0;
  const mix = (v: number) => { h = Math.imul(h ^ (v | 0), 0x01000193); };
  const all = (a: ArrayLike<number>) => { mix(a.length); for (let i = 0; i < a.length; i++) mix(a[i]); };
  mix(L.n); all(L.role); all(L.cap); all(L.burn); all(L.bBurn); all(L.gun); all(L.shot); all(L.rounds); all(L.passive); all(L.discharge); all(L.rest); all(L.threshold); all(L.steady);
  all(L.matCap); all(L.takes); all(L.tankFeed); all(L.linkFrom); all(L.linkTo); all(L.netOf); all(L.selOut);
  const s = ((h >>> 16) ^ (h & 0xffff)) & 0xffff;
  return s === 0 ? 1 : s;
}

// ================================================================ state
export function createPortsState(L: PortsLayout): PortsState {
  return fullPorts(L, { sig: L.sig, held: new Int32Array(L.n), flags: new Uint8Array(L.n), amt: new Int32Array(L.n), mat: new Uint8Array(L.n), closed: new Int16Array(L.n), sat: new Uint8Array(L.n), shieldSat: 255, gauge: 0 });
}
/** Everything full: stores, buffers and tanks; no material in the guns, lines or engines */
export function fullPorts(L: PortsLayout, out?: PortsState): PortsState {
  if (!out || out.held.length !== L.n) return createPortsState(L);
  out.held.set(L.cap);
  for (const c of L.carriers) out.held[c] = 0;
  out.flags.fill(0); out.amt.fill(0); out.mat.fill(0); out.closed.fill(0); out.sat.fill(255); out.shieldSat = 255; out.sig = L.sig; out.gauge = portsGauge(L, out);
  return out;
}
/** After a rebuild: the same design keeps what each part held (clamped); a new one starts full */
export function remapPorts(e: PortsState, after: PortsLayout, sameDesign: boolean): PortsState {
  if (!sameDesign || e.held.length !== after.n) return fullPorts(after, e.held.length === after.n ? e : undefined);
  for (let i = 0; i < after.n; i++) {
    if (e.held[i] > after.cap[i]) e.held[i] = after.cap[i];
    if (e.held[i] < 0) e.held[i] = 0;
    if (e.amt[i] > after.matCap[i]) e.amt[i] = after.matCap[i];
    if (e.amt[i] <= 0) { e.amt[i] = 0; e.mat[i] = 0; }
    if (after.gun[i] === 0 && after.role[i] !== P_SELECTOR) e.flags[i] = 0;
  }
  e.sig = after.sig; e.gauge = portsGauge(after, e);
  return e;
}
export function portsGauge(L: PortsLayout, e: PortsState): number { let g = 0; for (const r of L.relays) g += e.held[r]; return g; }
export function portsGaugePct(L: PortsLayout, e: PortsState): number { return L.gaugeMax > 0 ? Math.round((10000 * e.gauge) / L.gaugeMax) / 100 : 100; }

// ================================================================ effective stats (a part's material)
/** The feed index a part's stats are shaped by now: its material, if it holds enough for its next use and takes it */
export function matOf(L: PortsLayout, e: PortsState, p: number): number {
  const f = e.mat[p];
  if (!f || e.amt[p] < L.matUse[p] || !(L.takes[p] & (1 << (f - 1)))) return 0;
  return f;
}
const W = (L: PortsLayout) => L.feeds.length;
export const effShot = (L: PortsLayout, e: PortsState, p: number): number => { const f = matOf(L, e, p); return f ? Math.round(L.shot[p] * L.mShot[p * W(L) + f]) : L.shot[p]; };
export const effDamage = (L: PortsLayout, e: PortsState, p: number): number => { const f = matOf(L, e, p); return f ? L.mDamage[p * W(L) + f] : 1; };
export const effCycle = (L: PortsLayout, e: PortsState, p: number): number => { const f = matOf(L, e, p); return f ? L.mCycle[p * W(L) + f] : 1; };
const effDischarge = (L: PortsLayout, e: PortsState, p: number): number => { const f = matOf(L, e, p); return f ? Math.round(L.discharge[p] * L.mDischarge[p * W(L) + f]) : L.discharge[p]; };
const effRest = (L: PortsLayout, e: PortsState, p: number): number => { const f = matOf(L, e, p); return f ? Math.round(L.rest[p] * L.mRest[p * W(L) + f]) : L.rest[p]; };
const effThreshold = (L: PortsLayout, e: PortsState, p: number): number => { const f = matOf(L, e, p); return f ? Math.floor(L.threshold[p] * L.mThreshold[p * W(L) + f]) : L.threshold[p]; };
const effSteady = (L: PortsLayout, e: PortsState, p: number): number => { const f = matOf(L, e, p); return f ? Math.round(L.steady[p] * L.mSteady[p * W(L) + f]) : L.steady[p]; };
/** A gun's buffer under its material (a bigger shot: a bigger buffer) */
export const effCap = (L: PortsLayout, e: PortsState, p: number): number => { const f = matOf(L, e, p); return f && L.gun[p] ? (L.gun[p] === 3 ? L.cap[p] : Math.round(L.cap[p] * L.mShot[p * W(L) + f])) : L.cap[p]; };
/** Thrust multiplier (material, and boost when boosting) */
export function effThrust(L: PortsLayout, e: PortsState, p: number): number { const f = matOf(L, e, p); return f ? L.mThrust[p * W(L) + f] : 1; }

// ================================================================ the tick
export interface PortsControls {
  /** By part: 1 for a thruster pushing this tick; null: none */
  active: Uint8Array | null;
  boosting: boolean;
  /** By part: eu each tool wants this tick; null: its full rate */
  toolWant: Int32Array | null;
  /** The guns' triggers (beams light and burn in portsBeamStep; this is for the latch of clips): the Reload input */
  reload: boolean;
}
let sOffer = new Int32Array(16), sSend = new Int32Array(16), sInNow = new Int32Array(16), sOutNow = new Int32Array(16), sFrac = new Float64Array(16), sMul = new Float64Array(16), sMatIn = new Int32Array(16), sBurnNow = new Int32Array(16);
let sList = new Int32Array(16), sWant = new Int32Array(16);
function grow(nl: number, np: number): void {
  if (sOffer.length < nl) { const m = Math.max(nl, sOffer.length * 2); sOffer = new Int32Array(m); sSend = new Int32Array(m); }
  if (sInNow.length < np) { const m = Math.max(np, sInNow.length * 2); sInNow = new Int32Array(m); sOutNow = new Int32Array(m); sFrac = new Float64Array(m); sMul = new Float64Array(m); sMatIn = new Int32Array(m); sBurnNow = new Int32Array(m); sList = new Int32Array(m); sWant = new Int32Array(m); }
}
/** Thruster parts: the share of its burn each got this tick (1 when inactive), and its boost multiplier. Module scratch, valid straight after portsTick */
export function portsThrustFrac(): Float64Array { return sFrac; }
export function portsThrustMul(): Float64Array { return sMul; }
/** Per part, eu that arrived this tick (the hangar's flow) */
export function portsInflow(): Int32Array { return sInNow; }

/** Water-fill `supply` over the wants in sList[0..cnt) (sWant by part), smallest want first; writes the grants back into sWant */
function waterfill(cnt: number, supply: number): void {
  // (insertion sort by want, ties by part index: deterministic)
  for (let y = 1; y < cnt; y++) { const v = sList[y], w = sWant[v]; let x = y; while (x > 0 && (sWant[sList[x - 1]] > w || (sWant[sList[x - 1]] === w && sList[x - 1] > v))) { sList[x] = sList[x - 1]; x--; } sList[x] = v; }
  let left = supply < 0 ? 0 : supply, k = cnt;
  for (let y = 0; y < cnt; y++) { const p = sList[y], share = Math.floor(left / k--), g = sWant[p] < share ? sWant[p] : share; sWant[p] = g > 0 ? g : 0; left -= sWant[p]; }
}
/** A taker's space this tick: its room, or nothing while its ports are shut (discharge, rest, a lit burst beam) */
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

/** One tick. After it portsThrustFrac()/portsThrustMul() hold each thruster's share and boost; the guns are gated by portsGunReady etc. */
export function portsTick(L: PortsLayout, e: PortsState, ctl: Readonly<PortsControls>): void {
  grow(L.links, L.n);
  const held = e.held, cap = L.cap, nl = L.links, offer = sOffer, send = sSend;
  // 1. Offer: a generator the cap on every link; a relay what it holds, water-filled over its out links
  for (let l = 0; l < nl; l++) offer[l] = 0;
  for (const g of L.gens) for (let x = L.outStart[g]; x < L.outStart[g + 1]; x++) { const l = L.outLink[x]; offer[l] = L.linkCap[l]; }
  for (const s of L.relays) {
    const a = L.outStart[s], b = L.outStart[s + 1]; if (a === b) continue;
    if (b - a === 1) { const l = L.outLink[a]; offer[l] = held[s] < L.linkCap[l] ? held[s] : L.linkCap[l]; continue; }
    let cnt = 0; for (let x = a; x < b; x++) { const l = L.outLink[x]; sList[cnt++] = l; sWant[l] = L.linkCap[l]; }
    waterfill(cnt, held[s]);
    for (let x = a; x < b; x++) { const l = L.outLink[x]; offer[l] = sWant[l]; }
  }
  // 2. Accept: each taker up to its space, water-filled over its in links; a thresholded gun only from lines rated enough
  for (let l = 0; l < nl; l++) send[l] = 0;
  for (let p = 0; p < L.n; p++) {
    const a = L.inStart[p], b = L.inStart[p + 1]; if (a === b) continue;
    let space = spaceOf(L, e, p);
    const th = L.role[p] === P_WEAPON ? effThreshold(L, e, p) : 0;
    if (th > 0) { let rated = 0; for (let x = a; x < b; x++) { const l = L.inLink[x]; if (offer[l] > 0) rated += L.linkCap[l]; } if (rated < th) space = 0; }
    if (b - a === 1) { const l = L.inLink[a]; send[l] = offer[l] < space ? offer[l] : space; continue; }
    let cnt = 0; for (let x = a; x < b; x++) { const l = L.inLink[x]; sList[cnt++] = l; sWant[l] = offer[l]; }
    waterfill(cnt, space);
    for (let x = a; x < b; x++) { const l = L.inLink[x]; send[l] = sWant[l]; }
  }
  // 3. Apply
  for (let p = 0; p < L.n; p++) { sInNow[p] = 0; sOutNow[p] = 0; }
  for (let l = 0; l < nl; l++) { const s = send[l]; if (s > 0) { sOutNow[L.linkFrom[l]] += s; sInNow[L.linkTo[l]] += s; } }
  for (const s of L.relays) held[s] += sInNow[s] - sOutNow[s];
  for (const c of L.consumers) held[c] += sInNow[c];
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
  const active = ctl.active;
  for (const p of L.thrusters) {
    const on = active !== null && active[p] !== 0;
    if (!on) { sFrac[p] = 1; sMul[p] = 1; sBurnNow[p] = 0; continue; }
    const f = matOf(L, e, p), at = p * L.feeds.length + f;
    const bm = f ? L.mBurn[at] : 1, tm = f ? L.mThrust[at] : 1, bo = f ? L.boostMul[p] * L.mBoost[at] : L.boostMul[p];
    const b = Math.max(1, Math.round(L.burn[p] * bm)), bb = Math.max(b, Math.round(L.bBurn[p] * bm * (f ? L.mBoostDrain[at] : 1)));
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
    const w = tw ? tw[p] : L.rate[p], want = w > 0 ? w : 0, got = held[p] < want ? held[p] : want;
    held[p] -= got;
    e.sat[p] = want > 0 ? Math.round((255 * got) / want) : 255;
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
    const st = effSteady(L, e, p);
    if (st > 0 && e.closed[p] === 0 && held[p] > 0 && held[p] < effCap(L, e, p) - 2 * L.passive[p] && sInNow[p] < st) held[p] = 0;
    if (L.passive[p] > 0) { held[p] -= L.passive[p]; if (held[p] < 0) held[p] = 0; }
    if (e.amt[p] <= 0) { e.amt[p] = 0; e.mat[p] = 0; }
  }
  for (const p of L.thrusters) if (e.amt[p] <= 0) { e.amt[p] = 0; e.mat[p] = 0; }
  e.gauge = portsGauge(L, e);
}

/** Thrusters alone, intake assumed met (replicas): each buffer refills at its full intake, then burns */
export function portsThrustersFree(L: PortsLayout, e: PortsState, ctl: Readonly<PortsControls>): void {
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
/** Pay for a shot: eu off the buffer, material off the feed buffer, the ports shut for the discharge. Returns the damage multiplier its material gives */
export function portsSpendShot(L: PortsLayout, e: PortsState, p: number, n = L.rounds[p] || 1): number {
  const f = matOf(L, e, p), s = effShot(L, e, p) * n, h = e.held[p], paid = h < s ? h : s;
  const dmg = f ? L.mDamage[p * L.feeds.length + f] : 1;
  e.held[p] = h - paid;
  const d = effDischarge(L, e, p); if (d > 0) e.closed[p] = d > 32000 ? 32000 : d;
  if (f) { e.amt[p] -= L.matUse[p] * n; if (e.amt[p] <= 0) { e.amt[p] = 0; e.mat[p] = 0; } }
  if (L.gun[p] === 2 && e.held[p] < s) e.flags[p] |= PF_LATCH;
  return dmg;
}
/** A beam's tick while the trigger's held: lights when it may (a burst beam only when full), burns a tick's worth, goes out and rests when it can't. Returns eu burnt */
export function portsBeamStep(L: PortsLayout, e: PortsState, p: number, trigger: boolean): number {
  let fl = e.flags[p];
  if (!trigger) { e.flags[p] = fl & ~PF_LIT; return 0; }
  const f = matOf(L, e, p), b = f ? Math.max(1, Math.round(L.shot[p] * L.mBurn[p * L.feeds.length + f])) : L.shot[p], h = e.held[p];
  if (L.feedPort[p] === 2 && !f) { e.flags[p] = fl & ~PF_LIT; return 0; }
  const light = L.burst[p] ? L.cap[p] - 2 * L.passive[p] - 1 : L.relight[p];
  if (!(fl & PF_LIT) && e.closed[p] === 0 && h >= light && h >= b) fl = (fl | PF_LIT) & ~PF_LATCH;
  if (fl & PF_LIT) {
    if (h >= b) { e.held[p] = h - b; e.flags[p] = fl; if (f) { e.amt[p] -= L.matUse[p]; if (e.amt[p] <= 0) { e.amt[p] = 0; e.mat[p] = 0; } } return b; }
    fl = (fl & ~PF_LIT) | PF_LATCH;
    const r = effRest(L, e, p); if (r > 0) e.closed[p] = r > 32000 ? 32000 : r;
  }
  e.flags[p] = fl;
  return 0;
}
/** Flip a Selector (or every one with part < 0) to its other input */
export function portsSwitchFeeds(L: PortsLayout, e: PortsState, part = -1): void {
  for (const s of L.selectors) if (part < 0 || s === part) e.flags[s] ^= PF_SEL;
}
/** Empty every feed buffer and line (what was in them is lost) */
export function portsPurge(L: PortsLayout, e: PortsState): void {
  for (let p = 0; p < L.n; p++) if (L.role[p] !== P_TANK) { e.amt[p] = 0; e.mat[p] = 0; }
}

// ================================================================ the wire (the pilot row's energy slot, triples)
/** What the slot means (in the wire hash: a change of meaning is a protocol bump) */
export const PORTS_SLOT_LAYOUT = 'ports:triples(part,held*8+flags3,closed*2^24+mat*2^20+amt)';
export const PORTS_ROW = { sig: 8, count: 9, at: 13 } as const;
const FLAGS = 8, AMT_MOD = 1 << 20, MAT_MOD = 1 << 24;
/** Append the triples to `out` (from data[PORTS_ROW.at]). Returns the triple count; the row carries -count in data[PORTS_ROW.count] and L.sig in data[PORTS_ROW.sig] */
export function packPorts(L: PortsLayout, e: PortsState, out: number[]): number {
  let n = 0;
  for (let p = 0; p < L.n; p++) {
    const c = L.cap[p], full = e.held[p] === c && e.flags[p] === 0 && e.amt[p] === 0 && e.closed[p] === 0;
    if ((c <= 0 && !L.matCap[p] && L.role[p] !== P_SELECTOR) || full) continue;
    out.push(p, e.held[p] * FLAGS + (e.flags[p] & PF_MASK), Math.min(32000, e.closed[p]) * MAT_MOD + e.mat[p] * AMT_MOD + Math.min(AMT_MOD - 1, e.amt[p]));
    n++;
  }
  return n;
}
/** Where a ports row's slot ends (data[9] is -count) */
export function portsSlotEnd(data: ArrayLike<number>): number {
  const n = Math.max(0, -(data[PORTS_ROW.count] | 0));
  return Math.min(data.length, PORTS_ROW.at + 3 * n);
}
export const isPortsRow = (data: ArrayLike<number> | undefined): boolean => !!data && data.length > PORTS_ROW.count && (data[PORTS_ROW.count] | 0) < 0;
/** Read the slot into `e`: every part full and clear, then the triples. False (e untouched) when the sig isn't this layout's */
export function unpackPortsInto(L: PortsLayout, e: PortsState, data: ArrayLike<number>): boolean {
  if (!isPortsRow(data) || data[PORTS_ROW.sig] !== L.sig || e.held.length !== L.n) return false;
  fullPorts(L, e);
  const end = portsSlotEnd(data);
  for (let k = PORTS_ROW.at; k + 2 < end; k += 3) {
    const p = data[k], v = data[k + 1], m = data[k + 2];
    if (!Number.isInteger(p) || p < 0 || p >= L.n || !Number.isInteger(v) || v < 0 || !Number.isInteger(m) || m < 0) continue;
    const h = Math.floor(v / FLAGS);
    e.held[p] = h > L.cap[p] ? L.cap[p] : h; e.flags[p] = v - h * FLAGS;
    e.closed[p] = Math.floor(m / MAT_MOD); const rest = m - e.closed[p] * MAT_MOD; e.mat[p] = Math.floor(rest / AMT_MOD); e.amt[p] = rest - e.mat[p] * AMT_MOD;
    if (e.amt[p] > L.matCap[p]) e.amt[p] = L.matCap[p];
  }
  e.sig = L.sig; e.gauge = portsGauge(L, e);
  return true;
}
/** The 16-bit digest for the stateHash */
export function portsDigest(L: PortsLayout, e: PortsState): number {
  let h = 0x811c9dc5 | 0;
  for (let p = 0; p < L.n; p++) {
    if (L.cap[p] <= 0 && !L.matCap[p]) continue;
    h = Math.imul(h ^ p, 0x01000193); h = Math.imul(h ^ e.held[p], 0x01000193); h = Math.imul(h ^ e.flags[p], 0x01000193); h = Math.imul(h ^ e.amt[p], 0x01000193);
  }
  return ((h >>> 16) ^ (h & 0xffff)) & 0xffff;
}
