/**
 * One tick of a ship's guns, the same on the server and on the firing
 * pilot's client: cooldowns tick down, turrets slew (only while the trigger
 * is held: idle, they point straight at the aim) and fixed guns gimbal
 * towards the aim, and the guns that are ready, aligned and told to fire
 * do. Barrels and shells are deterministic (launch.ts), so a pilot's client
 * fires its own shells on the very tick the server does, from the very same
 * barrel, instead of waiting a round trip to hear about them.
 *
 * Every gun fires by one of the shared firing models (types.ts FireSpec,
 * docs/design/rework-2026-11.md §3): cycle, clip, charge, ammo, beam, or auto
 * (Point Defence). Their state (ShipState rounds, reload, charge, spin) steps
 * here and only here, forward only, on the server and the pilot's client alike.
 *
 * The caller does the rest: the server spawns the shells, runs the beams and
 * sends the charge tells; the client draws the shells it predicts.
 */

import type { ShipState } from './state.js';
import type { ShipTuning } from './tuning.js';
import type { WeaponInfo } from './rebuild.js';
import type { FireSpec, WeaponMods } from './types.js';
import { buildShot, shipPointToWorld, type ProjectileSpec, type ShipPose } from './shot.js';
import { pointTurretAim, stepFixedGunAim, stepTurretAim } from './turret.js';
import { SHOT_AIM_STEPS, shotAimQ } from './launch.js';
import { BROWNOUT, chargeGroupsEnd, feedShare, type Charge } from './energy.js';
import { PF_LATCH, effCap, effShot, portsBeamStep, portsGunReady, portsPieceLit, portsShotAugmented, portsSpendShot, type PortsLayout, type PortsState } from './power/ports.js';
import { PILOT_EXTRAS } from './features/plan.js';
import { datan2, dcos, dsin } from '../math/detTrig.js';
import { EVERY_MASK, TRIG_LEFT, clickCalls, freshMasks, gunSelected, gunTriggeredBy, partWeaponGroups, trigSel } from './weaponGroups.js';

export interface GunOrders {
  /** Some gun's button is down (ship-wide: the held aim distance, the aim reads); each gun's own trigger is `word` */
  firing: boolean;
  /**
   * The trigger word (weaponGroups.ts trigWord: left 1, right 2, the group selection from bit 2): each gun fires on it
   * if its groups are selected. Absent (an AI's): the left button when `firing`, selection "all"
   */
  word?: number;
  /** World angle to the aim point (undefined: hold aim) */
  aimWorld?: number;
  /** How far away the aim point is (0: aim along aimWorld from anywhere) */
  aimDist: number;
  /**
   * A pilot's guns (its cursor distance, which other ends get only as it's applied): while the trigger is held they
   * step on a held distance that takes aimDist only on its due ticks (distDue). Absent (an AI ship's, whose aim
   * every end works out): aimDist every tick
   */
  hold?: boolean;
  /**
   * A pilot's held aim (sim/aimHold.ts), where the flight kept it: the guns still aim on aimWorld, and also work out
   * whether this would have aimed them exactly the same (GunStep.aimHeld). Absent: not asked
   */
  heldAim?: number;
  /**
   * The charge after this tick's power step (energy.ts powerTick): each gun
   * draws on the ship as its model says (gunLoad: its banks first), and reloads,
   * regrows or charges at the share of that it got (a brownout: slower); a beam
   * burns that share of the time. Absent: guns run free (no accounting).
   */
  energy?: { charge: Charge };
}

export interface GunShot {
  w: WeaponInfo;
  /** The aim it fired with, in SHOT_AIM_STEPS (fire events carry it) */
  aimQ: number;
  shot: ProjectileSpec;
  /** A ports ship's augmented shot (power/ports.ts): its augment's mods go on top of the gun's */
  aug?: WeaponMods;
}

/** A pulse laser that starts a pulse this tick (pulse.ts): charged like a gun's reload, paid for as one shot */
export interface GunPulse {
  w: WeaponInfo;
  aimQ: number;
}

/** A charge gun that starts charging (start) or is let go early (the charge drains away): everyone sees the tell (a shell-less fire event) */
export interface GunTell {
  w: WeaponInfo;
  aimQ: number;
  start: boolean;
}

