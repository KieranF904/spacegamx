/**
 * SocketTransport - Node HTTP + WebSocket front end for GameServer.
 *
 * Owns everything that used to live in the GameServer constructor: the HTTP
 * server (health check + auth endpoints) and the WebSocket upgrade. Each socket
 * is wrapped as a ClientSocket and its decoded messages go through a ClientLink.
 */

import http from 'http';
import type { IncomingMessage } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { isBinaryMessage, InputDecoder, ClientMessage, ClientSocket } from '@space-game/common';
import type { GameServer } from '../GameServer.js';

/**
 * Limits on what one client can do to the server (docs/audits/server-robustness.md):
 * - the largest message a client may send (after inflating): a ship design of
 *   256 parts is ~40 KB; nothing legitimate comes near this;
 * - how much may wait unsent for a client that stops reading (its snapshots
 *   would pile up in memory): past it the socket's dropped;
 * - sockets open at once from one address (behind nginx: X-Real-IP).
 */
export const MAX_CLIENT_MESSAGE_BYTES = 512 * 1024;
export const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
export const MAX_SOCKETS_PER_IP = 16;

/** The client's address: nginx's X-Real-IP, believed only from this machine */
export function clientAddress(req: IncomingMessage): string {
  const direct = req.socket.remoteAddress ?? '';
  const loopback = direct === '127.0.0.1' || direct === '::1' || direct === '::ffff:127.0.0.1';
  const real = req.headers['x-real-ip'];
  return loopback && typeof real === 'string' && real ? real.trim() : direct;
}

export class SocketTransport {
  private httpServer: http.Server;
  private wss: WebSocketServer;
  private perIp = new Map<string, number>();
  /** When a bad frame was last logged (a line every few seconds, not one per frame) */
  private lastBadLog = 0;
  private badSince = 0;

  constructor(private server: GameServer, port: number, host?: string) {
    this.httpServer = http.createServer((req, res) => {
      // CORS headers for all responses
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      // Handle preflight
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // Health check (the join screen's ping, nginx /health)
      if (req.url === '/health' || req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', players: this.server.getPlayerCount() }));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    // Frames are deflated too (permessage-deflate, negotiated with the browser):
    // the binary frames shrink by another ~30%. An 8 KB window at level 4 is about
    // 64 KB of zlib state per pilot and gets within 5% of the best zlib manages on
    // them; ~2 KB/s per pilot costs nothing to compress. Tiny frames (pongs) go as they are.
    this.wss = new WebSocketServer({
      server: this.httpServer,
      // (ws checks this after inflating too, so a small compressed bomb is refused as well)
      maxPayload: MAX_CLIENT_MESSAGE_BYTES,
      perMessageDeflate: {
        zlibDeflateOptions: { level: 4, memLevel: 6 },
        serverMaxWindowBits: 13,
        clientMaxWindowBits: 11,
        clientNoContextTakeover: true,
        threshold: 96,
      },
    });

    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));
    // (Without these an error event has no listener and is thrown: the whole server would go down)
    this.wss.on('error', (e) => console.error('[Socket] server error:', e));
    this.httpServer.on('clientError', (_e, sock) => { try { sock.destroy(); } catch { /* gone */ } });

    // (host: every interface when not given; the VPS listens on 127.0.0.1 only, behind nginx)
    this.httpServer.listen(port, host, () => {
      console.log(`Game server started on ${host ?? '*'}:${port}`);
    });
  }

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const ip = clientAddress(req);
    const open = this.perIp.get(ip) ?? 0;
    if (open >= MAX_SOCKETS_PER_IP) { ws.close(1013, 'Too many connections'); return; }
    this.perIp.set(ip, open + 1);
    // A malformed frame, an oversized message, a reset: ws reports it here, then closes
    ws.on('error', (e) => this.logBad('socket error', e));

    const socket: ClientSocket = {
      isOpen: () => ws.readyState === WebSocket.OPEN,
      send: (data, opts) => {
        // A client that's stopped reading: dropped, rather than its snapshots queued without end
        if (ws.bufferedAmount > MAX_BUFFERED_BYTES) { ws.terminate(); return; }
        if (opts?.raw) ws.send(data, { compress: false });
        else ws.send(data);
      },
      close: () => ws.close(4001, 'Sign-in failed'),
    };

    let link: ReturnType<GameServer['connect']>;
    try {
      link = this.server.connect(socket, ip);
    } catch (e) {
      console.error('[Socket] could not take a connection:', e);
      this.release(ip);
      ws.terminate();
      return;
    }

    // (Inputs on this socket, in order: a compact one says only what changed since the last, CAPS.INPUTS)
    const inputs = new InputDecoder();
    ws.on('message', (data) => {
      try {
        // Handle both binary and JSON messages
        let msg: ClientMessage;
        if (Buffer.isBuffer(data)) {
          // Binary input messages start with their type id
          if (isBinaryMessage(data)) {
            msg = inputs.decode(data);
          } else {
            msg = JSON.parse(data.toString());
          }
        } else {
          msg = JSON.parse(data.toString());
        }
        link.receive(msg);
      } catch (e) {
        this.logBad('could not parse a message', e);
      }
    });

    ws.on('close', () => {
      this.release(ip);
      try {
        link.close();
      } catch (e) {
        console.error('[Socket] error closing a connection:', e);
      }
    });
  }

  private release(ip: string): void {
    const n = (this.perIp.get(ip) ?? 1) - 1;
    if (n > 0) this.perIp.set(ip, n); else this.perIp.delete(ip);
  }

  /** Bad frames are logged a line every 5 s at most (a hostile client could send thousands) */
  private logBad(what: string, e: unknown): void {
    const now = Date.now();
    if (now - this.lastBadLog < 5000) { this.badSince++; return; }
    console.error(`[Socket] ${what}${this.badSince ? ` (and ${this.badSince} more since)` : ''}:`, e instanceof Error ? e.message : e);
    this.lastBadLog = now;
    this.badSince = 0;
  }

  /** Stop taking connections (shutdown); sockets open are left to close with the process */
  stopAccepting(): void {
    this.httpServer.close();
  }

  /** The port it's listening on (tests listen on 0) */
  port(): number {
    const a = this.httpServer.address();
    return typeof a === 'object' && a ? a.port : 0;
  }
}
