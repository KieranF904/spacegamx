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

import type { FireSpec, FunctionDef, MaterialDef, PlacedPart, Rot, Side, Vec2, WeaponMods } from '../types.js';
import type { ShipTuning } from '../tuning.js';
import { SIDE_NORMAL, transformPoint, transformSide } from '../catalog.js';
import { fnOutput, isEngine, partDemand, partSupply } from '../grades.js';
import { EU, perTick, perTickUp, toEu } from './units.js';

// ---- Roles
/** Thruster kinds (PortsLayout.thrustKind) */
export const TK_ENGINE = 0, TK_STRAFER = 1, TK_GYRO = 2;
/**
 * Field machines (FunctionDef.machine; docs/design/field-fabrication.md): PortsLayout.machine's kinds, and the bit of
 * PortsState.mach that lets each draw. A machine is a tool that draws its full rate only while its bit is set (the server
 * sets it while the machine is switched on and has work it can do, and tells the pilot: a decision, never a stream), and
 * nothing otherwise; what it got is summed into PortsState.machEu[kind], the energy its jobs progress by
 */
export const MACHINE_FAB = 1, MACHINE_REF = 2;
export const machineBit = (kind: number): number => 1 << (kind - 1);
export const P_INERT = 0, P_GEN = 1, P_RELAY = 2, P_THRUSTER = 3, P_TOOL = 4, P_WEAPON = 5, P_TANK = 6, P_SELECTOR = 7, P_PIPE = 8;
// ---- Flags (PortsState.flags; three bits on the wire)
/** A clip reloading, or a burst beam resting */
export const PF_LATCH = 1;
/** A beam lit */
export const PF_LIT = 2;
/** A Selector passing its second input */
export const PF_SEL = 4;
/** A beam burning augmented this tick (its augment buffer pays) */
export const PF_AUG = 8;
export const PF_MASK = 15;

