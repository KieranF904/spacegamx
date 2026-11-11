/**
 * Friends, status and private messages.
 *
 *   Friends    signed-in accounts only (guests have none). Ask by name, the other side accepts or declines,
 *              either side removes. Kept per account by the lobby (FriendsBackend: LobbyFriends), so they follow
 *              the account to every server. Each online pilot's lists are kept here while they're on (read at
 *              sign-in, after every change, and every refreshMs for changes made on other servers).
 *   Status     Online, Away, Busy or Appear offline, saved per account in the lobby too (a guest's lasts the
 *              session). Friends see it in their list; Appear offline shows you as offline to everyone, private
 *              messages included.
 *   Presence   for now only this server's pilots count as online: a friend on another server shows as offline.
 *              presence() is the one place that decides; cross-server presence (servers reporting their online
 *              accounts to the lobby, server-browser/src/friends/routes.ts) would plug in there.
 *   Private    to any pilot online here by name, guests too. Never stored: a pilot who is offline (or appears so)
 *              is not sent it, and the sender is told so. Busy and Away pilots get it, and the sender is told
 *              they may not answer. (Cross-server messages: later, through the lobby.)
 *
 * The lobby being down: a list that can't load says so and is tried again every retryMs; a change says friends are
 * unavailable; a status still applies here for the session and is saved once the lobby answers. Whispers don't need it.
 *
 * Everything a client sends is checked here (names, text, status), and requests and messages are rate limited
 * per connection, admins included (dispatch's MESSAGE_LIMITS drop floods before this); the lobby checks again and
 * limits per account.
 *
 * At start, an old per-server friends document is moved to the lobby once (friendsMigration.ts).
 */
import type { ServerMessage, SocialStatus, FriendPresence, FriendView } from '@space-game/common';
import { isSocialStatus } from '@space-game/common';
import type { PilotConn } from '../Pilots.js';
import type { ProfileStore } from '../../profile/ProfileStore.js';
import { activity } from '../../activity/index.js';
import { FriendsUnavailable, type FriendChange, type FriendRecord, type FriendsBackend } from './FriendsBackend.js';
import { migrateFriends } from './friendsMigration.js';

export const MESSAGE_MAX = 200;
/** Private messages: this many in WHISPER_WINDOW ms */
export const WHISPER_BURST = 8;
export const WHISPER_WINDOW = 10_000;
/** Friend requests: this many in REQUEST_WINDOW ms */
export const REQUEST_BURST = 10;
export const REQUEST_WINDOW = 10 * 60_000;
/** Status changes: this many in STATUS_WINDOW ms */
export const STATUS_BURST = 6;
export const STATUS_WINDOW = 30_000;
/** How soon a list that couldn't load (or a status that couldn't be saved) is tried again */
export const RETRY_MS = 15_000;

export const UNAVAILABLE = "Friends are unavailable right now: the account server isn't answering. Try again in a moment.";
export const LIST_UNAVAILABLE = "Your friends list can't be loaded right now: the account server isn't answering. It will load when it's back.";
export const STATUS_UNSAVED = "Your status is set for now, but couldn't be saved yet: the account server isn't answering.";
const LIMITED = 'Too many friends changes lately: try again in a moment';

export interface SocialHost {
  send(conn: PilotConn, msg: ServerMessage): void;
  toast(conn: PilotConn, text: string, kind?: 'info' | 'good' | 'warn' | 'bad'): void;
  /** A line in the pilot's chat (the game's own) */
  note(conn: PilotConn, text: string, color?: string): void;
  /** Everyone connected and joined */
  conns(): Iterable<PilotConn>;
  now(): number;
}

const NOTE = '#7dd3fc';

/** A sliding window of times: may one more go now? */
class Window {
  private at: number[] = [];
  constructor(private burst: number, private ms: number) {}
  take(now: number): boolean {
    while (this.at.length && now - this.at[0] >= this.ms) this.at.shift();
    if (this.at.length >= this.burst) return false;
    this.at.push(now);
    return true;
  }
}

const clean = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, 40) : '');
const sameRecord = (a: FriendRecord | null | undefined, b: FriendRecord) => !!a && JSON.stringify(a) === JSON.stringify(b);

