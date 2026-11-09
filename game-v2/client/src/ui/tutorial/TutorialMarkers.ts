/**
 * @contract client.ui.tutorial.markers
 * owns:       the lesson's world-space marks, drawn on one pointer-transparent canvas over the game: rings, the stop zone and the
 *             exit marker (bright for this step, faint for later ones), a pulse on the current step's targets, and a
 *             screen-edge arrow towards a target that is off screen
 * needs:      tutorialModel (markerStyle, arrowTargets, edgeArrow), the renderer's worldToScreen, common objectPos
 * invariants: what is bright, faint or hidden is decided in tutorialModel.ts — client/src/ui/tutorial/tutorialModel.test.ts
 * extend:     a new kind of mark is a case in draw(); its rule is a function in tutorialModel.ts
 */

import { objectPos } from '@space-game/common';
import type { ServerTutorialStateMessage, TutorialData, TutorialObjectDef } from '@space-game/common';
import { arrowTargets, edgeArrow, markerStyle } from './tutorialModel';

export interface MarkerDeps {
  data: TutorialData;
  worldToScreen(x: number, y: number): { x: number; y: number };
  /** The pilot's ship, world position */
  me(): { x: number; y: number } | null;
}

const AMBER = '251, 191, 36';
const BLUE = '125, 211, 252';

export class TutorialMarkers {
  private cv = document.createElement('canvas');
  private ctx = this.cv.getContext('2d');
  private hidden = false;

  constructor(private d: MarkerDeps) {
    this.cv.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:2050;';
    this.cv.setAttribute('aria-hidden', 'true');
    document.body.appendChild(this.cv);
  }

  setHidden(h: boolean): void {
    this.hidden = h;
    this.cv.style.display = h ? 'none' : '';
  }

  /** Each frame */
  draw(s: ServerTutorialStateMessage | null): void {
    const ctx = this.ctx;
    if (!ctx || this.hidden) return;
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth, h = window.innerHeight;
    if (this.cv.width !== Math.round(w * dpr) || this.cv.height !== Math.round(h * dpr)) { this.cv.width = Math.round(w * dpr); this.cv.height = Math.round(h * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!s || s.left) return;
    const step = this.d.data.steps.find((x) => x.id === s.step);
    const t = performance.now() / 1000;
    for (const o of this.d.data.objects) {
      const style = markerStyle(o, s, step);
      if (style) this.mark(ctx, o, style === 'active', t);
    }
    // Arrows to this step's targets that are off screen (and a bobbing one over those on screen)
    const me = this.d.me();
    for (const o of arrowTargets(this.d.data, s, step)) {
      const p = objectPos(this.d.data, o);
      const sp = this.d.worldToScreen(p.x, p.y);
      const a = edgeArrow(sp.x, sp.y, w, h, 46);
      if (a.onScreen) this.pointer(ctx, sp.x, sp.y - this.screenRadius(o) - 14 - Math.sin(t * 4) * 4, o.label);
      else this.edge(ctx, a, me ? Math.hypot(p.x - me.x, p.y - me.y) : 0, o.label);
    }
  }

  private screenRadius(o: TutorialObjectDef): number {
    const p = objectPos(this.d.data, o);
    const a = this.d.worldToScreen(p.x, p.y), b = this.d.worldToScreen(p.x + o.radius, p.y);
    return Math.max(10, Math.hypot(b.x - a.x, b.y - a.y));
  }

  private mark(ctx: CanvasRenderingContext2D, o: TutorialObjectDef, active: boolean, t: number): void {
    const p = objectPos(this.d.data, o);
    const c = this.d.worldToScreen(p.x, p.y);
    const r = this.screenRadius(o);
    if (c.x < -r || c.y < -r || c.x > window.innerWidth + r || c.y > window.innerHeight + r) return;
    const col = o.kind === 'zone' ? BLUE : AMBER;
    const pulse = active ? 0.55 + 0.35 * Math.sin(t * 3) : 0;
    ctx.save();
    ctx.lineWidth = active ? 3 : 1.5;
    ctx.strokeStyle = `rgba(${col}, ${active ? 0.55 + pulse * 0.4 : 0.22})`;
    if (o.kind === 'zone' || o.kind === 'exit') ctx.setLineDash([14, 10]);
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.stroke();
    if (active) {
      ctx.fillStyle = `rgba(${col}, ${0.05 + pulse * 0.05})`;
      ctx.fill();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(c.x, c.y, r * (0.55 + 0.1 * Math.sin(t * 3)), 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${col}, 0.3)`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    if (o.label && (active || r > 40)) {
      ctx.setLineDash([]);
      ctx.fillStyle = `rgba(${col}, ${active ? 0.95 : 0.4})`;
      ctx.font = `700 ${active ? 15 : 12}px 'Segoe UI', sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(o.label, c.x, c.y);
    }
    ctx.restore();
  }

  private pointer(ctx: CanvasRenderingContext2D, x: number, y: number, label?: string): void {
    ctx.save();
    ctx.fillStyle = `rgba(${AMBER}, 0.95)`;
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.moveTo(x, y + 4);
    ctx.lineTo(x - 9, y - 10);
    ctx.lineTo(x + 9, y - 10);
    ctx.closePath();
    ctx.fill();
    if (label) {
      ctx.font = "700 12px 'Segoe UI', sans-serif";
      ctx.textAlign = 'center';
      ctx.fillText(label, x, y - 16);
    }
    ctx.restore();
  }

  private edge(ctx: CanvasRenderingContext2D, a: { x: number; y: number; angle: number }, dist: number, label?: string): void {
    ctx.save();
    ctx.translate(a.x, a.y);
    ctx.rotate(a.angle);
    ctx.fillStyle = `rgba(${AMBER}, 0.95)`;
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.moveTo(16, 0);
    ctx.lineTo(-10, -11);
    ctx.lineTo(-4, 0);
    ctx.lineTo(-10, 11);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    if (dist > 0 || label) {
      ctx.save();
      ctx.font = "600 11px 'Segoe UI', sans-serif";
      ctx.fillStyle = `rgba(${AMBER}, 0.95)`;
      ctx.textAlign = 'center';
      ctx.shadowColor = 'rgba(0,0,0,0.9)';
      ctx.shadowBlur = 4;
      const text = [label, dist > 0 ? `${Math.round(dist / 10) * 10}` : ''].filter(Boolean).join(' · ');
      // Inward of the arrow
      ctx.fillText(text, a.x - Math.cos(a.angle) * 34, a.y - Math.sin(a.angle) * 22 + 4);
      ctx.restore();
    }
  }
}
