/**
 * The energy graph (docs/design/energy-routing-impl.md §1.1, §2.2, with §0 D1: power moves only between parts that
 * touch). Built once a rebuild from the live parts, never per tick, never sent. tick.ts runs it.
 *
 * - Touch: two parts touch when they share a full cell edge (grid.ts computeJoins: connector keys with opposite
 *   normals, a shared triangle diagonal, and bespoke pieces' overlap joins). Corner contact never conducts. There are
 *   no wires: `bp.wires` plays no part in power.
 * - Roles: generator (`produce`), relay (the core, and anything with `store`: Battery, Capacitor, Drive Cell, Heavy
 *   Bank, Conduit, Diode), thruster (engines and Burst Strafers: their own buffer), tool (any other `demand`: shields,
 *   scanners, coils, miners, Tow), weapon (every gun in `input.weapons`: its own buffer), dynamo (`dynamo`), inert.
 * - A consumer's sources are the generators and relays it touches. A relay touching a relay is an equalising pair. A
 *   generator pushes into the relays it touches. A dynamo tops up the relays it touches.
 * - Diode (`oneWay`): x may pass power to y only if (x isn't a diode, or y is across x's out edge) and (y isn't a
 *   diode, or x isn't across y's out edge). So a diode gives only out of its facing edge, and takes from every other.
 *
 * All lists are in part-index order, so two builds of one design are equal (and so are the server's and the pilot's).
 */

import type { FireSpec, FunctionDef, MaterialDef } from '../types.js';
import type { ShipTuning } from '../tuning.js';
import { fnOutput, isEngine, partDemand, partSupply } from '../grades.js';
import { type PlacedGeom, geomContainsPoint, mountOf } from '../grid.js';
import { perTick, perTickUp, toEu } from './units.js';

// ---- Roles (EnergyLayout.role)
export const ROLE_INERT = 0;
export const ROLE_GEN = 1;
export const ROLE_RELAY = 2;
export const ROLE_THRUSTER = 3;
export const ROLE_TOOL = 4;
export const ROLE_WEAPON = 5;
export const ROLE_DYNAMO = 6;

// ---- Weapon buffer kinds (EnergyLayout.gun)
/** cycle, auto, ammo, charge: a buffer of `buffer` shots topped up continuously */
export const GUN_SHOT = 1;
/** clip: a true magazine; it takes energy only while LATCHED, and is latched until the whole clip is paid (D2) */
export const GUN_CLIP = 2;
/** beam: burns `shot` eu a tick while LIT, relights at `relight` eu */
export const GUN_BEAM = 3;

// ---- Consumer phases (served in this order each tick: EnergyLayout.phase)
export const PHASE_THRUST = 0;
export const PHASE_TOOL = 1;
export const PHASE_WEAPON = 2;

/** "No bound": settleEnergy never snaps a layout whose stores can't all be filled (fillBound) */
export const NO_FILL_BOUND = 0x7fffffff;
/** EnergyLayout.depth of a part that isn't a relay generation reaches */
export const NO_DEPTH = 0x7fffffff;

/** The energy tuning (data/ships/tuning.json `energy`; these defaults when absent) */
export const POWER_DEFAULTS = {
  coreCapacity: 240,
  coreDischarge: 720,
  coreIntake: 120,
  /** A beam relights once its buffer is back to this share of full (a weapon's fire.relight overrides) */
  relight: 0.5,
  /** Boosting engines burn × (1 + boostDraw × their boostDrain) */
  boostDraw: 2.2,
  /** Gives per cell of a (legacy) store with no `discharge` of its own; its Takes are a quarter of that */
  give: 600,
};
export type PowerTuning = typeof POWER_DEFAULTS;

