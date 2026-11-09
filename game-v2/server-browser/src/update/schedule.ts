/**
 * @contract lobby.update.schedule
 * owns:       the one scheduled update (a time every awake game server restarts at), kept in <dataDir>/update.json, and its admin routes
 * needs:      accounts/utils (safeEqual), node fs/path/http
 * invariants: the admin routes answer only to LOBBY_ADMIN_SECRET — server-browser/src/update/update.test.ts
 *             a schedule is forgotten a short while after its time, so a server that wakes late isn't restarted — server-browser/src/update/update.test.ts
 *             what servers are told is the time LEFT, so their clocks needn't agree with the lobby's — server-browser/src/update/update.test.ts
 * extend:     a new admin action is a case in UpdateRoutes.handle
 */

import fs from 'fs';
import http from 'http';
import path from 'path';
import { safeEqual } from '../accounts/utils.js';

/** A schedule stays this long past its time (servers restart at it; one that wakes after sees nothing) */
export const GRACE_MS = 2 * 60_000;
export const MAX_AHEAD_MS = 7 * 24 * 3600_000;
export const MIN_AHEAD_MS = 60_000;

export interface Scheduled { at: number; by: string; set: number }

export class UpdateSchedule {
  private cur: Scheduled | null = null;
  constructor(private file: string | null, private clock: () => number = Date.now) {
    if (file) {
      try {
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Number.isFinite(j?.at)) this.cur = { at: j.at, by: String(j.by ?? ''), set: Number(j.set) || 0 };
      } catch { /* none kept */ }
    }
  }

  /** The schedule, or null (dropped once its grace is over) */
  get(): Scheduled | null {
    if (this.cur && this.clock() > this.cur.at + GRACE_MS) { this.cur = null; this.persist(); }
    return this.cur;
  }

  /** What a heartbeat answers: the time left (never negative), or nothing */
  forHeartbeat(): { inMs: number } | undefined {
    const s = this.get();
    return s ? { inMs: Math.max(0, s.at - this.clock()) } : undefined;
  }

  schedule(at: number, by: string): { ok: true; at: number } | { ok: false; error: string } {
    const ahead = at - this.clock();
    if (!Number.isFinite(at) || ahead < MIN_AHEAD_MS) return { ok: false, error: 'An update needs at least 1 minute of notice' };
    if (ahead > MAX_AHEAD_MS) return { ok: false, error: 'An update can be at most 7 days ahead' };
    this.cur = { at, by: by.slice(0, 64), set: this.clock() };
    this.persist();
    return { ok: true, at };
  }

  cancel(): boolean {
    const had = this.get() !== null;
    this.cur = null;
    this.persist();
    return had;
  }

  private persist(): void {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      if (this.cur) fs.writeFileSync(this.file, JSON.stringify(this.cur));
      else fs.rmSync(this.file, { force: true });
    } catch (e) { console.error('[update] could not keep the schedule:', e); }
  }
}

type Json = (res: http.ServerResponse, status: number, body: unknown) => void;
type Body = (req: http.IncomingMessage) => Promise<any>;

/**
 *   POST /admin/update/schedule { inMinutes } or { at }  (ms since epoch) -> { success, at, inMs }
 *   POST /admin/update/cancel                             -> { success, cancelled }
 *   POST /admin/update/status                             -> { success, scheduled, at?, inMs? }
 * All behind `Authorization: Bearer <LOBBY_ADMIN_SECRET>`.
 */
export class UpdateRoutes {
  constructor(readonly schedule: UpdateSchedule, private sendJson: Json, private parseJson: Body, private secret: string, private clock: () => number = Date.now) {}

  static create(dataDir: string, sendJson: Json, parseJson: Body, secret: string): UpdateRoutes {
    return new UpdateRoutes(new UpdateSchedule(path.join(dataDir, 'update.json')), sendJson, parseJson, secret);
  }

  async handle(req: http.IncomingMessage, res: http.ServerResponse, url: string): Promise<boolean> {
    if (req.method !== 'POST' || !url.startsWith('/admin/update/')) return false;
    const given = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!this.secret || !safeEqual(given, this.secret)) { this.sendJson(res, 403, { success: false, error: 'Forbidden' }); return true; }
    let body: any = {};
    try { body = await this.parseJson(req); } catch { this.sendJson(res, 400, { success: false, error: 'Invalid request' }); return true; }
    const action = url.slice('/admin/update/'.length);
    if (action === 'schedule') {
      const at = body.at !== undefined ? Number(body.at) : this.clock() + Number(body.inMinutes) * 60_000;
      const r = this.schedule.schedule(at, String(body.by ?? 'admin'));
      if (!r.ok) { this.sendJson(res, 400, { success: false, error: r.error }); return true; }
      this.sendJson(res, 200, { success: true, at: r.at, inMs: r.at - this.clock() });
    } else if (action === 'cancel') {
      this.sendJson(res, 200, { success: true, cancelled: this.schedule.cancel() });
    } else if (action === 'status') {
      const s = this.schedule.get();
      this.sendJson(res, 200, { success: true, scheduled: !!s, ...(s ? { at: s.at, inMs: Math.max(0, s.at - this.clock()), by: s.by } : {}) });
    } else {
      this.sendJson(res, 404, { success: false, error: 'Not found' });
    }
    return true;
  }
}