/** Material amounts are kept in hundredths */
export const MAT_UNIT = 100;
/** Material moves at most this much a second across a link or out of a network */
const MAT_RATE = 30;
const BOOST_DRAW = 2.2;
/** Touch-routed lines (FunctionDef.touch 'relay'): E a second across each edge, and what one with no store holds a cell */
const TOUCH_LINE_RATE = 200;
const TOUCH_LINE_HOLDS = 10;
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
  /** The stats it multiplies: shot, damage, cycle, discharge, rest, burn, steady (the floor), thrust, boost, boostDrain */
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
  /** eu a tick: a consumer's own intake before its lines cap it (rate is the lower of the two): the hangar's load test */
  intake: Int32Array;
  /** Thrusters: what kind (TK_ENGINE, TK_STRAFER a Burst Strafer, TK_GYRO a Gyro: these two burn only while their part
   * feature asks, PortsControls.scale its share of the burn), burn a tick, boosted burn, boost multiplier */
  thrustKind: Uint8Array;
  burn: Int32Array;
  bBurn: Int32Array;
  boostMul: Float64Array;
  /** Weapons: 1 shot gun, 2 clip, 3 beam; eu a shot (a beam: a tick's burn); rounds a salvo; relight eu */
  gun: Uint8Array;
  shot: Int32Array;
  rounds: Int32Array;
  relight: Int32Array;
  /** Weapons' power profiles: passive eu a tick, discharge and rest in ticks, burst 0/1, and `steady`, the floor: eu a tick
   * its lines must deliver while it fills, or what it has gathered collapses (a lone reactor can't trickle a heavy gun full) */
  passive: Int32Array;
  discharge: Int32Array;
  rest: Int32Array;
  burst: Uint8Array;
  steady: Int32Array;
  /** Beams fired in pieces (FunctionDef.profile.pieces; portsBeamStep): how many pieces its buffer is (0: a plain beam), eu a
   * piece, ticks a piece burns (its share of the buffer's burn time), and its centre spike: the ticks [spikeLo, spikeHi) of a
   * piece burn x spikeIn, the rest x spikeOut (the same damage a piece: spikeOut x (T - w) + spikeIn x w = T) */
  pieces: Uint8Array;
  pieceE: Int32Array;
  pieceT: Int32Array;
  spikeLo: Int32Array;
  spikeHi: Int32Array;
  spikeIn: Float64Array;
  spikeOut: Float64Array;
  /** Weapons with an augment input (FunctionDef.augment): its buffer (eu), what a shot (a beam: a tick) costs, the most it
   * takes a tick, its floor (eu a tick, as `steady`), and a beam's dps x while augmented. 0 cap: none */
  augCap: Int32Array;
  augCost: Int32Array;
  augRate: Int32Array;
  augSteady: Int32Array;
  augDps: Float64Array;
  /** Per part: its augment's mods (what an augmented shot adds) and name, or undefined */
  augMods: readonly (WeaponMods | undefined)[];
  augName: readonly (string | undefined)[];
  /** Weapons: the damage x its infrastructure tier gives it (FunctionDef.infra) */
  tierDmg: Float64Array;
  /** Tools: 1 for a shield generator */
  shield: Uint8Array;
  /** Tools: 1 for a mining laser (portsMineStep draws it, by the pulse), and its pulse's length in ticks */
  miner: Uint8Array;
  /** Tools: a field machine's kind (MACHINE_FAB, MACHINE_REF; 0 none): it draws only while PortsState.mach has its bit */
  machine: Uint8Array;
  minePulse: Int32Array;
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
  /** 1 for a link into a weapon's augment input */
  linkAug: Uint8Array;
  /** Per part: its out links are links[outStart[p] .. outStart[p+1]], its in links inStart[p] .. (link ids) */
  outStart: Int32Array;
  outLink: Int32Array;
  inStart: Int32Array;
  inLink: Int32Array;
  /** Per part: open in ports (a consumer's with nothing across) and open out ports (a generator's), for the hangar */
  openIn: Uint8Array;
  openOut: Uint8Array;
  /** Every port, placed, for the hangar: part, dir (0 in, 1 out), x, y (its cell), side, rate (E/s), linked (0/1), its link's id (-1 none), a weapon's augment input (1) */
  ports: { part: number; dir: 0 | 1; x: number; y: number; side: Side; rate: number; link: number; l: number; aug: 0 | 1 }[];
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
  /** Touch generators (FunctionDef.touch 'gen'): touching ones make a block; touchOut[block] is its eu a tick, shared over all its
   * members' links by what each taker has room for; touchClus the block of each member (its lowest part; -1 a ported
   * generator), touchNext the next member (-1 the last) */
  touchOut: Int32Array;
  touchClus: Int32Array;
  touchNext: Int32Array;
  /** Totals for ShipDerived.energy and the hangar (E a second) */
  supply: number;
  engineDraw: number;
  weaponDraw: number;
  /** E a second the Burst Strafers burn during a burst, the Gyros turning flat out, the shields (always: a steady load) */
  strafeDraw: number;
  gyroDraw: number;
  shieldDraw: number;
  /** E a second the field machines draw while they work (fabricator and refiner together) */
  machineDraw: number;
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
  /** A weapon's augment buffer, eu */
  aug: Int32Array;
  /** Tools: the share of what each wanted that it got this tick, 0..255 */
  sat: Uint8Array;
  shieldSat: number;
  gauge: number;
  /** Field machines: which may draw this tick (bits machineBit(kind)); 0: none. A control the server sets, kept by remaps */
  mach: number;
  /** Field machines: eu each kind has taken in all (index = kind): its jobs' progress (econ/field/jobs.ts). Kept by remaps */
  machEu: Float64Array;
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
  const thrustKind = new Uint8Array(n);
  const role = new Uint8Array(n), cap = Z(), rate = Z(), burn = Z(), bBurn = Z(), boostMul = new Float64Array(n).fill(1);
  const gun = new Uint8Array(n), shot = Z(), rounds = Z(), relight = Z(), passive = Z(), discharge = Z(), rest = Z(), burst = new Uint8Array(n), steady = Z();
  const pieces = new Uint8Array(n), pieceE = Z(), pieceT = Z(), spikeLo = Z(), spikeHi = Z(), spikeIn = new Float64Array(n).fill(1), spikeOut = new Float64Array(n).fill(1);
  const augCap = Z(), augCost = Z(), augRate = Z(), augSteady = Z(), augDps = new Float64Array(n).fill(1), augMods: (WeaponMods | undefined)[] = new Array(n).fill(undefined), augName: (string | undefined)[] = new Array(n).fill(undefined);
  const tierDmg = new Float64Array(n).fill(1);
  const miner = new Uint8Array(n), minePulse = Z(), machine = new Uint8Array(n);
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
      if ((fn.shield ?? 0) > 0 && !fn.flash) { shield[i] = 1; shieldDraw += partDemand(fn, a, m); }
      if (fn.mining) { miner[i] = 1; minePulse[i] = Math.max(1, Math.round((fn.minePulse ?? 0.9) * TPS)); }
      if (fn.machine) { machine[i] = fn.machine.kind === 'fabricator' ? MACHINE_FAB : MACHINE_REF; machineDraw += partDemand(fn, a, m); }
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

  // ---- Ports, placed; links where an out port faces an in port across a shared edge
  const occ = new Map<number, number>();
  const key = (x: number, y: number) => (x + 1024) * 4096 + (y + 1024);
  const frames: PartFrame[] = [];
  for (let i = 0; i < n; i++) {
    frames.push(frameOf(parts[i], input.cells[i]));
    if (alive[i]) for (const c of input.cells[i]) occ.set(key(c[0], c[1]), i);
  }
  type Port = { part: number; dir: 0 | 1; x: number; y: number; side: Side; nx: number; ny: number; rate: number; link: number; aug: 0 | 1 };
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
    n, sig: 0, role, cap, rate, intake, thrustKind, burn, bBurn, boostMul, tierDmg, gun, shot, rounds, relight, passive, discharge, rest, burst, steady, pieces, pieceE, pieceT, spikeLo, spikeHi, spikeIn, spikeOut, augCap, augCost, augRate, augSteady, augDps, augMods, augName, shield, miner, minePulse, machine, carrier, matCap, matUse, takes, tankFeed, feedPort,
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
  return L;
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

