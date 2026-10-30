/**
 * Boss presentation: a health bar across the top while a boss is near (its
 * name, title, hull and the phase marks), a title card when the fight starts,
 * and a victory card when it falls.
 */

import { EntityType, huntedBoss } from '@space-game/common';
import type { GameState } from '../state/GameState';
import { setStyle } from './domWrite';
import bossData from '../../../data/bosses.json';

interface BossInfo { name: string; title: string; phases: { at: number }[] }
const BOSSES = (bossData as unknown as { rules: { barRange: number }; bosses: Record<string, BossInfo> });
const BY_NAME = new Map(Object.values(BOSSES.bosses).map((b) => [b.name, b]));
/** id → name (this week's hunted boss is picked by id) */
const BOSS_IDS = Object.fromEntries(Object.entries(BOSSES.bosses).map(([id, b]) => [id, b.name]));

let styled = false;
function inject(): void {
  if (styled) return;
  styled = true;
  const css = document.createElement('style');
  css.textContent = `
.bb { position: fixed; top: 54px; left: 50%; transform: translateX(-50%); width: min(620px, calc(100vw - 680px)); min-width: 320px; z-index: 860;
  pointer-events: none; display: none; font-family: 'Segoe UI', system-ui, sans-serif; text-align: center; }
.bb-n { font: 700 15px 'Segoe UI', sans-serif; letter-spacing: 5px; color: #ffcf7a; text-transform: uppercase; text-shadow: 0 0 12px rgba(255,140,40,0.55), 0 1px 3px #000; }
.bb-t { font-size: 11px; letter-spacing: 2px; color: #b9a58a; margin: 1px 0 5px; text-shadow: 0 1px 3px #000; }
.bb-bar { position: relative; height: 12px; border-radius: 3px; background: rgba(20, 8, 4, 0.8); border: 1px solid rgba(255, 170, 90, 0.45);
  box-shadow: 0 0 18px rgba(255, 90, 30, 0.25); overflow: hidden; }
.bb-bar > i { position: absolute; left: 0; top: 0; bottom: 0; background: linear-gradient(180deg, #ff9a4a, #c2410c); transition: width .25s; }
.bb-bar > b { position: absolute; left: 0; top: 0; bottom: 0; background: rgba(255, 230, 200, 0.6); transition: width 1.2s ease-in; }
.bb-bar > s { position: absolute; top: 0; bottom: 0; width: 2px; background: rgba(0,0,0,0.65); }
.bb.hit .bb-bar { animation: bbhit .5s; }
@keyframes bbhit { 0% { box-shadow: 0 0 30px rgba(255, 220, 120, 0.9); } 100% { box-shadow: 0 0 18px rgba(255, 90, 30, 0.25); } }
.bb-p { margin-top: 4px; font-size: 11px; color: #fca5a5; letter-spacing: 1px; min-height: 14px; text-shadow: 0 1px 3px #000; }

.bt { position: fixed; left: 0; right: 0; top: 118px; z-index: 3100; pointer-events: none; display: flex; justify-content: center; }
.bt-in { text-align: center; max-width: min(560px, calc(100vw - 32px)); padding: 8px 26px 10px; border-radius: 12px; opacity: 0; transform: translateY(-6px);
  background: radial-gradient(ellipse at center, rgba(30, 8, 2, 0.62), rgba(30, 8, 2, 0) 72%); transition: opacity .5s, transform .5s ease-out; }
.bt.on .bt-in { opacity: 1; transform: none; }
.bt.off .bt-in { opacity: 0; transition: opacity .7s; }
.bt-k { font: 700 10px 'Segoe UI', sans-serif; letter-spacing: 6px; color: #fca5a5; margin-bottom: 2px; }
.bt-n { font: 800 28px 'Segoe UI', sans-serif; letter-spacing: 8px; color: #ffe2b0; text-transform: uppercase;
  text-shadow: 0 0 18px rgba(255, 120, 40, 0.7), 0 2px 6px #000; }
.bt-t { font: 400 13px 'Segoe UI', sans-serif; letter-spacing: 3px; color: #d8c3a0; margin-top: 2px; text-shadow: 0 1px 4px #000; }
.bt-x { margin: 6px auto 0; font: italic 12px 'Segoe UI', sans-serif; color: #c9d4e5; line-height: 1.5; text-shadow: 0 1px 4px #000; }
`;
  document.head.appendChild(css);
}

