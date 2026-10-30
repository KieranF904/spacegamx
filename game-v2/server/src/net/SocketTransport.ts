/**
 * SocketTransport - Node HTTP + WebSocket front end for GameServer.
 *
 * Owns everything that used to live in the GameServer constructor: the HTTP
 * server (health check + auth endpoints) and the WebSocket upgrade. Each socket
 * is wrapped as a ClientSocket and its decoded messages go through a ClientLink.
 */

import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { decodeMessage, isBinaryMessage, ClientMessage, ClientSocket } from '@space-game/common';
import type { GameServer } from '../GameServer.js';

export class SocketTransport {
  private httpServer: http.Server;
  private wss: WebSocketServer;

  constructor(private server: GameServer, port: number) {
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

      // Health check endpoint for Fly.io
      if (req.url === '/health' || req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', players: this.server.getPlayerCount() }));
        return;
      }

      // Auth endpoints
      if (req.method === 'POST' && req.url === '/auth/register') {
        this.server.handleHttpAuth(req, res, 'register');
        return;
      }
      if (req.method === 'POST' && req.url === '/auth/login') {
        this.server.handleHttpAuth(req, res, 'login');
        return;
      }
      if (req.method === 'POST' && req.url === '/auth/validate') {
        this.server.handleHttpAuth(req, res, 'validate');
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
      perMessageDeflate: {
        zlibDeflateOptions: { level: 4, memLevel: 6 },
        serverMaxWindowBits: 13,
        clientMaxWindowBits: 11,
        clientNoContextTakeover: true,
        threshold: 96,
      },
    });
    this.wss.on('connection', (ws) => this.handleConnection(ws));

    this.httpServer.listen(port, () => {
      console.log(`Game server started on port ${port}`);
    });
  }

  private handleConnection(ws: WebSocket): void {
    const socket: ClientSocket = {
      isOpen: () => ws.readyState === WebSocket.OPEN,
      send: (data) => ws.send(data),
      close: () => ws.close(4001, 'Sign-in failed'),
    };
    const link = this.server.connect(socket);

    ws.on('message', (data) => {
      try {
        // Handle both binary and JSON messages
        let msg: ClientMessage;
        if (Buffer.isBuffer(data)) {
          // Binary input messages start with their type id
          if (isBinaryMessage(data)) {
            msg = decodeMessage(data) as ClientMessage;
          } else {
            msg = JSON.parse(data.toString());
          }
        } else {
          msg = JSON.parse(data.toString());
        }
        link.receive(msg);
      } catch (e) {
        console.error('Failed to parse message:', e);
      }
    });

    ws.on('close', () => link.close());
  }
}
