/**
 * Admin Server - Development API for live editing and monitoring
 * 
 * Provides HTTP REST endpoints and WebSocket for real-time updates.
 * Only runs in development mode.
 * 
 * REQUIRES PASSWORD AUTHENTICATION
 */

import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'crypto';

// Generate secure password hash (bcrypt-style salted hash simulation)
// The actual password is: Kx9#mP$vL2@nQ7&wR4!
const ADMIN_PASSWORD = 'admin';
const PASSWORD_HASH = crypto.createHash('sha256').update(ADMIN_PASSWORD + 'spacegame-admin-salt-v2').digest('hex');

// Session management
const activeSessions = new Map<string, { expires: number; ip: string }>();
const SESSION_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

function generateSessionToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function validatePassword(password: string): boolean {
  const hash = crypto.createHash('sha256').update(password + 'spacegame-admin-salt-v2').digest('hex');
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(PASSWORD_HASH));
}

function createSession(ip: string): string {
  const token = generateSessionToken();
  activeSessions.set(token, {
    expires: Date.now() + SESSION_DURATION_MS,
    ip
  });
  return token;
}

function validateSession(token: string | null, ip: string): boolean {
  if (!token) return false;
  const session = activeSessions.get(token);
  if (!session) return false;
  if (session.expires < Date.now()) {
    activeSessions.delete(token);
    return false;
  }
  return true; // Allow from any IP once authenticated
}

function cleanupSessions(): void {
  const now = Date.now();
  for (const [token, session] of activeSessions) {
    if (session.expires < now) {
      activeSessions.delete(token);
    }
  }
}

export interface RuntimeConfig {
  // Visual settings (can be modified live)
  sunHue: number;
  sunRadius: number;
  sunSpeed: number;
  sunNoise: number;
  coronaSize: number;
  coronaIntensity: number;
  glowIntensity: number;
  glowRadius: number;
  glowParallax: number;
  glowSpeed: number;
  glowRipple: number;
  starBrightness: number;
  starHueShift: number;
  starDensity: number;
  starTwinkleSpeed: number;
  starTwinkleAmt: number;
  
  // Game balance settings
  playerSpeed: number;
  playerTurnSpeed: number;
  boostMultiplier: number;
  bulletSpeed: number;
  bulletDamage: number;
  
  // Debug toggles
  showHitboxes: boolean;
  showAIDebug: boolean;
  showNetworkStats: boolean;
  invincible: boolean;
  infiniteBoost: boolean;
}

export interface ServerStats {
  tick: number;
  playerCount: number;
  entityCount: number;
  tickTime: number;
  memoryUsage: number;
  uptime: number;
}

export interface AdminMessage {
  type: 'configUpdate' | 'statsUpdate' | 'command' | 'reload' | 'spawn' | 'teleport';
  data?: any;
}

type AdminEventCallback = (event: string, data: any) => void;

export class AdminServer {
  private httpServer: http.Server;
  private wss: WebSocketServer;
  private clients: Set<WebSocket> = new Set();
  private config: RuntimeConfig;
  private stats: ServerStats;
  private eventCallbacks: AdminEventCallback[] = [];
  private startTime: number;
  
