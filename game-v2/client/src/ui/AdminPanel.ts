/**
 * The admin panel (F2, admins only): a window at the side that leaves the game
 * playable, with tabs for
 *
 *   Me       where you are and where the cursor is; god mode, hidden from
 *            hostiles, free camera; free build in the hangar (dev servers
 *            only: shown when the server allows it); repair, credits, XP, a level, skill points;
 *            teleport to a system and point, or to any station; Give items
 *            opens the item browser (AdminGive.ts)
 *   Players  everyone online (●), then the accounts that aren't (search by
 *            name): go to them, bring them, watch them, (⋯) repair,
 *            destroy, god mode, credits, give items; and (Manage) their rank, ban or
 *            unban them, kick them, online or not
 *   World    spawn hostiles where you click, bosses at their lairs, clear
 *            hostiles and loot, start events, announce
 *   Server   tick time, memory, bandwidth, prediction, recent errors
 *
 * Keys: F2 the panel, F3 teleport to the cursor, F4 free camera (WASD flies
 * it, Shift faster; F4 again or Esc back to your ship). Everything runs on
 * the server as admin commands (server/src/game/AdminTools.ts), so chat
 * commands (/help) do the same things.
 */

import { RARITY_COLOR, type AdminAccountInfo, type AdminPlayerInfo, type ClientMessage, type Economy, type ServerAdminAccountsMessage, type ServerAdminInfoMessage, type ServerAdminStatsMessage } from '@space-game/common';
import type { GameState } from '../state/GameState';
import { AdminGive, loadGiveRecents } from './AdminGive';
import { itemIcon } from './itemIcons';
import { devBankHtml, devBankMessage } from './station/devBank';
import { closeMenu, injectWindowStyles, openMenu } from './windowKit';
import { esc } from './escape';

type Tab = 'me' | 'players' | 'world' | 'server';

export interface AdminPanelDeps {
  send(msg: ClientMessage): void;
  state: GameState;
  /** The client's item catalogue (the item browser's cards) */
  econ: Economy;
  /** The world point under the mouse */
  cursorWorld(): { x: number; y: number };
  screenToWorld(x: number, y: number): { x: number; y: number };
  /** The camera follows this instead of your ship (null: your ship again) */
  setCamera(target: (() => { x: number; y: number } | null) | null): void;
  zoom(): number;
  isKeyDown(code: string): boolean;
  /** Extra lines for the Server tab (prediction stats) */
  clientStats?(): string;
}