const powerTunings = new WeakMap<ShipTuning, PowerTuning>();
export function powerTuning(t: ShipTuning): PowerTuning {
  let p = powerTunings.get(t);
  if (!p) {
    const e = (t as { energy?: Partial<PowerTuning> & { discharge?: { general?: number } } }).energy ?? {};
    p = {
      coreCapacity: e.coreCapacity ?? POWER_DEFAULTS.coreCapacity,
      coreDischarge: e.coreDischarge ?? POWER_DEFAULTS.coreDischarge,
      coreIntake: e.coreIntake ?? POWER_DEFAULTS.coreIntake,
      relight: e.relight ?? POWER_DEFAULTS.relight,
      boostDraw: e.boostDraw ?? POWER_DEFAULTS.boostDraw,
      give: e.discharge?.general ?? POWER_DEFAULTS.give,
    };
    powerTunings.set(t, p);
  }
  return p;
}

/** A store's Holds (E): `store` per cell × its output */
export function partHolds(fn: FunctionDef, area: number, m: MaterialDef | undefined): number {
  return (fn.store ?? 0) * area * fnOutput(fn, m);
}
/** A store's Gives (E a second): `discharge` per cell × its output (absent: the tuning's legacy default) */
export function partGives(fn: FunctionDef, area: number, m: MaterialDef | undefined, pt: PowerTuning): number {
  if (!((fn.store ?? 0) > 0)) return 0;
  return (fn.discharge ?? pt.give) * area * fnOutput(fn, m);
}
/** A store's Takes (E a second): `intake` per cell × its output (absent: a quarter of its Gives) */
export function partTakes(fn: FunctionDef, area: number, m: MaterialDef | undefined, pt: PowerTuning): number {
  if (!((fn.store ?? 0) > 0)) return 0;
  return fn.intake !== undefined ? fn.intake * area * fnOutput(fn, m) : partGives(fn, area, m, pt) / 4;
}

/** A weapon as rebuild knows it (WeaponInfo's fields the layout reads) */
export interface EnergyWeaponInput {
  part: number;
  /** Its firing model (rebuild.ts fireOf: a model's own, a legacy gun's from its kind) */
  fire: FireSpec;
  /**
   * Its ticks between shots with its rate mods, material and mount, but NOT its supply: no `/ satisfaction` term
   * (today's WeaponInfo.interval divides by it: P2.1 drops that term before building). A starved gun's interval would
   * shrink its intake and grow a legacy gun's shot: a feedback loop
   */
  interval: number;
}

export interface EnergyLayoutInput {
  fns: readonly FunctionDef[];
  area: readonly number[];
  mats: readonly (MaterialDef | undefined)[];
  /** Live parts (rebuild's `alive`); dead parts are inert and hold nothing */
  alive: readonly boolean[];
  /** Touching pairs (rebuild's `joins`: grid.ts computeJoins between intact parts), any order */
  joins: readonly (readonly [number, number])[];
  /** The live core's part index, or -1 */
  core: number;
  tuning: ShipTuning;
  /** The ship's guns (rebuild's WeaponInfo list). A weapon part not listed (no mount) is inert */
  weapons?: readonly EnergyWeaponInput[];
  /** Placed geometry (rebuild's `geoms`): only to find what's across a Diode's out edge. Absent: diodes give nowhere (so the game must pass it) */
  geoms?: readonly PlacedGeom[];
  /** Per part, its output against its health (tuning healthFactor): generators and dynamos make that share. Absent: 1 */
  health?: readonly number[];
}

/** The energy graph and every budget, in eu (ShipDerived.energy from P2). Arrays are by part index unless noted */
export interface EnergyLayout {
  /** Blueprint part count */
  n: number;
  /** u16 hash of the graph and the caps: the pilot row's guard against a rebuild race, and flightKey */
  sig: number;
  role: Uint8Array;
  /** eu: a relay's Holds, a weapon's buffer (shot × buffer; a beam's bufferE), a thruster's buffer. 0: holds nothing */
  cap: Int32Array;
  /** eu a tick: a generator's output, a consumer's intake (a tool's want while working), a dynamo's top-up */
  rate: Int32Array;
  /** eu a tick, relays: Gives and Takes */
  give: Int32Array;
  take: Int32Array;
  /** eu a tick, thrusters: Burn at full thrust, and boosted (bBurn = burn when it has no boost) */
  burn: Int32Array;
  bBurn: Int32Array;
  /** Thrusters: boost thrust ÷ thrust (1: no boost) */
  boostMul: Float64Array;
  /** Weapons: GUN_SHOT, GUN_CLIP or GUN_BEAM (0 otherwise) */
  gun: Uint8Array;
  /** Weapons: eu a shot (a clip: a round); a beam: eu it burns a tick while lit */
  shot: Int32Array;
  /** Clips: rounds a salvo fires (fire.rounds; the Hive's 4); 1 for every other gun. gunReady/spendShot's default n */
  rounds: Int32Array;
  /** Beams: eu held at which it may light again */
  relight: Int32Array;
  /** Tools: 1 for a shield generator (EnergyState.shieldSat) */
  shield: Uint8Array;
  /** Per part: the part across a Diode's out edge, or -1 */
  diodeOut: Int32Array;

