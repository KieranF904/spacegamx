/**
 * A boss arena's barrier (common world/gates.ts, TerrainFile `gates`): a faint shimmering curtain along its pieces'
 * inner edges, breathing slowly. Look only: the pieces themselves are solid in the shared terrain.
 */

import { Graphics } from 'pixi.js';
import type { Vec2 } from '@space-game/common';

export class BarrierView {
  readonly gfx = new Graphics();
  private t = 0;

  constructor(private pieces: Vec2[][], private colour = 0x7dffb0) {
    this.draw(0.5);
  }

  private draw(k: number): void {
    const g = this.gfx;
    g.clear();
    for (const p of this.pieces) {
      g.poly(p.flat()).fill({ color: this.colour, alpha: 0.05 + 0.04 * k });
      // (its two long edges: the curtain's faces)
      g.moveTo(p[0][0], p[0][1]).lineTo(p[3][0], p[3][1]).stroke({ width: 10, color: this.colour, alpha: 0.18 + 0.12 * k });
      g.moveTo(p[1][0], p[1][1]).lineTo(p[2][0], p[2][1]).stroke({ width: 6, color: this.colour, alpha: 0.1 + 0.08 * k });
    }
  }

  update(dt: number): void {
    this.t += dt;
    // (redrawn a few times a second: a slow breath, not a flicker)
    const step = Math.floor(this.t * 8);
    if (step === Math.floor((this.t - dt) * 8)) return;
    this.draw(0.5 + 0.5 * Math.sin(this.t * 1.3));
  }

  destroy(): void {
    this.gfx.destroy();
  }
}
