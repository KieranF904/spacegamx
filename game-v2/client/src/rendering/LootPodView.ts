/**
 * A loot pod floating in space: a small hexagonal crate that turns slowly,
 * glowing in the colour of the best item inside. Rare and better pods send up
 * a beam of light so they can be spotted from a distance.
 *
 * Snapshot data: [rarity index, kinds of item, item count].
 */

import { Container, Graphics } from 'pixi.js';

const RARITY = [0xc8d0dc, 0x5fd38d, 0x4fa3ff, 0xc77dff, 0xffb347];

export class LootPodView {
  readonly container = new Container();
  private glow = new Graphics();
  private crate = new Graphics();
  private beam = new Graphics();
  private t = Math.random() * 10;
  private color: number;

  constructor(private rarity: number, count: number) {
    this.color = RARITY[Math.max(0, Math.min(4, rarity))];
    const size = 11 + Math.min(8, Math.log2(1 + count) * 1.6);
    this.glow.blendMode = 'add';
    this.beam.blendMode = 'add';
    // Hexagonal crate with a lit band
    const hex: number[] = [];
    for (let i = 0; i < 6; i++) hex.push(Math.cos((i / 6) * Math.PI * 2) * size, Math.sin((i / 6) * Math.PI * 2) * size);
    this.crate.poly(hex).fill({ color: 0x2b3342 }).stroke({ color: 0x8b97a8, width: 2 });
    const inner: number[] = [];
    for (let i = 0; i < 6; i++) inner.push(Math.cos((i / 6) * Math.PI * 2) * size * 0.55, Math.sin((i / 6) * Math.PI * 2) * size * 0.55);
    this.crate.poly(inner).fill({ color: this.color, alpha: 0.9 });
    this.crate.moveTo(-size, 0).lineTo(size, 0).stroke({ color: 0x1b212b, width: 2 });
    // Glow and beam are drawn once; the pulse only changes their alpha
    this.glow.circle(0, 0, 30).fill({ color: this.color, alpha: 0.10 });
    this.glow.circle(0, 0, 18).fill({ color: this.color, alpha: 0.22 });
    if (rarity >= 2) {
      // A light column fading out as it rises
      const h = 160 + 60 * rarity, n = 8;
      for (let i = 0; i < n; i++) {
        const k = 1 - i / n;
        this.beam.rect(-3, -(h * (i + 1)) / n, 6, h / n).fill({ color: this.color, alpha: 0.16 * k });
        this.beam.rect(-1, -(h * (i + 1)) / n, 2, h / n).fill({ color: 0xffffff, alpha: 0.18 * k });
      }
    }
    this.container.addChild(this.beam, this.glow, this.crate);
  }

  /** Light on the crate (the glow and beam shine by themselves) */
  light(l: [number, number, number]): void {
    const k = (v: number) => Math.min(255, Math.round(255 * Math.min(1, v)));
    this.crate.tint = (k(l[0]) << 16) | (k(l[1]) << 8) | k(l[2]);
  }

  update(dt: number): void {
    this.t += dt;
    this.crate.rotation += dt * 0.6;
    const pulse = 0.6 + 0.4 * Math.sin(this.t * 3);
    this.glow.alpha = pulse;
    this.beam.alpha = 0.7 + 0.3 * pulse;
  }
}
