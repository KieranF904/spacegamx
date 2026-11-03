/**
 * Network Manager - WebSocket connection handling
 */

import {
  ClientMessage,
  ServerMessage,
  encodeMessage,
  decodeServerFrame,
  ClientTransport,
  DisconnectInfo,
  PROTOCOL_MISMATCH_CLOSE,
} from '@space-game/common';

/** Waits before each reconnect attempt (ms): backs off, then gives up */
const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 15000, 15000];

export class NetworkManager implements ClientTransport {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  public onConnect: (() => void) | null = null;
  public onDisconnect: ((info?: DisconnectInfo) => void) | null = null;
  public onMessage: ((msg: ServerMessage) => void) | null = null;
  /** After the last message of each frame (client-detected hits: ShipClient.frameEnd) */
  public onFrameEnd: (() => void) | null = null;
  /** Traffic counters (bytes and frames each way), for the network readout */
  readonly traffic = { bytesIn: 0, bytesOut: 0, framesIn: 0, framesOut: 0 };

  /** Hung up on purpose (or the server refused the sign-in): don't reconnect */
  private closing = false;
  /** Message types that failed to handle, each logged once */
  private failedTypes = new Set<string>();

  connect(url: string): void {
    this.connectSocket(url, false);
  }

  private connectSocket(url: string, retry: boolean): void {
    console.log('Connecting to', url);
    this.closing = false;
    this.cancelRetry();
    if (!retry) this.reconnectAttempts = 0;
    // A new connection replaces the old one: nothing from the old socket reaches the game again
    this.dropSocket();

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      console.error('Failed to connect:', e);
      this.scheduleRetry(url, undefined, undefined);
      return;
    }
    this.ws = ws;
    ws.binaryType = 'arraybuffer'; // Enable binary message handling

    ws.onopen = () => {
      if (this.ws !== ws) return;
      console.log('WebSocket connected');
      this.reconnectAttempts = 0;
      this.onConnect?.();
    };

    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      console.log('WebSocket closed', ev.code, ev.reason);
      this.ws = null;
      // Not after hanging up on purpose, a refused sign-in (4001) or a client on another protocol version (4002)
      if (this.closing || ev.code === 4001 || ev.code === PROTOCOL_MISMATCH_CLOSE) {
        this.onDisconnect?.({ code: ev.code, reason: ev.reason, retrying: false });
        return;
      }
      this.scheduleRetry(url, ev.code, ev.reason);
    };

    ws.onerror = (err) => {
      if (this.ws === ws) console.error('WebSocket error:', err);
    };

    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      // Handle both binary (ArrayBuffer) and text (string) messages
      // A frame may carry one message or a tick's worth
      this.traffic.framesIn++;
      this.traffic.bytesIn += typeof event.data === 'string' ? event.data.length : (event.data as ArrayBuffer).byteLength;
      let msgs: ServerMessage[];
      try {
        msgs = decodeServerFrame(event.data);
      } catch (e) {
        this.logOnce('(undecodable frame)', e);
        return;
      }
      // One message failing doesn't lose the rest of the frame (the tick's snapshot among them)
      for (const msg of msgs) {
        try {
          this.onMessage?.(msg);
        } catch (e) {
          this.logOnce(typeof msg?.type === 'string' ? msg.type : '(no type)', e);
        }
      }
      try {
        this.onFrameEnd?.();
      } catch (e) {
        this.logOnce('(frame end)', e);
      }
    };
  }

  /** Try again after a back-off, or report the connection lost for good */
  private scheduleRetry(url: string, code: number | undefined, reason: string | undefined): void {
    if (this.reconnectAttempts >= RECONNECT_DELAYS.length) {
      this.onDisconnect?.({ code, reason, retrying: false });
      return;
    }
    const delay = RECONNECT_DELAYS[this.reconnectAttempts];
    this.reconnectAttempts++;
    console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${RECONNECT_DELAYS.length})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectSocket(url, true);
    }, delay);
    this.onDisconnect?.({ code, reason, retrying: true, retryInMs: delay, attempt: this.reconnectAttempts, maxAttempts: RECONNECT_DELAYS.length });
  }

  private cancelRetry(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  /** Abandon the current socket: its handlers go, then it's closed */
  private dropSocket(): void {
    const ws = this.ws;
    if (!ws) return;
    this.ws = null;
    ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
    try { ws.close(); } catch { /* already closed */ }
  }

  private logOnce(type: string, e: unknown): void {
    if (this.failedTypes.has(type)) return;
    this.failedTypes.add(type);
    console.error(`Failed to handle server message '${type}' (further failures of this type aren't logged):`, e);
  }

  disconnect(): void {
    this.closing = true;
    this.cancelRetry();
    this.dropSocket();
  }

  send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const data = encodeMessage(msg);
      this.traffic.framesOut++;
      this.traffic.bytesOut += typeof data === 'string' ? data.length : data.byteLength;
      this.ws.send(data);
    }
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}