export interface GunStep {
  shots: GunShot[];
  beams: WeaponInfo[];
  pulses: GunPulse[];
  /** Charge starts and early releases (empty on most ticks: a shared empty list) */
  tells: readonly GunTell[];
  /** The aim distance the guns stepped on (a pilot's held one: distDue; else orders.aimDist) */
  dist: number;
  /**
   * orders.heldAim would have done all this exactly the same (sim/aimHold.ts): every aimed gun's offset and readiness
   * alike on a tick the trigger is down, held or let go, a semi-automatic click waits, or anything fired. True when no
   * held aim was given
   */
  aimHeld: boolean;
}

/** Ticks a click waits for a semi-automatic gun to be ready (a click just before the gun is) */
export const SEMI_BUFFER = 5;

/** Ticks a charge let go early takes to drain away (nothing fires) */
export const CHARGE_DRAIN = 15;
/** Ticks after its last shot that a partly spent clip starts reloading */
export const CLIP_IDLE = 60;
/** Fire-event ammo codes that mark a charge tell (no shells): a charge started, a charge let go */
export const TELL_CHARGE_START = 255;
export const TELL_CHARGE_CANCEL = 254;
/** Fire-event ammo code (no shells) for a beam in pieces spending a piece: its pulse starts on that tick (power/ports.ts portsBeamStep), so every client draws it then */
export const TELL_BEAM_PIECE = 253;
/** Fire-event ammo code (no shells) for a ports ship's mining laser starting a pulse (power/ports.ts portsMineStep); its aim field carries the fulfilment it started at, 0..255 */
export const TELL_MINE_PULSE = 252;

const NO_TELLS: readonly GunTell[] = Object.freeze([]);

/** A spinning gun's interval now (its beat eases from spin.from to spin.to as it spins up); any other gun's own */
export function gunInterval(ship: ShipState, w: WeaponInfo): number {
  const s = w.fire.spin;
  if (!s) return w.interval;
  const k = ship.spin[w.part] ?? 0;
  return (w.interval * (s.from + (s.to - s.from) * k)) / Math.max(1e-9, w.fire.interval);
}

/**
 * Ticks a shot (a volley) takes on average, firing flat out, by its model: a clip's beat plus its share of the reload
 * (a regrowing clip: no faster than it regrows), a charge's charge and cooldown; any other gun's interval (a spinning
 * one at full spin). What firepower and ratings divide by (rating.ts, partStats.ts)
 */
export function averageInterval(fire: FireSpec | undefined, interval: number): number {
  if (!fire) return interval;
  const per = fire.rounds ?? 1;
  switch (fire.model) {
    case 'clip': {
      const shots = Math.max(1, Math.floor((fire.clip ?? 1) / per));
      return fire.regrow ? Math.max(interval, fire.regrow * per) : interval + (fire.reload ?? 0) / shots;
    }
    case 'charge': return (fire.charge ?? interval) + (fire.cooldown ?? 0);
    default: return fire.spin ? (interval * fire.spin.to) / Math.max(1e-9, fire.interval) : interval;
  }
}

/** A beam's damage scale from its windup (0 → 1 over `windup` ticks lit); 1 without one */
export function windupScale(ship: ShipState, w: WeaponInfo): number {
  const n = w.fire.windup;
  return n ? Math.min(1, (ship.charge[w.part] ?? 0) / n) : 1;
}

/** Is a clip gun reloading (a whole-clip reload under way)? */
export function clipReloading(ship: Pick<ShipState, 'reload'>, w: WeaponInfo): boolean {
  return w.fire.model === 'clip' && !w.fire.regrow && (ship.reload[w.part] ?? 0) > 0;
}

// ---- The gun-state correction (docs/design/rework-2026-11.md §3.3): the pilot row's last slot, own ship only.
// A count, then that many (part index, value) pairs for the ship's clip and charge guns (the first GUN_STATE_MAX in
// weapon order): a clip gun's rounds (+ GUN_STATE_RELOADING while it reloads), a charge gun's charge in whole ticks.
// (The client no longer reads it: its own ship's gun state is stepped whole on its tick layer and put right exactly by an
// ownSync, sim/ownStep.ts. The slot still rides the row: dropping it is a row-layout change, a protocol bump.)

/** The most guns the gun-state slot carries */
export const GUN_STATE_MAX = 8;
/** Added to a clip gun's rounds while it reloads; a further GUN_STATE_RELOADING per eighth of the reload already done */
export const GUN_STATE_RELOADING = 128;
/** Steps the reload's progress is carried in */
const RELOAD_STEPS = 8;
/** Ticks of disagreement the client waits before it takes the server's gun state */
export const GUN_STATE_PATIENCE = 30;
/** What the slot holds (in the wire hash: a change of meaning is a protocol bump) */
export const GUN_STATE_LAYOUT = `count+(part,value)x${GUN_STATE_MAX}:clip=rounds+${GUN_STATE_RELOADING}x(1+eighths of the reload done)reloading,charge=ticks`;

