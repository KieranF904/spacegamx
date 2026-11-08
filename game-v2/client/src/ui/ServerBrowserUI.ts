/**
 * Join screen - shown after sign-in. There is one main server, so it's a Join button for it, a short
 * description of the game with a few photos, and the development news feed (join/news.json).
 * The server is the one this page belongs to: the dev server on the dev client, the live server on the VPS.
 * Signed-in pilots also get their inbox (join/InboxPanel.ts): a banner above everything for an unread admin
 * message, a badge on the Join button, and the inbox below it.
 */

import { LOBBY_URL } from '../network/lobby';
import { lobbyInbox, type InboxApi } from '../network/inbox';
import { InboxPanel, type InboxAccount } from './join/InboxPanel';
import NEWS from './join/news.json';
import sunRun from './join/sun-run.jpg';
import planet from './join/planet.jpg';
import boss from './join/boss.jpg';
import { esc } from './escape';

export interface ServerInfo {
  host: string;
  port: number;
  name: string;
  region?: string;
  maxPlayers: number;
  players: number;
  secure: boolean;
  ping?: number;
}

/** One development news item (newest first in news.json) */
interface NewsItem { date: string; title: string; body: string }

const PHOTOS = [
  { src: sunRun, alt: 'A ship skimming a star' },
  { src: planet, alt: 'A planet from orbit' },
  { src: boss, alt: 'A boss fight' },
];

export class ServerBrowserUI {
  private container: HTMLElement;
  private panel: HTMLElement;
  private visible = false;
  private servers: ServerInfo[] = [];
  private loading = false;

  // Server browser URL (override with VITE_BROWSER_URL at build/dev time)
  private browserUrl = LOBBY_URL;

  /** The inbox (kept across renders: placed into its slots after each) */
  readonly inbox: InboxPanel;

  // Callbacks
  public onServerSelect: ((server: ServerInfo) => void) | null = null;
  public onLogout: (() => void) | null = null;

  constructor(container: HTMLElement, inboxApi: InboxApi = lobbyInbox) {
    this.container = container;
    this.inbox = new InboxPanel(inboxApi);
    this.inbox.onCounts = () => this.showMailBadge();

    this.panel = document.createElement('div');
    this.panel.id = 'server-browser-panel';
    this.panel.className = 'ui-element';
    this.panel.style.display = 'none';
    container.appendChild(this.panel);

    this.setupStyles();
    this.render();
  }

