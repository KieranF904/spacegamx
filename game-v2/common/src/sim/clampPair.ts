/**
 * Two ships locked by Docking Clamps fly as one rigid body (docs/design/groups-mines-docking.md 3.3; the clamps' rules:
 * ships/features/clamp/clamp.ts). The one stepper (step.ts stepShipMotion) asks the step's clamp source
 * (`SimEnv.clamp`) what a pilot's ship is this tick and flies it here:
 *
 *   lead    the steering ship: the pair, flown at the joined centre of mass on the joined structure (joinDerived), from
 *           the leader's controls; its pose (the leader's centre of mass) worked back out after the step. Its engines'
 *           power: an accounted step pays its own engines from its own stores (a solo step on a scratch body) and
 *           takes the lower of that and the follower's share where the source knows it (the server); the CTL power
 *           bits it flew with carry the pair's share, so a replica flies the pair from the leader's bits alone
 *   follow  the other ship: placed at followerPose of the leader as it ended this tick (rounded as ships are); an
 *           accounted step still pays its engines for the pair's thrust (the leader's movement keys, on a scratch body)
 *   push    the tick an undock lets go: each ship gets the push along the clamps' line, then flies alone
 *
 * Every end steps it alike from the same records (clampLink, clampBreak) and the leader's controls: no positions are
 * streamed for the follower, and nobody's input is delayed. Pure and deterministic; per-tick paths allocate nothing.
 */

import type { FlightBody, FlightControls, FlightConstants } from '../ships/flight.js';
import type { ShipDerived, ThrusterInfo } from '../ships/rebuild.js';
import { CTL_POWER_MASK, CTL_SHARE_MASK, CTL_NO_BOOST, ctlOfPower, powerOfCtl } from '../ships/flight.js';
import { stepShipPhysics, quantizeShipBody } from '../ships/physics.js';
import { followerPose, type ClampBody, type ClampOffset } from '../ships/features/clamp/clamp.js';
import { dsincos } from '../math/detTrig.js';
import type { Charge } from '../ships/energy.js';
import type { SimShipState } from './state.js';
import type { SimEnv } from './env.js';

// ---------------------------------------------------------------------------------------------- the joined structure

/** The pair's structure as the step flies it, and where its centre of mass sits from the leader's */
export interface JoinedView {
  /** The joined structure: summed mass, the parallel-axis inertia, both ships' thrusters in the leader's frame */
  readonly derived: ShipDerived;
  /** The joined centre of mass from the leader's, in the leader's frame at angle 0 (world units, as ClampOffset) */
  readonly cx: number;
  readonly cy: number;
}

/** Cached per (leader structure, follower structure, offset): a structure changes only when its ship rebuilds */
const JOINED = new WeakMap<ShipDerived, WeakMap<ShipDerived, { key: string; view: JoinedView }>>();

/** Sum of a ship's thrust (each thruster's force, unscaled): the weight of its boost */
function thrustSum(d: ShipDerived): number {
  let s = 0;
  for (const t of d.thrusters) s += Math.sqrt(t.force[0] * t.force[0] + t.force[1] * t.force[1]);
  return s;
}

/**
 * The two ships as one structure for the flight step (flight.ts reads mass, inertia, thrusters, manoeuvre force,
 * turning torque, drive, boost, radius, the jump's numbers): mass and as-built mass summed; inertia about the joined
 * centre by the parallel axis rule; both ships' thrusters in the leader's frame (the follower's turned by the offset's
 * angle), each already scaled by its own ship's drive (so the joined drive is 1); manoeuvre force and turning torque
 * summed (each by its own drive); boost weighted by thrust. No part features (no dodge while docked), the leader's
 * stores' layout (the pair's step replays its power: never accounted on this structure).
 */
export function joinDerived(lead: ShipDerived, fol: ShipDerived, o: Readonly<ClampOffset>): JoinedView {
  const key = `${o.ox},${o.oy},${o.oa}`;
  let m = JOINED.get(lead);
  if (!m) JOINED.set(lead, (m = new WeakMap()));
  const had = m.get(fol);
  if (had && had.key === key) return had.view;
  const view = buildJoined(lead, fol, o);
  m.set(fol, { key, view });
  return view;
}

