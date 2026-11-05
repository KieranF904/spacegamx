/**
 * Performance monitor (Settings > Performance monitor, setting key ui.netStats).
 * One panel: FPS and frame time (with worst / p95 over the last few seconds) and a frame-time graph with 16.7 ms and
 * 33 ms reference lines, ping and jitter with their graph, entities, graphics tier and network rates.
 * Click the header to fold it to a one-line strip (remembered); drag the header to move it (remembered).
 * Cost: nothing is sampled or drawn while hidden; while shown the graphs redraw every frame (not tied to the Low/Medium
 * HUD throttling) and the numbers refresh a few times a second.
 */

const FRAME_SAMPLES = 300; // about five seconds at 60 fps
const LS_FOLD = 'sg.perfMonitor.compact';
const LS_POS = 'sg.perfMonitor.pos';

export interface PerfSource {
  ping: number;
  jitter: number;
  pingHistory: number[];
  jitterHistory: number[];
  /** Seconds between ping samples */
  pingEvery: number;
  entities: number;
  tier: string;
  /** Server processing time, ms (undefined until a pong carries it) */
  serverMs?: number;
  /** "↓ 1.2 KB/s (20/s) ↑ 0.3 KB/s" */
  net: string;
}

const FRAME_COLOR = '#7dd3fc';
const PING_COLOR = '#7dd3fc';
const JITTER_COLOR = '#fbbf24';
const WARN = '#fbbf24';
const BAD = '#f87171';
const GOOD = '#86efac';

const CSS = `
#perfMon { position: absolute; z-index: 30; width: 330px; box-sizing: border-box; display: none; user-select: none;
  background: linear-gradient(180deg, rgba(14, 22, 40, 0.88), rgba(7, 12, 24, 0.88)); border: 1px solid rgba(120, 150, 200, 0.25);
  border-radius: 10px; box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45); color: #d6deeb; font: 13px 'Segoe UI', system-ui, sans-serif;
  font-variant-numeric: tabular-nums; pointer-events: auto; }
#perfMon .pm-head { display: flex; align-items: center; gap: 10px; padding: 7px 10px; cursor: pointer; border-radius: 10px; }
#perfMon .pm-head:hover { background: rgba(125, 211, 252, 0.07); }
#perfMon .pm-title { font: 700 12px 'Segoe UI', sans-serif; letter-spacing: 3px; color: #7dd3fc; text-transform: uppercase; }
#perfMon .pm-sum { flex: 1; text-align: right; color: #d6deeb; white-space: nowrap; }
#perfMon .pm-caret { color: #8fa0b8; font-size: 11px; width: 10px; text-align: center; }
#perfMon .pm-body { padding: 2px 10px 10px; border-top: 1px solid rgba(140, 170, 220, 0.14); }
#perfMon canvas.pm-ping { height: 64px; }
#perfMon.compact .pm-body { display: none; }
#perfMon .pm-sec { display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px; margin: 8px 0 3px; }
#perfMon .pm-sec b { white-space: nowrap; font-size: 12px; letter-spacing: 1.5px; color: #8fa0b8; text-transform: uppercase; font-weight: 600; }
#perfMon .pm-sec .big { font-size: 17px; font-weight: 600; color: #fff; }
#perfMon .pm-sec .sp { flex: 1; }
#perfMon .pm-sec .sub { color: #a9b8cf; font-size: 12.5px; white-space: nowrap; }
#perfMon canvas { display: block; position: static; z-index: auto; width: 100%; height: 76px; border-radius: 6px; background: rgba(4, 8, 18, 0.7); border: 1px solid rgba(120, 160, 220, 0.18); }
#perfMon .pm-foot { margin-top: 8px; color: #a9b8cf; font-size: 12.5px; display: flex; flex-wrap: wrap; gap: 2px 14px; }
#perfMon .pm-foot span b { color: #d6deeb; font-weight: 600; }
`;

function lsGet(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k: string, v: string): void { try { localStorage.setItem(k, v); } catch { /* unavailable */ } }

export class PerfMonitor {
  private root: HTMLDivElement;
  private frameCv: HTMLCanvasElement;
  private pingCv: HTMLCanvasElement;
  private fctx: CanvasRenderingContext2D | null;
  private pctx: CanvasRenderingContext2D | null;
  private el: Record<string, HTMLElement> = {};
  private frames = new Float32Array(FRAME_SAMPLES);
  private n = 0; // samples taken (ring)
  private visible = false;
  private lastText = 0;
  private sorted = new Float32Array(FRAME_SAMPLES);
  private fpsT = 0;
  private fpsN = 0;
  private fps = 0;
  private dpr = 1;
  private pos: { x: number; y: number } | null = null;

