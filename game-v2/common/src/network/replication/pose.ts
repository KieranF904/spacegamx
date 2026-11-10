/**
 * @contract network.replication.pose
 * owns:       where a replicated ship is drawn between ticks: the lerp between stepped states, the way in before its
 *             first state, and the keyframe corrections and re-stepped paths bent in or eased out (drawing only)
 * needs:      network/replication/rep (Rep, Fix), wire (Keyframe, replicaAngle), hooks (Step), sim/ring, math/detTrig
 * invariants: a keyframe off the drawn path bends it on with no jump ahead and no step; a teleport snaps; a re-stepped
 *             path eases out — common/src/network/replicaSmoothing.test.ts
 *             drawing never changes a stepped state (`at` stays exact) — common/src/network/replicaSmoothing.test.ts
 * extend:     a new kind of correction is a Fix pushed on the Rep; its weight over time is fixWeight
 */

import { ReplicaMode } from '../../ships/index.js';
import type { StateRing } from '../../sim/ring.js';
import type { ReplicaState } from '../../sim/c-replicaState.js';
import { dhypot } from '../../math/detTrig.js';
import { wrapPi } from '../../math/basic.js';
import type { Rep } from './rep.js';
import type { Step } from './hooks.js';
import { replicaAngle, type Keyframe } from './wire.js';

/** A keyframe's correction is bent in over up to this many ticks before it (drawing only: `at` is always exact) */
export const BEND_TICKS = 8;
/** ...or, when it came too late for that, eased out over this many after */
export const SMOOTH_TICKS = 8;
/** Corrections this big or more (a teleport, a blink, the jump drive) snap */
export const SMOOTH_MAX = 400;
/** The old path is stepped up to a keyframe's tick only if it's this close (ticks) */
export const GAP_MAX = 60;
/** A ship drawn before its first state is drawn back along its way from it by at most this many ticks */
export const BACK_TICKS = 20;

const smoothstep = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));

/** An angle difference into (-pi, pi]: the one shared wrap, math/basic.ts wrapPi (the same loop for every angle the sim feeds it, never hangs) */
export const wrapAngle = wrapPi;

/** How much of a correction is added to the drawn pose at tick t (drawn = stepped path + d × this) */
export function fixWeight(f: { t: number; s: number }, t: number): number {
  // Between the tick before the keyframe and the keyframe, the stepped path runs from the old path into the new
  // one (pose's lerp): k of the correction comes in with it
  const k = Math.max(0, Math.min(1, t - (f.t - 1)));
  if (f.s < f.t - 1) return t >= f.t ? 0 : k - smoothstep((t - f.s) / (f.t - f.s));
  return t < f.t ? k : 1 - smoothstep((t - f.t) / SMOOTH_TICKS);
}

/** A ship's pose at a fractional tick, unbent, and the later of the two states it lies between */
export interface RawPose { x: number; y: number; angle: number; b: Step }

/** What pose gives: where it's drawn and what it flew */
export interface DrawnPose { x: number; y: number; angle: number; vx: number; vy: number; jump: number; jumpScale: number; dodge: number; dodgeDir: number; aim: number; bits: number }

/**
 * Before its first state (a ship just come into view, or back into it): drawn coming in along its way, back from that
 * state, not standing at it until the view reaches its tick (it stood there, then went on: a snap and a stall). Not
 * debris (nothing before it split), a docked ship or one mid-jump; at most BACK_TICKS back. Null: not that case
 */
export function poseComingIn(r: Rep | undefined, ring: StateRing, id: number, t: number): RawPose | null {
  const f = Math.floor(t);
  if (r && ring.size(id) && !ring.has(id, f) && r.mode !== ReplicaMode.Drift && r.mode !== ReplicaMode.Docked) {
    const first = ring.first(id)!;
    const s = first > f ? ring.get(id, first)! : null;
    if (s && !s.body.jump) {
      const back = Math.min(BACK_TICKS, first - t);
      return { x: s.body.x - s.body.vx * back, y: s.body.y - s.body.vy * back, angle: s.body.angle - s.body.angVel * back, b: s as ReplicaState };
    }
  }
  return null;
}

