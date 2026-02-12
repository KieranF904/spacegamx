/**
 * Network Manager - WebSocket connection handling
 */

import {
  ClientMessage,
  ServerMessage,
  encodeMessage,
  decodeMessage,
} from '@space-game/common';

export class NetworkManager {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 2000;
  
  public onConnect: (() => void) | null = null;
  public onDisconnect: (() => void) | null = null;
  public onMessage: ((msg: ServerMessage) => void) | null = null;

  connect(url: string): void {
    console.log('Connecting to', url);
    
    try {
      this.ws = new WebSocket(url);
      this.ws.binaryType = 'arraybuffer'; // Enable binary message handling
      
      this.ws.onopen = () => {
        console.log('WebSocket connected');
        this.reconnectAttempts = 0;
        this.onConnect?.();
      };
      
      this.ws.onclose = () => {
        console.log('WebSocket closed');
        this.ws = null;
        this.onDisconnect?.();
        
        // Attempt reconnect
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          console.log(`Reconnecting in ${this.reconnectDelay}ms (attempt ${this.reconnectAttempts})`);
          setTimeout(() => this.connect(url), this.reconnectDelay);
        }
      };
      
      this.ws.onerror = (err) => {
        console.error('WebSocket error:', err);
      };
      
      this.ws.onmessage = (event) => {
        try {
          // Handle both binary (ArrayBuffer) and text (string) messages
          const msg = decodeMessage(event.data) as ServerMessage;
          this.onMessage?.(msg);
        } catch (e) {
          console.error('Failed to parse message:', e);
        }
      };
    } catch (e) {
      console.error('Failed to connect:', e);
    }
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(encodeMessage(msg));
    }
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}
