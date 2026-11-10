/**
 * The ship status data source (ui/shipStatus/Schematic.ts draws it on the HUD's ship schematic): everything the HUD shows
 * about energy, shield, weapons and thrust, worked out from what the client already has, in one record rewritten in
 * place (no allocation at the HUD's 10 Hz). `parts` is the per-part readout the schematic paints (fills, glows, flashes).
 *
 * THE ONE PLACE THE PANEL READS ENERGY: the ports core (common/src/ships/power/ports.ts): its gauge, each tank's and
 * store's fill, and the ports lines (tanks, Selectors, augments, heavy guns).
 *
 * Inputs (ShipClient.statusInput builds them):
 *   ship         the pilot's ShipState (derived: energy, ports, shield, weapons; the predicted gun state)
 *   charge       the predicted charge (GameState.charge: the ports state)
 *   shieldPct    the pilot row's shield % (data[4])
 *   thrust       what the keys ask the engines for now (thrusting, boosting)
 *   groups       the weapon ring's groups (ships/gunHud.ts RingModel): clip, charge, spin, ammo per gun model
 *   features     part features' status lines (ClientFeature.status: the Burst Strafer's dodge)
 *
 * Numbers are per second (E/s). "Draw" is the steady loads (shields, scanners, coils).
 */

import {
  P_TANK, PF_SEL, MAT_UNIT, portsInflow, chargeTotal,
  shapedOf, shieldHp, shieldUp, type Charge, type ShipState, type ShipTuning,
} from '@space-game/common';
import type { RingGroup } from '../../ships/gunHud';
import { shipFunction } from '../../ships/shipFunctionData';

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
    /** Generation (all generators), steady loads, estimated draw, net, all E/s */
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
    /** The lowest share of what it asked anything short got (0..1; 1 while nothing is short): short of Output, everything drawing on it gets the same share */
    share: number;
    /** Draw beyond generation: the stores are paying */
    draining: boolean;
    /** Seconds until the stores run dry at this net rate (Infinity: not draining) */
    empty: number;
    /** Seconds until they are full again at this net rate (Infinity: not filling) */
    full: number;
  };
  weapons: WeaponLine[];
  features: readonly FeatureStatusLine[];
  parts: PartStatus[];
}

export type PartKind = 'none' | 'store' | 'weapon' | 'engine' | 'gen' | 'shield';

/** One part's readout for the schematic (parallel to ship.blueprint.parts; rewritten in place) */
export interface PartStatus {
  kind: PartKind;
  /** 0..1 liquid level (a store's charge, a weapon's reload, a shield's level); -1: no fill */
  fill: number;
  /** 0..1 steady glow (thrusting, a lit beam, a generator running) */
  glow: number;
  /** 0..1 flash (a shot just fired) */
  flash: number;
  /** Clip guns: the clip size (ticks drawn for a small clip); 0: none */
  clip: number;
  /** Out of ammo, or a shield that is down: drawn dim */
  dim: boolean;
}

/** What the source remembers between reads (the shield's last hit) */
export interface StatusMemory {
  ship: ShipState | null;
  rebuilds: number;
  shield: number;
  hitAt: number;
}

export function newMemory(): StatusMemory {
  return { ship: null, rebuilds: -1, shield: NaN, hitAt: -Infinity };
}

export function emptyStatus(): ShipStatus {
  return {
    has: false,
    hull: { parts: 0, intact: 0, lost: 0, integrity: 0, coreHp: 0, coreMax: 1 },
    shield: { max: 0, cur: 0, pct: 0, regen: 0, state: 'none', wait: 0 },
    energy: { gen: 0, steady: 0, draw: 0, net: 0, held: 0, cap: 0, pct: 100, brownout: false, short: '', share: 1, draining: false, empty: Infinity, full: Infinity },
    weapons: [],
    features: [],
    parts: [],
  };
}

/** Fill `out` (or a new record) from `inp`; `mem` carries the measured rates between calls */
export function readStatus(inp: StatusInput, mem: StatusMemory, out: ShipStatus = emptyStatus()): ShipStatus {
  const ship = inp.ship;
  if (!ship || ship.kind !== 'ship') { out.has = false; mem.ship = null; return out; }
  const fresh = ship !== mem.ship || ship.rebuilds !== mem.rebuilds;
  if (fresh) { mem.ship = ship; mem.rebuilds = ship.rebuilds; mem.shield = NaN; mem.hitAt = -Infinity; }
  out.has = true;
  readHull(ship, out.hull);
  readShield(ship, inp, mem, out.shield);
  readEnergy(ship, inp, out.energy);
  readWeapons(ship, inp, out);
  readParts(ship, inp, out);
  out.features = inp.charge.e ? [...portsLines(ship, inp.charge, inp.nameOf), ...inp.features] : inp.features;
  return out;
}