/** Does the gun-state slot carry this gun (a clip or charge gun)? */
export function carriesGunState(w: WeaponInfo): boolean {
  return w.fire.model === 'clip' || w.fire.model === 'charge';
}

/** A gun's value in the gun-state slot */
export function gunStateValue(ship: ShipState, w: WeaponInfo): number {
  if (w.fire.model === 'clip') {
    const rounds = Math.max(0, Math.min(GUN_STATE_RELOADING - 1, Math.round(ship.rounds[w.part])));
    if (!clipReloading(ship, w)) return rounds;
    const len = w.fire.reload ?? 60, done = Math.max(0, Math.min(RELOAD_STEPS - 1, Math.floor((1 - ship.reload[w.part] / len) * RELOAD_STEPS)));
    return rounds + GUN_STATE_RELOADING * (1 + done);
  }
  return Math.max(0, Math.round(ship.charge[w.part]));
}

/** Where the gun-state slot starts in a pilot row: after the charge groups and the part features' values */
export function gunStateAt(data: ArrayLike<number>): number {
  return chargeGroupsEnd(data) + PILOT_EXTRAS;
}

/** Append the gun-state slot to a pilot row (the server's): the count, then the pairs */
export function packGunState(ship: ShipState, out: number[]): void {
  const at = out.length;
  out.push(0);
  let n = 0;
  for (const w of ship.derived.weapons) {
    if (n >= GUN_STATE_MAX || !carriesGunState(w)) continue;
    out.push(w.part, gunStateValue(ship, w));
    n++;
  }
  out[at] = n;
}

/**
 * Take the server's value for one gun (the client, after GUN_STATE_PATIENCE ticks of disagreeing). `v` is the server's
 * value at its tick T. With `mine` (our own value at T) and `elapsed` (ticks from T to now), the adoption is the
 * DELTA (server - mine@T) applied to the present state, and a reload resumes `elapsed` ticks further on, so our own
 * shots and charge ticks since T are kept. Without them the raw value is written.
 */
export function applyGunState(ship: ShipState, w: WeaponInfo, v: number, mine?: number, elapsed = 0): void {
  const p = w.part, f = w.fire;
  if (f.model === 'clip') {
    const clip = f.clip ?? 1, sr = v % GUN_STATE_RELOADING;
    ship.rounds[p] = mine === undefined ? sr : Math.max(0, Math.min(clip, ship.rounds[p] + (sr - (mine % GUN_STATE_RELOADING))));
    if (f.regrow) return;
    // Reloading: resume at the server's progress (the middle of its eighth), not from the start
    if (v >= GUN_STATE_RELOADING) {
      const left = (f.reload ?? 60) * (1 - (Math.floor(v / GUN_STATE_RELOADING) - 1 + 0.5) / RELOAD_STEPS) - elapsed;
      if (left > 0) ship.reload[p] = left;
      else { ship.reload[p] = 0; ship.rounds[p] = clip; } // it has finished since
    } else if (mine === undefined || mine >= GUN_STATE_RELOADING) ship.reload[p] = 0;
  } else if (f.model === 'charge') {
    ship.charge[p] = mine === undefined ? v : Math.max(0, Math.min(f.charge ?? Infinity, ship.charge[p] + (v - mine)));
  }
}

/** Guns of a group fire in turn (see stepGuns): the others of `w`'s group that are ready wait their turn, `interval / guns` apart, in part order */
function stagger(ship: ShipState, w: WeaponInfo): void {
  const same = (x: WeaponInfo) => x.kind === w.kind && x.fire.model === w.fire.model && Math.abs(x.interval - w.interval) < 1e-6;
  let n = 0;
  for (const x of ship.derived.weapons) if (same(x)) n++;
  if (n < 2) return;
  const gap = w.interval / n;
  let turn = 1;
  for (const x of ship.derived.weapons) {
    if (x === w || !same(x) || ship.cooldown[x.part] > 0) continue;
    ship.cooldown[x.part] = turn++ * gap;
  }
}

/** Beams in pieces burning on with the trigger let go (stepGuns' scratch, cleared each call) */
const letGo = new Set<number>();

/** A loaded gun counts on below 0 while it waits (how long it has: see stepGuns), down to this */
const MAX_WAIT = 600;

