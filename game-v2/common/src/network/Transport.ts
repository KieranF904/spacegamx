/**
 * Transport interfaces
 *
 * The simulation never knows which transport is in use. The client talks to a
 * ClientTransport (WebSocket in normal play, LocalTransport in proto mode), and
 * the server writes to a ClientSocket per connection.
 */

import type { ClientMessage, ServerMessage } from './protocol.js';

/** Why a client transport went down, and whether it will try again by itself */
export interface DisconnectInfo {
  /** WebSocket close code (4001: sign-in refused, 4002: protocol mismatch) */
  code?: number;
  reason?: string;
  /** A reconnect is scheduled (in `retryInMs`, attempt `attempt` of `maxAttempts`) */
  retrying?: boolean;
  retryInMs?: number;
  attempt?: number;
  maxAttempts?: number;
}

/** Client side: what Game.ts needs to talk to a server. */
export interface ClientTransport {
  onConnect: (() => void) | null;
  onDisconnect: ((info?: DisconnectInfo) => void) | null;
  onMessage: ((msg: ServerMessage) => void) | null;
  connect(url: string): void;
  disconnect(): void;
  send(msg: ClientMessage): void;
  isConnected(): boolean;
}

/** Server side: one connected client, as seen by GameServer. */
export interface ClientSocket {
  isOpen(): boolean;
  /** An encoded frame (serverFrame) */
  send(data: string | ArrayBuffer | Uint8Array): void;
  /** Hang up (a failed sign-in: code 4001; another protocol version: PROTOCOL_MISMATCH_CLOSE, 'version') */
  close?(code?: number, reason?: string): void;
}

/** Returned by GameServer.connect(): how a transport feeds a client's messages in. */
export interface ClientLink {
  receive(msg: ClientMessage): void;
  close(): void;
}