  /** [start, end) of each phase's consumers in `cons`: phase k is cons[phase[k] .. phase[k+1]] (4 entries) */
  phase: Int32Array;
  /** Consumer part indices, by phase, ascending within a phase */
  cons: Int32Array;
  /** Per phase: its sources are srcPart[srcStart[k] .. srcStart[k+1]], generators (ascending) first, relays (ascending) from srcRelay[k] */
  srcStart: Int32Array;
  srcRelay: Int32Array;
  srcPart: Int32Array;
  /** Per source entry j (an index into srcPart): the consumers of that phase it feeds are feedCons[feedStart[j] .. feedStart[j+1]] (link ids feedStart[j]..) */
  feedStart: Int32Array;
  feedCons: Int32Array;
  /** Generators (ascending), and per generator entry g the relays it pushes into: pushRelay[pushStart[g] .. pushStart[g+1]] */
  gens: Int32Array;
  pushStart: Int32Array;
  pushRelay: Int32Array;
  /** Relays (ascending) */
  relays: Int32Array;
  /**
   * Per part: a relay's hops from generation (0: a generator pushes into it or a dynamo tops it up; +1 per pair power may
   * cross); NO_DEPTH for anything else. A full relay closes the last rounding gap only towards a deeper one (tick step 5)
   */
  depth: Int32Array;
  /** Relay pairs, sorted by (a, b), a < b; pairDir 0 both ways, 1 only a to b, 2 only b to a */
  pairA: Int32Array;
  pairB: Int32Array;
  pairDir: Uint8Array;
  /** Dynamos (ascending), and per dynamo entry the relays it tops up: dynRelay[dynStart[d] .. dynStart[d+1]] */
  dyns: Int32Array;
  dynStart: Int32Array;
  dynRelay: Int32Array;

  /** Per part: it has a source (consumers), or reaches/is reached from a generator or dynamo (hangar warnings) */
  fed: Uint8Array;
  linked: Uint8Array;
  /** eu: every relay full (the gauge's 100%) */
  gaugeMax: number;
  /**
   * Ticks after which a sleeping ship (tools wanting nothing) is surely full (settleEnergy snaps then); NO_FILL_BOUND
   * when it may never be. A heuristic: each linked buffer in turn at the least of its own intake and the generation
   */
  fillBound: number;

  /** The trace (hangar): link ids are feed entries [0, linkPush), push entries [linkPush, linkPair), pairs [linkPair, linkDyn), dynamo entries [linkDyn, links) */
  links: number;
  linkPush: number;
  linkPair: number;
  linkDyn: number;
  /** Per link id: the part power leaves and the part it reaches (a pair: a and b; its trace is signed, + a to b) */
  linkFrom: Int32Array;
  linkTo: Int32Array;
}

const isConsumerRole = (r: number) => r === ROLE_THRUSTER || r === ROLE_TOOL || r === ROLE_WEAPON;
const phaseOfRole = (r: number) => (r === ROLE_THRUSTER ? PHASE_THRUST : r === ROLE_TOOL ? PHASE_TOOL : PHASE_WEAPON);