/**
 * The held-distance rule (a pilot's guns, GunOrders.hold): while the trigger is held through from the tick before, a
 * pilot's guns step on an aim distance held from earlier ticks (ShipState.heldDist), which takes the cursor's afresh
 * only on a tick some gun is due: twice per its fire interval, on the tick it fires (before it steps, so the shot flies
 * at the cursor exactly) and halfway to its next (so a turret's slew between shots heads for about the right point).
 * Idle, and on the tick the trigger goes down, the guns step on the cursor's. A pure function of the gun state as the
 * tick begins (its cooldowns, reloads and charges, stepped as stepGuns steps them), so every end that steps the guns
 * (the server's real ship, its lanes, other clients' lanes, the pilot's own prediction) holds the same distance, and
 * other ends need it only as it's applied (server GunNet: a gun row only when it changes).
 *
 * Due this tick, by model (`share`: each gun's share of its power, as stepGuns has it; `ports`: a ports ship, whose
 * guns charge and reload at a tick a tick here):
 *  - beam: every tick (it fires every tick it burns)
 *  - semi-automatic: a click waiting for it and the gun loaded after this tick's step (held, it fires only on a click;
 *    clicked through a clip's reload, only the tick the reload ends: semiLoaded)
 *  - charge: the tick its charge fills (it fires) or crosses half; cooling down, never
 *  - clip, reloading: the tick the reload ends or crosses half
 *  - any other (cycle, ammo, a clip's beat; spinning and staggered guns by their cooldown): the tick its cooldown
 *    reaches 0 (it fires, unless held back: off its aim, short of power), the tick it crosses half its interval, and
 *    while it waits loaded, every half interval (by the tick)
 * Point defence aims on its own: never due.
 */
export function distDue(ship: ShipState, tick: number, tuning: ShipTuning, share: (w: WeaponInfo) => number, ports: boolean): boolean {
  const weapons = tuning.weapons ?? {};
  const clicked = tick - ship.clickAt <= SEMI_BUFFER;
  for (const w of ship.derived.weapons) {
    const f = w.fire, p = w.part;
    if (f.model === 'auto' || weapons[w.kind]?.pointDefence) continue;
    if (f.model === 'beam') return true;
    // (its cooldown after this tick's step, as stepGuns steps it)
    const cd0 = ship.cooldown[p];
    const cd = cd0 > 0 && f.model === 'cycle' ? cd0 - share(w) : cd0 - 1;
    if (f.semi) { if (clicked && cd <= 0 && clickCalls(ship.clickMasks, partWeaponGroups(ship.blueprint.parts[p])) && (ports || semiLoaded(ship, w, cd, share(w)))) return true; continue; }
    if (f.model === 'charge') {
      if (cd > 0) continue;
      const c = Math.max(0, ship.charge[p]), full = f.charge ?? 60, c1 = c + (ports ? 1 : share(w));
      if (c1 >= full - 1e-9 || (c < full / 2 && c1 >= full / 2)) return true;
      continue;
    }
    if (f.model === 'clip' && !f.regrow && ship.reload[p] > 0) {
      const r0 = ship.reload[p], r = r0 - (ports ? 1 : share(w)), len = f.reload ?? 60;
      if (r <= 1e-9 || (r0 > len / 2 && r <= len / 2)) return true;
      continue;
    }
    const half = gunInterval(ship, w) / 2;
    if (cd <= 0) {
      if (cd0 > 0 || tick % Math.max(1, Math.round(half)) === 0) return true;
      continue;
    }
    if (cd0 > half && cd <= half) return true;
  }
  return false;
}

/**
 * Will a semi-automatic gun hold a shot once this tick's clip step is done (stepClip, at `share`; `cd` its cooldown
 * after the step)? Not a clip: yes. A clip reloading holds one only on the tick its reload ends; a loaded clip not on the
 * tick it starts reloading (empty, or partly spent and idle); a regrowing clip once it has a shot's rounds.
 * (distDue's: a click waiting through a reload is not due. A ports ship's clip is its buffer: distDue doesn't ask.)
 */
function semiLoaded(ship: ShipState, w: WeaponInfo, cd: number, share: number): boolean {
  const f = w.fire, p = w.part;
  if (f.model !== 'clip') return true;
  const need = f.rounds ?? 1, clip = f.clip ?? 1, rounds = ship.rounds[p];
  if (f.regrow) return rounds >= need || (rounds < clip && rounds + 1 >= need && ship.reload[p] + share >= f.regrow);
  if (ship.reload[p] > 0) return ship.reload[p] - share <= 1e-9;
  return rounds >= need && !(rounds < clip && cd <= w.interval - CLIP_IDLE);
}

