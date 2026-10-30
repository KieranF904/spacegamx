/**
 * Sprites reused frame to frame: begin(), take one per thing drawn, end() hides the ones not taken. For effects that
 * come and go (sparks, flashes, tracers).
 *
 * Kept cheap for Pixi: the pool is a render group of its own, since a sprite shown or hidden has Pixi rebuild the draw
 * list of its group (this pool's, not the whole scene's); and a pool grown in a busy fight gives its surplus back a few
 * seconds after, so that list stays short. (Each sprite carries the blend mode: Pixi doesn't pass a render group's own
 * on to what's in it.)
 */

import { Container, Sprite, Texture } from 'pixi.js';

/** How often a pool looks at whether it's bigger than it has needed lately (ms) */
const TRIM_EVERY = 4000;
/** It keeps a quarter more than its busiest frame since, and never trims below this */
const KEEP_MIN = 32;

export class SpritePool {
  readonly container = new Container({ isRenderGroup: true });
  private sprites: Sprite[] = [];
  /** Each sprite's tint as last set (Pixi parses the colour on every set, changed or not) */
  private tints: number[] = [];
  private used = 0;
  /** The most taken in a frame since the last trim, and when that was */
  private peak = 0;
  private trimmedAt = 0;

  constructor(private blendMode: 'add' | 'normal' = 'normal') {}

  begin(): void {
    this.used = 0;
  }

  /** A sprite showing `texture`, anchored at (ax, ay), at (x, y), turned, tinted, faded (its scale is the caller's to set) */
  take(texture: Texture, x: number, y: number, ax: number, ay: number, tint: number, alpha: number, rotation = 0): Sprite {
    const i = this.used++;
    let s = this.sprites[i];
    if (!s) {
      s = new Sprite(texture);
      s.blendMode = this.blendMode;
      this.sprites.push(s);
      this.tints.push(0xffffff);
      this.container.addChild(s);
    }
    if (s.texture !== texture) s.texture = texture;
    s.visible = true;
    s.anchor.set(ax, ay);
    s.position.set(x, y);
    s.rotation = rotation;
    if (this.tints[i] !== tint) {
      s.tint = tint;
      this.tints[i] = tint;
    }
    s.alpha = alpha;
    return s;
  }

  end(): void {
    for (let i = this.used; i < this.sprites.length; i++) {
      const s = this.sprites[i];
      if (!s.visible) break;
      s.visible = false;
    }
    this.peak = Math.max(this.peak, this.used);
    const now = performance.now();
    if (now - this.trimmedAt < TRIM_EVERY) return;
    this.trimmedAt = now;
    const keep = Math.max(KEEP_MIN, Math.ceil(this.peak * 1.25));
    this.peak = this.used;
    // (only for a real surplus: a pool about the size it needs stays as it is)
    if (this.sprites.length < keep * 1.5) return;
    for (const s of this.sprites.splice(keep)) s.destroy();
    this.tints.length = keep;
  }
}
