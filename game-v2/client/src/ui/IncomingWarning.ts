/**
 * A warning for a pilot a huge shell (the Leviathan) is heading at: an arrow on the screen edge pointing to it, flashing
 * quicker the less time is left. Whether it is heading at you is worked out from the shell's velocity
 * (rendering/weapons/ordnanceTells incomingTicks, in WeaponFx). A shell already on screen needs no arrow. A small fixed
 * set of elements, restyled in place; nothing is made per frame.
 */

import { edgePoint } from '../rendering/weapons/ordnanceTells';

const SLOTS = 4;
/** Keep the arrow this far inside the screen edge (pixels), and treat a shell this close to the edge as on screen */
const INSET = 34;

interface Threats { list: readonly { x: number; y: number; t: number }[]; count: number }

export class IncomingWarning {
  private els: HTMLDivElement[] = [];
  private clock = 0;
  private readonly pt = { x: 0, y: 0 };
  private shown = 0;

  private build(): void {
    if (this.els.length || typeof document === 'undefined') return;
    for (let i = 0; i < SLOTS; i++) {
      const el = document.createElement('div');
      el.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:1900;display:none;will-change:transform,opacity';
      el.innerHTML = '<div style="position:absolute;left:-16px;top:-14px;width:0;height:0;border-top:14px solid transparent;border-bottom:14px solid transparent;border-left:30px solid #ff2a22;filter:drop-shadow(0 0 6px #ff2a22)"></div>';
      document.body.appendChild(el);
      this.els.push(el);
    }
  }

  /** `threats` as WeaponFx lists them; `toScreen` puts a world point on screen (pixels) */
  update(dt: number, threats: Threats, toScreen: (x: number, y: number) => { x: number; y: number }, size: { w: number; h: number }): void {
    try {
      if (!threats.count && !this.shown) return;
      this.build();
      this.clock += dt;
      let n = 0;
      for (let i = 0; i < threats.count && n < this.els.length; i++) {
        const th = threats.list[i];
        const s = toScreen(th.x, th.y);
        // On screen already (well inside the edge): the shell is plain to see
        if (s.x > INSET && s.x < size.w - INSET && s.y > INSET && s.y < size.h - INSET) continue;
        if (!edgePoint(s.x - size.w / 2, s.y - size.h / 2, size.w, size.h, INSET, this.pt)) continue;
        const el = this.els[n++];
        // Quicker as it nears: 2 flashes a second far off, 8 a second in the last second
        const rate = 2 + 6 * Math.max(0, Math.min(1, 1 - th.t / 360));
        const on = 0.55 + 0.45 * Math.sin(this.clock * rate * Math.PI * 2);
        el.style.display = 'block';
        el.style.opacity = String(on);
        el.style.transform = `translate(${this.pt.x}px,${this.pt.y}px) rotate(${Math.atan2(s.y - size.h / 2, s.x - size.w / 2)}rad)`;
      }
      for (let i = n; i < this.els.length; i++) this.els[i].style.display = 'none';
      this.shown = n;
    } catch {
      // (no DOM: the warning is only a nicety)
    }
  }
}
