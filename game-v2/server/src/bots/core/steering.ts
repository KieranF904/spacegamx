/**
 * Steering for a bot: the four screen-relative move keys (mouse-steer flies in world directions, the nose is aimed
 * separately), pressed the way a player holds them. A pure function of the ship's pose, so it tests without a server.
 *
 * `flyTo` wants a velocity toward the goal that falls off as the goal nears (so friction and the engines stop the ship
 * on it) and presses a key on each axis while the velocity is short of it, with hysteresis so a key is not flickered
 * on and off (each change of keys is a control change to send, and to replicate for an NPC).
 */
import { idle, type Controls, type Pose } from './types.js';

export interface FlyOpts {
  /** Stop this far from the goal point */
  arrive: number;
  /** Wanted speed is `gain` × the distance still to go, up to `cap` (units a tick) */
  gain?: number;
  cap?: number;
  /** The goal's own velocity (a station or rock in orbit): matched when there */
  gx?: number; gy?: number;
}

const ON = 0.06, OFF = 0.02;

/** The keys (and boost off) for one tick of flying to (x, y); `prev` the keys held last tick (hysteresis). Aim is left to the caller. */
export function flyTo(pose: Pose, x: number, y: number, o: FlyOpts, prev: Controls = idle()): Controls {
  const gain = o.gain ?? 0.03, cap = o.cap ?? 40;
  const dx = x - pose.x, dy = y - pose.y;
  const dist = Math.hypot(dx, dy);
  const gvx = o.gx ?? 0, gvy = o.gy ?? 0;
  const out = idle(Math.atan2(dy, dx));
  const away = Math.max(0, dist - o.arrive);
  const want = Math.min(cap, away * gain);
  const vx = (away > 0 ? (dx / dist) * want : 0) + gvx, vy = (away > 0 ? (dy / dist) * want : 0) + gvy;
  const ex = vx - pose.vx, ey = vy - pose.vy;
  // (Screen y grows downward: forward is up the screen, -y)
  out.right = ex > (prev.right ? OFF : ON);
  out.left = ex < -(prev.left ? OFF : ON);
  out.backward = ey > (prev.backward ? OFF : ON);
  out.forward = ey < -(prev.forward ? OFF : ON);
  out.aimDist = dist;
  return out;
}

/** Hold still: brake against whatever velocity is left (matching a drift of (gx, gy)) */
export function hold(pose: Pose, prev: Controls = idle(), gx = 0, gy = 0): Controls {
  return flyTo(pose, pose.x, pose.y, { arrive: 0, gx, gy }, prev);
}

export const speedOf = (p: Pose): number => Math.hypot(p.vx, p.vy);
