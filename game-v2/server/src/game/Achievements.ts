/**
 * Ribbons, rankings and galaxy news: the long game, and the bits of it worth
 * telling everyone about.
 *
 *   Ribbons   milestones from data/achievements.json (kills, bosses, ore, jobs,
 *             fleet ops, systems visited, level...). Earned the moment the stat
 *             gets there, with a reward; rare ones make the news. Kept in the
 *             profile's stats as ach:<id> (and visited systems as sys:<id>).
 *   Rankings  weekly and all-time boards of the RANKED stats, for registered
 *             pilots, saved as a game-wide document in the profile store.
 *   News      a galaxy-wide feed: boss kills, fleet ops, levels, rare ribbons,
 *             the week's hunt. New arrivals hear the last few.
 */

import {
  ServerMessage, RibbonDef, RibbonsFile, ribbonValue, ribbonKey, weekOf, weekEndsIn, RANKED, RankRow,
} from '@space-game/common';
import type { Pilots, PilotConn, PilotEvent } from './Pilots.js';
import type { ProfileStore } from '../profile/ProfileStore.js';

/** The rankings document in the profile store */
export const RANKINGS_DOC = 'rankings';
const NEWS_KEEP = 12;

export interface AchievementsHost {
  send(conn: PilotConn, msg: ServerMessage): void;
  /** Everyone online */
  broadcast(msg: ServerMessage): void;
  now(): number;
}

interface Board { name: string; v: Record<string, number> }
interface RankingsDoc { week: number; weekly: Record<string, Board>; allTime: Record<string, Board> }

export class Achievements {
  readonly defs: RibbonDef[];
  private news: { text: string; kind: string; at: number }[] = [];
  private ranks: RankingsDoc;
  private ranksDirty = false;
  private lastSave = 0;

  constructor(private host: AchievementsHost, private pilots: Pilots, file: RibbonsFile | undefined, private store: ProfileStore) {
    this.defs = file?.ribbons ?? [];
    this.ranks = { week: weekOf(host.now()), weekly: {}, allTime: {} };
    void this.load();
    pilots.onEvent((conn, ev) => this.onEvent(conn, ev));
  }

  private async load(): Promise<void> {
    try {
      const doc = (await this.store.loadDoc(RANKINGS_DOC)) as RankingsDoc | null;
      if (doc && typeof doc === 'object' && doc.weekly && doc.allTime) {
        this.ranks = { week: doc.week, weekly: doc.weekly, allTime: { ...doc.allTime, ...this.ranks.allTime } };
        for (const [k, b] of Object.entries(this.ranks.weekly)) if (!doc.weekly[k]) this.ranks.weekly[k] = b;
      }
    } catch (e) {
      console.error('[Achievements] could not load rankings:', e);
    }
  }

  // ---------------------------------------------------------------------------
  // News
  // ---------------------------------------------------------------------------

  post(text: string, kind: 'boss' | 'fleet' | 'level' | 'ribbon' | 'hunt' | 'info'): void {
    const now = this.host.now();
    // The same story from several pilots at once (a party finishing together) is told once
    if (this.news.some((n) => n.text === text && now - n.at < 15000)) return;
    this.news.push({ text, kind, at: now });
    if (this.news.length > NEWS_KEEP) this.news.shift();
    this.host.broadcast({ type: 'news', text, kind, at: now });
  }

  /** A pilot arrived: the latest news */
  catchUp(conn: PilotConn): void {
    for (const n of this.news.slice(-5)) this.host.send(conn, { type: 'news', text: n.text, kind: n.kind as never, at: n.at, old: true });
  }

  // ---------------------------------------------------------------------------
  // Ribbons
  // ---------------------------------------------------------------------------

  private onEvent(conn: PilotConn, ev: PilotEvent): void {
    if (ev.type === 'stat') {
      this.rank(conn, ev.key, ev.n);
      this.check(conn);
    } else if (ev.type === 'level') {
      const p = this.pilots.get(conn);
      if (p && ev.level % 10 === 0) this.post(`${conn.username} reached pilot level ${ev.level}`, 'level');
      this.check(conn);
    } else if (ev.type === 'login') {
      this.check(conn, true);
      this.catchUp(conn);
      this.seed(conn);
    }
  }

  /** A pilot is in a system (a new one counts towards Explorer) */
  visit(conn: PilotConn, systemId: string): void {
    const p = this.pilots.get(conn);
    if (!p || !systemId || p.stats[`sys:${systemId}`]) return;
    p.stats[`sys:${systemId}`] = 1;
    this.pilots.markDirty(conn);
    this.check(conn);
  }

