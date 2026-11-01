/**
 * The ship status readout in the top-left ship panel (ships/ShipHud.ts hosts it): a two-line summary under the CORE
 * bar (shield and stored energy, always shown) and a details column beside the schematic (energy generation against
 * draw and each store, shield state, hull, each weapon group, thrust and part features' lines), folded with its
 * button (remembered in localStorage). It draws a ShipStatus (source.ts: the only place that reads the game's data).
 *
 * The DOM is built once per layout (how many weapon groups, stores and feature lines) and then rewritten through
 * domWrite, so an unchanged value writes nothing.
 */

import { setStyle, setText } from '../domWrite';
import type { ShipStatus, Tone } from './source';

const CSS = `
.ss-sum { margin: -2px 0 6px; }
.ss-row { display: flex; align-items: center; gap: 6px; height: 15px; }
.ss-k { width: 34px; color: #8ea0bd; font-size: 11px; }
.ss-bar { flex: 1; height: 5px; background: #1b2333; border-radius: 3px; overflow: hidden; position: relative; }
.ss-bar > i { position: absolute; left: 0; top: 0; bottom: 0; width: 0; border-radius: 3px; transition: width 0.1s linear; }
.ss-v { min-width: 44px; text-align: right; font-size: 11px; font-variant-numeric: tabular-nums; }
.ss-row.brown .ss-bar { animation: ss-flash 0.35s steps(2) infinite; }
@keyframes ss-flash { 0% { background: rgba(239, 68, 68, 0.55); } 100% { background: rgba(239, 68, 68, 0.12); } }
.ss-fold { all: unset; pointer-events: auto; cursor: pointer; float: right; color: #8ea0bd; font-size: 11px; padding: 0 4px; border-radius: 4px; }
.ss-fold:hover { color: #fff; background: rgba(255, 255, 255, 0.08); }
/* (Beside the ship panel, its own box: it may run taller than the ship panel without covering the pilot panel below) */
.ss-det { position: absolute; left: calc(100% + 6px); top: -1px; width: 196px; padding: 8px 10px 9px; font-size: 11px; line-height: 15px;
  background: rgba(8, 12, 22, 0.82); border: 1px solid rgba(120, 150, 200, 0.35); border-radius: 8px; }
.ss-h { color: #6f82a1; font-size: 10px; letter-spacing: 1.5px; margin: 6px 0 1px; display: flex; justify-content: space-between; }
.ss-h:first-child { margin-top: 0; }
.ss-h [data-q] { letter-spacing: 0; font-size: 11px; }
.ss-l { display: flex; justify-content: space-between; gap: 6px; white-space: nowrap; }
.ss-l > span:first-child { overflow: hidden; text-overflow: ellipsis; color: #b6c3d7; }
.ss-l b { font-weight: 700; }
.ss-warn { display: none; margin: 2px 0; padding: 0 4px; border-radius: 3px; background: rgba(239, 68, 68, 0.2); color: #fca5a5; font-weight: 700; letter-spacing: 1px; }
.ss-stores { display: flex; gap: 4px; margin-top: 3px; }
.ss-st { flex: 1; display: flex; flex-direction: column; gap: 1px; align-items: stretch; font-size: 9px; text-align: center; }
.ss-st .ss-bar { flex: none; height: 4px; }
.ss-st.brown .ss-bar { animation: ss-flash 0.35s steps(2) infinite; }
.ss-wb { height: 2px; margin: 0 0 2px; }
.ss-dim { color: #6f82a1; }
`;

const TONE: Record<Tone, string> = { ok: '#4ade80', busy: '#7dd3fc', warn: '#fbbf24', bad: '#f87171', dim: '#64748b' };
const STORE_COLOR = { pool: '#64b4ff', cap: '#fbbf24', drive: '#60a5fa' } as const;
const STORE_TAG = { pool: 'CORE', cap: 'CAP', drive: 'DRV' } as const;
const FOLD_KEY = 'sg.shipStatus.open';
/** The most weapon groups listed (the column stays clear of the cargo panel below) */
const MAX_WEAPONS = 4;

let styled = false;
function injectStyle(): void {
  if (styled) return;
  styled = true;
  const s = document.createElement('style');
  s.textContent = CSS;
  document.head.appendChild(s);
}

/** A number of E/s, short */
export function rate(v: number): string {
  return Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1);
}

