/**
 * Structures the local pilot is building or has built (construct steps):
 * drawn for them alone, from the quests message's `builds`. Built pieces in
 * plate and light; pieces still to come as faint outlines while it's going
 * up. Scenery only: nothing collides with them. While a piece is going on
 * (the job's card says so), a constructor beam runs from the ship to it.
 */

import { Container, Graphics } from 'pixi.js';
import type { BuildView } from '@space-game/common';
import type { GameState } from '../state/GameState';

const PLATE = 0x9aa7b8;
const EDGE = 0xdbe4ef;
const GHOST = 0x7dd3fc;
const LAMP = 0x7dd3fc;
const CELL = 0xfbbf24;
const BEAM = 0xf5b942;

export class BuildSites {
  private g = new Graphics();
  private builds: BuildView[] = [];
  private time = 0;
  private drawn = false;

  constructor(layer: Container, private state: GameState) {
    layer.addChild(this.g);
  }

  set(builds: BuildView[] | undefined): void {
    this.builds = builds ?? [];
  }

  /** `beam`: the site a piece is going on at now, if any */
  update(dt: number, beam: { x: number; y: number } | null): void {
    this.time += dt;
    const g = this.g;
    // Nothing of yours in this system: leave the (empty) graphics alone rather than rebuild it every frame
    const here = this.builds.some((b) => b.system === this.state.systemId);
    if (!here && !beam) { if (this.drawn) { g.clear(); this.drawn = false; } return; }
    this.drawn = true;
    g.clear();
    for (const b of this.builds) {
      if (b.system !== this.state.systemId) continue;
      if (b.structure === 'nav_buoy') this.navBuoy(g, b);
    }
    const me = this.state.entities.get(this.state.playerId);
    if (beam && me) {
      const flick = 0.55 + 0.45 * Math.sin(this.time * 22);
      g.moveTo(me.renderX, me.renderY).lineTo(beam.x, beam.y).stroke({ color: BEAM, width: 10, alpha: 0.12 * flick });
      g.moveTo(me.renderX, me.renderY).lineTo(beam.x, beam.y).stroke({ color: 0xfff1c2, width: 3, alpha: 0.7 * flick });
      for (let k = 0; k < 6; k++) {
        const a = this.time * 3 + k * 1.047;
        g.circle(beam.x + Math.cos(a) * 70, beam.y + Math.sin(a) * 70, 6).fill({ color: BEAM, alpha: 0.6 * flick });
      }
    }
  }

  /** A nav buoy from above: a ring frame, a cross-braced mast at its heart, power cells either side, a dish on top */
  private navBuoy(g: Graphics, b: BuildView): void {
    const has = (id: string) => b.pieces.some((p) => p.id === id && p.built);
    const whole = b.pieces.every((p) => p.built);
    const x = b.x, y = b.y;
    const ghost = (draw: () => void) => { draw(); g.stroke({ color: GHOST, width: 3, alpha: 0.28 + 0.12 * Math.sin(this.time * 3) }); };
    // Frame: an octagonal ring and its keel
    const ring = (r: number) => { for (let i = 0; i <= 8; i++) { const a = (i / 8) * Math.PI * 2 + Math.PI / 8; const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r; if (i) g.lineTo(px, py); else g.moveTo(px, py); } };
    if (has('frame')) {
      ring(130); g.stroke({ color: PLATE, width: 16 });
      ring(130); g.stroke({ color: EDGE, width: 2, alpha: 0.8 });
      g.moveTo(x, y + 130).lineTo(x, y + 190).stroke({ color: PLATE, width: 10 });
    } else if (!whole) ghost(() => ring(130));
    // Mast: a cross-braced spine
    const mast = () => { g.moveTo(x - 95, y).lineTo(x + 95, y); g.moveTo(x, y - 95).lineTo(x, y + 95); };
    if (has('mast')) {
      mast(); g.stroke({ color: PLATE, width: 12 });
      g.circle(x, y, 26).fill({ color: 0x5b6676 }).stroke({ color: EDGE, width: 2 });
    } else if (!whole) ghost(mast);
    // Power cells: a pod either side
    const pods = (fill: boolean) => {
      for (const s of [-1, 1]) {
        g.roundRect(x + s * 165 - 30, y - 45, 60, 90, 14);
        if (fill) g.fill({ color: 0x3b4452 }).stroke({ color: EDGE, width: 2 });
      }
    };
    if (has('cell')) {
      pods(true);
      for (const s of [-1, 1]) g.rect(x + s * 165 - 14, y - 26, 28, 52).fill({ color: CELL, alpha: 0.55 + 0.25 * Math.sin(this.time * 2 + s) });
    } else if (!whole) ghost(() => pods(false));
    // Dish: an arc that sweeps slowly, and the beacon lamp
    if (has('dish')) {
      const a = this.time * 0.6;
      g.moveTo(x + Math.cos(a - 0.7) * 70, y + Math.sin(a - 0.7) * 70).arc(x, y, 70, a - 0.7, a + 0.7).stroke({ color: EDGE, width: 8 });
      g.moveTo(x, y).lineTo(x + Math.cos(a) * 70, y + Math.sin(a) * 70).stroke({ color: PLATE, width: 4 });
      const blink = Math.sin(this.time * 4) > 0.6 ? 1 : 0.25;
      g.circle(x, y, 12).fill({ color: LAMP, alpha: blink });
      if (whole) g.circle(x, y, 60).fill({ color: LAMP, alpha: 0.08 * blink });
    } else if (!whole) ghost(() => { g.moveTo(x + 70, y).arc(x, y, 70, 0, Math.PI * 2); });
  }
}
