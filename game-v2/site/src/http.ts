/**
 * Small HTTP helpers: bodies (form, JSON, raw), responses, and a router.
 */

import type http from 'http';
import { SafeHtml } from './html.js';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function readBody(req: http.IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > max) { reject(new HttpError(413, 'Too large')); req.resume(); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) { reject(new HttpError(413, 'Too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** A form or JSON body, as string fields (JSON values that aren't strings are kept as is) */
export async function readFields(req: http.IncomingMessage, max = 256 * 1024): Promise<Record<string, any>> {
  const buf = await readBody(req, max);
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  const text = buf.toString('utf-8');
  if (type === 'application/json') {
    if (!text.trim()) return {};
    try {
      const v = JSON.parse(text);
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch { throw new HttpError(400, 'Invalid JSON'); }
  }
  if (type === 'application/x-www-form-urlencoded' || type === '') {
    const out: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(text)) out[k] = v;
    return out;
  }
  throw new HttpError(415, 'Unsupported content type');
}

export function str(v: unknown, max = 10_000): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

export function sendHtml(res: http.ServerResponse, status: number, body: SafeHtml | string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(String(body));
}

export function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

export function redirect(res: http.ServerResponse, to: string, status = 303): void {
  // Only paths on this site
  const safe = /^\/(?![/\\])/.test(to) ? to : '/';
  res.writeHead(status, { Location: safe, 'Cache-Control': 'no-store' });
  res.end();
}

/** A same-site path to go back to after signing in (anything else: home) */
export function safeNext(v: unknown): string {
  const s = typeof v === 'string' ? v : '';
  return /^\/(?![/\\])[^\s]*$/.test(s) && !s.startsWith('/signin') && !s.startsWith('/register') ? s : '/';
}

// ---------------------------------------------------------------- router

export type Params = Record<string, string>;
type Handler<C> = (ctx: C, params: Params) => Promise<void> | void;

interface Route<C> { method: string; parts: string[]; handler: Handler<C> }

export class Router<C> {
  private routes: Route<C>[] = [];

  on(method: string, pattern: string, handler: Handler<C>): this {
    this.routes.push({ method, parts: pattern.split('/').filter(Boolean), handler });
    return this;
  }
  get(p: string, h: Handler<C>) { return this.on('GET', p, h); }
  post(p: string, h: Handler<C>) { return this.on('POST', p, h); }

  match(method: string, pathname: string): { handler: Handler<C>; params: Params } | 'method' | null {
    const segs = pathname.split('/').filter(Boolean);
    let wrongMethod = false;
    for (const r of this.routes) {
      if (r.parts.length !== segs.length) continue;
      const params: Params = {};
      let ok = true;
      for (let i = 0; i < segs.length; i++) {
        const p = r.parts[i];
        let seg: string;
        try { seg = decodeURIComponent(segs[i]); } catch { ok = false; break; }
        if (p.startsWith(':')) params[p.slice(1)] = seg;
        else if (p !== seg) { ok = false; break; }
      }
      if (!ok) continue;
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) { wrongMethod = true; continue; }
      return { handler: r.handler, params };
    }
    return wrongMethod ? 'method' : null;
  }
}