export function buildEnergyLayout(input: EnergyLayoutInput): EnergyLayout {
  const { fns, area, mats, alive, tuning } = input;
  const n = fns.length;
  const pt = powerTuning(tuning);
  const health = (i: number) => input.health?.[i] ?? 1;

  const role = new Uint8Array(n), cap = new Int32Array(n), rate = new Int32Array(n), give = new Int32Array(n), take = new Int32Array(n);
  const burn = new Int32Array(n), bBurn = new Int32Array(n), boostMul = new Float64Array(n).fill(1);
  const gun = new Uint8Array(n), shot = new Int32Array(n), rounds = new Int32Array(n), relight = new Int32Array(n), shield = new Uint8Array(n);
  const diode = new Uint8Array(n), diodeOut = new Int32Array(n).fill(-1), passOnly = new Uint8Array(n);
  const weaponOf = new Map<number, EnergyWeaponInput>();
  for (const w of input.weapons ?? []) weaponOf.set(w.part, w);

  // ---- Roles and budgets
  for (let i = 0; i < n; i++) {
    if (!alive[i]) continue;
    const fn = fns[i], a = area[i], m = mats[i];
    if (i === input.core) {
      role[i] = ROLE_RELAY;
      cap[i] = toEu(pt.coreCapacity); give[i] = perTick(pt.coreDischarge); take[i] = perTick(pt.coreIntake);
    } else if (fn.weapon) {
      const w = weaponOf.get(i);
      if (w) { role[i] = ROLE_WEAPON; weaponNumbers(i, fn, a, m, w, pt); }
    } else if (isEngine(fn) || fn.strafe) {
      role[i] = ROLE_THRUSTER;
      thrusterNumbers(i, fn, a, m, pt);
    } else if ((fn.store ?? 0) > 0) {
      role[i] = ROLE_RELAY;
      cap[i] = toEu(partHolds(fn, a, m)); give[i] = perTick(partGives(fn, a, m, pt)); take[i] = perTick(partTakes(fn, a, m, pt));
      if (fn.oneWay) diode[i] = 1;
      if (fn.oneWay || fn.relayOnly) passOnly[i] = 1;
    } else if ((fn.produce ?? 0) > 0) {
      role[i] = ROLE_GEN;
      rate[i] = perTick(partSupply(fn, a, m) * health(i));
    } else if ((fn.dynamo ?? 0) > 0) {
      role[i] = ROLE_DYNAMO;
      rate[i] = perTick(fn.dynamo! * health(i));
    } else if ((fn.demand ?? 0) > 0) {
      role[i] = ROLE_TOOL;
      rate[i] = perTick(partDemand(fn, a, m));
      if ((fn.shield ?? 0) > 0) shield[i] = 1;
    }
  }

  function weaponNumbers(i: number, fn: FunctionDef, a: number, m: MaterialDef | undefined, w: EnergyWeaponInput, p: PowerTuning): void {
    const f = w.fire, draw = partDemand(fn, a, m);
    rounds[i] = 1;
    if (f.model === 'beam') {
      const burnE = f.burn ?? draw, intakeE = f.intake ?? burnE;
      gun[i] = GUN_BEAM;
      shot[i] = burnE > 0 ? Math.max(1, perTick(burnE)) : 0;
      rate[i] = perTickUp(intakeE);
      cap[i] = toEu(f.bufferE ?? 2 * burnE);
      relight[i] = Math.floor(cap[i] * (f.relight ?? p.relight));
      return;
    }
    // A model's shot is derived for its own beat; a rate mod (or a conductive material) shortens the interval, so its
    // intake grows to match and it is never energy-bound at full supply (§1.4). A legacy gun: a shot is its draw over
    // its interval, from a buffer of one, refilled at its draw: as today at full supply
    const own = f.shot !== undefined;
    const base = fn.fireInterval ?? f.interval;
    const scale = own && w.interval > 0 && base > 0 ? base / w.interval : 1;
    gun[i] = f.model === 'clip' ? GUN_CLIP : GUN_SHOT;
    shot[i] = toEu(own ? f.shot! : (draw * w.interval) / 60);
    rate[i] = perTickUp((f.intake ?? draw) * scale);
    cap[i] = shot[i] * Math.max(1, Math.round(f.buffer ?? (f.model === 'clip' ? f.clip ?? 1 : 1)));
    // (a clip's salvo: never more rounds than it holds)
    if (gun[i] === GUN_CLIP && shot[i] > 0) rounds[i] = Math.max(1, Math.min(Math.round(f.rounds ?? 1), Math.floor(cap[i] / shot[i])));
  }

  function thrusterNumbers(i: number, fn: FunctionDef, a: number, m: MaterialDef | undefined, p: PowerTuning): void {
    const burnE = partDemand(fn, a, m);
    // (intake and buffer scale like demand: a legacy engine's by its grade)
    const k = (fn.demand ?? 0) > 0 ? burnE / (fn.demand! * a) : 1;
    let bBurnE = burnE, mul = 1, intakeE: number, bufE: number;
    if (fn.strafe) {
      const burstE = (burnE * fn.strafe.ticks) / 60;
      bufE = fn.buffer !== undefined ? fn.buffer * a * k : burstE;
      intakeE = fn.intake !== undefined ? fn.intake * a * k : burstE / 3.5;
    } else {
      mul = fn.boost ?? 2.2;
      bBurnE = burnE * (1 + p.boostDraw * (fn.boostDrain ?? 1));
      if (mul <= 1 || bBurnE <= burnE) { mul = 1; bBurnE = burnE; }
      // (a legacy engine with no numbers of its own: it can boost flat out off its supply, with a second of it buffered)
      intakeE = fn.intake !== undefined ? fn.intake * a * k : bBurnE;
      bufE = fn.buffer !== undefined ? fn.buffer * a * k : bBurnE;
    }
    burn[i] = perTick(burnE);
    bBurn[i] = mul > 1 ? Math.max(burn[i], perTick(bBurnE)) : burn[i];
    boostMul[i] = mul;
    rate[i] = perTick(intakeE);
    cap[i] = toEu(bufE);
  }

  // ---- Touch (live parts only), each neighbour list ascending
  const nb: number[][] = Array.from({ length: n }, () => []);
  for (const [x, y] of input.joins) {
    if (x === y || !alive[x] || !alive[y] || x >= n || y >= n) continue;
    if (!nb[x].includes(y)) nb[x].push(y);
    if (!nb[y].includes(x)) nb[y].push(x);
  }
  for (const l of nb) l.sort((p, q) => p - q);

  // ---- Diodes: the part across the out (facing) edge
  if (input.geoms) {
    for (let i = 0; i < n; i++) {
      if (!diode[i]) continue;
      const mt = mountOf(input.geoms[i] as PlacedGeom);
      if (!mt) continue;
      const px = mt.at[0] + mt.dir[0] * 0.05, py = mt.at[1] + mt.dir[1] * 0.05;
      for (const j of nb[i]) if (geomContainsPoint(input.geoms[j] as PlacedGeom, px, py)) { diodeOut[i] = j; break; }
    }
  }
  const may = (x: number, y: number) => (!diode[x] || diodeOut[x] === y) && (!diode[y] || diodeOut[y] !== x);

  // ---- Consumers by phase
  const byPhase: number[][] = [[], [], []];
  for (let i = 0; i < n; i++) if (isConsumerRole(role[i])) byPhase[phaseOfRole(role[i])].push(i);
  const cons = Int32Array.from([...byPhase[0], ...byPhase[1], ...byPhase[2]]);
  const phase = Int32Array.from([0, byPhase[0].length, byPhase[0].length + byPhase[1].length, cons.length]);

  // ---- Feed CSR: per phase, its sources (generators, then relays), and each one's consumers
  const srcStart = new Int32Array(4), srcRelay = new Int32Array(3);
  const srcPart: number[] = [], feedStart: number[] = [0], feedCons: number[] = [];
  const isSource = (s: number) => role[s] === ROLE_GEN || role[s] === ROLE_RELAY;
  for (let k = 0; k < 3; k++) {
    srcStart[k] = srcPart.length;
    const set = new Set<number>();
    for (const c of byPhase[k]) for (const s of nb[c]) if (isSource(s) && may(s, c)) set.add(s);
    const list = [...set].sort((p, q) => p - q);
    const gensFirst = [...list.filter((s) => role[s] === ROLE_GEN), ...list.filter((s) => role[s] === ROLE_RELAY)];
    srcRelay[k] = srcStart[k] + list.filter((s) => role[s] === ROLE_GEN).length;
    for (const s of gensFirst) {
      srcPart.push(s);
      for (const c of nb[s]) if (isConsumerRole(role[c]) && phaseOfRole(role[c]) === k && may(s, c)) feedCons.push(c);
      feedStart.push(feedCons.length);
    }
  }
  srcStart[3] = srcPart.length;

  // ---- Generator pushes, relay pairs, dynamos
  const gens: number[] = [], pushStart: number[] = [0], pushRelay: number[] = [];
  const relays: number[] = [], dyns: number[] = [], dynStart: number[] = [0], dynRelay: number[] = [];
  const pairA: number[] = [], pairB: number[] = [], pairDir: number[] = [];
  for (let i = 0; i < n; i++) {
    if (role[i] === ROLE_GEN) {
      gens.push(i);
      for (const r of nb[i]) if (role[r] === ROLE_RELAY && may(i, r)) pushRelay.push(r);
      pushStart.push(pushRelay.length);
    } else if (role[i] === ROLE_RELAY) {
      relays.push(i);
      for (const j of nb[i]) {
        if (j <= i || role[j] !== ROLE_RELAY) continue;
        const ab = may(i, j), ba = may(j, i);
        if (!ab && !ba) continue;
        pairA.push(i); pairB.push(j); pairDir.push(ab && ba ? 0 : ab ? 1 : 2);
      }
    } else if (role[i] === ROLE_DYNAMO) {
      dyns.push(i);
      // (a dynamo tops up the stores it touches; a Conduit or Diode only passes power on)
      for (const r of nb[i]) if (role[r] === ROLE_RELAY && !passOnly[r]) dynRelay.push(r);
      dynStart.push(dynRelay.length);
    }
  }

  // ---- Links (trace ids)
  const linkPush = feedCons.length, linkPair = linkPush + pushRelay.length, linkDyn = linkPair + pairA.length, links = linkDyn + dynRelay.length;
  const linkFrom = new Int32Array(links), linkTo = new Int32Array(links);
  for (let j = 0; j < srcPart.length; j++) for (let x = feedStart[j]; x < feedStart[j + 1]; x++) { linkFrom[x] = srcPart[j]; linkTo[x] = feedCons[x]; }
  for (let g = 0; g < gens.length; g++) for (let x = pushStart[g]; x < pushStart[g + 1]; x++) { linkFrom[linkPush + x] = gens[g]; linkTo[linkPush + x] = pushRelay[x]; }
  for (let x = 0; x < pairA.length; x++) { linkFrom[linkPair + x] = pairA[x]; linkTo[linkPair + x] = pairB[x]; }
  for (let d = 0; d < dyns.length; d++) for (let x = dynStart[d]; x < dynStart[d + 1]; x++) { linkFrom[linkDyn + x] = dyns[d]; linkTo[linkDyn + x] = dynRelay[x]; }

  // ---- Reach (hangar warnings): relays a generator or dynamo can fill, through relays, in the directions power may go
  // (breadth first, so each relay's depth is its fewest hops from generation)
  const reach = new Uint8Array(n), depth = new Int32Array(n).fill(NO_DEPTH), queue: number[] = [];
  const mark = (r: number, d: number) => { if (!reach[r]) { reach[r] = 1; depth[r] = d; queue.push(r); } };
  for (const r of pushRelay) mark(r, 0);
  for (const r of dynRelay) mark(r, 0);
  const pairsOf: number[][] = Array.from({ length: n }, () => []);
  for (let x = 0; x < pairA.length; x++) {
    if (pairDir[x] !== 2) pairsOf[pairA[x]].push(pairB[x]);
    if (pairDir[x] !== 1) pairsOf[pairB[x]].push(pairA[x]);
  }
  for (let q = 0; q < queue.length; q++) for (const r of pairsOf[queue[q]]) mark(r, depth[queue[q]] + 1);
  const fed = new Uint8Array(n), linked = new Uint8Array(n);
  for (let j = 0; j < srcPart.length; j++) {
    const s = srcPart[j];
    for (let x = feedStart[j]; x < feedStart[j + 1]; x++) {
      const c = feedCons[x];
      fed[c] = 1;
      if (role[s] === ROLE_GEN || reach[s]) linked[c] = 1;
      if (role[s] === ROLE_GEN) linked[s] = 1;
    }
  }
  for (const r of relays) { fed[r] = reach[r]; linked[r] = reach[r]; }
  for (let g = 0; g < gens.length; g++) if (pushStart[g + 1] > pushStart[g]) linked[gens[g]] = 1;
  for (let d = 0; d < dyns.length; d++) if (dynStart[d + 1] > dynStart[d]) linked[dyns[d]] = 1;

  // ---- The gauge's full, and how long a sleeping ship takes to fill at worst (each buffer in turn, at the least of its
  // own intake and the generation: asleep, its tools want nothing, settleEnergy). A clip counts though only a latched one
  // fills (the layout can't tell): that only lengthens the bound
  let gaugeMax = 0;
  for (const r of relays) gaugeMax += cap[r];
  let spare = 0;
  for (const g of gens) spare += rate[g];
  for (let d = 0; d < dyns.length; d++) spare += rate[dyns[d]] * (dynStart[d + 1] - dynStart[d]);
  let fillBound = 0;
  if (spare <= 0) fillBound = NO_FILL_BOUND;
  else {
    for (let i = 0; i < n && fillBound < NO_FILL_BOUND; i++) {
      if (cap[i] <= 0 || !linked[i]) continue;
      const inRate = Math.min(role[i] === ROLE_RELAY ? take[i] : rate[i], spare);
      fillBound = inRate > 0 ? Math.min(NO_FILL_BOUND, fillBound + Math.ceil(cap[i] / inRate)) : NO_FILL_BOUND;
    }
  }

  const L: EnergyLayout = {
    n, sig: 0, role, cap, rate, give, take, burn, bBurn, boostMul, gun, shot, rounds, relight, shield, diodeOut,
    phase, cons, srcStart, srcRelay, srcPart: Int32Array.from(srcPart), feedStart: Int32Array.from(feedStart), feedCons: Int32Array.from(feedCons),
    gens: Int32Array.from(gens), pushStart: Int32Array.from(pushStart), pushRelay: Int32Array.from(pushRelay), relays: Int32Array.from(relays), depth,
    pairA: Int32Array.from(pairA), pairB: Int32Array.from(pairB), pairDir: Uint8Array.from(pairDir),
    dyns: Int32Array.from(dyns), dynStart: Int32Array.from(dynStart), dynRelay: Int32Array.from(dynRelay),
    fed, linked, gaugeMax, fillBound, links, linkPush, linkPair, linkDyn, linkFrom, linkTo,
  };
  L.sig = layoutSig(L);
  return L;
}

