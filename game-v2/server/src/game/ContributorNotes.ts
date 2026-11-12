/**
 * Contributor notes and the contributor rank (common/src/world/contributorNotes.ts
 * has the model). Contributors, and admins (contributors by right), pin notes
 * and shapes to a system's map; only they are ever sent them, and only while
 * their overlay is on or they ask.
 *
 * Every op is checked here, never trusting the client: the rank (looked up
 * again on each message), ownership (your own notes; admins any), the draft
 * itself (parseNoteDraft), counts per author and in all, and a rate limit.
 * Contributors also comment on any note and give other people's a thumbs up
 * or down (the rules: common/src/world/contributorFeedback.ts). A note goes
 * out as its viewer's copy (noteForViewer): the vote counts and their own
 * vote, never who voted.
 *
 * Kept in data/contributor/ (excluded from deploys like data/telemetry):
 *   notes.json         every note, written atomically (temp file, rename);
 *                      a note's comments and voters ride on it, both absent
 *                      on notes stored before there were any (read as none)
 *   contributors.json  who has the rank: account id and username (an id of
 *                      null: granted by name while they were offline, filled
 *                      in when they next sign in). Granted by an admin, or
 *                      by donating (grantDonor; `revoked`: ids an admin took
 *                      it from, which donating doesn't give back)
 *   clock.json         the server tick and wall time, every 30 s, so the
 *                      terminal can work out where orbiting notes are now
 *   inbox/*.json       ops dropped in from the terminal (scripts/contributor-notes.mjs
 *                      --mark-done), applied and removed every few seconds
 * Without a store (tests, the browser proto) it all lives in memory. The disk
 * store is contribFiles.ts (kept apart: the browser proto bundles this file).
 */

import {
  NOTE_LIMITS, NOTE_FEEDBACK_LIMITS, parseNoteDraft, parseNoteStatus, parseComment, parseVote,
  isNoteAuthor, mayEditNote, mayVoteNote, mayDeleteComment, noteComments, noteForViewer, voterKey, withVote,
  type ContributorNote, type NoteBodies, type NoteComment, type ServerMessage,
} from '@space-game/common';

export interface ContribConn {
  username: string;
  userId: number | null;
  isAdmin: boolean;
  isContributor: boolean;
}

export interface ContribHost<C extends ContribConn> {
  /** Everyone connected */
  conns(): Iterable<C>;
  send(c: C, msg: ServerMessage): void;
  /** A system's bodies (null: no such system) */
  bodies(system: string): NoteBodies | null;
  tick(): number;
}

export interface RankEntry { id: number | null; username: string; grantedBy: string; grantedAt: string }

interface NotesFile { version: 1; notes: ContributorNote[] }
/** `revoked`: account ids an admin took the rank from, so a donation's grant (grantDonor) doesn't hand it straight back */
interface RanksFile { version: 1; contributors: RankEntry[]; revoked?: number[] }

/** Who a donation's grant is recorded as granted by (the lobby says who qualifies: server-browser/src/donations) */
export const DONOR_GRANT = 'donation';

/** Writes per minute (create, update, delete, status) and lists per minute, per connection */
const WRITES_PER_MIN = 20;
const READS_PER_MIN = 40;
/** Votes per minute (comments count as writes) */
const VOTES_PER_MIN = 60;
const CLOCK_EVERY_MS = 30_000;
const INBOX_EVERY_MS = 5_000;

