/** Cursor distance on the wire (a leaf, so sim/d-sources.ts need not import protocol.ts; protocol.ts re-exports it) */

/** Cursor distance is sent in steps of this many world units, up to CURSOR_DIST_MAX */
export const CURSOR_DIST_STEP = 4;
export const CURSOR_DIST_MAX = 200000; // far enough to aim a jump (16 bits at 4-unit steps)

export function quantizeCursorDist(d: number): number {
  return Math.round(Math.max(0, Math.min(CURSOR_DIST_MAX, d)) / CURSOR_DIST_STEP);
}
