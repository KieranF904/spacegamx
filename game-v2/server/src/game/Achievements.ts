/**
 * Ribbons, rankings and galaxy news: the long game, and the bits of it worth
 * telling everyone about.
 *
 *   Ribbons   milestones from data/achievements.json (kills, bosses, ore, jobs,
 *             fleet ops, systems visited, level...). Earned the moment the stat
 *             gets there, with a reward; rare ones make the news. Kept in the
 *             profile's stats as ach:<id> (and visited systems as sys:<id>).
 *   Rankings  weekly and all-time boards of the RANKED stats, for registered
 *             pilots. Kept by the lobby (one row per account, every server's pilots
 *             ranked together): this reports changes to it (game/rankings).
 *   News      a galaxy-wide feed: boss kills, fleet ops, levels, rare ribbons,
 *             the week's hunt. New arrivals hear the last few.
 */

import {
  ServerMessage, RibbonDef, RibbonsFile, ribbonValue, ribbonKey, weekEndsIn, RANKED,
} from '@space-game/common';
import type { Pilots, PilotConn, PilotEvent } from './Pilots.js';
import type { ProfileStore } from '../profile/ProfileStore.js';
import type { RankingsBackend } from './rankings/RankingsBackend.js';
import { RankingReporter } from './rankings/RankingReporter.js';
import { migrateRankings } from './rankings/rankingsMigration.js';

export { RANKINGS_DOC } from './rankings/rankingsMigration.js';
const NEWS_KEEP = 12;

export interface AchievementsHost {
  send(conn: PilotConn, msg: ServerMessage): void;
  /** Everyone online */
  broadcast(msg: ServerMessage): void;
  now(): number;
}

export class Achievements {
  readonly defs: RibbonDef[];
  private news: { text: string; kind: string; at: number }[] = [];
  /** Rankings changes on their way to the lobby (none without one: a server with no lobby ranks nobody) */
  private reporter: RankingReporter | null;
  /** The old per-server rankings document, moved to the lobby once (resolves when done; tests wait on it) */
  readonly migrated: Promise<unknown>;

  constructor(private host: AchievementsHost, private pilots: Pilots, file: RibbonsFile | undefined, store: ProfileStore,
    private backend?: RankingsBackend, serverName = 'Game Server') {
    this.defs = file?.ribbons ?? [];
    this.reporter = backend ? new RankingReporter(backend, serverName, () => host.now()) : null;
    this.migrated = backend ? migrateRankings(store, backend, () => host.now()).catch((e) => console.error('[Rankings] migration failed:', e)) : Promise.resolve();
    pilots.onEvent((conn, ev) => this.onEvent(conn, ev));
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
    this.reporter?.add(conn.userId, key, n, p.stats[key] ?? 0);
  }

  /** A registered pilot logs in: their all-time totals go to the lobby (from before rankings existed, too) */
  private seed(conn: PilotConn): void {
    const p = this.pilots.get(conn);
    if (conn.userId === null || !p || !this.reporter) return;
    const v: Record<string, number> = {};
    for (const r of RANKED) if (p.stats[r.key]) v[r.key] = p.stats[r.key];
    if (Object.keys(v).length) this.reporter.seed(conn.userId, v);
  }

  /** The account was deleted: nothing more to report (the lobby takes it off the boards itself) */
  forget(userId: number): void {
    this.reporter?.forget(userId);
  }

  /** The Rankings tab, for clients that ask this server (the game client reads the lobby itself: network/rankings.ts) */
  rankings(conn: PilotConn): void {
    void (async () => {
      const view = await this.backend?.view();
      this.host.send(conn, {
        type: 'rankings',
        weekEndsIn: view?.weekEndsIn ?? weekEndsIn(this.host.now()),
        boards: view?.boards ?? RANKED.map((r) => ({ key: r.key, label: r.label, weekly: [], allTime: [] })),
      });
    })();
  }

  /** Now and then (and at shutdown): send what changed to the lobby */
  async save(force = false): Promise<void> {
    if (!this.reporter) return;
    await this.migrated;
    await this.reporter.flush(force);
  }
}
