/**
 * The ship status panel's data source (ui/shipStatus/StatusPanel.ts draws it): everything the panel shows, worked out
 * from what the client already has, in one record rewritten in place (no allocation at the panel's 10 Hz beyond
 * gunLoad's small vector).
 *
 * THE ONE PLACE THE PANEL READS ENERGY. The live game still runs the old energy system (common/src/ships/energy.ts,
 * circuits.ts: a pool, Capacitor and Drive Cell banks, feed-group shares in Charge.eng/gun). The touch-only power core
 * (common/src/ships/power/, docs/design/energy-routing-impl.md) replaces it at the P2 switch-over; then only
 * `readEnergy` (and the `charge` field of StatusInput) changes to read the new EnergyState: generation, draw, stored,
 * per-store fills and the shortfall. The panel and the rest of this record stay as they are.
 *
 * Inputs (ShipClient.statusInput builds them):
 *   ship         the pilot's ShipState (derived: energy, power, satisfaction, shield, weapons; the predicted gun state)
 *   charge       the predicted charge (GameState.charge: the pool's and each bank's %, this tick's feed shares)
 *   shieldPct    the pilot row's shield % (data[4])
 *   thrust       what the keys ask the engines for now (thrusting, boosting)
 *   groups       the weapon ring's groups (ships/gunHud.ts RingModel): clip, charge, spin, ammo per gun model
 *   features     part features' status lines (ClientFeature.status: the Burst Strafer's dodge)
 *
 * Numbers are per second (E/s). "Draw" is the closest the client can know: the steady loads (shields, scanners: what
 * generation they take at the rebuild), the engines while the keys thrust (boosting at the boost rate), and what the
 * guns draw this tick by their predicted state (gunLoad). "Net" is the stores' measured rate of change.
 */

import {
  BROWNOUT, bankHeld, energyTuning, feedShare, gunLoad, poolHeld,
  type Charge, type ShipState, type ShipTuning,
} from '@space-game/common';
import type { RingGroup } from '../../ships/gunHud';

/** A part feature's line on the panel (ClientFeature.status) */
export interface FeatureStatusLine {
  label: string;
  text: string;
  tone: Tone;
  /** 0..1 progress bar (a cooldown filling), absent: none */
  progress?: number;
}

export type Tone = 'ok' | 'busy' | 'warn' | 'bad' | 'dim';

export interface StatusInput {
  ship: ShipState | null | undefined;
  charge: Charge;
  shieldPct: number | null | undefined;
  thrust: { on: boolean; boost: boolean };
  tick: number;
  tuning: ShipTuning;
  groups: readonly RingGroup[];
  features: readonly FeatureStatusLine[];
  /** A function id's display name */
  nameOf: (fn: string) => string;
  /** Wall clock, ms (the net rate and the shield's wait are measured against it) */
  now: number;
}

export interface StoreBar {
  kind: 'pool' | 'cap' | 'drive';
  /** 0..100 */
  pct: number;
  cap: number;
  /** A feed group this store feeds got less than it asked this tick */
  brown: boolean;
}

export interface WeaponLine {
  name: string;
  count: number;
  model: string;
  state: string;
  tone: Tone;
  /** 0..1, -1: no bar */
  progress: number;
  /** Clip guns: rounds left (averaged over the group) and clip size; 0 clip: not a clip gun */
  rounds: number;
  clip: number;
  /** Crate guns: rounds in the open crate and crates aboard; -1: takes no ammo */
  ammo: number;
  crates: number;
}

export interface ShipStatus {
  has: boolean;
  hull: { parts: number; intact: number; lost: number; integrity: number; coreHp: number; coreMax: number };
  shield: { max: number; cur: number; pct: number; regen: number; state: 'none' | 'full' | 'regen' | 'wait' | 'down'; wait: number };
  energy: {
    /** Generation (spare after nothing: all generators, plus bank dynamos), steady loads, estimated draw, measured net, all E/s */
    gen: number;
    steady: number;
    draw: number;
    net: number;
    held: number;
    cap: number;
    /** 0..100 */
    pct: number;
    /** Something got less power than it asked this tick */
    brownout: boolean;
    /** What is short: engines, guns, both, or none */
    short: '' | 'engines' | 'guns' | 'engines+guns';
    /** Draw beyond generation: the stores are paying */
    draining: boolean;
    /** Seconds until the stores run dry at this net rate (Infinity: not draining) */
    empty: number;
    stores: StoreBar[];
  };
  weapons: WeaponLine[];
  thrust: { engines: number; boost: 'ready' | 'boosting' | 'empty' | 'none'; share: number };
  features: readonly FeatureStatusLine[];
}