/** A token bucket: `per` tokens a minute, up to a burst of a third of that */
class Bucket {
  private tokens: number;
  private at: number;
  constructor(private per: number, private now: () => number) { this.tokens = Math.max(3, per / 3); this.at = now(); }
  take(): boolean {
    const t = this.now();
    this.tokens = Math.min(Math.max(3, this.per / 3), this.tokens + ((t - this.at) / 60_000) * this.per);
    this.at = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export class ContributorNotes<C extends ContribConn> {
  private notes = new Map<string, ContributorNote>();
  private ranks: RankEntry[] = [];
  /** Accounts an admin took the rank from (see RanksFile) */
  private revoked = new Set<number>();
  /** Connections with the overlay on */
  private watching = new Set<C>();
  private buckets = new Map<C, { w: Bucket; r: Bucket; v: Bucket }>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private saving: Promise<void> | null = null;
  private dirty = { notes: false, ranks: false };

  /** `dir`: where it's kept (contribFiles.ts: data/contributor; null: in memory only) */
  constructor(private host: ContribHost<C>, private dir: ContribStore | null, private now: () => number = () => Date.now()) {
    if (!dir) return;
    const notes = dir.read('notes.json') as NotesFile | null;
    for (const n of notes?.notes ?? []) if (n && typeof n.id === 'string') this.notes.set(n.id, tidyStored(n));
    const ranks = dir.read('contributors.json') as RanksFile | null;
    this.ranks = ranks?.contributors ?? [];
    for (const id of Array.isArray(ranks?.revoked) ? ranks.revoked : []) if (Number.isSafeInteger(id)) this.revoked.add(id);
    console.log(`[contrib] ${this.notes.size} notes, ${this.ranks.length} contributors`);
    this.pollInbox();
    this.writeClock();
    this.timers.push(setInterval(() => this.writeClock(), CLOCK_EVERY_MS), setInterval(() => this.pollInbox(), INBOX_EVERY_MS));
    for (const t of this.timers) (t as { unref?: () => void }).unref?.();
  }

  // ---------------------------------------------------------------------------
  // The rank

  /** Can this connection use the tools (admins always can) */
  allowed(c: C): boolean {
    return c.isAdmin || c.isContributor;
  }

  /** Signed in (or not): does this account have the rank (an entry granted by name gets the account id now) */
  hasRank(userId: number | null, username: string): boolean {
    if (userId === null) return false;
    const low = username.toLowerCase();
    const e = this.ranks.find((r) => r.id === userId) ?? this.ranks.find((r) => r.id === null && r.username.toLowerCase() === low);
    if (!e) return false;
    if (e.id === null || e.username !== username) { e.id = userId; e.username = username; this.save('ranks'); }
    return true;
  }

  /** Who has the rank */
  contributors(): RankEntry[] {
    return this.ranks.map((r) => ({ ...r }));
  }

  /**
   * Grant or revoke the rank: `online` is that player's connection (null: not
   * on, granted by name and matched when they sign in). Guests can't have it.
   */
  setRank(name: string, online: C | null, on: boolean, by: string): { ok: boolean; text: string } {
    const low = (online?.username ?? name).toLowerCase();
    if (on) {
      if (online && online.userId === null) return { ok: false, text: `${online.username} is a guest: only signed-in accounts can be contributors` };
      const id = online?.userId ?? null;
      const has = this.ranks.find((r) => (id !== null && r.id === id) || r.username.toLowerCase() === low);
      if (has) {
        if (id !== null) has.id = id;
      } else {
        this.ranks.push({ id, username: online?.username ?? name, grantedBy: by, grantedAt: new Date(this.now()).toISOString() });
      }
      // (An admin's grant undoes an earlier revoke)
      for (const rid of [id, has?.id]) if (rid != null) this.revoked.delete(rid);
      this.save('ranks');
      if (online) this.setLive(online, true);
      return { ok: true, text: `${online?.username ?? name} is a contributor${online ? '' : ' (from their next sign-in)'}` };
    }
    const before = this.ranks.length;
    // (Remembered by account, so a donor's rank an admin took away isn't granted again by their donations)
    for (const r of this.ranks) if (r.id !== null && ((online?.userId != null && r.id === online.userId) || r.username.toLowerCase() === low)) this.revoked.add(r.id);
    this.ranks = this.ranks.filter((r) => !((online?.userId != null && r.id === online.userId) || r.username.toLowerCase() === low));
    if (online) this.setLive(online, false);
    if (this.ranks.length === before) return { ok: false, text: `${online?.username ?? name} isn't a contributor` };
    this.save('ranks');
    return { ok: true, text: `${online?.username ?? name} isn't a contributor any more` };
  }

  /**
   * The rank for an account the lobby says has donated enough (server-browser/src/donations, CONTRIBUTOR_AT): granted
   * once, as an admin's grant would be, and to `online` (their connection, if they're on) at once. Does nothing for an
   * account that has it already or that an admin took it from. Never takes the rank away. True when it granted.
   */
  grantDonor(userId: number, username: string, online: C | null): boolean {
    if (!Number.isSafeInteger(userId) || userId <= 0 || this.revoked.has(userId)) return false;
    if (this.hasRank(userId, username)) {
      // (Theirs already, but this connection hasn't been told: a sign-in before the grant)
      if (online && !online.isContributor) this.setLive(online, true);
      return false;
    }
    this.ranks.push({ id: userId, username, grantedBy: DONOR_GRANT, grantedAt: new Date(this.now()).toISOString() });
    this.save('ranks');
    if (online) this.setLive(online, true);
    console.log(`[contrib] ${username} is a contributor (donation)`);
    return true;
  }

  /** The rank changed for someone online: tell their client (an admin keeps the tools anyway) */
  private setLive(c: C, on: boolean): void {
    c.isContributor = on;
    if (!this.allowed(c)) this.watching.delete(c);
    this.host.send(c, { type: 'contribRank', on: this.allowed(c) });
  }

  /** A connection left */
  forget(c: C): void {
    this.watching.delete(c);
    this.buckets.delete(c);
  }

  // ---------------------------------------------------------------------------
  // Notes

  all(): ContributorNote[] {
    return [...this.notes.values()];
  }

  get(id: string): ContributorNote | undefined {
    return this.notes.get(id);
  }

  /** A `contrib` message (every op checks the rank first) */
  handle(c: C, msg: Record<string, unknown>): void {
    if (!this.allowed(c)) { this.reply(c, false, 'Contributors only'); return; }
    const op = msg.op;
    const read = op === 'overlay' || op === 'list';
    const b = this.bucket(c);
    if (!(read ? b.r : op === 'vote' ? b.v : b.w).take()) { this.reply(c, false, 'Slow down: too many note changes at once'); return; }
    const id = typeof msg.id === 'string' ? msg.id : '';
    switch (op) {
      case 'overlay':
        if (msg.on === true) {
          this.watching.add(c);
          if (typeof msg.system === 'string') this.sendList(c, msg.system);
        } else {
          this.watching.delete(c);
        }
        return;
      case 'list':
        this.sendList(c, typeof msg.system === 'string' ? msg.system : '*');
        return;
      case 'create': this.create(c, msg.note); return;
      case 'update': this.update(c, id, msg.note); return;
      case 'delete': this.remove(c, id); return;
      case 'deleteMany': this.removeMany(c, msg.ids); return;
      case 'status': this.setStatus(c, id, msg.status, msg.resolution); return;
      case 'comment': this.comment(c, id, msg.text); return;
      case 'commentDelete': this.commentDelete(c, id, msg.commentId); return;
      case 'vote': this.vote(c, id, msg.value); return;
    }
    this.reply(c, false, 'Unknown note op');
  }

  private sendList(c: C, system: string): void {
    const notes = this.all().filter((n) => system === '*' || n.system === system).map((n) => noteForViewer(n, c));
    this.host.send(c, { type: 'contribNotes', system, notes });
  }

  private create(c: C, raw: unknown): void {
    const d = parseNoteDraft(raw, (s) => this.host.bodies(s));
    if (!d.ok) { this.reply(c, false, d.error); return; }
    const mine = this.all().filter((n) => n.author.toLowerCase() === c.username.toLowerCase()).length;
    const cap = c.isAdmin ? NOTE_LIMITS.adminPerAuthor : NOTE_LIMITS.perAuthor;
    if (mine >= cap) { this.reply(c, false, `You have ${cap} notes already: delete some first`); return; }
    if (this.notes.size >= NOTE_LIMITS.total) { this.reply(c, false, 'The server has as many notes as it keeps'); return; }
    const at = new Date(this.now()).toISOString();
    let id = '';
    do id = `n_${randomHex(5)}`; while (this.notes.has(id));
    const note: ContributorNote = { id, author: c.username, authorId: c.userId, createdAt: at, updatedAt: at, status: 'open', ...d.value };
    this.notes.set(id, note);
    this.changed(note);
    console.log(`[contrib] ${c.username} made ${id} in ${note.system}: ${note.title}`);
    this.reply(c, true, `Note saved: ${note.title}`, id);
  }

  /** The author, or an admin */
  private mayEdit(c: C, n: ContributorNote): boolean {
    return mayEditNote(c, n);
  }

  private update(c: C, id: string, raw: unknown): void {
    const n = this.notes.get(id);
    if (!n) { this.reply(c, false, 'No such note'); return; }
    if (!this.mayEdit(c, n)) { this.reply(c, false, 'Only its author or an admin can change that note'); return; }
    const d = parseNoteDraft(raw, (s) => this.host.bodies(s));
    if (!d.ok) { this.reply(c, false, d.error); return; }
    const at = new Date(this.now()).toISOString();
    // (Its comments and votes stay with it; an admin's edit of someone else's says so)
    const next: ContributorNote = { ...n, ...d.value, updatedAt: at, editedAt: at };
    if (!d.value.sizeHint) delete next.sizeHint;
    if (isNoteAuthor(c, n)) delete next.editedBy; else next.editedBy = c.username;
    this.notes.set(id, next);
    this.changed(next);
    this.reply(c, true, `Note updated: ${next.title}`, id);
  }

  private remove(c: C, id: string): void {
    const n = this.notes.get(id);
    if (!n) { this.reply(c, false, 'No such note'); return; }
    if (!this.mayEdit(c, n)) { this.reply(c, false, 'Only its author or an admin can delete that note'); return; }
    this.notes.delete(id);
    this.save('notes');
    for (const w of this.watchers()) this.host.send(w, { type: 'contribNoteGone', id });
    console.log(`[contrib] ${c.username} deleted ${id}`);
    this.reply(c, true, `Note deleted: ${n.title}`, id);
  }

  /** Clearing up: every listed note this pilot may delete, as one write (at most 200 a go) */
  private removeMany(c: C, raw: unknown): void {
    const ids = Array.isArray(raw) ? [...new Set(raw.filter((x): x is string => typeof x === 'string'))].slice(0, 200) : [];
    const gone = ids.filter((id) => { const n = this.notes.get(id); return n && this.mayEdit(c, n); });
    if (!gone.length) { this.reply(c, false, 'None of those are yours to delete'); return; }
    for (const id of gone) this.notes.delete(id);
    this.save('notes');
    for (const w of this.watchers()) for (const id of gone) this.host.send(w, { type: 'contribNoteGone', id });
    console.log(`[contrib] ${c.username} deleted ${gone.length} notes: ${gone.join(', ')}`);
    this.reply(c, true, `Deleted ${gone.length} note${gone.length === 1 ? '' : 's'}${gone.length < ids.length ? ` (${ids.length - gone.length} not yours, left)` : ''}`);
  }

  private setStatus(c: C, id: string, status: unknown, resolution: unknown): void {
    const n = this.notes.get(id);
    if (!n) { this.reply(c, false, 'No such note'); return; }
    if (!this.mayEdit(c, n)) { this.reply(c, false, 'Only its author or an admin can set its status'); return; }
    const s = parseNoteStatus(status, resolution);
    if (!s.ok) { this.reply(c, false, s.error); return; }
    this.applyStatus(n, s.value.status, s.value.resolution, c.username);
    this.reply(c, true, `Marked ${s.value.status}: ${n.title}`, id);
  }

  private applyStatus(n: ContributorNote, status: ContributorNote['status'], resolution: string, by: string): ContributorNote {
    const next: ContributorNote = { ...n, status, statusBy: by, updatedAt: new Date(this.now()).toISOString() };
    if (resolution) next.resolution = resolution; else delete next.resolution;
    this.notes.set(n.id, next);
    this.changed(next);
    return next;
  }

  // ---------------------------------------------------------------------------
  // Comments and votes (any contributor, on any note; votes not on your own)

  private comment(c: C, id: string, raw: unknown): void {
    const n = this.notes.get(id);
    if (!n) { this.reply(c, false, 'No such note'); return; }
    const t = parseComment(raw);
    if (!t.ok) { this.reply(c, false, t.error); return; }
    const comments = noteComments(n);
    if (comments.length >= NOTE_FEEDBACK_LIMITS.commentsPerNote) { this.reply(c, false, `That note has ${NOTE_FEEDBACK_LIMITS.commentsPerNote} comments already`); return; }
    let cid = '';
    do cid = `c_${randomHex(4)}`; while (comments.some((x) => x.id === cid));
    const made: NoteComment = { id: cid, author: c.username, authorId: c.userId, at: new Date(this.now()).toISOString(), text: t.value };
    const next: ContributorNote = { ...n, comments: [...comments, made] };
    this.notes.set(id, next);
    this.changed(next);
    console.log(`[contrib] ${c.username} commented on ${id}`);
    this.reply(c, true, 'Comment added', id);
  }

  private commentDelete(c: C, id: string, commentId: unknown): void {
    const n = this.notes.get(id);
    const was = n ? noteComments(n).find((x) => x.id === commentId) : undefined;
    if (!n || !was) { this.reply(c, false, 'No such comment'); return; }
    if (!mayDeleteComment(c, was)) { this.reply(c, false, 'Only its author or an admin can delete that comment'); return; }
    const next: ContributorNote = { ...n, comments: noteComments(n).filter((x) => x.id !== was.id) };
    this.notes.set(id, next);
    this.changed(next);
    console.log(`[contrib] ${c.username} deleted ${was.author}'s comment ${was.id} on ${id}`);
    this.reply(c, true, 'Comment deleted', id);
  }

  private vote(c: C, id: string, raw: unknown): void {
    const n = this.notes.get(id);
    if (!n) { this.reply(c, false, 'No such note'); return; }
    const v = parseVote(raw);
    if (v === null) { this.reply(c, false, 'A vote is up, down or none'); return; }
    if (!mayVoteNote(c, n)) { this.reply(c, false, "You can't vote on your own note"); return; }
    const key = voterKey(c);
    if ((n.voters?.[key] ?? 0) === v) return;
    const next: ContributorNote = { ...n, voters: withVote(n.voters, key, v) };
    this.notes.set(id, next);
    this.changed(next);
  }

  /** Watchers who still have the rank */
  private *watchers(): Iterable<C> {
    for (const w of this.watching) if (this.allowed(w)) yield w;
  }

  private changed(n: ContributorNote): void {
    this.save('notes');
    for (const w of this.watchers()) this.host.send(w, { type: 'contribNote', note: noteForViewer(n, w) });
  }

  private reply(c: C, ok: boolean, text: string, id?: string): void {
    this.host.send(c, { type: 'contribResult', ok, text, ...(id ? { id } : {}) });
  }

  private bucket(c: C): { w: Bucket; r: Bucket; v: Bucket } {
    let b = this.buckets.get(c);
    if (!b) this.buckets.set(c, b = { w: new Bucket(WRITES_PER_MIN, this.now), r: new Bucket(READS_PER_MIN, this.now), v: new Bucket(VOTES_PER_MIN, this.now) });
    return b;
  }

  // ---------------------------------------------------------------------------
  // The terminal's inbox (scripts/contributor-notes.mjs --mark-done)

  /** Apply ops left in inbox/ (each a JSON file: { op: 'status', id, status, resolution?, by? }) */
  pollInbox(): number {
    if (!this.dir) return 0;
    let n = 0;
    for (const { name: f, op: raw } of this.dir.takeInbox()) {
      const op = raw as Record<string, unknown> | null;
      if (!op || op.op !== 'status' || typeof op.id !== 'string') { console.warn(`[contrib] inbox: ignored ${f}`); continue; }
      const note = this.notes.get(op.id);
      const s = parseNoteStatus(op.status, op.resolution);
      if (!note || !s.ok) { console.warn(`[contrib] inbox: ${f}: ${!note ? `no note ${op.id}` : s.ok ? '' : s.error}`); continue; }
      const by = typeof op.by === 'string' && op.by.trim() ? op.by.trim().slice(0, 40) : 'terminal';
      this.applyStatus(note, s.value.status, s.value.resolution, by);
      console.log(`[contrib] inbox: ${op.id} marked ${s.value.status} by ${by}`);
      n++;
    }
    return n;
  }

  // ---------------------------------------------------------------------------
  // Saving

  private writeClock(): void {
    if (!this.dir) return;
    try { this.dir.write('clock.json', JSON.stringify({ tick: this.host.tick(), at: this.now(), tickRate: 60 })); } catch (e) { console.warn('[contrib] clock write failed:', (e as Error).message); }
  }

  private save(what: 'notes' | 'ranks'): void {
    this.dirty[what] = true;
    if (!this.dir || this.saving) return;
    // (A moment's grace: a burst of changes is one write)
    this.saving = new Promise<void>((resolve) => setTimeout(resolve, 50)).then(() => this.writeDirty()).finally(() => {
      this.saving = null;
      if (this.dirty.notes || this.dirty.ranks) this.save(this.dirty.notes ? 'notes' : 'ranks');
    });
  }

  private writeDirty(): void {
    if (!this.dir) return;
    try {
      if (this.dirty.notes) {
        this.dirty.notes = false;
        this.dir.write('notes.json', JSON.stringify({ version: 1, notes: this.all() } satisfies NotesFile, null, 1));
      }
      if (this.dirty.ranks) {
        this.dirty.ranks = false;
        this.dir.write('contributors.json', JSON.stringify({ version: 1, contributors: this.ranks, ...(this.revoked.size ? { revoked: [...this.revoked] } : {}) } satisfies RanksFile, null, 1));
      }
    } catch (e) {
      console.warn('[contrib] save failed:', (e as Error).message);
    }
  }

  /** Everything written (shutdown, tests) */
  async flush(): Promise<void> {
    while (this.saving) await this.saving;
    this.writeDirty();
  }

  close(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}

/** Where notes, ranks and the clock are kept, and the terminal's inbox (contribFiles.ts: data/contributor/) */
export interface ContribStore {
  /** A file's parsed JSON (null: none, or unreadable) */
  read(name: string): unknown;
  /** Write a file whole (atomically) */
  write(name: string, text: string): void;
  /** The inbox's ops, oldest first, each taken out as it's read */
  takeInbox(): { name: string; op: unknown }[];
}

/**
 * A note as read from disk: one stored before comments and votes loads as it is (none of either); comments or voters
 * that aren't the right shape (a hand-edited file) are dropped rather than sent to clients
 */
function tidyStored(n: ContributorNote): ContributorNote {
  const badComments = n.comments !== undefined && !(Array.isArray(n.comments) && n.comments.every((c) => c && typeof c.id === 'string' && typeof c.author === 'string' && typeof c.at === 'string' && typeof c.text === 'string'));
  const badVoters = n.voters !== undefined && !(typeof n.voters === 'object' && n.voters !== null && !Array.isArray(n.voters) && Object.values(n.voters).every((v) => v === 1 || v === -1));
  // (A viewer's tally is worked out per send, never kept)
  if (!badComments && !badVoters && n.votes === undefined) return n;
  const { votes: _votes, ...rest } = n;
  if (badComments) delete rest.comments;
  if (badVoters) delete rest.voters;
  return rest;
}

/** `bytes` random bytes as hex (Web Crypto: the server and the browser proto both have it) */
function randomHex(bytes: number): string {
  const b = globalThis.crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}
