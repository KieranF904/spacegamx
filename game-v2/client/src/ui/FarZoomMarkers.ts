/**
 * Far-zoom markers: zoomed well out, ships are a few pixels, so your own ship
 * gets a ring and a heading chevron, and other pilots a small labelled pip
 * (party members in green), and the stillstones a pale grey diamond.
 * They fade in as the camera pulls back.
 */

import { EntityType, lodestonePosition, lodestoneLabel, lodestoneLive, jumpTuning, type StarSystemData, type ShipTuning } from '@space-game/common';
import systemsData from '../../../data/systems.json';
import shipTuning from '../../../data/ships/tuning.json';
import type { GameState } from '../state/GameState';

/** Below this zoom the markers start to show; fully shown at FULL */
const START = 0.3;
const FULL = 0.12;
const SYSTEMS = (systemsData as { systems: StarSystemData[] }).systems;
const JUMP = jumpTuning(shipTuning as unknown as ShipTuning);

export class FarZoomMarkers {
  private root: HTMLDivElement;
  private me: HTMLDivElement;
  private pool: HTMLDivElement[] = [];
  private hidden = false;
  /** What each element was last given (style is written only when it changes) */
  private last = new WeakMap<HTMLElement, string>();
  private lastOpacity = '';

  constructor(
    private state: GameState,
    private worldToScreen: (x: number, y: number) => { x: number; y: number },
    private zoom: () => number,
    /** Party members (entity ids), drawn green */
    private party: () => Set<number> = () => new Set(),
  ) {
    const css = document.createElement('style');
    css.textContent = `
.fzm { position: fixed; inset: 0; pointer-events: none; z-index: 70; overflow: hidden; }
.fzm-me { position: absolute; left: 0; top: 0; will-change: transform; width: 34px; height: 34px; margin: -17px 0 0 -17px; border-radius: 50%;
  border: 2px solid rgba(74, 222, 128, 0.85); box-shadow: 0 0 10px rgba(74, 222, 128, 0.45), inset 0 0 8px rgba(74, 222, 128, 0.25); }
.fzm-me i { position: absolute; left: 50%; top: 50%; width: 0; height: 0; border-left: 6px solid transparent; border-right: 6px solid transparent;
  border-bottom: 11px solid #86efac; transform-origin: 50% 100%; filter: drop-shadow(0 0 3px rgba(74, 222, 128, 0.9)); }
.fzm-me b { position: absolute; left: 50%; top: 38px; transform: translateX(-50%); font: 700 9px 'Segoe UI', sans-serif; letter-spacing: 2px; color: #86efac;
  text-shadow: 0 0 3px #000; }
.fzm-o { position: absolute; left: 0; top: 0; will-change: transform; display: flex; flex-direction: column; align-items: center; gap: 2px; }
.fzm-o i { width: 9px; height: 9px; border-radius: 50%; background: #60a5fa; box-shadow: 0 0 6px rgba(96, 165, 250, 0.9); }
.fzm-o.party i { background: #4ade80; box-shadow: 0 0 6px rgba(74, 222, 128, 0.9); width: 11px; height: 11px; border: 1px solid #dcfce7; }
.fzm-o b { font: 600 10px 'Segoe UI', sans-serif; color: #bfdbfe; text-shadow: 0 0 3px #000, 0 0 2px #000; white-space: nowrap; }
.fzm-o.party b { color: #bbf7d0; }
.fzm-o.lode i { width: 8px; height: 8px; border-radius: 1px; transform: rotate(45deg); background: #a3c2cf; box-shadow: 0 0 6px rgba(163, 194, 207, 0.9); }
.fzm-o.lode b { color: #d4e2e8; font-weight: 400; opacity: 0.85; }
.fzm-o.lode.dead i { background: #7d8590; box-shadow: none; }
.fzm-o.lode.dead b { color: #9aa1aa; }`;
    document.head.appendChild(css);
    this.root = document.createElement('div');
    this.root.className = 'fzm';
    this.me = document.createElement('div');
    this.me.className = 'fzm-me';
    this.me.innerHTML = '<i></i><b>YOU</b>';
    this.root.appendChild(this.me);
    document.body.appendChild(this.root);
  }

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    if (hidden) this.root.style.display = 'none';
  }

  update(): void {
    const z = this.zoom();
    const k = Math.max(0, Math.min(1, (START - z) / (START - FULL)));
    if (this.hidden || k <= 0) { this.root.style.display = 'none'; return; }
    if (this.root.style.display !== 'block') this.root.style.display = 'block';
    const opacity = k.toFixed(2);
    if (opacity !== this.lastOpacity) { this.lastOpacity = opacity; this.root.style.opacity = opacity; }
    const me = this.state.entities.get(this.state.playerId);
    if (me) {
      const p = this.worldToScreen(me.renderX, me.renderY);
      if (this.me.style.display !== 'block') this.me.style.display = 'block';
      this.place(this.me, `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`);
      // The chevron sits on the ring, pointing the way the ship faces
      this.place(this.me.firstElementChild as HTMLElement, `translate(-50%, -100%) rotate(${(me.renderAngle + Math.PI / 2).toFixed(3)}rad) translateY(-15px)`);
    } else {
      this.me.style.display = 'none';
    }
    const party = this.party();
    let n = 0;
    for (const e of this.state.entities.values()) {
      if (e.type !== EntityType.Player || e.id === this.state.playerId) continue;
      const p = this.worldToScreen(e.renderX, e.renderY);
      if (p.x < -40 || p.y < -40 || p.x > innerWidth + 40 || p.y > innerHeight + 40) continue;
      const el = this.pool[n] ?? this.makePip();
      n++;
      if (el.style.display !== 'flex') el.style.display = 'flex';
      this.place(el, `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) translate(-50%, -50%)`);
      el.classList.toggle('party', party.has(e.id));
      el.classList.remove('lode', 'dead');
      const label = el.lastElementChild as HTMLElement;
      if (label.textContent !== (e.name ?? '')) label.textContent = e.name ?? '';
    }
    // Stillstones (their fields charge the jump drive; a dead or shattered one is dimmed)
    const sys = SYSTEMS.find((s) => s.id === this.state.systemId);
    for (const l of sys?.lodestones ?? []) {
      const at = lodestonePosition(l, this.state.getRawServerTick());
      const p = this.worldToScreen(at.x, at.y);
      if (p.x < -40 || p.y < -40 || p.x > innerWidth + 40 || p.y > innerHeight + 40) continue;
      const el = this.pool[n] ?? this.makePip();
      n++;
      if (el.style.display !== 'flex') el.style.display = 'flex';
      this.place(el, `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) translate(-50%, -50%)`);
      el.classList.remove('party');
      el.classList.add('lode');
      el.classList.toggle('dead', !lodestoneLive(l));
      const label = el.lastElementChild as HTMLElement, name = lodestoneLabel(l, JUMP);
      if (label.textContent !== name) label.textContent = name;
    }
    for (let i = n; i < this.pool.length; i++) if (this.pool[i].style.display !== 'none') this.pool[i].style.display = 'none';
  }

  /** Set an element's transform, only if it changed */
  private place(el: HTMLElement, transform: string): void {
    if (this.last.get(el) === transform) return;
    this.last.set(el, transform);
    el.style.transform = transform;
  }

  private makePip(): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'fzm-o';
    el.innerHTML = '<i></i><b></b>';
    this.root.appendChild(el);
    this.pool.push(el);
    return el;
  }
}
