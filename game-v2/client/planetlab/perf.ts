/**
 * The planet lab's live performance graph (after the sun lab's, client/sunlab/perf.ts): the last 30 s of what the shown
 * option costs (ms a frame) against the current shader (dashed), a marker wherever something was changed, and a plain
 * readout of the last 2 s ("2.8x cheaper than current"). The numbers come from planetlab.ts's measure().
 */

export type Series = 'planet' | 'planetRef';

const WINDOW = 30;
const AVERAGE = 2;
const COLOR = '#7fd0ff';

interface Sample { t: number; ms: number }

function niceStep(max: number): number {
  const raw = max / 4, p = Math.pow(10, Math.floor(Math.log10(raw)));
  return [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? raw;
}

export class PerfGraph {
  private samples: Record<Series, Sample[]> = { planet: [], planetRef: [] };
  private marks: { t: number; label: string }[] = [];
  private ctx: CanvasRenderingContext2D;

  constructor(private canvas: HTMLCanvasElement, private readout: HTMLElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  add(series: Series, ms: number, t = performance.now() / 1000): void {
    const list = this.samples[series];
    list.push({ t, ms });
    while (list.length && list[0].t < t - WINDOW - 1) list.shift();
  }

  /** A change worth seeing on the graph; changes made together are one marker */
  mark(label: string, t = performance.now() / 1000): void {
    const last = this.marks[this.marks.length - 1];
    if (last && t - last.t < 0.4) last.label += ` · ${label}`;
    else this.marks.push({ t, label });
    while (this.marks.length && this.marks[0].t < t - WINDOW - 1) this.marks.shift();
  }

  average(series: Series, now = performance.now() / 1000): number | null {
    const recent = this.samples[series].filter((s) => s.t > now - AVERAGE).map((s) => s.ms).sort((a, b) => a - b);
    return recent.length ? recent[Math.floor(recent.length / 2)] : null;
  }

  draw(option: string, paused: boolean): void {
    const now = performance.now() / 1000;
    const ms = this.average('planet', now), ref = this.average('planetRef', now);
    const cost = ms === null ? '…' : ms < 0.0005 ? 'not drawn' : `${ms.toFixed(3)} ms`;
    let vs = '';
    if (ms !== null && ref !== null && ref > 0 && ms >= 0.0005) {
      const k = ref / ms;
      vs = k > 0.9 && k < 1.1 ? `about the same as current (${ref.toFixed(3)} ms)`
        : k >= 1 ? `<b>${k.toFixed(1)}× cheaper</b> than current (${ref.toFixed(3)} ms)`
        : `<b class="worse">${(1 / k).toFixed(1)}× more expensive</b> than current (${ref.toFixed(3)} ms)`;
    }
    this.readout.innerHTML = (paused ? '<div class="paused">Measuring paused</div>' : '')
      + `<div class="big"><span style="color:${COLOR}">PLANET</span> ${option}<br><span class="ms">${cost}</span> ${vs}</div>`;

    const { canvas, ctx } = this;
    const dpr = devicePixelRatio || 1;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    if (canvas.width !== Math.round(W * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const left = 46, right = 8, top = 18, bottom = 18;
    const plotH = H - top - bottom;
    const x = (t: number) => left + ((t - (now - WINDOW)) / WINDOW) * (W - left - right);
    ctx.font = '11px Segoe UI, system-ui, sans-serif';
    const visible = [...this.samples.planet, ...this.samples.planetRef].filter((p) => p.t > now - WINDOW).map((p) => p.ms).sort((a, b) => a - b);
    const max = Math.max(0.02, visible.length ? visible[Math.floor((visible.length - 1) * 0.95)] : 0) * 1.3;
    const step = niceStep(max);
    const y = (v: number) => top + plotH - (Math.min(v, max) / max) * plotH;
    ctx.fillStyle = '#0a0d13';
    ctx.fillRect(left, top, W - left - right, plotH);
    ctx.strokeStyle = '#1d2532';
    ctx.fillStyle = '#7f8ca0';
    ctx.textAlign = 'right';
    ctx.lineWidth = 1;
    for (let v = 0; v <= max + 1e-9; v += step) {
      ctx.beginPath(); ctx.moveTo(left, y(v) + 0.5); ctx.lineTo(W - right, y(v) + 0.5); ctx.stroke();
      ctx.fillText(step < 0.01 ? v.toFixed(3) : step < 0.1 ? v.toFixed(2) : v.toFixed(1), left - 4, y(v) + 4);
    }
    ctx.textAlign = 'left';
    ctx.fillStyle = '#c9d3e0';
    ctx.fillText('Planet, ms a frame', left + 4, top - 5);
    for (const [series, dashed] of [['planetRef', true], ['planet', false]] as const) {
      const pts = this.samples[series].filter((p) => p.t > now - WINDOW - 1);
      if (pts.length < 1) continue;
      ctx.strokeStyle = dashed ? '#8a94a6' : COLOR;
      ctx.lineWidth = dashed ? 1.5 : 2;
      ctx.setLineDash(dashed ? [5, 4] : []);
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(x(p.t), y(p.ms)) : ctx.moveTo(x(p.t), y(p.ms))));
      ctx.stroke();
    }
    ctx.setLineDash([]);
    for (const m of this.marks) {
      if (m.t < now - WINDOW) continue;
      const mx = Math.round(x(m.t)) + 0.5;
      ctx.strokeStyle = '#e8e0a0';
      ctx.beginPath(); ctx.moveTo(mx, top); ctx.lineTo(mx, H - bottom + 2); ctx.stroke();
      ctx.save();
      ctx.translate(mx + 2, top + 2);
      ctx.rotate(Math.PI / 2);
      const tw = Math.min(ctx.measureText(m.label).width, H - top - 22);
      ctx.fillStyle = 'rgba(10, 13, 19, 0.85)';
      ctx.fillRect(-1, -13, tw + 6, 15);
      ctx.fillStyle = '#e8e0a0';
      ctx.fillText(m.label, 2, -2, H - top - 26);
      ctx.restore();
    }
    ctx.fillStyle = '#7f8ca0';
    ctx.textAlign = 'center';
    for (let s = 0; s <= WINDOW; s += 5) ctx.fillText(s === 0 ? 'now' : `−${s} s`, x(now - s), H - 4);
    ctx.textAlign = 'right';
    ctx.fillText('— option   - - current shader', W - right, 12);
  }
}
