/**
 * Friends, status and private messages.
 *
 *   Friends    signed-in accounts only (guests have none). Ask by name, the other side accepts or declines,
 *              either side removes. Kept in the 'social' document (friendsDoc.ts), so it lasts across sessions
 *              and changes reach accounts that are not online.
 *   Status     Online, Away, Busy or Appear offline, saved per account (a guest's lasts the session). Friends
 *              see it in their list; Appear offline shows you as offline to everyone, private messages included.
 *   Private    to any pilot online by name, guests too. Never stored: a pilot who is offline (or appears so)
 *              is not sent it, and the sender is told so. Busy and Away pilots get it, and the sender is told
 *              they may not answer.
 *
 * Everything a client sends is checked here (names, text, status), and requests and messages are rate limited
 * per connection, admins included (dispatch's MESSAGE_LIMITS drop floods before this).
 */
import type { ServerMessage, SocialStatus, FriendPresence, FriendView } from '@space-game/common';
import { isSocialStatus } from '@space-game/common';
import type { PilotConn } from '../Pilots.js';
import type { ProfileStore } from '../../profile/ProfileStore.js';
import { activity } from '../../activity/index.js';
import { SOCIAL_DOC, emptyDoc, parseDoc, touch, findByName, request, respond, unfriend, forget, type SocialDoc } from './friendsDoc.js';

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

export class Social {
  private doc: SocialDoc = emptyDoc();
  private loaded = false;
  private waiting: (() => void)[] = [];
  /** Who each joined connection is (its account id, or null for a guest) */
  private joined = new Map<PilotConn, number | null>();
  /** The connection on each account */
  private byUser = new Map<number, PilotConn>();
  private guestStatus = new WeakMap<PilotConn, SocialStatus>();
  private limits = new WeakMap<PilotConn, { whisper: Window; request: Window; status: Window }>();
  private saving: Promise<void> | null = null;
  private saveAgain = false;
  /** Resolves once the document has loaded (tests) */
  readonly ready: Promise<void>;

  constructor(private host: SocialHost, private store: ProfileStore) {
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    try {
      this.doc = parseDoc(await this.store.loadDoc(SOCIAL_DOC));
    } catch (e) {
      console.error('[Social] could not load the friends document:', e);
    }
    this.loaded = true;
    for (const fn of this.waiting.splice(0)) fn();
  }

