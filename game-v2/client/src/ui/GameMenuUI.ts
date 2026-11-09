/**
 * The Escape menu: Resume, Map, Field guide, Settings, Controls (rebindable),
 * Server, and Leave / Log out. The game keeps running underneath (it's
 * multiplayer), but flight input is off while it's open. (Pilot & ship and the
 * component guide are tabs of the side panel on the HUD now: ui/hub.)
 *
 *   Esc  open · back to the main list from a page · close
 */

import type { GuideTab } from './fieldGuide';
import { Lazy } from '../lazy';
import { ACTIONS, ActionDef, RESERVED_KEYS, keyName } from '../input/keybindings';
import { settings, SettingsData, defaultSettings } from '../settings/Settings';
import { FPS_CAPS, type QualitySetting } from '../settings/quality';
import { esc } from './escape';
import { getTutorialState } from './tutorial/tutorialStore';

export interface MenuShipInfo {
  name: string;
  parts: number;
  mass: number;
  topSpeed: number;
  accel: number;
  turn: number;
  radius: number;
  coreHp: number;
  coreMax: number;
  guns: number;
  turrets: number;
  engines: number;
  power: { supply: number; demand: number };
  controls: 'helm' | 'mouse-steer';
  jump: { phase: string; progress: number; cooldownSecs: number; distance: number };
}

export interface MenuPilotInfo {
  name: string;
  level: number;
  xp: number;
  xpToNext: number;
  credits: number;
  system: string;
  sector: string;
  admin: boolean;
  /** The owner rank (admin is true for them too) */
  owner?: boolean;
}

export interface MenuServerInfo {
  name: string;
  address: string;
  ping: number;
  jitter: number;
  tick: number;
  pilotsHere: number;
  entities: number;
}

export interface MenuDeps {
  /** In-process prototype: no server to leave */
  proto: boolean;
  openMap(): void;
  pilot(): MenuPilotInfo;
  ship(): MenuShipInfo | null;
  server(): MenuServerInfo;
  /** Is the ship in a station's docking ring? (name of the station) */
  dockableStation(): string | null;
  dock(): void;
  /** The rebinding UI's key capture (InputManager.onCapture) */
  captureKey(cb: ((code: string) => void) | null): void;
  leave(): void;
  logout(): void;
  onOpenChange(open: boolean): void;
  /** UI sounds */
  sound(id: string, volume?: number): void;
  /** Run the new-pilot tutorial again */
  replayTutorial?(): void;
  /** Threat ratings by system and siege moon, and your ship's rating (the field guide's tiers) */
  threats?(): Record<string, number>;
  myRating?(): number;
  /** Your level and total XP, and an item's icon (the field guide) */
  level?(): number;
  xp?(): number;
  icon?(id: string): string;
  shipIcon?(parts: { piece: string; rot: number; flip: boolean; x: number; y: number }[], size?: number): string;
  /** The component guide (the side panel's tab) */
  openComponents?(): void;
}

type Page = 'main' | 'guide' | 'settings' | 'controls' | 'server';
type SettingsTab = 'audio' | 'display' | 'ui' | 'gameplay';

/** The field guide's pages, split out of the main chunk (Game prefetches it after sign-in) */
export const fieldGuide = new Lazy(() => import('./fieldGuide').then((m) => {
  // (its CSS goes just ahead of the menu's, as it always has)
  const style = document.createElement('style');
  style.textContent = m.GUIDE_CSS;
  const menu = document.getElementById('game-menu-css');
  if (menu) menu.before(style); else document.head.appendChild(style);
  return m;
}));