/** What the source remembers between reads (the net rate, the shield's last hit) */
export interface StatusMemory {
  ship: ShipState | null;
  rebuilds: number;
  held: number;
  at: number;
  net: number;
  shield: number;
  hitAt: number;
}

export function newMemory(): StatusMemory {
  return { ship: null, rebuilds: -1, held: NaN, at: 0, net: 0, shield: NaN, hitAt: -Infinity };
}

export function emptyStatus(): ShipStatus {
  return {
    has: false,
    hull: { parts: 0, intact: 0, lost: 0, integrity: 0, coreHp: 0, coreMax: 1 },
    shield: { max: 0, cur: 0, pct: 0, regen: 0, state: 'none', wait: 0 },
    energy: { gen: 0, steady: 0, draw: 0, net: 0, held: 0, cap: 0, pct: 100, brownout: false, short: '', draining: false, empty: Infinity, stores: [] },
    weapons: [],
    thrust: { engines: 0, boost: 'none', share: 1 },
    features: [],
  };
}

/** How long the net rate is smoothed over (s) */
const NET_SMOOTH = 0.6;

/** Fill `out` (or a new record) from `inp`; `mem` carries the measured rates between calls */
export function readStatus(inp: StatusInput, mem: StatusMemory, out: ShipStatus = emptyStatus()): ShipStatus {
  const ship = inp.ship;
  if (!ship || ship.kind !== 'ship') { out.has = false; mem.ship = null; return out; }
  const fresh = ship !== mem.ship || ship.rebuilds !== mem.rebuilds;
  if (fresh) { mem.ship = ship; mem.rebuilds = ship.rebuilds; mem.held = NaN; mem.net = 0; mem.shield = NaN; mem.hitAt = -Infinity; }
  out.has = true;
  readHull(ship, out.hull);
  readShield(ship, inp, mem, out.shield);
  readEnergy(ship, inp, mem, out.energy);
  readWeapons(ship, inp, out);
  readThrust(ship, inp, out);
  out.features = inp.features;
  return out;
}

function readHull(ship: ShipState, h: ShipStatus['hull']): void {
  const parts = ship.blueprint.parts;
  let n = 0, intact = 0, hp = 0, max = 0, core = -1;
  for (let i = 0; i < parts.length; i++) {
    if (ship.ghost?.[i]) continue;
    n++;
    const m = ship.maxHp[i] ?? 0;
    max += m;
    const gone = ship.detached[i] || !(ship.hp[i] > 0);
    if (!gone) { intact++; hp += Math.min(m, ship.hp[i]); }
    if (core < 0 && parts[i].fn === 'core') core = i;
  }
  h.parts = n;
  h.intact = intact;
  h.lost = n - intact;
  h.integrity = max > 0 ? hp / max : 0;
  h.coreMax = core >= 0 ? ship.maxHp[core] || 1 : 1;
  h.coreHp = core >= 0 && !ship.detached[core] ? Math.max(0, ship.hp[core]) : 0;
}

function readShield(ship: ShipState, inp: StatusInput, mem: StatusMemory, s: ShipStatus['shield']): void {
  const d = ship.derived;
  s.max = d.shieldMax ?? 0;
  s.regen = d.shieldRegen ?? 0;
  const pct = Math.max(0, Math.min(100, inp.shieldPct ?? 0));
  s.pct = s.max > 0 ? pct : 0;
  s.cur = (s.max * s.pct) / 100;
  // (A drop is a hit: regeneration waits shieldDelay ticks after the last one)
  if (Number.isFinite(mem.shield) && pct < mem.shield - 0.05) mem.hitAt = inp.now;
  mem.shield = pct;
  const delay = ((d.shieldDelay ?? 0) / 60) * 1000;
  s.wait = Math.max(0, (mem.hitAt + delay - inp.now) / 1000);
  if (s.max <= 0) s.state = 'none';
  else if (s.wait > 0 && pct < 99.95) s.state = pct <= 0 ? 'down' : 'wait';
  else if (pct >= 99.95) s.state = 'full';
  else if (pct <= 0 && s.regen <= 0) s.state = 'down';
  else s.state = 'regen';
}