/** Between the states at whole ticks f (`a`) and f + 1 (`b`), at fractional tick t */
export function poseBetween(a: Step, b: Step, t: number, f: number): RawPose {
  const k = Math.max(0, Math.min(1, t - f));
  const da = wrapAngle(b.body.angle - a.body.angle);
  return { x: a.body.x + (b.body.x - a.body.x) * k, y: a.body.y + (b.body.y - a.body.y) * k, angle: a.body.angle + da * k, b };
}

/**
 * The drawn pose from the raw one: its path stepped again where it was drawn already eases out (a new Fix), and every
 * correction still under way is blended in (fixWeight). `rawAt` is the raw pose at another tick
 */
export function bendPose(rep: Rep, raw: RawPose, t: number, rawAt: (t: number) => RawPose | null): DrawnPose {
  const { b } = raw;
  const mode = rep.mode;
  // (Its path stepped again where it was drawn already (a control row, a decision, a cause for a tick it had run
  // ahead to): the change eases out from where it was drawn, as a late keyframe's does, instead of a jump)
  if (rep.moved && rep.raw && rep.raw.t <= t) {
    const now = rawAt(rep.raw.t);
    if (now) {
      const dx = rep.raw.x - now.x, dy = rep.raw.y - now.y, da = wrapAngle(rep.raw.angle - now.angle);
      if ((dx || dy || da) && dhypot(dx, dy) < SMOOTH_MAX) (rep.fixes ??= []).push({ t: rep.raw.t, s: rep.raw.t, dx, dy, da });
    }
  }
  rep.moved = false;
  rep.raw = { t, x: raw.x, y: raw.y, angle: raw.angle };
  let { x, y, angle } = raw;
  rep.drawn = t;
  if (rep.fixes) {
    let n = 0;
    for (const fix of rep.fixes) {
      // (Done with once the view is past it: bent in by its tick, or eased out after)
      if (t >= fix.t + (fix.s < fix.t - 1 ? 0 : SMOOTH_TICKS)) continue;
      rep.fixes[n++] = fix;
      const w = fixWeight(fix, t);
      x += fix.dx * w; y += fix.dy * w; angle += fix.da * w;
    }
    rep.fixes.length = n;
    if (!n) rep.fixes = undefined;
  }
  return {
    x, y, angle,
    vx: b.body.vx, vy: b.body.vy, jump: b.body.jump ?? 0, jumpScale: b.body.jumpScale ?? 1, dodge: b.body.dodge ?? 0, dodgeDir: b.body.dodgeDir ?? 0, aim: replicaAngle(mode, b.q), bits: b.bits,
  };
}

/** A path rewritten from a keyframe's tick on: corrections at or after it go with it */
export function dropFixesFrom(r: Rep, tick: number): void {
  if (r.fixes) { r.fixes = r.fixes.filter((f) => f.t < tick); if (!r.fixes.length) r.fixes = undefined; }
}

/**
 * How far the path it was drawn on (`was`, at the keyframe's tick) was off the keyframe, kept for pose to bend in or
 * ease out; a teleport's (SMOOTH_MAX or more) drops them all: it snaps
 */
export function noteKeyframeFix(r: Rep, tick: number, was: Step, k: Keyframe): void {
  const dx = was.body.x - k.body.x, dy = was.body.y - k.body.y;
  const da = wrapAngle(was.body.angle - k.body.angle);
  if (dhypot(dx, dy) >= SMOOTH_MAX) { r.fixes = undefined; return; }
  if ((!dx && !dy && !da) || r.drawn === undefined) return;
  (r.fixes ??= []).push({ t: tick, s: Math.max(r.drawn, tick - BEND_TICKS), dx, dy, da });
}