const CSS = `
#game-menu { position: fixed; inset: 0; z-index: 3000; display: none; color: #d6deeb;
  font: 14px 'Segoe UI', system-ui, sans-serif; background: radial-gradient(ellipse at 30% 40%, rgba(12, 24, 48, 0.82), rgba(3, 6, 14, 0.93));
  backdrop-filter: blur(5px); -webkit-backdrop-filter: blur(5px); user-select: none; }
#game-menu.open { display: flex; animation: gmIn 0.16s ease-out; }
@keyframes gmIn { from { opacity: 0; } to { opacity: 1; } }
#game-menu .gm-side { width: 300px; padding: 56px 28px 28px 56px; display: flex; flex-direction: column; gap: 4px; flex-shrink: 0; }
#game-menu .gm-title { font: 700 13px 'Segoe UI', sans-serif; letter-spacing: 5px; color: #7dd3fc; margin-bottom: 4px; }
#game-menu .gm-sub { font-size: 12px; color: #6f8099; margin-bottom: 26px; }
#game-menu .gm-item { all: unset; cursor: pointer; padding: 10px 14px; border-radius: 8px; font-size: 16px; letter-spacing: 0.5px;
  color: #c9d4e5; display: flex; align-items: center; gap: 12px; border: 1px solid transparent; transition: background 0.12s, color 0.12s; white-space: nowrap; }
#game-menu .gm-item:hover, #game-menu .gm-item:focus-visible { background: rgba(125, 211, 252, 0.08); color: #fff; border-color: rgba(125, 211, 252, 0.18); }
#game-menu .gm-item.active { background: rgba(125, 211, 252, 0.13); color: #fff; border-color: rgba(125, 211, 252, 0.35); }
#game-menu .gm-item .ic { width: 20px; text-align: center; color: #7dd3fc; opacity: 0.85; }
#game-menu .gm-item .k { margin-left: auto; font-size: 11px; color: #6f8099; }
#game-menu .gm-item.danger { color: #fca5a5; }
#game-menu .gm-item.danger .ic { color: #f87171; }
#game-menu .gm-sep { height: 1px; background: rgba(140, 170, 220, 0.14); margin: 10px 0; }
#game-menu .gm-foot { margin-top: auto; font-size: 11px; color: #56657c; line-height: 1.6; }
#game-menu .gm-main { flex: 1; padding: 56px 56px 40px 24px; overflow-y: auto; min-width: 0; }
#game-menu .gm-panel { max-width: 860px; background: rgba(9, 15, 28, 0.78); border: 1px solid rgba(120, 150, 200, 0.22);
  border-radius: 14px; padding: 26px 30px 30px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.45); }
#game-menu h2 { margin: 0 0 4px; font: 600 22px 'Segoe UI', sans-serif; color: #fff; letter-spacing: 0.5px; }
#game-menu h3 { margin: 22px 0 10px; font: 700 11px 'Segoe UI', sans-serif; letter-spacing: 2.5px; color: #7dd3fc; text-transform: uppercase; }
#game-menu p { color: #a9b6c9; line-height: 1.6; margin: 6px 0; }
#game-menu .muted { color: #6f8099; font-size: 12px; }
#game-menu .tabs { display: flex; gap: 6px; margin: 16px 0 8px; border-bottom: 1px solid rgba(140, 170, 220, 0.15); }
#game-menu .tab { all: unset; cursor: pointer; padding: 8px 14px; color: #8fa0b8; border-bottom: 2px solid transparent; margin-bottom: -1px; }
#game-menu .tab:hover { color: #fff; }
#game-menu .tab.on { color: #fff; border-bottom-color: #7dd3fc; }
#game-menu .row { display: flex; align-items: center; gap: 16px; padding: 11px 2px; border-bottom: 1px solid rgba(140, 170, 220, 0.07); }
#game-menu .row .lbl { flex: 1; min-width: 0; }
#game-menu .row .lbl small { display: block; color: #6f8099; font-size: 12px; margin-top: 2px; }
#game-menu .row .val { width: 46px; text-align: right; color: #9fb3cc; font-variant-numeric: tabular-nums; font-size: 13px; }
#game-menu input[type=range] { width: 220px; accent-color: #7dd3fc; }
#game-menu .sw { all: unset; cursor: pointer; width: 42px; height: 22px; border-radius: 11px; background: #283246; position: relative; transition: background 0.15s; flex-shrink: 0; }
#game-menu .sw::after { content: ''; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: #9aa8bc; transition: left 0.15s, background 0.15s; }
#game-menu .sw.on { background: #1f6f8f; }
#game-menu .sw.on::after { left: 23px; background: #e8f6ff; }
#game-menu .seg { display: flex; border: 1px solid rgba(140, 170, 220, 0.25); border-radius: 8px; overflow: hidden; flex-shrink: 0; }
#game-menu .seg button { all: unset; cursor: pointer; padding: 6px 12px; font-size: 13px; color: #9fb3cc; }
#game-menu .seg button + button { border-left: 1px solid rgba(140, 170, 220, 0.2); }
#game-menu .seg button.on { background: rgba(125, 211, 252, 0.18); color: #fff; }
#game-menu .btn { all: unset; cursor: pointer; padding: 8px 16px; border-radius: 8px; border: 1px solid rgba(140, 170, 220, 0.3); color: #d6deeb; font-size: 13px; }
#game-menu .btn:hover { background: rgba(125, 211, 252, 0.1); border-color: rgba(125, 211, 252, 0.5); }
#game-menu .btn.primary { background: #1d5e7a; border-color: #2c87ad; color: #fff; }
#game-menu .btn.primary:hover { background: #24739a; }
#game-menu .btn.danger { border-color: rgba(248, 113, 113, 0.5); color: #fecaca; }
#game-menu .btn.danger:hover { background: rgba(248, 113, 113, 0.14); }
#game-menu .btn:disabled, #game-menu .btn.off { opacity: 0.4; pointer-events: none; }
#game-menu .actions { display: flex; gap: 10px; margin-top: 20px; flex-wrap: wrap; align-items: center; }
#game-menu .key { all: unset; cursor: pointer; min-width: 96px; text-align: center; padding: 6px 12px; border-radius: 7px; font: 600 13px 'Segoe UI', sans-serif;
  background: #18233a; border: 1px solid rgba(140, 170, 220, 0.3); color: #e8f0fb; box-shadow: inset 0 -2px 0 rgba(0, 0, 0, 0.35); }
#game-menu .key:hover { border-color: #7dd3fc; }
#game-menu .key.fixed { cursor: default; opacity: 0.6; background: transparent; box-shadow: none; }
#game-menu .key.listen { border-color: #ffd166; color: #ffd166; animation: gmBlink 0.9s infinite; }
#game-menu .key.changed { border-color: rgba(125, 211, 252, 0.7); }
@keyframes gmBlink { 50% { opacity: 0.55; } }
#game-menu .alt { width: 92px; color: #6f8099; font-size: 12px; text-align: right; }
#game-menu .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 10px; margin-top: 8px; }
#game-menu .stat { background: rgba(20, 30, 50, 0.6); border: 1px solid rgba(140, 170, 220, 0.12); border-radius: 10px; padding: 10px 12px; }
#game-menu .stat b { display: block; font-size: 18px; color: #fff; font-weight: 600; margin-top: 2px; font-variant-numeric: tabular-nums; }
#game-menu .stat span { font-size: 11px; color: #7a8ba3; letter-spacing: 1px; text-transform: uppercase; }
#game-menu .bar { height: 6px; border-radius: 3px; background: #1b2639; overflow: hidden; margin-top: 8px; }
#game-menu .bar > i { display: block; height: 100%; background: linear-gradient(90deg, #3b82f6, #7dd3fc); }
#game-menu kbd { display: inline-block; padding: 0 6px; border-radius: 4px; background: #1a2740; border: 1px solid #33496d; font: 600 11px 'Segoe UI', sans-serif; color: #e8f0fb; line-height: 18px; }
#game-menu .notice { margin-top: 12px; color: #ffd166; font-size: 13px; min-height: 18px; }
#game-menu .confirm { margin-top: 18px; padding: 14px 16px; border-radius: 10px; border: 1px solid rgba(248, 113, 113, 0.35); background: rgba(80, 20, 20, 0.25); }
@media (max-width: 760px) {
  #game-menu.open { flex-direction: column; overflow-y: auto; }
  #game-menu .gm-side { width: auto; padding: 24px 16px 8px; }
  #game-menu .gm-main { padding: 8px 16px 24px; overflow: visible; }
  #game-menu .gm-panel { padding: 18px 16px; }
  #game-menu input[type=range] { width: 140px; }
}
`;

