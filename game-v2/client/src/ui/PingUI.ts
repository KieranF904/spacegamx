/**
 * Pings: B marks what's under the cursor for your party (a hostile: "attack",
 * and the marker follows it; loot: "loot"; anywhere else: "here"); Shift+B
 * marks danger. Pings show in space, on the screen edge (nav markers) and on
 * the map, for a few seconds.
 */

import { EntityType, ServerMapPingMessage, PingKind, ClientMessage } from '@space-game/common';
import type { GameState } from '../state/GameState';

const LIFE_MS = 15000;
const STYLE: Record<PingKind, { color: string; icon: string; word: string }> = {
  here: { color: '#7dd3fc', icon: '⌖', word: 'here' },
  attack: { color: '#f87171', icon: '⚔', word: 'attack' },
  danger: { color: '#fbbf24', icon: '⚠', word: 'danger' },
  loot: { color: '#86efac', icon: '◈', word: 'loot' },
};

interface Ping extends ServerMapPingMessage { until: number; el: HTMLDivElement }

export class PingUI {
  private pings: Ping[] = [];
  private root: HTMLDivElement;
  private hidden = false;

  constructor(
    private state: GameState,
    private send: (m: ClientMessage) => void,
    private worldToScreen: (x: number, y: number) => { x: number; y: number },
    private cursorWorld: () => { x: number; y: number },
    private zoom: () => number,
    private sound: (id: string) => void,
  ) {
    const css = document.createElement('style');
    css.textContent = `
.png-r { position: fixed; inset: 0; pointer-events: none; z-index: 74; overflow: hidden; }
.png { position: absolute; transform: translate(-50%, -100%); display: flex; flex-direction: column; align-items: center; color: var(--c);
  font: 700 11px 'Segoe UI', sans-serif; text-shadow: 0 0 4px #000, 0 0 2px #000; white-space: nowrap; }
.png b { font-size: 22px; line-height: 1; filter: drop-shadow(0 0 6px var(--c)); animation: pngb 0.8s ease-in-out infinite; }
.png i { position: absolute; left: 50%; top: 100%; width: 34px; height: 34px; margin: -17px 0 0 -17px; border-radius: 50%; border: 2px solid var(--c);
  animation: pngr 1.2s ease-out infinite; }
@keyframes pngb { 50% { transform: translateY(-4px); } }
@keyframes pngr { from { transform: scale(0.4); opacity: 1; } to { transform: scale(1.6); opacity: 0; } }`;
    document.head.appendChild(css);
    this.root = document.createElement('div');
    this.root.className = 'png-r';
    document.body.appendChild(this.root);
  }

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    this.root.style.display = hidden ? 'none' : 'block';
  }

  /** B (Shift: danger): ping what's under the cursor */
  pingAtCursor(danger: boolean): void {
    const c = this.cursorWorld();
    const reach = 260 / Math.max(0.25, this.zoom());
    let kind: PingKind = danger ? 'danger' : 'here';
    let target: number | undefined;
    if (!danger) {
      let best = Infinity;
      for (const e of this.state.entities.values()) {
        const d = Math.hypot(e.renderX - c.x, e.renderY - c.y);
        if (d > reach || d >= best) continue;
        if (e.type === EntityType.ShipBody && e.data?.[0] === 3) { best = d; kind = 'attack'; target = e.id; }
        else if (e.type === EntityType.DroppedItem && kind !== 'attack') { best = d; kind = 'loot'; target = e.id; }
      }
    }
    const at = target !== undefined ? this.state.entities.get(target)! : null;
    this.send({ type: 'mapPing', x: at?.renderX ?? c.x, y: at?.renderY ?? c.y, kind, target });
  }

  /** A ping (map clicks too) */
  pingAt(x: number, y: number, kind: PingKind = 'here'): void {
    this.send({ type: 'mapPing', x, y, kind });
  }

  onPing(m: ServerMapPingMessage): void {
    // One live ping per pilot: a new one replaces their last
    this.pings = this.pings.filter((p) => { if (p.from === m.from) { p.el.remove(); return false; } return true; });
    const el = document.createElement('div');
    el.className = 'png';
    const s = STYLE[m.kind];
    el.style.setProperty('--c', s.color);
    el.innerHTML = `<b>${s.icon}</b><span>${m.from.replace(/[<>&"]/g, '')}: ${s.word}</span><i></i>`;
    this.root.appendChild(el);
    this.pings.push({ ...m, until: performance.now() + LIFE_MS, el });
    this.sound('scan_ping');
  }

  /** Where the live pings are (this system), for nav markers and the map */
  markers(): { name: string; x: number; y: number; kind: PingKind }[] {
    return this.pings.filter((p) => p.system === this.state.systemId).map((p) => {
      const pos = this.where(p);
      return { name: `${p.from}: ${STYLE[p.kind].word}`, x: pos.x, y: pos.y, kind: p.kind };
    });
  }

  private where(p: Ping): { x: number; y: number } {
    const e = p.target !== undefined ? this.state.entities.get(p.target) : undefined;
    return e ? { x: e.renderX, y: e.renderY } : { x: p.x, y: p.y };
  }

  update(): void {
    const now = performance.now();
    this.pings = this.pings.filter((p) => {
      // Gone: its time is up, or the hostile it marked is destroyed
      if (now > p.until || (p.kind === 'attack' && p.target !== undefined && !this.state.entities.has(p.target))) { p.el.remove(); return false; }
      return true;
    });
    if (this.hidden) return;
    for (const p of this.pings) {
      if (p.system !== this.state.systemId) { p.el.style.display = 'none'; continue; }
      const s = this.worldToScreen(this.where(p).x, this.where(p).y);
      p.el.style.display = 'flex';
      p.el.style.left = `${s.x}px`;
      p.el.style.top = `${s.y - 18}px`;
      p.el.style.opacity = String(Math.min(1, (p.until - now) / 2000));
    }
  }
}
