// One design in progress: the live assembly grid beside the rendered still (or a timelapse of its build-up).
import { drawGrid, gridLinesOf, parseGrid } from './grid.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export class Pane {
  constructor(parent, title, legend) {
    this.legend = legend;
    this.el = document.createElement('div');
    this.el.className = 'pane';
    this.el.innerHTML = `
      <div class="paneHead"><b class="title">${esc(title)}</b><span class="lane muted"></span><span class="grow"></span><span class="score muted"></span></div>
      <div class="paneBody">
        <div class="view"><canvas></canvas><span class="tag">assembly</span><div class="empty">waiting for the model</div></div>
        <div class="view still"><img alt=""><span class="tag">render</span><div class="empty">no still yet</div></div>
      </div>
      <div class="paneFoot"></div>`;
    parent.appendChild(this.el);
    this.canvas = this.el.querySelector('canvas');
    this.img = this.el.querySelector('.still img');
    this.img.hidden = true;
    this.reset();
    new ResizeObserver(() => this.draw()).observe(this.canvas);
  }

  reset() {
    this.tokens = ''; this.cells = new Map(); this.prev = null; this.final = null; this.overlay = null; this.round = 0; this.pending = false;
    this.stopLapse?.();
  }

  set(sel, text) { this.el.querySelector(sel).textContent = text; }
  foot(text) { this.set('.paneFoot', text); }

  /** A new round: last round's final grid becomes what changes are measured against */
  newRound(round, lane) {
    if (this.final?.size) this.prev = this.final;
    this.final = null; this.overlay = null; this.tokens = ''; this.round = round;
    this.set('.lane', `${lane ? `${lane} · ` : ''}round ${round}`);
    this.foot('asking the model...');
  }

  token(text) {
    this.tokens += text;
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      const cells = parseGrid(gridLinesOf(this.tokens));
      if (cells.size) { this.cells = cells; this.draw(); }
      this.foot(`streaming: ${this.tokens.length} chars, ${cells.size} cells so far`);
    });
  }

  gridFinal(text) {
    this.cells = text ? parseGrid(gridLinesOf(text)) : new Map();
    this.final = this.cells;
    this.draw();
  }

  check(result, cells) { this.overlay = { result, cells }; this.draw(); }

  /** Shows a design outright (a library ship, a gallery pick) */
  show(gridText, result, cells, url, title) {
    this.reset();
    if (title) this.set('.title', title);
    this.set('.lane', '');
    this.gridFinal(gridText);
    this.final = this.cells;
    if (result) this.check(result, cells);
    this.still(url);
  }

  still(url) {
    this.stopLapse?.();
    const empty = this.el.querySelector('.still .empty');
    if (!url) { this.img.hidden = true; empty.hidden = false; return; }
    this.img.src = url; this.img.hidden = false; empty.hidden = true;
  }

  score(text) { this.set('.score', text); }

  draw() {
    this.el.querySelector('.view .empty').hidden = this.cells.size > 0;
    drawGrid(this.canvas, this.cells, { legend: this.legend, prev: this.prev, overlay: this.overlay });
  }

  /** Plays timelapse frames in the still's place */
  lapse(frames, dir) {
    this.stopLapse?.();
    const view = this.el.querySelector('.still');
    const hadStill = !!this.img.getAttribute('src') && !this.img.hidden;
    const bar = document.createElement('div');
    bar.className = 'player';
    bar.innerHTML = `<button class="pp">pause</button><input type="range" min="0" max="${frames.length - 1}" value="0"><span class="st"></span><button class="x">close</button>`;
    view.appendChild(bar);
    view.querySelector('.empty').hidden = true;
    this.img.hidden = false;
    // (Preload, then step)
    for (const f of frames) { const i = new Image(); i.src = f.url; }
    let i = 0, playing = true;
    const slider = bar.querySelector('input'), st = bar.querySelector('.st'), pp = bar.querySelector('.pp');
    const show = () => { this.img.src = frames[i].url; slider.value = String(i); st.textContent = `${i + 1}/${frames.length} ${frames[i].stage}`; };
    const timer = setInterval(() => { if (!playing) return; i = (i + 1) % frames.length; if (i === 0) { playing = false; pp.textContent = 'play'; i = frames.length - 1; } show(); }, 140);
    pp.onclick = () => { playing = !playing; if (playing && i === frames.length - 1) i = 0; pp.textContent = playing ? 'pause' : 'play'; };
    slider.oninput = () => { playing = false; pp.textContent = 'play'; i = Number(slider.value); show(); };
    const last = this.img.src;
    this.stopLapse = () => {
      clearInterval(timer); bar.remove(); this.stopLapse = null;
      if (hadStill) this.img.src = last; else { this.img.hidden = true; view.querySelector('.empty').hidden = false; }
    };
    bar.querySelector('.x').onclick = () => this.stopLapse();
    show();
    this.foot(`timelapse: ${frames.length} frames saved in ${dir}`);
  }
}
