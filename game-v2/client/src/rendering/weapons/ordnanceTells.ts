/**
 * The maths behind ordnance tells (landing rings, the sonar that quickens, the Leviathan warning). Pure, and writes into
 * the objects it is given, so a frame allocates nothing.
 */

/** A shell that ends at a chosen point: where it lands (spawn + velocity × the ticks it flies), written into `out` */
export function landingPoint(spawnX: number, spawnY: number, vx: number, vy: number, spawnTick: number, endTick: number, out: { x: number; y: number }): void {
  const flight = Math.max(0, endTick - spawnTick);
  out.x = spawnX + vx * flight;
  out.y = spawnY + vy * flight;
}

/** How far through its flight a shell is, 0 at the muzzle to 1 at its end (0 when it has no end) */
export function arcFraction(tick: number, spawnTick: number, endTick: number): number {
  if (!(endTick > spawnTick)) return 0;
  return Math.max(0, Math.min(1, (tick - spawnTick) / (endTick - spawnTick)));
}

/** A sonar ring's period at `dist` from what it hunts: the base far away, down to 0.3 × it at touching (closing: the distance it starts quickening) */
export function sonarPeriod(base: number, dist: number, closing: number): number {
  if (!(closing > 0)) return base;
  return base * (0.3 + 0.7 * Math.max(0, Math.min(1, dist / closing)));
}

/**
 * Is a shell flying from (sx, sy) at (vx, vy) per tick heading at the point (tx, ty)? Its closest approach, worked out from
 * its velocity: the ticks until it, if it is still approaching, passes within `radius` and is within `horizon` ticks, else -1.
 */
export function incomingTicks(tx: number, ty: number, sx: number, sy: number, vx: number, vy: number, radius: number, horizon: number): number {
  const v2 = vx * vx + vy * vy;
  if (v2 < 1e-6) return -1;
  const rx = tx - sx, ry = ty - sy;
  const t = (rx * vx + ry * vy) / v2;
  if (t < 0 || t > horizon) return -1;
  const mx = rx - vx * t, my = ry - vy * t;
  return mx * mx + my * my <= radius * radius ? t : -1;
}

/**
 * Where the ray from the middle of a w × h screen toward (dx, dy) leaves it, `inset` inside the edge (written into `out`).
 * Returns false when the direction is nothing.
 */
export function edgePoint(dx: number, dy: number, w: number, h: number, inset: number, out: { x: number; y: number }): boolean {
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return false;
  const hx = w / 2 - inset, hy = h / 2 - inset;
  const k = Math.min(Math.abs(dx) > 1e-9 ? hx / Math.abs(dx) : Infinity, Math.abs(dy) > 1e-9 ? hy / Math.abs(dy) : Infinity);
  out.x = w / 2 + dx * k;
  out.y = h / 2 + dy * k;
  return true;
}