export class Social {
  private migrated = false;
  private loaded = false;
  private waiting: (() => void)[] = [];
  /** Who each joined connection is (its account id, or null for a guest) */
  private joined = new Map<PilotConn, number | null>();
  /** The connection on each account */
  private byUser = new Map<number, PilotConn>();
  /** Each online account's lists: missing until loaded, null when the lobby couldn't be reached */
  private lists = new Map<number, FriendRecord | null>();
  /** Status chosen this session (it wins over the lobby's copy while they're on) */
  private chosen = new Map<number, SocialStatus>();
  /** ...and not saved yet (the lobby was down) */
  private unsaved = new Set<number>();
  private guestStatus = new WeakMap<PilotConn, SocialStatus>();
  private limits = new WeakMap<PilotConn, { whisper: Window; request: Window; status: Window }>();
  private inflight = new Set<Promise<unknown>>();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryMs: number;
  /** Resolves once the start-up move of old friends has been tried (tests) */
  readonly ready: Promise<void>;

  constructor(private host: SocialHost, private store: ProfileStore | null, private backend: FriendsBackend, opts: { retryMs?: number } = {}) {
    this.retryMs = opts.retryMs ?? RETRY_MS;
    this.ready = this.migrate().finally(() => {
      this.loaded = true;
      for (const fn of this.waiting.splice(0)) fn();
    });
    if (backend.refreshMs > 0) {
      this.refreshTimer = setInterval(() => this.refresh(), backend.refreshMs);
      this.refreshTimer.unref?.();
    }
  }

  private async migrate(): Promise<void> {
    if (!this.store) { this.migrated = true; return; }
    this.migrated = (await migrateFriends(this.store, this.backend, this.host.now)) !== 'failed';
    if (!this.migrated) this.scheduleRetry();
  }

  /** Run now, or once the start-up move is done (a pilot can arrive before it is) */
  private when(fn: () => void): void {
    if (this.loaded) fn(); else this.waiting.push(fn);
  }

  /** Keeps a lobby call's promise until it settles (save() waits for them) */
  private track<T>(p: Promise<T>): Promise<T> {
    this.inflight.add(p);
    void p.catch(() => {}).finally(() => this.inflight.delete(p));
    return p;
  }

  // ---------------------------------------------------------------------------
  // Presence
  // ---------------------------------------------------------------------------

  /** A pilot joined or signed in (Pilots 'login'): their list, and their friends hear they're on */
  join(conn: PilotConn): void {
    this.when(() => {
      const was = this.joined.get(conn);
      if (was !== undefined && was !== null && was !== conn.userId) this.leave(conn);
      const uid = conn.userId;
      this.joined.set(conn, uid);
      if (uid === null) return this.sendList(conn);
      this.byUser.set(uid, conn);
      void this.track(this.load(uid, conn, true));
    });
  }

  /** Read an online account's lists from the lobby; true when it answered */
  private async load(uid: number, conn: PilotConn, first: boolean): Promise<boolean> {
    let rec: FriendRecord;
    try {
      rec = await this.backend.get(uid, conn.username);
    } catch {
      if (this.byUser.get(uid) !== conn) return false;
      // (A refresh that fails keeps the lists it had)
      if (this.lists.get(uid) === undefined) {
        this.lists.set(uid, null);
        this.sendList(conn);
        this.host.note(conn, LIST_UNAVAILABLE, NOTE);
        this.pushFriendsOf(uid);
      }
      if (this.lists.get(uid) === null) this.scheduleRetry();
      return false;
    }
    if (this.byUser.get(uid) !== conn) return true;
    const before = this.lists.get(uid);
    this.lists.set(uid, rec);
    if (!sameRecord(before, rec)) this.sendList(conn);
    if (first || before === null || before?.status !== rec.status) this.pushFriendsOf(uid);
    if (this.unsaved.has(uid)) void this.saveStatus(uid, conn, true);
    return true;
  }

  /** Disconnected */
  leave(conn: PilotConn): void {
    const uid = this.joined.get(conn);
    this.joined.delete(conn);
    if (uid === undefined || uid === null || this.byUser.get(uid) !== conn) return;
    this.byUser.delete(uid);
    this.lists.delete(uid);
    this.chosen.delete(uid);
    this.unsaved.delete(uid);
    this.pushFriendsOf(uid);
  }

  /**
   * What others see of an account: offline unless they're on this server (and their lists have loaded, so an
   * Appear offline pilot never flickers online). The seam for cross-server presence.
   */
  presence(uid: number): FriendPresence {
    if (!this.byUser.has(uid) || this.lists.get(uid) === undefined) return 'offline';
    const s = this.accountStatus(uid);
    return s === 'invisible' ? 'offline' : s;
  }

