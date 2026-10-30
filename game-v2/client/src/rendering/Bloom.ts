/**
 * Bloom for the things that glow: engine flames and exhaust, tracers, muzzle
 * flashes, sparks, beams. They're drawn a second time into a texture a quarter
 * of the screen's size, which is blurred (at that size) and added over the
 * scene. Only those layers go in, so nothing needs thresholding, and at a
 * sixteenth of the pixels the extra draw and the blur cost next to nothing.
 */

import { Application, BlurFilter, Container, Graphics, Matrix, RenderTexture, Sprite } from 'pixi.js';

/** The bloom texture's size, as a fraction of the screen's (the quality setting changes it: see settings/quality.ts) */
const SCALE = 0.25;

/** A layer with nothing drawn in it (a cleared Graphics, a plain container with no children): no pass for it. Anything else (a particle container) is assumed to have something. */
function isEmpty(c: Container): boolean {
  if (c instanceof Graphics) return c.children.length === 0 && c.context.instructions.length === 0;
  return c.constructor === Container && c.children.length === 0;
}

export class Bloom {
  /** Goes over the world, under the UI */
  readonly sprite: Sprite;
  private rt: RenderTexture;
  private sources: Container[] = [];
  private m = new Matrix();
  private chain: Container[] = [];
  private scale = SCALE;
  private blur: BlurFilter;
  enabled = true;

  constructor(private app: Application) {
    this.rt = RenderTexture.create({ width: 4, height: 4, resolution: 1, dynamic: true });
    this.sprite = new Sprite(this.rt);
    this.sprite.blendMode = 'add';
    this.sprite.scale.set(1 / SCALE);
    const blur = new BlurFilter({ strength: 3, quality: 2 });
    // The blur runs at the bloom texture's own size
    blur.resolution = SCALE;
    this.blur = blur;
    this.sprite.filters = [blur];
    this.resize();
  }

  /** The glow texture's size (a fraction of the screen's) and the blur's passes */
  setQuality(scale: number, blurQuality: number): void {
    if (scale === this.scale && blurQuality === this.blur.quality) return;
    this.scale = scale;
    this.blur.quality = blurQuality;
    this.blur.resolution = scale;
    this.sprite.scale.set(1 / scale);
    this.resize();
  }

  /** A layer of glowing things (kept where it is in the scene; it's drawn again into the bloom) */
  add(c: Container): void {
    this.sources.push(c);
  }

  resize(): void {
    const { width, height } = this.app.screen;
    this.rt.resize(Math.max(1, Math.ceil(width * this.scale)), Math.max(1, Math.ceil(height * this.scale)));
  }

  /** Once a frame, after everything is placed */
  render(): void {
    this.sprite.visible = this.enabled;
    if (!this.enabled) return;
    const r = this.app.renderer;
    let first = true;
    for (const c of this.sources) {
      if (!this.onScreen(c) || isEmpty(c)) continue;
      r.render({ container: c, target: this.rt, clear: first, transform: this.transformOf(c) });
      first = false;
    }
    // Nothing glowing on screen: no blur pass at all (the next layer drawn clears what's left)
    if (first) this.sprite.visible = false;
  }

  /** In the scene and shown (every ancestor visible) */
  private onScreen(c: Container): boolean {
    for (let n: Container | null = c; n; n = n.parent) {
      if (!n.visible) return false;
      if (n === this.app.stage) return true;
    }
    return false;
  }

  /** Where the layer is on screen, scaled down to the bloom texture */
  private transformOf(c: Container): Matrix {
    const chain = this.chain;
    chain.length = 0;
    for (let n: Container | null = c; n && n !== this.app.stage; n = n.parent) chain.push(n);
    const m = this.m.identity().scale(this.scale, this.scale);
    for (let i = chain.length - 1; i >= 0; i--) {
      chain[i].updateLocalTransform();
      // world = parent × local; scaled down at the end (prepended above)
      m.append(chain[i].localTransform);
    }
    return m;
  }
}
