/**
 * The camera's roll. In helm mode the view turns so the ship's nose points up
 * the screen; otherwise it eases back to north-up. The world is drawn turned
 * by -angle, so anything that should stay upright on screen (name tags,
 * damage numbers, labels) turns by +angle in world space.
 */

/** Live roll of the camera (radians); written by the Renderer once a frame */
export const cameraView = { angle: 0 };

/** Helm: how fast the view swings onto the ship's heading (1/s: 63% of the gap closed in 1/rate s) */
export const HELM_FOLLOW_RATE = 3;
/** Out of helm: how fast it eases back to north-up */
export const NORTH_RETURN_RATE = 2.2;
/** The view never spins faster than this (rad/s), so a big swing is a gentle turn, not a whip */
export const MAX_VIEW_SPIN = 2.4;

const TAU = Math.PI * 2;

/** An angle in [-π, π) */
export function wrapAngle(a: number): number {
  return ((((a + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
}

/** Exponential approach to `target` the short way round, the same at any frame rate; its step capped at `maxSpeed`·dt */
export function smoothAngle(current: number, target: number, rate: number, dt: number, maxSpeed = Infinity): number {
  if (dt <= 0) return current;
  const gap = wrapAngle(target - current);
  let step = gap * (1 - Math.exp(-rate * dt));
  const cap = maxSpeed * dt;
  if (Math.abs(step) > cap) step = Math.sign(step) * cap;
  // (Kept within one turn, so it never winds up)
  return wrapAngle(current + step);
}

/** The roll that puts a ship's nose up the screen (an entity's angle points its nose along +x; up is -y) */
export function noseUpAngle(shipAngle: number): number {
  return wrapAngle(shipAngle + Math.PI / 2);
}

export interface CameraPose { x: number; y: number; zoom: number; angle: number }

/** A screen-aligned offset (pixels or world units) as a world-aligned one */
export function screenToWorldDir(x: number, y: number, angle: number): { x: number; y: number } {
  const c = Math.cos(angle), s = Math.sin(angle);
  return { x: c * x - s * y, y: s * x + c * y };
}

/** A world-aligned offset as a screen-aligned one */
export function worldToScreenDir(x: number, y: number, angle: number): { x: number; y: number } {
  return screenToWorldDir(x, y, -angle);
}

/** The world point under a screen point (the camera's point at the screen's centre) */
export function screenToWorld(sx: number, sy: number, cam: CameraPose, w: number, h: number): { x: number; y: number } {
  const d = screenToWorldDir((sx - w / 2) / cam.zoom, (sy - h / 2) / cam.zoom, cam.angle);
  return { x: cam.x + d.x, y: cam.y + d.y };
}

export function worldToScreen(wx: number, wy: number, cam: CameraPose, w: number, h: number): { x: number; y: number } {
  const d = worldToScreenDir(wx - cam.x, wy - cam.y, cam.angle);
  return { x: w / 2 + d.x * cam.zoom, y: h / 2 + d.y * cam.zoom };
}

/** Half-size (world units) of the axis-aligned box round the turned view */
export function viewHalfExtents(w: number, h: number, zoom: number, angle: number): { hw: number; hh: number } {
  const c = Math.abs(Math.cos(angle)), s = Math.abs(Math.sin(angle));
  const hw = w / 2 / zoom, hh = h / 2 / zoom;
  return { hw: c * hw + s * hh, hh: s * hw + c * hh };
}

const BELOW = new WeakMap<object, number>();

/**
 * A label placed `y` below its parent's origin (as made): kept that far below
 * it along the screen, and upright, however the view is turned. `parentRot`:
 * its parent's own turn in the world, if any.
 */
export function keepUpright(o: { x: number; y: number; rotation: number }, parentRot = 0): void {
  let d = BELOW.get(o);
  if (d === undefined) BELOW.set(o, (d = o.y));
  const a = cameraView.angle - parentRot;
  o.x = -Math.sin(a) * d;
  o.y = Math.cos(a) * d;
  o.rotation = a;
}
