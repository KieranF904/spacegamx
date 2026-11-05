/**
 * The sun lab's live performance graph: the last 30 s of what the shown option costs (ms a frame), the sun's, the
 * sky's and the planets' (every planet and moon on screen) in three plots, each against the current shader's cost (dashed), with a marker wherever something was changed,
 * and a plain readout of the last 2 s ("8.2x cheaper than current"). The numbers come from sunlab.ts's measure().
 */

export type Series = 'sun' | 'sunRef' | 'sky' | 'skyRef' | 'planet' | 'planetRef';

const WINDOW = 30;   // seconds shown
const AVERAGE = 2;   // seconds averaged for the readout
const COLORS = { sun: '#ffb347', sky: '#6fb6ff', planet: '#7fe0b0' };

interface Sample { t: number; ms: number }

/** A 1-2-5 step that gives about four gridlines up to `max` */
function niceStep(max: number): number {
  const raw = max / 4, p = Math.pow(10, Math.floor(Math.log10(raw)));
  return [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? raw;
}

export class PerfGraph {
  private samples: Record<Series, Sample[]> = { sun: [], sunRef: [], sky: [], skyRef: [], planet: [], planetRef: [] };
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

  /** A change worth seeing on the graph (an option, the system, the view, the resolution, Space held); changes made
   * together are one marker */
  mark(label: string, t = performance.now() / 1000): void {
    const last = this.marks[this.marks.length - 1];
    if (last && t - last.t < 0.4) last.label += ` · ${label}`;
    else this.marks.push({ t, label });
    while (this.marks.length && this.marks[0].t < t - WINDOW - 1) this.marks.shift();
  }

  /** A series' typical cost over the last few seconds: the median, so a stray stall doesn't skew it (null if nothing yet) */
  average(series: Series, now = performance.now() / 1000): number | null {
    const recent = this.samples[series].filter((s) => s.t > now - AVERAGE).map((s) => s.ms).sort((a, b) => a - b);
    return recent.length ? recent[Math.floor(recent.length / 2)] : null;
  }

  /** The plain line for one of the three: the option, its cost, and how it compares to the current shader */
  private line(what: string, option: string, ms: number | null, ref: number | null, color: string): string {
    const cost = ms === null ? '…' : ms < 0.0005 ? 'not drawn' : `${ms.toFixed(3)} ms`;
    let vs = '';
    if (ms !== null && ref !== null && ref > 0) {
      if (ms < 0.0005) vs = `nothing to draw (current: ${ref.toFixed(3)} ms)`;
      else {
        const k = ref / ms;
        vs = k > 0.9 && k < 1.1 ? `about the same as current (${ref.toFixed(3)} ms)`
          : k >= 1 ? `<b>${k.toFixed(1)}× cheaper</b> than current (${ref.toFixed(3)} ms)`
          : `<b class="worse">${(1 / k).toFixed(1)}× more expensive</b> than current (${ref.toFixed(3)} ms)`;
      }
    }
    return `<div class="big"><span style="color:${color}">${what}</span> ${option}<br><span class="ms">${cost}</span> ${vs}</div>`;
  }

  draw(sunOption: string, skyOption: string, planetOption: string, paused: boolean): void {
    const now = performance.now() / 1000;
    this.readout.innerHTML = (paused ? '<div class="paused">Measuring paused</div>' : '')
      + this.line('SUN', sunOption, this.average('sun', now), this.average('sunRef', now), COLORS.sun)
      + this.line('SKY', skyOption, this.average('sky', now), this.average('skyRef', now), COLORS.sky)
      + this.line('PLANETS', planetOption, this.average('planet', now), this.average('planetRef', now), COLORS.planet);

    const { canvas, ctx } = this;
    const dpr = devicePixelRatio || 1;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    if (canvas.width !== Math.round(W * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const left = 46, right = 8, gap = 30, top = 18;
    const plotH = (H - top - 2 * gap - 18) / 3;
    const x = (t: number) => left + ((t - (now - WINDOW)) / WINDOW) * (W - left - right);
    const plots: [string, Series, Series, string, number][] = [
      ['Sun, ms a frame', 'sun', 'sunRef', COLORS.sun, top],
      ['Sky, ms a frame', 'sky', 'skyRef', COLORS.sky, top + plotH + gap],
      ['Planets and moons on screen, ms a frame', 'planet', 'planetRef', COLORS.planet, top + 2 * (plotH + gap)],
    ];
    ctx.font = '11px Segoe UI, system-ui, sans-serif';
    for (const [title, s, ref, color, y0] of plots) {
      // (scaled to the 95th percentile, so a stray stall doesn't flatten everything else; it's clipped at the top)
      const visible = [...this.samples[s], ...this.samples[ref]].filter((p) => p.t > now - WINDOW).map((p) => p.ms).sort((a, b) => a - b);
      const max = Math.max(0.05, visible.length ? visible[Math.floor((visible.length - 1) * 0.95)] : 0) * 1.3;
      const step = niceStep(max);
      const y = (ms: number) => y0 + plotH - (Math.min(ms, max) / max) * plotH;
      ctx.fillStyle = '#0a0d13';
      ctx.fillRect(left, y0, W - left - right, plotH);
      // The y axis, in ms
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
      ctx.fillText(title, left + 4, y0 - 5);
      // The current shader (dashed) and the shown option
      for (const [series, dashed] of [[ref, true], [s, false]] as const) {
        const pts = this.samples[series].filter((p) => p.t > now - WINDOW - 1);
        if (pts.length < 1) continue;
        ctx.strokeStyle = dashed ? '#8a94a6' : color;
        ctx.lineWidth = dashed ? 1.5 : 2;
        ctx.setLineDash(dashed ? [5, 4] : []);
        ctx.beginPath();
        pts.forEach((p, i) => (i ? ctx.lineTo(x(p.t), y(p.ms)) : ctx.moveTo(x(p.t), y(p.ms))));
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }
    // Changes: a line through all three plots, labelled
    ctx.textAlign = 'left';
    for (const m of this.marks) {
      if (m.t < now - WINDOW) continue;
      const mx = Math.round(x(m.t)) + 0.5;
      ctx.strokeStyle = '#e8e0a0';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(mx, top); ctx.lineTo(mx, H - 16); ctx.stroke();
      // Its label on a dark tab beside the line, reading downward
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
    // The time axis
    ctx.fillStyle = '#7f8ca0';
    ctx.textAlign = 'center';
    for (let s = 0; s <= WINDOW; s += 5) ctx.fillText(s === 0 ? 'now' : `−${s} s`, x(now - s), H - 4);
    ctx.fillStyle = '#7f8ca0';
    ctx.textAlign = 'right';
    ctx.fillText('— option   - - current shader', W - right, 12);
  }
}