function buildJoined(L: ShipDerived, F: ShipDerived, o: Readonly<ClampOffset>): JoinedView {
  const mL = Math.max(0, L.mass), mF = Math.max(0, F.mass), M = mL + mF;
  const cx = M > 0 ? (mF * o.ox) / M : 0, cy = M > 0 ? (mF * o.oy) / M : 0;
  const rL2 = cx * cx + cy * cy, fx = o.ox - cx, fy = o.oy - cy, rF2 = fx * fx + fy * fy;
  const fullL = Math.max(mL, L.fullMass ?? mL), fullF = Math.max(mF, F.fullMass ?? mF);
  const iL = L.inertia, iF = F.inertia;
  const fiL = Math.max(iL, L.fullInertia ?? iL), fiF = Math.max(iF, F.fullInertia ?? iF);
  const dL = L.drive ?? 1, dF = F.drive ?? 1;
  const tL = L.turn ?? 1, tF = F.turn ?? 1;
  const SCo: [number, number] = [0, 0];
  dsincos(o.oa, SCo);
  const s = SCo[0], c = SCo[1];
  const thrusters: ThrusterInfo[] = [];
  for (const t of L.thrusters) thrusters.push({ ...t, force: [t.force[0] * dL, t.force[1] * dL] });
  for (const t of F.thrusters) {
    const f0 = t.force[0] * dF, f1 = t.force[1] * dF;
    // (The follower's parts as the pair's: never one of the leader's indices; flight reads only their forces)
    thrusters.push({ ...t, part: -1 - t.part, force: [f0 * c - f1 * s, f0 * s + f1 * c] });
  }
  const wL = thrustSum(L), wF = thrustSum(F);
  const boostFactor = wL + wF > 0 ? (L.boostFactor * wL + F.boostFactor * wF) / (wL + wF) : L.boostFactor;
  const derived: ShipDerived = {
    ...L,
    mass: M,
    fullMass: fullL + fullF,
    inertia: iL + mL * rL2 + iF + mF * rF2,
    fullInertia: fiL + fullL * rL2 + fiF + fullF * rF2,
    drive: 1,
    turn: undefined,
    boostFactor,
    thrusters,
    maneuverForce: L.maneuverForce * dL + F.maneuverForce * dF,
    maxTorque: { cw: L.maxTorque.cw * dL * tL + F.maxTorque.cw * dF * tF, ccw: L.maxTorque.ccw * dL * tL + F.maxTorque.ccw * dF * tF },
    radius: Math.max(L.radius + Math.sqrt(rL2), F.radius + Math.sqrt(rF2)),
    fxMask: undefined,
    fxList: undefined,
    fx: undefined,
  };
  return { derived, cx, cy };
}

// ---------------------------------------------------------------------------------------------- the link records

/** A link as every end holds it: the clampLink record, and the tick its break let go (Infinity: still locked) */
export interface ClampLinkRec {
  leader: number;
  follower: number;
  /** The two clamps (blueprint uids) */
  lc: number;
  fc: number;
  offset: ClampOffset;
  /** The first tick the pair is flown as one */
  tick: number;
  /** The first tick each flies alone again */
  until: number;
  /** An undock's push on the leader on `until` (the follower's is the reverse); absent: none */
  push?: readonly [number, number];
}

/** What a ship is on tick t under the clamps (the step's clamp source) */
export type ClampAt =
  | { kind: 'lead'; joined: JoinedView; share?: number }
  | { kind: 'follow'; leader: Readonly<ClampBody>; offset: Readonly<ClampOffset>; leaderBits: number }
  | { kind: 'push'; ix: number; iy: number };

/** The step's clamp source (SimEnv.clamp): null for a ship flying alone on tick t */
export interface ClampSource {
  at(id: number, t: number): ClampAt | null;
}

/** How many ticks of ended links a client keeps (a re-step reaches back no further than the replica set's window) */
const KEEP_TICKS = 600;

/**
 * The links an end holds, by tick (a client's replica set; network/replication.ts ShipReplicaSet). A swap is a new
 * record for the same pair: the old one ends where it starts. Few at a time: plain arrays
 */
export class ClampLinks {
  private recs: ClampLinkRec[] = [];