  /**
   * The look: panels are hull plates (gunmetal, a lit top bevel, a dark lower edge, rivets at the corners) over Sol's
   * stars with the sun's limb glowing up from below, as on the sign-in screen. The Join button is the one hot thing on
   * screen: a sun-orange plate with a glowing core. Colours are custom properties here, used by the inbox's styles too.
   */
  private setupStyles(): void {
    const style = document.createElement('style');
    style.textContent = `
      #server-browser-panel {
        --hull-top: #1d2635; --hull-mid: #141b27; --hull-low: #0e131c;
        --edge-hi: rgba(196, 216, 255, 0.2); --edge-lo: rgba(0, 0, 0, 0.65); --rim: rgba(130, 160, 200, 0.22);
        --well: rgba(3, 6, 12, 0.62);
        --ink: #e4ebf5; --ink-2: #b4c2d4; --ink-3: #8b9cb3;
        --port: #6cc8ff; --port-glow: rgba(90, 190, 255, 0.45);
        --amber: #ffbe55; --amber-glow: rgba(255, 175, 60, 0.4);
        --sun: #e8651a; --sun-glow: rgba(255, 120, 30, 0.42);
        --ease: 160ms ease-out;
        position: absolute; inset: 0;
        display: flex; align-items: center; justify-content: center;
        /* Sol's limb below the screen, a warm haze over it, and two layers of stars (the background stays put as the
           page scrolls: it belongs to the scroller) */
        background:
          radial-gradient(ellipse 70% 30% at 50% 116%, rgba(255, 214, 150, 0.85) 0%, rgba(255, 150, 60, 0.6) 42%, rgba(240, 100, 25, 0.32) 60%, rgba(190, 60, 10, 0.1) 72%, transparent 84%),
          radial-gradient(ellipse 120% 60% at 50% 120%, rgba(255, 110, 30, 0.14), transparent 70%),
          radial-gradient(1px 1px at 23px 41px, rgba(255, 255, 255, 0.85), transparent),
          radial-gradient(1px 1px at 141px 97px, rgba(200, 220, 255, 0.7), transparent),
          radial-gradient(1.5px 1.5px at 211px 183px, rgba(255, 240, 220, 0.9), transparent),
          radial-gradient(1px 1px at 77px 213px, rgba(255, 255, 255, 0.55), transparent),
          radial-gradient(1px 1px at 183px 19px, rgba(255, 255, 255, 0.5), transparent),
          radial-gradient(1px 1px at 59px 139px, rgba(170, 200, 255, 0.45), transparent),
          radial-gradient(ellipse at 50% 30%, #0a1222 0%, #04060c 70%);
        background-size: 100% 100%, 100% 100%, 240px 240px, 240px 240px, 240px 240px, 240px 240px, 240px 240px, 240px 240px, 100% 100%;
        z-index: 1900; overflow-y: auto; padding: 28px 16px; box-sizing: border-box;
        color: var(--ink-2);
      }
      #server-browser-panel *, #server-browser-panel *::before, #server-browser-panel *::after { box-sizing: border-box; }
      .join-wrap { width: 800px; max-width: 100%; margin: auto; display: flex; flex-direction: column; gap: 16px; }

      /* A hull plate */
      .join-box {
        position: relative; padding: 26px 28px; border-radius: 5px; border: 1px solid #05080d;
        background:
          radial-gradient(circle at 9px 9px, rgba(220, 230, 250, 0.22) 1.5px, rgba(0, 0, 0, 0.5) 2.5px, transparent 3.5px),
          radial-gradient(circle at calc(100% - 9px) 9px, rgba(220, 230, 250, 0.22) 1.5px, rgba(0, 0, 0, 0.5) 2.5px, transparent 3.5px),
          radial-gradient(circle at 9px calc(100% - 9px), rgba(220, 230, 250, 0.16) 1.5px, rgba(0, 0, 0, 0.5) 2.5px, transparent 3.5px),
          radial-gradient(circle at calc(100% - 9px) calc(100% - 9px), rgba(220, 230, 250, 0.16) 1.5px, rgba(0, 0, 0, 0.5) 2.5px, transparent 3.5px),
          radial-gradient(ellipse 80% 60% at 30% 0%, rgba(150, 185, 235, 0.08), transparent 70%),
          linear-gradient(180deg, var(--hull-top) 0%, var(--hull-mid) 45%, var(--hull-low) 100%);
        box-shadow:
          inset 0 1px 0 var(--edge-hi), inset 1px 0 0 rgba(196, 216, 255, 0.06),
          inset 0 -2px 0 var(--edge-lo), inset -1px 0 0 rgba(0, 0, 0, 0.35),
          0 0 0 1px var(--rim), 0 20px 50px rgba(0, 0, 0, 0.6), 0 2px 6px rgba(0, 0, 0, 0.5);
      }

      .join-title {
        margin: 0 0 10px; font: 900 34px/1.1 'Orbitron', 'Rajdhani', 'Arial Black', sans-serif;
        letter-spacing: 8px; text-transform: uppercase; color: #fff;
        text-shadow: 0 0 10px rgba(255, 200, 120, 0.55), 0 0 28px rgba(255, 120, 30, 0.35);
      }
      .join-blurb { color: var(--ink-2); font-size: 15px; line-height: 1.6; margin: 0 0 20px; max-width: 62ch; }

      /* Photos: viewports in the plate */
      .join-photos { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
      .join-photos img {
        width: 100%; aspect-ratio: 16 / 10; object-fit: cover; display: block; border-radius: 3px;
        border: 1px solid #000; box-shadow: 0 0 0 1px var(--rim), 0 6px 14px rgba(0, 0, 0, 0.5);
        filter: saturate(0.92) brightness(0.92); transition: filter var(--ease), box-shadow var(--ease);
      }
      .join-photos img:hover { filter: none; box-shadow: 0 0 0 1px rgba(160, 200, 255, 0.45), 0 6px 18px rgba(0, 0, 0, 0.6); }

      /* Section headings: small caps with a rule running off to the right */
      .join-h {
        display: flex; align-items: center; gap: 12px; margin: 24px 0 12px;
        font: 600 12px/1 'Rajdhani', 'Segoe UI', system-ui, sans-serif; letter-spacing: 3px; text-transform: uppercase; color: var(--ink-3);
      }
      .join-h::after { content: ''; flex: 1; height: 1px; background: linear-gradient(90deg, rgba(140, 170, 210, 0.35), transparent); }
      .inbox-head .join-h::after { display: none; }

      .news { display: flex; flex-direction: column; gap: 14px; max-height: 260px; overflow-y: auto; padding-right: 4px; }
      .news-item { position: relative; padding-left: 16px; }
      .news-item::before { content: ''; position: absolute; left: 0; top: 5px; width: 6px; height: 6px; border-radius: 1px;
        background: var(--port); box-shadow: 0 0 6px var(--port-glow); }
      .news-date { font-size: 12px; color: var(--ink-3); font-variant-numeric: tabular-nums; }
      .news-title { color: var(--ink); font-size: 15px; font-weight: 600; margin: 2px 0 4px; }
      .news-body { color: var(--ink-2); font-size: 14px; line-height: 1.55; }
      .news-empty { color: var(--ink-3); font-size: 14px; }

      /* Join: the focal point. A sun-orange plate, beveled, with a core glowing behind the word */
      .join-main-btn {
        position: relative; isolation: isolate; overflow: hidden; width: 100%; padding: 16px 16px 14px; cursor: pointer;
        border: 1px solid #3a1402; border-radius: 6px; color: #fff;
        background: linear-gradient(180deg, #f2802f 0%, #e8661b 44%, #d4580f 56%, #a8400a 100%);
        box-shadow:
          inset 0 1px 0 rgba(255, 230, 190, 0.75), inset 0 -2px 0 rgba(70, 20, 0, 0.55),
          0 0 0 1px rgba(255, 150, 70, 0.35), 0 0 34px var(--sun-glow), 0 14px 30px rgba(0, 0, 0, 0.55);
        font: 800 34px/1.05 'Orbitron', 'Rajdhani', 'Arial Black', sans-serif; letter-spacing: 6px;
        text-shadow: 0 1px 2px rgba(60, 15, 0, 0.6);
        transition: box-shadow var(--ease), filter var(--ease), transform var(--ease);
      }
      .join-main-btn::before {
        content: ''; position: absolute; z-index: -1; left: 50%; top: 50%; width: 46%; height: 160%;
        transform: translate(-50%, -50%); border-radius: 50%;
        background: radial-gradient(closest-side, rgba(255, 236, 190, 0.55), rgba(255, 170, 80, 0.18) 60%, transparent);
      }
      .join-main-btn:hover { filter: brightness(1.08);
        box-shadow: inset 0 1px 0 rgba(255, 240, 210, 0.85), inset 0 -2px 0 rgba(70, 20, 0, 0.55),
          0 0 0 1px rgba(255, 170, 90, 0.55), 0 0 52px rgba(255, 130, 40, 0.6), 0 14px 30px rgba(0, 0, 0, 0.55); }
      .join-main-btn:active { transform: translateY(1px); filter: brightness(0.96); }
      .join-main-btn:disabled { cursor: default; filter: none; transform: none; text-shadow: none; color: var(--ink-3);
        border-color: #05080d; background: linear-gradient(180deg, var(--hull-top), var(--hull-low));
        box-shadow: inset 0 1px 0 var(--edge-hi), inset 0 -2px 0 var(--edge-lo), 0 0 0 1px var(--rim); }
      .join-main-btn:disabled::before { display: none; }
      .join-main-btn small { display: block; margin-top: 6px; font: 600 14px/1.2 'Segoe UI', system-ui, sans-serif;
        letter-spacing: 1.5px; color: #fff4ea; }
      .join-main-btn:disabled small { color: var(--ink-3); }

      .join-foot { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; padding: 0 4px; }
      .join-stats { display: flex; align-items: center; gap: 16px; font-size: 13px; color: var(--ink-2); }
      .join-stats b { color: var(--ink); font-weight: 600; }
      .join-online::before { content: ''; display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 8px;
        vertical-align: 1px; background: #7dff9a; box-shadow: 0 0 6px rgba(110, 255, 150, 0.7); }
      .ping-good { color: #8cf5a4; } .ping-medium { color: #ffd98a; } .ping-bad { color: #ff9a9a; }
      .logout-btn { padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 13px; color: var(--ink-2);
        background: linear-gradient(180deg, var(--hull-top), var(--hull-low)); border: 1px solid #05080d;
        box-shadow: inset 0 1px 0 var(--edge-hi), 0 0 0 1px var(--rim); transition: color var(--ease), box-shadow var(--ease); }
      .logout-btn:hover { color: #ffb0a8; box-shadow: inset 0 1px 0 var(--edge-hi), 0 0 0 1px rgba(255, 120, 110, 0.45); }
      .logout-btn:focus-visible, #server-browser-panel button:focus-visible, #server-browser-panel input:focus-visible,
        #server-browser-panel textarea:focus-visible { outline: 2px solid var(--port); outline-offset: 2px; }
      #server-browser-panel .join-main-btn:focus-visible { outline: 3px solid #fff; outline-offset: 3px; }

      /* Narrow windows: less padding, and the Join button stays in reach while you scroll down to it */
      @media (max-width: 560px) {
        #server-browser-panel { padding: 14px 10px; }
        .join-wrap { gap: 12px; }
        .join-box { padding: 20px 16px; }
        .join-title { font-size: 26px; letter-spacing: 5px; }
        .join-blurb { font-size: 14px; margin-bottom: 16px; }
        .join-photos { gap: 6px; }
        .join-main-btn { position: sticky; bottom: 10px; z-index: 2; font-size: 28px; }
      }
      @media (prefers-reduced-motion: reduce) {
        #server-browser-panel *, #server-browser-panel *::before { transition: none !important; animation: none !important; }
        .join-main-btn:active { transform: none; }
      }
    `;
    document.head.appendChild(style);
  }