/**
 * The energy readout. P2 switch-over: this function (and StatusInput.charge) is what changes, to read the new
 * EnergyState instead of the old pool-and-banks Charge.
 */
function readEnergy(ship: ShipState, inp: StatusInput, mem: StatusMemory, e: ShipStatus['energy']): void {
  const d = ship.derived, L = d.power, c = inp.charge;
  const supply = d.energy?.supply ?? 0;
  const spare = L?.spare ?? d.energy?.spare ?? 0;
  let dynamo = 0;
  e.steady = Math.max(0, supply - spare);
  // Stores: the pool, then each bank (the bars past MAX_STORES are left off; the total counts them)
  let held = 0, cap = 0;
  const stores = e.stores;
  let n = 0;
  if (L) {
    held = poolHeld(d, c);
    cap = L.pool.cap;
    if (L.pool.cap > 0) setStore(stores, n++, 'pool', pctOf(c.g), L.pool.cap, false);
    for (let b = 0; b < L.banks.length; b++) {
      const B = L.banks[b];
      held += bankHeld(d, c, b);
      cap += B.cap;
      dynamo += B.dynamo;
      if (n < MAX_STORES) setStore(stores, n++, B.kind, pctOf(c.b[b]), B.cap, bankBrown(L.feeds, b, c));
    }
  }
  stores.length = n;
  e.gen = supply + dynamo;
  e.held = held;
  e.cap = cap;
  e.pct = cap > 0 ? (held / cap) * 100 : 100;
  // Draw: steady loads, engines while thrusting, guns by their state this tick
  let draw = e.steady;
  if (L && inp.thrust.on) {
    const boostDraw = inp.thrust.boost ? energyTuning(inp.tuning).boostDraw : 0;
    for (const t of d.thrusters) {
      if (!t.force[0] && !t.force[1]) continue;
      draw += (L.draw[t.part] ?? 0) * (1 + boostDraw * (L.boostDrain[t.part] ?? 0));
    }
  }
  const load = L ? gunLoad(ship as Parameters<typeof gunLoad>[0], inp.tick) : undefined;
  if (load) for (let f = 0; f < load.length; f++) draw += load[f];
  e.draw = draw;
  // Brownout: any feed group's share this tick below the line
  let engShort = false, gunShort = false;
  if (L) for (let f = 0; f < L.feeds.length; f++) {
    if ((c.eng?.[f] ?? 1) < BROWNOUT) engShort = true;
    if ((c.gun?.[f] ?? 1) < BROWNOUT) gunShort = true;
  }
  e.brownout = engShort || gunShort;
  e.short = engShort && gunShort ? 'engines+guns' : engShort ? 'engines' : gunShort ? 'guns' : '';
  // Net: the stores' measured rate (smoothed)
  if (Number.isFinite(mem.held) && inp.now > mem.at) {
    const dt = (inp.now - mem.at) / 1000;
    const raw = (held - mem.held) / dt;
    mem.net += (raw - mem.net) * Math.min(1, dt / NET_SMOOTH);
  }
  mem.held = held;
  mem.at = inp.now;
  e.net = Math.abs(mem.net) < 0.05 ? 0 : mem.net;
  e.draining = draw > e.gen + 1e-6;
  e.empty = e.net < -0.05 && held > 0 ? held / -e.net : Infinity;
}

/** The most store bars shown (the pool and three banks) */
export const MAX_STORES = 5;

/** Rewrite store record `i` (made the first time it's needed) */
function setStore(stores: StoreBar[], i: number, kind: StoreBar['kind'], pct: number, cap: number, brown: boolean): void {
  const r = stores[i] ?? (stores[i] = { kind, pct, cap, brown });
  r.kind = kind; r.pct = pct; r.cap = cap; r.brown = brown;
}

function bankBrown(feeds: { banks: number[] }[], b: number, c: Charge): boolean {
  for (let f = 0; f < feeds.length; f++) {
    if (!feeds[f].banks.includes(b)) continue;
    if (Math.min(c.eng?.[f] ?? 1, c.gun?.[f] ?? 1) < BROWNOUT) return true;
  }
  return false;
}

