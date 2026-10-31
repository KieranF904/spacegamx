/**
 * One tick of a ship's guns, the same on the server and on the firing
 * pilot's client: cooldowns tick down, turrets slew and fixed guns gimbal
 * towards the aim, and the guns that are ready, aligned and told to fire
 * do. Barrels and shells are deterministic (launch.ts), so a pilot's client
 * fires its own shells on the very tick the server does, from the very same
 * barrel, instead of waiting a round trip to hear about them.
 *
 * The caller does the rest: the server spawns the shells and runs the beams;
 * the client draws the shells it predicts.
 */

import type { ShipState } from './state.js';
import type { ShipTuning } from './tuning.js';
import type { WeaponInfo } from './rebuild.js';
import { buildShot, shipPointToWorld, type ProjectileSpec, type ShipPose } from './shot.js';
import { stepFixedGunAim, stepTurretAim } from './turret.js';
import { SHOT_AIM_STEPS, shotAimQ } from './launch.js';
import { BROWNOUT, feedShare, type Charge } from './energy.js';

export interface GunOrders {
  firing: boolean;
  /** World angle to the aim point (undefined: hold aim) */
  aimWorld?: number;
  /** How far away the aim point is (0: aim along aimWorld from anywhere) */
  aimDist: number;
  /**
   * The charge after this tick's power step (energy.ts powerTick): each gun
   * draws on its own circuit while it reloads (gunLoad), and reloads at the
   * share of that its circuit could give (a brownout: slower); a beam burns
   * that share of the time. Absent: guns run free (no accounting).
   */
  energy?: { charge: Charge };
  /** Intervals × this (a cold ship's guns recycle slower: warmth.ts); absent: 1 */
  slow?: number;
}

export interface GunShot {
  w: WeaponInfo;
  /** The aim it fired with, in SHOT_AIM_STEPS (fire events carry it) */
  aimQ: number;
  shot: ProjectileSpec;
}

/** A pulse laser that starts a pulse this tick (pulse.ts): charged like a gun's reload, paid for as one shot */
export interface GunPulse {
  w: WeaponInfo;
  aimQ: number;
}

/** Guns of a group fire in turn (see stepGuns): the others of `w`'s group that are ready wait their turn, `interval / guns` apart, in part order */
function stagger(ship: ShipState, w: WeaponInfo): void {
  let n = 0;
  for (const x of ship.derived.weapons) if (x.kind === w.kind && Math.abs(x.interval - w.interval) < 1e-6) n++;
  if (n < 2) return;
  const gap = w.interval / n;
  let turn = 1;
  for (const x of ship.derived.weapons) {
    if (x === w || x.kind !== w.kind || Math.abs(x.interval - w.interval) >= 1e-6 || ship.cooldown[x.part] > 0) continue;
    ship.cooldown[x.part] = turn++ * gap;
  }
}

/** A loaded gun counts on below 0 while it waits (how long it has: see stepGuns), down to this */
const MAX_WAIT = 600;

/**
 * Step every gun one tick. Returns the projectile guns that fire now, the
 * pulse lasers that start a pulse, and the beams that are on (cooling and
 * heat are the beams' own business; a pulse runs its course on its own).
 *
 * A loaded gun fires; its shot's energy is drawn as it reloads (energy.ts
 * gunLoad), from its own circuit. On a circuit short of power every gun on it
 * gets the same share, so all reload that much slower and a big gun is never
 * starved by small ones (the ready ones still go longest-waiting first).
 *
 * Kinds that stagger (tuning `stagger`: pulse lasers, railguns, missiles)
 * fire one after another instead of all together: a gun of such a kind that
 * fires sets the others of its group (same kind, same interval, so a laser
 * never waits on a cannon or one of another charge time) that are ready to
 * wait their turn, `interval / guns` apart. So on a first pull the first fires
 * at once and the rest ripple after it, and from then on each keeps its own
 * interval: as many shots a minute as before, evenly spaced. A group mid-cycle
 * isn't touched.
 */
