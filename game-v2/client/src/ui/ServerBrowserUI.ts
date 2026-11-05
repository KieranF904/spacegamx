/**
 * Join screen - shown after sign-in. There is one main server, so it's a Join button for it, a short
 * description of the game with a few photos, and the development news feed (join/news.json).
 * The server is the one this page belongs to: the dev server on the dev client, the live server on the VPS.
 */

import { LOBBY_URL } from '../network/lobby';
import NEWS from './join/news.json';
import sunRun from './join/sun-run.jpg';
import planet from './join/planet.jpg';
import boss from './join/boss.jpg';

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

  // Callbacks
  public onServerSelect: ((server: ServerInfo) => void) | null = null;
  public onLogout: (() => void) | null = null;

  constructor(container: HTMLElement) {
    this.container = container;

    this.panel = document.createElement('div');
    this.panel.id = 'server-browser-panel';
    this.panel.className = 'ui-element';
    this.panel.style.display = 'none';
    container.appendChild(this.panel);

    this.setupStyles();
    this.render();
  }

  private setupStyles(): void {
    const style = document.createElement('style');
    style.textContent = `
      #server-browser-panel {
        position: absolute; inset: 0;
        display: flex; align-items: center; justify-content: center;
        background: radial-gradient(ellipse at center, #001133 0%, #000011 100%);
        z-index: 1900; overflow-y: auto; padding: 24px 16px; box-sizing: border-box;
      }
      .join-wrap { width: 780px; max-width: 100%; margin: auto; display: flex; flex-direction: column; gap: 14px; }
      .join-box {
        background: rgba(0, 20, 50, 0.95); border: 1px solid #2266aa; border-radius: 12px;
        padding: 22px 24px; box-shadow: 0 0 40px rgba(0, 100, 200, 0.2); box-sizing: border-box;
      }
      .join-title { font-size: 30px; color: #88ccff; font-weight: bold; letter-spacing: 3px;
        text-shadow: 0 0 20px rgba(100, 180, 255, 0.45); margin: 0 0 8px; }
      .join-blurb { color: #9fb4cc; font-size: 14px; line-height: 1.55; margin: 0 0 16px; max-width: 60ch; }
      .join-photos { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 4px; }
      .join-photos img { width: 100%; aspect-ratio: 16 / 10; object-fit: cover; border-radius: 6px;
        border: 1px solid #234; display: block; }
      .join-h { font-size: 12px; letter-spacing: 2px; text-transform: uppercase; color: #6f8fb5; margin: 20px 0 10px; }
      .news { display: flex; flex-direction: column; gap: 12px; max-height: 260px; overflow-y: auto; padding-right: 4px; }
      .news-item { border-left: 2px solid #2a5a8a; padding-left: 12px; }
      .news-date { font-size: 11px; color: #6f8fb5; font-variant-numeric: tabular-nums; }
      .news-title { color: #dde8f5; font-size: 15px; margin: 2px 0 4px; }
      .news-body { color: #9fb4cc; font-size: 13px; line-height: 1.5; }
      .news-empty { color: #6a7d96; font-size: 13px; }
      .join-main-btn {
        width: 100%; padding: 14px 16px 12px;
        background: linear-gradient(180deg, #2a9a3a 0%, #17702a 100%);
        border: 1px solid #4c4; border-radius: 8px; color: #fff; cursor: pointer;
        font-size: 30px; font-weight: bold; letter-spacing: 3px; transition: background 0.2s, box-shadow 0.2s;
      }
      .join-main-btn:hover { background: linear-gradient(180deg, #36b347 0%, #208a33 100%); box-shadow: 0 0 18px rgba(80, 200, 80, 0.35); }
      .join-main-btn:focus-visible { outline: 2px solid #aef; outline-offset: 2px; }
      .join-main-btn:disabled { background: #233; border-color: #345; color: #678; cursor: default; box-shadow: none; }
      .join-main-btn small { display: block; font-size: 13px; font-weight: normal; letter-spacing: 1px; opacity: 0.85; margin-top: 2px; }
      .join-foot { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
      .join-stats { display: flex; gap: 16px; font-size: 13px; color: #9fb4cc; }
      .join-stats b { color: #88ff88; font-weight: normal; }
      .ping-good { color: #88ff88; } .ping-medium { color: #ffdd88; } .ping-bad { color: #ff8888; }
      .logout-btn { padding: 8px 16px; background: transparent; border: 1px solid #664444;
        border-radius: 6px; color: #aa6666; font-size: 13px; cursor: pointer; }
      .logout-btn:hover { background: rgba(150, 50, 50, 0.2); color: #ff8888; }
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
                  <div class="news-date">${this.escapeHtml(n.date)}</div>
                  <div class="news-title">${this.escapeHtml(n.title)}</div>
                  <div class="news-body">${this.escapeHtml(n.body)}</div>
                </div>`).join('')}
          </div>
        </div>

        <button class="join-main-btn" ${main && !this.loading ? '' : 'disabled'}>
          ${main || this.loading ? 'Join' : 'Server offline'}
          <small class="join-server">${this.loading ? 'Finding the server…' : main ? this.escapeHtml(main.name) : 'Try again in a minute'}</small>
        </button>

        <div class="join-foot">
          <div class="join-stats">
            ${main && !this.loading ? `<span><b>${main.players}</b> / ${main.maxPlayers} pilots online</span>${this.renderPing(main)}` : ''}
          </div>
          <button class="logout-btn">← Log out</button>
        </div>
      </div>
    `;

    this.setupEventListeners();
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

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  show(): void {
    this.visible = true;
    this.panel.style.display = 'flex';
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
