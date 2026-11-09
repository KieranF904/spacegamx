/**
 * @contract client.ui.tutorial.markers
 * owns:       the lesson's world-space marks, drawn on one pointer-transparent canvas over the game: rings, the stop zone and the
 *             exit marker (bright for this step; later steps' are not drawn), a pulse on the current step's targets, and a
 *             screen-edge arrow towards a target that is off screen (also the nearest belt rock on the mining step)
 * needs:      tutorialModel (markerStyle, arrowTargets, edgeArrow, ringArrow), the renderer's worldToScreen, common objectPos
 * invariants: what is bright, faint or hidden is decided in tutorialModel.ts — client/src/ui/tutorial/tutorialModel.test.ts
 * extend:     a new kind of mark is a case in draw(); its rule is a function in tutorialModel.ts
 */

import { objectPos } from '@space-game/common';
import type { ServerTutorialStateMessage, TutorialData, TutorialObjectDef } from '@space-game/common';
import { arrowTargets, distLabel, edgeArrow, markerStyle, pointsAtBelt, pointsAtStation, ringArrow } from './tutorialModel';

export interface MarkerDeps {
  data: TutorialData;
  worldToScreen(x: number, y: number): { x: number; y: number };
  /** The pilot's ship, world position */
  me(): { x: number; y: number } | null;
  /** The yard station, world position and body radius (the dock step points at it) */
  station(): { x: number; y: number; radius: number } | null;
  /** The belt rock nearest the pilot (the mining step points at it) */
  nearestRock(): { x: number; y: number; radius: number } | null;
}

const AMBER = '251, 191, 36';
const BLUE = '125, 211, 252';
const GREEN = '74, 222, 128';
/** A burst on a ring just flown through lasts this long (s) */
const BURST_S = 0.8;

