/**
 * The game servers' heartbeat (POST /register): what one says about itself, checked and bounded before
 * it goes in the list (the list page writes these into HTML, and the list must not grow without end).
 */

export interface ServerEntry {
  host: string;
  port: number;
  name: string;
  region: string;
  maxPlayers: number;
  players: number;
  secure: boolean;
  version: string;
  lastSeen: number;
  adminPort?: number;
}

/** Most servers listed at once (a heartbeat from a new one past this is refused until some go stale) */
export const MAX_SERVERS = 200;

/** A hostname, IPv4 or IPv6 address: nothing that could break out of the page's HTML or script */
const HOST = /^[A-Za-z0-9._:[\]-]{1,253}$/;

function port(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

function count(v: unknown, fallback: number): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(100_000, Math.max(0, n)) : fallback;
}

function text(v: unknown, fallback: string, max: number): string {
  const s = v === undefined || v === null || v === '' ? fallback : String(v);
  return s.slice(0, max);
}

/** The entry a heartbeat describes (lastSeen left to the caller), or why it's refused */
export function parseHeartbeat(body: Record<string, any>, fromIp: string): Omit<ServerEntry, 'lastSeen'> | { error: string } {
  const host = String(body.host || fromIp);
  if (!HOST.test(host)) return { error: 'Invalid host' };
  const p = port(body.port || 3000);
  if (p === null) return { error: 'Invalid port' };
  const adminPort = body.adminPort ? port(body.adminPort) : undefined;
  if (adminPort === null) return { error: 'Invalid adminPort' };
  return {
    host,
    port: p,
    name: text(body.name, 'Game Server', 64),
    region: text(body.region, 'unknown', 32),
    maxPlayers: count(body.maxPlayers || 32, 32),
    players: count(body.players, 0),
    secure: Boolean(body.secure),
    version: text(body.version, '1.0.0', 32),
    adminPort,
  };
}
