/**
 * Bloom for the things that glow: engine flames and exhaust, tracers, muzzle
 * flashes, sparks, beams. They're drawn a second time into a texture a quarter
 * of the screen's size, which is blurred (at that size) and added over the
 * scene. Only those layers go in, so nothing needs thresholding, and at a
 * sixteenth of the pixels the extra draw and the blur cost next to nothing.
 *
 * The second draw happens inside the main pass, just before the bloom sprite: by then Pixi has placed and batched every
 * glow layer for the screen, so their draw lists are replayed into the bloom texture as they are (one pass for all of
 * them, nothing placed or batched twice). The texture has the screen's size in CSS pixels at a quarter of the
 * resolution, so the layers' screen transforms draw into it unchanged.
 */

import { Application, BlurFilter, Container, Graphics, ParticleContainer, RenderContainer, RenderTexture, Sprite, executeInstructions, type Renderer } from 'pixi.js';

/** The bloom texture's size, as a fraction of the screen's (the quality setting changes it: see settings/quality.ts) */
const SCALE = 0.25;
const CLEAR: [number, number, number, number] = [0, 0, 0, 0];

/** A layer with nothing drawn in it (a cleared Graphics, a particle container with no particles, a plain container holding only such): no pass for it */
function isEmpty(c: Container): boolean {
  if (c instanceof Graphics) return c.children.length === 0 && c.context.instructions.length === 0;
  if (c instanceof ParticleContainer) return c.particleChildren.length === 0;
  return c.constructor === Container && c.children.every(isEmpty);
}

export class Bloom {
  /** Goes over the world, under the UI */
  readonly sprite: Sprite;
  /** Draws the glow layers into the bloom texture during the main pass: goes just before `sprite` (see `addTo`) */
  readonly pass: RenderContainer;
  private rt: RenderTexture;
  private sources: Container[] = [];
  /** The layers with something on screen this frame */
  private live: Container[] = [];
  private scale = SCALE;
  private blur: BlurFilter;
  enabled = true;

  constructor(private app: Application) {
    this.rt = RenderTexture.create({ width: 4, height: 4, resolution: SCALE, dynamic: true });
    this.sprite = new Sprite(this.rt);
    this.sprite.blendMode = 'add';
    const blur = new BlurFilter({ strength: 3, quality: 2 });
    // The blur runs at the bloom texture's own size
    blur.resolution = SCALE;
    this.blur = blur;
    this.sprite.filters = [blur];
    this.pass = new RenderContainer({ render: (r) => this.draw(r as Renderer) });
    this.resize();
  }

  /** Puts the bloom (its pass, then its sprite) on top of `parent`'s children */
  addTo(parent: Container): void {
    parent.addChild(this.pass, this.sprite);
  }

  /** The glow texture's size (a fraction of the screen's) and the blur's passes */
  setQuality(scale: number, blurQuality: number): void {
    if (scale === this.scale && blurQuality === this.blur.quality) return;
    this.scale = scale;
    this.blur.quality = blurQuality;
    this.blur.resolution = scale;
    this.resize();
  }

  /** A layer of glowing things (kept where it is in the scene; it's drawn again into the bloom) */
  add(c: Container): void {
    // Its own draw list, to replay (the old one-render-per-layer bloom made every layer a render group too)
    c.enableRenderGroup();
    this.sources.push(c);
  }

  resize(): void {
    const { width, height } = this.app.screen;
    this.rt.resize(Math.max(1, width), Math.max(1, height), this.scale);
  }

  /** Once a frame, after everything is placed: which layers the main pass draws into the bloom */
  render(): void {
    const live = this.live;
    live.length = 0;
    if (this.enabled) for (const c of this.sources) if (this.onScreen(c) && !isEmpty(c)) live.push(c);
    // Nothing glowing on screen: no blur pass at all
    const show = live.length > 0;
    if (this.sprite.visible !== show) this.sprite.visible = show;
  }

  /** During the main pass, just before the sprite: every live layer's draw list, as Pixi built it for this frame */
  private draw(r: Renderer): void {
    if (!this.sprite.visible || this.live.length === 0) return;
    const target = r.renderTarget, uniforms = r.globalUniforms, pipes = r.renderPipes;
    target.push(this.rt, true, CLEAR);
    for (const c of this.live) {
      const g = c.renderGroup;
      if (!g || !g.isRenderable) continue;
      uniforms.push({ worldTransformMatrix: g.worldTransform, worldColor: g.worldColorAlpha });
      executeInstructions(g, pipes);
      uniforms.pop();
    }
    target.finishRenderPass();
    target.pop();
  }

  /** In the scene and shown (every ancestor visible) */
  private onScreen(c: Container): boolean {
    for (let n: Container | null = c; n; n = n.parent) {
      if (!n.visible || !n.renderable) return false;
      if (n === this.app.stage) return true;
    }
    return false;
  }
}