// ================================================================ state
export function createPortsState(L: PortsLayout): PortsState {
  return fullPorts(L, { sig: L.sig, held: new Int32Array(L.n), flags: new Uint8Array(L.n), amt: new Int32Array(L.n), mat: new Uint8Array(L.n), closed: new Int16Array(L.n), aug: new Int32Array(L.n), sat: new Uint8Array(L.n), shieldSat: 255, gauge: 0, mach: 0, machEu: new Float64Array(3) });
}
/** Everything full: stores, buffers and tanks; no material in the guns, lines or engines */
export function fullPorts(L: PortsLayout, out?: PortsState): PortsState {
  if (!out || out.held.length !== L.n) return createPortsState(L);
  out.held.set(L.cap); out.aug.set(L.augCap);
  for (const c of L.carriers) out.held[c] = 0;
  out.flags.fill(0); out.amt.fill(0); out.mat.fill(0); out.closed.fill(0); out.sat.fill(255); out.shieldSat = 255; out.sig = L.sig; out.gauge = portsGauge(L, out);
  return out;
}
/** After a rebuild: the same design keeps what each part held (clamped); a new one starts full */
export function remapPorts(e: PortsState, after: PortsLayout, sameDesign: boolean): PortsState {
  if (!sameDesign || e.held.length !== after.n) {
    // (The field machines' switches and their energy counters go with the ship, whatever its design: jobs progress by them)
    const f = fullPorts(after, e.held.length === after.n ? e : undefined);
    if (f !== e) { f.mach = e.mach; f.machEu.set(e.machEu); }
    return f;
  }
  for (let i = 0; i < after.n; i++) {
    if (e.held[i] > after.cap[i]) e.held[i] = after.cap[i];
    if (e.held[i] < 0) e.held[i] = 0;
    if (e.aug[i] > after.augCap[i]) e.aug[i] = after.augCap[i];
    if (e.amt[i] > after.matCap[i]) e.amt[i] = after.matCap[i];
    if (e.amt[i] <= 0) { e.amt[i] = 0; e.mat[i] = 0; }
    if (after.gun[i] === 0 && after.role[i] !== P_SELECTOR) e.flags[i] = 0;
  }
  e.sig = after.sig; e.gauge = portsGauge(after, e);
  return e;
}
/**
 * Into another design whose parts are the old one's moved about, some added (a field plan's appended parts) or taken
 * away (a recycled part): `keep[i]` is the old index of the new part i, or -1 for a new part. A kept part keeps what it
 * held (clamped, as remapPorts does); a new one starts empty. So a plan save or a recycle is never a free store refill
 * (docs/design/field-fabrication.md section 5.1). The machines' switches and counters go with the ship
 */
