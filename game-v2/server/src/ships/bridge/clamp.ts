/**
 * ShipBridge clamps: two pilots' ships locked by Docking Clamps flown as one body on the server's real ships (the shared
 * step: common sim/clampPair.ts; the decisions: ships/features/clamp; docs/design/groups-mines-docking.md 3).
 *
 *   ClampTable    the links (and an undock's pushes) by tick, and the clamp source every server step reads them by: the
 *                 pilots' step (flight.ts stepMovement's env) and the Replication shadows (net/Replication.ts)
 *   clampMove     the tick's order: a follower steps after its leader (it sits where the leader ends the tick), so a
 *                 follower reached first waits for it (stepMovement's first line)
 *   foldClampContacts  after the contact pass: what pushed either ship (a contact, a pull) is the pair's, an impulse
 *                 at the joined centre of mass; the follower is put back on the leader (flight.ts tick)
 *
 * A link from tick `from` to `until` (the first tick each flies alone again): the server decides it in the features'
 * tick after the pilots flew tick T, so it takes effect from T + 1, and a link ended then still holds for tick T's
 * shadows. Few links at a time: plain arrays.
 */

import { hasComponent } from 'bitecs';
import {
  Position, Velocity, Rotation, Player, joinDerived, followerPose, powerOfCtl, quantizeShipBody, pairLimited, clampStepInfo, dsincos,
  type ClampAt, type ClampSource, type ClampOffset, type ClampBody,
} from '@space-game/common';
import type { BridgeCtx } from './core.js';
import { readBody, writeBody } from './sync.js';

export interface ServerClampLink {
  leader: number;
  follower: number;
  /** The two clamps (blueprint uids) */
  lc: number;
  fc: number;
  offset: ClampOffset;
  /** The follower's load the pair carries (its cargo as the link was made: common sim/clampPair.ts ClampLinkRec.fcargo); 0: none */
  fcargo: number;
  /** First tick flown as one, and the first flown apart again (Infinity: still locked) */
  from: number;
  until: number;
  /** The follower's engine share on its last step (the pair's is the lower of the two: on the CTL power grid) */
  fshare?: number;
  /** The leader as its step left it this tick (what the contact pass then changed is folded into the pair) */
  after?: ClampBody;
  /** The tick the leader's step was cut by the follower's share (its own client can't know it: a keyframe of its own ship) */
  limited: number;
  /** The follower waited for its leader's step this tick */
  waiting: number;
  /** The leader stepped this tick */
  led: number;
}

export class ClampTable {
  readonly links: ServerClampLink[] = [];
  /** An undock's push apart, by ship: on `tick` */
  readonly pushes = new Map<number, { tick: number; ix: number; iy: number }>();

  constructor(private readonly ctx: BridgeCtx) {}

  /** Any link or push to fly by (the step's env carries the source only then) */
  get any(): boolean { return this.links.length > 0 || this.pushes.size > 0; }

  /** The link ship `eid` flies under on tick t (undefined: alone) */
  at(eid: number, t: number): ServerClampLink | undefined {
    for (const k of this.links) if ((k.leader === eid || k.follower === eid) && k.from <= t && t < k.until) return k;
    return undefined;
  }

  /** Its link now or still to come (undefined: none): one a ship at a time */
  open(eid: number): ServerClampLink | undefined {
    for (const k of this.links) if ((k.leader === eid || k.follower === eid) && k.until === Infinity) return k;
    return undefined;
  }

  /** The ship it is locked to on tick t (undefined: none): the contact pass leaves the pair out */
  partner(eid: number, t: number): number | undefined {
    if (!this.links.length) return undefined;
    const k = this.at(eid, t);
    return k ? (k.leader === eid ? k.follower : k.leader) : undefined;
  }

  /**
   * The leader's step on tick t flew the pair below what its own stores gave it (the follower's share was lower): its
   * own client stepped it on its own share (Replication sends it a keyframe of its own ship then)
   */
  limited(eid: number, t: number): boolean {
    if (!this.links.length) return false;
    const k = this.at(eid, t);
    return !!k && k.leader === eid && k.limited === t;
  }