interface WeaponEls { name: HTMLElement; state: HTMLElement; extra: HTMLElement; bar: HTMLElement; fill: HTMLElement }
interface StoreEls { root: HTMLElement; fill: HTMLElement }
interface FeatEls { label: HTMLElement; text: HTMLElement; bar: HTMLElement; fill: HTMLElement }

export class StatusPanel {
  /** The summary rows (under the CORE bar) and the details column (beside the schematic) */
  readonly summary: HTMLDivElement;
  readonly details: HTMLDivElement;
  /** The fold button (in the CORE label row) */
  readonly fold: HTMLButtonElement;
  private open = true;

  private shRow: HTMLElement; private shFill: HTMLElement; private shVal: HTMLElement;
  private enRow: HTMLElement; private enFill: HTMLElement; private enVal: HTMLElement;

  private layout = '';
  private q: Record<string, HTMLElement> = {};
  private weapons: WeaponEls[] = [];
  private stores: StoreEls[] = [];
  private feats: FeatEls[] = [];

  constructor() {
    injectStyle();
    this.summary = document.createElement('div');
    this.summary.className = 'ss-sum';
    this.summary.innerHTML = `
      <div class="ss-row" data-k="sh"><span class="ss-k">SHLD</span><div class="ss-bar"><i></i></div><span class="ss-v"></span></div>
      <div class="ss-row" data-k="en"><span class="ss-k">ENRG</span><div class="ss-bar"><i></i></div><span class="ss-v"></span></div>`;
    const row = (k: string) => this.summary.querySelector(`[data-k="${k}"]`) as HTMLElement;
    this.shRow = row('sh'); this.shFill = this.shRow.querySelector('i')!; this.shVal = this.shRow.querySelector('.ss-v')!;
    this.enRow = row('en'); this.enFill = this.enRow.querySelector('i')!; this.enVal = this.enRow.querySelector('.ss-v')!;
    this.details = document.createElement('div');
    this.details.className = 'ss-det';
    // (Nav markers keep clear of it: NavMarkersUI)
    this.details.dataset.hudAvoid = '1';
    this.fold = document.createElement('button');
    this.fold.className = 'ss-fold';
    try { this.open = localStorage.getItem(FOLD_KEY) !== '0'; } catch { /* private window: open */ }
    this.fold.addEventListener('click', (e) => {
      e.stopPropagation();
      this.open = !this.open;
      try { localStorage.setItem(FOLD_KEY, this.open ? '1' : '0'); } catch { /* not kept */ }
      this.applyFold();
    });
    this.applyFold();
  }

  private applyFold(): void {
    this.details.style.display = this.open ? 'block' : 'none';
    this.fold.textContent = this.open ? '◂' : '▸';
    this.fold.title = this.open ? 'Fold the ship status' : 'Show the ship status: energy, shield, weapons, thrust';
  }

