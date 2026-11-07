/**
 * The mines and their blasts, drawn over the ships' hulls (mines.ts holds what's known). Pooled: one Graphics a mine
 * over two shared looks (yours, everyone else's), made once and moved each frame; an armed mine blinks. A blast is a
 * ring and a flash where its mine rested, from the tick it went off on the drawing timeline.
 */
import { Container, Graphics, GraphicsContext } from 'pixi.js';
import { MINES } from '@space-game/common';
import { BLAST_MS, type MineStore } from './mines';

/** Yours (the own ship's friendly teal), everyone else's red */
const OWN = 0x5eead4;
const OTHER = 0xef4444;

function look(color: number): GraphicsContext {
  const g = new GraphicsContext();
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    g.moveTo(Math.cos(a) * 5, Math.sin(a) * 5).lineTo(Math.cos(a) * 9, Math.sin(a) * 9);
  }
  g.stroke({ width: 1.6, color: 0x9ca3af, alpha: 0.9 });
  g.circle(0, 0, 6).fill({ color: 0x1f2937 }).stroke({ width: 1.2, color, alpha: 0.9 });
  g.circle(0, 0, 2.4).fill({ color });
  return g;
}

export class MinesLayer {
  private root?: Container;
  private own?: GraphicsContext;
  private other?: GraphicsContext;
  private readonly pool: Graphics[] = [];
  private blastG?: Graphics;
  private readonly live: { x: number; y: number; armed: boolean; owner: number; age: number }[] = [];

  /** Once a frame: every live mine, and the blasts under way */
  draw(shared: Container, store: MineStore, me: number, tickOf: (owner: number) => number, now: number): void {
    if (!this.root) {
      this.root = new Container();
      this.root.label = 'mines';
      shared.addChild(this.root);
      this.own = look(OWN);
      this.other = look(OTHER);
      this.blastG = new Graphics();
      this.root.addChild(this.blastG);
    }
    store.prune(tickOf, now);
    const live = store.live(tickOf, this.live);
    for (let i = 0; i < live.length; i++) {
      let g = this.pool[i];
      if (!g) { g = new Graphics(); this.pool.push(g); this.root.addChild(g); }
      const m = live[i], ctx = m.owner === me ? this.own! : this.other!;
      if (g.context !== ctx) g.context = ctx;
      g.visible = true;
      g.position.set(m.x, m.y);
      // (Unarmed: dim; armed: a slow blink, each mine on its own beat)
      g.alpha = m.armed ? (Math.floor((now + i * 137) / 400) % 2 ? 1 : 0.55) : 0.4;
    }
    for (let i = live.length; i < this.pool.length; i++) this.pool[i].visible = false;
    const b = this.blastG!;
    b.clear();
    for (const bl of store.blasts as (typeof store.blasts[number] & { start?: number })[]) {
      if (tickOf(bl.owner) < bl.tick) continue;
      bl.start ??= now;
      const u = (now - bl.start) / BLAST_MS;
      if (u > 1) continue;
      const r = MINES.blastRadius * (0.25 + 0.75 * u);
      b.circle(bl.x, bl.y, r).stroke({ width: 3 + 6 * (1 - u), color: 0xfbbf24, alpha: 0.85 * (1 - u) });
      b.circle(bl.x, bl.y, r * 0.45).fill({ color: 0xfff7cc, alpha: 0.6 * (1 - u) * (1 - u) });
    }
  }
}