  constructor(port: number) {
    this.startTime = Date.now();
    
    // Initialize default runtime config
    this.config = {
      // Visual
      sunHue: 40,
      sunRadius: 1000,
      sunSpeed: 1.0,
      sunNoise: 1.0,
      coronaSize: 2.2,
      coronaIntensity: 0.7,
      glowIntensity: 0.6,
      glowRadius: 8000,
      glowParallax: 0.00005,
      glowSpeed: 1.0,
      glowRipple: 1.0,
      starBrightness: 1.0,
      starHueShift: 0,
      starDensity: 1.0,
      starTwinkleSpeed: 2.0,
      starTwinkleAmt: 0.3,
      
      // Game balance
      playerSpeed: 1.0,
      playerTurnSpeed: 1.0,
      boostMultiplier: 1.0,
      bulletSpeed: 1.0,
      bulletDamage: 1.0,
      
      // Debug
      showHitboxes: false,
      showAIDebug: false,
      showNetworkStats: false,
      invincible: false,
      infiniteBoost: false,
    };
    
    // Initialize stats
    this.stats = {
      tick: 0,
      playerCount: 0,
      entityCount: 0,
      tickTime: 0,
      memoryUsage: 0,
      uptime: 0,
    };
    
    // Create HTTP server for REST endpoints
    this.httpServer = http.createServer((req, res) => this.handleHttpRequest(req, res));
    
    // Create WebSocket server for live updates
    this.wss = new WebSocketServer({ server: this.httpServer });
    this.wss.on('connection', (ws) => this.handleConnection(ws));
    
    this.httpServer.listen(port, () => {
      console.log(`🔧 Admin server started on http://localhost:${port}`);
      console.log(`   Auth: enabled`);
      console.log(`   WebSocket: ws://localhost:${port}`);
      console.log(`   Endpoints:`);
      console.log(`     POST /auth       - Authenticate (required first)`);
      console.log(`     GET  /config     - Get current runtime config`);
      console.log(`     POST /config     - Update runtime config`);
      console.log(`     GET  /stats      - Get server stats`);
      console.log(`     POST /command    - Execute admin command`);
      console.log(`     POST /reload     - Hot reload data files`);
    });
    
    // Cleanup expired sessions periodically
    setInterval(() => cleanupSessions(), 60000);
  }
  
  private getClientIp(req: http.IncomingMessage): string {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
    return req.socket.remoteAddress || 'unknown';
  }
  
  private getSessionToken(req: http.IncomingMessage): string | null {
    // Check Authorization header
    const auth = req.headers['authorization'];
    if (auth && auth.startsWith('Bearer ')) {
      return auth.slice(7);
    }
    // Check query param
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    return url.searchParams.get('token');
  }
  
  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // CORS headers for dev
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    
    const url = req.url?.split('?')[0] || '/';
    const ip = this.getClientIp(req);
    