  /** The server the Join button connects to: the one on this page's own host (dev client: the dev server; the VPS: the
   *  live one), else the lobby's first */
  private mainServer(): ServerInfo | undefined {
    const here = window.location.hostname;
    return this.servers.find((s) => s.host === here) ?? this.getSortedServers()[0];
  }

  private render(): void {
    const main = this.mainServer();
    const news = (NEWS as NewsItem[]);

    this.panel.innerHTML = `
      <div class="join-wrap">
        <div class="inbox-slot-banner"></div>
        <div class="join-box">
          <h1 class="join-title">SPACE GAME</h1>
          <p class="join-blurb">Fly, fight, mine and trade alongside other pilots in one shared galaxy.
            Build your ship from parts, take on bosses together and defend stations through the night.
            The game is in early development, so expect changes and the odd bug.</p>
          <div class="join-photos">
            ${PHOTOS.map((p) => `<img src="${p.src}" alt="${p.alt}" loading="lazy">`).join('')}
          </div>
          <div class="join-h">Development news</div>
          <div class="news">
            ${news.length === 0
              ? '<div class="news-empty">No news yet. Updates from development will show up here.</div>'
              : news.map((n) => `
                <div class="news-item">
                  <div class="news-date">${esc(n.date)}</div>
                  <div class="news-title">${esc(n.title)}</div>
                  <div class="news-body">${esc(n.body)}</div>
                </div>`).join('')}
          </div>
        </div>

        <button class="join-main-btn" ${main && !this.loading ? '' : 'disabled'}>
          ${main || this.loading ? 'Join' : 'Server offline'}
          <span class="join-mail-badge" hidden></span>
          <small class="join-server">${this.loading ? 'Finding the server…' : main ? esc(main.name) : 'Try again in a minute'}</small>
        </button>

        <div class="inbox-slot"></div>

        <div class="join-foot">
          <div class="join-stats">
            ${main && !this.loading ? `<span class="join-online"><b>${main.players}</b> / ${main.maxPlayers} pilots online</span>${this.renderPing(main)}` : ''}
          </div>
          <button class="logout-btn">← Log out</button>
        </div>
      </div>
    `;

    this.panel.querySelector('.inbox-slot-banner')?.replaceWith(this.inbox.banner);
    this.panel.querySelector('.inbox-slot')?.replaceWith(this.inbox.box);
    this.showMailBadge();
    this.setupEventListeners();
  }