  get size(): number { return this.recs.length; }

  /** All the records (oldest first) */
  all(): readonly ClampLinkRec[] { return this.recs; }

  /**
   * A lock (or a swap: the pair's new record). Ends any open record of either ship at its tick; returns the first tick
   * that changes
   */
  link(r: Omit<ClampLinkRec, 'until' | 'push'>): number {
    let from = r.tick;
    for (const x of this.recs) {
      if (x.until <= r.tick || x.tick > r.tick) continue;
      if (x.leader === r.leader || x.follower === r.leader || x.leader === r.follower || x.follower === r.follower) {
        x.until = r.tick;
        x.push = undefined;
      }
    }
    // (The same record again, a late joiner's copy: nothing changes)
    const same = this.recs.find((x) => x.tick === r.tick && x.leader === r.leader && x.follower === r.follower);
    if (same) { if (same.until !== Infinity || same.offset.ox !== r.offset.ox || same.offset.oy !== r.offset.oy || same.offset.oa !== r.offset.oa) { same.until = Infinity; same.offset = { ...r.offset }; } else from = Infinity; return from; }
    this.recs.push({ ...r, offset: { ...r.offset }, until: Infinity });
    this.recs.sort((a, b) => a.tick - b.tick);
    return from;
  }

  /** The pair let go on `tick` (an undock's push on the leader, if any): the record open then. Returns the first tick that changes (Infinity: none held) */
  unlink(a: number, b: number, tick: number, push?: readonly [number, number]): number {
    let from = Infinity;
    for (const x of this.recs) {
      if (!((x.leader === a && x.follower === b) || (x.leader === b && x.follower === a))) continue;
      if (x.tick >= tick) continue;
      if (x.until < tick) continue;
      from = Math.min(from, tick, x.until);
      x.until = tick;
      x.push = push ? [push[0], push[1]] : undefined;
    }
    return from;
  }

  /** The record ship `id` flies under on tick t (null: alone) */
  recAt(id: number, t: number): ClampLinkRec | null {
    const r = this.recs;
    for (let i = r.length - 1; i >= 0; i--) {
      const x = r[i];
      if (x.tick <= t && t < x.until && (x.leader === id || x.follower === id)) return x;
    }
    return null;
  }

  /** The ship it is locked to on tick t (undefined: none): the contact pass leaves the pair out */
  partner(id: number, t: number): number | undefined {
    const x = this.recAt(id, t);
    return x ? (x.leader === id ? x.follower : x.leader) : undefined;
  }

  /** An undock's push on ship `id` on tick t, if it let go then */
  pushAt(id: number, t: number): readonly [number, number] | null {
    for (const x of this.recs) {
      if (x.until !== t || !x.push) continue;
      if (x.leader === id) return x.push;
      if (x.follower === id) return [-x.push[0], -x.push[1]];
    }
    return null;
  }

  /** Ships whose path reads ship `id`'s from tick t on (a leader's follower), each with the first tick */
  readers(id: number, t: number, out: [number, number][] = []): [number, number][] {
    out.length = 0;
    for (const x of this.recs) if (x.leader === id && x.until > t) out.push([x.follower, Math.max(t, x.tick)]);
    return out;
  }

  /** Forget links that ended before tick t - KEEP_TICKS */
  prune(t: number): void {
    const cut = t - KEEP_TICKS;
    if (this.recs.some((x) => x.until < cut)) this.recs = this.recs.filter((x) => x.until >= cut);
  }

  /** Forget the links of a ship (gone) */
  forget(id: number): void {
    this.recs = this.recs.filter((x) => x.leader !== id && x.follower !== id);
  }

  clear(): void { this.recs = []; }
}

/**
 * A clamp source over a ClampLinks table: `derived` gives each ship's structure, `leaderAt` the leader's state as it
 * ended tick t (body and the control bits it flew). Allocates only for a ship under a link that tick
 */
