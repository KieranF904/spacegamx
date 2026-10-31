/**
 * Surge (energy Phase 2: docs/design/energy-system.md, proposal B), the second power type. A wired circuit carries
 * Steady power. Surge never travels along wires: it's a bank's (capacitors and Pulse Dynamos touching each other are
 * one bank, circuits.ts) and reaches only what touches the bank. A part fed Surge by touch reacts by its category
 * (one table, not per model), on top of running on its Steady circuit as ever:
 *
 *   guns     charged shot: a shot after a pause (loaded and idle a while) takes a packet from the bank and hits harder
 *   engines  kick: while boosting, a dash every KICK_EVERY ticks, a packet from the bank each
 *   shields  flash restore: when the shield breaks, the bank puts part of it back at once
 *
 * Dual-fed models (Steady + Surge): the Rail Driver (Steady holds its rails, so it fires only on a wired circuit; its
 * bank sets each shot's power, and a full bank adds a pierce and is emptied) and the Flash Screen (a flash restore
 * puts all of the shield back). Beams, pulse lasers and mining lasers have no Surge reaction yet.
 *
 * Everything here is the charge's arithmetic (the bank's share of Charge.s), the same on the server and in the pilot's
 * prediction; the shield's restore is the server's alone (shields aren't predicted).
 */

import type { ShipDerived, WeaponInfo } from './rebuild.js';
import type { ShipTuning } from './tuning.js';
import type { FunctionDef, Vec2 } from './types.js';
import type { Charge } from './energy.js';

export const SURGE_DEFAULTS = {
  /** A charged shot: a gun loaded and idle this many ticks, its damage ×, and its packet (× the shot's own energy) */
  pauseTicks: 30,
  chargedDamage: 1.5,
  chargedPacket: 3,
  /** The Rail Driver: its damage × from an empty bank to a full one, the share of the bank a shot takes, and "full" */
  rail: { min: 0.7, max: 1.5, drain: 0.3, full: 0.98 },
  /** A kick every this many ticks while boosting, worth this many ticks of the kicking engines' full thrust, and its
   *  packet (× their draw over those ticks) */
  kickEvery: 20,
  kickTicks: 12,
  kickCost: 2,
  /** A flash restore: the share of the shield put back (a Flash Screen's: all), and the bank's energy per point of it */
  flash: { share: 0.5, screen: 1, costPerPoint: 4 },
};
export type SurgeTuning = typeof SURGE_DEFAULTS;

/** The power types (wave 2 adds no more yet): their colours, everywhere (hangar, HUD, guides) */
export const POWER_TYPES = {
  steady: { name: 'Steady', color: '#18b4d0' },
  surge: { name: 'Surge', color: '#b57cff' },
} as const;

const tunings = new WeakMap<ShipTuning, SurgeTuning>();
export function surgeTuning(t: ShipTuning): SurgeTuning {
  let s = tunings.get(t);
  if (!s) {
    const e = ((t as { energy?: { surge?: Partial<SurgeTuning> } }).energy?.surge ?? {}) as Partial<SurgeTuning>;
    s = { ...SURGE_DEFAULTS, ...e, rail: { ...SURGE_DEFAULTS.rail, ...(e.rail ?? {}) }, flash: { ...SURGE_DEFAULTS.flash, ...(e.flash ?? {}) } };
    tunings.set(t, s);
  }
  return s;
}

/** What a part does when fed Surge (its category's line in the reaction table), or null: no reaction */
export function surgeReaction(fn: FunctionDef | undefined): 'charged' | 'rail' | 'kick' | 'flash' | 'screen' | null {
  if (!fn) return null;
  if (fn.dual === 'rail') return 'rail';
  if (fn.dual === 'flash') return 'screen';
  if ((fn.shield ?? 0) > 0) return 'flash';
  if ((fn.thrust ?? 0) > 0) return 'kick';
  if (fn.weapon) return 'charged';
  return null;
}

/** The bank feeding a part by touch (a store index), -1 none */
export function bankFor(d: ShipDerived, part: number): number {
  const L = d.power;
  if (!L) return -1;
  const f = L.feedOf[part];
  if (f >= 0) return L.feeds[f].bank;
  // (Shields aren't burst consumers: the bank whose shields list has it)
  for (let s = 0; s < L.stores.length; s++) if (L.stores[s].shields?.includes(part)) return s;
  return -1;
}

const pctOf = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? 100 : Math.max(0, Math.min(100, v)));
const held = (d: ShipDerived, c: Charge, s: number) => (d.power!.stores[s].cap * pctOf(c.s[s])) / 100;
/** The charge with bank `s` holding `energy` (a copy: charges are shared) */
function withHeld(d: ShipDerived, c: Charge, s: number, energy: number): Charge {
  const L = d.power!, n = L.stores.length;
  const out = Array.from({ length: n }, (_, i) => pctOf(c.s[i]));
  const cap = L.stores[s].cap;
  out[s] = cap > 0 ? Math.round(Math.max(0, Math.min(100, (energy / cap) * 100)) * 1000) / 1000 : 100;
  return { ...c, s: out };
}