  constructor(parent: HTMLElement, private source: () => PerfSource) {
    if (!document.getElementById('perfMonStyle')) {
      const st = document.createElement('style');
      st.id = 'perfMonStyle';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    const root = this.root = document.createElement('div');
    root.id = 'perfMon';
    root.innerHTML = `
      <div class="pm-head" title="Click to fold or unfold, drag to move">
        <span class="pm-title">Performance</span>
        <span class="pm-sum" data-k="sum"></span>
        <span class="pm-caret" data-k="caret"></span>
      </div>
      <div class="pm-body">
        <div class="pm-sec"><b>Frame ms</b><span class="big" data-k="fps" style="white-space:nowrap"></span><span class="sp"></span><span class="sub" data-k="ft"></span></div>
        <canvas data-k="fcv"></canvas>
        <div class="pm-sec"><b>Ping ms</b><span class="big" data-k="ping"></span><span class="sp"></span><span class="sub" data-k="jit"></span></div>
        <canvas class="pm-ping" data-k="pcv"></canvas>
        <div class="pm-foot" data-k="foot"></div>
      </div>`;
    parent.appendChild(root);
    root.querySelectorAll<HTMLElement>('[data-k]').forEach((e) => { this.el[e.dataset.k!] = e; });
    this.frameCv = this.el.fcv as HTMLCanvasElement;
    this.pingCv = this.el.pcv as HTMLCanvasElement;
    this.fctx = this.frameCv.getContext('2d');
    this.pctx = this.pingCv.getContext('2d');

    this.setCompact(lsGet(LS_FOLD) === '1');
    try {
      const p = JSON.parse(lsGet(LS_POS) ?? 'null');
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) this.pos = { x: p.x, y: p.y };
    } catch { /* ignore */ }
    this.place();
    this.wireHead(root.querySelector('.pm-head') as HTMLElement);
    window.addEventListener('resize', () => this.place());
  }

  /** Click folds, drag moves (and is remembered) */
  private wireHead(head: HTMLElement): void {
    let down: { px: number; py: number; ox: number; oy: number; moved: boolean } | null = null;
    head.addEventListener('pointerdown', (e) => {
      const r = this.root.getBoundingClientRect();
      const pr = (this.root.offsetParent as HTMLElement | null)?.getBoundingClientRect();
      down = { px: e.clientX, py: e.clientY, ox: r.left - (pr?.left ?? 0), oy: r.top - (pr?.top ?? 0), moved: false };
      head.setPointerCapture(e.pointerId);
    });
    head.addEventListener('pointermove', (e) => {
      if (!down) return;
      const dx = e.clientX - down.px, dy = e.clientY - down.py;
      if (!down.moved && Math.hypot(dx, dy) < 5) return;
      down.moved = true;
      this.pos = { x: down.ox + dx, y: down.oy + dy };
      this.place();
    });
    head.addEventListener('pointerup', () => {
      if (!down) return;
      if (down.moved) lsSet(LS_POS, JSON.stringify(this.pos));
      else this.setCompact(!this.root.classList.contains('compact'));
      down = null;
    });
    head.addEventListener('dblclick', () => { // reset to the default spot
      this.pos = null;
      try { localStorage.removeItem(LS_POS); } catch { /* ignore */ }
      this.place();
    });
  }

  /** Default: top, left of the minimap and the quest tracker, clear of the pilot panels and the nav marker row; a dragged spot is kept inside the window */
  private place(): void {
    const s = this.root.style;
    const parent = (this.root.offsetParent as HTMLElement | null) ?? this.root.parentElement;
    if (!this.pos) { s.left = 'auto'; s.right = '296px'; s.top = '52px'; return; }
    s.right = 'auto';
    const W = parent?.clientWidth || window.innerWidth, H = parent?.clientHeight || window.innerHeight;
    const w = this.root.offsetWidth || 330, h = this.root.offsetHeight || 40;
    s.left = `${Math.max(0, Math.min(W - w, this.pos.x))}px`;
    s.top = `${Math.max(0, Math.min(H - Math.min(h, 40), this.pos.y))}px`;
  }

  private setCompact(on: boolean): void {
    this.root.classList.toggle('compact', on);
    this.el.caret.textContent = on ? '▸' : '▾';
    lsSet(LS_FOLD, on ? '1' : '0');
    this.place();
  }