export function stepGuns(ship: ShipState, pose: ShipPose, orders: GunOrders, tick: number, tuning: ShipTuning): { shots: GunShot[]; beams: WeaponInfo[]; pulses: GunPulse[] } {
  const shots: GunShot[] = [];
  const beams: WeaponInfo[] = [];
  const pulses: GunPulse[] = [];
  /** A beam that stays on while held (a pulse laser charges and fires like a gun) */
  const held = (w: WeaponInfo) => weapons[w.kind]?.type === 'beam' && !weapons[w.kind]?.pulse;
  const weapons = tuning.weapons ?? {};
  const { aimWorld, aimDist } = orders;
  // Each gun's share of the power it asked its circuit for this tick (1 unaccounted, or with plenty)
  const share = (w: WeaponInfo) => (orders.energy ? feedShare(ship.derived, orders.energy.charge, w.part, 'gun') : 1);
  // (A beam short of power burns that share of the ticks, evenly spread)
  const burns = (w: WeaponInfo) => { const r = share(w); return r >= BROWNOUT || (r > 0 && Math.floor(tick * r) !== Math.floor((tick - 1) * r)); };
  const aimX = aimWorld === undefined ? 0 : pose.x + Math.cos(aimWorld) * aimDist;
  const aimY = aimWorld === undefined ? 0 : pose.y + Math.sin(aimWorld) * aimDist;
  const ready: WeaponInfo[] = [];
  for (const w of ship.derived.weapons) {
    // (Reloading, it loads at its circuit's share: a browned-out gun reloads slower)
    const cd0 = ship.cooldown[w.part];
    ship.cooldown[w.part] = Math.max(-MAX_WAIT, cd0 > 0 && !held(w) ? cd0 - share(w) : cd0 - 1);
    let canFire = true;
    if (w.window) {
      let desired = w.window.center + ship.aim[w.part];
      if (aimWorld !== undefined) {
        let worldAngle = aimWorld;
        if (aimDist > 0) {
          const [px, py] = shipPointToWorld(ship, pose, w.window.pivot, tuning.cellSize);
          worldAngle = Math.atan2(aimY - py, aimX - px);
        }
        // World angle → local grid frame (grid forward is -y)
        desired = worldAngle - (pose.angle + Math.PI / 2);
      }
      const res = stepTurretAim(w.window, ship.aim[w.part], desired, tuning);
      ship.aim[w.part] = res.offset;
      canFire = res.canFire;
    } else if (aimWorld !== undefined) {
      // Fixed gun: fires when the cursor point is (almost) straight down its barrel,
      // or when the ship itself is pointed at it (close targets, guns out on the wings)
      let worldAngle = aimWorld;
      if (aimDist > 0) {
        const [mx, my] = shipPointToWorld(ship, pose, w.muzzle, tuning.cellSize);
        worldAngle = Math.atan2(aimY - my, aimX - mx);
      }
      const facing = Math.atan2(w.dir[1], w.dir[0]);
      const local = (a: number) => a - (pose.angle + Math.PI / 2) - facing;
      const res = stepFixedGunAim(local(worldAngle), tuning, local(aimWorld), weapons[w.kind]?.type === 'beam');
      ship.aim[w.part] = res.offset;
      canFire = res.canFire;
    }
    if (!orders.firing || !canFire) continue;
    if (held(w) ? !ship.overheated[w.part] : ship.cooldown[w.part] <= 0) ready.push(w);
  }
  if (orders.energy && ready.length > 1) ready.sort((a, b) => ship.cooldown[a.part] - ship.cooldown[b.part] || a.part - b.part);
  for (const w of ready) {
    // (Waiting its turn in its group's ripple: see stagger below)
    if (!held(w) && ship.cooldown[w.part] > 0) continue;
    if (held(w) && !burns(w)) continue;
    const cd = ship.cooldown[w.part];
    if (held(w)) {
      // (A beam pays a tick at a time: each one is a shot)
      ship.cooldown[w.part] = 1;
      beams.push(w);
      continue;
    }
    // The aim fires in fire-event steps, so clients build the same shells (see launch.ts)
    const aimQ = shotAimQ(ship.aim[w.part]);
    ship.aim[w.part] = aimQ / SHOT_AIM_STEPS;
    if (weapons[w.kind]?.type === 'beam') pulses.push({ w, aimQ });
    else shots.push({ w, aimQ, shot: buildShot(w, ship, pose, tick, tuning) });
    // Fired on time, it keeps the fraction of a tick it was late by (so an interval of 14.3 averages 14.3); after a wait, it starts afresh
    ship.cooldown[w.part] = (cd > -1 ? cd : 0) + w.interval * (orders.slow ?? 1);
    if (weapons[w.kind]?.stagger) stagger(ship, w);
  }
  return { shots, beams, pulses };
}
