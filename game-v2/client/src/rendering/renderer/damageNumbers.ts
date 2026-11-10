/**
 * @contract client.render.damage-numbers
 * owns:       floating hit numbers: pooled bitmap text rising off what was hit
 * needs:      DamageNumbersHost (tagScale, cameraAngle), cameraView screenToWorldDir; npm: pixi.js
 * invariants: texts are pooled, never created per hit once warm — client/src/rendering/renderer/rendererModules.test.ts
 * extend:     a new number style (colour or size) is one more branch in show()
 */

import { BitmapFont, BitmapText, Container } from 'pixi.js';
import { screenToWorldDir } from '../cameraView';

/** What the numbers read from the renderer */
export interface DamageNumbersHost {
  tagScale(): number;
  cameraAngle(): number;
}

interface DamageNumber {
  /** Where it was hit (world) */
  x: number;
  y: number;
  /** Its rise and drift from there, along the screen's axes (world units) */
  ox: number;
  oy: number;
  amount: number;
  critical: boolean;
  lifetime: number;
  /** Sideways drift (world units a second at the start) */
  drift: number;
  text: BitmapText;
}

export class DamageNumbers {
  private list: DamageNumber[] = [];
  /** A bitmap font (digits drawn once), pooled */
  private pool: BitmapText[] = [];
  /** Over the other effects. Its own render group: a number coming or going rebuilds its draw list, not the scene's */
  readonly layer = new Container({ isRenderGroup: true });
  private static fontInstalled = false;
  /** Display setting: hidden numbers still run, they just don't show */
  visible = true;

  constructor(parent: Container, private host: DamageNumbersHost) {
    parent.addChild(this.layer);
  }

  update(delta: number): void {
    // Counter-scaled zoomed out (so they stay readable), and they float as far on screen
    const k = this.host.tagScale();
    for (let i = this.list.length - 1; i >= 0; i--) {
      const dn = this.list[i];
      dn.lifetime -= delta;
      // Float up the screen, slowing, drifting a little to its side (so a burst of hits fans out instead of stacking)
      dn.oy -= 55 * k * delta * dn.lifetime;
      dn.ox += dn.drift * k * delta * dn.lifetime;
      
      if (dn.lifetime <= 0) {
        this.layer.removeChild(dn.text);
        this.pool.push(dn.text);
        this.list.splice(i, 1);
      } else {
        const o = screenToWorldDir(dn.ox, dn.oy, this.host.cameraAngle());
        dn.text.x = dn.x + o.x;
        dn.text.y = dn.y + o.y;
        dn.text.rotation = this.host.cameraAngle();
        dn.text.alpha = Math.min(1, dn.lifetime * 2);
        // A pop as it appears: big, settling to size in the first ~0.12 s
        const age = 1 - dn.lifetime;
        dn.text.scale.set((age < 0.12 ? 1 + 0.6 * (1 - age / 0.12) : 1) * k);
      }
    }
  }

  /** A hit's number over what it hit: yellow and bigger for a critical, small and grey for a glancing hit (a gun too weak for that armour) */
  show(x: number, y: number, amount: number, critical?: boolean, glancing?: boolean): void {
    // A bitmap font (its digits drawn once), pooled: no text rasterised and uploaded per hit
    if (!DamageNumbers.fontInstalled) {
      BitmapFont.install({ name: 'DamageNumbers', style: { fontFamily: 'Arial', fontSize: 36, fill: 0xffffff, fontWeight: 'bold' }, chars: [['0', '9']], resolution: 2 });
      DamageNumbers.fontInstalled = true;
    }
    const text = this.pool.pop() ?? new BitmapText({ text: '', style: { fontFamily: 'DamageNumbers', fontSize: 18 } });
    text.text = Math.floor(amount).toString();
    text.style.fontSize = critical ? 24 : glancing ? 14 : 18;
    text.tint = critical ? 0xffff00 : glancing ? 0x94a3b8 : 0xff4444;
    text.anchor.set(0.5);
    text.alpha = 1;
    text.visible = this.visible;
    text.rotation = this.host.cameraAngle();
    this.layer.addChild(text);

    text.scale.set(1.6 * this.host.tagScale());
    const jx = (Math.random() - 0.5) * 24 * this.host.tagScale();
    // (Its rise and drift along the screen's axes, from the hit)
    const o = screenToWorldDir(jx, -30, this.host.cameraAngle());
    text.x = x + o.x;
    text.y = y + o.y;
    this.list.push({
      drift: jx * 1.5,
      x: x,
      y: y,
      ox: jx,
      oy: -30,
      amount,
      critical: critical || false,
      lifetime: 1,
      text,
    });
  }
}