  setVisible(v: boolean): void {
    if (v === this.visible) return;
    this.visible = v;
    this.root.style.display = v ? 'block' : 'none';
    if (v) { this.n = 0; this.fpsN = 0; this.fpsT = 0; this.lastText = 0; this.place(); }
  }

  /** Called every game frame with the frame's duration in ms (does nothing while hidden) */
  frame(ms: number, now: number): void {
    if (!this.visible) return;
    this.frames[this.n % FRAME_SAMPLES] = ms;
    this.n++;
    this.fpsN++;
    if (now - this.fpsT >= 500) {
      this.fps = this.fpsT ? (this.fpsN * 1000) / (now - this.fpsT) : 0;
      this.fpsT = now;
      this.fpsN = 0;
    }
    const compact = this.root.classList.contains('compact');
    if (now - this.lastText >= 250) { this.lastText = now; this.text(compact); }
    if (!compact) { this.drawFrames(); this.drawPing(); }
  }

  /** Newest-last copy of the frame samples */
  private window(): Float32Array {
    const k = Math.min(this.n, FRAME_SAMPLES);
    const out = this.sorted.subarray(0, k);
    for (let i = 0; i < k; i++) out[i] = this.frames[(this.n - k + i) % FRAME_SAMPLES];
    return out;
  }

  private text(compact: boolean): void {
    const src = this.source();
    const k = Math.min(this.n, FRAME_SAMPLES);
    const fps = Math.round(this.fps);
    const avg = k ? this.avg(k) : 0;
    const fcol = fps >= 55 ? GOOD : fps >= 30 ? WARN : BAD;
    const pcol = src.ping < 80 ? GOOD : src.ping < 160 ? WARN : BAD;
    this.el.sum.innerHTML = `<span style="color:${fcol}">${fps} FPS</span> &middot; <span style="color:${pcol}">${src.ping} ms</span>`;
    if (compact) return;
    const w = this.window();
    let worst = 0;
    for (let i = 0; i < w.length; i++) if (w[i] > worst) worst = w[i];
    const sorted = Float32Array.from(w).sort();
    const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0;
    this.el.fps.innerHTML = `<span style="color:${fcol}">${fps}</span> FPS · ${avg.toFixed(1)} ms`;
    this.el.ft.textContent = `worst ${worst.toFixed(1)} · p95 ${p95.toFixed(1)}`;
    this.el.ping.innerHTML = `<span style="color:${pcol}">${src.ping}</span> ms`;
    this.el.jit.textContent = `jitter ${src.jitter} ms${src.serverMs !== undefined ? ` · server ${src.serverMs} ms` : ''}`;
    this.el.foot.innerHTML = `<span>Entities <b>${src.entities}</b></span><span>Quality <b>${src.tier}</b></span>${src.net ? `<span>${src.net}</span>` : ''}`;
  }

  private avg(k: number): number {
    let s = 0;
    for (let i = 0; i < k; i++) s += this.frames[i];
    return s / k;
  }

  /** Match the canvas backing store to its CSS size and the device pixel ratio */
  private fit(cv: HTMLCanvasElement, ctx: CanvasRenderingContext2D): { w: number; h: number } | null {
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return null;
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    const bw = Math.round(w * this.dpr), bh = Math.round(h * this.dpr);
    if (cv.width !== bw || cv.height !== bh) { cv.width = bw; cv.height = bh; }
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { w, h };
  }

