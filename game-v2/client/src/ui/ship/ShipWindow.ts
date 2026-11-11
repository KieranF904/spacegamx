/**
 * @contract client.ui.ship.window
 * owns:       the Ship window: one tabbed panel on the right of the screen (Status, Power, Weapons, Pickup, Refiner,
 *             Fabricator, Kills), opened on a tab by the footer, its key or another panel; live tabs redrawn at their rate
 * needs:      ShipTab / ShipCtx (shipTabs.ts), windowKit styles, the tabs from tabs/index.ts
 * invariants: it is not modal: no veil, the flight keys still reach the game (only typing in a field stays in it), and
 *             while it is open the guns are held (Game passes isOpen to app/inputSend.ts fireBlocked) —
 *             client/src/app/inputSend.test.ts
 *             open(tab) shows that tab; toggle(tab) on the tab on show closes it — client/src/ui/ship/shipWindow.test.ts
 * extend:     a new tab is a ShipTab module in tabs/ and a line in tabs/index.ts; nothing here names a tab
 */

import { injectWindowStyles, hideTip, closeMenu } from '../windowKit';
import type { ShipCtx, ShipTab, ShipTabId } from './shipTabs';

const CSS = `
.sgsw { position: fixed; right: 16px; top: 60px; width: min(470px, calc(100vw - 32px)); max-height: calc(100vh - 180px); z-index: 2600;
  display: none; flex-direction: column; }
.sgsw.on { display: flex; }
.sgsw .sgw-head { padding: 10px 14px; gap: 10px; }
.sgsw .sgw-tabs { padding: 0 8px; gap: 0; flex-wrap: wrap; }
.sgsw .sgw-tab { padding: 8px 9px; font-size: 12px; }
.sgsw .sgw-body { padding: 12px 14px 14px; }
.sgsw .sgw-sub b { color: #fca5a5; font-weight: 600; }
.sgsw-sec { color: #7dd3fc; font: 700 10px 'Segoe UI', sans-serif; letter-spacing: 2px; text-transform: uppercase; margin: 12px 0 6px; display: flex; align-items: center; gap: 8px; }
.sgsw-sec:first-child { margin-top: 0; }
.sgsw-sec span { margin-left: auto; color: #56657c; font-weight: 400; letter-spacing: 0; text-transform: none; font-size: 11px; }
.sgsw-row { display: flex; align-items: center; gap: 8px; padding: 4px 6px; border-radius: 6px; font-size: 12px; }
.sgsw-row:nth-child(even) { background: rgba(255, 255, 255, 0.02); }
.sgsw-row .nm { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #dbe5f3; }
.sgsw-row .v { color: #9fb0cc; white-space: nowrap; font-variant-numeric: tabular-nums; }
.sgsw-row .k { min-width: 18px; padding: 0 5px; border-radius: 4px; border: 1px solid rgba(140, 170, 220, 0.35); color: #cfe0f5; font: 700 10px 'Segoe UI', sans-serif; text-align: center; }
.sgsw-meter { height: 5px; border-radius: 3px; background: rgba(255,255,255,0.07); overflow: hidden; width: 80px; flex: none; }
.sgsw-meter > i { display: block; height: 100%; border-radius: 3px; background: #7dd3fc; }
.sgsw-note { color: #8394ad; font-size: 11.5px; line-height: 1.45; margin: 4px 0; }
.sgsw-warn { color: #fbbf24; }
.sgsw-bad { color: #f87171; }
.sgsw-ok { color: #86efac; }
.sgsw-dim { color: #56657c; }
.sgsw-btns { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0 4px; }
.sgsw-btns .sgw-btn { padding: 5px 11px; }
.sgsw-mini { all: unset; cursor: pointer; padding: 1px 7px; border-radius: 5px; border: 1px solid rgba(140, 170, 220, 0.3); color: #cfe0f5; font-size: 11px; }
.sgsw-mini:hover { background: rgba(125, 211, 252, 0.12); }
.sgsw-mini.on { background: #14532d; border-color: #22c55e; color: #bbf7d0; }
.sgsw select, .sgsw input[type=text], .sgsw input[type=search] { background: #101a30; color: #cfe0f5; border: 1px solid #2a3a5a; border-radius: 6px; padding: 3px 6px; font: 12px 'Segoe UI', sans-serif; color-scheme: dark; }
`;

export class ShipWindow {
  private root: HTMLDivElement;
  private sub: HTMLSpanElement;
  private tabBar: HTMLDivElement;
  private body: HTMLDivElement;
  private buttons = new Map<ShipTabId, HTMLButtonElement>();
  private cur: ShipTabId;
  private drawnAt = 0;
  isOpen = false;
  onChange: ((open: boolean) => void) | null = null;

