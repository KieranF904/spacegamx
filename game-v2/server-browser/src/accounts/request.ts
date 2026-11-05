/**
 * Reading requests safely: a size-limited JSON body, and the caller's address.
 */

import http from 'http';

/** Largest JSON body accepted (every endpoint's bodies are tiny) */
export const MAX_BODY_BYTES = 64 * 1024;

/** A body that couldn't be read: `status` is what to answer (400 bad JSON, 413 too large) */
export class BodyError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/**
 * The JSON object in a request body ({} when empty). Rejects with a BodyError past `limit` bytes (the rest
 * of the body is read and dropped, never kept), for JSON that isn't an object, or when the client goes away.
 */
export function readJson(req: http.IncomingMessage, limit = MAX_BODY_BYTES): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    let done = false;
    const fail = (err: BodyError) => { if (!done) { done = true; reject(err); } };
    if (Number(req.headers['content-length']) > limit) { fail(new BodyError('Request body too large', 413)); req.resume(); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) { chunks.length = 0; fail(new BodyError('Request body too large', 413)); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) { done = true; resolve({}); return; }
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { fail(new BodyError('Invalid JSON', 400)); return; }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { fail(new BodyError('Expected a JSON object', 400)); return; }
      done = true;
      resolve(parsed as Record<string, any>);
    });
    req.on('error', () => fail(new BodyError('Request aborted', 400)));
    req.on('close', () => fail(new BodyError('Request aborted', 400)));
  });
}

function isLoopback(ip: string): boolean {
  return ip === '::1' || ip.startsWith('127.') || ip.startsWith('::ffff:127.');
}

/**
 * The caller's address. X-Forwarded-For is only believed from this machine (nginx, the website): anyone
 * else could write any address there to dodge the sign-in limits. nginx and the website each set it to
 * the one address they saw, so the last entry is the one a trusted proxy wrote.
 */
export function clientIp(req: http.IncomingMessage): string {
  const socketIp = req.socket?.remoteAddress || '';
  const xff = req.headers['x-forwarded-for'];
  if (xff && isLoopback(socketIp)) {
    const parts = String(xff).split(',');
    const last = parts[parts.length - 1].trim();
    if (last) return last;
  }
  return socketIp;
}