  private accountStatus(uid: number): SocialStatus {
    return this.chosen.get(uid) ?? this.lists.get(uid)?.status ?? 'online';
  }

  private statusOf(conn: PilotConn): SocialStatus {
    const uid = this.joined.get(conn) ?? conn.userId;
    return uid !== null && uid !== undefined ? this.accountStatus(uid) : this.guestStatus.get(conn) ?? 'online';
  }

  /** What others see of an online pilot (a guest's status is theirs for the session) */
  private shown(conn: PilotConn): FriendPresence {
    const s = this.statusOf(conn);
    return s === 'invisible' ? 'offline' : s;
  }

  setStatus(conn: PilotConn, status: unknown): void {
    if (!isSocialStatus(status)) return;
    if (!this.limit(conn).status.take(this.host.now())) return this.host.toast(conn, 'Slow down: try again in a moment', 'warn');
    this.when(() => {
      const uid = this.joined.get(conn);
      if (uid === undefined) return;
      if (uid === null) { this.guestStatus.set(conn, status); return this.sendList(conn); }
      if (this.accountStatus(uid) === status) return this.sendList(conn);
      this.chosen.set(uid, status);
      this.unsaved.add(uid);
      this.sendList(conn);
      this.pushFriendsOf(uid);
      void this.track(this.saveStatus(uid, conn, false));
    });
  }

  /** Save the chosen status in the lobby (`quiet`: a retry, which doesn't tell the pilot again) */
  private async saveStatus(uid: number, conn: PilotConn, quiet: boolean): Promise<void> {
    const status = this.chosen.get(uid);
    if (status === undefined) return;
    try {
      await this.backend.setStatus(uid, status);
      if (this.chosen.get(uid) !== status) return;
      this.unsaved.delete(uid);
      const rec = this.lists.get(uid);
      if (rec) rec.status = status;
    } catch (e) {
      if (this.byUser.get(uid) !== conn) return;
      if (!quiet) this.host.toast(conn, e instanceof FriendsUnavailable && e.limited ? LIMITED : STATUS_UNSAVED, 'warn');
      this.scheduleRetry();
    }
  }

  // ---------------------------------------------------------------------------
  // Friends
  // ---------------------------------------------------------------------------

  /** Ask a pilot (by name) to be friends */
  request(conn: PilotConn, name: unknown): void {
    const n = clean(name);
    if (!n) return;
    this.when(() => void this.track(this.doRequest(conn, n)));
  }

  private async doRequest(conn: PilotConn, n: string): Promise<void> {
    const me = this.account(conn);
    if (me === null) return this.host.toast(conn, 'Sign in to add friends', 'warn');
    if (!this.limit(conn).request.take(this.host.now())) return this.host.toast(conn, 'Too many friend requests: try again later', 'warn');
    const online = this.onlineByName(n);
    if (online && online.userId === null) return this.host.toast(conn, "Guests can't be added as friends", 'warn');
    if (online === conn || n.toLowerCase() === conn.username.toLowerCase()) return this.host.toast(conn, "You can't add yourself", 'warn');
    let c: FriendChange<string>;
    try { c = await this.backend.request(me, n); } catch (e) { return this.unavailable(conn, e); }
    if (this.account(conn) !== me) return;
    this.apply(me, c);
    const them = c.other?.name ?? n;
    switch (c.result) {
      case 'sent': {
        activity.social(conn, 'friend requests');
        this.host.toast(conn, `Friend request sent to ${them}`, 'info');
        const other = c.other && this.byUser.get(c.other.id);
        if (other) this.host.send(other, { type: 'friendRequest', from: conn.username });
        return;
      }
      case 'accepted':
        activity.social(conn, 'friends accepted');
        return this.befriended(me, c);
      case 'already': return this.host.toast(conn, `${them} is already your friend`, 'info');
      case 'pending': return this.host.toast(conn, `You already asked ${them}`, 'info');
      case 'full': return this.host.toast(conn, 'Your friends list is full', 'warn');
      case 'theirFull': return this.host.toast(conn, `${them}'s friends list is full`, 'warn');
      case 'busy': return this.host.toast(conn, `${them} has too many requests waiting`, 'warn');
      case 'self': return this.host.toast(conn, "You can't add yourself", 'warn');
      default: return this.host.toast(conn, `No pilot called ${n}`, 'warn');
    }
  }

