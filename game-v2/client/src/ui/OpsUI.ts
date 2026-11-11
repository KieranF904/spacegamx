/**
 * Operations in progress: a status panel at the top of the screen (what's
 * happening, progress, the ship you're protecting and its hull, the clock on a
 * courier run) and rings in space for the places that matter: relay beacons,
 * the outpost, wrecks to scan, where to meet a freighter. Each card has a
 * give-up button (asks once more before it sends).
 */

import type { OpView, ServerOpsMessage } from '@space-game/common';
import type { GameState } from '../state/GameState';
import { esc } from './escape';


const COLORS: Record<string, string> = { idle: '#7dd3fc', active: '#4ade80', done: '#a3a3a3', danger: '#f87171' };
/** Asking "give up?" this long before it lapses */
const SURE_MS = 6000;

export interface OpsActions {
  abandon(quest: string): void;
  /** In a party: true if you lead it; flying solo: null */
  leader(): boolean | null;
}

const KIND: Record<string, string> = { courier: 'COURIER', scan: 'SURVEY', escort: 'ESCORT', defend: 'DEFENCE', uplink: 'FLEET OP · UPLINK', hold: 'HOLD STEADY', course: 'RUN', recover: 'RECOVERY', construct: 'CONSTRUCTION' };

export class OpsUI {
  ops: OpView[] = [];
  private panel: HTMLDivElement;
  private rings: HTMLDivElement;
  private pool: HTMLDivElement[] = [];
  private hidden = false;
  private received = 0;
  private lastHtml = '';
  /** The job we're asking "give up?" about, and since when */
  private sure: string | null = null;
  private sureAt = 0;