  /** Grant every ribbon whose stat has got there (on login: ones earned before ribbons existed, quietly) */
  check(conn: PilotConn, quiet = false): void {
    const p = this.pilots.get(conn);
    if (!p) return;
    for (const d of this.defs) {
      if (p.stats[ribbonKey(d.id)]) continue;
      if (ribbonValue(d, p.stats, p.level) < d.at) continue;
      p.stats[ribbonKey(d.id)] = Math.floor(this.host.now() / 1000);
      this.pilots.markDirty(conn);
      const credits = d.reward.credits ?? 0, xp = d.reward.xp ?? 0;
      if (credits) this.pilots.addCredits(conn, credits);
      if (xp) this.pilots.addXp(conn, xp);
      this.host.send(conn, { type: 'ribbon', id: d.id, credits, xp });
      if (d.rare && !quiet) this.post(`${conn.username} earned the ${d.name} ribbon ${d.icon}`, 'ribbon');
    }
  }

  /** The Ribbons tab */
  progress(conn: PilotConn): void {
    const p = this.pilots.get(conn);
    if (!p) return;
    this.host.send(conn, {
      type: 'ribbons',
      progress: this.defs.map((d) => ({ id: d.id, value: Math.min(d.at, ribbonValue(d, p.stats, p.level)), earned: !!p.stats[ribbonKey(d.id)] })),
    });
  }

  /** A pilot's ribbons: how many, and the rarest */
  summary(conn: PilotConn): { count: number; top?: string } {
    const p = this.pilots.get(conn);
    if (!p) return { count: 0 };
    const earned = this.defs.filter((d) => p.stats[ribbonKey(d.id)]);
    const top = [...earned].reverse().find((d) => d.rare) ?? earned[earned.length - 1];
    return { count: earned.length, top: top ? `${top.icon} ${top.name}` : undefined };
  }

  // ---------------------------------------------------------------------------
  // Rankings
  // ---------------------------------------------------------------------------

  private rank(conn: PilotConn, key: string, n: number): void {
    if (conn.userId === null || !RANKED.some((r) => r.key === key)) return;
    const p = this.pilots.get(conn);
    if (!p) return;
    this.roll();
    const id = String(conn.userId);
    const w = (this.ranks.weekly[id] ??= { name: conn.username, v: {} });
    w.name = conn.username;
    w.v[key] = (w.v[key] ?? 0) + n;
    const a = (this.ranks.allTime[id] ??= { name: conn.username, v: {} });
    a.name = conn.username;
    a.v[key] = p.stats[key] ?? 0;
    this.ranksDirty = true;
  }

  /** A registered pilot logs in: their all-time totals go on the boards (from before rankings existed, too) */
  private seed(conn: PilotConn): void {
    const p = this.pilots.get(conn);
    if (conn.userId === null || !p) return;
    const v: Record<string, number> = {};
    for (const r of RANKED) if (p.stats[r.key]) v[r.key] = p.stats[r.key];
    if (!Object.keys(v).length) return;
    this.ranks.allTime[String(conn.userId)] = { name: conn.username, v };
    this.ranksDirty = true;
  }

  /** The account was deleted: off the boards */
  forget(userId: number): void {
    const id = String(userId);
    if (!(id in this.ranks.weekly) && !(id in this.ranks.allTime)) return;
    delete this.ranks.weekly[id];
    delete this.ranks.allTime[id];
    this.ranksDirty = true;
  }

  /** A new week: the weekly boards start again */
  private roll(): void {
    const week = weekOf(this.host.now());
    if (week !== this.ranks.week) {
      this.ranks.week = week;
      this.ranks.weekly = {};
      this.ranksDirty = true;
    }
  }

  rankings(conn: PilotConn): void {
    this.roll();
    const id = conn.userId === null ? null : String(conn.userId);
    const top = (boards: Record<string, Board>, key: string): { rows: RankRow[]; you: number; rank: number } => {
      const all = Object.entries(boards).filter(([, b]) => (b.v[key] ?? 0) > 0).sort((x, y) => (y[1].v[key] ?? 0) - (x[1].v[key] ?? 0));
      const i = id ? all.findIndex(([k]) => k === id) : -1;
      return { rows: all.slice(0, 10).map(([, b]) => ({ name: b.name, value: Math.round(b.v[key] ?? 0) })), you: i >= 0 ? all[i][1].v[key] ?? 0 : 0, rank: i + 1 };
    };
    this.host.send(conn, {
      type: 'rankings', weekEndsIn: weekEndsIn(this.host.now()),
      boards: RANKED.map((r) => {
        const w = top(this.ranks.weekly, r.key), a = top(this.ranks.allTime, r.key);
        return { key: r.key, label: r.label, weekly: w.rows, allTime: a.rows, you: id ? { weekly: Math.round(w.you), allTime: Math.round(a.you), weeklyRank: w.rank, allTimeRank: a.rank } : undefined };
      }),
    });
  }

  /** Now and then (and at shutdown): save the boards */
  async save(force = false): Promise<void> {
    const now = this.host.now();
    if (!this.ranksDirty || (!force && now - this.lastSave < 60_000)) return;
    this.ranksDirty = false;
    this.lastSave = now;
    try {
      await this.store.saveDoc(RANKINGS_DOC, this.ranks);
    } catch (e) {
      this.ranksDirty = true; // (tried again next time)
      console.error('[Achievements] could not save rankings:', e);
    }
  }
}
