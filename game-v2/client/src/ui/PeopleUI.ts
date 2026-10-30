/**
 * People out in space and down on planets (the server's `people` list): they
 * live aboard a ship parked where they are (the server's, drawn like any
 * other); over it, their name, a ! when they have a job for you (▸ when a job
 * of yours needs them), and "X Talk" once you're close enough. People at
 * stations are in the station window instead.
 */

import type { PersonView } from '@space-game/common';
import type { GameState } from '../state/GameState';
import { setStyle } from './domWrite';
import { boundKeyName } from '../input/keybindings';
import { settings } from '../settings/Settings';

/** As the server's (People.ts TALK_RANGE) */
export const TALK_RANGE = 900;
/** The label sits this far (world units) above where they are, over their ship */
const LIFT = 170;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export class PeopleUI {
  private root: HTMLDivElement;
  private els = new Map<string, HTMLDivElement>();
  private hidden = false;
  /** "X Talk to …" at the bottom of the screen, while someone's in range (their ship may be off screen) */
  private hint: HTMLDivElement;

  constructor(private state: GameState, private worldToScreen: (x: number, y: number) => { x: number; y: number }, private people: () => PersonView[]) {
    const css = document.createElement('style');
    css.textContent = `
.ppl { position: absolute; left: 0; top: 0; transform: translate(-50%, -100%); pointer-events: none; display: flex; flex-direction: column; align-items: center; gap: 2px;
  font: 600 11px 'Segoe UI', system-ui, sans-serif; color: #e5ecf7; text-shadow: 0 0 4px #000, 0 0 2px #000; white-space: nowrap; will-change: transform; }
.ppl .ic { width: 18px; height: 18px; border-radius: 50%; border: 2px solid var(--pc); box-shadow: 0 0 12px var(--pc), inset 0 0 8px var(--pc);
  background: rgba(8, 14, 26, 0.6); display: grid; place-items: center; font: 700 12px 'Segoe UI', sans-serif; color: #fbbf24; animation: pplpulse 2.4s ease-in-out infinite; }
@keyframes pplpulse { 50% { box-shadow: 0 0 22px var(--pc), inset 0 0 10px var(--pc); } }
.ppl .t { color: #8394ad; font-weight: 400; font-size: 10px; }
.ppl .x { margin-top: 2px; padding: 1px 7px; border-radius: 6px; background: rgba(8, 14, 26, 0.8); border: 1px solid rgba(251,191,36,0.6); color: #fde68a; }
.ppl .x kbd { font: 700 10px 'Segoe UI', sans-serif; color: #fff; }`;
    document.head.appendChild(css);
    this.root = document.createElement('div');
    this.root.style.cssText = 'position:fixed; inset:0; pointer-events:none; z-index:820;';
    document.body.appendChild(this.root);
    this.hint = document.createElement('div');
    this.hint.style.cssText = `position: fixed; left: 50%; bottom: 240px; transform: translateX(-50%); display: none;
      padding: 7px 16px; border-radius: 999px; background: rgba(8, 16, 30, 0.85); border: 1px solid rgba(251, 191, 36, 0.6);
      color: #fde68a; font: 14px 'Segoe UI', system-ui, sans-serif; letter-spacing: 0.5px; pointer-events: none; z-index: 900;`;
    document.body.appendChild(this.hint);
  }

  setHidden(h: boolean): void {
    if (h === this.hidden) return;
    this.hidden = h;
    setStyle(this.root, 'display', h ? 'none' : 'block');
    if (h) setStyle(this.hint, 'display', 'none');
  }

  /** Those out here (not docked at a station), for the edge markers too */
  here(): PersonView[] {
    return this.people().filter((p) => !p.station && p.system === this.state.systemId && p.x !== undefined && p.y !== undefined);
  }

  update(): void {
    if (this.hidden) return;
    const me = this.state.entities.get(this.state.playerId);
    const seen = new Set<string>();
    let talk: PersonView | null = null;
    for (const p of this.here()) {
      seen.add(p.id);
      let el = this.els.get(p.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'ppl';
        this.root.appendChild(el);
        this.els.set(p.id, el);
      }
      const near = !!me && Math.hypot(me.renderX - p.x!, me.renderY - p.y!) <= TALK_RANGE;
      if (near) talk = p;
      const key = `${p.name}|${p.mark ?? ''}|${near}`;
      if (el.dataset.k !== key) {
        el.dataset.k = key;
        el.style.setProperty('--pc', p.color);
        el.innerHTML = `<div class="ic">${p.mark === 'offer' ? '!' : p.mark === 'step' ? '▸' : ''}</div><div>${esc(p.name)}</div><div class="t">${esc(p.title)}</div>`
          + (near ? `<div class="x"><kbd>${esc(boundKeyName('interact', settings.data.bindings))}</kbd> Talk</div>` : '');
      }
      // Over their ship
      const s = this.worldToScreen(p.x!, p.y! - LIFT);
      setStyle(el, 'transform', `translate(${Math.round(s.x)}px, ${Math.round(s.y)}px) translate(-50%, -100%)`);
    }
    for (const [id, el] of this.els) if (!seen.has(id)) { el.remove(); this.els.delete(id); }
    const t = talk as PersonView | null;
    const text = t ? `<kbd style="font:700 12px 'Segoe UI',sans-serif;color:#fff">${esc(boundKeyName('interact', settings.data.bindings))}</kbd> Talk to <b>${esc(t.name)}</b>${t.mark === 'offer' ? ' · has work for you' : t.mark === 'step' ? ' · about your job' : ''}` : '';
    if (this.hint.dataset.k !== text) { this.hint.dataset.k = text; this.hint.innerHTML = text; }
    setStyle(this.hint, 'display', text ? 'block' : 'none');
  }
}