/**
 * A ports ship (common/src/ships/power/ports.ts): each tank's material left, what each Selector passes, each gun's augment
 * (its buffer, and whether its line keeps it fed) and each heavy gun whose lines don't deliver its floor (it can't charge)
 */
const portsLineCache = new WeakMap<object, { lines: FeatureStatusLine[]; aug: number[]; heavy: number[] }>();
function portsLines(ship: ShipState, c: Charge, nameOf: (fn: string) => string): FeatureStatusLine[] {
  const L = ship.derived.ports!, e = c.e!, parts = ship.blueprint.parts;
  let cached = portsLineCache.get(L);
  if (!cached) {
    const lines: FeatureStatusLine[] = [], aug: number[] = [], heavy: number[] = [];
    for (const t of L.tanks) lines.push({ label: `${L.feedDefs[L.tankFeed[t]]?.name ?? 'Feed'} tank`, text: '', tone: 'ok', progress: 1 });
    for (const s of L.selectors) lines.push({ label: 'Selector (Y)', text: '', tone: 'ok' });
    for (const w of L.weapons) if (L.augCap[w] > 0) { aug.push(w); lines.push({ label: `${nameOf(parts[w].fn)}: ${L.augName[w]}`, text: '', tone: 'dim', progress: 0 }); }
    for (const w of L.weapons) if (L.steady[w] > 0) { heavy.push(w); lines.push({ label: nameOf(parts[w].fn), text: '', tone: 'ok' }); }
    portsLineCache.set(L, (cached = { lines, aug, heavy }));
  }
  const lines = cached.lines, inflow = portsInflow();
  let k = 0;
  for (const t of L.tanks) {
    const r = lines[k++], f = L.cap[t] > 0 ? e.held[t] / L.cap[t] : 0;
    r.text = `${Math.floor(e.held[t] / MAT_UNIT)} / ${Math.round(L.cap[t] / MAT_UNIT)}`;
    r.progress = f; r.tone = f <= 0 ? 'bad' : f < 0.2 ? 'warn' : 'ok';
  }
  for (const s of L.selectors) {
    const r = lines[k++], side = e.flags[s] & PF_SEL ? 1 : 0, net = L.selIn[2 * s + side];
    const tank = net >= 0 ? L.nets[net].tanks[0] : -1;
    r.text = tank >= 0 ? `passing ${L.feedDefs[L.tankFeed[tank]]?.name ?? 'feed'}` : 'nothing on that side';
  }
  // (An augment: ready while its buffer holds a shot's cost; no line into its input, or one too weak to fill it, says so)
  for (const w of cached.aug) {
    const r = lines[k++], f = e.aug[w] / L.augCap[w];
    r.progress = f;
    if (e.aug[w] >= L.augCost[w]) { r.text = 'ready'; r.tone = 'ok'; }
    else { r.text = L.ports.some((q) => q.part === w && q.aug && q.link) ? 'its line is too weak' : 'no line to its augment input'; r.tone = 'dim'; }
  }
  // (A heavy gun short of its floor collapses what it gathers: say so)
  for (const w of cached.heavy) {
    const r = lines[k++], full = e.held[w] >= L.cap[w];
    const short = !full && e.closed[w] === 0 && inflow[w] < L.steady[w];
    r.text = full ? 'charged' : short ? `starved: its lines give under ${Math.round((L.steady[w] * 60) / 256)}/s` : 'charging';
    r.tone = full ? 'ok' : short ? 'warn' : 'busy';
  }
  return lines;
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
  // Shaped shields (features/zoneshield) have no pool of their own: the bar is all of their HP together, and each
  // shield shows on its own part in the schematic (readParts)
  const shaped = (d.shieldMax ?? 0) <= 0 ? shapedOf(ship) : [];
  if (shaped.length) {
    let cap = 0, cur = 0, rate = 0, down = 0;
    for (let i = 0; i < shaped.length; i++) { cap += shaped[i].cap; cur += shieldHp(ship, i); rate += shaped[i].rate; if (!shieldUp(ship, i)) down++; }
    s.max = cap; s.regen = rate; s.cur = cur; s.pct = cap > 0 ? (cur / cap) * 100 : 0;
    if (Number.isFinite(mem.shield) && s.pct < mem.shield - 0.05) mem.hitAt = inp.now;
    mem.shield = s.pct;
    s.wait = Math.max(0, (mem.hitAt + 1200 - inp.now) / 1000);
    s.state = down === shaped.length ? 'down' : s.pct >= 99.95 ? 'full' : s.wait > 0 ? 'wait' : 'regen';
    return;
  }
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
 * The energy readout: generation, the steady loads and the ports gauge (chargeTotal). The ports core keeps no ship-wide
 * store, net rate or share yet, so those read as steady (held 0, net 0, nothing short).
 */
function readEnergy(ship: ShipState, inp: StatusInput, e: ShipStatus['energy']): void {
  const d = ship.derived, en = d.energy;
  e.gen = en.supply;
  e.steady = Math.min(en.supply, en.demand);
  e.draw = e.steady;
  e.held = 0;
  e.cap = 0;
  e.pct = chargeTotal(d, inp.charge);
  e.brownout = false;
  e.short = '';
  e.share = 1;
  e.net = 0;
  e.draining = false;
  e.empty = Infinity;
  e.full = Infinity;
}

function readWeapons(ship: ShipState, inp: StatusInput, out: ShipStatus): void {
  const lines = out.weapons;
  const gs = inp.groups;
  // (The records are rebuilt only when the group count changes; otherwise rewritten)
  while (lines.length > gs.length) lines.pop();
  while (lines.length < gs.length) lines.push({ name: '', count: 0, model: '', state: '', tone: 'ok', progress: -1, rounds: 0, clip: 0, ammo: -1, crates: 0 });
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
    switch (g.model) {
      case 'clip':
        w.progress = g.clip > 0 ? Math.min(1, g.rounds / g.clip) : -1;
        if (g.reloading && g.rounds < 1) { w.state = 'RELOAD'; w.tone = 'busy'; }
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
  }
}

/** The per-part readout: tanks and stores show what each one holds (the ports state); legacy store functions full */
const e0 = (cap: number, held: number) => (cap > 0 ? Math.max(0, Math.min(1, held / cap)) : 0);
function readParts(ship: ShipState, inp: StatusInput, out: ShipStatus): void {
  const parts = ship.blueprint.parts, d = ship.derived, c = inp.charge, ps = out.parts;
  while (ps.length > parts.length) ps.pop();
  while (ps.length < parts.length) ps.push({ kind: 'none', fill: -1, glow: 0, flash: 0, clip: 0, dim: false });
  for (let i = 0; i < parts.length; i++) {
    const r = ps[i], fn = parts[i].fn;
    r.kind = 'none'; r.fill = -1; r.glow = 0; r.flash = 0; r.clip = 0; r.dim = false;
    // (Tanks show what's left, stores what they hold)
    const P = d.ports;
    if (c.e && (P.role[i] === P_TANK || (P.cap[i] > 0 && P.relays.includes(i)))) { r.kind = 'store'; r.fill = e0(P.cap[i], c.e.held[i]); continue; }
    if (shipFunction(fn)?.statusFull) { r.kind = 'store'; r.fill = 1; }
    else if (fn === 'generator') { r.kind = 'gen'; r.glow = 1; }
    else if (fn === 'shield') {
      r.kind = 'shield'; r.fill = out.shield.pct / 100; r.dim = out.shield.state === 'down';
    } else if (d.fx?.shaped) {
      // (a shaped shield's own part: its own HP, dim while it is down)
      const list = shapedOf(ship), k = list.findIndex((x) => x.part === i);
      if (k >= 0) { r.kind = 'shield'; r.fill = shieldHp(ship, k) / list[k].cap; r.dim = !shieldUp(ship, k); }
    }
  }
  for (const t of d.thrusters) {
    const r = ps[t.part];
    if (!r || (!t.force[0] && !t.force[1])) continue;
    r.kind = 'engine';
    r.glow = inp.thrust.on ? (inp.thrust.boost ? 1 : 0.55) : 0;
  }
  for (const g of inp.groups) {
    const dry = g.ammo === 0 && g.crates <= 0;
    for (const p of g.parts) {
      const r = ps[p];
      if (!r) continue;
      r.kind = 'weapon';
      r.flash = g.flash;
      r.dim = dry && g.model !== 'clip';
      switch (g.model) {
        case 'clip': r.fill = g.clip > 0 ? Math.min(1, g.rounds / g.clip) : 1; r.clip = g.clip; break;
        case 'charge': r.fill = g.charge > 0 ? g.charge : g.cooling > 0 ? 1 - g.cooling : 1; break;
        case 'beam': {
          const lit = (ship.cooldown[p] ?? 0) > 0;
          r.glow = lit ? 1 : 0;
          r.fill = lit ? 1 : g.charge > 0 ? g.charge : 1;
          break;
        }
        default: r.fill = Math.min(1, g.ready);
      }
    }
  }
}