const ITEMS: { page: Page | 'resume' | 'map' | 'components' | 'leave'; label: string; icon: string; key?: string; danger?: boolean }[] = [
  { page: 'resume', label: 'Resume', icon: '▶', key: 'Esc' },
  { page: 'map', label: 'Galaxy map', icon: '✦' },
  { page: 'guide', label: 'Field guide', icon: '❖' },
  { page: 'settings', label: 'Settings', icon: '⚙' },
  { page: 'controls', label: 'Controls', icon: '⌨' },
  { page: 'server', label: 'Server', icon: '◉' },
  { page: 'leave', label: 'Leave server', icon: '⏻', danger: true },
];

export class GameMenuUI {
  private root: HTMLDivElement;
  private side: HTMLDivElement;
  private main: HTMLDivElement;
  private page: Page = 'main';
  private tab: SettingsTab = 'audio';
  private guideTab: GuideTab = 'progress';
  private open_ = false;
  private listening: string | null = null;
  private notice = '';
  private confirmLeave = false;
  private refreshTimer = 0;

  constructor(private deps: MenuDeps) {
    const style = document.createElement('style');
    style.id = 'game-menu-css';
    style.textContent = CSS;
    document.head.appendChild(style);
    this.root = document.createElement('div');
    this.root.id = 'game-menu';
    this.side = document.createElement('div');
    this.side.className = 'gm-side';
    this.main = document.createElement('div');
    this.main.className = 'gm-main';
    this.root.append(this.side, this.main);
    document.body.appendChild(this.root);
    // Clicking the empty backdrop of the main list closes the menu
    this.main.addEventListener('mousedown', (e) => { if (e.target === this.main && this.page === 'main') this.close(); });
    // Keep game keys out of the page while it's open (the menu has its own handling)
    this.root.addEventListener('wheel', (e) => e.stopPropagation());
    // Button sounds
    let hovered: Element | null = null;
    this.root.addEventListener('pointerover', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (b && b !== hovered) this.deps.sound('ui_hover');
      hovered = b;
    });
    this.root.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button')) this.deps.sound('ui_click');
    });
  }

  get isOpen(): boolean {
    return this.open_;
  }

  open(page: Page = 'main'): void {
    this.open_ = true;
    this.page = page;
    this.confirmLeave = false;
    this.notice = '';
    this.root.classList.add('open');
    this.deps.sound('ui_open', 0.6);
    this.render();
    this.deps.onOpenChange(true);
    // The live page (server) refreshes twice a second
    clearInterval(this.refreshTimer);
    this.refreshTimer = window.setInterval(() => {
      if (this.page === 'server') this.renderMain();
    }, 500);
  }

  /** Open the field guide on a tab (e.g. a link to the Resources entry of an item) */
  openGuide(tab: GuideTab): void {
    this.guideTab = tab;
    if (this.open_) { this.page = 'guide'; this.render(); } else this.open('guide');
  }

  close(): void {
    if (!this.open_) return;
    this.stopListening();
    this.open_ = false;
    this.deps.sound('ui_close', 0.6);
    this.root.classList.remove('open');
    clearInterval(this.refreshTimer);
    this.deps.onOpenChange(false);
  }

  toggle(): void {
    if (this.open_) this.close(); else this.open();
  }

  /** Esc: cancel a rebind, leave a page, or close. */
  back(): void {
    if (this.listening) { this.stopListening(); this.renderMain(); return; }
    if (this.confirmLeave) { this.confirmLeave = false; this.renderMain(); return; }
    if (this.page !== 'main') { this.page = 'main'; this.render(); return; }
    this.close();
  }

  // -------------------------------------------------------------------------

  private render(): void {
    this.renderSide();
    this.renderMain();
  }

  private renderSide(): void {
    const pilot = this.deps.pilot();
    this.side.innerHTML = `<div class="gm-title">MENU</div><div class="gm-sub">${esc(pilot.name)} · ${esc(pilot.system)}</div>`;
    for (const it of ITEMS) {
      if (it.page === 'leave' && this.deps.proto) continue;
      if (it.page === 'server' || it.page === 'leave') {
        if (!this.side.querySelector('.gm-sep')) this.side.insertAdjacentHTML('beforeend', '<div class="gm-sep"></div>');
      }
      const b = document.createElement('button');
      b.className = `gm-item${it.danger ? ' danger' : ''}${this.page === it.page ? ' active' : ''}`;
      const key = it.page === 'map' ? keyName(settings.data.bindings.map ?? 'KeyM') : it.key;
      b.innerHTML = `<span class="ic">${it.icon}</span>${it.label}${key ? `<span class="k">${key}</span>` : ''}`;
      b.addEventListener('click', () => this.choose(it.page));
      this.side.appendChild(b);
    }
    this.side.insertAdjacentHTML('beforeend', `<div class="gm-foot">The universe keeps moving while this menu is open.<br>Flight controls are paused.</div>`);
  }

  private choose(page: Page | 'resume' | 'map' | 'components' | 'leave'): void {
    if (page === 'resume') return this.close();
    if (page === 'components') { this.close(); this.deps.openComponents?.(); return; }
    if (page === 'map') { this.close(); this.deps.openMap(); return; }
    if (page === 'leave') { this.page = 'server'; this.confirmLeave = true; this.render(); return; }
    this.stopListening();
    this.page = page;
    this.notice = '';
    this.confirmLeave = false;
    this.render();
  }

  private renderMain(): void {
    // Don't rebuild under the pointer while a slider is being dragged
    if (this.root.contains(document.activeElement) && (document.activeElement as HTMLElement).tagName === 'INPUT' && this.page === 'settings') return;
    const panel = document.createElement('div');
    panel.className = 'gm-panel';
    switch (this.page) {
      case 'main': this.main.innerHTML = ''; this.main.appendChild(this.welcome()); return;
      case 'guide': this.guidePage(panel); break;
      case 'settings': this.settingsPage(panel); break;
      case 'controls': this.controlsPage(panel); break;
      case 'server': this.serverPage(panel); break;
    }
    const scroll = this.main.scrollTop;
    this.main.innerHTML = '';
    this.main.appendChild(panel);
    this.main.scrollTop = scroll;
  }

  // -------------------------------------------------------------------------
  // Pages
  // -------------------------------------------------------------------------

  private welcome(): HTMLElement {
    const p = this.deps.pilot();
    const ship = this.deps.ship();
    const el = document.createElement('div');
    el.className = 'gm-panel';
    el.style.maxWidth = '560px';
    const dock = this.deps.dockableStation();
    el.innerHTML = `
      <h2>${esc(p.system)}</h2>
      <p class="muted">${esc(p.sector)}</p>
      <div class="grid">
        <div class="stat"><span>Pilot</span><b>${esc(p.name)}</b></div>
        <div class="stat"><span>Level</span><b>${p.level}</b><div class="bar"><i style="width:${pct(p.xp, p.xpToNext)}%"></i></div></div>
        <div class="stat"><span>Credits</span><b>${p.credits.toLocaleString()}</b></div>
        <div class="stat"><span>Ship</span><b>${esc(ship?.name ?? '—')}</b></div>
      </div>
      <div class="actions">
        <button class="btn primary" data-a="resume">Resume</button>
        ${dock ? `<button class="btn" data-a="dock">Dock at ${esc(dock)}</button>` : ''}
        <button class="btn" data-a="map">Open map</button>
      </div>`;
    el.querySelector('[data-a=resume]')!.addEventListener('click', () => this.close());
    el.querySelector('[data-a=map]')!.addEventListener('click', () => this.choose('map'));
    el.querySelector('[data-a=dock]')?.addEventListener('click', () => { this.close(); this.deps.dock(); });
    return el;
  }

  private guidePage(panel: HTMLElement): void {
    const fg = fieldGuide.value;
    if (!fg) {
      panel.innerHTML = '<h2>Field guide</h2><p class="muted">Loading…</p>';
      fieldGuide.use(() => { if (this.isOpen && this.page === 'guide') this.renderMain(); });
      return;
    }
    const { GUIDE_TABS, guideHtml, wireGuideCharts } = fg;
    const k = (id: string) => `<kbd>${keyName(settings.data.bindings[id] ?? ACTIONS.find((a) => a.id === id)!.key)}</kbd>`;
    panel.classList.add('fg');
    // (The old flight-school tour is offered only where it is the lesson: a server that runs the training yard teaches there)
    const replay = !!this.deps.replayTutorial && !getTutorialState();
    panel.innerHTML = `<div class="fg-head"><h2>Field guide</h2><p class="muted">What a pilot needs to know${replay ? ' · <button class="btn" data-a="tutorial" style="padding:3px 10px">Replay flight school</button>' : ''}</p></div>
      <div class="fg-tabs">${GUIDE_TABS.map((t) => `<button class="fg-tab${t.id === this.guideTab ? ' on' : ''}" data-tab="${t.id}">${t.label}</button>`).join('')}</div>
      <div class="fg-body">${guideHtml(this.guideTab, { k, threats: () => this.deps.threats?.() ?? {}, myRating: () => this.deps.myRating?.() ?? 0, level: () => this.deps.level?.() ?? 1, xp: () => this.deps.xp?.() ?? 0, icon: (id) => this.deps.icon?.(id) ?? '', shipIcon: this.deps.shipIcon })}</div>`;
    panel.querySelector<HTMLButtonElement>('[data-a="tutorial"]')?.addEventListener('click', () => { this.close(); this.deps.replayTutorial?.(); });
    for (const b of panel.querySelectorAll<HTMLElement>('[data-tab]')) b.onclick = () => { this.guideTab = b.dataset.tab as GuideTab; this.renderMain(); };
    wireGuideCharts(panel);
  }


  private settingsPage(panel: HTMLElement): void {
    const s = settings.data;
    panel.innerHTML = `<h2>Settings</h2><p class="muted">Saved on this device</p>`;
    const tabs = document.createElement('div');
    tabs.className = 'tabs';
    const TABS: [SettingsTab, string][] = [['audio', 'Audio'], ['display', 'Display'], ['ui', 'Interface'], ['gameplay', 'Gameplay']];
    for (const [id, label] of TABS) {
      const b = document.createElement('button');
      b.className = `tab${this.tab === id ? ' on' : ''}`;
      b.textContent = label;
      b.addEventListener('click', () => { this.tab = id; this.renderMain(); });
      tabs.appendChild(b);
    }
    panel.appendChild(tabs);
    const body = document.createElement('div');
    panel.appendChild(body);

    const upd = (fn: (d: SettingsData) => void, rerender = false) => { settings.update(fn); if (rerender) this.renderMain(); };
    if (this.tab === 'audio') {
      body.append(
        slider('Master volume', s.audio.master, 0, 1, 0.05, pctFmt, (v) => upd((d) => { d.audio.master = v; })),
        slider('Effects', s.audio.sfx, 0, 1, 0.05, pctFmt, (v) => upd((d) => { d.audio.sfx = v; })),
        slider('Music', s.audio.music, 0, 1, 0.05, pctFmt, (v) => upd((d) => { d.audio.music = v; })),
        toggle('Mute when the window is in the background', s.audio.muteUnfocused, (v) => upd((d) => { d.audio.muteUnfocused = v; })),
      );
    } else if (this.tab === 'display') {
      body.append(
        slider('Screen shake', s.display.screenShake, 0, 1.5, 0.1, pctFmt, (v) => upd((d) => { d.display.screenShake = v; })),
        toggle('Jump drive screen effects', s.display.jumpEffects, (v) => upd((d) => { d.display.jumpEffects = v; }), 'Star streaks and the spooling vignette'),
        toggle('Pull the camera back during a jump', s.display.jumpCamera, (v) => upd((d) => { d.display.jumpCamera = v; })),
        toggle('Planets and moons', s.display.planets, (v) => upd((d) => { d.display.planets = v; }), 'Turn off on slow GPUs'),
        slider('Your shield at rest', s.display.ownShield, 0, 1, 0.1, pctFmt, (v) => upd((d) => { d.display.ownShield = v; })),
        toggle('Damage numbers', s.display.damageNumbers, (v) => upd((d) => { d.display.damageNumbers = v; })),
        toggle('Pilot names', s.display.playerNames, (v) => upd((d) => { d.display.playerNames = v; })),
        toggle('Bloom', s.display.bloom, (v) => upd((d) => { d.display.bloom = v; }), 'Glow around engines, shots and sparks'),
        toggle('Lighting', s.display.lighting, (v) => upd((d) => { d.display.lighting = v; }), 'Ships, stations and asteroids lit by the sun, weapons and lamps. Off: flat colours'),
        slider('Render resolution', s.display.renderScale, 0.5, 1, 0.05, pctFmt, (v) => upd((d) => { d.display.renderScale = v; })),
        segmented('Graphics quality', 'Bloom size, star layers, effect particles and the pixel density. Anti-aliasing (off on Low) applies the next time the game loads. Auto steps down by itself when the frame rate drops',
          [['auto', 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], s.display.quality,
          (v) => upd((d) => { d.display.quality = v as QualitySetting; }, true)),
        segmented('Frame rate limit', 'Off draws as fast as the screen allows. A limit saves power and heat',
          FPS_CAPS.map((c): [string, string] => [String(c), c ? String(c) : 'Off']), String(s.display.fpsCap),
          (v) => upd((d) => { d.display.fpsCap = +v; }, true)),
      );
    } else if (this.tab === 'ui') {
      body.append(
        toggle('Navigation markers', s.ui.navMarkers, (v) => upd((d) => { d.ui.navMarkers = v; }), `Edge-of-screen pointers to stations, gates and more (${keyName(s.bindings.nav ?? 'KeyN')})`),
        toggle('Minimap', s.ui.minimap, (v) => upd((d) => { d.ui.minimap = v; })),
        toggle('Ship schematic', s.ui.shipHud, (v) => upd((d) => { d.ui.shipHud = v; })),
        toggle('Performance monitor', s.ui.netStats, (v) => upd((d) => { d.ui.netStats = v; }), 'FPS, frame time, ping and jitter graphs, entities'),
        toggle('Chat box', s.ui.chat, (v) => upd((d) => { d.ui.chat = v; })),
        toggle('Hazard screen effects', s.ui.hazardEffects, (v) => upd((d) => { d.ui.hazardEffects = v; }), 'Haze, darkness and radiation tints (the warnings stay)'),
        toggle('Jobs tracker', s.ui.questTracker, (v) => upd((d) => { d.ui.questTracker = v; }), 'The list of your jobs at the right. Off: just its header (SHOW brings it back)'),
        toggle('Objective guide', s.ui.questGuide, (v) => upd((d) => { d.ui.questGuide = v; }), 'For the job you follow: the next waypoint under the tracker (the gate, rift or planet on the way), and chevrons from your ship pointing at it'),
      );
    } else {
      body.append(
        segmented('Default controls', 'Which mode a ship starts in', [['mouse', 'Mouse-steer'], ['helm', 'Helm']], s.gameplay.controlMode,
          (v) => upd((d) => { d.gameplay.controlMode = v as any; }, true)),
        segmented('View', 'North up, or turned so your nose points up the screen', [['auto', 'With controls'], ['north', 'North up'], ['heading', 'Follow heading']], s.gameplay.cameraMode,
          (v) => upd((d) => { d.gameplay.cameraMode = v as any; }, true)),
        segmented('Jump drive key', 'Tap to engage, or hold to spool (let go to abort)', [['tap', 'Tap'], ['hold', 'Hold']], s.gameplay.jumpMode,
          (v) => upd((d) => { d.gameplay.jumpMode = v as any; }, true)),
        slider('Zoom speed', s.gameplay.zoomSpeed, 0.4, 2, 0.1, (v) => `${v.toFixed(1)}×`, (v) => upd((d) => { d.gameplay.zoomSpeed = v; })),
        toggle('Invert mouse wheel zoom', s.gameplay.invertZoom, (v) => upd((d) => { d.gameplay.invertZoom = v; })),
        toggle('Mouse wheel changes weapon group', s.gameplay.wheelGroups, (v) => upd((d) => { d.gameplay.wheelGroups = v; }), 'The wheel picks the left group instead of zooming'),
        toggle('Number keys pick weapon group', s.gameplay.digitGroups, (v) => upd((d) => { d.gameplay.digitGroups = v; }), '1-4 pick a group, 5 picks all. Off: the quick bar'),
      );
      const note = document.createElement('p');
      note.className = 'muted';
      note.style.marginTop = '12px';
      note.textContent = `Mouse-steer unless you pick helm here (or switch with ${keyName(s.bindings.helm ?? 'KeyV')}). `
        + `The view: "With controls" turns it with your ship at the helm and keeps it north up for mouse-steer; or pick one for both (or switch with ${keyName(s.bindings.camera ?? 'Backquote')}). `
        + 'Mouse-steer with the view following your heading: the cursor stays on its spot in space as the view turns, WASD push along your ship, and a click captures the mouse (Esc lets it go).';
      body.appendChild(note);
    }
    const actions = document.createElement('div');
    actions.className = 'actions';
    const reset = button('Reset this page', 'btn', () => {
      const section = this.tab === 'audio' ? 'audio' : this.tab === 'display' ? 'display' : this.tab === 'ui' ? 'ui' : 'gameplay';
      settings.reset(section);
      this.renderMain();
    });
    actions.appendChild(reset);
    panel.appendChild(actions);
  }

  private controlsPage(panel: HTMLElement): void {
    const b = settings.data.bindings;
    const defaults = defaultSettings().bindings;
    panel.innerHTML = `<h2>Controls</h2><p class="muted">Click a key to rebind it, then press the new key. Esc cancels. Binding a key that's already in use swaps the two.</p>`;
    const cats = [...new Set(ACTIONS.map((a) => a.category))];
    for (const cat of cats) {
      const h = document.createElement('h3');
      h.textContent = cat;
      panel.appendChild(h);
      for (const a of ACTIONS.filter((x) => x.category === cat)) panel.appendChild(this.bindingRow(a, b, defaults));
    }
    const notice = document.createElement('div');
    notice.className = 'notice';
    notice.textContent = this.notice;
    panel.appendChild(notice);
    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.appendChild(button('Reset all to defaults', 'btn', () => {
      settings.update((d) => { d.bindings = defaultSettings().bindings; });
      this.notice = 'Controls reset to defaults.';
      this.renderMain();
    }));
    panel.appendChild(actions);
  }

  private bindingRow(a: ActionDef, b: Record<string, string>, defaults: Record<string, string>): HTMLElement {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<div class="lbl">${esc(a.label)}${a.hint ? `<small>${esc(a.hint)}</small>` : ''}</div>`;
    const alt = document.createElement('div');
    alt.className = 'alt';
    alt.textContent = a.alt ? `or ${keyName(a.alt)}` : '';
    const key = document.createElement('button');
    if (a.rebindable === false) {
      key.className = 'key fixed';
      key.textContent = keyName(a.key);
      key.title = 'Fixed';
    } else {
      const code = b[a.id] ?? a.key;
      key.className = `key${this.listening === a.id ? ' listen' : ''}${code !== defaults[a.id] ? ' changed' : ''}`;
      key.textContent = this.listening === a.id ? 'Press a key…' : keyName(code);
      key.addEventListener('click', () => this.listen(a.id));
    }
    row.append(alt, key);
    return row;
  }

  private listen(actionId: string): void {
    this.listening = actionId;
    this.notice = '';
    this.renderMain();
    this.deps.captureKey((code) => {
      this.listening = null;
      if (code === 'Escape') { this.renderMain(); return; }
      if (RESERVED_KEYS.has(code)) {
        this.notice = `${keyName(code)} can't be bound.`;
        this.renderMain();
        return;
      }
      const action = ACTIONS.find((x) => x.id === actionId)!;
      settings.update((d) => {
        const prev = d.bindings[actionId];
        const clash = Object.keys(d.bindings).find((id) => id !== actionId && d.bindings[id] === code);
        d.bindings[actionId] = code;
        if (clash) {
          d.bindings[clash] = prev;
          const other = ACTIONS.find((x) => x.id === clash)!;
          this.notice = `${keyName(code)} was ${other.label}: swapped, ${other.label} is now ${keyName(prev)}.`;
        } else {
          this.notice = `${action.label}: ${keyName(code)}`;
        }
      });
      this.renderMain();
    });
  }

  private stopListening(): void {
    if (!this.listening) return;
    this.listening = null;
    this.deps.captureKey(null);
  }

  private serverPage(panel: HTMLElement): void {
    const s = this.deps.server();
    const quality = s.ping < 60 ? ['Excellent', '#4ade80'] : s.ping < 120 ? ['Good', '#a3e635'] : s.ping < 200 ? ['Fair', '#facc15'] : ['Poor', '#f87171'];
    panel.innerHTML = `<h2>${esc(s.name)}</h2><p class="muted">${esc(s.address)}</p>
      <div class="grid" style="margin-top:16px">
        <div class="stat"><span>Ping</span><b style="color:${quality[1]}">${s.ping} ms</b><small class="muted">${quality[0]}</small></div>
        <div class="stat"><span>Jitter</span><b>${s.jitter} ms</b></div>
        <div class="stat"><span>Pilots in system</span><b>${s.pilotsHere}</b></div>
        <div class="stat"><span>Objects tracked</span><b>${s.entities}</b></div>
        <div class="stat"><span>Server tick</span><b>${s.tick.toLocaleString()}</b></div>
      </div>
      <div class="actions">
        ${this.deps.proto ? '<span class="muted">Prototype mode runs the server in this tab.</span>' : `
        <button class="btn" data-a="copy">Copy server address</button>
        <button class="btn danger" data-a="leave">Leave server</button>
        <button class="btn danger" data-a="logout">Log out</button>`}
      </div>
      ${this.confirmLeave ? `<div class="confirm"><p style="margin-top:0">Leave <b>${esc(s.name)}</b>? Your refitted ship is kept if you're logged in.</p>
        <div class="actions" style="margin-top:8px"><button class="btn danger" data-a="confirm">Leave</button><button class="btn" data-a="cancel">Stay</button></div></div>` : ''}
      <div class="notice">${esc(this.notice)}</div>`;
    panel.querySelector('[data-a=copy]')?.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(s.address); this.notice = 'Address copied.'; } catch { this.notice = s.address; }
      this.renderMain();
    });
    panel.querySelector('[data-a=leave]')?.addEventListener('click', () => { this.confirmLeave = true; this.renderMain(); });
    panel.querySelector('[data-a=confirm]')?.addEventListener('click', () => this.deps.leave());
    panel.querySelector('[data-a=cancel]')?.addEventListener('click', () => { this.confirmLeave = false; this.renderMain(); });
    panel.querySelector('[data-a=logout]')?.addEventListener('click', () => this.deps.logout());
  }
}