  /** A lock (or a swap, or a fresh offset: the pair's new link) from tick `from`; ends either ship's open link there */
  lock(leader: number, follower: number, lc: number, fc: number, offset: ClampOffset, from: number, fcargo = 0): ServerClampLink {
    for (const k of this.links) if (k.until === Infinity && (k.leader === leader || k.follower === leader || k.leader === follower || k.follower === follower)) k.until = from;
    const k: ServerClampLink = { leader, follower, lc, fc, offset: { ...offset }, fcargo, from, until: Infinity, limited: -1, waiting: -1, led: -1 };
    this.links.push(k);
    return k;
  }

  /** The link lets go from tick `until` (an undock's push on the leader, the follower's the reverse) */
  end(k: ServerClampLink, until: number, push?: readonly [number, number]): void {
    k.until = Math.min(k.until, until);
    if (push) {
      this.pushes.set(k.leader, { tick: until, ix: push[0], iy: push[1] });
      this.pushes.set(k.follower, { tick: until, ix: -push[0], iy: -push[1] });
    }
  }

  /** Links and pushes done with by tick `now` (a link ended at `until` holds for that tick's shadows: kept a tick on) */
  prune(now: number): void {
    for (let i = this.links.length - 1; i >= 0; i--) if (this.links[i].until < now) this.links.splice(i, 1);
    for (const [eid, p] of this.pushes) if (p.tick < now) this.pushes.delete(eid);
  }

  /** The step's clamp source (common sim/clampPair.ts ClampSource) over these links, as the server's ships are now */
  readonly source: ClampSource = {
    at: (id, t): ClampAt | null => {
      const k = this.at(id, t);
      if (!k) {
        const p = this.pushes.get(id);
        return p && p.tick === t ? { kind: 'push', ix: p.ix, iy: p.iy } : null;
      }
      const L = this.ctx.bodies.get(k.leader), F = this.ctx.bodies.get(k.follower);
      if (!L || !F) return null;
      if (k.leader === id) return { kind: 'lead', joined: joinDerived(L.derived, F.derived, k.offset), share: k.fshare, fcargo: k.fcargo || undefined };
      return { kind: 'follow', leader: readBody(k.leader, L), offset: k.offset, leaderBits: this.ctx.replicaCtl.get(k.leader)?.bits ?? 0 };
    },
  };
}

/** (clampMove's guard: the step it asks for itself runs as any other) */
let inner = false;

/**
 * The pilots' step order under links (stepMovement's first line): true when this call stepped it, or left it for later.
 * A follower reached before its leader this tick waits; the leader steps, then the follower that waited for it. The
 * leader's body after its step is kept (foldClampContacts) and the follower's engine share (the pair's next step)
 */
export function clampMove(b: BridgeCtx, eid: number): boolean {
  // (A bridge without the table, a test's stand-in: no links)
  const T = b.clamps;
  if (inner || !T?.links.length) return false;
  const tick = b.host.getTick();
  const k = T.at(eid, tick);
  if (!k) return false;
  if (k.follower === eid) {
    if (k.led !== tick) { k.waiting = tick; return true; }
    stepInner(b, eid);
    noteFollower(b, k);
    return true;
  }
  stepInner(b, eid);
  k.led = tick;
  const L = b.bodies.get(eid);
  if (L) k.after = { x: Position.x[eid], y: Position.y[eid], vx: Velocity.x[eid], vy: Velocity.y[eid], angle: Rotation.angle[eid], angVel: L.angVel };
  // (The pair flew below the leader's own share, the follower's being lower: its own client stepped it on its own)
  if (pairLimited(clampStepInfo.own, k.fshare)) k.limited = tick;
  if (k.waiting === tick) { stepInner(b, k.follower); noteFollower(b, k); }
  return true;
}

