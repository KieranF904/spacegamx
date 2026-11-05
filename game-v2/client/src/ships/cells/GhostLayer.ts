/**
 * Ghosts (CAPS.FOCUS; common network/cells.ts): what the client draws of ships it doesn't simulate, and of ships it does
 * from 18 km out. A ghost is a small marker held at a fixed size on screen, coloured by what the ship is (hostile, pilot,
 * traffic, derelict), at the place its leg puts it (the ring's ships: map-dot legs, state/FarShips.ts) or its tick
 * layer does (a focus ship past GHOST_FADE_FROM: its hull fades out as its marker fades in, ShipRenderer.ghostOf). Drawing
 * only: nothing here is sent or read back.
 */
import { Graphics, type Container } from 'pixi.js';

export interface Ghost { x: number; y: number; kind: number; rank: number; w: number }

/** Marker colours by map-dot kind (1 derelict, 2 traffic, 3 hostile, 4 pilot; 0 other) */
const COLORS = [0xa9b3c4, 0x8a8f99, 0xb8c4d6, 0xff6b5a, 0x7dd3fc];
/** Its half-size and line on screen (px) */
const SIZE = 6, LINE = 1.5;

export class GhostLayer {
  private g = new Graphics();
  /** Ghosts drawn last frame (stats, the tests) */
  drawn = 0;

  constructor(layer: Container) {
    layer.addChild(this.g);
  }

  draw(ghosts: readonly Ghost[], zoom: number, inView: (x: number, y: number) => boolean): void {
    const g = this.g;
    g.clear();
    this.drawn = 0;
    const u = 1 / Math.max(zoom, 1e-4);
    for (const h of ghosts) {
      if (h.w <= 0.01 || !inView(h.x, h.y)) continue;
      const s = (SIZE + 2 * h.rank) * u, color = COLORS[h.kind] ?? COLORS[0];
      g.moveTo(h.x, h.y - s).lineTo(h.x + s, h.y).lineTo(h.x, h.y + s).lineTo(h.x - s, h.y).closePath()
        .fill({ color, alpha: 0.18 * h.w }).stroke({ color, width: LINE * u, alpha: 0.6 * h.w });
      this.drawn++;
    }
  }

  destroy(): void {
    this.g.destroy();
  }
}
