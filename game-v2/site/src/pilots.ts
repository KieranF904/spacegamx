/**
 * What the game knows about pilots, read-only: their saved profiles (the pilot
 * card), the rankings, and the live player count.
 *
 * FilePilotSource reads the game server's files (dev, and the VPS, where the
 * site runs beside the game): data/profiles/<userId>.json,
 * data/profiles/_rankings.json and data/status/live.json. A Postgres-backed
 * source (the `profiles` table in server-browser/schema.sql) can implement the
 * same interface when profiles move there.
 */

import fs from 'fs/promises';
import path from 'path';

/** The ranking boards (common/src/econ/ribbons.ts RANKED; copied, so the site doesn't build against the game) */
export const BOARDS: { key: string; label: string; unit?: string }[] = [
  { key: 'kills', label: 'Hostiles destroyed' },
  { key: 'bosses', label: 'Boss kills' },
  { key: 'earned', label: 'Credits earned', unit: 'cr' },
  { key: 'quests', label: 'Jobs done' },
  { key: 'mined', label: 'Ore mined' },
];

export interface PilotCard {
  level: number;
  xp: number;
  credits: number;
  shipName: string | null;
  ships: number;
  stats: { kills: number; bosses: number; quests: number; mined: number; earned: number; crafted: number; deaths: number };
  systemsVisited: number;
  ribbons: number;
  /** Ids of the ribbons earned (names are in the catalog) */
  ribbonIds: string[];
  /** Bosses beaten, by id (stats boss:<id>) */
  bossKills: Record<string, number>;
  since: string | null;
  lastFlown: string | null;
}

export interface RankRow { userId: string; name: string; value: number }
export interface Rankings { week: number; weekly: Record<string, RankRow[]>; allTime: Record<string, RankRow[]> }
export interface LiveStatus { players: number; ships: number; at: number; fresh: boolean }

export interface PilotSource {
  card(userId: number): Promise<PilotCard | null>;
  rankings(): Promise<Rankings | null>;
  live(): Promise<LiveStatus | null>;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** A saved profile (PlayerProfile, any version) to a pilot card: only what's shown, tolerant of missing fields */
export function toCard(p: any): PilotCard {
  const stats = (p?.stats && typeof p.stats === 'object') ? p.stats as Record<string, unknown> : {};
  const bossKills: Record<string, number> = {};
  let systems = 0, ribbons = 0;
  const ribbonIds: string[] = [];
  for (const [k, v] of Object.entries(stats)) {
    if (k.startsWith('boss:')) bossKills[k.slice(5)] = num(v);
    else if (k.startsWith('sys:')) systems++;
    else if (k.startsWith('ach:') && num(v) > 0) { ribbons++; ribbonIds.push(k.slice(4)); }
  }
  const hangar = Array.isArray(p?.hangar) ? p.hangar.filter(Boolean) : [];
  const name = p?.ship?.blueprint?.name;
  return {
    level: Math.max(1, num(p?.level)),
    xp: num(p?.xp),
    credits: num(p?.credits),
    shipName: typeof name === 'string' && name.trim() ? name.trim().slice(0, 40) : null,
    ships: hangar.length || (p?.ship ? 1 : 0),
    stats: {
      kills: num(stats.kills), bosses: num(stats.bosses), quests: num(stats.quests), mined: num(stats.mined),
      earned: num(stats.earned), crafted: num(stats.crafted), deaths: num(stats.deaths),
    },
    systemsVisited: systems,
    ribbons,
    ribbonIds,
    bossKills,
    since: typeof p?.createdAt === 'string' ? p.createdAt : null,
    lastFlown: typeof p?.updatedAt === 'string' ? p.updatedAt : null,
  };
}

/** The game's rankings document to sorted boards (top `top` of each) */
export function toRankings(doc: any, top = 10): Rankings | null {
  if (!doc || typeof doc !== 'object' || !doc.allTime) return null;
  const boards = (src: Record<string, { name: string; v: Record<string, number> }>) => {
    const out: Record<string, RankRow[]> = {};
    for (const b of BOARDS) {
      out[b.key] = Object.entries(src ?? {})
        .map(([userId, e]) => ({ userId, name: String(e?.name ?? '?'), value: Math.round(num(e?.v?.[b.key])) }))
        .filter((r) => r.value > 0)
        .sort((a, b2) => b2.value - a.value || a.name.localeCompare(b2.name))
        .slice(0, top);
    }
    return out;
  };
  return { week: num(doc.week), weekly: boards(doc.weekly), allTime: boards(doc.allTime) };
}

export class FilePilotSource implements PilotSource {
  private cache = new Map<string, { at: number; value: unknown }>();

  constructor(private profilesDir: string, private statusFile: string, private ttlMs = 5000) {}

  private async readJson(file: string): Promise<unknown | null> {
    const hit = this.cache.get(file);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value;
    let value: unknown = null;
    try { value = JSON.parse(await fs.readFile(file, 'utf-8')); } catch { value = null; }
    this.cache.set(file, { at: Date.now(), value });
    if (this.cache.size > 2000) this.cache.clear();
    return value;
  }

  async card(userId: number): Promise<PilotCard | null> {
    if (!Number.isInteger(userId) || userId <= 0) return null;
    const doc = await this.readJson(path.join(this.profilesDir, `${userId}.json`));
    return doc ? toCard(doc) : null;
  }

  async rankings(): Promise<Rankings | null> {
    return toRankings(await this.readJson(path.join(this.profilesDir, '_rankings.json')));
  }

  async live(): Promise<LiveStatus | null> {
    const s = await this.readJson(this.statusFile) as { players?: number; ships?: number; t?: number } | null;
    if (!s) return null;
    const at = num(s.t);
    // The game writes it every 2 s: older than 15 s, the server is down
    const fresh = Date.now() - at < 15_000;
    return { players: fresh ? num(s.players) : 0, ships: num(s.ships), at, fresh };
  }
}