export function linksSource(
  links: ClampLinks,
  derived: (id: number, t: number) => ShipDerived | null | undefined,
  leaderAt: (id: number, t: number) => { body: Readonly<ClampBody>; bits: number } | null,
): ClampSource {
  return {
    at(id, t) {
      if (!links.size) return null;
      const x = links.recAt(id, t);
      if (!x) {
        const p = links.pushAt(id, t);
        return p ? { kind: 'push', ix: p[0], iy: p[1] } : null;
      }
      if (x.leader === id) {
        const L = derived(x.leader, t), F = derived(x.follower, t);
        if (!L || !F) return null;
        return { kind: 'lead', joined: joinDerived(L, F, x.offset) };
      }
      const l = leaderAt(x.leader, t);
      return l ? { kind: 'follow', leader: l.body, offset: x.offset, leaderBits: l.bits } : null;
    },
  };
}

// ---------------------------------------------------------------------------------------------- the step

/** The CTL bits a replica replays: the engines' power, the features' share, a refused boost */
const REPLAY_BITS = CTL_POWER_MASK | CTL_SHARE_MASK | CTL_NO_BOOST;

/**
 * The pair's engine power as the leader's control bits carry it: the leader's own (its CTL power bits, ctlOfPower) or,
 * where the follower's share is known (`share`, on the POWER_STEPS grid), the lower of the two
 */
export function pairPowerBits(own: number, share: number | undefined): number {
  if (share === undefined || !(share < powerOfCtl(own))) return own;
  return (own & ~CTL_POWER_MASK) | ctlOfPower(share);
}

/** Has the follower's share cut the pair's power below the leader's own (the leader's own client can't know it)? */
export function pairLimited(own: number, share: number | undefined): boolean {
  return share !== undefined && share < powerOfCtl(own);
}

/** The joined body (pose and motion at the joined centre of mass), stepped in place by `run` */
const JB: FlightBody = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angVel: 0 };
const SC: [number, number] = [0, 0];

/** A leader-frame vector at the leader's angle, in the world (grid forward is -y: as clamp.ts rotate) */
function toWorld(vx: number, vy: number, angle: number, out: [number, number]): [number, number] {
  dsincos(angle + Math.PI / 2, SC);
  const s = SC[0], c = SC[1];
  out[0] = vx * c - vy * s; out[1] = vx * s + vy * c;
  return out;
}
const R: [number, number] = [0, 0];

/**
 * The pair's step on the leader's body (its centre of mass): to the joined centre, `run` steps that (the flight step on
 * the joined structure), and back to the leader's centre, rounded as ships are. The leader's jump state rides along
 * unchanged by the move (no jump while docked)
 */
export function stepPairBody(body: FlightBody, j: JoinedView, run: (jb: FlightBody) => void): void {
  toWorld(j.cx, j.cy, body.angle, R);
  const w = body.angVel;
  JB.x = body.x + R[0]; JB.y = body.y + R[1];
  JB.vx = body.vx - w * R[1]; JB.vy = body.vy + w * R[0];
  JB.angle = body.angle; JB.angVel = w;
  JB.jump = body.jump; JB.jumpScale = body.jumpScale; JB.jumpAim = body.jumpAim; JB.jumpTo = body.jumpTo;
  JB.cargo = body.cargo; JB.dodge = undefined; JB.dodgeDir = undefined;
  run(JB);
  toWorld(j.cx, j.cy, JB.angle, R);
  const w2 = JB.angVel;
  body.x = JB.x - R[0]; body.y = JB.y - R[1];
  body.vx = JB.vx + w2 * R[1]; body.vy = JB.vy - w2 * R[0];
  body.angle = JB.angle; body.angVel = w2;
  body.jump = JB.jump; body.jumpScale = JB.jumpScale; body.jumpAim = JB.jumpAim; body.jumpTo = JB.jumpTo;
  quantizeShipBody(body);
}

/** The follower placed on the leader (followerPose, rounded as ships are); the rest of its body (jump, cargo) as it was */
export function placeFollower(body: FlightBody, leader: Readonly<ClampBody>, o: Readonly<ClampOffset>): void {
  followerPose(leader, o, FP);
  body.x = FP.x; body.y = FP.y; body.vx = FP.vx; body.vy = FP.vy; body.angle = FP.angle; body.angVel = FP.angVel;
}
const FP: ClampBody = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angVel: 0 };

