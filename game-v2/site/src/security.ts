/**
 * Cookies, CSRF, rate limits, security headers and API tokens.
 *
 * Sessions: the lobby's session token in `sg_session` (HttpOnly, SameSite=Lax,
 * Secure in production). CSRF: every form and fetch that changes something
 * carries a token that is an HMAC of a random per-browser cookie (`sg_csrf`,
 * HttpOnly) under the site's secret; a cross-site page can neither read the
 * cookie nor compute the token. On top of that, a POST whose Origin header
 * names another site is refused. Requests authenticated by an API bearer token
 * (the CLI) carry no cookies, so they need no CSRF token.
 */

import crypto from 'crypto';
import type http from 'http';

export const SESSION_COOKIE = 'sg_session';
export const CSRF_COOKIE = 'sg_csrf';
export const SESSION_MAX_AGE_S = 7 * 24 * 3600;

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || k in out) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* malformed: skip */ }
  }
  return out;
}

export function cookie(name: string, value: string, opts: { maxAge?: number; secure: boolean; httpOnly?: boolean }): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax'];
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  if (opts.secure) parts.push('Secure');
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  return parts.join('; ');
}

export class Csrf {
  constructor(private secret: string) {}

  /** A fresh random value for the CSRF cookie */
  static seed(): string { return crypto.randomBytes(24).toString('base64url'); }

  token(seed: string): string {
    return crypto.createHmac('sha256', this.secret).update(`csrf:${seed}`).digest('base64url');
  }

  verify(seed: string | undefined, given: string | undefined): boolean {
    if (!seed || !given) return false;
    const want = Buffer.from(this.token(seed));
    const got = Buffer.from(given);
    return want.length === got.length && crypto.timingSafeEqual(want, got);
  }
}

/** Is this request's Origin (or Referer) this site, or absent? */
export function sameOrigin(req: http.IncomingMessage, siteOrigin: string): boolean {
  const origin = req.headers.origin ?? (req.headers.referer ? safeOrigin(String(req.headers.referer)) : undefined);
  if (!origin || origin === 'null') return !req.headers.origin; // no Origin at all: old browser or a tool; the CSRF token still applies
  const host = req.headers.host;
  return origin === siteOrigin || (!!host && (origin === `http://${host}` || origin === `https://${host}`));
}

function safeOrigin(url: string): string | undefined {
  try { return new URL(url).origin; } catch { return undefined; }
}

/** Sliding-window limits by key ("comment:42", "signin:1.2.3.4") */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(private clock: () => number = Date.now) {}

  /** Record a hit; false if over `limit` within `windowMs` (the hit is not recorded then) */
  hit(key: string, limit: number, windowMs: number): boolean {
    const now = this.clock();
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (list.length >= limit) { this.hits.set(key, list); return false; }
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 20_000) this.prune(windowMs);
    return true;
  }

  /** Seconds until the next hit would be allowed (0: now) */
  retryAfter(key: string, limit: number, windowMs: number): number {
    const now = this.clock();
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (list.length < limit) return 0;
    return Math.ceil((list[list.length - limit] + windowMs - now) / 1000);
  }

  private prune(windowMs: number): void {
    const now = this.clock();
    for (const [k, list] of this.hits) if (!list.some((t) => now - t < windowMs)) this.hits.delete(k);
    if (this.hits.size > 20_000) this.hits.clear();
  }
}

/** The limits (count per window) */
export const LIMITS = {
  signin: { limit: 8, windowMs: 60_000 },
  register: { limit: 4, windowMs: 10 * 60_000 },
  account: { limit: 8, windowMs: 60_000 },
  comment: { limit: 4, windowMs: 60_000 },
  commentDaily: { limit: 60, windowMs: 24 * 3600_000 },
  suggestion: { limit: 3, windowMs: 10 * 60_000 },
  vote: { limit: 40, windowMs: 60_000 },
  shout: { limit: 5, windowMs: 15_000 },
  shoutMinute: { limit: 12, windowMs: 60_000 },
  api: { limit: 120, windowMs: 60_000 },
  apiAuthFail: { limit: 10, windowMs: 10 * 60_000 },
  upload: { limit: 30, windowMs: 60_000 },
  /** The game server sharing ships, per pilot */
  shipShare: { limit: 20, windowMs: 3600_000 },
  /** Public reads of the catalog and changelog, per address */
  publicApi: { limit: 120, windowMs: 60_000 },
} as const;

/** Headers on every site page (the game page at /play gets its own) */
export function securityHeaders(res: http.ServerResponse, secure: boolean): void {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    // (The fonts are this site's own files: public/fonts)
    "style-src 'self'",
    "font-src 'self'",
    "img-src 'self' data: https:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

// ---------------------------------------------------------------- API tokens

export const TOKEN_PREFIX = 'sgs_';

/** A new admin API token: the token (shown once) and what's kept (its hash and a prefix to tell it by) */
export function newApiToken(): { token: string; hash: string; prefix: string } {
  const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token), prefix: token.slice(0, TOKEN_PREFIX.length + 6) };
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Does the key a caller sent match the configured one? (constant time; an unset key matches nothing) */
export function keyMatches(given: string, expected: string): boolean {
  if (!expected || !given) return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}
