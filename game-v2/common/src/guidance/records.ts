/**
 * Scheduled waypoints on the wire (CAPS.WAYPOINTS; waypoints.ts, docs/design/awareness-model.md 6.3). A snapshot's
 * `guides` rows are [id, dt, op, ...args], dt the record's tick less the snapshot's (0 or less), args whole numbers:
 *
 *   SYNC  [x, y, vx, vy, turn, accel, max, target + 1, flags, (w: wx, wy, start, until), (n: ...), (mob: a, arm)]: a
 *         shell (or mob) it runs from here, as it ended the snapshot's tick (state × 256, turn and accel × 65536, max ×
 *         256, waypoints by their grid, ticks less the snapshot's; a mob's heading × 65536; flags 1 w, 2 n, 4 sent, 8 mob)
 *   WP    [dx, dy, L]: a new waypoint, from now for L ticks (a first one, or a swerve), its point in grid steps from
 *         the missile's as the tick began (rounded to the grid); the queued one goes
 *   NEXT  [dx, dy, L]: the next waypoint, from when the current one ends
 *   LOST  []: its target is gone: it flies straight on
 *   MODE  [sent]: from this tick it takes the server's WP and NEXT (1: it lacks the target), or plans them itself (0)
 *   OFF   []: it stops running it (out of range: rows again)
 *   TARGET [target + 1]: a mob's brain chose a new target (0: none): planned afresh from it
 *   LAUNCH [...]: a volley of mobs laid at once, each one's run from it in place of its SYNC (launch.ts; CAPS.LAUNCHES)
 *
 * WP and NEXT go only to a client in "sent" mode for that tick; the rest to every client running it.
 */
import { replicaHash } from '../network/causes.js';
import {
  FLIGHT_MISSILE, FLIGHT_MOB, GUIDE_KQ, GUIDE_Q, WP_GRID, guideLost, guideKind, guideRetarget, newGuide, type Guide, type GuideBody, type Waypoint,
} from './waypoints.js';

export const GUIDE = { SYNC: 0, WP: 1, NEXT: 2, LOST: 3, MODE: 4, OFF: 5, TARGET: 6, LAUNCH: 7 } as const;
/** Ops there are (a row whose op is past this is dropped) */
export const GUIDE_OPS = 8;
/** A missile's mode for a tick: it plans its waypoints itself, or takes the server's */
export const MODE_DERIVED = 0, MODE_SENT = 1;

const g4 = (v: number, from: number) => Math.round(v / WP_GRID) - Math.round(from / WP_GRID);

/** A WP or NEXT record's args for a waypoint planned when the missile was at m */
export function wpArgs(w: Waypoint, m: GuideBody): number[] {
  return [g4(w.x, m.x), g4(w.y, m.y), w.until - w.start];
}

/** Records every client running it takes at their tick, before the queue moves on: LOST and TARGET */
export const guideFirst = (op: number): boolean => op === GUIDE.LOST || op === GUIDE.TARGET;

/** A record folded into the guide at tick t, the shell at m as the tick began (WP and NEXT after guideAdvance) */
export function applyGuideRec(g: Guide, op: number, args: readonly number[], m: GuideBody, t: number): void {
  if (op === GUIDE.LOST) { guideLost(g); return; }
  if (op === GUIDE.TARGET) { guideRetarget(g, (args[0] ?? 0) - 1); return; }
  if (op !== GUIDE.WP && op !== GUIDE.NEXT) return;
  const x = (args[0] + Math.round(m.x / WP_GRID)) * WP_GRID, y = (args[1] + Math.round(m.y / WP_GRID)) * WP_GRID, L = Math.max(1, args[2] ?? 1);
  if (op === GUIDE.WP) { g.w = { x, y, start: t, until: t + L }; g.n = null; return; }
  if (!g.w) return;
  g.n = { x, y, start: g.w.until, until: g.w.until + L };
}

const wpSync = (w: Waypoint, tick: number) => [w.x / WP_GRID, w.y / WP_GRID, w.start - tick, w.until - tick];

/** A SYNC's args: the missile as it ended tick `tick`, its guide, and its mode */
export function guideSyncArgs(m: GuideBody, g: Guide, sent: boolean, tick: number): number[] {
  const k = g.kind;
  const out = [Math.round(m.x * GUIDE_Q), Math.round(m.y * GUIDE_Q), Math.round(m.vx * GUIDE_Q), Math.round(m.vy * GUIDE_Q),
    Math.round(k.turn * GUIDE_KQ), Math.round(k.accel * GUIDE_KQ), Math.round(k.max * GUIDE_Q), g.target + 1,
    (g.w ? 1 : 0) | (g.n ? 2 : 0) | (sent ? 4 : 0) | (k.flight === FLIGHT_MOB ? 8 : 0)];
  if (g.w) out.push(...wpSync(g.w, tick));
  if (g.n) out.push(...wpSync(g.n, tick));
  if (k.flight === FLIGHT_MOB) out.push(Math.round((m.a ?? 0) * GUIDE_KQ), k.arm - tick);
  return out;
}

/** What a SYNC says, for tick `tick` */
export function guideOfSync(a: readonly number[], tick: number): { m: GuideBody; g: Guide; sent: boolean } {
  const m: GuideBody = { x: a[0] / GUIDE_Q, y: a[1] / GUIDE_Q, vx: a[2] / GUIDE_Q, vy: a[3] / GUIDE_Q };
  const f = a[8] ?? 0, mob = (f & 8) !== 0;
  let i = 9;
  const wp = (): Waypoint => { const w = { x: a[i] * WP_GRID, y: a[i + 1] * WP_GRID, start: a[i + 2] + tick, until: a[i + 3] + tick }; i += 4; return w; };
  const w = f & 1 ? wp() : null, n = f & 2 ? wp() : null;
  if (mob) m.a = a[i] / GUIDE_KQ;
  const g = newGuide(a[7] - 1, guideKind(a[4] / GUIDE_KQ, a[5] / GUIDE_KQ, a[6] / GUIDE_Q, mob ? FLIGHT_MOB : FLIGHT_MISSILE, mob ? a[i + 1] + tick : 0));
  g.w = w; g.n = n;
  return { m, g, sent: (f & 4) !== 0 };
}

/** Is this a row the guides can take ([id, dt, op, ...args], whole numbers, a known op)? */
export function guideRowOk(row: unknown): row is number[] {
  if (!Array.isArray(row) || row.length < 3 || row.length > 24) return false;
  for (const v of row) if (typeof v !== 'number' || !Number.isInteger(v)) return false;
  return row[0] >= 0 && row[1] <= 0 && row[2] >= 0 && row[2] < GUIDE_OPS;
}

/** One running missile's share of the check (its client's own check adds the sum: network/causes.ts replicasByte) */
export function guideHash(id: number, m: GuideBody): number {
  return replicaHash(id ^ 0x40000000, { x: m.x, y: m.y, vx: m.vx, vy: m.vy, angle: m.a ?? 0 });
}