// ---------------------------------------------------------------------------
// Small builders
// ---------------------------------------------------------------------------


function pct(v: number, max: number): number {
  return max > 0 ? Math.max(0, Math.min(100, (v / max) * 100)) : 0;
}

const pctFmt = (v: number) => `${Math.round(v * 100)}%`;

function row(label: string, hint?: string): HTMLDivElement {
  const r = document.createElement('div');
  r.className = 'row';
  r.innerHTML = `<div class="lbl">${esc(label)}${hint ? `<small>${esc(hint)}</small>` : ''}</div>`;
  return r;
}

function slider(label: string, value: number, min: number, max: number, step: number, fmt: (v: number) => string, onChange: (v: number) => void): HTMLElement {
  const r = row(label);
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  const val = document.createElement('div');
  val.className = 'val';
  val.textContent = fmt(value);
  input.addEventListener('input', () => { val.textContent = fmt(+input.value); onChange(+input.value); });
  input.addEventListener('change', () => input.blur());
  r.append(input, val);
  return r;
}

function toggle(label: string, value: boolean, onChange: (v: boolean) => void, hint?: string): HTMLElement {
  const r = row(label, hint);
  const sw = document.createElement('button');
  sw.className = `sw${value ? ' on' : ''}`;
  sw.setAttribute('role', 'switch');
  sw.setAttribute('aria-checked', String(value));
  sw.setAttribute('aria-label', label);
  sw.addEventListener('click', () => {
    const on = !sw.classList.contains('on');
    sw.classList.toggle('on', on);
    sw.setAttribute('aria-checked', String(on));
    onChange(on);
  });
  r.appendChild(sw);
  return r;
}

function segmented(label: string, hint: string, options: [string, string][], value: string, onChange: (v: string) => void): HTMLElement {
  const r = row(label, hint);
  const seg = document.createElement('div');
  seg.className = 'seg';
  for (const [v, text] of options) {
    const b = document.createElement('button');
    b.textContent = text;
    if (v === value) b.className = 'on';
    b.addEventListener('click', () => onChange(v));
    seg.appendChild(b);
  }
  r.appendChild(seg);
  return r;
}

function button(text: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = cls;
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}
