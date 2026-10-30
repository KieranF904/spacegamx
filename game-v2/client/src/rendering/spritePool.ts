/**
 * Sprites reused frame to frame: begin(), take one per thing drawn, end() hides
 * the ones not taken. For effects that come and go (sparks, flashes, tracers).
 */

import { Container, Sprite, Texture } from 'pixi.js';

export class SpritePool {
  readonly container = new Container();
  private sprites: Sprite[] = [];
  private used = 0;

  constructor(blendMode: 'add' | 'normal' = 'normal') {
    this.container.blendMode = blendMode;
  }

  begin(): void {
    this.used = 0;
  }

  /** A sprite showing `texture`, anchored at (ax, ay), at (x, y), tinted, faded */
  take(texture: Texture, x: number, y: number, ax: number, ay: number, tint: number, alpha: number): Sprite {
    let s = this.sprites[this.used];
    if (!s) {
      s = new Sprite(texture);
      this.sprites.push(s);
      this.container.addChild(s);
    }
    this.used++;
    if (s.texture !== texture) s.texture = texture;
    s.visible = true;
    s.anchor.set(ax, ay);
    s.position.set(x, y);
    s.rotation = 0;
    s.tint = tint;
    s.alpha = alpha;
    return s;
  }

  end(): void {
    for (let i = this.used; i < this.sprites.length; i++) {
      const s = this.sprites[i];
      if (!s.visible) break;
      s.visible = false;
    }
  }
}