  respond(conn: PilotConn, name: unknown, accept: unknown): void {
    const n = clean(name);
    if (!n) return;
    this.when(() => void this.track(this.doRespond(conn, n, accept === true)));
  }

  private async doRespond(conn: PilotConn, n: string, accept: boolean): Promise<void> {
    const me = this.account(conn);
    if (me === null) return this.host.toast(conn, 'That request is no longer open', 'warn');
    let c: FriendChange<string>;
    try { c = await this.backend.respond(me, n, accept); } catch (e) { return this.unavailable(conn, e); }
    if (this.account(conn) !== me) return;
    this.apply(me, c);
    switch (c.result) {
      case 'accepted':
        activity.social(conn, 'friends accepted');
        return this.befriended(me, c);
      case 'declined': activity.social(conn, 'requests declined'); return;
      case 'full': return this.host.toast(conn, 'A friends list is full (yours or theirs)', 'warn');
      default: return this.host.toast(conn, 'That request is no longer open', 'warn');
    }
  }

  /** Remove a friend (or take back a request, or turn one down) */
  remove(conn: PilotConn, name: unknown): void {
    const n = clean(name);
    if (!n) return;
    this.when(() => void this.track(this.doRemove(conn, n)));
  }

  private async doRemove(conn: PilotConn, n: string): Promise<void> {
    const me = this.account(conn);
    if (me === null) return;
    let c: FriendChange<string>;
    try { c = await this.backend.remove(me, n); } catch (e) { return this.unavailable(conn, e); }
    if (this.account(conn) !== me) return;
    this.apply(me, c);
    if (c.result === 'unfriended') {
      activity.social(conn, 'friends removed');
      this.host.toast(conn, `${c.other?.name ?? n} is no longer on your friends list`, 'info');
    }
  }

  /** A change's lists kept for whichever of the two is online here, and sent to them */
  private apply(me: number, c: FriendChange<string>): void {
    const set = (uid: number, rec: FriendRecord) => {
      const conn = this.byUser.get(uid);
      if (!conn) return;
      this.lists.set(uid, rec);
      this.sendList(conn);
    };
    set(me, c.me);
    if (c.other && c.them && c.other.id !== me) set(c.other.id, c.them);
  }

  private befriended(me: number, c: FriendChange<string>): void {
    if (!c.other) return;
    const myName = this.byUser.get(me)?.username ?? 'they';
    for (const [uid, them] of [[me, c.other.name], [c.other.id, myName]] as const) {
      const conn = this.byUser.get(uid);
      if (conn) this.host.toast(conn, `You and ${them} are friends now`, 'good');
    }
  }

  private unavailable(conn: PilotConn, e: unknown): void {
    if (!(e instanceof FriendsUnavailable)) console.error('[Social] a friends change failed:', e);
    this.host.toast(conn, e instanceof FriendsUnavailable && e.limited ? LIMITED : UNAVAILABLE, 'warn');
  }

  /** The friends list as this pilot sees it */
  list(conn: PilotConn): ServerMessage {
    const uid = this.joined.get(conn) ?? null;
    const rec = uid !== null ? this.lists.get(uid) : undefined;
    const friends: FriendView[] = (rec?.friends ?? []).map((f) => ({ name: f.name, presence: this.presence(f.id) }))
      .sort((x, y) => Number(x.presence === 'offline') - Number(y.presence === 'offline') || x.name.localeCompare(y.name));
    return {
      type: 'friends', status: this.statusOf(conn), account: uid !== null, friends,
      incoming: (rec?.incoming ?? []).map((e) => e.name), outgoing: (rec?.outgoing ?? []).map((e) => e.name),
    };
  }

  private sendList(conn: PilotConn): void {
    this.host.send(conn, this.list(conn));
  }

  /** Everyone online here with this account on their list hears how it is now */
  private pushFriendsOf(uid: number): void {
    for (const [fid, rec] of this.lists) {
      if (!rec?.friends.some((f) => f.id === uid)) continue;
      const c = this.byUser.get(fid);
      if (c) this.sendList(c);
    }
  }

  // ---------------------------------------------------------------------------
  // Private messages
  // ---------------------------------------------------------------------------

