/**
 * Server Browser UI - Shows available servers after login
 */

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

export class ServerBrowserUI {
  private container: HTMLElement;
  private panel: HTMLElement;
  private visible = false;
  private servers: ServerInfo[] = [];
  private loading = false;
  private error = '';
  private sortBy: 'ping' | 'name' = 'ping';
  
  // Server browser URL
  private browserUrl = 'https://spacegame-v2.fly.dev';
  
  // Callbacks
  public onServerSelect: ((server: ServerInfo) => void) | null = null;
  public onLogout: (() => void) | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    
    // Create panel
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
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        background: radial-gradient(ellipse at center, #001133 0%, #000011 100%);
        z-index: 1900;
      }
      
      .browser-container {
        width: 700px;
        max-width: 95vw;
        background: rgba(0, 20, 50, 0.95);
        border: 2px solid #2266aa;
        border-radius: 12px;
        padding: 30px;
        box-shadow: 0 0 50px rgba(0, 100, 200, 0.3);
      }
      
      .browser-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 20px;
      }
      
      .browser-title {
        font-size: 28px;
        color: #88ccff;
        text-shadow: 0 0 20px rgba(100, 180, 255, 0.5);
        font-weight: bold;
        letter-spacing: 2px;
      }
      
      .browser-controls {
        display: flex;
        gap: 10px;
      }
      
      .browser-btn {
        padding: 8px 16px;
        background: rgba(30, 60, 100, 0.8);
        border: 1px solid #446;
        border-radius: 6px;
        color: #88aacc;
        font-size: 13px;
        cursor: pointer;
        transition: all 0.2s;
      }
      
      .browser-btn:hover {
        background: rgba(40, 80, 130, 0.9);
        border-color: #66aaff;
        color: #aaccff;
      }
      
      .browser-btn.active {
        background: rgba(50, 100, 180, 0.8);
        border-color: #88ccff;
        color: #fff;
      }
      
      .sort-controls {
        display: flex;
        gap: 8px;
        margin-bottom: 15px;
      }
      
      .sort-btn {
        padding: 6px 12px;
        background: transparent;
        border: 1px solid #335;
        border-radius: 4px;
        color: #668;
        font-size: 12px;
        cursor: pointer;
        transition: all 0.2s;
      }
      
      .sort-btn:hover {
        border-color: #558;
        color: #88aacc;
      }
      
      .sort-btn.active {
        border-color: #88ccff;
        color: #88ccff;
        background: rgba(50, 100, 180, 0.2);
      }
      
      .server-list {
        max-height: 400px;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 10px;
        margin-bottom: 20px;
      }
      
      .server-list::-webkit-scrollbar {
        width: 8px;
      }
      
      .server-list::-webkit-scrollbar-track {
        background: rgba(0, 0, 0, 0.3);
        border-radius: 4px;
      }
      
      .server-list::-webkit-scrollbar-thumb {
        background: #446;
        border-radius: 4px;
      }
      
      .server-card {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 16px 20px;
        background: rgba(20, 40, 70, 0.8);
        border: 1px solid #335;
        border-radius: 8px;
        cursor: pointer;
        transition: all 0.2s;
      }
      
      .server-card:hover {
        background: rgba(30, 60, 100, 0.9);
        border-color: #558;
        transform: translateX(5px);
      }
      
      .server-info {
        flex: 1;
      }
      
      .server-name {
        font-size: 18px;
        color: #fff;
        margin-bottom: 4px;
      }
      
      .server-meta {
        display: flex;
        gap: 12px;
        font-size: 13px;
        color: #668;
      }
      
      .region-tag {
        background: rgba(100, 150, 255, 0.2);
        color: #88aacc;
        padding: 2px 8px;
        border-radius: 4px;
        font-size: 11px;
        text-transform: uppercase;
      }
      
      .server-stats {
        display: flex;
        align-items: center;
        gap: 20px;
      }
      
      .server-players {
        font-size: 16px;
        color: #88ff88;
      }
      
      .server-ping {
        font-size: 14px;
        padding: 4px 10px;
        border-radius: 4px;
        min-width: 60px;
        text-align: center;
      }
      
      .ping-good { background: rgba(80, 200, 80, 0.2); color: #88ff88; }
      .ping-medium { background: rgba(200, 180, 80, 0.2); color: #ffdd88; }
      .ping-bad { background: rgba(200, 80, 80, 0.2); color: #ff8888; }
      
      .join-btn {
        padding: 10px 20px;
        background: linear-gradient(180deg, #228822 0%, #116611 100%);
        border: none;
        border-radius: 6px;
        color: #fff;
        font-size: 14px;
        font-weight: bold;
        cursor: pointer;
        transition: all 0.2s;
        margin-left: 15px;
      }
      
      .join-btn:hover {
        background: linear-gradient(180deg, #33aa33 0%, #228822 100%);
        box-shadow: 0 0 15px rgba(80, 200, 80, 0.3);
      }
      
      .browser-status {
        text-align: center;
        padding: 40px;
        color: #668;
        font-size: 14px;
      }
      
      .browser-error {
        text-align: center;
        padding: 20px;
        background: rgba(200, 50, 50, 0.2);
        border: 1px solid #a44;
        border-radius: 8px;
        color: #ff6666;
        font-size: 14px;
        margin-bottom: 15px;
      }
      
      .browser-footer {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding-top: 15px;
        border-top: 1px solid #335;
      }
      
      .logout-btn {
        padding: 10px 20px;
        background: transparent;
        border: 1px solid #664444;
        border-radius: 6px;
        color: #aa6666;
        font-size: 14px;
        cursor: pointer;
        transition: all 0.2s;
      }
      
      .logout-btn:hover {
        background: rgba(150, 50, 50, 0.2);
        border-color: #aa6666;
        color: #ff8888;
      }
      
      .direct-connect {
        display: flex;
        gap: 10px;
      }
      
      .direct-input {
        padding: 10px 15px;
        background: rgba(0, 30, 60, 0.8);
        border: 1px solid #335;
        border-radius: 6px;
        color: #fff;
        font-size: 14px;
        width: 200px;
      }
      
      .direct-input:focus {
        border-color: #66aaff;
        outline: none;
      }
      
      .direct-btn {
        padding: 10px 15px;
        background: rgba(30, 60, 100, 0.8);
        border: 1px solid #446;
        border-radius: 6px;
        color: #88aacc;
        cursor: pointer;
        transition: all 0.2s;
      }
      
      .direct-btn:hover {
        background: rgba(40, 80, 130, 0.9);
        border-color: #66aaff;
      }
    `;
    document.head.appendChild(style);
  }

  private render(): void {
    const sortedServers = this.getSortedServers();
    
    this.panel.innerHTML = `
      <div class="browser-container">
        <div class="browser-header">
          <div class="browser-title">SELECT SERVER</div>
          <div class="browser-controls">
            <button class="browser-btn refresh-btn">⟳ Refresh</button>
          </div>
        </div>
        
        <div class="sort-controls">
          <span style="color:#668;font-size:12px;margin-right:10px;">Sort by:</span>
          <button class="sort-btn ${this.sortBy === 'ping' ? 'active' : ''}" data-sort="ping">Ping</button>
          <button class="sort-btn ${this.sortBy === 'name' ? 'active' : ''}" data-sort="name">Name</button>
        </div>
        
        ${this.error ? `<div class="browser-error">${this.error}</div>` : ''}
        
        <div class="server-list">
          ${this.loading ? `
            <div class="browser-status">Loading servers...</div>
          ` : sortedServers.length === 0 ? `
            <div class="browser-status">No servers available</div>
          ` : sortedServers.map(server => this.renderServerCard(server)).join('')}
        </div>
        
        <div class="browser-footer">
          <button class="logout-btn">← Logout</button>
          <div class="direct-connect">
            <input type="text" class="direct-input" placeholder="ws://host:port" />
            <button class="direct-btn">Direct Connect</button>
          </div>
        </div>
      </div>
    `;
    
    this.setupEventListeners();
  }

  private renderServerCard(server: ServerInfo): string {
    const pingClass = server.ping !== undefined
      ? server.ping < 100 ? 'ping-good'
        : server.ping < 200 ? 'ping-medium'
        : 'ping-bad'
      : '';
    
    const pingText = server.ping !== undefined
      ? server.ping < 999 ? `${server.ping}ms` : 'N/A'
      : '...';
    
    const region = this.getRegionName(server);
    
    return `
      <div class="server-card" data-host="${server.host}" data-port="${server.port}" data-secure="${server.secure}">
        <div class="server-info">
          <div class="server-name">${this.escapeHtml(server.name || region)}</div>
          <div class="server-meta">
            <span class="region-tag">${region}</span>
            <span>${server.players}/${server.maxPlayers} players</span>
          </div>
        </div>
        <div class="server-stats">
          <div class="server-ping ${pingClass}">${pingText}</div>
          <button class="join-btn">Join</button>
        </div>
      </div>
    `;
  }

  private getRegionName(server: ServerInfo): string {
    if (server.region) {
      const regionMap: Record<string, string> = {
        'iad': 'US East',
        'lax': 'US West',
        'syd': 'Australia',
        'lhr': 'Europe',
        'nrt': 'Japan',
        'sin': 'Singapore',
        'local': 'Local',
      };
      return regionMap[server.region] || server.region.toUpperCase();
    }
    
    // Try to detect from hostname
    const host = server.host.toLowerCase();
    if (host.includes('syd')) return 'Australia';
    if (host.includes('iad')) return 'US East';
    if (host.includes('lax')) return 'US West';
    if (host.includes('lhr')) return 'Europe';
    if (host.includes('localhost') || host.includes('127.0.0.1')) return 'Local';
    
    return 'Unknown';
  }

  private getSortedServers(): ServerInfo[] {
    return [...this.servers].sort((a, b) => {
      if (this.sortBy === 'ping') {
        const pingA = a.ping ?? 9999;
        const pingB = b.ping ?? 9999;
        return pingA - pingB;
      } else {
        return (a.name || '').localeCompare(b.name || '');
      }
    });
  }

  private setupEventListeners(): void {
    // Refresh button
    const refreshBtn = this.panel.querySelector('.refresh-btn');
    refreshBtn?.addEventListener('click', () => this.refresh());
    
    // Sort buttons
    const sortBtns = this.panel.querySelectorAll('.sort-btn');
    sortBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        this.sortBy = (btn as HTMLElement).dataset.sort as 'ping' | 'name';
        this.render();
      });
    });
    
    // Server cards
    const serverCards = this.panel.querySelectorAll('.server-card');
    serverCards.forEach(card => {
      const joinBtn = card.querySelector('.join-btn');
      joinBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        const host = (card as HTMLElement).dataset.host!;
        const port = parseInt((card as HTMLElement).dataset.port!, 10);
        const secure = (card as HTMLElement).dataset.secure === 'true';
        const server = this.servers.find(s => s.host === host && s.port === port);
        if (server) {
          this.onServerSelect?.(server);
        }
      });
      
      // Also allow clicking the whole card
      card.addEventListener('click', () => {
        const host = (card as HTMLElement).dataset.host!;
        const port = parseInt((card as HTMLElement).dataset.port!, 10);
        const server = this.servers.find(s => s.host === host && s.port === port);
        if (server) {
          this.onServerSelect?.(server);
        }
      });
    });
    
    // Logout button
    const logoutBtn = this.panel.querySelector('.logout-btn');
    logoutBtn?.addEventListener('click', () => this.onLogout?.());
    
    // Direct connect
    const directInput = this.panel.querySelector('.direct-input') as HTMLInputElement;
    const directBtn = this.panel.querySelector('.direct-btn');
    directBtn?.addEventListener('click', () => {
      const url = directInput?.value.trim();
      if (url) {
        // Parse the URL and create a fake server entry
        const match = url.match(/^(wss?):\/\/([^:\/]+)(?::(\d+))?/);
        if (match) {
          const server: ServerInfo = {
            host: match[2],
            port: parseInt(match[3] || (match[1] === 'wss' ? '443' : '80'), 10),
            name: 'Direct Connect',
            maxPlayers: 32,
            players: 0,
            secure: match[1] === 'wss',
          };
          this.onServerSelect?.(server);
        }
      }
    });
    
    // Enter key on direct input
    directInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        directBtn?.dispatchEvent(new Event('click'));
      }
    });
  }

  async refresh(): Promise<void> {
    this.loading = true;
    this.error = '';
    this.render();
    
    // Fallback servers in case API is unavailable
    const fallbackServers: ServerInfo[] = [
      {
        host: 'spacegame-v2-server.fly.dev',
        port: 443,
        name: 'Sydney (Primary)',
        region: 'Sydney',
        maxPlayers: 32,
        players: 0,
        secure: true,
      }
    ];
    
    try {
      const response = await fetch(`${this.browserUrl}/list`);
      if (!response.ok) {
        throw new Error(`Server browser error (${response.status})`);
      }
      
      const data = await response.json();
      this.servers = Array.isArray(data.servers) && data.servers.length > 0 
        ? data.servers 
        : fallbackServers;
      
      // Measure ping for each server
      await this.measurePings();
      
    } catch (err) {
      // Use fallback servers if API fails
      this.servers = fallbackServers;
      await this.measurePings();
    }
    
    this.loading = false;
    this.render();
  }

  private async measurePings(): Promise<void> {
    const pingPromises = this.servers.map(async (server) => {
      server.ping = await this.measurePing(server);
    });
    
    await Promise.all(pingPromises);
  }

  private async measurePing(server: ServerInfo): Promise<number> {
    // Use HTTP fetch to /health to measure round-trip time
    // This avoids WebSocket errors when machines are waking up on fly.io
    try {
      const protocol = server.secure ? 'https' : 'http';
      const isFlyHost = /\.fly\.dev$/i.test(server.host);
      const shouldOmitPort = isFlyHost || (server.secure && (server.port === 443 || server.port === 80));
      
      const url = shouldOmitPort
        ? `${protocol}://${server.host}/health`
        : `${protocol}://${server.host}:${server.port}/health`;
      
      const start = performance.now();
      const response = await fetch(url, { 
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      });
      
      if (response.ok) {
        return Math.round(performance.now() - start);
      }
      return 999;
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
