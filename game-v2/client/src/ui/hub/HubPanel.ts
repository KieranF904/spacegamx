/**
 * The side panel: a tabbed HUD panel in the left column, on top of the cargo panel and under the pilot readout
 * (Social, Party, Pilot & ship, Component guide; the tabs are registered modules, hubTabs.ts). It folds to its tab
 * bar (the fold button, or clicking the open tab), its top edge drags to resize, and it remembers the tab each pilot
 * had open, the fold and the height (hubPrefs.ts). Where it goes and how tall it may be is hubLayout.ts: it shares
 * the column with the cargo panel and never covers it.
 *
 * Keys: P opens the Social tab, C the Component guide (app/keys.ts); the same key again folds it. Where it would be
 * hidden (over the station or the hangar, a window too short for it), the key calls it up over everything until Esc
 * or the key again. In a short column it shows its tab bar until a tab is opened, then lifts over the pilot readout
 * (hubLayout `lift`) until folded. With a tab button focused,
 * the arrow keys, Home and End move between tabs and Esc hands the keyboard back to the game.
 */

import { boundKeyName } from '../../input/keybindings';
import { settings } from '../../settings/Settings';
import { hideTip, closeMenu } from '../windowKit';
import { hubLayout } from './hubLayout';
import { loadFolded, loadHeight, loadTab, saveFolded, saveHeight, saveTab } from './hubPrefs';
import { HubTabs, type HubTab } from './hubTabs';

/** The body's height until the pilot drags it, and the least worth showing */
const DEFAULT_BODY = 240;
const MIN_BODY = 96;
const GAP = 8;

/** Where it may be: `off` never (signed out, the menu, the map); `covered` only if called up (docked, the hangar, no ship); `on` */
export type HubState = 'off' | 'covered' | 'on';

/** The left column as it is now (app/windows.ts reads it off the cargo panel, the pilot readout and the party list) */
export interface HubColumnNow {
  /** The cargo panel's bottom edge, its least height (0: not on screen) and its top (0: not on screen) */
  floor: number;
  cargoMin: number;
  cargoTop: number;
  /** The bottom of what sits above (the pilot readout, the party list) */
  ceiling: number;
  /** The pilot readout's top: as high as it may lift */
  lift: number;
  /** The column's left edge and width (the chat box's) */
  left: number;
  width: number;
}

export interface HubDeps {
  /** The pilot's name (the saved tab is theirs) */
  player(): string;
  column(): HubColumnNow;
  /** Its room changed: the cargo panel places itself again (it asks cargoCeiling) */
  relayoutCargo(): void;
  sound(id: string, volume?: number): void;
}

