/**
 * @contract server.rankings.reporter
 * owns:       collecting pilots' ranked-stat changes and sending them to the lobby in batches (retried, never lost on a
 *             failed send, never counted twice)
 * needs:      RankingsBackend, a clock, common weekOf
 * invariants: a batch that failed is sent again unchanged (same id) before anything newer — server/src/game/rankings/rankings.test.ts
 *             sends are at most one per SEND_MS, backing off up to MAX_BACKOFF_MS while the lobby is down — server/src/game/rankings/rankings.test.ts
 *             at most MAX_PLAYERS pilots wait at once (a long outage can't grow it) — none pinned
 * extend:     nothing: Achievements feeds it (add, seed, forget)
 */
import { randomUUID } from 'node:crypto';
import { weekOf } from '@space-game/common';
import type { RankBatch, RankPlayerReport, RankStats, RankingsBackend } from './RankingsBackend.js';

export const SEND_MS = 15_000;
export const MAX_BACKOFF_MS = 5 * 60_000;
export const BATCH_MAX = 200;
export const MAX_PLAYERS = 5000;

export class RankingReporter {
  private pending = new Map<number, RankPlayerReport>();
  /** The batch the lobby hasn't taken yet (kept as it was: the lobby counts a batch id once) */
  private inflight: RankBatch | null = null;
  private lastSend = -Infinity;
  private failures = 0;

  constructor(private backend: RankingsBackend, private server: string, private now: () => number) {}

  private entry(userId: number): RankPlayerReport | null {
    let e = this.pending.get(userId);
    if (!e) {
      if (this.pending.size >= MAX_PLAYERS) return null;
      e = { userId, weekly: {}, allTime: {} };
      this.pending.set(userId, e);
    }
    return e;
  }

  /** A ranked stat went up by `n` and is now `total` */
  add(userId: number, key: string, n: number, total: number): void {
    const e = this.entry(userId);
    if (!e) return;
    e.weekly[key] = (e.weekly[key] ?? 0) + n;
    e.allTime[key] = total;
  }

  /** A pilot's totals (login: what they had before rankings were central, too) */
  seed(userId: number, totals: RankStats): void {
    const e = this.entry(userId);
    if (e) Object.assign(e.allTime, totals);
  }

  /** The account was deleted */
  forget(userId: number): void {
    this.pending.delete(userId);
    if (this.inflight) this.inflight.players = this.inflight.players.filter((p) => p.userId !== userId);
  }

  get waiting(): number {
    return this.pending.size + (this.inflight?.players.length ?? 0);
  }

  /** Send what's waiting (one batch; `force`: now, whatever the pace, as at shutdown). Never throws */
  async flush(force = false): Promise<void> {
    const t = this.now();
    const wait = this.failures ? Math.min(MAX_BACKOFF_MS, SEND_MS * 2 ** this.failures) : SEND_MS;
    if (!force && t - this.lastSend < wait) return;
    if (!this.inflight) {
      if (!this.pending.size) return;
      const players: RankPlayerReport[] = [];
      for (const [id, p] of this.pending) {
        if (players.length >= BATCH_MAX) break;
        players.push(p);
        this.pending.delete(id);
      }
      this.inflight = { server: this.server, batch: randomUUID(), week: weekOf(t), players };
    }
    this.lastSend = t;
    const batch = this.inflight;
    let taken = false;
    try { taken = await this.backend.report(batch); } catch { taken = false; }
    if (taken) { this.inflight = null; this.failures = 0; } else this.failures++;
  }
}