  /** The Join button's badge: unread mail */
  private showMailBadge(): void {
    const badge = this.panel.querySelector<HTMLElement>('.join-mail-badge');
    if (!badge) return;
    const { unread } = this.inbox.counts();
    badge.hidden = unread === 0;
    badge.textContent = `✉ ${unread} new`;
  }

  private renderPing(server: ServerInfo): string {
    if (server.ping === undefined) return '<span>…</span>';
    if (server.ping >= 999) return '<span class="ping-bad">no reply</span>';
    const cls = server.ping < 100 ? 'ping-good' : server.ping < 200 ? 'ping-medium' : 'ping-bad';
    return `<span class="${cls}">${server.ping} ms</span>`;
  }

  private getSortedServers(): ServerInfo[] {
    return [...this.servers].sort((a, b) => (a.ping ?? 9999) - (b.ping ?? 9999));
  }

  private setupEventListeners(): void {
    const q = <T extends Element>(sel: string) => this.panel.querySelector<T>(sel);
    q('.join-main-btn')?.addEventListener('click', () => {
      const main = this.mainServer();
      if (main && !this.loading) this.onServerSelect?.(main);
    });
    q('.logout-btn')?.addEventListener('click', () => this.onLogout?.());
  }

  async refresh(): Promise<void> {
    this.loading = true;
    this.render();

    // Fallback in case the lobby is unavailable: the dev server (port 3000) in dev builds; in production the game on
    // this page's own address (nginx takes its socket at the root, on the page's own scheme and port)
    const dev = !!(import.meta as { env?: { DEV?: boolean } }).env?.DEV;
    const secure = window.location.protocol === 'https:';
    const fallbackServers: ServerInfo[] = [dev ? {
      host: window.location.hostname || 'localhost',
      port: 3000,
      name: 'Local dev',
      region: 'local',
      maxPlayers: 32,
      players: 0,
      secure: false,
    } : {
      host: window.location.hostname,
      port: Number(window.location.port) || (secure ? 443 : 80),
      name: 'Space Game',
      region: '',
      maxPlayers: 32,
      players: 0,
      secure,
    }];

    try {
      const response = await fetch(`${this.browserUrl}/list`);
      if (!response.ok) throw new Error(`Server browser error (${response.status})`);
      const data = await response.json();
      this.servers = Array.isArray(data.servers) && data.servers.length > 0 ? data.servers : fallbackServers;
    } catch {
      this.servers = fallbackServers;
    }
    // Show the server as soon as it's known; the ping fills in after
    this.loading = false;
    this.render();
    await this.measurePings();
    if (this.visible) this.render();
  }

  private async measurePings(): Promise<void> {
    await Promise.all(this.servers.map(async (server) => { server.ping = await this.measurePing(server); }));
  }

  private async measurePing(server: ServerInfo): Promise<number> {
    // HTTP round trip to /health (no WebSocket errors while a server wakes up)
    try {
      const protocol = server.secure ? 'https' : 'http';
      const omitPort = server.secure && (server.port === 443 || server.port === 80);
      const url = omitPort
        ? `${protocol}://${server.host}/health`
        : `${protocol}://${server.host}:${server.port}/health`;
      const start = performance.now();
      const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(5000) });
      return response.ok ? Math.round(performance.now() - start) : 999;
    } catch {
      return 999;
    }
  }


  /** `account`: the signed-in pilot (their inbox shows); none for a guest */
  show(account: InboxAccount | null = null): void {
    this.visible = true;
    this.panel.style.display = 'flex';
    this.inbox.setAccount(account);
    void this.inbox.refresh();
    this.refresh();
  }

  hide(): void {
    this.visible = false;
    this.panel.style.display = 'none';
  }

  isVisible(): boolean {
    return this.visible;
  }
}