export class TutorialMarkers {
  private cv = document.createElement('canvas');
  private ctx = this.cv.getContext('2d');
  private hidden = false;
  private passedSeen = new Set<string>();
  private bursts: { id: string; t0: number }[] = [];

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
    if (!s || s.left) { this.passedSeen.clear(); this.bursts = []; return; }
    const step = this.d.data.steps.find((x) => x.id === s.step);
    const t = performance.now() / 1000;
    // A ring newly passed bursts once (a fresh step starts the count over without bursting)
    const now = new Set(s.passed ?? []);
    for (const id of now) if (!this.passedSeen.has(id) && this.passedSeen.size + 1 === now.size) this.bursts.push({ id, t0: t });
    this.passedSeen = now;
    this.bursts = this.bursts.filter((b) => t - b.t0 < BURST_S);
    for (const o of this.d.data.objects) {
      const style = markerStyle(o, s, step, this.d.data);
      if (style) this.mark(ctx, o, style, t);
    }
    for (const b of this.bursts) {
      const o = this.d.data.objects.find((x) => x.id === b.id);
      if (o) this.burst(ctx, o, (t - b.t0) / BURST_S);
    }
    // Arrows to this step's targets that are off screen (and a bobbing one over those on screen)
    const me = this.d.me();
    for (const o of arrowTargets(this.d.data, s, step)) {
      const p = objectPos(this.d.data, o);
      const sp = this.d.worldToScreen(p.x, p.y);
      const a = edgeArrow(sp.x, sp.y, w, h, 46);
      if (a.onScreen) this.pointer(ctx, sp.x, sp.y - this.screenRadius(o) - 14 - Math.sin(t * 4) * 4, o.label);
      else this.edge(ctx, ringArrow(sp.x, sp.y, w, h), me ? Math.hypot(p.x - me.x, p.y - me.y) : 0, o.label);
    }
    // The mining step: the nearest rock of the yard's belt
    const rock = pointsAtBelt(step) ? this.d.nearestRock() : null;
    if (rock) {
      const sp = this.d.worldToScreen(rock.x, rock.y);
      const a = edgeArrow(sp.x, sp.y, w, h, 46);
      const rs = Math.max(20, Math.hypot(this.d.worldToScreen(rock.x + rock.radius, rock.y).x - sp.x, this.d.worldToScreen(rock.x + rock.radius, rock.y).y - sp.y));
      if (a.onScreen) this.pointer(ctx, sp.x, sp.y - rs - 14 - Math.sin(t * 4) * 4, 'Mine here');
      else this.edge(ctx, ringArrow(sp.x, sp.y, w, h), me ? Math.hypot(rock.x - me.x, rock.y - me.y) : 0, 'Belt');
    }
    // The dock step: the yard station is no training object, so it is marked from its own position
    const st = pointsAtStation(step) ? this.d.station() : null;
    if (st) {
      const sp = this.d.worldToScreen(st.x, st.y);
      const a = edgeArrow(sp.x, sp.y, w, h, 46);
      const rs = Math.max(30, Math.hypot(this.d.worldToScreen(st.x + st.radius, st.y).x - sp.x, this.d.worldToScreen(st.x + st.radius, st.y).y - sp.y));
      if (a.onScreen) this.pointer(ctx, sp.x, sp.y - rs - 14 - Math.sin(t * 4) * 4, 'Yard station');
      else this.edge(ctx, ringArrow(sp.x, sp.y, w, h), me ? Math.hypot(st.x - me.x, st.y - me.y) : 0, 'Yard station');
    }
  }

  /** The small flash on a ring just passed: an expanding green ring and a tick */
  private burst(ctx: CanvasRenderingContext2D, o: TutorialObjectDef, k: number): void {
    const p = objectPos(this.d.data, o);
    const c = this.d.worldToScreen(p.x, p.y);
    const r = this.screenRadius(o);
    ctx.save();
    ctx.strokeStyle = `rgba(${GREEN}, ${0.9 * (1 - k)})`;
    ctx.lineWidth = 4 * (1 - k) + 1;
    ctx.beginPath();
    ctx.arc(c.x, c.y, r * (0.8 + 0.7 * k), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  private screenRadius(o: TutorialObjectDef): number {
    const p = objectPos(this.d.data, o);
    const a = this.d.worldToScreen(p.x, p.y), b = this.d.worldToScreen(p.x + o.radius, p.y);
    return Math.max(10, Math.hypot(b.x - a.x, b.y - a.y));
  }

  private mark(ctx: CanvasRenderingContext2D, o: TutorialObjectDef, style: 'active' | 'passed' | 'upcoming', t: number): void {
    const active = style === 'active', passed = style === 'passed';
    const p = objectPos(this.d.data, o);
    const c = this.d.worldToScreen(p.x, p.y);
    const r = this.screenRadius(o);
    if (c.x < -r || c.y < -r || c.x > window.innerWidth + r || c.y > window.innerHeight + r) return;
    const col = passed ? GREEN : o.kind === 'zone' ? BLUE : AMBER;
    const pulse = active ? 0.55 + 0.35 * Math.sin(t * 3) : 0;
    ctx.save();
    ctx.lineWidth = active ? 3 : passed ? 2.5 : 1.5;
    ctx.strokeStyle = `rgba(${col}, ${active ? 0.55 + pulse * 0.4 : passed ? 0.7 : 0.22})`;
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
    if (passed) {
      // A tick in the middle
      ctx.setLineDash([]);
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = `rgba(${GREEN}, 0.9)`;
      const u = Math.min(r * 0.3, 26);
      ctx.beginPath();
      ctx.moveTo(c.x - u, c.y + u * 0.05);
      ctx.lineTo(c.x - u * 0.3, c.y + u * 0.7);
      ctx.lineTo(c.x + u, c.y - u * 0.7);
      ctx.stroke();
    } else if (o.label && (active || r > 40)) {
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
      const text = [label, dist > 0 ? distLabel(dist) : ''].filter(Boolean).join(' · ');
      // Inward of the arrow
      ctx.fillText(text, a.x - Math.cos(a.angle) * 34, a.y - Math.sin(a.angle) * 22 + 4);
      ctx.restore();
    }
  }
}