/** A clip gun's reload (or regrowth) for one tick, at its share of the power it asked for */
function stepClip(ship: ShipState, w: WeaponInfo, share: number): void {
  const f = w.fire, p = w.part, clip = f.clip ?? 1;
  if (f.regrow) {
    if (ship.rounds[p] >= clip) { ship.reload[p] = 0; return; }
    ship.reload[p] += share;
    if (ship.reload[p] >= f.regrow) {
      ship.reload[p] -= f.regrow;
      if (++ship.rounds[p] >= clip) ship.reload[p] = 0;
    }
    return;
  }
  if (ship.reload[p] > 0) {
    ship.reload[p] -= share;
    if (ship.reload[p] <= 1e-9) { ship.reload[p] = 0; ship.rounds[p] = clip; }
    return;
  }
  // Empty, or a partly spent clip left alone a second: it reloads (the cooldown counts the ticks since its last shot)
  if (ship.rounds[p] < (f.rounds ?? 1) || (ship.rounds[p] < clip && ship.cooldown[p] <= w.interval - CLIP_IDLE)) ship.reload[p] = f.reload ?? 60;
}

/**
 * Step every gun one tick. Returns the projectile guns that fire now, the
 * pulse lasers that start a pulse, the beams that are on (a pulse runs its
 * course on its own) and the charge tells.
 *
 * By model (types.ts FireSpec):
 * - cycle (and auto): a loaded gun fires; its shot's energy is drawn as it reloads
 *   (energy.ts gunLoad), from the banks it touches, then the ship. Short of
 *   power, every gun gets the same share, so all reload that much slower and a
 *   big gun is never starved by small ones (the ready ones still go
 *   longest-waiting first). A spinning gun's beat quickens as it's held.
 * - clip: fires while it has rounds; empty (or idle a second with a partial
 *   clip) it reloads at its share, then the clip is full; a regrowing clip gets a
 *   round back at a time instead.
 * - charge: held, aligned and cooled, it charges at its share; full, it fires
 *   itself and cools down. Let go early, or held off the aim, the charge drains away and nothing fires.
 * - ammo: a cycle that needs no power (the server spends the rounds).
 * - beam: on while held and aligned; short of power it burns that share of the
 *   ticks, evenly spread (the sputter); a windup ramps its damage in.
 *
 * Kinds that stagger (tuning `stagger`: pulse lasers, railguns, missiles)
 * fire one after another instead of all together: a gun of such a kind that
 * fires sets the others of its group (same kind, model and interval, so a laser
 * never waits on a cannon or one of another charge time) that are ready to
 * wait their turn, `interval / guns` apart. So on a first pull the first fires
 * at once and the rest ripple after it, and from then on each keeps its own
 * interval: as many shots a minute as before, evenly spaced. A group mid-cycle
 * isn't touched.
 */
