/**
 * The shoutbox: a short live chat for signed-in pilots, pushed to every open
 * page over Server-Sent Events (GET /shoutbox/stream). Posting is a normal POST
 * (CSRF-checked, rate limited); the store keeps only the latest KEEP lines.
 */

import type http from 'http';
import type { Shout, SiteStore } from './store/types.js';

export const SHOUT_MAX = 280;
export const SHOUT_KEEP = 300;
export const SHOUT_HISTORY = 50;
const MAX_CLIENTS = 1000;
const MAX_PER_IP = 8;

/** A shout as sent to browsers */
export function publicShout(s: Shout) {
  return { id: s.id, name: s.authorName, admin: s.isAdmin, text: s.text, at: s.createdAt };
}

/** Clean a line: no control characters, single spaces, trimmed; '' if nothing's left */
export function cleanShout(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();
}

interface Client { res: http.ServerResponse; ip: string }

export class ShoutHub {
  private clients = new Set<Client>();
  private beat: NodeJS.Timeout;

  constructor(private store: SiteStore) {
    // A comment line now and then keeps proxies from closing idle streams
    this.beat = setInterval(() => { for (const c of this.clients) c.res.write(': ping\n\n'); }, 25_000);
    this.beat.unref();
  }

  get size(): number { return this.clients.size; }

  async open(req: http.IncomingMessage, res: http.ServerResponse, ip: string): Promise<void> {
    const fromIp = [...this.clients].filter((c) => c.ip === ip).length;
    if (this.clients.size >= MAX_CLIENTS || fromIp >= MAX_PER_IP) {
      res.writeHead(503, { 'Content-Type': 'text/plain', 'Retry-After': '30' });
      res.end('Too many open streams');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // nginx: don't buffer the stream
    });
    res.write('retry: 4000\n\n');
    const recent = await this.store.recentShouts(SHOUT_HISTORY);
    res.write(`event: history\ndata: ${JSON.stringify(recent.map(publicShout))}\n\n`);
    const client = { res, ip };
    this.clients.add(client);
    req.on('close', () => this.clients.delete(client));
  }

  broadcast(event: 'shout' | 'delete', data: unknown): void {
    const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.clients) c.res.write(line);
  }

  close(): void {
    clearInterval(this.beat);
    for (const c of this.clients) c.res.end();
    this.clients.clear();
  }
}