  constructor(private state: GameState, private worldToScreen: (x: number, y: number) => { x: number; y: number }, private zoom: () => number, private actions?: OpsActions) {
    const css = document.createElement('style');
    css.textContent = `
.ops { position: fixed; top: 54px; left: 50%; transform: translateX(-50%); display: none; flex-direction: column; gap: 6px; z-index: 855; pointer-events: none;
  width: min(420px, calc(100vw - 520px)); min-width: 300px; }
.ops.low { top: 112px; }
.ops-c { background: rgba(8, 14, 26, 0.86); border: 1px solid rgba(125, 211, 252, 0.35); border-radius: 10px; padding: 7px 12px 8px;
  font: 12px 'Segoe UI', system-ui, sans-serif; color: #d6deeb; }
.ops-c .h { display: flex; justify-content: space-between; font: 700 10px 'Segoe UI', sans-serif; letter-spacing: 2px; color: #7dd3fc; }
.ops-c .h b { color: #fde68a; letter-spacing: 1px; }
.ops-c .h b.hot { color: #f87171; }
.ops-c .x { margin: 2px 0 4px; }
.ops-c .bar { height: 5px; border-radius: 3px; background: rgba(255,255,255,0.08); overflow: hidden; }
.ops-c .bar i { display: block; height: 100%; background: linear-gradient(90deg, #2c87ad, #7dd3fc); transition: width .4s; }
.ops-c .w { display: grid; grid-template-columns: auto 1fr 36px; gap: 8px; align-items: center; margin-top: 5px; font-size: 11px; color: #fbbf24; }
.ops-c .w .bar i { background: linear-gradient(90deg, #b45309, #fbbf24); }
.ops-c .w .bar i.low { background: linear-gradient(90deg, #b91c1c, #f87171); }
.ops-c .h .r { display: flex; gap: 8px; align-items: center; }
.ops-c button { pointer-events: auto; cursor: pointer; font: 700 10px 'Segoe UI', sans-serif; border-radius: 5px; }
.ops-c .h .ab { background: none; border: 1px solid transparent; color: #7c8aa3; padding: 0 5px; line-height: 14px; letter-spacing: 0; }
.ops-c .h .ab:hover { color: #fca5a5; border-color: rgba(248, 113, 113, 0.45); }
.ops-c .sure { display: flex; gap: 6px; align-items: center; margin-top: 6px; padding-top: 6px; border-top: 1px solid rgba(248, 113, 113, 0.3); font-size: 11px; color: #fca5a5; }
.ops-c .sure span { flex: 1; }
.ops-c .sure button { padding: 3px 9px; border: 1px solid rgba(125, 211, 252, 0.4); background: rgba(125, 211, 252, 0.08); color: #d6deeb; }
.ops-c .sure button.yes { border-color: rgba(248, 113, 113, 0.6); background: rgba(248, 113, 113, 0.15); color: #fca5a5; }
.ops-c .sure button:hover { filter: brightness(1.3); }
.ops-r { position: fixed; inset: 0; pointer-events: none; z-index: 60; overflow: hidden; }
.ops-ring { position: absolute; border-radius: 50%; border: 2px dashed var(--c); transform: translate(-50%, -50%); box-shadow: 0 0 14px color-mix(in srgb, var(--c) 35%, transparent);
  background: radial-gradient(circle, color-mix(in srgb, var(--c) 10%, transparent), transparent 70%); }
.ops-ring.active { border-style: solid; animation: opsp 1.2s ease-in-out infinite; }
@keyframes opsp { 50% { box-shadow: 0 0 26px var(--c); } }
.ops-ring b { position: absolute; left: 50%; top: 100%; transform: translate(-50%, 6px); white-space: nowrap; font: 700 11px 'Segoe UI', sans-serif;
  color: var(--c); text-shadow: 0 0 4px #000, 0 0 2px #000; letter-spacing: 0.5px; }`;
    document.head.appendChild(css);
    this.panel = document.createElement('div');
    this.panel.className = 'ops';
    this.rings = document.createElement('div');
    this.rings.className = 'ops-r';
    document.body.append(this.panel, this.rings);
    // Pointerdown, not click: the cards are rebuilt as their text changes
    this.panel.addEventListener('pointerdown', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b || !this.actions) return;
      e.preventDefault();
      e.stopPropagation();
      const q = b.dataset.q ?? '';
      if (b.dataset.a === 'ask') { this.sure = this.sure === q ? null : q; this.sureAt = performance.now(); }
      else if (b.dataset.a === 'yes') { this.actions.abandon(q); this.sure = null; }
      else this.sure = null;
      this.lastHtml = '';
    });
  }

  /** What giving up means here */
  private sureText(o: OpView): string {
    const lead = o.quest.startsWith('fleet:') ? this.actions?.leader() ?? null : null;
    if (lead === true) return 'Cancel this for the whole party?';
    if (lead === false) return 'Leave this job? Your party carries on without you';
    return 'Abandon this job? You get no reward';
  }

  setOps(m: ServerOpsMessage): void {
    this.ops = m.ops;
    this.received = performance.now();
  }

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
  }

  /** Places in this system worth a nav marker (and a jump lock) */
  markers(): { name: string; x: number; y: number }[] {
    const out: { name: string; x: number; y: number }[] = [];
    for (const op of this.ops) if (op.system === this.state.systemId) for (const m of op.markers) out.push({ name: m.label, x: m.x, y: m.y });
    return out;
  }

  /** The ship a job has you protecting (its id), if any */
  wards(): Set<number> {
    return new Set(this.ops.filter((o) => o.ward).map((o) => o.ward!.eid));
  }

  update(bossBar: boolean): void {
    if (this.hidden || !this.ops.length) {
      this.panel.style.display = 'none';
      this.rings.style.display = 'none';
      return;
    }
    // Courier clocks count down between updates
    const since = (performance.now() - this.received) / 1000;
    if (this.sure && (performance.now() - this.sureAt > SURE_MS || !this.ops.some((o) => o.quest === this.sure))) this.sure = null;
    const html = this.ops.map((o) => {
      const timer = o.timer !== undefined ? Math.max(0, Math.ceil(o.timer - since)) : undefined;
      const t = timer !== undefined ? `<b class="${timer < 30 ? 'hot' : ''}">${Math.floor(timer / 60)}:${String(timer % 60).padStart(2, '0')}</b>` : '';
      const ward = o.ward ? `<div class="w">${esc(o.ward.name)}<div class="bar"><i class="${o.ward.hull < 35 ? 'low' : ''}" style="width:${o.ward.hull}%"></i></div><span>${o.ward.hull}%</span></div>` : '';
      const q = esc(o.quest);
      const ab = this.actions ? `<button class="ab" tabindex="-1" data-a="ask" data-q="${q}" title="Give up this job">✕</button>` : '';
      const sure = this.sure === o.quest ? `<div class="sure"><span>${esc(this.sureText(o))}</span><button class="yes" tabindex="-1" data-a="yes" data-q="${q}">Give up</button><button tabindex="-1" data-a="no">Keep going</button></div>` : '';
      return `<div class="ops-c"><div class="h"><span>${KIND[o.kind] ?? o.kind.toUpperCase()} · ${esc(o.title)}</span><span class="r">${t}${ab}</span></div>
        <div class="x">${esc(o.text)}</div><div class="bar"><i style="width:${Math.round(Math.max(0, Math.min(1, o.progress)) * 100)}%"></i></div>${ward}${sure}</div>`;
    }).join('');
    if (html !== this.lastHtml) { this.lastHtml = html; this.panel.innerHTML = html; }
    this.panel.classList.toggle('low', bossBar);
    this.panel.style.display = 'flex';
    // Rings in space
    this.rings.style.display = 'block';
    let n = 0;
    const z = this.zoom();
    for (const o of this.ops) {
      if (o.system !== this.state.systemId) continue;
      for (const m of o.markers) {
        const p = this.worldToScreen(m.x, m.y);
        const d = Math.max(26, m.r * 2 * z);
        if (p.x < -d || p.y < -d || p.x > innerWidth + d || p.y > innerHeight + d) continue;
        const el = this.pool[n] ?? this.make();
        n++;
        el.className = `ops-ring ${m.state}`;
        el.style.cssText = `display:block; left:${p.x}px; top:${p.y}px; width:${d}px; height:${d}px; --c:${COLORS[m.state] ?? '#7dd3fc'}`;
        const label = el.firstElementChild as HTMLElement;
        if (label.textContent !== m.label) label.textContent = m.label;
      }
    }
    for (let i = n; i < this.pool.length; i++) this.pool[i].style.display = 'none';
  }

  private make(): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'ops-ring';
    el.innerHTML = '<b></b>';
    this.rings.appendChild(el);
    this.pool.push(el);
    return el;
  }
}