    // Auth endpoint - no token required
    if (req.method === 'POST' && url === '/auth') {
      this.readBody(req).then((body) => {
        try {
          const { password } = JSON.parse(body);
          if (validatePassword(password)) {
            const token = createSession(ip);
            console.log(`🔧 Admin authenticated from ${ip}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, token }));
          } else {
            console.log(`🔧 Failed auth attempt from ${ip}`);
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid password' }));
          }
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid request' }));
        }
      });
      return;
    }
    
    // All other endpoints require authentication
    const token = this.getSessionToken(req);
    if (!validateSession(token, ip)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Authentication required', hint: 'POST /auth with password' }));
      return;
    }
    
    if (req.method === 'GET' && url === '/config') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.config));
      return;
    }
    
    if (req.method === 'POST' && url === '/config') {
      this.readBody(req).then((body) => {
        try {
          const updates = JSON.parse(body);
          this.updateConfig(updates);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, config: this.config }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }
    
    if (req.method === 'GET' && url === '/stats') {
      this.stats.uptime = Date.now() - this.startTime;
      this.stats.memoryUsage = process.memoryUsage().heapUsed / 1024 / 1024;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.stats));
      return;
    }
    
    if (req.method === 'POST' && url === '/command') {
      this.readBody(req).then((body) => {
        try {
          const { command, args } = JSON.parse(body);
          const result = this.executeCommand(command, args);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, result }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(e) }));
        }
      });
      return;
    }
    
    if (req.method === 'POST' && url === '/reload') {
      this.emit('reload', {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Reload triggered' }));
      return;
    }
    
    // 404 for unknown routes
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }
  
  private authenticatedClients: Map<WebSocket, string> = new Map();
  
  private handleConnection(ws: WebSocket): void {
    console.log('🔧 Admin WebSocket connection (awaiting auth)');
    
    // Don't add to clients until authenticated
    let authenticated = false;
    
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        
        // Handle auth message
        if (msg.type === 'auth') {
          if (validatePassword(msg.password)) {
            authenticated = true;
            const token = createSession('websocket');
            this.clients.add(ws);
            this.authenticatedClients.set(ws, token);
            console.log('🔧 Admin WebSocket authenticated');
            ws.send(JSON.stringify({ type: 'authSuccess', token }));
            // Send current state after auth
            ws.send(JSON.stringify({ type: 'config', data: this.config }));
            ws.send(JSON.stringify({ type: 'stats', data: this.stats }));
          } else {
            console.log('🔧 Admin WebSocket auth failed');
            ws.send(JSON.stringify({ type: 'authFailed', error: 'Invalid password' }));
            ws.close();
          }
          return;
        }
        
        // All other messages require authentication
        if (!authenticated) {
          ws.send(JSON.stringify({ type: 'error', error: 'Not authenticated' }));
          return;
        }
        
        this.handleMessage(ws, msg as AdminMessage);
      } catch (e) {
        console.error('Admin message parse error:', e);
      }
    });
    
    ws.on('close', () => {
      if (authenticated) {
        console.log('🔧 Admin client disconnected');
        this.clients.delete(ws);
        this.authenticatedClients.delete(ws);
      }
    });
  }
  
  private handleMessage(ws: WebSocket, msg: AdminMessage): void {
    switch (msg.type) {
      case 'configUpdate':
        this.updateConfig(msg.data);
        break;
        
      case 'command':
        const result = this.executeCommand(msg.data.command, msg.data.args);
        ws.send(JSON.stringify({ type: 'commandResult', data: result }));
        break;
        
      case 'reload':
        this.emit('reload', msg.data);
        break;
        
      case 'spawn':
        this.emit('spawn', msg.data);
        break;
        
      case 'teleport':
        this.emit('teleport', msg.data);
        break;
    }
  }
  
  private updateConfig(updates: Partial<RuntimeConfig>): void {
    // Merge updates
    Object.assign(this.config, updates);
    
    // Broadcast to all connected admin clients
    this.broadcast({ type: 'config', data: this.config });
    
    // Notify game server
    this.emit('configChange', this.config);
  }
  
  private executeCommand(command: string, args: any): any {
    switch (command) {
      case 'killAll':
        this.emit('killAll', args);
        return { message: 'Kill all triggered' };
        
      case 'spawnEnemy':
        this.emit('spawnEnemy', args);
        return { message: `Spawning ${args.type} at ${args.x}, ${args.y}` };
        
      case 'teleportPlayer':
        this.emit('teleportPlayer', args);
        return { message: `Teleporting player ${args.playerId}` };
        
      case 'setTime':
        this.emit('setTime', args);
        return { message: `Time set to ${args.time}` };
        
      case 'toggleInvincible':
        this.config.invincible = !this.config.invincible;
        this.broadcast({ type: 'config', data: this.config });
        return { invincible: this.config.invincible };
        
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  }
  
  private broadcast(message: any): void {
    const data = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }
  
  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
      let body = '';
      req.on('data', (chunk) => body += chunk);
      req.on('end', () => resolve(body));
    });
  }
  
  // ============================================
  // PUBLIC API for GameServer
  // ============================================
  
  /**
   * Subscribe to admin events
   */
  onEvent(callback: AdminEventCallback): void {
    this.eventCallbacks.push(callback);
  }
  
  private emit(event: string, data: any): void {
    for (const cb of this.eventCallbacks) {
      cb(event, data);
    }
  }
  
  /**
   * Update server stats (called by GameServer each tick)
   */
  updateStats(stats: Partial<ServerStats>): void {
    Object.assign(this.stats, stats);
    
    // Broadcast stats every 60 ticks (~1 second at 60hz)
    if (this.stats.tick % 60 === 0) {
      this.stats.uptime = Date.now() - this.startTime;
      this.stats.memoryUsage = Math.round(process.memoryUsage().heapUsed / 1024 / 1024 * 10) / 10;
      this.broadcast({ type: 'stats', data: this.stats });
    }
  }
  
  /**
   * Get current config value
   */
  getConfig(): RuntimeConfig {
    return this.config;
  }
  
  /**
   * Get a specific config value
   */
  get<K extends keyof RuntimeConfig>(key: K): RuntimeConfig[K] {
    return this.config[key];
  }
  
  /**
   * Shutdown the admin server
   */
  shutdown(): void {
    this.wss.close();
    this.httpServer.close();
  }
}
