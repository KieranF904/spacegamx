/**
 * Outgoing messages: each client's outbox (one frame per client per tick, or straight after one of its requests),
 * the effects that can wait for the next frame (lazy), the broadcasts to a system or to the clients near a point, and
 * the byte counters the admin dashboard reads. Moved verbatim from GameServer, which keeps one-line delegates
 * (send, flushOutbox, flushLazy, broadcastToSystem, broadcastProjectileHit, broadcastNear) and bumps `batching`
 * around a tick or a request.
 *
 * Per-tick path: no closures or objects beyond what the moved bodies already made; the host's pieces are plain fields.
 */
import { hasComponent, type IWorld } from 'bitecs';
import { InSystem, Player, Position, encodeServerMessage, serverFrame, type ClientSocket, type ServerMessage } from '@space-game/common';
import type { ClientConnection } from '../ClientConnection.js';
import { LAZY_TYPES, LAZY_TICKS, FX_RANGE } from './constants.js';

/** What the outbox needs of the server (GameServer itself) */
export interface OutboxHost {
  readonly world: IWorld;
  readonly clients: ReadonlyMap<ClientSocket, ClientConnection>;
  readonly currentTick: number;
}

export class Outbox {
  private readonly world: IWorld;
  private readonly clients: ReadonlyMap<ClientSocket, ClientConnection>;
  private readonly host: OutboxHost;
  /** Bytes sent since the admin dashboard last asked, all told and by message type (it resets them) */
  snapshotBytesSent = 0;
  bytesByType: Record<string, number> = {};

  constructor(host: OutboxHost) {
    this.world = host.world;
    this.clients = host.clients;
    this.host = host;
  }

  private get currentTick(): number {
    return this.host.currentTick;
  }

  /** Get byte length of encoded message (string or ArrayBuffer) */
  private getMessageByteLength(data: string | ArrayBuffer | Uint8Array): number {
    if (typeof data === 'string') {
      return data.length; // Approximation for ASCII/UTF-8 JSON
    }
    return data.byteLength;
  }

  /**
   * Messages for a client wait in its outbox and go out together, one frame per
   * tick (or straight after handling one of its requests), instead of a frame each.
   */
  readonly outbox = new Map<ClientSocket, Uint8Array[]>();
  /** Inside a tick or a request: messages wait for the flush (outside, e.g. timers, they go at once) */
  batching = 0;

  /**
   * Effects only for the eye and ear (hit sparks, damage numbers, parts blowing
   * off, bumps) needn't have a frame of their own: they wait (up to LAZY_TICKS)
   * to go with the next frame a client gets anyway, usually a snapshot. Saves
   * a packet's headers each time, for a delay of a tick or two.
   */
  readonly lazy = new Map<ClientSocket, { since: number; parts: Uint8Array[] }>();

  send(ws: ClientSocket, msg: ServerMessage): void {
    if (ws.isOpen()) {
      const data = encodeServerMessage(msg);
      const byteLen = data.length;
      this.snapshotBytesSent += byteLen;
      this.bytesByType[msg.type] = (this.bytesByType[msg.type] || 0) + byteLen;
      // Pongs go at once: they measure the round trip
      if (msg.type === 'pong') { ws.send(serverFrame([data])); return; }
      this.queue(ws, data, LAZY_TYPES.has(msg.type));
    }
  }

  private queue(ws: ClientSocket, data: Uint8Array, lazy = false): void {
    if (!this.batching) { ws.send(serverFrame([data])); return; }
    if (lazy) {
      const l = this.lazy.get(ws);
      if (l) l.parts.push(data); else this.lazy.set(ws, { since: this.currentTick, parts: [data] });
      return;
    }
    const box = this.outbox.get(ws);
    if (box) box.push(data); else this.outbox.set(ws, [data]);
  }

  /** Send everything waiting: one frame per client (effects that can wait, wait: see lazy) */
  flushOutbox(): void {
    for (const [ws, box] of this.outbox) {
      const l = this.lazy.get(ws);
      if (l) this.lazy.delete(ws);
      if (ws.isOpen() && box.length) ws.send(serverFrame(l ? [...l.parts, ...box] : box));
    }
    this.outbox.clear();
    for (const [ws, l] of this.lazy) {
      if (!ws.isOpen()) { this.lazy.delete(ws); continue; }
      if (this.currentTick - l.since >= LAZY_TICKS) { ws.send(serverFrame(l.parts)); this.lazy.delete(ws); }
    }
  }

  /** Send the effects still waiting now (tests that look at a tick's messages straight after it) */
  flushLazy(): void {
    for (const [ws, l] of this.lazy) if (ws.isOpen()) ws.send(serverFrame(l.parts));
    this.lazy.clear();
  }

  broadcastToSystem(systemId: number, msg: ServerMessage): void {
    const data = encodeServerMessage(msg);
    const byteLen = this.getMessageByteLength(data);
    let sent = 0;
    for (const client of this.clients.values()) {
      // (System first: the cheapest check, and it rules out most)
      if (InSystem.systemId[client.playerId] !== systemId) continue;
      if (!client.ws.isOpen() || !hasComponent(this.world, Player, client.playerId)) continue;
      
      this.queue(client.ws, data, LAZY_TYPES.has(msg.type));
      sent++;
    }
    const total = byteLen * sent;
    this.snapshotBytesSent += total;
    this.bytesByType[msg.type] = (this.bytesByType[msg.type] || 0) + total;
  }

  broadcastProjectileHit(proj: number, x: number, y: number): void {
    this.broadcastNear(InSystem.systemId[proj], x, y, { type: 'projectileHit', id: proj, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 });
  }

  /** Clients in a system near a point (combat effects: nobody further out has the ships involved) */
  broadcastNear(systemId: number, x: number, y: number, msg: ServerMessage, also: number[] = []): void {
    const data = encodeServerMessage(msg);
    for (const client of this.clients.values()) {
      if (InSystem.systemId[client.playerId] !== systemId) continue;
      if (!client.ws.isOpen() || !hasComponent(this.world, Player, client.playerId)) continue;
      const pid = client.playerId;
      if (Math.hypot(Position.x[pid] - x, Position.y[pid] - y) > FX_RANGE && !also.includes(pid)) continue;
      this.queue(client.ws, data, LAZY_TYPES.has(msg.type));
      this.snapshotBytesSent += this.getMessageByteLength(data);
    }
  }
}