export function remapPortsByIndex(e: PortsState, after: PortsLayout, keep: ArrayLike<number>): PortsState {
  const out = createPortsState(after);
  const old = e.held.length;
  out.held.fill(0); out.aug.fill(0);
  for (let i = 0; i < after.n; i++) {
    const o = i < keep.length ? keep[i] : -1;
    if (!(o >= 0 && o < old)) continue;
    out.held[i] = Math.max(0, Math.min(after.cap[i], e.held[o]));
    out.aug[i] = Math.max(0, Math.min(after.augCap[i], e.aug[o]));
    out.amt[i] = Math.max(0, Math.min(after.matCap[i], e.amt[o]));
    out.mat[i] = out.amt[i] > 0 ? e.mat[o] : 0;
    out.closed[i] = e.closed[o];
    out.sat[i] = e.sat[o];
    out.flags[i] = after.gun[i] === 0 && after.role[i] !== P_SELECTOR ? 0 : e.flags[o];
  }
  out.shieldSat = e.shieldSat;
  out.mach = e.mach;
  out.machEu.set(e.machEu);
  out.sig = after.sig; out.gauge = portsGauge(after, out);
  return out;
}
export function portsGauge(L: PortsLayout, e: PortsState): number { let g = 0; for (const r of L.relays) g += e.held[r]; return g; }
export function portsGaugePct(L: PortsLayout, e: PortsState): number { return L.gaugeMax > 0 ? Math.round((10000 * e.gauge) / L.gaugeMax) / 100 : 100; }
/** The live part that is this kind of field machine (MACHINE_FAB, MACHINE_REF), or -1 */
export function portsMachinePart(L: PortsLayout, kind: number): number {
  for (const p of L.tools) if (L.machine[p] === kind) return p;
  return -1;
}
/** Let a field machine draw (on) or not: the server's decision, applied on the tick it is made on both sides */
export function setPortsMachine(e: PortsState, kind: number, on: boolean): void {
  const b = machineBit(kind);
  e.mach = on ? e.mach | b : e.mach & ~b;
}
/** eu a field machine kind has taken in all (its jobs progress by the difference between two reads) */
export function portsMachineEu(e: PortsState, kind: number): number { return e.machEu[kind] ?? 0; }

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
const effSteady = (L: PortsLayout, e: PortsState, p: number): number => { const f = matOf(L, e, p); return f ? Math.round(L.steady[p] * L.mSteady[p * W(L) + f]) : L.steady[p]; };
/** A gun's buffer under its material (a bigger shot: a bigger buffer) */
export const effCap = (L: PortsLayout, e: PortsState, p: number): number => { const f = matOf(L, e, p); return f && L.gun[p] ? (L.gun[p] === 3 ? L.cap[p] : Math.round(L.cap[p] * L.mShot[p * W(L) + f])) : L.cap[p]; };
/** Thrust multiplier (material, and boost when boosting) */
export function effThrust(L: PortsLayout, e: PortsState, p: number): number { const f = matOf(L, e, p); return f ? L.mThrust[p * W(L) + f] : 1; }

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
export function portsPurge(L: PortsLayout, e: PortsState): void {
  for (let p = 0; p < L.n; p++) if (L.role[p] !== P_TANK) { e.amt[p] = 0; e.mat[p] = 0; }
}

