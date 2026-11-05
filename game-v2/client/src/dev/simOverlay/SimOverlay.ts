/**
 * The sim overlay (dev builds only; off until switched on from the Sim tools panel (F7) or with Shift+F7).
 *
 * In the world, per ship: a cyan outlined ghost where the confirmed timeline (ST) has it, a yellow marker where the client's
 * own stepper (PT) has it, a white ring where it is drawn this frame, a line between ST and PT coloured by how far apart they are,
 * and red arrows for corrections as they land (fading in 1.5 s). Markers keep a fixed size on screen at any zoom.
 *
 * On a panel: corrections/s, re-steps/s, hash misses/s, mean and max correction size, prediction CPU a frame, drawn-hit and
 * real-hit rates, input-to-screen delay, plus the mode name and extra rows a source supplies (Stage 4's C2/C3). A number the
 * source doesn't have shows a dash. The overlay reads a SimOverlaySource and nothing else.
 */
import { worldToScreen, worldToScreenDir } from '../../rendering/cameraView';
import type { CorrectionVector, OverlayCounters, OverlayShip, PoseXY, SimOverlaySource } from './types';

const ROWS: { key: keyof OverlayCounters; label: string; unit: string; digits: number }[] = [
  { key: 'correctionsPerSec', label: 'corrections / s', unit: '', digits: 1 },
  { key: 'restepsPerSec', label: 're-steps / s (ticks)', unit: '', digits: 1 },
  { key: 'hashMissesPerSec', label: 'hash misses / s', unit: '', digits: 2 },
  { key: 'meanCorrection', label: 'correction mean', unit: ' u', digits: 2 },
  { key: 'maxCorrection', label: 'correction max', unit: ' u', digits: 2 },
  { key: 'predictionCpuMs', label: 'prediction CPU / frame', unit: ' ms', digits: 2 },
  { key: 'drawnHitsPerSec', label: 'drawn hits / s', unit: '', digits: 1 },
  { key: 'realHitsPerSec', label: 'real hits / s', unit: '', digits: 1 },
  { key: 'inputToScreenMs', label: 'input to screen (est.)', unit: ' ms', digits: 0 },
];

const FADE_MS = 1500;

export class SimOverlay {
  private canvas = document.createElement('canvas');
  private panel = document.createElement('div');
  private raf = 0;
  private on = false;
  private shown = false;
  private vectors: CorrectionVector[] = [];
  private panelAt = 0;
  /** Which parts to draw (the panel's checkboxes) */
  readonly show = { st: true, pt: true, drawn: true, lines: true, vectors: true, counters: true };
  onChange: ((on: boolean) => void) | null = null;
  private readonly onKey = (e: KeyboardEvent) => {
    if (e.code !== 'F7' || !e.shiftKey) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.setOn(!this.on);
  };

  constructor(private source: SimOverlaySource, private hooks: { attach?: () => void; detach?: () => void } = {}) {
    Object.assign(this.canvas.style, { position: 'fixed', left: '0', top: '0', width: '100vw', height: '100vh', pointerEvents: 'none', zIndex: '8400', display: 'none' });
    Object.assign(this.panel.style, {
      position: 'fixed', left: '332px', top: '70px', padding: '8px 10px', zIndex: '8500', display: 'none', pointerEvents: 'none',
      background: 'rgba(6, 12, 20, 0.82)', border: '1px solid #2c4a66', borderRadius: '6px', color: '#cfe3f5', font: '11px Consolas, monospace', whiteSpace: 'pre', lineHeight: '1.45',
    });
    this.panel.dataset.simOverlay = 'counters';
    document.body.append(this.canvas, this.panel);
    window.addEventListener('keydown', this.onKey, true);
  }

  get enabled(): boolean { return this.on; }

  setOn(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    this.canvas.style.display = on ? 'block' : 'none';
    this.panel.style.display = on && this.show.counters ? 'block' : 'none';
    if (on) { this.hooks.attach?.(); this.raf = requestAnimationFrame(this.frame); }
    else { cancelAnimationFrame(this.raf); this.hooks.detach?.(); }
    this.onChange?.(on);
  }

  private readonly frame = (): void => {
    if (!this.on) return;
    this.raf = requestAnimationFrame(this.frame);
    try { this.draw(); } catch (e) { if (!this.shown) { this.shown = true; console.error('sim overlay draw failed', e); } }
  };

