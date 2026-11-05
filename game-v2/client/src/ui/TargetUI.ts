/**
 * Targeting: Tab cycles through hostiles nearby (nearest first), T targets the
 * ship under the cursor (T on empty space clears it). The target gets corner
 * brackets in space (an arrow on the screen edge when it's off screen) and a
 * panel: name, faction, hull, shield, core and range. Missiles lock on to it.
 */

import { EntityType, ClientMessage } from '@space-game/common';
import type { GameState, InterpolatedEntity } from '../state/GameState';
import { esc, shipKind, shipSubHtml, shipBarsHtml, distText } from './shipReadout';

const CYCLE_RANGE = 9000;

export class TargetUI {
  target = 0;
  private bracket: HTMLDivElement;
  private edge: HTMLDivElement;
  private panel: HTMLDivElement;
  private hidden = false;
  private lastHtml = '';
  /** When the current target was picked (the brackets close in on it) */
  private lockAt = 0;

  constructor(
    private state: GameState,
    private send: (m: ClientMessage) => void,
    private worldToScreen: (x: number, y: number) => { x: number; y: number },
    private zoom: () => number,
    private radius: (id: number) => number,
    private cursorWorld: () => { x: number; y: number },
    private sound: (id: string) => void,
    private myRating: () => number = () => 0,
  ) {
    const css = document.createElement('style');
    css.textContent = `
.tgt-br { position: fixed; pointer-events: none; z-index: 75; display: none; --c: #f87171; }
.tgt-br i { position: absolute; width: 12px; height: 12px; border-color: var(--c); border-style: solid; filter: drop-shadow(0 0 3px var(--c)); }
.tgt-br i:nth-child(1) { left: 0; top: 0; border-width: 2px 0 0 2px; }
.tgt-br i:nth-child(2) { right: 0; top: 0; border-width: 2px 2px 0 0; }
.tgt-br i:nth-child(3) { right: 0; bottom: 0; border-width: 0 2px 2px 0; }
.tgt-br i:nth-child(4) { left: 0; bottom: 0; border-width: 0 0 2px 2px; }
.tgt-edge { position: fixed; pointer-events: none; z-index: 76; display: none; transform: translate(-50%, -50%); font: 700 11px 'Segoe UI', sans-serif;
  color: #fca5a5; text-shadow: 0 0 4px #000; white-space: nowrap; }
.tgt-edge b { display: inline-block; font-size: 16px; }
.tgt-p { position: fixed; right: 70px; bottom: 112px; width: 228px; display: none; z-index: 860; padding: 9px 11px; border-radius: 10px;
  background: rgba(10, 14, 26, 0.86); border: 1px solid var(--c, #f87171); color: #d6deeb; font: 12px 'Segoe UI', system-ui, sans-serif;
  box-shadow: 0 0 16px rgba(0,0,0,0.4); }
.tgt-p .t { font: 700 10px 'Segoe UI', sans-serif; letter-spacing: 2px; color: var(--c); display: flex; justify-content: space-between; }
.tgt-p .n { font: 700 14px 'Segoe UI', sans-serif; color: #fff; margin: 2px 0 1px; }
.tgt-p .s { color: #8394ad; font-size: 11px; margin-bottom: 5px; }
.tgt-p .rw { display: grid; grid-template-columns: 46px 1fr 34px; align-items: center; gap: 6px; font-size: 11px; color: #8394ad; margin-top: 3px; }
.tgt-p .rw b { color: #d6deeb; text-align: right; font-weight: 600; }
.tgt-p .bar { height: 5px; border-radius: 3px; background: rgba(255,255,255,0.08); overflow: hidden; }
.tgt-p .bar i { display: block; height: 100%; }
.tgt-p .k { margin-top: 6px; color: #64748b; font-size: 10px; letter-spacing: 0.5px; }`;
    document.head.appendChild(css);
    this.bracket = document.createElement('div');
    this.bracket.className = 'tgt-br';
    this.bracket.innerHTML = '<i></i><i></i><i></i><i></i>';
    this.edge = document.createElement('div');
    this.edge.className = 'tgt-edge';
    this.panel = document.createElement('div');
    this.panel.className = 'tgt-p';
    this.panel.dataset.hudAvoid = '1';
    document.body.append(this.bracket, this.edge, this.panel);
  }

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
  }

  /** The panel's height while it shows (the info panel stacks above it), else 0 */
  get panelHeight(): number {
    return this.panel.style.display === 'block' ? this.panel.offsetHeight : 0;
  }

  set(id: number): void {
    if (id === this.target) return;
    this.target = id;
    this.lockAt = performance.now();
    this.send({ type: 'target', id });
    if (id) this.sound('ui_click');
  }

  /** Tab: the next hostile, nearest first */
  cycle(): void {
    const me = this.state.entities.get(this.state.playerId);
    if (!me) return;
    const list = [...this.state.entities.values()]
      .filter((e) => this.hostile(e) && Math.hypot(e.renderX - me.renderX, e.renderY - me.renderY) < CYCLE_RANGE)
      .sort((a, b) => Math.hypot(a.renderX - me.renderX, a.renderY - me.renderY) - Math.hypot(b.renderX - me.renderX, b.renderY - me.renderY));
    if (!list.length) { this.set(0); return; }
    const i = list.findIndex((e) => e.id === this.target);
    this.set(list[(i + 1) % list.length].id);
  }

  /** T: whatever ship is under the cursor (nothing there: clear) */
  pickAtCursor(): void {
    const c = this.cursorWorld();
    let best = 0, bd = Infinity;
    for (const e of this.state.entities.values()) {
      if (e.id === this.state.playerId || (e.type !== EntityType.ShipBody && e.type !== EntityType.Player)) continue;
      const d = Math.hypot(e.renderX - c.x, e.renderY - c.y) - this.radius(e.id);
      if (d < 250 / Math.max(0.3, this.zoom()) && d < bd) { bd = d; best = e.id; }
    }
    this.set(best);
  }

  private hostile(e: InterpolatedEntity): boolean {
    return e.type === EntityType.ShipBody && e.data?.[0] === 3;
  }

  update(): void {
    const e = this.target ? this.state.entities.get(this.target) : undefined;
    if (this.target && !e) { this.set(0); }
    if (!e || this.hidden) {
      this.bracket.style.display = this.edge.style.display = this.panel.style.display = 'none';
      return;
    }
    const me = this.state.entities.get(this.state.playerId);
    const k = shipKind(e);
    const p = this.worldToScreen(e.renderX, e.renderY);
    // Locking on: the brackets start wide and snap in
    const lock = Math.min(1, (performance.now() - this.lockAt) / 260);
    const size = Math.max(28, this.radius(e.id) * 2.3 * this.zoom()) * (1 + 0.9 * (1 - lock) * (1 - lock));
    const onScreen = p.x > -size / 2 && p.y > -size / 2 && p.x < innerWidth + size / 2 && p.y < innerHeight + size / 2;
    const dist = me ? Math.hypot(e.renderX - me.renderX, e.renderY - me.renderY) : 0;
    const km = distText(dist);
    if (onScreen) {
      this.bracket.style.cssText = `display:block; left:${p.x - size / 2}px; top:${p.y - size / 2}px; width:${size}px; height:${size}px; --c:${k.color}; opacity:${0.35 + 0.65 * lock}`;
      this.edge.style.display = 'none';
    } else {
      this.bracket.style.display = 'none';
      const cx = innerWidth / 2, cy = innerHeight / 2, dx = p.x - cx, dy = p.y - cy;
      const t = Math.min((cx - 40) / Math.max(1, Math.abs(dx)), (cy - 40) / Math.max(1, Math.abs(dy)));
      this.edge.style.cssText = `display:block; left:${cx + dx * t}px; top:${cy + dy * t}px; color:${k.color}`;
      this.edge.innerHTML = `<b style="transform: rotate(${Math.atan2(dy, dx)}rad)">➤</b> ${esc(e.name ?? 'Target')} · ${km}`;
    }
    // Panel
    const html = `<div class="t"><span>TARGET · ${k.label}</span><span>${km}</span></div><div class="n">${esc(e.name ?? 'Unknown')}</div>${shipSubHtml(e, this.myRating())}`
      + shipBarsHtml(e)
      + `<div class="k">Tab next hostile · T target under cursor · missiles lock on</div>`;
    if (html !== this.lastHtml) { this.lastHtml = html; this.panel.innerHTML = html; }
    this.panel.style.setProperty('--c', k.color);
    this.panel.style.display = 'block';
  }
}
