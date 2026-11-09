/**
 * @contract power.ports-types
 * owns:       the ports core's constants (roles, flags, rates) and the PortsLayout / PortsState shapes
 * needs:      common/ships types, tuning
 * invariants: layout and state shapes are the ones the tick, wire and hangar read — common/src/ships/power/ports.test.ts
 * extend:     a new part role is a P_* constant here, with its case in portsBuild and ports
 */

import type { FireSpec, FunctionDef, MaterialDef, PlacedPart, Side, Vec2, WeaponMods } from '../types.js';
import type { ShipTuning } from '../tuning.js';

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
export const MAT_RATE = 30;
export const BOOST_DRAW = 2.2;
/** Touch-routed lines (FunctionDef.touch 'relay'): E a second across each edge, and what one with no store holds a cell */
export const TOUCH_LINE_RATE = 200;
export const TOUCH_LINE_HOLDS = 10;
/** Ticks a second */
export const TPS = 60;

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