let styled = false;
function injectStyles(): void {
  if (styled) return;
  styled = true;
  const css = document.createElement('style');
  css.textContent = `
.hub { position: fixed; left: 16px; width: 320px; z-index: 850; box-sizing: border-box; display: none; flex-direction: column;
  background: linear-gradient(180deg, rgba(24, 33, 50, 0.86) 0%, rgba(10, 16, 28, 0.82) 38%, rgba(8, 13, 24, 0.84) 100%);
  border: 1px solid rgba(120, 150, 200, 0.22); border-radius: 10px;
  box-shadow: inset 0 1px 0 rgba(196, 216, 255, 0.13), inset 0 -2px 0 rgba(0, 0, 0, 0.45);
  color: #c9d4e5; font: 12px 'Segoe UI', system-ui, sans-serif; user-select: none; }
.hub.on { display: flex; }
.hub.lifted { z-index: 870; background: linear-gradient(180deg, rgba(24, 33, 50, 0.98) 0%, rgba(10, 16, 28, 0.97) 38%, rgba(8, 13, 24, 0.97) 100%); box-shadow: inset 0 1px 0 rgba(196, 216, 255, 0.13), inset 0 -2px 0 rgba(0, 0, 0, 0.45), 0 10px 28px rgba(0, 0, 0, 0.55); }
.hub.over { z-index: 2950; }
.hub-grip { position: absolute; left: 10px; right: 10px; top: -4px; height: 8px; cursor: ns-resize; z-index: 1; }
.hub-grip::after { content: ''; position: absolute; left: 50%; top: 3px; width: 34px; margin-left: -17px; height: 2px; border-radius: 1px; background: rgba(125, 160, 210, 0); transition: background .15s; }
.hub:hover .hub-grip::after, .hub-grip.drag::after { background: rgba(125, 160, 210, 0.45); }
.hub.folded .hub-grip { display: none; }
.hub-bar { display: flex; align-items: stretch; gap: 2px; padding: 4px 4px 0; border-bottom: 1px solid rgba(140, 170, 220, 0.16);
  background: rgba(3, 6, 12, 0.28); border-radius: 9px 9px 0 0; }
.hub.folded .hub-bar { border-bottom-color: transparent; padding-bottom: 4px; border-radius: 9px; }
.hub-tab { all: unset; box-sizing: border-box; flex: 1 1 auto; min-width: 0; cursor: pointer; text-align: center; padding: 6px 5px 5px;
  border-radius: 6px 6px 0 0; border-bottom: 2px solid transparent; margin-bottom: -1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  font: 700 9.5px 'Segoe UI', sans-serif; letter-spacing: 1.4px; text-transform: uppercase; color: #8394ad; }
.hub-tab:hover { color: #e5ecf7; background: rgba(125, 211, 252, 0.06); }
.hub-tab[aria-selected="true"] { color: #e8f6ff; border-bottom-color: #6cc8ff; background: rgba(108, 200, 255, 0.09); }
.hub.folded .hub-tab[aria-selected="true"] { border-bottom-color: transparent; border-radius: 6px; margin-bottom: 0; }
.hub-tab .badge { display: inline-block; margin-left: 4px; min-width: 13px; padding: 0 3px; border-radius: 7px; box-sizing: border-box;
  background: rgba(251, 191, 36, 0.18); color: #fcd34d; font-size: 9px; letter-spacing: 0; line-height: 13px; }
.hub-fold { all: unset; cursor: pointer; flex: 0 0 22px; text-align: center; color: #56657c; font-size: 10px; border-radius: 6px; }
.hub-fold:hover { color: #c9d4e5; background: rgba(125, 211, 252, 0.06); }
.hub-tab:focus-visible, .hub-fold:focus-visible { outline: 2px solid #6cc8ff; outline-offset: -2px; color: #fff; }
.hub-body { overflow-y: auto; padding: 6px 8px 8px; min-height: 0; scrollbar-width: thin; scrollbar-color: rgba(125, 160, 210, 0.35) transparent; }
.hub-body::-webkit-scrollbar { width: 6px; }
.hub-body::-webkit-scrollbar-thumb { background: rgba(125, 160, 210, 0.35); border-radius: 3px; }
.hub-body.fill { overflow: hidden; padding: 0; display: flex; flex-direction: column; }
.hub.folded .hub-body { display: none; }
.hub-body button:focus-visible, .hub-body input:focus-visible, .hub-body summary:focus-visible { outline: 2px solid #6cc8ff; outline-offset: 1px; }
@media (prefers-reduced-motion: reduce) { .hub-grip::after { transition: none; } }
`;
  document.head.appendChild(css);
}

export class HubPanel {
  private readonly tabs = new HubTabs();
  private root: HTMLDivElement;
  private bar: HTMLDivElement;
  private foldBtn: HTMLButtonElement;
  private body: HTMLDivElement;
  private current = '';
  /** The tab on show (rendered and not since hidden) */
  private drawn = '';
  private folded = false;
  private want = DEFAULT_BODY;
  private state: HubState = 'off';
  private summoned = false;
  /** On show only because it was called up (over the station or hangar, or a window too short for it): Esc puts it away */
  private forced = false;
  /** The pilot opened a tab (a key, a click): it may lift over the pilot readout for room, until folded or put away */
  private engaged = false;
  private visible = false;
  private pilot: string | null = null;
  /** The cargo panel's ceiling, as last placed */
  private cargoCeil = 0;
  private chrome = 30;
  private placedAt = 0;
  private liveAt = 0;
  /** A redraw put off while the pilot types in the tab */
  private pending = false;