/** (stepClamped's scratch: a body for a solo step that only pays the engines) */
const SCRATCH: FlightBody = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angVel: 0 };
function scratchOf(b: FlightBody): FlightBody {
  SCRATCH.x = b.x; SCRATCH.y = b.y; SCRATCH.vx = b.vx; SCRATCH.vy = b.vy; SCRATCH.angle = b.angle; SCRATCH.angVel = b.angVel;
  SCRATCH.jump = b.jump; SCRATCH.jumpScale = b.jumpScale; SCRATCH.jumpAim = b.jumpAim; SCRATCH.jumpTo = b.jumpTo;
  SCRATCH.cargo = b.cargo; SCRATCH.dodge = b.dodge; SCRATCH.dodgeDir = b.dodgeDir;
  return SCRATCH;
}

/** The follower's controls for paying its engines: the leader's movement keys (CTL bits), its own aim */
const FOLLOW_CTL: FlightControls = { forward: false, backward: false, left: false, right: false, boost: false, targetAngle: 0 };
function followControls(bits: number, own: FlightControls): FlightControls {
  const c = FOLLOW_CTL;
  c.forward = (bits & 1) !== 0; c.backward = (bits & 2) !== 0; c.left = (bits & 4) !== 0; c.right = (bits & 8) !== 0;
  c.boost = (bits & 16) !== 0; c.helm = (bits & 32) !== 0; c.strafeLeft = (bits & 64) !== 0; c.strafeRight = (bits & 128) !== 0;
  c.jump = false; c.targetAngle = own.targetAngle; c.heldAngle = undefined;
  return c;
}

/**
 * The last accounted leader step's own engine bits (its CTL power before the follower's share was taken): the server
 * tells by it whether the pair flew below the leader's own share (bridge/clamp.ts), which the leader's own client can't know
 */
export const clampStepInfo = { own: 0 };

/** What stepClamped reports (step.ts MotionOut's fields) */
export interface ClampMotionOut { ctlPower: number; isBoosting: boolean; aimHeld: boolean }

/**
 * A pilot's motion this tick under a link (step.ts stepShipMotion, inside the charging fields' wrap): `c` from the
 * clamp source (a 'push' is the caller's impulse, not this), `energy` the step's (an accounted one pays from
 * `s.charge`), `bits` the input's (a replica's power bits are the authority's)
 */
export function stepClamped(
  c: Exclude<ClampAt, { kind: 'push' }>, s: SimShipState, controls: FlightControls, accounted: boolean,
  energy: { charge: Charge; drainRate: number; load?: ArrayLike<number>; tick?: number; replay?: number },
  bits: number, env: Readonly<SimEnv>, rangeBoost: number, hazard: FlightConstants['hazard'], out: ClampMotionOut,
): void {
  const d = s.structure.derived, body = s.body;
  if (c.kind === 'lead') {
    let replay = bits & REPLAY_BITS;
    if (accounted) {
      // (Its own engines, paid from its own stores, as a solo step would: the pair's share is the lower of its and the follower's)
      const r = stepShipPhysics(scratchOf(body), controls, d, env.tuning, energy, env.gravity, rangeBoost, hazard, env.terrain);
      s.charge = r.charge;
      clampStepInfo.own = r.ctlPower;
      replay = pairPowerBits(r.ctlPower, c.share);
    }
    let boosting = false, held = true;
    stepPairBody(body, c.joined, (jb) => {
      const r = stepShipPhysics(jb, controls, c.joined.derived, env.tuning, { charge: energy.charge, drainRate: 0, replay }, env.gravity, rangeBoost, hazard, env.terrain);
      boosting = r.isBoosting; held = r.aimHeld;
    });
    out.ctlPower = replay; out.isBoosting = boosting; out.aimHeld = held;
    return;
  }
  // The follower: its engines pay for the pair's thrust (the leader's keys); it sits where the leader puts it
  if (accounted) {
    const r = stepShipPhysics(scratchOf(body), followControls(c.leaderBits, controls), d, env.tuning, energy, env.gravity, rangeBoost, hazard, env.terrain);
    s.charge = r.charge;
    out.ctlPower = r.ctlPower;
  } else out.ctlPower = bits & REPLAY_BITS;
  placeFollower(body, c.leader, c.offset);
  out.isBoosting = false;
  out.aimHeld = true;
}