/**
 * FNV-1a over the graph and the budgets, folded to 16 bits (never 0, so a 0 on the wire always mismatches). Not over
 * the health-scaled rates (generators', dynamos'): a hit on a generator must not change it, or a pilot whose hp for the
 * part lags the server's would refuse every correction until it caught up
 */
export function layoutSig(L: EnergyLayout): number {
  let h = 0x811c9dc5 | 0;
  const mix = (v: number) => { h = Math.imul(h ^ (v | 0), 0x01000193); };
  const all = (a: ArrayLike<number>) => { mix(a.length); for (let i = 0; i < a.length; i++) mix(a[i]); };
  mix(L.n);
  all(L.role); all(L.cap);
  for (let i = 0; i < L.n; i++) mix(L.role[i] === ROLE_GEN || L.role[i] === ROLE_DYNAMO ? 0 : L.rate[i]);
  all(L.rounds); all(L.give); all(L.take); all(L.burn); all(L.bBurn); all(L.gun); all(L.shot); all(L.relight);
  for (let i = 0; i < L.boostMul.length; i++) mix(Math.round(L.boostMul[i] * 4096));
  all(L.diodeOut); all(L.srcPart); all(L.feedStart); all(L.feedCons); all(L.pushRelay); all(L.pairA); all(L.pairB); all(L.pairDir); all(L.dynRelay);
  const s = ((h >>> 16) ^ (h & 0xffff)) & 0xffff;
  return s === 0 ? 1 : s;
}
