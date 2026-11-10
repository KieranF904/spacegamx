/**
 * @contract client.render.death-screen
 * owns:       the DESTROYED overlay: building it, easing it in, rebuilding it on a resize
 * needs:      pixi Container, settings/keybindings (respawn key name); npm: pixi.js
 * invariants: a resize while dead keeps the fade where it was — client/src/rendering/renderer/rendererModules.test.ts
 * extend:     new lines on the overlay go in build()
 */

import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import { boundKeyName } from '../../input/keybindings';
import { settings } from '../../settings/Settings';

export class DeathScreen {
  private overlay: Container | null = null;
  private at = 0;
  private killer: string | undefined;

  constructor(private parent: Container, private size: () => { width: number; height: number }) {}

  /** Whether the overlay is up */
  get active(): boolean {
    return this.overlay !== null;
  }

  show(killerName?: string): void {
    if (this.overlay) return;
    this.killer = killerName;
    this.at = performance.now();
    this.build();
  }

  hide(): void {
    if (this.overlay) {
      this.parent.removeChild(this.overlay);
      this.overlay.destroy({ children: true });
      this.overlay = null;
    }
  }

  /** Each frame: it fades and settles in from `at` */
  step(): void {
    const o = this.overlay;
    if (o) {
      const t = Math.min(1, (performance.now() - this.at) / 700);
      const e = 1 - (1 - t) ** 3;
      o.alpha = e;
      const title = o.getChildByLabel('deathTitle');
      if (title) title.scale.set(1.35 - 0.35 * e);
    }
  }

  /** The screen changed size: the overlay keeps its place in its fade */
  rebuild(): void {
    if (this.overlay) {
      const old = this.overlay;
      const alpha = old.alpha, titleScale = old.getChildByLabel('deathTitle')?.scale.x;
      this.parent.removeChild(old);
      old.destroy({ children: true });
      this.build();
      // (It starts at 0: carry the fade across, so a resize while dead doesn't flash the world back)
      if (this.overlay) {
        this.overlay.alpha = alpha;
        if (titleScale !== undefined) this.overlay.getChildByLabel('deathTitle')?.scale.set(titleScale);
      }
    }
  }

  /** The overlay (it fades and settles in from `at`, see step) */
  private build(): void {
    const w = this.size().width, h = this.size().height;
    this.overlay = new Container();
    this.overlay.alpha = 0;

    const bg = new Graphics();
    bg.rect(0, 0, w, h);
    bg.fill({ color: 0x000000, alpha: 0.7 });
    this.overlay.addChild(bg);

    const text = new Text({
      text: 'DESTROYED',
      style: new TextStyle({ fontFamily: 'Arial', fontSize: 48, fill: 0xff4444, fontWeight: 'bold', letterSpacing: 6 }),
    });
    text.anchor.set(0.5);
    text.position.set(w / 2, h / 2 - 50);
    text.label = 'deathTitle';
    this.overlay.addChild(text);

    if (this.killer) {
      const by = new Text({
        text: `by ${this.killer}`,
        style: new TextStyle({ fontFamily: 'Arial', fontSize: 20, fill: 0xffb4a8 }),
      });
      by.anchor.set(0.5);
      by.position.set(w / 2, h / 2 - 8);
      this.overlay.addChild(by);
    }

    const subText = new Text({
      text: `Press ${boundKeyName('respawn', settings.data.bindings)} to respawn`,
      style: new TextStyle({ fontFamily: 'Arial', fontSize: 24, fill: 0xffffff }),
    });
    subText.anchor.set(0.5);
    subText.position.set(w / 2, h / 2 + 34);
    this.overlay.addChild(subText);

    this.parent.addChild(this.overlay);
  }
}
