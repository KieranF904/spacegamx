import type { Graphics } from 'pixi.js';

/**
 * Clear a Graphics only if it has something drawn. Clearing an empty one still
 * marks it changed, and Pixi rebuilds it that frame for nothing: effects that
 * are usually idle (beams, scans, sparks) would cost a rebuild every frame.
 */
export function clearIfDrawn(g: Graphics): void {
  if (g.context.instructions.length) g.clear();
}