  private draw(): void {
    const cam = this.source.camera();
    const dpr = window.devicePixelRatio || 1, w = Math.round(cam.width), h = Math.round(cam.height);
    if (this.canvas.width !== w * dpr || this.canvas.height !== h * dpr) { this.canvas.width = w * dpr; this.canvas.height = h * dpr; }
    const g = this.canvas.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const now = performance.now();
    const pt = (p: { x: number; y: number }) => worldToScreen(p.x, p.y, cam, w, h);

    for (const s of this.source.ships()) this.drawShip(g, s, cam, pt, w, h);

    for (const v of this.source.corrections?.() ?? []) this.vectors.push(v);
    this.vectors = this.vectors.filter((v) => now - v.at < FADE_MS);
    if (this.show.vectors) {
      for (const v of this.vectors) {
        const a = pt(v.from), b = pt(v.to), k = 1 - (now - v.at) / FADE_MS;
        g.strokeStyle = `rgba(255, 70, 70, ${k.toFixed(2)})`; g.fillStyle = g.strokeStyle; g.lineWidth = 2;
        g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
        const ang = Math.atan2(b.y - a.y, b.x - a.x);
        g.beginPath(); g.moveTo(b.x, b.y); g.lineTo(b.x - 9 * Math.cos(ang - 0.4), b.y - 9 * Math.sin(ang - 0.4)); g.lineTo(b.x - 9 * Math.cos(ang + 0.4), b.y - 9 * Math.sin(ang + 0.4)); g.closePath(); g.fill();
      }
    }
    if (now - this.panelAt > 250) { this.panelAt = now; this.writePanel(); }
  }

  private nose(a: number, cam: { angle: number }): { x: number; y: number } { return worldToScreenDir(Math.cos(a), Math.sin(a), cam.angle); }

  private marker(g: CanvasRenderingContext2D, at: { x: number; y: number }, pose: PoseXY, cam: { angle: number }, size: number, style: { stroke?: string; fill?: string }): void {
    const n = this.nose(pose.angle, cam), px = -n.y, py = n.x;
    g.beginPath();
    g.moveTo(at.x + n.x * size, at.y + n.y * size);
    g.lineTo(at.x - n.x * size * 0.7 + px * size * 0.6, at.y - n.y * size * 0.7 + py * size * 0.6);
    g.lineTo(at.x - n.x * size * 0.7 - px * size * 0.6, at.y - n.y * size * 0.7 - py * size * 0.6);
    g.closePath();
    if (style.fill) { g.fillStyle = style.fill; g.fill(); }
    if (style.stroke) { g.strokeStyle = style.stroke; g.lineWidth = 1.5; g.stroke(); }
  }

  private drawShip(g: CanvasRenderingContext2D, s: OverlayShip, cam: { angle: number }, pt: (p: { x: number; y: number }) => { x: number; y: number }, w: number, h: number): void {
    const anchor = s.pt ?? s.drawn ?? s.st;
    if (!anchor) return;
    const c = pt(anchor);
    if (c.x < -60 || c.y < -60 || c.x > w + 60 || c.y > h + 60) return;
    const size = s.own ? 13 : 10;
    const st = s.st ? pt(s.st) : null, p = s.pt ? pt(s.pt) : null, d = s.drawn ? pt(s.drawn) : null;
    if (this.show.lines && st && p) {
      const gap = Math.hypot(s.pt!.x - s.st!.x, s.pt!.y - s.st!.y);
      g.strokeStyle = gap < 2 ? 'rgba(120,255,160,0.8)' : gap < 20 ? 'rgba(255,220,90,0.9)' : 'rgba(255,90,90,0.95)';
      g.lineWidth = 1.5; g.beginPath(); g.moveTo(st.x, st.y); g.lineTo(p.x, p.y); g.stroke();
    }
    if (this.show.drawn && d) { g.strokeStyle = 'rgba(255,255,255,0.65)'; g.lineWidth = 1; g.beginPath(); g.arc(d.x, d.y, size + 5, 0, Math.PI * 2); g.stroke(); }
    if (this.show.st && st && s.st) this.marker(g, st, s.st, cam, size, { stroke: 'rgba(90,220,255,0.95)' });
    if (this.show.pt && p && s.pt) this.marker(g, p, s.pt, cam, size * 0.8, { fill: 'rgba(255,215,60,0.9)' });
    if (s.own) { g.fillStyle = 'rgba(255,255,255,0.85)'; g.font = '10px Consolas, monospace'; g.fillText('you', c.x + size + 6, c.y - size - 4); }
  }

  private writePanel(): void {
    if (!this.show.counters) { this.panel.style.display = 'none'; return; }
    this.panel.style.display = 'block';
    const c = this.source.counters();
    const lines = [`SIM OVERLAY · Shift+F7 · mode ${this.source.mode?.() ?? '-'}`, 'cyan = ST (confirmed) · yellow = PT (stepped) · ring = drawn · red = correction'];
    for (const r of ROWS) {
      const v = c[r.key];
      lines.push(`${r.label.padEnd(24)} ${typeof v === 'number' && Number.isFinite(v) ? v.toFixed(r.digits) + r.unit : '-'}`);
    }
    for (const [k, v] of Object.entries(this.source.extras?.() ?? {})) lines.push(`${k.padEnd(24)} ${v}`);
    this.panel.textContent = lines.join('\n');
  }

  destroy(): void {
    this.setOn(false);
    window.removeEventListener('keydown', this.onKey, true);
    this.canvas.remove();
    this.panel.remove();
  }
}