const fmt = (n: number) => Math.round(n).toLocaleString();
/** How long a ban lasts (AdminTools reads these) */
const BAN_LENGTHS = [['1h', '1 hour'], ['1d', '1 day'], ['7d', '7 days'], ['30d', '30 days'], ['perm', 'For good']];
const banText = (b: NonNullable<AdminAccountInfo['ban']>) =>
  `banned ${b.until === null ? 'for good' : `until ${new Date(b.until).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`}${b.by ? ` by ${b.by}` : ''}${b.reason ? `: ${b.reason}` : ''}`;

/** A row of the Players tab: someone online, or an account that isn't */
interface PlayerRow { key: string; name: string; on: AdminPlayerInfo | null; acc: AdminAccountInfo | null }

let styled = false;
function injectStyles(): void {
  if (styled) return;
  styled = true;
  const css = document.createElement('style');
  css.textContent = `
.adm { position: fixed; top: 70px; right: 12px; width: 360px; max-height: calc(100vh - 150px); z-index: 2400; display: none; flex-direction: column;
  background: linear-gradient(180deg, rgba(20, 14, 18, 0.95), rgba(10, 8, 12, 0.95)); border: 1px solid rgba(255, 120, 90, 0.35); border-radius: 12px;
  box-shadow: 0 16px 50px rgba(0,0,0,0.5); color: #e6dde0; font: 12px 'Segoe UI', system-ui, sans-serif; color-scheme: dark; }
.adm.on { display: flex; }
.adm * { scrollbar-width: thin; scrollbar-color: rgba(255, 140, 110, 0.3) transparent; }
.adm-head { display: flex; align-items: center; gap: 8px; padding: 9px 12px; border-bottom: 1px solid rgba(255, 140, 110, 0.18); cursor: move; user-select: none; }
.adm-title { font: 700 11px 'Segoe UI', sans-serif; letter-spacing: 3px; color: #ff8a6a; }
.adm-head .sp { flex: 1; }
.adm-head .k { color: #8a7f86; font-size: 11px; }
.adm-x { all: unset; cursor: pointer; padding: 0 6px; color: #a99; font-size: 16px; }
.adm-x:hover { color: #fff; }
.adm-tabs { display: flex; gap: 2px; padding: 0 8px; border-bottom: 1px solid rgba(255, 140, 110, 0.12); }
.adm-tab { all: unset; cursor: pointer; padding: 7px 10px; color: #a99aa1; border-bottom: 2px solid transparent; margin-bottom: -1px; }
.adm-tab:hover { color: #fff; }
.adm-tab.on { color: #fff; border-bottom-color: #ff8a6a; }
.adm-body { padding: 10px 12px; overflow: auto; flex: 1; min-height: 0; }
.adm-sec { margin: 10px 0 5px; color: #ff8a6a; font-weight: 600; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; }
.adm-sec:first-child { margin-top: 0; }
.adm-row { display: flex; gap: 6px; align-items: center; margin: 4px 0; flex-wrap: wrap; }
.adm-btn { all: unset; cursor: pointer; padding: 5px 9px; border-radius: 7px; border: 1px solid rgba(255, 150, 120, 0.28); color: #eadfe2; text-align: center; white-space: nowrap; }
.adm-btn:hover { background: rgba(255, 138, 106, 0.12); border-color: rgba(255, 138, 106, 0.55); }
.adm-btn.on { background: rgba(255, 138, 106, 0.22); border-color: #ff8a6a; color: #fff; }
.adm-btn.bad { color: #ffb4a8; }
.adm-btn.sm { padding: 2px 7px; font-size: 11px; }
.adm-btn.off { opacity: 0.35; }
.adm-in { background: rgba(0,0,0,0.35); border: 1px solid rgba(255, 150, 120, 0.25); border-radius: 7px; color: #f2e9ec; padding: 4px 7px; font: inherit; outline: none; min-width: 0; }
.adm-in:focus { border-color: rgba(255, 138, 106, 0.7); }
select.adm-in { padding: 3px 4px; }
.adm-in.n { width: 72px; }
.adm-grow { flex: 1; }
.adm-kv { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; font: 11px 'Consolas', monospace; color: #cfc4c8; }
.adm-kv b { color: #8a7f86; font-weight: 400; }
.adm-pl { width: 100%; border-collapse: collapse; }
.adm-pl td { padding: 4px 3px; border-bottom: 1px solid rgba(255,255,255,0.05); vertical-align: middle; }
.adm-pl .nm { font-weight: 600; }
.adm-pl .sub { color: #8a7f86; font: 10px 'Consolas', monospace; }
.adm-tag { font-size: 9px; padding: 0 4px; border-radius: 4px; margin-left: 3px; background: rgba(255, 138, 106, 0.2); color: #ffb39d; }
.adm-log { border-top: 1px solid rgba(255, 140, 110, 0.12); padding: 6px 12px; max-height: 92px; overflow: auto; font: 11px 'Consolas', monospace; white-space: pre-wrap; }
.adm-log .bad { color: #ff9a8a; } .adm-log .ok { color: #9fe0b5; }
.adm-pick { position: fixed; inset: 0; z-index: 2300; cursor: crosshair; display: none; }
.adm-pick.on { display: block; }
.adm-hint { position: fixed; left: 50%; top: 64px; transform: translateX(-50%); z-index: 2401; padding: 6px 14px; border-radius: 999px; display: none;
  background: rgba(30, 12, 10, 0.9); border: 1px solid rgba(255, 138, 106, 0.6); color: #ffd7cc; font: 12px 'Segoe UI', sans-serif; pointer-events: none; }
.adm-hint.on { display: block; }
.adm-err { color: #ff9a8a; font: 10px 'Consolas', monospace; word-break: break-all; margin: 2px 0; }
.adm-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 6px; background: #4a4247; vertical-align: 1px; }
.adm-dot.on { background: #7ee0a0; box-shadow: 0 0 5px rgba(126, 224, 160, 0.6); }
.adm-tag.ban { background: rgba(255, 80, 70, 0.25); color: #ffb4a8; }
.adm-pl tr.off .nm { color: #b3a8ad; }
.adm-man td { background: rgba(255, 138, 106, 0.06); padding: 6px 6px 8px; }
.adm-man .lbl { color: #8a7f86; width: 38px; }
.adm-ask { color: #ffd7cc; }
.adm-rec { all: unset; cursor: pointer; position: relative; width: 28px; height: 28px; border-radius: 7px; display: grid; place-items: center;
  border: 1px solid var(--rc, rgba(255,150,120,0.28)); background: radial-gradient(circle at 50% 35%, rgba(255,255,255,0.07), rgba(0,0,0,0.3)); }
.adm-rec:hover { background: radial-gradient(circle at 50% 35%, rgba(255,255,255,0.14), rgba(0,0,0,0.2)); }
.adm-rec img { width: 82%; height: 82%; pointer-events: none; }
`;
  document.head.appendChild(css);
}

export class AdminPanel {
  private root = document.createElement('div');
  private body: HTMLElement;
  private log: HTMLElement;
  private pickVeil = document.createElement('div');
  private hint = document.createElement('div');
  private tab: Tab = 'me';
  private info: ServerAdminInfoMessage | null = null;
  private stats: ServerAdminStatsMessage | null = null;
  private live: HTMLElement | null = null;
  private timer = 0;
  private lastPick: { x: number; y: number } | null = null;
  /** Free camera position (null: off) */
  private cam: { x: number; y: number } | null = null;
  /** Watching another player (their entity id) */
  private watching = -1;
  private onPick: ((p: { x: number; y: number }) => void) | null = null;
  private keyHandler = (e: KeyboardEvent) => this.onKey(e);
  private lastFrame = performance.now();
  /** Spawn settings, kept between visits to the tab */
  private spawn = { faction: '', ship: '', count: 0 };
  /** Players tab: the accounts (the `players` command's answer), the search, and the row being managed */
  private accounts: ServerAdminAccountsMessage | null = null;
  private search = '';
  private searchTimer = 0;
  private manage: { key: string; rank: string; dur: string; reason: string; ask: 'ban' | 'kick' | null } | null = null;
  /** An account command was sent: list them again once it's answered */
  private relist = false;
  /** The item browser (made when first opened) */
  private giveWin: AdminGive | null = null;

  constructor(private deps: AdminPanelDeps) {
    injectWindowStyles();
    injectStyles();
    this.root.className = 'adm';
    this.root.innerHTML = `
      <div class="adm-head"><span class="adm-title">ADMIN</span><span class="sp"></span><span class="k">F2 · F3 tp · F4 cam</span><button class="adm-x" title="Close (F2)">×</button></div>
      <div class="adm-tabs">${(['me', 'players', 'world', 'server'] as Tab[]).map((t) => `<button class="adm-tab" data-tab="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div>
      <div class="adm-body"></div>
      <div class="adm-log"></div>`;
    this.body = this.root.querySelector('.adm-body')!;
    this.log = this.root.querySelector('.adm-log')!;
    this.root.querySelector('.adm-x')!.addEventListener('click', () => this.toggle(false));
    this.root.querySelectorAll<HTMLElement>('.adm-tab').forEach((b) => b.addEventListener('click', () => this.show(b.dataset.tab as Tab)));
    // Typing (or arrowing through a list) in the panel never flies the ship
    this.root.addEventListener('keydown', (e) => { if (['INPUT', 'SELECT'].includes((e.target as HTMLElement).tagName)) e.stopPropagation(); });
    this.dragging();
    document.body.appendChild(this.root);

    // Picking a spot: the next click in the world, swallowed so it doesn't fire the guns
    this.pickVeil.className = 'adm-pick';
    this.pickVeil.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const fn = this.onPick;
      this.endPick();
      if (e.button === 0 && fn) { const p = this.deps.screenToWorld(e.clientX, e.clientY); this.lastPick = p; fn(p); }
    });
    this.pickVeil.addEventListener('contextmenu', (e) => { e.preventDefault(); this.endPick(); });
    document.body.appendChild(this.pickVeil);
    this.hint.className = 'adm-hint';
    document.body.appendChild(this.hint);

    window.addEventListener('keydown', this.keyHandler, true);
    this.timer = window.setInterval(() => this.refreshLive(), 200);
  }

  get isOpen(): boolean {
    return this.root.classList.contains('on');
  }

  /** The camera isn't on your ship: flight keys fly the camera (or nothing), not the ship */
  get capturesFlight(): boolean {
    return !!this.cam || this.watching >= 0;
  }

  toggle(on = !this.isOpen): void {
    this.root.classList.toggle('on', on);
    if (on) {
      if (!this.info) this.cmd('info', {}, true);
      this.show(this.tab);
    } else {
      closeMenu();
      this.giveWin?.close();
    }
  }

  /** Each frame: the free camera flies */
  update(): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    if (!this.cam) return;
    const k = this.deps.isKeyDown;
    const speed = (900 / Math.max(0.05, this.deps.zoom())) * (k('ShiftLeft') || k('ShiftRight') ? 3.5 : 1);
    const dx = (k('KeyD') || k('ArrowRight') ? 1 : 0) - (k('KeyA') || k('ArrowLeft') ? 1 : 0);
    const dy = (k('KeyS') || k('ArrowDown') ? 1 : 0) - (k('KeyW') || k('ArrowUp') ? 1 : 0);
    this.cam.x += dx * speed * dt;
    this.cam.y += dy * speed * dt;
  }

  onInfo(msg: ServerAdminInfoMessage): void {
    this.info = msg;
    if (this.isOpen && this.tab !== 'server') this.show(this.tab);
  }

  onStats(msg: ServerAdminStatsMessage): void {
    this.stats = msg;
    this.giveWin?.onStats();
    if (!this.isOpen) return;
    if (this.tab === 'players') this.renderPlayers();
    if (this.tab === 'server') this.renderServer();
  }

  onAccounts(msg: ServerAdminAccountsMessage): void {
    // (An answer to an older search is no use)
    if (msg.search !== this.search) return;
    this.accounts = msg;
    if (this.isOpen && this.tab === 'players') this.renderPlayers(true);
  }

  onResult(ok: boolean, text: string): void {
    this.giveWin?.onResult(ok, text);
    const line = document.createElement('div');
    line.className = ok ? 'ok' : 'bad';
    line.textContent = `${ok ? '✓' : '✗'} ${text}`;
    this.log.appendChild(line);
    while (this.log.children.length > 40) this.log.firstChild!.remove();
    this.log.scrollTop = this.log.scrollHeight;
    // A flag may have changed: the next stats show it, but show it now in the Me tab
    if (this.isOpen && this.tab === 'me') this.syncFlags();
    // A rank or ban changed: the accounts again
    if (this.relist) { this.relist = false; this.listAccounts(); }
  }

  /** Signed out: away with it */
  destroy(): void {
    this.stopCamera();
    this.endPick();
    window.removeEventListener('keydown', this.keyHandler, true);
    clearInterval(this.timer);
    clearTimeout(this.searchTimer);
    this.giveWin?.destroy();
    this.root.remove();
    this.pickVeil.remove();
    this.hint.remove();
  }

  // ---------------------------------------------------------------------------

  private cmd(cmd: string, args: Record<string, unknown> = {}, quiet = false): void {
    this.deps.send({ type: 'admin', cmd, args });
    if (!quiet) this.log.scrollTop = this.log.scrollHeight;
  }

  /** The item browser, maybe for a player (entity id) or with an item picked */
  private openGive(opts: { to?: number; item?: string; n?: number } = {}): void {
    this.giveWin ??= new AdminGive({
      econ: this.deps.econ,
      cmd: (cmd, args) => this.cmd(cmd, args),
      players: () => this.stats?.playerList ?? [],
      myId: () => this.deps.state.playerId,
      serverItems: () => this.info?.items ?? [],
    });
    this.giveWin.open(opts);
  }

  private me(): AdminPlayerInfo | undefined {
    return this.stats?.playerList.find((p) => p.id === this.deps.state.playerId);
  }

  private onKey(e: KeyboardEvent): void {
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    // (Before anything else hears them: F3 is also the old glow debug panel's key)
    if (['F2', 'F3', 'F4'].includes(e.code)) { e.preventDefault(); e.stopPropagation(); }
    if (e.code === 'F2') { this.toggle(); return; }
    if (e.code === 'F3') {
      const p = this.deps.cursorWorld();
      this.cmd('tp', { x: Math.round(p.x), y: Math.round(p.y), system: this.deps.state.systemId });
      return;
    }
    if (e.code === 'F4') { if (this.capturesFlight) this.stopCamera(); else this.freeCamera(); return; }
    if (e.code === 'Escape' && (this.onPick || this.capturesFlight)) {
      e.preventDefault();
      e.stopPropagation();
      if (this.onPick) this.endPick(); else this.stopCamera();
    }
  }

  private pick(what: string, fn: (p: { x: number; y: number }) => void): void {
    this.onPick = fn;
    this.pickVeil.classList.add('on');
    this.hint.textContent = `Click in space: ${what} · right-click or Esc cancels`;
    this.hint.classList.add('on');
  }

  private endPick(): void {
    this.onPick = null;
    this.pickVeil.classList.remove('on');
    if (!this.capturesFlight) this.hint.classList.remove('on');
    else this.cameraHint();
  }

  private freeCamera(): void {
    const me = this.deps.state.getPlayerPosition();
    this.watching = -1;
    this.cam = { x: me.x, y: me.y };
    this.deps.setCamera(() => this.cam);
    this.cameraHint();
    this.syncFlags();
  }

  private watch(id: number, name: string): void {
    this.cam = null;
    this.watching = id;
    this.deps.setCamera(() => {
      const e = this.deps.state.entities.get(this.watching);
      return e ? { x: e.renderX, y: e.renderY } : null;
    });
    this.cameraHint(name);
    this.syncFlags();
  }

  private stopCamera(): void {
    if (!this.capturesFlight) return;
    this.cam = null;
    this.watching = -1;
    this.deps.setCamera(null);
    this.hint.classList.remove('on');
    this.syncFlags();
  }

  private cameraHint(name?: string): void {
    this.hint.textContent = this.cam ? 'Free camera: WASD flies, Shift faster · F4 or Esc: back to your ship' : `Watching ${name ?? 'a pilot'} · F4 or Esc: back to your ship`;
    this.hint.classList.add('on');
  }

  private show(tab: Tab): void {
    this.tab = tab;
    closeMenu();
    this.root.querySelectorAll<HTMLElement>('.adm-tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    this.live = null;
    delete this.body.dataset.players;
    if (tab === 'me') this.renderMe();
    else if (tab === 'players') { this.renderPlayers(); this.listAccounts(); }
    else if (tab === 'world') this.renderWorld();
    else this.renderServer();
  }

  /** Buttons with data-cmd run that command; data-args is JSON */
  private wire(): void {
    this.body.querySelectorAll<HTMLElement>('[data-cmd]').forEach((b) => b.addEventListener('click', () => {
      this.cmd(b.dataset.cmd!, b.dataset.args ? JSON.parse(b.dataset.args) : {});
    }));
  }

  private val(sel: string): string {
    return (this.body.querySelector(sel) as HTMLInputElement | HTMLSelectElement | null)?.value.trim() ?? '';
  }

  // --- Me ---------------------------------------------------------------------

  private renderMe(): void {
    const systems = this.info?.systems ?? [];
    const here = this.deps.state.systemId;
    const stations = this.info?.stations ?? [];
    const bySystem = systems.map((s) => ({ s, list: stations.filter((st) => st.system === s.id) })).filter((g) => g.list.length);
    this.body.innerHTML = `
      <div class="adm-sec">Where</div>
      <div class="adm-kv" data-live></div>
      <div class="adm-sec">Me</div>
      <div class="adm-row">
        <button class="adm-btn" data-flag="god" title="Take no damage">God mode</button>
        <button class="adm-btn" data-flag="hide" title="Hostiles ignore you">Hidden</button>
        <button class="adm-btn" data-flag="cam" title="F4: fly the camera with WASD">Free camera</button>
      </div>
      ${this.info?.freeBuild ? `<div class="adm-row">
        <button class="adm-btn" data-flag="freebuild" title="Dev server only: the hangar places any part or model, owned or not, licensed or not, and saving takes nothing">Free build: place any part</button>
      </div>` : ''}
      <div class="adm-row">
        <button class="adm-btn" data-cmd="heal">Repair ship</button>
        <button class="adm-btn" data-cmd="credits" data-args='{"n":10000}'>+10k cr</button>
        <button class="adm-btn" data-cmd="xp" data-args='{"n":1000}'>+1k XP</button>
        <button class="adm-btn" data-cmd="levelup" title="The XP your next level needs">+1 level</button>
        <button class="adm-btn" data-cmd="skillpoints" data-args='{"n":1}'>+1 skill pt</button>
      </div>
      ${devBankHtml(!!this.info?.freeBuild)}
      <div class="adm-sec">Teleport</div>
      <div class="adm-row">
        <button class="adm-btn" data-pick="tp">Click a spot…</button>
        <span style="color:#8a7f86">or F3 at the cursor</span>
      </div>
      <div class="adm-row">
        <select class="adm-in adm-grow" data-k="sys">${systems.map((s) => `<option value="${esc(s.id)}"${s.id === here ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
        <input class="adm-in n" data-k="x" placeholder="x" value="0">
        <input class="adm-in n" data-k="y" placeholder="y" value="0">
        <button class="adm-btn" data-go="xy">Go</button>
      </div>
      <div class="adm-row">
        <select class="adm-in adm-grow" data-k="station">${bySystem.map((g) => `<optgroup label="${esc(g.s.name)}">${g.list.map((st) => `<option value="${esc(st.id)}">${esc(st.name)}</option>`).join('')}</optgroup>`).join('')}</select>
        <button class="adm-btn" data-go="station">Go</button>
      </div>
      <div class="adm-sec">Items</div>
      <div class="adm-row">
        <button class="adm-btn" data-givewin title="Browse every item: search, filter, give to anyone online">Give items…</button>
        ${loadGiveRecents().slice(0, 7).map((r) => ({ ...r, d: this.deps.econ.items.get(r.id) })).filter((r) => r.d).map((r) => `<button class="adm-rec" data-rec="${esc(r.id)}" data-n="${r.n}" style="--rc:${RARITY_COLOR[r.d!.rarity]}88" title="${esc(r.d!.name)} ×${r.n} (recent: pick it again)"><img src="${itemIcon(this.deps.econ, r.id)}" alt=""></button>`).join('')}
      </div>`;
    this.live = this.body.querySelector('[data-live]');
    this.wire();
    this.body.querySelectorAll<HTMLElement>('[data-flag]').forEach((b) => b.addEventListener('click', () => {
      const f = b.dataset.flag!;
      if (f === 'cam') { this.cam ? this.stopCamera() : this.freeCamera(); return; }
      this.cmd(f, { on: !b.classList.contains('on') });
    }));
    this.body.querySelectorAll<HTMLElement>('[data-devbank]').forEach((b) => b.addEventListener('click', () => {
      const m = devBankMessage(this.deps.econ, b.dataset.devbank!);
      if (m) this.deps.send(m);
    }));
    this.body.querySelector('[data-pick="tp"]')!.addEventListener('click', () =>
      this.pick('teleport there', (p) => this.cmd('tp', { x: Math.round(p.x), y: Math.round(p.y), system: this.deps.state.systemId })));
    this.body.querySelector('[data-go="xy"]')!.addEventListener('click', () =>
      this.cmd('tp', { system: this.val('[data-k="sys"]'), x: Number(this.val('[data-k="x"]')), y: Number(this.val('[data-k="y"]')) }));
    this.body.querySelector('[data-go="station"]')!.addEventListener('click', () => this.cmd('goto', { station: this.val('[data-k="station"]') }));
    this.body.querySelector('[data-givewin]')!.addEventListener('click', () => this.openGive({ to: this.deps.state.playerId }));
    this.body.querySelectorAll<HTMLElement>('[data-rec]').forEach((b) => b.addEventListener('click', () => this.openGive({ to: this.deps.state.playerId, item: b.dataset.rec, n: Number(b.dataset.n) })));
    this.syncFlags();
    this.refreshLive();
  }

  private syncFlags(): void {
    const me = this.me();
    const set = (f: string, on: boolean) => this.body.querySelector(`[data-flag="${f}"]`)?.classList.toggle('on', on);
    set('god', !!me?.god);
    set('hide', !!me?.hidden);
    set('freebuild', !!me?.freeBuild);
    set('cam', !!this.cam);
  }

  /** The live readouts, a few times a second */
  private refreshLive(): void {
    if (!this.isOpen || !this.live || this.tab !== 'me') return;
    const s = this.deps.state;
    const p = s.getPlayerPosition();
    const c = this.deps.cursorWorld();
    const sys = this.info?.systems.find((x) => x.id === s.systemId)?.name ?? s.systemId;
    this.live.innerHTML = `<b>System</b><span>${esc(sys)} <span style="color:#8a7f86">(${esc(s.systemId)})</span></span>
      <b>Ship</b><span>${fmt(p.x)}, ${fmt(p.y)}</span>
      <b>Cursor</b><span>${fmt(c.x)}, ${fmt(c.y)}</span>
      ${this.cam ? `<b>Camera</b><span>${fmt(this.cam.x)}, ${fmt(this.cam.y)}</span>` : ''}
      ${this.lastPick ? `<b>Last pick</b><span>${fmt(this.lastPick.x)}, ${fmt(this.lastPick.y)}</span>` : ''}
      <b>Zoom</b><span>${this.deps.zoom().toFixed(2)}</span>`;
  }

  // --- Players ----------------------------------------------------------------

  /** Ask for the accounts matching the search (online or not) */
  private listAccounts(): void {
    this.cmd('players', { search: this.search, quiet: true }, true);
  }

  /** An account command: the list is asked for again once it's answered */
  private accountCmd(cmd: string, args: Record<string, unknown>): void {
    this.relist = true;
    this.manage = null;
    this.cmd(cmd, args);
    this.renderPlayers(true);
  }

  private renderPlayers(force = false): void {
    // The search box stays put (typing in it isn't interrupted); the list under it is redrawn
    let listEl = this.body.querySelector<HTMLElement>('[data-list]');
    if (!listEl) {
      this.body.innerHTML = `
        <div class="adm-row"><input class="adm-in adm-grow" data-k="search" placeholder="Search players by name (online or not)" value="${esc(this.search)}"></div>
        <div data-list></div>`;
      listEl = this.body.querySelector<HTMLElement>('[data-list]')!;
      this.body.querySelector('[data-k="search"]')!.addEventListener('input', (e) => {
        this.search = (e.target as HTMLInputElement).value.trim();
        clearTimeout(this.searchTimer);
        this.searchTimer = window.setTimeout(() => this.listAccounts(), 250);
        this.renderPlayers(true);
      });
      force = true;
    }
    const low = this.search.toLowerCase();
    const live = (this.stats?.playerList ?? []).filter((p) => p.name.toLowerCase().startsWith(low));
    const accounts = this.accounts?.search === this.search ? this.accounts.players : [];
    const onNames = new Set(live.map((p) => p.name.toLowerCase()));
    const rows: PlayerRow[] = [
      ...live.map((p) => ({ key: `#${p.id}`, name: p.name, on: p, acc: accounts.find((a) => a.online === p.id) ?? null })),
      // (Someone who signed on since the list came is in the first lot already)
      ...accounts.filter((a) => a.online === null && !onNames.has(a.name.toLowerCase())).map((a) => ({ key: `@${a.name}`, name: a.name, on: null, acc: a })),
    ];
    if (this.manage && !rows.some((r) => r.key === this.manage!.key)) this.manage = null;
    // Keep the open menu's rows from vanishing under the cursor, and the managed row's fields from losing what's typed:
    // re-render only when the list changes, and not while a field in it is in use
    const key = JSON.stringify([rows, this.manage?.key, this.manage?.ask]);
    const typing = document.activeElement && listEl.contains(document.activeElement) && ['INPUT', 'SELECT'].includes(document.activeElement.tagName);
    if (!force && (this.body.dataset.players === key || typing)) return;
    this.body.dataset.players = key;
    const myId = this.deps.state.playerId;
    const mySystem = this.deps.state.systemId;
    const name = (sys: string) => this.info?.systems.find((s) => s.id === sys)?.name ?? sys;
    const rankOf = (r: PlayerRow) => this.rankOf(r);
    const note = this.accounts?.error ? `<div class="adm-err">${esc(this.accounts.error)}</div>` : '';
    const more = this.accounts?.more && this.accounts.search === this.search
      ? `<div class="sub" style="color:#8a7f86;margin-top:6px">${this.accounts.total} accounts match: type more of the name</div>` : '';
    if (!rows.length) {
      listEl.innerHTML = `${note}<div style="color:#8a7f86">${this.stats ? (this.search ? 'Nobody by that name' : 'Waiting for the accounts…') : 'Waiting for the player list…'}</div>`;
      return;
    }
    listEl.innerHTML = `${note}<table class="adm-pl">${rows.map((r) => {
      const p = r.on;
      const rank = rankOf(r);
      const tags = `${rank !== 'player' ? `<span class="adm-tag">${rank === 'owner' ? 'owner' : rank === 'admin' ? 'admin' : 'contrib'}</span>` : ''}${r.acc && !r.acc.account ? '<span class="adm-tag">guest</span>' : ''}${r.acc?.ban ? '<span class="adm-tag ban">banned</span>' : ''}`
        + (p ? `${p.god ? '<span class="adm-tag">god</span>' : ''}${p.hidden ? '<span class="adm-tag">hidden</span>' : ''}${p.dead ? '<span class="adm-tag">dead</span>' : ''}` : '');
      const sub = p ? `#${p.id} · ${esc(name(p.system))} · ${fmt(p.x)}, ${fmt(p.y)} · ${p.ping}ms` : `offline${r.acc?.ban ? ` · ${esc(banText(r.acc.ban))}` : ''}`;
      return `
      <tr data-key="${esc(r.key)}"${p ? '' : ' class="off"'}>
        <td><div class="nm"><span class="adm-dot${p ? ' on' : ''}" title="${p ? 'Online' : 'Offline'}"></span>${esc(r.name)}${tags}</div>
          <div class="sub">${sub}</div></td>
        <td style="text-align:right;white-space:nowrap">
          ${!p ? '' : p.id === myId ? '<span class="sub">you</span>' : `
          <button class="adm-btn sm" data-p="goto" title="Go to them">Go</button>
          <button class="adm-btn sm" data-p="bring" title="Bring them to you">Bring</button>
          <button class="adm-btn sm${p.system === mySystem ? '' : ' off'}" data-p="watch" title="${p.system === mySystem ? 'Watch them (camera)' : 'In another system: go there first'}">Watch</button>`}
          ${p ? '<button class="adm-btn sm" data-p="more">⋯</button>' : ''}
          <button class="adm-btn sm${this.manage?.key === r.key ? ' on' : ''}" data-p="manage" title="Rank, ban, kick">Manage</button>
        </td>
      </tr>${this.manage?.key === r.key ? this.manageRow(r, rank) : ''}`;
    }).join('')}</table>${more}`;
    this.wirePlayers(listEl, rows);
  }

  /** The managed row's strip: rank, ban (asked to be sure, in place), unban, kick */
  private manageRow(r: PlayerRow, rank: string): string {
    const m = this.manage!;
    const me = r.on?.id === this.deps.state.playerId;
    const guest = r.acc ? !r.acc.account : false;
    const ban = r.acc?.ban;
    const len = BAN_LENGTHS.find(([v]) => v === m.dur)?.[1] ?? m.dur;
    // Ranks: the owner's is set on the server only; an admin's is the owner's to change (and so is banning one)
    const iOwn = !!this.me()?.owner;
    const locked = !me && (rank === 'owner' || (rank === 'admin' && !iOwn));
    const ranks = iOwn || rank === 'admin' ? ['player', 'contributor', 'admin'] : ['player', 'contributor'];
    const rankRow = guest ? '<div class="adm-row"><span class="sub">A guest: no account to rank or ban (kick only)</span></div>'
      : rank === 'owner' ? '<div class="adm-row"><span class="lbl">Rank</span><span class="sub adm-grow">Owner (set on the server only)</span></div>'
      : locked ? '<div class="adm-row"><span class="lbl">Rank</span><span class="sub adm-grow">Admin (only the owner can change an admin\'s rank or ban them)</span></div>'
      : `<div class="adm-row"><span class="lbl">Rank</span>
          <select class="adm-in adm-grow" data-m="rank"${me ? ' disabled title="You can\'t demote yourself"' : ''}>${ranks.map((k) => `<option value="${k}"${k === m.rank ? ' selected' : ''}>${k[0].toUpperCase() + k.slice(1)}</option>`).join('')}</select>
          <button class="adm-btn sm${m.rank === rank || me ? ' off' : ''}" data-m="setrank">Set</button></div>`;
    const banRow = guest || me || locked ? '' : ban
      ? `<div class="adm-row"><span class="lbl">Ban</span><span class="adm-grow sub">${esc(banText(ban))}</span><button class="adm-btn sm" data-m="unban">Unban</button></div>`
      : m.ask === 'ban'
        ? `<div class="adm-row"><span class="adm-ask adm-grow">Ban ${esc(r.name)} ${m.dur === 'perm' ? 'for good' : `for ${esc(len)}`}${m.reason ? ` (${esc(m.reason)})` : ''}${r.on ? ' and kick them' : ''}?</span>
            <button class="adm-btn sm bad" data-m="banyes">Ban</button><button class="adm-btn sm" data-m="cancel">Cancel</button></div>`
        : `<div class="adm-row"><span class="lbl">Ban</span>
            <select class="adm-in" data-m="dur">${BAN_LENGTHS.map(([v, l]) => `<option value="${v}"${v === m.dur ? ' selected' : ''}>${l}</option>`).join('')}</select>
            <input class="adm-in adm-grow" data-m="reason" placeholder="Reason (they're told)" value="${esc(m.reason)}">
            <button class="adm-btn sm bad" data-m="ban">Ban…</button></div>`;
    const kickRow = !r.on || me ? '' : m.ask === 'kick'
      ? `<div class="adm-row"><span class="adm-ask adm-grow">Kick ${esc(r.name)} from the server?</span><button class="adm-btn sm bad" data-m="kickyes">Kick</button><button class="adm-btn sm" data-m="cancel">Cancel</button></div>`
      : '<div class="adm-row"><span class="lbl"></span><button class="adm-btn sm bad" data-m="kick">Kick from server…</button></div>';
    return `<tr class="adm-man"><td colspan="2">${rankRow}${banRow}${kickRow}</td></tr>`;
  }

  private wirePlayers(listEl: HTMLElement, rows: PlayerRow[]): void {
    const rowOf = (el: HTMLElement) => rows.find((r) => r.key === el.closest<HTMLElement>('tr[data-key]')?.dataset.key
      || r.key === (el.closest('tr.adm-man')?.previousElementSibling as HTMLElement | null)?.dataset.key);
    /** How the server's told who: online by entity id, else by account name */
    const ref = (r: PlayerRow) => (r.on ? String(r.on.id) : r.name);
    listEl.querySelectorAll<HTMLElement>('[data-p]').forEach((b) => b.addEventListener('click', (e) => {
      const r = rowOf(b);
      if (!r) return;
      const p = r.on;
      const who = { player: ref(r) };
      switch (b.dataset.p) {
        case 'manage': this.openManage(r); break;
        case 'goto': if (p) this.cmd('goto', { to: String(p.id) }); break;
        case 'bring': this.cmd('bring', who); break;
        case 'watch': if (p && p.system === this.deps.state.systemId) this.watch(p.id, p.name); break;
        case 'more': {
          if (!p) break;
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          openMenu(rect.left - 150, rect.bottom + 4, [
            { label: 'Repair ship', run: () => this.cmd('heal', who) },
            { label: p.god ? 'God mode off' : 'God mode on', run: () => this.cmd('god', { ...who, on: !p.god }) },
            { label: p.hidden ? 'Visible to hostiles' : 'Hidden from hostiles', run: () => this.cmd('hide', { ...who, on: !p.hidden }) },
            { label: '+10,000 credits', run: () => this.cmd('credits', { ...who, n: 10000 }) },
            { label: '+1,000 XP', run: () => this.cmd('xp', { ...who, n: 1000 }) },
            { label: '+1 level', run: () => this.cmd('levelup', who) },
            { label: 'Give items…', run: () => this.openGive({ to: p.id }) },
            { label: p.contributor ? 'Remove contributor rank' : 'Make contributor (map notes)', run: () => this.accountCmd('contributor', { ...who, on: !p.contributor }) },
            { label: 'Send to my cursor (F3 spot)…', run: () => this.pick(`send ${p.name} there`, (q) => this.cmd('tp', { ...who, x: Math.round(q.x), y: Math.round(q.y), system: this.deps.state.systemId })) },
            { label: 'Destroy ship', bad: true, run: () => this.cmd('kill', who) },
            ...(p.id === this.deps.state.playerId ? [] : [{ label: 'Kick from server…', bad: true, run: () => this.openManage(r, 'kick') }]),
          ]);
          break;
        }
      }
    }));
    // The managed row's fields keep what's typed (redraws put it back)
    const m = this.manage;
    if (!m) return;
    listEl.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-m="rank"], [data-m="dur"], [data-m="reason"]').forEach((f) => f.addEventListener('input', () => {
      if (f.dataset.m === 'rank') { m.rank = f.value; this.renderPlayers(true); } else if (f.dataset.m === 'dur') m.dur = f.value; else m.reason = f.value;
    }));
    listEl.querySelector('[data-m="reason"]')?.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') { m.ask = 'ban'; this.renderPlayers(true); } });
    listEl.querySelectorAll<HTMLElement>('button[data-m]').forEach((b) => b.addEventListener('click', () => {
      const r = rowOf(b);
      if (!r) return;
      switch (b.dataset.m) {
        case 'setrank': if (!b.classList.contains('off')) this.accountCmd('rank', { player: ref(r), rank: m.rank }); return;
        case 'ban': m.ask = 'ban'; break;
        case 'kick': m.ask = 'kick'; break;
        case 'cancel': m.ask = null; break;
        case 'banyes': this.accountCmd('ban', { player: ref(r), duration: m.dur, reason: m.reason }); return;
        case 'unban': this.accountCmd('unban', { player: r.name }); return;
        case 'kickyes': this.accountCmd('kick', { player: ref(r), reason: m.reason || undefined }); return;
      }
      this.renderPlayers(true);
    }));
  }

  /** owner > admin > contributor > player (online: as their connection says; offline: as the lobby does) */
  private rankOf(r: PlayerRow): string {
    return r.on ? (r.on.owner ? 'owner' : r.on.admin ? 'admin' : r.on.contributor ? 'contributor' : 'player') : r.acc?.rank ?? 'player';
  }

  /** Open (or shut) a row's Manage strip, maybe straight at a question */
  private openManage(r: PlayerRow, ask: 'kick' | null = null): void {
    const rank = this.rankOf(r);
    this.manage = this.manage?.key === r.key && !ask ? null : { key: r.key, rank, dur: '1d', reason: '', ask };
    this.renderPlayers(true);
  }

  // --- World ------------------------------------------------------------------

  private renderWorld(): void {
    const factions = this.info?.factions ?? {};
    const ships = this.spawn.faction ? factions[this.spawn.faction] ?? [] : Object.values(factions).flat();
    this.body.innerHTML = `
      <div class="adm-sec">Spawn hostiles</div>
      <div class="adm-row">
        <select class="adm-in adm-grow" data-k="faction"><option value="">This system's own</option>${Object.keys(factions).map((f) => `<option${f === this.spawn.faction ? ' selected' : ''}>${esc(f)}</option>`).join('')}</select>
        <select class="adm-in adm-grow" data-k="ship"><option value="">Any ships</option>${ships.map((s) => `<option${s === this.spawn.ship ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select>
      </div>
      <div class="adm-row">
        <span style="color:#8a7f86">How many</span><input class="adm-in n" data-k="count" style="width:44px" placeholder="pack" value="${this.spawn.count || ''}">
        <button class="adm-btn" data-spawn="pick">Click a spot…</button>
        <button class="adm-btn" data-spawn="me">At me</button>
      </div>
      <div class="adm-sec">Bosses</div>
      <div class="adm-row">
        <select class="adm-in adm-grow" data-k="boss">${(this.info?.bosses ?? []).map((b) => `<option>${esc(b)}</option>`).join('')}</select>
        <button class="adm-btn" data-bossgo>Spawn at its lair</button>
      </div>
      <div class="adm-sec">Clear (this system)</div>
      <div class="adm-row">
        <button class="adm-btn bad" data-cmd="clear">Destroy hostiles</button>
        <button class="adm-btn bad" data-cmd="clear" data-args='{"radius":4000}'>Within 4k of me</button>
        <button class="adm-btn" data-cmd="clear" data-args='{"quiet":true}' title="Gone, no explosions or loot">Remove quietly</button>
        <button class="adm-btn" data-cmd="clearpods">Clear loot pods</button>
      </div>
      <div class="adm-sec">Events (this system)</div>
      <div class="adm-row">
        <button class="adm-btn" data-cmd="event" data-args='{"kind":"raid"}'>Start a raid</button>
        <button class="adm-btn" data-cmd="event" data-args='{"kind":"salvage"}'>Start a salvage field</button>
        <button class="adm-btn" data-cmd="event" data-args='{"kind":"siege"}' title="On a planet with a city">Start a siege</button>
      </div>
      <div class="adm-sec">Announce (everyone)</div>
      <div class="adm-row">
        <input class="adm-in adm-grow" data-k="say" placeholder="Message to every pilot">
        <button class="adm-btn" data-say>Send</button>
      </div>`;
    this.wire();
    const read = () => {
      this.spawn = { faction: this.val('[data-k="faction"]'), ship: this.val('[data-k="ship"]'), count: Number(this.val('[data-k="count"]')) || 0 };
      return { faction: this.spawn.faction || undefined, ships: this.spawn.ship ? [this.spawn.ship] : undefined, count: this.spawn.count || undefined };
    };
    this.body.querySelector('[data-k="faction"]')!.addEventListener('change', () => { read(); this.spawn.ship = ''; this.renderWorld(); });
    this.body.querySelector('[data-spawn="me"]')!.addEventListener('click', () => this.cmd('spawn', read()));
    this.body.querySelector('[data-spawn="pick"]')!.addEventListener('click', () => {
      const args = read();
      this.pick('spawn hostiles there', (p) => this.cmd('spawn', { ...args, x: Math.round(p.x), y: Math.round(p.y) }));
    });
    this.body.querySelector('[data-bossgo]')!.addEventListener('click', () => this.cmd('boss', { id: this.val('[data-k="boss"]') }));
    const say = () => { const t = this.val('[data-k="say"]'); if (t) { this.cmd('announce', { text: t }); (this.body.querySelector('[data-k="say"]') as HTMLInputElement).value = ''; } };
    this.body.querySelector('[data-say]')!.addEventListener('click', say);
    this.body.querySelector('[data-k="say"]')!.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') say(); });
  }

  // --- Server -----------------------------------------------------------------

  private renderServer(): void {
    const s = this.stats;
    if (!s) { this.body.innerHTML = '<div style="color:#8a7f86">Waiting for stats (about a second)…</div>'; return; }
    const tickColor = s.avgTickTimeMs > 10 ? '#ff6b5a' : s.avgTickTimeMs > 5 ? '#ffb347' : '#7ee0a0';
    const bytes = s.bytesByType ?? {};
    this.body.innerHTML = `
      <div class="adm-sec">Server</div>
      <div class="adm-kv">
        <b>Tick</b><span>${s.tick}</span>
        <b>Tick time</b><span style="color:${tickColor}">${s.avgTickTimeMs} ms avg · ${s.maxTickTimeMs} ms max</span>
        <b>Memory</b><span>${s.memoryMb} MB</span>
        <b>Uptime</b><span>${Math.floor(s.uptime / 3600)}h ${Math.floor((s.uptime % 3600) / 60)}m</span>
        <b>Players</b><span>${s.playerCount} (${s.connectionsTotal} connections so far)</span>
        <b>Entities</b><span>${s.entityCount}</span>
        <b>Sent</b><span>${(s.snapshotBytes / 1024).toFixed(1)} KB/s</span>
      </div>
      ${Object.keys(bytes).length ? `<div class="adm-sec">Bandwidth by message</div><div class="adm-kv">${Object.entries(bytes).sort(([, a], [, b]) => b - a).slice(0, 10)
        .map(([t, b]) => `<b>${esc(t)}</b><span>${(b / 1024).toFixed(1)} KB/s</span>`).join('')}</div>` : ''}
      ${this.deps.clientStats ? `<div class="adm-sec">This client</div><div class="adm-kv">${this.deps.clientStats()}</div>` : ''}
      ${s.errors?.length ? `<div class="adm-sec">Recent errors</div>${s.errors.slice(-6).map((e) => `<div class="adm-err">${esc(e)}</div>`).join('')}` : ''}`;
  }

  /** Drag the panel by its header */
  private dragging(): void {
    const head = this.root.querySelector<HTMLElement>('.adm-head')!;
    head.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      const r = this.root.getBoundingClientRect();
      const ox = e.clientX - r.left, oy = e.clientY - r.top;
      const move = (m: MouseEvent) => {
        this.root.style.left = `${Math.max(0, Math.min(window.innerWidth - 80, m.clientX - ox))}px`;
        this.root.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, m.clientY - oy))}px`;
        this.root.style.right = 'auto';
      };
      const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      e.preventDefault();
    });
  }
}