  constructor(private deps: HubDeps) {
    injectStyles();
    this.folded = loadFolded();
    this.want = loadHeight(MIN_BODY) ?? DEFAULT_BODY;
    this.root = document.createElement('div');
    this.root.className = 'hub';
    this.root.dataset.hudAvoid = '1';
    this.root.classList.toggle('folded', this.folded);
    this.root.innerHTML = '<div class="hub-grip" title="Drag to resize"></div><div class="hub-bar" role="tablist" aria-label="Side panel"></div><div class="hub-body" role="tabpanel" id="hub-body"></div>';
    this.bar = this.root.querySelector('.hub-bar') as HTMLDivElement;
    this.body = this.root.querySelector('.hub-body') as HTMLDivElement;
    this.foldBtn = document.createElement('button');
    this.foldBtn.className = 'hub-fold';
    this.foldBtn.onclick = (e) => { this.setFolded(!this.folded); this.deps.sound('ui_click', 0.4); this.blurIfMouse(e); };
    this.grip(this.root.querySelector('.hub-grip') as HTMLElement);
    this.bar.addEventListener('keydown', (e) => this.barKey(e));
    // Esc anywhere in it hands the keyboard back to the game (not the menu)
    this.root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && document.activeElement && this.root.contains(document.activeElement)) {
        (document.activeElement as HTMLElement).blur();
        e.stopPropagation();
        e.preventDefault();
      }
    });
    // A redraw put off while typing happens when the pilot leaves the field
    this.body.addEventListener('focusout', () => setTimeout(() => { if (this.pending && !this.typing()) this.redraw(); }, 0));
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
    document.body.appendChild(this.root);
    window.addEventListener('resize', () => this.place());
  }

  /** Add a tab (in order: the bar shows them as registered) */
  register(tab: HubTab): void {
    this.tabs.add(tab);
    tab.attach?.({
      invalidate: () => { this.renderBar(); if (this.drawn === tab.id) this.redraw(); },
      shown: () => this.drawn === tab.id,
    });
    if (!this.current) this.current = tab.id;
    this.renderBar();
  }

  get isFolded(): boolean {
    return this.folded;
  }

  /** On screen (and not folded) with this tab */
  showing(id: string): boolean {
    return this.visible && !this.folded && this.current === id;
  }

  /** Show this tab, unfolded; called up over the station or hangar, or in a window too short for it, if it's hidden there */
  open(id: string): void {
    if (!this.tabs.get(id)) return;
    if (this.state === 'off') return;
    this.summoned = true;
    this.engaged = true;
    const was = this.showing(id);
    this.select(id, false);
    if (this.folded) this.setFolded(false);
    if (!was) this.deps.sound('ui_open', 0.5);
    this.refreshVisible();
  }

  /** The tab's key: open it, or fold it (put it away, if called up) when it's already on show */
  toggle(id: string): void {
    if (this.showing(id)) {
      if (!this.dismiss()) { this.setFolded(true); this.deps.sound('ui_close', 0.5); }
      return;
    }
    this.open(id);
  }

  /** Esc: put away a panel on show only because it was called up (true if it did) */
  dismiss(): boolean {
    if (!this.summoned || !this.forced) return false;
    this.summoned = false;
    this.deps.sound('ui_close', 0.5);
    this.refreshVisible();
    return true;
  }

  /** Choose a tab (the tab bar, the arrow keys, open) */
  select(id: string, sound = true): void {
    if (!this.tabs.get(id)) return;
    if (id !== this.current) {
      this.hideDrawn();
      this.current = id;
      if (this.pilot !== null) saveTab(this.pilot, id);
      if (sound) this.deps.sound('ui_click', 0.4);
    }
    this.renderBar();
    if (this.visible && !this.folded) this.redraw();
  }

  setFolded(on: boolean): void {
    if (on === this.folded) return;
    this.folded = on;
    saveFolded(on);
    this.root.classList.toggle('folded', on);
    if (on) { this.hideDrawn(); this.engaged = false; this.summoned = false; }
    else if (this.visible) this.redraw();
    this.renderBar();
    this.place();
  }

  /** The cargo panel's ceiling: below the readout and this panel */
  cargoCeiling(): number {
    return this.cargoCeil;
  }

  /** Each frame: where it may be, the pilot (their saved tab), live tabs, and its place now and then */
  update(state: HubState): void {
    const name = this.deps.player();
    if (name !== this.pilot) {
      this.pilot = name;
      const t = loadTab(name, this.tabs.ids());
      if (t && t !== this.current) { this.hideDrawn(); this.current = t; this.renderBar(); if (this.visible && !this.folded) this.redraw(); }
    }
    if (state !== this.state) {
      this.state = state;
      if (state !== 'covered') this.summoned = false;
      this.refreshVisible();
    }
    const now = performance.now();
    if (this.visible && now - this.placedAt > 500) this.place();
    const tab = this.tabs.get(this.current);
    if (tab?.live && this.drawn === tab.id && now - this.liveAt > tab.live) { this.liveAt = now; this.redraw(); }
  }

  // ---------------------------------------------------------------------------

  private refreshVisible(): void {
    const want = this.state === 'on' || (this.state === 'covered' && this.summoned);
    if (!want) this.setVisible(false);
    this.place();
  }

  private setVisible(on: boolean): void {
    if (on === this.visible) return;
    this.visible = on;
    this.root.classList.toggle('on', on);
    if (!on) { this.hideDrawn(); hideTip(); closeMenu(); }
    else if (!this.folded) this.redraw();
  }

  /** Size and place it in the column (hubLayout), then let the cargo panel take the rest */
  place(): void {
    this.placedAt = performance.now();
    const want = this.state === 'on' || (this.state === 'covered' && this.summoned);
    const col = this.deps.column();
    if (!want) {
      this.forced = false;
      this.root.classList.remove('over');
      this.cargoCeil = col.ceiling - GAP;
      this.deps.relayoutCargo();
      return;
    }
    // (Its frame, measured while it's on screen; folded it's the whole box)
    if (this.visible) {
      const h = this.root.offsetHeight - (this.folded ? 0 : this.body.offsetHeight);
      if (h > 0) this.chrome = h;
    }
    const column = { floor: col.floor, cargoMin: col.cargoMin, ceiling: col.ceiling, lift: col.lift, gap: GAP };
    const wants = { chrome: this.chrome, body: this.want, minBody: MIN_BODY, folded: this.folded, summoned: this.summoned, lift: this.engaged };
    const p = hubLayout(column, wants);
    // (Called up where it would be hidden: drawn over everything, and Esc puts it away)
    this.forced = this.summoned && (this.state === 'covered' || hubLayout(column, { ...wants, summoned: false }).hidden);
    this.root.classList.toggle('over', this.forced);
    this.cargoCeil = p.cargoCeiling;
    this.root.classList.toggle('lifted', p.lifted);
    // (The tab bar alone: the body goes, without folding it for good)
    this.body.style.display = p.body > 0 || this.folded ? '' : 'none';
    if (p.body > 0) this.body.style.height = `${Math.round(p.body)}px`;
    this.setVisible(!p.hidden);
    this.deps.relayoutCargo();
    this.position();
  }

  /** Sit on top of the cargo panel (or where it would be), the column's width */
  position(): void {
    if (!this.visible) return;
    const col = this.deps.column();
    const bottomY = col.cargoTop > 0 ? col.cargoTop - GAP : col.floor;
    this.root.style.left = `${Math.round(col.left)}px`;
    this.root.style.width = `${Math.round(col.width)}px`;
    this.root.style.bottom = `${Math.round(innerHeight - bottomY)}px`;
  }

  private renderBar(): void {
    const focused = this.root.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.tab : undefined;
    this.bar.replaceChildren();
    for (const t of this.tabs.all()) {
      const b = document.createElement('button');
      b.className = 'hub-tab';
      b.id = `hub-tab-${t.id}`;
      b.dataset.tab = t.id;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-controls', 'hub-body');
      const on = t.id === this.current;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      const key = t.action ? boundKeyName(t.action, settings.data.bindings) : '';
      b.title = `${t.title}${key ? ` (${key})` : ''}${on && !this.folded ? ' · click to fold' : ''}`;
      const n = t.badge?.() ?? 0;
      b.textContent = t.label;
      if (n) {
        const s = document.createElement('span');
        s.className = 'badge';
        s.textContent = String(n);
        s.setAttribute('aria-label', `${n} waiting`);
        b.appendChild(s);
      }
      b.onclick = (e) => {
        if (on && !this.folded) { this.setFolded(true); this.deps.sound('ui_close', 0.4); }
        else { this.engaged = true; this.select(t.id); if (this.folded) this.setFolded(false); else this.place(); }
        this.blurIfMouse(e);
      };
      this.bar.appendChild(b);
      if (focused === t.id) b.focus();
    }
    this.foldBtn.textContent = this.folded ? '▸' : '▾';
    this.foldBtn.title = this.folded ? 'Unfold' : 'Fold';
    this.foldBtn.setAttribute('aria-label', this.folded ? 'Unfold the side panel' : 'Fold the side panel');
    this.foldBtn.setAttribute('aria-expanded', this.folded ? 'false' : 'true');
    this.bar.appendChild(this.foldBtn);
    const cur = this.tabs.get(this.current);
    this.body.setAttribute('aria-labelledby', `hub-tab-${this.current}`);
    this.body.classList.toggle('fill', !!cur?.fill);
  }

  /** Arrow keys, Home and End along the tab bar (kept from flying the ship) */
  private barKey(e: KeyboardEvent): void {
    const id = (e.target as HTMLElement).dataset?.tab;
    if (!id) return;
    let to: string | undefined;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') to = this.tabs.step(id, 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') to = this.tabs.step(id, -1);
    else if (e.key === 'Home') to = this.tabs.all()[0]?.id;
    else if (e.key === 'End') to = this.tabs.all().at(-1)?.id;
    else if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); return; }
    if (!to) return;
    e.preventDefault();
    e.stopPropagation();
    this.engaged = true;
    this.select(to);
    if (this.folded) this.setFolded(false); else this.place();
    this.bar.querySelector<HTMLElement>(`[data-tab="${to}"]`)?.focus();
  }

  /** A mouse click leaves no focus on the button (Space and Enter stay the ship's); the keyboard keeps it */
  private blurIfMouse(e: MouseEvent): void {
    if (e.detail > 0) (e.currentTarget as HTMLElement | null)?.blur();
  }

  private typing(): boolean {
    const a = document.activeElement as HTMLElement | null;
    return !!a && this.body.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA');
  }

  private redraw(): void {
    if (!this.visible || this.folded) return;
    if (this.typing()) { this.pending = true; return; }
    this.pending = false;
    const tab = this.tabs.get(this.current);
    if (!tab) return;
    if (this.drawn && this.drawn !== tab.id) this.hideDrawn();
    // (Drawn again, it keeps its scroll: a live tab redraws while the pilot reads it)
    const again = this.drawn === tab.id, scroll = this.body.scrollTop;
    this.drawn = tab.id;
    this.liveAt = performance.now();
    tab.render(this.body);
    if (again) this.body.scrollTop = scroll;
  }

  private hideDrawn(): void {
    if (!this.drawn) return;
    const t = this.tabs.get(this.drawn);
    this.drawn = '';
    t?.hide?.();
    this.body.replaceChildren();
    this.body.scrollTop = 0;
  }

  /** Drag the top edge: taller upwards (kept for next time) */
  private grip(el: HTMLElement): void {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      el.classList.add('drag');
      this.engaged = true;
      const y0 = e.clientY, h0 = this.body.offsetHeight;
      const move = (ev: PointerEvent) => { this.want = Math.max(MIN_BODY, Math.round(h0 + (y0 - ev.clientY))); this.place(); };
      const up = () => {
        el.classList.remove('drag');
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        // What it could actually have: dragging past the room keeps the most that fits
        this.want = Math.max(MIN_BODY, Math.min(this.want, this.body.offsetHeight || this.want));
        saveHeight(this.want);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
  }
}