/** The Rail Driver can't fire off a wired (Steady) circuit: Steady holds its rails */
export function railUnheld(d: ShipDerived, part: number): boolean {
  const L = d.power;
  if (!L || L.dual[part] !== 'rail') return false;
  const k = L.circuitOf[part];
  return k < 0 || L.circuits[k].net < 0;
}

/**
 * A gun fires (guns.ts): what Surge does to the shot. `waited`: its cooldown as it fired (≤ 0: how long it sat
 * loaded). Returns the new charge, the shot's damage × and pierces added, or null (nothing changes)
 */
export function surgeShot(d: ShipDerived, c: Charge, w: WeaponInfo, waited: number, tuning: ShipTuning): { charge: Charge; damage: number; pierce: number } | null {
  const L = d.power;
  if (!L) return null;
  const st = surgeTuning(tuning);
  const b = bankFor(d, w.part);
  if (L.dual[w.part] === 'rail') {
    // Its bank sets the shot's power: an empty bank (or none) the least, a full one the most, with a pierce, and empties
    const cap = b >= 0 ? L.stores[b].cap : 0, h = b >= 0 ? held(d, c, b) : 0;
    const fill = cap > 0 ? h / cap : 0;
    const damage = st.rail.min + (st.rail.max - st.rail.min) * fill;
    if (b < 0 || cap <= 0) return { charge: c, damage, pierce: 0 };
    const full = fill >= st.rail.full;
    return { charge: withHeld(d, c, b, full ? 0 : Math.max(0, h - cap * st.rail.drain)), damage, pierce: full ? 1 : 0 };
  }
  if (b < 0 || waited > -st.pauseTicks) return null;
  const packet = Math.max(1, st.chargedPacket * w.energy);
  const h = held(d, c, b);
  if (h + 1e-9 < packet) return null;
  return { charge: withHeld(d, c, b, h - packet), damage: st.chargedDamage, pierce: 0 };
}

/**
 * Boosting on a kick tick (flight.ts): each bank pays for a kick from the engines it touches that push along `dir`
 * (ship-local), as far as it can. Returns the new charge and the speed the kick adds (world units a tick), or null
 */
export function surgeKick(d: ShipDerived, c: Charge, dir: Vec2, tuning: ShipTuning): { charge: Charge; dv: number } | null {
  const L = d.power;
  if (!L) return null;
  const st = surgeTuning(tuning);
  const force = new Map<number, number>(), cost = new Map<number, number>();
  for (const t of d.thrusters) {
    const f = L.feedOf[t.part];
    if (f < 0 || L.feeds[f].bank < 0) continue;
    const along = t.force[0] * dir[0] + t.force[1] * dir[1];
    if (along <= 1e-9) continue;
    const b = L.feeds[f].bank;
    force.set(b, (force.get(b) ?? 0) + along);
    cost.set(b, (cost.get(b) ?? 0) + (L.draw[t.part] * st.kickTicks * st.kickCost) / 60);
  }
  if (!force.size) return null;
  let charge = c, paid = 0;
  for (const [b, f] of force) {
    const h = held(d, charge, b), need = cost.get(b)!;
    const k = need > 0 ? Math.min(1, h / need) : 1;
    if (k <= 0.01) continue;
    charge = withHeld(d, charge, b, h - need * k);
    paid += f * k;
  }
  if (paid <= 0) return null;
  const m = Math.max(d.mass, d.fullMass ?? d.mass);
  return { charge, dv: m > 0 ? ((paid * (d.drive ?? 1)) / m) * st.kickTicks : 0 };
}

/**
 * The shield just broke (the server's damage step): the fullest bank touching a shield generator puts back its share
 * of the shield (all of it if a Flash Screen touches that bank), as far as it can pay. Returns the new charge and the
 * shield put back, or null
 */
export function flashRestore(d: ShipDerived, c: Charge, tuning: ShipTuning): { charge: Charge; restore: number } | null {
  const L = d.power;
  if (!L || d.shieldMax <= 0) return null;
  const st = surgeTuning(tuning);
  let best = -1, bestHeld = 0;
  L.stores.forEach((g, s) => {
    if (g.kind !== 'k' || !g.shields?.length) return;
    const h = held(d, c, s);
    if (h > bestHeld) { best = s; bestHeld = h; }
  });
  if (best < 0) return null;
  const screen = L.stores[best].shields!.some((i) => L.dual[i] === 'flash');
  const want = d.shieldMax * (screen ? st.flash.screen : st.flash.share);
  const restore = Math.min(want, bestHeld / st.flash.costPerPoint);
  if (restore < 1) return null;
  return { charge: withHeld(d, c, best, bestHeld - restore * st.flash.costPerPoint), restore };
}
