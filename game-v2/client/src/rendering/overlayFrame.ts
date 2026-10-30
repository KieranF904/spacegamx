/**
 * Screen overlays painted outside Pixi (2D canvases over the game) step from
 * the renderer's frame, with its real delta, instead of their own rAF loops:
 * in step with the world, and idle when the game isn't running.
 */

const steps = new Set<(dt: number) => void>();

/** Step `fn` (seconds) once a frame; returns the unsubscribe */
export function onOverlayFrame(fn: (dt: number) => void): () => void {
  steps.add(fn);
  return () => steps.delete(fn);
}

/** Once a frame, from Renderer.update */
export function stepOverlays(dt: number): void {
  for (const fn of steps) fn(dt);
}

/**
 * The red edge of a hit (0..1), set by the damage indicator and drawn by the
 * renderer's vignette, so the two don't stack two full-screen gradients.
 */
export const screenTint = { damage: 0 };
