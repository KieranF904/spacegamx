// Small HTTP helpers for the shipgen page: JSON replies, bounded request bodies, files served only from inside a root.
import type { IncomingMessage, ServerResponse } from 'http';
import { existsSync, readFileSync, statSync } from 'fs';
import { extname, resolve, sep } from 'path';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(s);
}

export async function readJson<T = any>(req: IncomingMessage, limit = 4 << 20): Promise<T> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > limit) throw new HttpError(413, 'request body too large');
    chunks.push(c as Buffer);
  }
  const s = Buffer.concat(chunks).toString('utf8');
  if (!s.trim()) return {} as T;
  try { return JSON.parse(s) as T; } catch { throw new HttpError(400, 'body is not JSON'); }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
};

/** The file at `rel` under `root`, or null when it is outside it or missing */
export function inside(root: string, rel: string): string | null {
  let clean: string;
  try { clean = decodeURIComponent(rel); } catch { return null; }
  if (clean.includes('\0')) return null;
  const base = resolve(root);
  const p = resolve(base, '.' + sep + clean.replace(/^[/\\]+/, ''));
  if (p !== base && !p.startsWith(base + sep)) return null;
  return existsSync(p) && statSync(p).isFile() ? p : null;
}

export function sendFile(res: ServerResponse, root: string, rel: string): boolean {
  const p = inside(root, rel);
  if (!p) return false;
  res.writeHead(200, { 'Content-Type': MIME[extname(p).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
  res.end(readFileSync(p));
  return true;
}