function stepInner(b: BridgeCtx, eid: number): void {
  inner = true;
  clampStepInfo.own = 0;
  try { b.stepMovement(eid); } finally { inner = false; }
}

function noteFollower(b: BridgeCtx, k: ServerClampLink): void {
  const rec = b.replicaCtl.get(k.follower);
  k.fshare = rec ? powerOfCtl(rec.bits) : undefined;
}

const SC = { x: 0, y: 0 }, SC2: [number, number] = [0, 0];
function rot(vx: number, vy: number, angle: number): { x: number; y: number } {
  // (A leader-frame vector in the world, as clamp.ts turns it: grid forward is -y)
  const [s, c] = dsincos(angle + Math.PI / 2, SC2);
  SC.x = vx * c - vy * s; SC.y = vx * s + vy * c;
  return SC;
}

/**
 * After the contact pass (flight.ts tick): what pushed either ship of a pair this tick besides its step (a contact, a
 * pull) is the pair's: the change in each one's momentum is applied to the pair at its centre of mass (turning it about
 * the joined centre), then the follower put back on the leader. The leader's shadows then leave it: a keyframe
 */
export function foldClampContacts(b: BridgeCtx): void {
  const T = b.clamps;
  if (!T?.links.length) return;
  const tick = b.host.getTick();
  for (const k of T.links) {
    if (!(k.from <= tick && tick < k.until) || k.led !== tick || !k.after) continue;
    const L = b.bodies.get(k.leader), F = b.bodies.get(k.follower);
    if (!L || !F || !hasComponent(b.host.world, Player, k.leader) || !hasComponent(b.host.world, Player, k.follower)) continue;
    const a = k.after, f0 = followerPose(a, k.offset);
    const dvLx = Velocity.x[k.leader] - a.vx, dvLy = Velocity.y[k.leader] - a.vy;
    const dxL = Position.x[k.leader] - a.x, dyL = Position.y[k.leader] - a.y;
    const dvFx = Velocity.x[k.follower] - f0.vx, dvFy = Velocity.y[k.follower] - f0.vy;
    const dxF = Position.x[k.follower] - f0.x, dyF = Position.y[k.follower] - f0.y;
    if (!dvLx && !dvLy && !dxL && !dyL && !dvFx && !dvFy && !dxF && !dyF) continue;
    const j = joinDerived(L.derived, F.derived, k.offset);
    const mL = Math.max(0, L.derived.mass), mF = Math.max(0, F.derived.mass), M = mL + mF;
    if (!(M > 0)) continue;
    // (Each ship's centre from the joined one, in the world)
    const c = rot(j.cx, j.cy, a.angle), rLx = -c.x, rLy = -c.y;
    const o = rot(k.offset.ox - j.cx, k.offset.oy - j.cy, a.angle), rFx = o.x, rFy = o.y;
    const px = mL * dvLx + mF * dvFx, py = mL * dvLy + mF * dvFy;
    const I = Math.max(j.derived.inertia, j.derived.fullInertia ?? 0) || 1;
    const dw = (rLx * mL * dvLy - rLy * mL * dvLx + rFx * mF * dvFy - rFy * mF * dvFx) / I;
    const body = readBody(k.leader, L);
    body.x = a.x + (mL * dxL + mF * dxF) / M;
    body.y = a.y + (mL * dyL + mF * dyF) / M;
    body.vx = a.vx + px / M - dw * rLy;
    body.vy = a.vy + py / M + dw * rLx;
    body.angle = a.angle;
    body.angVel = a.angVel + dw;
    quantizeShipBody(body);
    writeBody(k.leader, L, body);
    const fb = readBody(k.follower, F), p = followerPose(body, k.offset);
    fb.x = p.x; fb.y = p.y; fb.vx = p.vx; fb.vy = p.vy; fb.angle = p.angle; fb.angVel = p.angVel;
    writeBody(k.follower, F, fb);
    k.after = { x: body.x, y: body.y, vx: body.vx, vy: body.vy, angle: body.angle, angVel: body.angVel };
  }
}
