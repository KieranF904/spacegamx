/**
 * Scheduled waypoints (docs/design/awareness-model.md 6.3): the steering law a homing shell flies by, the same on the
 * server and on every client's tick-aligned layer (CAPS.WAYPOINTS).
 *
 * A missile flies at a waypoint (a point on the 4-unit grid, and the tick the next one takes over). The planner makes
 * waypoints from the target's state at a plan tick, and only then:
 *
 *   first   no waypoint yet (its first tick with a target): one from now, for `spacing` ticks
 *   swerve  every SWERVE_EVERY ticks (staggered by its id) the point is planned again; if it moved further than
 *           max(64, 0.15 × the distance left to it), the new one replaces it at once (and the queued one goes)
 *   queue   the next waypoint is planned `lead` ticks before the current one ends (16, or half a short one), so it is
 *           known that far ahead and flight carries on through with no gap
 *
 * `spacing` follows the ticks to the target (distance / speed): 48 far out, down to 4 in the last 20 ticks.
 *
 * Each tick (guideTick): the queue moves on, the planner runs, then the steer: turn toward the point (at most `turn`
 * radians), speed up by `accel` to `max`, the velocity on the 1/256 grid. The caller moves it (x += vx, y += vy), so a
 * missile's state stays on that grid and goes on the wire exactly.
 *
 * Two flights (GuideKind.flight): a missile's (above), and a mob's (a mite, a drone, a kamikaze: FLIGHT_MOB). A mob coasts
 * out of its bay until `arm`, then points (turn-limited) at its waypoint and thrusts along where it points, sideways
 * drift bleeding away, to its top speed; its heading is part of its state (on the 1/65536 grid). Its spacing is
 * shorter (32 down to 4) and its lead capped at 18 ticks, as its old per-tick law's.
 *
 * Who plans: the server always. A client holding the missile and its target plans the same way from its own replica of
 * the target ("derived": nothing on the wire); one lacking the target takes the server's waypoints as records instead
 * ("sent": records.ts). Either way the same waypoints come out, so a switch between them changes nothing.
 */
import { datan2, dcos, dhypot, dsin } from '../math/detTrig.js';

/** A missile's state grid (1/256 world unit: dyadic, so x += vx stays exact) */
export const GUIDE_Q = 256;
/** Its kind's turn and acceleration grid (1/65536) */
export const GUIDE_KQ = 65536;
/** Waypoints sit on this grid (world units) */
export const WP_GRID = 4;
/** The queue's lead (ticks): the next waypoint is planned this long before the current one ends, at most */
export const WP_LEAD = 16;
/** Ticks between swerve checks */
export const SWERVE_EVERY = 4;
/** The flights: a missile's, a mob's */
export const FLIGHT_MISSILE = 0, FLIGHT_MOB = 1;
/** The longest the lead looks ahead at the target, in ticks, by flight (the old per-tick laws' caps) */
const LEAD_CAP = [30, 18];
/** A mob's sideways drift kept a tick, and its coast out of the bay */
const MOB_SIDE = 0.86, MOB_COAST = 0.98;

export const qGuide = (v: number): number => Math.round(v * GUIDE_Q) / GUIDE_Q;
export const qKind = (v: number): number => Math.round(v * GUIDE_KQ) / GUIDE_KQ;
/** A heading on its grid (1/65536 radian) */
export const qAngle = qKind;

export interface Waypoint { x: number; y: number; start: number; until: number }

/**
 * Its flight: which (FLIGHT_*), turn (radians a tick), acceleration and top speed on their grids (guideKind), and the
 * tick it starts steering (a mob coasts out of its bay until then; 0: at once)
 */
export interface GuideKind { flight: number; turn: number; accel: number; max: number; arm: number }

/** A missile's guidance state: its target (-1: none, it flies straight on), the waypoint it flies at and the queued one */
export interface Guide { target: number; w: Waypoint | null; n: Waypoint | null; kind: GuideKind }

/** A missile's (or its target's) motion; a mob's heading too (`a`) */
export interface GuideBody { x: number; y: number; vx: number; vy: number; a?: number }

/** What the planner did this tick (records.ts GUIDE.WP / GUIDE.NEXT), or none */
export const PLAN_NONE = 0, PLAN_WP = 1, PLAN_NEXT = 2;

export function guideKind(turn: number, accel: number, max: number, flight = FLIGHT_MISSILE, arm = 0): GuideKind {
  return { flight, turn: qKind(turn), accel: qKind(accel), max: Math.round(max * GUIDE_Q) / GUIDE_Q, arm };
}

export function newGuide(target: number, kind: GuideKind): Guide {
  return { target, w: null, n: null, kind };
}

export function cloneGuide(g: Guide): Guide {
  return { target: g.target, w: g.w && { ...g.w }, n: g.n && { ...g.n }, kind: g.kind };
}

/** Ticks between waypoints for τ ticks to the target (a mob's half a missile's, down to 4) */
export function spacing(tau: number, flight = FLIGHT_MISSILE): number {
  const L = tau > 240 ? 48 : tau >= 120 ? 32 : tau >= 48 ? 16 : tau >= 20 ? 8 : 4;
  return flight === FLIGHT_MOB ? (L === 48 ? 32 : Math.max(4, L >> 1)) : L;
}

/** How long before a waypoint ends the next one is planned */
export function leadOf(w: Waypoint): number {
  return Math.min(WP_LEAD, Math.max(1, (w.until - w.start) >> 1));
}