  private drawFrames(): void {
    const ctx = this.fctx;
    if (!ctx) return;
    const sz = this.fit(this.frameCv, ctx);
    if (!sz) return;
    const { w, h } = sz;
    const L = 34, R = 6, T = 8, B = 16;
    const pw = w - L - R, ph = h - T - B;
    const data = this.window();
    let top = 20;
    for (let i = 0; i < data.length; i++) if (data[i] > top) top = data[i];
    const max = top <= 40 ? 40 : top <= 70 ? 70 : top <= 120 ? 120 : Math.ceil(top / 100) * 100;
    const y = (v: number) => T + ph - (Math.min(v, max) / max) * ph;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    // reference lines: 60 fps and 30 fps budgets
    for (const [v, col, label] of [[16.7, 'rgba(134,239,172,0.55)', '16.7'], [33.3, 'rgba(251,191,36,0.55)', '33']] as const) {
      if (v > max) continue;
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = col;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(L, y(v)); ctx.lineTo(w - R, y(v)); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = col.replace('0.55', '0.95');
      ctx.textAlign = 'right';
      ctx.fillText(label, L - 4, y(v));
    }
    ctx.fillStyle = 'rgba(180,200,230,0.75)';
    ctx.textAlign = 'right';
    ctx.fillText('0', L - 4, y(0));
    if (max > 40) ctx.fillText(`${max}`, L - 4, y(max) + 4);
    ctx.fillStyle = 'rgba(180,200,230,0.6)';
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillText('-5 s', L, h - 3);
    ctx.textAlign = 'right';
    ctx.fillText('now', w - R, h - 3);
    if (data.length < 2) return;
    const step = pw / (FRAME_SAMPLES - 1);
    const x0 = L + pw - (data.length - 1) * step;
    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = x0 + i * step;
      i ? ctx.lineTo(x, y(data[i])) : ctx.moveTo(x, y(data[i]));
    }
    ctx.strokeStyle = FRAME_COLOR;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  private drawPing(): void {
    const ctx = this.pctx;
    if (!ctx) return;
    const src = this.source();
    const pd = src.pingHistory, jd = src.jitterHistory;
    const sz = this.fit(this.pingCv, ctx);
    if (!sz) return;
    const { w, h } = sz;
    const L = 34, R = 6, T = 8, B = 16;
    const pw = w - L - R, ph = h - T - B;
    let top = 40;
    for (const v of pd) if (v > top) top = v;
    for (const v of jd) if (v > top) top = v;
    const nice = [40, 80, 160, 320, 640, 1280];
    const max = nice.find((n) => top <= n) ?? Math.ceil(top / 500) * 500;
    const y = (v: number) => T + ph - (Math.min(v, max) / max) * ph;
    ctx.font = '11px system-ui, sans-serif';
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let g = 0; g <= 2; g++) {
      const v = (max / 2) * g;
      ctx.strokeStyle = g === 0 ? 'rgba(120,160,220,0.3)' : 'rgba(120,160,220,0.16)';
      ctx.beginPath(); ctx.moveTo(L, y(v)); ctx.lineTo(w - R, y(v)); ctx.stroke();
      ctx.fillStyle = 'rgba(180,200,230,0.75)';
      ctx.fillText(`${v}`, L - 4, y(v));
    }
    ctx.setLineDash([]);
    ctx.textBaseline = 'alphabetic';
    // legend
    ctx.textAlign = 'right';
    ctx.fillStyle = JITTER_COLOR; ctx.fillText('jitter', w - R, 10);
    ctx.fillStyle = PING_COLOR; ctx.fillText('ping   ', w - R - ctx.measureText('jitter  ').width, 10);
    // time axis: the history is ping samples, newest last
    const span = Math.max(1, (pd.length - 1) * src.pingEvery);
    ctx.fillStyle = 'rgba(180,200,230,0.6)';
    ctx.textAlign = 'left';
    ctx.fillText(span >= 90 ? `-${Math.round(span / 60)} min` : `-${Math.round(span)} s`, L, h - 3);
    ctx.textAlign = 'right';
    ctx.fillText('now', w - R, h - 3);
    if (pd.length < 2) {
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(180,200,230,0.6)';
      ctx.fillText('collecting samples…', L + pw / 2, T + ph / 2);
      return;
    }
    const step = pw / Math.max(1, pd.length - 1);
    const line = (d: number[], col: string, lw: number, fill?: string) => {
      ctx.beginPath();
      for (let i = 0; i < d.length; i++) i ? ctx.lineTo(L + i * step, y(d[i])) : ctx.moveTo(L, y(d[i]));
      if (fill) {
        ctx.lineTo(L + (d.length - 1) * step, y(0)); ctx.lineTo(L, y(0)); ctx.closePath();
        ctx.fillStyle = fill; ctx.fill();
        ctx.beginPath();
        for (let i = 0; i < d.length; i++) i ? ctx.lineTo(L + i * step, y(d[i])) : ctx.moveTo(L, y(d[i]));
      }
      ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.lineJoin = 'round'; ctx.stroke();
    };
    line(jd, JITTER_COLOR, 1.5, 'rgba(251,191,36,0.12)');
    line(pd, PING_COLOR, 2);
    ctx.beginPath();
    ctx.arc(L + (pd.length - 1) * step, y(pd[pd.length - 1]), 3.5, 0, Math.PI * 2);
    ctx.fillStyle = PING_COLOR;
    ctx.fill();
  }
}
