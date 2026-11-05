/**
 * Join screen - shown after sign-in. There is one main server, so it's a Join button for it, a short
 * description of the game with a few photos, and the development news feed (join/news.json).
 * Any other servers the lobby lists, and direct connect, sit under "Other servers".
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
  private showOthers = false;

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
      .join-wrap {
        width: 980px; max-width: 100%; margin: auto;
        display: grid; grid-template-columns: 1fr 320px; gap: 20px;
      }
      @media (max-width: 820px) { .join-wrap { grid-template-columns: 1fr; } }
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
      .join-side { display: flex; flex-direction: column; gap: 14px; }
      .join-server-label { font-size: 12px; letter-spacing: 2px; text-transform: uppercase; color: #6f8fb5; }
      .join-main-btn {
        width: 100%; padding: 18px 16px; margin-top: 10px;
        background: linear-gradient(180deg, #2a9a3a 0%, #17702a 100%);
        border: 1px solid #4c4; border-radius: 8px; color: #fff; cursor: pointer;
        font-size: 22px; font-weight: bold; letter-spacing: 1px; transition: background 0.2s, box-shadow 0.2s;
      }
      .join-main-btn:hover { background: linear-gradient(180deg, #36b347 0%, #208a33 100%); box-shadow: 0 0 18px rgba(80, 200, 80, 0.35); }
      .join-main-btn:focus-visible { outline: 2px solid #aef; outline-offset: 2px; }
      .join-main-btn:disabled { background: #233; border-color: #345; color: #678; cursor: default; box-shadow: none; }
      .join-main-btn small { display: block; font-size: 12px; font-weight: normal; letter-spacing: 0; opacity: 0.85; margin-top: 2px; }
      .join-stats { display: flex; justify-content: space-between; margin-top: 12px; font-size: 13px; color: #9fb4cc; }
      .join-stats b { color: #88ff88; font-weight: normal; }
      .ping-good { color: #88ff88; } .ping-medium { color: #ffdd88; } .ping-bad { color: #ff8888; }
      .join-link { background: none; border: none; color: #6f8fb5; font-size: 13px; cursor: pointer; padding: 0; text-align: left; }
      .join-link:hover { color: #aaccff; }
      .other-list { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }
      .other-server { display: flex; justify-content: space-between; align-items: center; gap: 8px;
        padding: 8px 10px; background: rgba(20, 40, 70, 0.8); border: 1px solid #335; border-radius: 6px;
        color: #dde8f5; font-size: 13px; cursor: pointer; text-align: left; }
      .other-server:hover { border-color: #558; }
      .direct-connect { display: flex; gap: 6px; margin-top: 8px; }
      .direct-input { flex: 1; min-width: 0; padding: 7px 10px; background: rgba(0, 30, 60, 0.8);
        border: 1px solid #335; border-radius: 6px; color: #fff; font-size: 13px; }
      .direct-input:focus { border-color: #66aaff; outline: none; }
      .direct-btn { padding: 7px 10px; background: rgba(30, 60, 100, 0.8); border: 1px solid #446;
        border-radius: 6px; color: #88aacc; cursor: pointer; font-size: 13px; }
      .logout-btn { align-self: flex-start; padding: 8px 16px; background: transparent; border: 1px solid #664444;
        border-radius: 6px; color: #aa6666; font-size: 13px; cursor: pointer; }
      .logout-btn:hover { background: rgba(150, 50, 50, 0.2); color: #ff8888; }
    `;
    document.head.appendChild(style);
  }

  /** The server the Join button connects to: the lobby's first (lowest ping) */
  private mainServer(): ServerInfo | undefined {
    return this.getSortedServers()[0];
  }

  private render(): void {
    const main = this.mainServer();
    const others = this.getSortedServers().slice(1);
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

        <div class="join-side">
          <div class="join-box">
            <div class="join-server-label">Server</div>
            <button class="join-main-btn" ${main ? '' : 'disabled'}>
              ${this.loading ? 'Finding the server…' : main ? `Join ${this.escapeHtml(main.name)}` : 'Server offline'}
              ${main && !this.loading ? `<small>${this.regionName(main)}</small>` : ''}
            </button>
            ${main && !this.loading ? `
              <div class="join-stats">
                <span><b>${main.players}</b> / ${main.maxPlayers} pilots online</span>
                ${this.renderPing(main)}
              </div>` : ''}
          </div>

          <div class="join-box">
            <button class="join-link others-toggle">${this.showOthers ? '▾' : '▸'} Other servers</button>
            ${this.showOthers ? `
              <div class="other-list">
                ${others.map((s, k) => `
                  <button class="other-server" data-k="${k + 1}">
                    <span>${this.escapeHtml(s.name)}</span><span>${s.players}/${s.maxPlayers} · ${this.renderPing(s)}</span>
                  </button>`).join('')}
                ${others.length === 0 ? '<div class="news-empty">None listed.</div>' : ''}
              </div>
              <div class="direct-connect">
                <input type="text" class="direct-input" id="direct-input" placeholder="ws://host:port" />
                <button class="direct-btn">Connect</button>
              </div>` : ''}
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

  private regionName(server: ServerInfo): string {
    const regionMap: Record<string, string> = {
      'au': 'Australia', 'syd': 'Australia', 'iad': 'US East', 'lax': 'US West',
      'lhr': 'Europe', 'nrt': 'Japan', 'sin': 'Singapore', 'local': 'This computer',
    };
    if (server.region) return regionMap[server.region] || server.region.toUpperCase();
    const host = server.host.toLowerCase();
    if (host.includes('localhost') || host.includes('127.0.0.1')) return 'This computer';
    return '';
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
    q('.others-toggle')?.addEventListener('click', () => { this.showOthers = !this.showOthers; this.render(); });
    const sorted = this.getSortedServers();
    this.panel.querySelectorAll<HTMLElement>('.other-server').forEach((el) => {
      el.addEventListener('click', () => {
        const s = sorted[Number(el.dataset.k)];
        if (s) this.onServerSelect?.(s);
      });
    });
    q('.logout-btn')?.addEventListener('click', () => this.onLogout?.());

    const directInput = q<HTMLInputElement>('.direct-input');
    const directBtn = q('.direct-btn');
    const direct = () => {
      const url = directInput?.value.trim();
      const match = url?.match(/^(wss?):\/\/([^:\/]+)(?::(\d+))?/);
      if (!match) return;
      this.onServerSelect?.({
        host: match[2],
        port: parseInt(match[3] || (match[1] === 'wss' ? '443' : '80'), 10),
        name: 'Direct Connect',
        maxPlayers: 32,
        players: 0,
        secure: match[1] === 'wss',
      });
    };
    directBtn?.addEventListener('click', direct);
    directInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') direct(); });
  }

  async refresh(): Promise<void> {
    this.loading = true;
    this.render();

    // Fallback in case the lobby is unavailable
    const fallbackServers: ServerInfo[] = [{
      host: window.location.hostname || 'localhost',
      port: 3000,
      name: 'Local Dev Server',
      region: 'local',
      maxPlayers: 32,
      players: 0,
      secure: false,
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