// ================================================================ the wire (the pilot row's energy slot, triples)
/** What the slot means (in the wire hash: a change of meaning is a protocol bump) */
export const PORTS_SLOT_LAYOUT = 'ports:quads(part,held*16+flags4,closed*2^24+mat*2^20+amt,aug);closed=a lit piece beam ticks left, a mining pulse ticks left';
export const PORTS_ROW = { sig: 8, count: 9, at: 13 } as const;
const FLAGS = 16, AMT_MOD = 1 << 20, MAT_MOD = 1 << 24, PER = 4;
/** Append the triples to `out` (from data[PORTS_ROW.at]). Returns the triple count; the row carries -count in data[PORTS_ROW.count] and L.sig in data[PORTS_ROW.sig] */
export function packPorts(L: PortsLayout, e: PortsState, out: number[]): number {
  let n = 0;
  for (let p = 0; p < L.n; p++) {
    const c = L.cap[p], full = e.held[p] === c && e.flags[p] === 0 && e.amt[p] === 0 && e.closed[p] === 0 && e.aug[p] === L.augCap[p];
    if ((c <= 0 && !L.matCap[p] && L.role[p] !== P_SELECTOR) || full) continue;
    out.push(p, e.held[p] * FLAGS + (e.flags[p] & PF_MASK), Math.min(32000, e.closed[p]) * MAT_MOD + e.mat[p] * AMT_MOD + Math.min(AMT_MOD - 1, e.amt[p]), e.aug[p]);
    n++;
  }
  return n;
}
/** Where a ports row's slot ends (data[9] is -count) */
export function portsSlotEnd(data: ArrayLike<number>): number {
  const n = Math.max(0, -(data[PORTS_ROW.count] | 0));
  return Math.min(data.length, PORTS_ROW.at + PER * n);
}
export const isPortsRow = (data: ArrayLike<number> | undefined): boolean => !!data && data.length > PORTS_ROW.count && (data[PORTS_ROW.count] | 0) < 0;
/** Read the slot into `e`: every part full and clear, then the triples. False (e untouched) when the sig isn't this layout's */
export function unpackPortsInto(L: PortsLayout, e: PortsState, data: ArrayLike<number>): boolean {
  if (!isPortsRow(data) || data[PORTS_ROW.sig] !== L.sig || e.held.length !== L.n) return false;
  fullPorts(L, e);
  const end = portsSlotEnd(data);
  for (let k = PORTS_ROW.at; k + PER - 1 < end; k += PER) {
    const p = data[k], v = data[k + 1], m = data[k + 2], g = data[k + 3];
    if (!Number.isInteger(p) || p < 0 || p >= L.n || !Number.isInteger(v) || v < 0 || !Number.isInteger(m) || m < 0) continue;
    const h = Math.floor(v / FLAGS);
    e.held[p] = h > L.cap[p] ? L.cap[p] : h; e.flags[p] = v - h * FLAGS;
    e.closed[p] = Math.floor(m / MAT_MOD); const rest = m - e.closed[p] * MAT_MOD; e.mat[p] = Math.floor(rest / AMT_MOD); e.amt[p] = rest - e.mat[p] * AMT_MOD;
    if (e.amt[p] > L.matCap[p]) e.amt[p] = L.matCap[p];
    e.aug[p] = Number.isInteger(g) && g > 0 ? Math.min(g, L.augCap[p]) : 0;
  }
  e.sig = L.sig; e.gauge = portsGauge(L, e);
  return true;
}
/** The 16-bit digest for the stateHash */
export function portsDigest(L: PortsLayout, e: PortsState): number {
  let h = 0x811c9dc5 | 0;
  for (let p = 0; p < L.n; p++) {
    if (L.cap[p] <= 0 && !L.matCap[p]) continue;
    h = Math.imul(h ^ p, 0x01000193); h = Math.imul(h ^ e.held[p], 0x01000193); h = Math.imul(h ^ e.flags[p], 0x01000193); h = Math.imul(h ^ e.amt[p], 0x01000193); h = Math.imul(h ^ e.aug[p], 0x01000193);
  }
  return ((h >>> 16) ^ (h & 0xffff)) & 0xffff;
}