  constructor(private ctx: ShipCtx, private tabs: readonly ShipTab[]) {
    injectWindowStyles();
    if (!document.getElementById('sgsw-style')) {
      const s = document.createElement('style');
      s.id = 'sgsw-style';
      s.textContent = CSS;
      document.head.appendChild(s);
    }
    this.cur = tabs[0].id;
    this.root = document.createElement('div');
    this.root.className = 'sgw sgsw';
    this.root.dataset.hudAvoid = '1';
    const head = document.createElement('div');
    head.className = 'sgw-head';
    const t = document.createElement('span');
    t.className = 'sgw-title';
    t.textContent = 'Ship';
    this.sub = document.createElement('span');
    this.sub.className = 'sgw-sub';
    const sp = document.createElement('span');
    sp.className = 'sp';
    const x = document.createElement('button');
    x.className = 'sgw-x';
    x.textContent = '×';
    x.title = 'Close (Esc)';
    x.onclick = () => this.close();
    head.append(t, this.sub, sp, x);
    this.tabBar = document.createElement('div');
    this.tabBar.className = 'sgw-tabs';
    this.tabBar.setAttribute('role', 'tablist');
    for (const tab of tabs) {
      const b = document.createElement('button');
      b.className = 'sgw-tab';
      b.textContent = tab.label;
      b.title = tab.title;
      b.setAttribute('role', 'tab');
      b.onclick = () => this.show(tab.id);
      this.buttons.set(tab.id, b);
      this.tabBar.appendChild(b);
    }
    this.body = document.createElement('div');
    this.body.className = 'sgw-body';
    this.body.setAttribute('role', 'tabpanel');
    this.root.append(head, this.tabBar, this.body);
    // Not modal: only typing in a field stays in the window; every other key (the flight keys) reaches the game. A
    // clicked button gives the focus back, so Space and the arrows fly the ship rather than press it again
    this.root.addEventListener('keydown', (e) => {
      const tg = e.target as HTMLElement;
      if (e.code !== 'Escape' && (tg.tagName === 'INPUT' || tg.tagName === 'SELECT' || tg.tagName === 'TEXTAREA')) e.stopPropagation();
    });
    this.root.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button')) (document.activeElement as HTMLElement | null)?.blur?.();
    });
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
    document.body.appendChild(this.root);
  }

  get tab(): ShipTabId { return this.cur; }

  /** Open on a tab (the last one shown if none) */
  open(tab?: ShipTabId): void {
    if (!this.isOpen) {
      this.isOpen = true;
      // (Closed, the last tab already had its hide: nothing to hide again)
      if (tab) this.cur = tab;
      this.root.classList.add('on');
      this.ctx.sound('ui_open');
      this.onChange?.(true);
    }
    this.show(tab ?? this.cur);
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.root.classList.remove('on');
    this.tabs.find((t) => t.id === this.cur)?.hide?.();
    hideTip();
    closeMenu();
    this.ctx.sound('ui_close');
    this.onChange?.(false);
  }

  /** Its key or a footer button: open on `tab`; on the tab already on show, close */
  toggle(tab?: ShipTabId): void {
    if (this.isOpen && (!tab || tab === this.cur)) this.close();
    else this.open(tab);
  }

  private show(id: ShipTabId): void {
    if (id !== this.cur) this.tabs.find((t) => t.id === this.cur)?.hide?.();
    this.cur = id;
    for (const [k, b] of this.buttons) { b.classList.toggle('on', k === id); b.setAttribute('aria-selected', String(k === id)); }
    this.body.replaceChildren();
    this.body.scrollTop = 0;
    this.draw(performance.now());
  }

  private draw(now: number): void {
    this.drawnAt = now;
    const tab = this.tabs.find((t) => t.id === this.cur)!;
    const ship = this.ctx.ship();
    this.sub.textContent = ship ? ship.blueprint.name || 'Your ship' : 'No ship';
    tab.render(this.body, this.ctx);
  }

  /** Each frame: a live tab is drawn again at its rate; `hidden` (a full-screen view over the HUD) closes it */
  update(now: number, hidden: boolean): void {
    if (!this.isOpen) return;
    if (hidden) { this.close(); return; }
    const tab = this.tabs.find((t) => t.id === this.cur)!;
    if (tab.live > 0 && now - this.drawnAt >= tab.live) this.draw(now);
  }

  /** The modal chain (app/keys.ts): Esc closes it; every other key passes on */
  onKey(code: string): boolean {
    if (!this.isOpen || code !== 'Escape') return false;
    this.close();
    return true;
  }
}
