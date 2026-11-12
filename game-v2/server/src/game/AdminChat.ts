/**
 * @contract server.game.admin-chat
 * owns:       chat between an admin on the website and pilots in this game server: who is on (the roster the admin page
 *             shows), delivering an admin's message to everyone or to one pilot, and taking a pilot's private reply to an
 *             admin who isn't in the game. The link to the lobby (polling, sending) is adminChatLink.ts
 * needs:      AdminChatHost (conns, send, note, now), @space-game/common (ServerMessage: the existing chat and whisper
 *             messages, so the wire is unchanged)
 * invariants: a message to everyone reaches every joined pilot as chat from "[Admin] name" — server/src/game/adminChat.test.ts
 *             a private message reaches only its pilot, as a whisper from the admin; one to a pilot who has gone is reported failed — server/src/game/adminChat.test.ts
 *             a pilot's private message to a website admin who isn't in the game goes to the lobby's admin log and to nobody in game — server/src/game/adminChat.test.ts
 *             a private message to any other name that isn't on is not taken (the usual "offline" answer stands) — server/src/game/adminChat.test.ts
 *             each lobby message is delivered once, however often it is handed over — server/src/game/adminChat.test.ts
 * extend:     a new kind of admin message is one case in deliver()
 */
/**
 * The admin's side is the website's admin panel (site/src/routes/adminChat.ts), through the lobby
 * (server-browser/src/adminchat). Nothing here is on the public activity feed: a private reply goes only into the
 * lobby's admin message log.
 */

import type { ServerMessage } from '@space-game/common';

export interface AdminChatConn {
  username: string;
  userId: number | null;
  joined: boolean;
}

export interface AdminChatHost<C extends AdminChatConn> {
  /** Everyone connected */
  conns(): Iterable<C>;
  send(c: C, msg: ServerMessage): void;
  /** A line in the pilot's chat (the game's own) */
  note(c: C, text: string, color?: string): void;
  now(): number;
}

/** A message from the lobby: to everyone ('all') or to one pilot ('pm') */
export interface AdminMessage { id: number; kind: 'all' | 'pm'; admin: string; to?: string; text: string }
/** A pilot's private reply to a website admin */
export interface AdminReply { from: string; guest: boolean; to: string; text: string; at: number }
export interface RosterEntry { name: string; guest: boolean; since: number }

/** Most characters of one message, either way */
export const ADMIN_TEXT_MAX = 300;
/** How long after an admin's message a pilot's reply to that name is still taken for the website */
export const ADMIN_REPLY_WINDOW_MS = 24 * 60 * 60_000;
/** Replies kept while the lobby can't be reached (the oldest are dropped past this) */
const REPLIES_MAX = 200;
const ADMIN_NAME = /^[A-Za-z0-9_-]{2,20}$/;
const NOTE = '#fbbf24';

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f‧-‮]/g, ' ').trim().slice(0, max) : '');

export class AdminChat<C extends AdminChatConn> {
  /** Website admins who have written here lately (by lower-case name): replies to them go to the lobby */
  private admins = new Map<string, { name: string; until: number }>();
  private replies: AdminReply[] = [];
  private failed: number[] = [];
  private since = new WeakMap<C, number>();
  /** Pilots told who an admin is (once each per admin, per connection) */
  private told = new WeakMap<C, Set<string>>();
  /** The newest lobby message handled: one handed over again is skipped */
  private last = 0;

  constructor(private host: AdminChatHost<C>) {}

  private lobbyEpoch: unknown = undefined;

  /**
   * The lobby's start time, from each of its answers: when it changes the lobby restarted, and its message ids may
   * have started again, so the count of what has been handled starts again too
   */
  lobby(epoch: unknown): void {
    if (epoch === undefined || epoch === this.lobbyEpoch) return;
    if (this.lobbyEpoch !== undefined) this.last = 0;
    this.lobbyEpoch = epoch;
  }

  /** The newest lobby message handled (the link tells the lobby, which then stops sending it) */
  get ack(): number { return this.last; }

  private joined(): C[] {
    return [...this.host.conns()].filter((c) => c.joined);
  }

  /** Who is on now: name, guest or not, and when they were first seen on */
  roster(): RosterEntry[] {
    const now = this.host.now();
    return this.joined().map((c) => {
      if (!this.since.has(c)) this.since.set(c, now);
      return { name: c.username, guest: c.userId === null, since: this.since.get(c)! };
    });
  }

  /** A message from the lobby (each id once) */
  deliver(m: AdminMessage): void {
    if (!m || !Number.isSafeInteger(m.id) || m.id <= this.last) return;
    this.last = m.id;
    const admin = typeof m.admin === 'string' && ADMIN_NAME.test(m.admin) ? m.admin : '';
    const text = clean(m.text, ADMIN_TEXT_MAX);
    if (!admin || !text) { this.failed.push(m.id); return; }
    const now = this.host.now();
    this.admins.set(admin.toLowerCase(), { name: admin, until: now + ADMIN_REPLY_WINDOW_MS });
    if (m.kind === 'all') {
      for (const c of this.joined()) this.host.send(c, { type: 'chat', playerId: 0, playerName: `[Admin] ${admin}`, text, timestamp: now });
      return;
    }
    const to = clean(m.to, 40).toLowerCase();
    const target = to ? this.joined().find((c) => c.username.toLowerCase() === to) : undefined;
    if (!target) { this.failed.push(m.id); return; }
    let told = this.told.get(target);
    if (!told) this.told.set(target, told = new Set());
    if (!told.has(admin.toLowerCase())) {
      told.add(admin.toLowerCase());
      this.host.note(target, `${admin} is an admin, writing to you from outside the game. Reply with /w ${admin} your message`, NOTE);
    }
    this.host.send(target, { type: 'whisper', from: admin, to: target.username, text });
  }

  /**
   * A pilot's private message to `name`, who isn't on (Social.whisper asks before saying "offline"). If `name` is a
   * website admin who wrote here lately, it is theirs: kept for the lobby, shown to the sender as sent. True when taken.
   */
  replyTo(conn: C, name: string, body: string): boolean {
    const a = this.admins.get(name.toLowerCase());
    const now = this.host.now();
    if (!a || a.until <= now) { if (a) this.admins.delete(name.toLowerCase()); return false; }
    const text = clean(body, ADMIN_TEXT_MAX);
    if (!text || !conn.joined) return false;
    this.replies.push({ from: conn.username, guest: conn.userId === null, to: a.name, text, at: now });
    if (this.replies.length > REPLIES_MAX) this.replies.splice(0, this.replies.length - REPLIES_MAX);
    this.host.send(conn, { type: 'whisper', from: conn.username, to: a.name, text, out: true });
    return true;
  }

  /** Anything waiting to go to the lobby */
  get pending(): boolean {
    return this.replies.length > 0 || this.failed.length > 0;
  }

  /** What goes to the lobby now. Call `sent()` once the lobby has it; until then it is offered again */
  outgoing(): { replies: AdminReply[]; failed: number[]; sent(): void } {
    const replies = this.replies.slice(), failed = this.failed.slice();
    return { replies, failed, sent: () => { this.replies.splice(0, replies.length); this.failed.splice(0, failed.length); } };
  }
}