/** The speed it reckons the time to its target by: a missile's own, a mob's top speed (its old law's) */
const speedOf = (m: GuideBody, k: GuideKind) => (k.flight === FLIGHT_MOB ? Math.max(4, k.max) : Math.max(1, dhypot(m.vx, m.vy)));

/** Ticks to the target */
export function ticksTo(m: GuideBody, tg: GuideBody, k: GuideKind): number {
  return dhypot(tg.x - m.x, tg.y - m.y) / speedOf(m, k);
}

/** Where to aim, `ahead` ticks from now: the target carried on by that plus the time to reach it (capped), on the grid */
export function aimPoint(m: GuideBody, tg: GuideBody, ahead: number, kd: GuideKind): { x: number; y: number } {
  const k = ahead + Math.min(LEAD_CAP[kd.flight] ?? 30, ticksTo(m, tg, kd));
  return { x: Math.round((tg.x + tg.vx * k) / WP_GRID) * WP_GRID, y: Math.round((tg.y + tg.vy * k) / WP_GRID) * WP_GRID };
}

/** The queue moves on: the next waypoint takes over at its start */
export function guideAdvance(g: Guide, t: number): void {
  if (g.n && t >= g.n.start) { g.w = g.n; g.n = null; }
}

/** The target is gone: it flies straight on from here */
export function guideLost(g: Guide): void {
  g.target = -1;
  g.w = g.n = null;
}

/** A new target (a mob's brain chose it; -1: none): planned afresh from it */
export function guideRetarget(g: Guide, target: number): void {
  g.target = target;
  g.w = g.n = null;
}

/** The planner at tick t, from the target's state then (null: not known, nothing planned). PLAN_*: what it did */
export function guidePlan(g: Guide, id: number, m: GuideBody, tg: GuideBody | null, t: number): number {
  const k = g.kind;
  if (g.target < 0 || !tg || t < k.arm) return PLAN_NONE;
  const w = g.w;
  if (!w) {
    g.w = { ...aimPoint(m, tg, 0, k), start: t, until: t + spacing(ticksTo(m, tg, k), k.flight) };
    g.n = null;
    return PLAN_WP;
  }
  if ((t + id) % SWERVE_EVERY === 0) {
    const p = aimPoint(m, tg, 0, k);
    const off = dhypot(p.x - w.x, p.y - w.y), left = dhypot(w.x - m.x, w.y - m.y);
    if (off > Math.max(64, 0.15 * left)) {
      g.w = { ...p, start: t, until: t + spacing(ticksTo(m, tg, k), k.flight) };
      g.n = null;
      return PLAN_WP;
    }
  }
  if (!g.n && t >= w.until - leadOf(w)) {
    const ahead = w.until - t;
    g.n = { ...aimPoint(m, tg, ahead, k), start: w.until, until: w.until + spacing(Math.max(0, ticksTo(m, tg, k) - ahead), k.flight) };
    return PLAN_NEXT;
  }
  return PLAN_NONE;
}

/** The turn toward its waypoint from heading `ang` (0: none, or within `reach` of it) */
function turnTo(g: Guide, m: GuideBody, ang: number, reach: number): number {
  const w = g.w;
  if (!w) return 0;
  const dx = w.x - m.x, dy = w.y - m.y;
  if (dx * dx + dy * dy <= reach * reach) return 0;
  let d = datan2(dy, dx) - ang;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return Math.max(-g.kind.turn, Math.min(g.kind.turn, d));
}

/** A mob's steer at tick t: out of its bay it coasts; then it points at its waypoint and thrusts along its heading */
function mobSteer(g: Guide, m: GuideBody, t: number): void {
  const k = g.kind;
  let vx = m.vx, vy = m.vy, ang = m.a ?? 0;
  if (t < k.arm) { vx *= MOB_COAST; vy *= MOB_COAST; }
  else {
    ang += turnTo(g, m, ang, 0);
    const fx = dcos(ang), fy = dsin(ang);
    vx += fx * k.accel; vy += fy * k.accel;
    // (it flies where it points: sideways drift bleeds away fast)
    const along = vx * fx + vy * fy;
    vx = fx * along + (vx - fx * along) * MOB_SIDE; vy = fy * along + (vy - fy * along) * MOB_SIDE;
    const sp = dhypot(vx, vy);
    if (sp > k.max) { vx *= k.max / sp; vy *= k.max / sp; }
  }
  m.vx = qGuide(vx); m.vy = qGuide(vy); m.a = qAngle(ang);
}

/** The steer at tick t: velocity (and a mob's heading) toward its waypoint, written into m; the caller moves it */
export function guideSteer(g: Guide, m: GuideBody, t: number): void {
  const k = g.kind;
  if (k.flight === FLIGHT_MOB) { mobSteer(g, m, t); return; }
  const sp = dhypot(m.vx, m.vy) || 1;
  const nsp = Math.min(k.max, sp + k.accel);
  const head = datan2(m.vy, m.vx), ang = head + turnTo(g, m, head, nsp);
  m.vx = qGuide(dcos(ang) * nsp);
  m.vy = qGuide(dsin(ang) * nsp);
}

/** One tick of guidance where the planner runs here (the server; a client holding the target): PLAN_* it did */
export function guideTick(g: Guide, id: number, m: GuideBody, tg: GuideBody | null, t: number): number {
  guideAdvance(g, t);
  const did = guidePlan(g, id, m, tg, t);
  guideSteer(g, m, t);
  return did;
}