  update(s: ShipStatus): void {
    if (!s.has) return;
    // ---- Summary
    const sh = s.shield, en = s.energy;
    setStyle(this.shRow, 'opacity', sh.max > 0 ? '1' : '0.45');
    setStyle(this.shFill, 'width', `${sh.pct.toFixed(1)}%`);
    setStyle(this.shFill, 'background', sh.state === 'wait' || sh.state === 'down' ? '#f59e0b' : '#38bdf8');
    setText(this.shVal, sh.max > 0 ? `${Math.round(sh.cur)}` : 'none');
    setStyle(this.shVal, 'color', sh.state === 'down' ? TONE.bad : sh.state === 'wait' ? TONE.warn : '#cfd8e6');
    setStyle(this.enFill, 'width', `${Math.max(0, Math.min(100, en.pct)).toFixed(1)}%`);
    setStyle(this.enFill, 'background', en.pct < 15 ? '#ef4444' : '#64b4ff');
    setText(this.enVal, en.brownout ? 'SHORT' : `${Math.round(en.pct)}%`);
    setStyle(this.enVal, 'color', en.brownout ? TONE.bad : en.draining ? TONE.warn : '#cfd8e6');
    if (this.enRow.classList.contains('brown') !== en.brownout) this.enRow.classList.toggle('brown', en.brownout);
    if (!this.open) return;

    // ---- Details (rebuilt only when the layout changes)
    const key = `${Math.min(MAX_WEAPONS, s.weapons.length)}|${en.stores.map((x) => x.kind).join('')}|${s.features.length}|${sh.max > 0 ? 1 : 0}`;
    if (key !== this.layout) this.build(s, key);
    const q = this.q;
    // Energy
    setText(q.ePct, `${Math.round(en.pct)}% · ${Math.round(en.held)}/${Math.round(en.cap)}`);
    setText(q.gen, `+${rate(en.gen)}`);
    setText(q.draw, en.draw < 0.05 ? '0' : `-${rate(en.draw)}`);
    setStyle(q.draw, 'color', en.draw > en.gen + 1e-6 ? TONE.warn : '#cfd8e6');
    setText(q.net, en.net === 0 ? (en.pct >= 99.5 ? 'full' : 'steady') : `${en.net > 0 ? '+' : ''}${rate(en.net)}/s${Number.isFinite(en.empty) && en.empty < 600 ? ` · dry ${Math.ceil(en.empty)}s` : ''}`);
    setStyle(q.net, 'color', en.net < 0 ? TONE.warn : en.net > 0 ? TONE.ok : '#8ea0bd');
    setStyle(q.warn, 'display', en.brownout ? 'block' : 'none');
    if (en.brownout) setText(q.warn, `BROWNOUT · ${en.short} short`);
    for (let i = 0; i < this.stores.length; i++) {
      const st = en.stores[i], el = this.stores[i];
      setStyle(el.fill, 'width', `${st.pct.toFixed(0)}%`);
      if (el.root.classList.contains('brown') !== st.brown) el.root.classList.toggle('brown', st.brown);
    }
    // Shield
    if (q.shV) {
      setText(q.shV, `${Math.round(sh.cur)}/${Math.round(sh.max)}`);
      const [txt, tone]: [string, Tone] = sh.state === 'full' ? ['FULL', 'ok']
        : sh.state === 'regen' ? [`REGEN +${rate(sh.regen)}/s`, 'busy']
        : sh.state === 'wait' ? [`WAIT ${sh.wait.toFixed(1)}s`, 'warn']
        : ['DOWN', 'bad'];
      setText(q.shS, txt);
      setStyle(q.shS, 'color', TONE[tone]);
    }
    // Hull
    const h = s.hull;
    setText(q.hull, `${Math.round(h.integrity * 100)}%`);
    setStyle(q.hull, 'color', h.integrity > 0.75 ? TONE.ok : h.integrity > 0.4 ? TONE.warn : TONE.bad);
    setText(q.parts, h.lost ? `${h.intact}/${h.parts} · ${h.lost} lost` : `${h.parts} parts`);
    setStyle(q.parts, 'color', h.lost ? TONE.warn : '#8ea0bd');
    // Weapons (the first MAX_WEAPONS groups; the rest counted)
    if (q.more) setText(q.more, s.weapons.length > MAX_WEAPONS ? `+${s.weapons.length - MAX_WEAPONS} more` : '');
    for (let i = 0; i < this.weapons.length; i++) {
      const w = s.weapons[i], el = this.weapons[i];
      setText(el.name, w.count > 1 ? `${w.name} ×${w.count}` : w.name);
      setText(el.state, w.state);
      setStyle(el.state, 'color', TONE[w.tone]);
      const extra = w.clip > 0 ? `${Math.floor(w.rounds + 1e-6)}/${w.clip}`
        : w.ammo >= 0 ? `${w.ammo}${w.crates ? `+${w.crates}c` : ''}` : '';
      setText(el.extra, extra);
      setStyle(el.extra, 'color', w.ammo === 0 && w.crates <= 0 ? TONE.bad : '#8ea0bd');
      setStyle(el.bar, 'opacity', w.progress >= 0 ? '1' : '0');
      setStyle(el.fill, 'width', `${(Math.max(0, w.progress) * 100).toFixed(0)}%`);
      setStyle(el.fill, 'background', TONE[w.tone]);
    }
    // Thrust
    const t = s.thrust;
    setText(q.eng, t.engines ? `${t.engines} engine${t.engines === 1 ? '' : 's'}${t.share < 0.995 ? ` · ${Math.round(t.share * 100)}% power` : ''}` : 'no engines');
    setStyle(q.eng, 'color', t.share < 0.995 ? TONE.warn : '#b6c3d7');
    const [bt, btone]: [string, Tone] = t.boost === 'boosting' ? ['BOOSTING', 'busy'] : t.boost === 'ready' ? ['BOOST OK', 'ok'] : t.boost === 'empty' ? ['NO CHARGE', 'bad'] : ['', 'dim'];
    setText(q.boost, bt);
    setStyle(q.boost, 'color', TONE[btone]);
    for (let i = 0; i < this.feats.length; i++) {
      const f = s.features[i], el = this.feats[i];
      setText(el.label, f.label);
      setText(el.text, f.text);
      setStyle(el.text, 'color', TONE[f.tone]);
      setStyle(el.bar, 'opacity', f.progress !== undefined ? '1' : '0');
      setStyle(el.fill, 'width', `${((f.progress ?? 0) * 100).toFixed(0)}%`);
    }
  }