  /** Run now, or once loaded (a pilot can arrive before the document has) */
  private when(fn: () => void): void {
    if (this.loaded) fn(); else this.waiting.push(fn);
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
      if (uid !== null) {
        touch(this.doc, uid, conn.username);
        this.byUser.set(uid, conn);
        this.dirty();
        this.pushFriendsOf(uid);
      }
      this.sendList(conn);
    });
  }

  /** Disconnected */
  leave(conn: PilotConn): void {
    const uid = this.joined.get(conn);
    this.joined.delete(conn);
    if (uid === undefined || uid === null || this.byUser.get(uid) !== conn) return;
    this.byUser.delete(uid);
    this.pushFriendsOf(uid);
  }

  /** What others see of an account */
  presence(uid: number): FriendPresence {
    if (!this.byUser.has(uid)) return 'offline';
    const s = this.doc.accounts[uid]?.status ?? 'online';
    return s === 'invisible' ? 'offline' : s;
  }

  private statusOf(conn: PilotConn): SocialStatus {
    const uid = this.joined.get(conn) ?? conn.userId;
    return uid !== null && uid !== undefined ? this.doc.accounts[uid]?.status ?? 'online' : this.guestStatus.get(conn) ?? 'online';
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
      if (uid === null) this.guestStatus.set(conn, status);
      else {
        const a = this.doc.accounts[uid];
        if (!a || a.status === status) return this.sendList(conn);
        a.status = status;
        this.dirty();
        this.pushFriendsOf(uid);
      }
      this.sendList(conn);
    });
  }

  // ---------------------------------------------------------------------------
  // Friends
  // ---------------------------------------------------------------------------

  /** Ask a pilot (by name) to be friends */
  request(conn: PilotConn, name: unknown): void {
    const n = typeof name === 'string' ? name.trim().slice(0, 40) : '';
    if (!n) return;
    this.when(() => {
      const me = this.account(conn);
      if (me === null) return this.host.toast(conn, 'Sign in to add friends', 'warn');
      if (!this.limit(conn).request.take(this.host.now())) return this.host.toast(conn, 'Too many friend requests: try again later', 'warn');
      const online = this.onlineByName(n);
      const to = online?.userId ?? findByName(this.doc, n);
      if (online && online.userId === null) return this.host.toast(conn, "Guests can't be added as friends", 'warn');
      if (to === undefined || to === null) return this.host.toast(conn, `No pilot called ${n} has flown here`, 'warn');
      if (to === me) return this.host.toast(conn, "You can't add yourself", 'warn');
      const them = this.doc.accounts[to]?.name ?? n;
      const r = request(this.doc, me, to);
      switch (r) {
        case 'sent': {
          this.dirty();
          activity.social(conn, 'friend requests');
          this.host.toast(conn, `Friend request sent to ${them}`, 'info');
          const other = this.byUser.get(to);
          if (other) { this.host.send(other, { type: 'friendRequest', from: conn.username }); this.sendList(other); }
          this.sendList(conn);
          return;
        }
        case 'accepted':
          this.dirty();
          activity.social(conn, 'friends accepted');
          this.befriended(me, to);
          return;
        case 'already': return this.host.toast(conn, `${them} is already your friend`, 'info');
        case 'pending': return this.host.toast(conn, `You already asked ${them}`, 'info');
        case 'full': return this.host.toast(conn, 'Your friends list is full', 'warn');
        case 'theirFull': return this.host.toast(conn, `${them}'s friends list is full`, 'warn');
        case 'busy': return this.host.toast(conn, `${them} has too many requests waiting`, 'warn');
        default: return this.host.toast(conn, `No pilot called ${n} has flown here`, 'warn');
      }
    });
  }

  respond(conn: PilotConn, name: unknown, accept: unknown): void {
    const n = typeof name === 'string' ? name.trim().slice(0, 40) : '';
    if (!n) return;
    this.when(() => {
      const me = this.account(conn);
      const from = findByName(this.doc, n);
      if (me === null || from === undefined || !this.doc.accounts[me]?.in.includes(from)) return this.host.toast(conn, 'That request has gone', 'warn');
      const ok = respond(this.doc, me, from, accept === true);
      this.dirty();
      activity.social(conn, ok ? 'friends accepted' : 'requests declined');
      if (ok) return this.befriended(me, from);
      if (accept === true) this.host.toast(conn, 'A friends list is full', 'warn');
      this.sendList(conn);
      const other = this.byUser.get(from);
      if (other) this.sendList(other);
    });
  }

  /** Remove a friend (or take back a request, or turn one down) */
  remove(conn: PilotConn, name: unknown): void {
    const n = typeof name === 'string' ? name.trim().slice(0, 40) : '';
    if (!n) return;
    this.when(() => {
      const me = this.account(conn);
      const other = findByName(this.doc, n);
      if (me === null || other === undefined) return;
      const wasFriend = !!this.doc.accounts[me]?.friends.includes(other);
      if (!unfriend(this.doc, me, other)) return;
      this.dirty();
      if (wasFriend) activity.social(conn, 'friends removed');
      if (wasFriend) this.host.toast(conn, `${this.doc.accounts[other]?.name ?? n} is no longer on your friends list`, 'info');
      this.sendList(conn);
      const oc = this.byUser.get(other);
      if (oc) this.sendList(oc);
    });
  }

  private befriended(a: number, b: number): void {
    for (const [me, them] of [[a, b], [b, a]] as const) {
      const c = this.byUser.get(me);
      if (!c) continue;
      this.host.toast(c, `You and ${this.doc.accounts[them]?.name ?? 'they'} are friends now`, 'good');
      this.sendList(c);
    }
  }

  /** The friends list as this pilot sees it */
  list(conn: PilotConn): ServerMessage {
    const uid = this.joined.get(conn) ?? null;
    const a = uid !== null ? this.doc.accounts[uid] : undefined;
    const name = (id: number) => this.doc.accounts[id]?.name ?? '?';
    const friends: FriendView[] = (a?.friends ?? []).map((id) => ({ name: name(id), presence: this.presence(id) }))
      .sort((x, y) => Number(x.presence === 'offline') - Number(y.presence === 'offline') || x.name.localeCompare(y.name));
    return {
      type: 'friends', status: this.statusOf(conn), account: uid !== null, friends,
      incoming: (a?.in ?? []).map(name), outgoing: (a?.out ?? []).map(name),
    };
  }

  private sendList(conn: PilotConn): void {
    this.host.send(conn, this.list(conn));
  }

  /** Everyone online with this account on their list hears how it is now */
  private pushFriendsOf(uid: number): void {
    for (const f of this.doc.accounts[uid]?.friends ?? []) {
      const c = this.byUser.get(f);
      if (c) this.sendList(c);
    }
  }

  // ---------------------------------------------------------------------------
  // Private messages
  // ---------------------------------------------------------------------------

  whisper(conn: PilotConn, to: unknown, text: unknown): void {
    const name = typeof to === 'string' ? to.trim().slice(0, 40) : '';
    const body = typeof text === 'string' ? text.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, MESSAGE_MAX).trim() : '';
    if (!name || !body || !this.joined.has(conn)) return;
    const target = this.onlineByName(name);
    if (target === conn) return this.host.note(conn, "You can't send a private message to yourself", NOTE);
    if (!this.limit(conn).whisper.take(this.host.now())) return this.host.note(conn, 'Slow down: too many private messages at once.', '#fca5a5');
    // (Appear offline looks exactly like offline: nothing tells the sender otherwise)
    if (!target || this.shown(target) === 'offline') {
      const known = findByName(this.doc, name);
      return this.host.note(conn, `${known !== undefined ? this.doc.accounts[known].name : name} is offline. Private messages only reach pilots who are online.`, NOTE);
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

  /** An account was deleted (the lobby's list) */
  forget(uid: number): void {
    this.when(() => {
      const friends = [...(this.doc.accounts[uid]?.friends ?? []), ...(this.doc.accounts[uid]?.in ?? []), ...(this.doc.accounts[uid]?.out ?? [])];
      if (!forget(this.doc, uid)) return;
      this.dirty();
      for (const f of friends) { const c = this.byUser.get(f); if (c) this.sendList(c); }
    });
  }

  /** Changes are written at once, one write at a time (a change during a write is written right after) */
  private dirty(): void {
    void this.save();
  }

  async save(): Promise<void> {
    if (!this.loaded) return;
    if (this.saving) { this.saveAgain = true; return this.saving; }
    this.saving = (async () => {
      do {
        this.saveAgain = false;
        try {
          await this.store.saveDoc(SOCIAL_DOC, this.doc);
        } catch (e) {
          console.error('[Social] could not save the friends document:', e);
        }
      } while (this.saveAgain);
    })().finally(() => { this.saving = null; });
    return this.saving;
  }
}
