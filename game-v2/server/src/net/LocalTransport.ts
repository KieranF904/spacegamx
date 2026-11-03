/**
 * LocalTransport - in-process, zero-latency transport for proto mode.
 *
 * Implements the same ClientTransport interface as the client's WebSocket
 * NetworkManager. Messages go through the real encode/decode path so the
 * wire format stays exercised, but delivery is synchronous.
 */

import {
  ClientMessage,
  ClientSocket,
  ClientLink,
  ClientTransport,
  ServerMessage,
  encodeMessage,
  decodeMessage,
  decodeServerFrame,
} from '@space-game/common';
import type { GameServer } from '../GameServer.js';

export class LocalTransport implements ClientTransport {
  public onConnect: (() => void) | null = null;
  public onDisconnect: (() => void) | null = null;
  public onMessage: ((msg: ServerMessage) => void) | null = null;
  public onFrameEnd: (() => void) | null = null;

  private link: ClientLink | null = null;
  private open = false;
  private readonly socket: ClientSocket = {
    isOpen: () => this.open,
    send: (data) => { for (const m of decodeServerFrame(data)) this.onMessage?.(m); this.onFrameEnd?.(); },
  };

  constructor(private server: GameServer) {}

  /** The url is ignored; there is only one server. */
  connect(_url = 'local'): void {
    this.open = true;
    this.link = this.server.connect(this.socket);
    this.onConnect?.();
  }

  disconnect(): void {
    if (!this.link) return;
    this.link.close();
    this.link = null;
    this.open = false;
    this.onDisconnect?.();
  }

  send(msg: ClientMessage): void {
    this.link?.receive(decodeMessage(encodeMessage(msg)) as ClientMessage);
  }

  isConnected(): boolean {
    return this.open;
  }

  /** Proto-only: the player entity this transport controls. */
  getPlayerId(): number {
    return this.server.getPlayerId(this.socket);
  }
}