  private build(s: ShipStatus, key: string): void {
    this.layout = key;
    const stores = s.energy.stores.map((st, i) => {
      const same = s.energy.stores.slice(0, i).filter((x) => x.kind === st.kind).length + 1;
      const tag = st.kind === 'pool' ? STORE_TAG.pool : `${STORE_TAG[st.kind]}${same}`;
      const what = st.kind === 'pool' ? 'Core store and batteries' : st.kind === 'cap' ? `Capacitor bank ${same}` : `Drive Cell bank ${same}`;
      return `<div class="ss-st" title="${what}: holds ${Math.round(st.cap)}"><div class="ss-bar"><i style="background:${STORE_COLOR[st.kind]}"></i></div><span style="color:${STORE_COLOR[st.kind]}">${tag}</span></div>`;
    }).join('');
    const weapons = s.weapons.slice(0, MAX_WEAPONS).map(() => `<div class="ss-l"><span data-w="n"></span><span><span data-w="x" class="ss-dim"></span> <b data-w="s"></b></span></div><div class="ss-bar ss-wb" data-w="b"><i></i></div>`).join('');
    const feats = s.features.map(() => `<div class="ss-l"><span data-f="l"></span><b data-f="t"></b></div><div class="ss-bar ss-wb" data-f="b"><i></i></div>`).join('');
    this.details.innerHTML = `
      <div class="ss-h"><span>ENERGY</span><span data-q="ePct"></span></div>
      <div class="ss-l"><span>gen / draw E/s</span><span><b data-q="gen" style="color:${TONE.ok}"></b> <b data-q="draw"></b></span></div>
      <div class="ss-l"><span>stores</span><span data-q="net"></span></div>
      <div class="ss-warn" data-q="warn"></div>
      ${stores ? `<div class="ss-stores">${stores}</div>` : ''}
      ${s.shield.max > 0 ? `<div class="ss-h"><span>SHIELD <span data-q="shV" style="color:#b6c3d7"></span></span><b data-q="shS"></b></div>` : ''}
      <div class="ss-h"><span>HULL <b data-q="hull"></b></span><span data-q="parts"></span></div>
      ${weapons ? `<div class="ss-h"><span>WEAPONS</span><span data-q="more"></span></div>${weapons}` : ''}
      <div class="ss-h"><span>THRUST</span></div>
      <div class="ss-l"><span data-q="eng"></span><b data-q="boost"></b></div>
      ${feats}`;
    this.q = {};
    this.details.querySelectorAll<HTMLElement>('[data-q]').forEach((el) => { this.q[el.dataset.q!] = el; });
    const ws = this.details.querySelectorAll<HTMLElement>('[data-w="n"]');
    const xs = this.details.querySelectorAll<HTMLElement>('[data-w="x"]');
    const ss = this.details.querySelectorAll<HTMLElement>('[data-w="s"]');
    const bs = this.details.querySelectorAll<HTMLElement>('[data-w="b"]');
    this.weapons = Array.from(ws, (name, i) => ({ name, extra: xs[i], state: ss[i], bar: bs[i], fill: bs[i].querySelector('i')! }));
    this.stores = Array.from(this.details.querySelectorAll<HTMLElement>('.ss-st'), (root) => ({ root, fill: root.querySelector('i')! }));
    const fl = this.details.querySelectorAll<HTMLElement>('[data-f="l"]');
    const ft = this.details.querySelectorAll<HTMLElement>('[data-f="t"]');
    const fb = this.details.querySelectorAll<HTMLElement>('[data-f="b"]');
    this.feats = Array.from(fl, (label, i) => ({ label, text: ft[i], bar: fb[i], fill: fb[i].querySelector('i')! }));
  }
}