export class BossUI {
  private bar: HTMLDivElement;
  private name: HTMLDivElement;
  private title: HTMLDivElement;
  private fill: HTMLElement;
  private trail: HTMLElement;
  private marks: HTMLElement;
  private phaseText: HTMLDivElement;
  private current = -1;
  private lastHull = 100;
  private phaseTimer: number | null = null;
  hidden = false;

  /** Is the boss bar up (other panels make room) */
  get visible(): boolean {
    return this.current >= 0;
  }

  constructor(private state: GameState, private sound: (id: string, volume?: number) => void) {
    inject();
    this.bar = document.createElement('div');
    this.bar.className = 'bb';
    this.bar.innerHTML = '<div class="bb-n"></div><div class="bb-t"></div><div class="bb-bar"><b></b><i></i><span></span></div><div class="bb-p"></div>';
    this.name = this.bar.querySelector('.bb-n')!;
    this.title = this.bar.querySelector('.bb-t')!;
    this.fill = this.bar.querySelector('.bb-bar > i')!;
    this.trail = this.bar.querySelector('.bb-bar > b')!;
    this.marks = this.bar.querySelector('.bb-bar > span')!;
    this.phaseText = this.bar.querySelector('.bb-p')!;
    document.body.appendChild(this.bar);
  }

  /** Every frame: show the nearest boss in range */
  update(): void {
    const me = this.state.entities.get(this.state.playerId);
    let best: { id: number; d: number } | null = null;
    if (me && !this.hidden) {
      for (const e of this.state.entities.values()) {
        if (e.type !== EntityType.ShipBody || e.data?.[4] !== 2) continue;
        const d = Math.hypot(e.renderX - me.renderX, e.renderY - me.renderY);
        if (d < BOSSES.rules.barRange && (!best || d < best.d)) best = { id: e.id, d };
      }
    }
    if (!best) {
      setStyle(this.bar, 'display', 'none');
      this.current = -1;
      return;
    }
    const e = this.state.entities.get(best.id)!;
    const hull = Math.max(0, Math.min(100, e.data?.[7] ?? 100));
    if (best.id !== this.current) {
      this.current = best.id;
      const info = e.name ? BY_NAME.get(e.name) : undefined;
      this.name.textContent = e.name ?? 'Unknown';
      const hunted = Object.entries(BOSS_IDS).find(([, n]) => n === e.name)?.[0] === huntedBoss(Date.now(), Object.keys(BOSS_IDS));
      this.title.textContent = `${info?.title ?? ''}${hunted ? ' · HUNTED THIS WEEK: double rewards' : ''}`;
      this.marks.innerHTML = (info?.phases ?? []).map((p) => `<s style="left:${p.at * 100}%"></s>`).join('');
      this.lastHull = hull;
      this.trail.style.width = `${hull}%`;
      this.phaseText.textContent = '';
    }
    setStyle(this.bar, 'display', 'block');
    setStyle(this.fill, 'width', `${hull}%`);
    if (hull < this.lastHull - 0.5) {
      this.trail.style.width = `${hull}%`;
      this.bar.classList.remove('hit');
      void this.bar.offsetWidth;
      this.bar.classList.add('hit');
    }
    this.lastHull = hull;
  }

  onPhase(text: string): void {
    this.phaseText.textContent = text;
    this.sound('warning', 0.7);
    if (this.phaseTimer !== null) clearTimeout(this.phaseTimer);
    this.phaseTimer = window.setTimeout(() => { this.phaseText.textContent = ''; }, 7000);
  }

  /** The fight starts: a title card */
  intro(name: string, title: string, text: string): void {
    this.card('WARNING', name, title, text, 4200);
    this.sound('boss_roar', 0.9);
  }

  defeated(name: string): void {
    this.card('DEFEATED', name, 'Its spoils are in your station storage', '', 3000);
    this.sound('level_up', 0.8);
  }

  private card(kicker: string, name: string, title: string, text: string, ms: number): void {
    const el = document.createElement('div');
    el.className = 'bt';
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
    el.innerHTML = `<div class="bt-in"><div class="bt-k">${kicker}</div><div class="bt-n">${esc(name)}</div><div class="bt-t">${esc(title)}</div>${text ? `<div class="bt-x">${esc(text)}</div>` : ''}</div>`;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('on'));
    setTimeout(() => { el.classList.add('off'); }, ms);
    setTimeout(() => el.remove(), ms + 900);
  }
}
