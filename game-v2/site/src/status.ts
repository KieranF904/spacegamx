/**
 * The game server's status, from the file it writes every 2 s (data/status/live.json).
 *
 * Today the file has { t, players, ships }. The site also reads, when the game sends them (docs/game-integration.md,
 * section 2): version, protocol, startedAt, tick { ms50, ms99 }, systems [{ id, players }], bosses [{ id, system,
 * state, respawnAt }]. Every field is checked here, and one that is missing or the wrong type is left out, so a page
 * can say "Not reported by the server yet." for that section alone.
 */

import fs from 'fs/promises';

export type BossState = 'up' | 'fighting' | 'down';

export interface ServerStatus {
  /** The file is fresh (the game writes it every 2 s; older than 15 s means the server is down) */
  online: boolean;
  /** ms since epoch of the last write (0: never) */
  at: number;
  players: number;
  ships: number;
  version?: string;
  protocol?: number;
  startedAt?: number;
  tick?: { ms50: number; ms99: number };
  systems?: { id: string; players: number }[];
  bosses?: { id: string; system: string; state: BossState; respawnAt?: number }[];
}

export const STALE_MS = 15_000;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(v);

export function parseStatus(doc: unknown, now = Date.now()): ServerStatus | null {
  if (!doc || typeof doc !== 'object') return null;
  const d = doc as Record<string, unknown>;
  const at = isNum(d.t) ? d.t : 0;
  const online = now - at < STALE_MS;
  const out: ServerStatus = { online, at, players: online && isNum(d.players) ? Math.max(0, Math.round(d.players)) : 0, ships: isNum(d.ships) ? Math.max(0, Math.round(d.ships)) : 0 };
  if (typeof d.version === 'string' && d.version.length <= 40) out.version = d.version;
  if (isNum(d.protocol)) out.protocol = d.protocol;
  if (isNum(d.startedAt) && d.startedAt > 0) out.startedAt = d.startedAt;
  const t = d.tick as Record<string, unknown> | undefined;
  if (t && isNum(t.ms50) && isNum(t.ms99)) out.tick = { ms50: t.ms50, ms99: t.ms99 };
  if (Array.isArray(d.systems)) {
    out.systems = d.systems.filter((s): s is { id: string; players: number } => !!s && isId((s as any).id) && isNum((s as any).players)).slice(0, 100).map((s) => ({ id: s.id, players: Math.max(0, Math.round(s.players)) }));
  }
  if (Array.isArray(d.bosses)) {
    out.bosses = d.bosses
      .filter((b): b is { id: string; system: string; state: BossState; respawnAt?: number } => !!b && isId((b as any).id) && isId((b as any).system) && ['up', 'fighting', 'down'].includes((b as any).state))
      .slice(0, 100)
      .map((b) => ({ id: b.id, system: b.system, state: b.state, ...(isNum(b.respawnAt) && b.respawnAt > 0 ? { respawnAt: b.respawnAt } : {}) }));
  }
  return out;
}

/** Reads and parses the status file (null: no such file, or not JSON) */
export class StatusFile {
  private cache: { at: number; value: ServerStatus | null } | null = null;

  constructor(private file: string, private ttlMs = 2000) {}

  async get(): Promise<ServerStatus | null> {
    if (this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache.value;
    let value: ServerStatus | null = null;
    try { value = parseStatus(JSON.parse(await fs.readFile(this.file, 'utf8'))); } catch { value = null; }
    this.cache = { at: Date.now(), value };
    return value;
  }
}

/** The public JSON: only what the game reported */
export function statusJson(s: ServerStatus | null) {
  if (!s) return { online: false, players: 0 };
  const { at, ...rest } = s;
  return { ...rest, updatedAt: at ? new Date(at).toISOString() : null };
}