export function stepGuns(ship: ShipState, pose: ShipPose, orders: GunOrders, tick: number, tuning: ShipTuning): GunStep {
  const shots: GunShot[] = [];
  const beams: WeaponInfo[] = [];
  const pulses: GunPulse[] = [];
  let tells = NO_TELLS as GunTell[];
  const weapons = tuning.weapons ?? {};
  const { aimWorld } = orders;
  // A ports ship (power/ports.ts): each gun fires from its own buffer, a shot's worth at a time, and a beam lights while its buffer
  // can feed it; nothing is shared. (Unaccounted without the state, as the old one is without a charge)
  // (A gun range cheat ship's guns are always fully powered, types.ts Blueprint.range: its power goes unaccounted)
  const energy = ship.blueprint.range ? undefined : orders.energy;
  const pz: PortsLayout | undefined = ship.derived.ports && energy?.charge.e ? ship.derived.ports : undefined, E = energy?.charge.e as PortsState;
  // Each gun's share of the power it asked for this tick (1 unaccounted, or with plenty)
  const share = (w: WeaponInfo) => (energy && !pz ? feedShare(ship.derived, energy.charge, w.part, 'gun') : 1);
  // (A beam short of power burns that share of the ticks, evenly spread)
  // (A beam in pieces burns a piece out whatever the trigger: `want` only decides whether the next follows)
  const burns = (w: WeaponInfo, want: boolean) => { if (pz) return portsBeamStep(pz, E, w.part, want) > 0; const r = share(w); return r >= BROWNOUT || (r > 0 && Math.floor(tick * r) !== Math.floor((tick - 1) * r)); };
  const tell = (w: WeaponInfo, start: boolean) => {
    if (tells === NO_TELLS) tells = [];
    tells.push({ w, aimQ: shotAimQ(ship.aim[w.part]), start });
  };
  // Turrets slew (their turn rate) only while the trigger is held through from the tick before; not firing, or on the
  // tick it goes down, a turret points straight at the aim (pointTurretAim): no slew state is carried while idle, so
  // what fires on a trigger-down depends only on that tick's aim (other pilots' idle aim distance isn't sent exactly)
  const slewing = orders.firing && ship.triggerHeld;
  // (Per gun, from this tick's trigger word and last tick's: with the selection on "all" every gun reads what the ship does)
  const word = orders.word ?? (orders.firing ? TRIG_LEFT : 0), prevWord = ship.trig ?? 0;
  const hasMiners = ship.derived.miners.length > 0, sel = trigSel(word);
  // A semi-automatic gun fires once per click: the click is kept a few ticks, for one pressed just before the gun is ready.
  // A click: some gun's trigger goes down; it is for those guns only (clickMasks: their group masks, absent every gun's),
  // so a gun held through a group change or the other button's press needs a fresh click of its own. A click that comes
  // while another waits adds its guns to it. (Before the held distance: a click's tick may be due, distDue)
  let click = orders.firing && !ship.triggerHeld;
  if (!click && word !== prevWord) for (const w of ship.derived.weapons) { const m = partWeaponGroups(ship.blueprint.parts[w.part]); if (gunTriggeredBy(m, word, hasMiners) && !gunTriggeredBy(m, prevWord, hasMiners)) { click = true; break; } }
  if (click) {
    const waiting = tick - ship.clickAt <= SEMI_BUFFER ? ship.clickMasks ?? EVERY_MASK : 0;
    const masks = waiting | freshMasks(word, prevWord, hasMiners);
    ship.clickMasks = masks === EVERY_MASK ? undefined : masks;
    ship.clickAt = tick;
  }
  // (A pilot's guns, held through: on the distance held from earlier ticks, taken afresh on a due tick: distDue)
  let aimDist = orders.aimDist;
  if (orders.hold) {
    if (slewing && ship.heldDist !== undefined && ship.heldDist !== aimDist && !distDue(ship, tick, tuning, share, !!pz)) aimDist = ship.heldDist;
    ship.heldDist = aimDist;
  } else if (ship.heldDist !== undefined) ship.heldDist = undefined;
  const aimX = aimWorld === undefined ? 0 : pose.x + dcos(aimWorld) * aimDist;
  const aimY = aimWorld === undefined ? 0 : pose.y + dsin(aimWorld) * aimDist;
  // (The held aim, sim/aimHold.ts: each aimed gun's aim worked out on it too, and compared. `heldDiff`: some gun's differs)
  const heldAim = aimWorld === undefined ? undefined : orders.heldAim;
  const heldX = heldAim === undefined ? 0 : pose.x + dcos(heldAim) * aimDist;
  const heldY = heldAim === undefined ? 0 : pose.y + dsin(heldAim) * aimDist;
  let heldDiff = false;
  // (The trigger down, held or let go this tick: what the guns aim at is read (a turret's slew, a charge let go's tell))
  const reads = orders.firing || ship.triggerHeld;
  const ready: WeaponInfo[] = [];
  letGo.clear();
  ship.triggerHeld = orders.firing;
  ship.trig = word;
  const semiReady: WeaponInfo[] = [];
  const clicked = tick - ship.clickAt <= SEMI_BUFFER;
  let semiWaits = false;
  for (const w of ship.derived.weapons) {
    const f = w.fire, p = w.part;
    // (Reloading, a cycle gun loads at its share: a browned-out gun reloads slower. Every other model's beat needs no power)
    const cd0 = ship.cooldown[p];
    ship.cooldown[p] = Math.max(-MAX_WAIT, cd0 > 0 && (f.model === 'cycle' || f.model === 'auto') ? cd0 - share(w) : cd0 - 1);
    if (f.model === 'clip') {
      // (On a ports ship the clip is the gun's buffer: its rounds are the shots it holds, and it reloads, latched, until full)
      if (pz) { const s = effShot(pz, E, p); ship.rounds[p] = Math.min(f.clip ?? 1, s > 0 ? Math.floor(E.held[p] / s) : 0); ship.reload[p] = E.flags[p] & PF_LATCH ? Math.max(1, Math.ceil((effCap(pz, E, p) - E.held[p]) / Math.max(1, pz.rate[p]))) : 0; }
      else stepClip(ship, w, share(w));
    }
    // (A charge let go early drains away)
    else if (f.model === 'charge' && ship.charge[p] < 0) ship.charge[p] = Math.min(0, ship.charge[p] + (f.charge ?? 60) / CHARGE_DRAIN);
    // (Point defence reloads here, drawing its power as any gun does, but aims and fires on its own: support.ts)
    if (f.model === 'auto' || weapons[w.kind]?.pointDefence) continue;
    let canFire = true;
    const mask = partWeaponGroups(ship.blueprint.parts[p]), trigNow = gunTriggeredBy(mask, word, hasMiners);
    const slewGun = trigNow && gunTriggeredBy(mask, prevWord, hasMiners);
    // (A semi-automatic gun answers a waiting click its own trigger made, while its groups are selected)
    const answers = f.semi === true && clicked && clickCalls(ship.clickMasks, mask) && gunSelected(mask, sel, hasMiners);
    if (answers) semiWaits = true;
    if (w.window) {
      let desired = w.window.center + ship.aim[p];
      let px = 0, py = 0;
      if (aimWorld !== undefined) {
        let worldAngle = aimWorld;
        if (aimDist > 0) {
          [px, py] = shipPointToWorld(ship, pose, w.window.pivot, tuning.cellSize);
          worldAngle = datan2(aimY - py, aimX - px);
        }
        // World angle → local grid frame (grid forward is -y)
        desired = worldAngle - (pose.angle + Math.PI / 2);
      }
      const res = slewGun ? stepTurretAim(w.window, ship.aim[p], desired, tuning) : pointTurretAim(w.window, desired, tuning);
      if (heldAim !== undefined && !heldDiff) {
        const dh = (aimDist > 0 ? datan2(heldY - py, heldX - px) : heldAim) - (pose.angle + Math.PI / 2);
        const rh = slewGun ? stepTurretAim(w.window, ship.aim[p], dh, tuning) : pointTurretAim(w.window, dh, tuning);
        if (rh.offset !== res.offset || rh.canFire !== res.canFire) heldDiff = true;
      }
      ship.aim[p] = res.offset;
      canFire = res.canFire;
    } else if (aimWorld !== undefined) {
      // Fixed gun: fires when the cursor point is (almost) straight down its barrel,
      // or when the ship itself is pointed at it (close targets, guns out on the wings)
      let worldAngle = aimWorld;
      let mx = 0, my = 0;
      if (aimDist > 0) {
        [mx, my] = shipPointToWorld(ship, pose, w.muzzle, tuning.cellSize);
        worldAngle = datan2(aimY - my, aimX - mx);
      }
      const facing = datan2(w.dir[1], w.dir[0]);
      const local = (a: number) => a - (pose.angle + Math.PI / 2) - facing;
      const beam = f.model === 'beam' || weapons[w.kind]?.type === 'beam', gimbal = weapons[w.kind]?.gimbalDeg;
      const res = stepFixedGunAim(local(worldAngle), tuning, local(aimWorld), beam, gimbal);
      if (heldAim !== undefined && !heldDiff) {
        const rh = stepFixedGunAim(local(aimDist > 0 ? datan2(heldY - my, heldX - mx) : heldAim), tuning, local(heldAim), beam, gimbal);
        if (rh.offset !== res.offset || rh.canFire !== res.canFire) heldDiff = true;
      }
      ship.aim[p] = res.offset;
      canFire = res.canFire;
    }
    const want = trigNow && canFire;
    if (f.semi) {
      // (Held or not, it needs a fresh click; a reloading or busy gun is skipped, so the next of its kind takes the shot)
      if (answers && canFire && ship.cooldown[p] <= 0 && ship.rounds[p] >= (f.rounds ?? 1) && (f.regrow || ship.reload[p] <= 0)) semiReady.push(w);
      continue;
    }
    // A spinning gun spins up while it's fired, and down when it isn't
    if (f.spin) ship.spin[p] = want ? Math.min(1, ship.spin[p] + 1 / Math.max(1, f.spin.up)) : Math.max(0, ship.spin[p] - 1 / Math.max(1, f.spin.down));
    if (f.model === 'charge') {
      // Let go: a charge under way drains away, and nothing fires (held but cooling, it waits)
      // Held but unable to fire (off the aim, still slewing) counts as let go too: a stalled charge would otherwise keep drawing its energy
      if (!want) { if (ship.charge[p] > 0) { tell(w, false); ship.charge[p] = -ship.charge[p]; } continue; }
      if (canFire && ship.cooldown[p] <= 0) ready.push(w);
      continue;
    }
    if (!want) {
      // (A beam let go winds up again from nothing; on a ports ship it goes out, but a piece once spent burns to its end)
      if (f.model === 'beam') {
        if (pz && portsPieceLit(pz, E, p)) { ready.push(w); letGo.add(p); continue; }
        ship.charge[p] = 0; if (pz) portsBeamStep(pz, E, p, false);
      }
      continue;
    }
    if (f.model === 'beam') ready.push(w);
    else if (ship.cooldown[p] <= 0 && (f.model !== 'clip' || (ship.rounds[p] >= (f.rounds ?? 1) && (f.regrow || ship.reload[p] <= 0))) && (!pz || portsGunReady(pz, E, p, f.model === 'clip' ? f.rounds ?? 1 : 1))) ready.push(w);
  }
  if (semiReady.length) {
    // One shot a click for each kind of semi-automatic gun: the one that has waited longest, so a pair takes turns
    const taken = new Set<string>();
    semiReady.sort((a, b) => ship.cooldown[a.part] - ship.cooldown[b.part] || a.part - b.part);
    for (const w of semiReady) if (!taken.has(w.kind)) { taken.add(w.kind); ready.push(w); }
    ship.clickAt = -1e9; ship.clickMasks = undefined;
  }
  if (orders.energy && ready.length > 1) ready.sort((a, b) => ship.cooldown[a.part] - ship.cooldown[b.part] || a.part - b.part);
  for (const w of ready) {
    const f = w.fire, p = w.part;
    if (f.model === 'beam') {
      if (!burns(w, !letGo.has(p))) continue;
      // (A beam pays a tick at a time: each one is a shot. Its windup counts the ticks it has burned)
      ship.cooldown[p] = 1;
      if (f.windup) ship.charge[p] = Math.min(f.windup, ship.charge[p] + 1);
      beams.push(w);
      continue;
    }
    // (Waiting its turn in its group's ripple: see stagger below)
    if (ship.cooldown[p] > 0) continue;
    if (f.model === 'charge') {
      // A charge starts (over a draining one: afresh), and everyone is told; it fills at the gun's share, and full, it fires
      if (ship.charge[p] <= 0) { ship.charge[p] = 0; tell(w, true); }
      // (On a ports ship it charges while its buffer holds the shot)
      ship.charge[p] += pz ? (portsGunReady(pz, E, p) ? 1 : 0) : share(w);
      if (ship.charge[p] < (f.charge ?? 60) - 1e-9) continue;
      ship.charge[p] = 0;
    }
    const cd = ship.cooldown[p];
    // The aim fires in fire-event steps, so clients build the same shells (see launch.ts)
    const aimQ = shotAimQ(ship.aim[p]);
    ship.aim[p] = aimQ / SHOT_AIM_STEPS;
    // (A ports ship pays for the shot now, from the gun's buffer and its feed buffer; its material may make the shot hit harder)
    const dmg = pz ? portsSpendShot(pz, E, p, f.model === 'clip' ? f.rounds ?? 1 : 1) : 1;
    const aug = pz && portsShotAugmented() ? pz.augMods[p] : undefined;
    if (weapons[w.kind]?.type === 'beam') pulses.push({ w, aimQ });
    else { const shot = buildShot(w, ship, pose, tick, tuning); if (dmg !== 1) shot.damageScale *= dmg; shots.push(aug ? { w, aimQ, shot, aug } : { w, aimQ, shot }); }
    if (f.model === 'charge') ship.cooldown[p] = f.cooldown ?? w.interval;
    // Fired on time, it keeps the fraction of a tick it was late by (so an interval of 14.3 averages 14.3); after a wait, it starts afresh
    else ship.cooldown[p] = (cd > -1 ? cd : 0) + gunInterval(ship, w);
    if (f.model === 'clip') ship.rounds[p] -= f.rounds ?? 1;
    if ((f.model === 'cycle' || f.model === 'ammo') && weapons[w.kind]?.stagger) stagger(ship, w);
  }
  // (Held: unless a gun's aim differed on it where it's read: the trigger down, held or let go, a click waiting, a shot)
  const aimHeld = !heldDiff || !(reads || semiWaits || shots.length > 0 || beams.length > 0 || pulses.length > 0 || tells.length > 0);
  return { shots, beams, pulses, tells, dist: aimDist, aimHeld };
}