const pctOf = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? 100 : Math.max(0, Math.min(100, v)));

function readWeapons(ship: ShipState, inp: StatusInput, out: ShipStatus): void {
  const lines = out.weapons;
  const gs = inp.groups;
  // (The records are rebuilt only when the group count changes; otherwise rewritten)
  while (lines.length > gs.length) lines.pop();
  while (lines.length < gs.length) lines.push({ name: '', count: 0, model: '', state: '', tone: 'ok', progress: -1, rounds: 0, clip: 0, ammo: -1, crates: 0 });
  const d = ship.derived;
  for (let i = 0; i < gs.length; i++) {
    const g = gs[i], w = lines[i];
    w.name = inp.nameOf(g.fn);
    w.count = g.parts.length;
    w.model = g.model;
    w.rounds = g.rounds;
    w.clip = g.clip;
    w.ammo = g.ammo;
    w.crates = g.crates;
    w.progress = -1;
    // Short of power: any gun of the group got less than it asked
    let starved = g.starved;
    if (!starved) for (const p of g.parts) if (feedShare(d, inp.charge, p, 'gun') < BROWNOUT) { starved = true; break; }
    switch (g.model) {
      case 'clip':
        w.progress = g.clip > 0 ? Math.min(1, g.rounds / g.clip) : -1;
        if (g.reloading && g.starved) { w.state = 'NO POWER'; w.tone = 'bad'; }
        else if (g.reloading && g.rounds < 1) { w.state = 'RELOAD'; w.tone = 'busy'; }
        else { w.state = 'READY'; w.tone = 'ok'; }
        break;
      case 'charge':
        if (g.charge > 0) { w.state = g.charge >= 0.98 ? 'FULL' : 'CHARGING'; w.tone = g.charge >= 0.98 ? 'ok' : 'busy'; w.progress = g.charge; }
        else if (g.cooling > 0) { w.state = 'COOLING'; w.tone = 'busy'; w.progress = 1 - g.cooling; }
        else { w.state = 'READY'; w.tone = 'ok'; }
        break;
      case 'beam': {
        let lit = false;
        for (const p of g.parts) if ((ship.cooldown[p] ?? 0) > 0) { lit = true; break; }
        if (g.charge > 0 && g.charge < 1 && !lit) { w.state = 'WINDUP'; w.tone = 'busy'; w.progress = g.charge; }
        else if (lit) { w.state = 'LIT'; w.tone = 'busy'; }
        else { w.state = 'RESTING'; w.tone = 'dim'; }
        break;
      }
      default:
        // (Out of crates a crate gun fires plain rounds: tuning.ts ammo.dry)
        if (g.ammo === 0 && g.crates <= 0) { w.state = 'PLAIN'; w.tone = 'warn'; if (g.ready < 1) w.progress = g.ready; }
        else if (g.ready < 1) { w.state = 'CYCLING'; w.tone = 'busy'; w.progress = g.ready; }
        else { w.state = 'READY'; w.tone = 'ok'; }
    }
    if (starved && w.tone !== 'bad' && w.state !== 'READY' && w.state !== 'RESTING') { w.state = 'LOW POWER'; w.tone = 'warn'; }
  }
}

function readThrust(ship: ShipState, inp: StatusInput, out: ShipStatus): void {
  const d = ship.derived, L = d.power, t = out.thrust;
  let engines = 0;
  for (const th of d.thrusters) if (th.force[0] || th.force[1]) engines++;
  t.engines = engines;
  // Boosting needs charge stored for the engines: the pool's, or a Drive Cell bank's (energy.ts powerTick)
  let stored = L ? poolHeld(d, inp.charge) : 0;
  if (L) for (let b = 0; b < L.banks.length; b++) if (L.banks[b].kind === 'drive') stored += bankHeld(d, inp.charge, b);
  t.boost = engines === 0 ? 'none' : stored <= 0 ? 'empty' : inp.thrust.on && inp.thrust.boost ? 'boosting' : 'ready';
  let share = 1;
  if (L) for (let f = 0; f < L.feeds.length; f++) share = Math.min(share, inp.charge.eng?.[f] ?? 1);
  t.share = share;
}