  whisper(conn: PilotConn, to: unknown, text: unknown): void {
    const name = clean(to);
    const body = typeof text === 'string' ? text.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, MESSAGE_MAX).trim() : '';
    if (!name || !body || !this.joined.has(conn)) return;
    const target = this.onlineByName(name);
    if (target === conn) return this.host.note(conn, "You can't send a private message to yourself", NOTE);
    if (!this.limit(conn).whisper.take(this.host.now())) return this.host.note(conn, 'Slow down: too many private messages at once.', '#fca5a5');
    // (Appear offline looks exactly like offline: nothing tells the sender otherwise)
    if (!target || this.shown(target) === 'offline') {
      const uid = this.joined.get(conn);
      const known = uid != null ? this.lists.get(uid)?.friends.find((f) => f.name.toLowerCase() === name.toLowerCase()) : undefined;
      return this.host.note(conn, `${known?.name ?? target?.username ?? name} is offline. Private messages only reach pilots who are online.`, NOTE);
    }
    this.host.send(target, { type: 'whisper', from: conn.username, to: target.username, text: body });
    this.host.send(conn, { type: 'whisper', from: conn.username, to: target.username, text: body, out: true });
    activity.social(conn, 'private messages');
    const s = this.shown(target);
    if (s === 'busy' || s === 'away') this.host.note(conn, `${target.username} is ${s} and may not answer right away.`, NOTE);
  }

  /** Chat commands: /w name message (also /msg, /whisper), /friend name. True if it was one */
  chatCommand(conn: PilotConn, cmd: string, arg: string): boolean {
    switch (cmd) {
      case 'w': case 'msg': case 'whisper': case 'tell': {
        const m = /^(\S+)\s+([\s\S]+)$/.exec(arg.trim());
        if (!m) { this.host.note(conn, 'Private message: /w name message', NOTE); return true; }
        this.whisper(conn, m[1], m[2]);
        return true;
      }
      case 'friend': case 'addfriend':
        if (arg.trim()) this.request(conn, arg.trim());
        return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Upkeep
  // ---------------------------------------------------------------------------

  /** The account (null for a guest, or one not joined) */
  private account(conn: PilotConn): number | null {
    return this.joined.get(conn) ?? null;
  }

  private onlineByName(name: string): PilotConn | undefined {
    const n = name.toLowerCase();
    for (const c of this.host.conns()) if (this.joined.has(c) && c.username.toLowerCase() === n) return c;
    return undefined;
  }

  private limit(conn: PilotConn) {
    let l = this.limits.get(conn);
    if (!l) {
      l = { whisper: new Window(WHISPER_BURST, WHISPER_WINDOW), request: new Window(REQUEST_BURST, REQUEST_WINDOW), status: new Window(STATUS_BURST, STATUS_WINDOW) };
      this.limits.set(conn, l);
    }
    return l;
  }

  /** An account was deleted (the lobby's list; the lobby has taken it off every list already): off the lists here */
  forget(uid: number): void {
    this.when(() => {
      this.lists.delete(uid);
      for (const [fid, rec] of this.lists) {
        if (!rec) continue;
        const has = (l: { id: number }[]) => l.some((e) => e.id === uid);
        if (!has(rec.friends) && !has(rec.incoming) && !has(rec.outgoing)) continue;
        const keep = (l: { id: number; name: string }[]) => l.filter((e) => e.id !== uid);
        this.lists.set(fid, { ...rec, friends: keep(rec.friends), incoming: keep(rec.incoming), outgoing: keep(rec.outgoing) });
        const c = this.byUser.get(fid);
        if (c) this.sendList(c);
      }
    });
  }

  /** Read every online pilot's lists again (changes made on other servers); runs every backend.refreshMs */
  refresh(): void {
    for (const [uid, conn] of this.byUser) void this.track(this.load(uid, conn, false));
  }

  /** Lists that couldn't load, statuses not saved, the start-up move: tried again (the timer; tests call it) */
  async retry(): Promise<void> {
    const jobs: Promise<unknown>[] = [];
    if (!this.migrated && this.store) jobs.push(this.migrate());
    for (const [uid, conn] of this.byUser) {
      if (this.lists.get(uid) === null) jobs.push(this.track(this.load(uid, conn, false)));
      else if (this.unsaved.has(uid)) jobs.push(this.track(this.saveStatus(uid, conn, true)));
    }
    await Promise.allSettled(jobs);
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.retryMs <= 0) return;
    this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.retry(); }, this.retryMs);
    this.retryTimer.unref?.();
  }

  /** Nothing is kept here any more (the lobby has it): waits for lobby calls under way (server shutdown) */
  async save(): Promise<void> {
    await Promise.allSettled([...this.inflight]);
  }

  /** Timers off (a server that's done) */
  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.refreshTimer = this.retryTimer = null;
  }
}
