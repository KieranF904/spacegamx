/**
 * @contract client.ui.contributor-model
 * owns:       what the contributor panel shows of other people's notes, worked out without the DOM: the list (whose,
 *             where, status, sort), each row's line, which controls a viewer gets, and the detail view's HTML (the
 *             note, its votes and its comments)
 * needs:      ui/escape; npm: @space-game/common (world/contributorFeedback's rules)
 * invariants: every piece of user text in the HTML goes through esc; edit and delete controls only for the author or
 *             an admin, vote buttons never on your own note, a comment's delete only for its author or an admin —
 *             client/src/ui/contributorModel.test.ts
 * extend:     a new control is a flag in noteControls (from a rule in common) and its markup in detailHtml, wired by
 *             its data-d attribute in ContributorPanel.wireDetail
 */

/**
 * The contributor panel's model (ContributorPanel.ts draws and wires it).
 * The server enforces every rule (server/src/game/ContributorNotes.ts); the
 * same rules from common decide here which buttons are worth showing.
 */

import {
  NOTE_FEEDBACK_LIMITS, isNoteAuthor, mayDeleteComment, mayEditNote, mayVoteNote, noteComments, noteTally, sortNotes,
  type ContributorNote, type NoteActor, type NoteComment, type NoteSort, type NoteStatus, type NoteVote,
} from '@space-game/common';
import { esc } from './escape';

/** Who's looking: the signed-in pilot (the client has no account id, so authorship goes by name) */
export interface NoteViewer { name: string; isAdmin: boolean }

/** The author filter's "Mine" (no username can be this) */
export const MINE = '\u0000me';

export type NoteScope = 'here' | 'all';

export interface NoteListFilter {
  /** The system you're in */
  system: string;
  /** Notes here, or in every system */
  scope: NoteScope;
  /** '': everyone's; MINE; else one author's name */
  author: string;
  status: NoteStatus | 'all';
  sort: NoteSort;
}

export const STATUS_WORD: Record<NoteStatus, string> = { open: 'Open', done: 'Done', wontdo: "Won't do" };

const actor = (v: NoteViewer): NoteActor => ({ username: v.name, userId: null, isAdmin: v.isAdmin });

/** Which controls a viewer gets on a note */
export function noteControls(n: ContributorNote, v: NoteViewer): { mine: boolean; edit: boolean; vote: boolean } {
  const a = actor(v);
  return { mine: isNoteAuthor(a, n), edit: mayEditNote(a, n), vote: mayVoteNote(a, n) };
}

export function mayRemoveComment(c: NoteComment, v: NoteViewer): boolean {
  return mayDeleteComment(actor(v), c);
}

/** The vote to send when a thumb is pressed: pressing the one you gave takes it back */
export function nextVote(mine: NoteVote | 0 | undefined, pressed: NoteVote): NoteVote | 0 {
  return mine === pressed ? 0 : pressed;
}

/** The notes the list shows, sorted */
export function listNotes(notes: Iterable<ContributorNote>, f: NoteListFilter, v: NoteViewer): ContributorNote[] {
  const a = actor(v);
  const kept = [...notes].filter((n) => (f.scope === 'all' || n.system === f.system)
    && (!f.author || (f.author === MINE ? isNoteAuthor(a, n) : n.author === f.author))
    && (f.status === 'all' || n.status === f.status));
  return sortNotes(kept, f.sort);
}

/** The authors to offer in the filter, A to Z */
export function noteAuthors(notes: Iterable<ContributorNote>, f: Pick<NoteListFilter, 'system' | 'scope'>): string[] {
  const names = new Set<string>();
  for (const n of notes) if (f.scope === 'all' || n.system === f.system) names.add(n.author);
  return [...names].sort((x, y) => x.localeCompare(y));
}

/** "just now", "5 min ago", "3 h ago", "2 d ago", then the date */
export function fmtWhen(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)} d ago`;
  return iso.slice(0, 10);
}

/** A list row's counts: thumbs and comments */
export function noteCounts(n: ContributorNote): { up: number; down: number; comments: number } {
  return { ...noteTally(n), comments: noteComments(n).length };
}

/** A list row's second line (plain text: escape it): who, when, edited, and the system when listing them all */
export function rowMeta(n: ContributorNote, now: number, systemName?: string): string {
  return [n.author, systemName, fmtWhen(n.createdAt, now), n.editedAt ? 'edited' : ''].filter(Boolean).join(' · ');
}

export interface DetailView {
  viewer: NoteViewer;
  now: number;
  systemName: string;
  /** The note is in the system you're in (Look works) */
  here: boolean;
  canWarp: boolean;
  looking: boolean;
  /** A delete waiting on its second press: the note's id or a comment's */
  armed: string | null;
  /** What's typed in the comment box */
  commentText: string;
  message: { ok: boolean; text: string } | null;
}

/** The detail view: the note in full, its votes, what can be done with it, and its comments (oldest first) */
export function detailHtml(n: ContributorNote, d: DetailView): string {
  const can = noteControls(n, d.viewer);
  const votes = n.votes ?? { ...noteTally(n), mine: 0 as const };
  const comments = noteComments(n);
  const when = (iso: string) => `<span title="${esc(iso)}">${esc(fmtWhen(iso, d.now))}</span>`;
  const edited = n.editedAt ? ` · edited ${when(n.editedAt)}${n.editedBy ? ` by ${esc(n.editedBy)}` : ''}` : '';
  const thumb = (v: NoteVote, count: number) => (can.vote
    ? `<button class="ctb-btn sm${votes.mine === v ? ' on' : ''}" data-d="${v === 1 ? 'up' : 'down'}" title="${votes.mine === v ? 'Take your vote back' : v === 1 ? 'Thumbs up' : 'Thumbs down'}">${v === 1 ? '👍' : '👎'} ${count}</button>`
    : `<span class="ctb-count" data-count="${v === 1 ? 'up' : 'down'}">${v === 1 ? '👍' : '👎'} ${count}</span>`);
  return `<div class="ctb-detail" data-detail="${esc(n.id)}">
      <div class="ctb-row"><button class="ctb-btn sm" data-d="back">← Notes</button><span class="ctb-hint">${esc(d.systemName)}</span></div>
      <div class="ctb-dt"><i style="background:${esc(n.color)}"></i><span>${esc(n.title)}</span> <span class="ctb-tag${n.status !== 'open' ? ` ${n.status}` : ''}">${STATUS_WORD[n.status]}</span></div>
      <div class="ctb-dsub">by ${esc(n.author)}${can.mine ? ' (you)' : ''} · ${when(n.createdAt)}${edited}</div>
      ${n.text ? `<div class="ctb-dtext">${esc(n.text)}</div>` : ''}
      ${n.sizeHint ? `<div class="ctb-hint">Size: ${esc(n.sizeHint)}</div>` : ''}
      ${n.status !== 'open' && (n.resolution || n.statusBy) ? `<div class="ctb-hint">${STATUS_WORD[n.status]}${n.statusBy ? ` (${esc(n.statusBy)})` : ''}${n.resolution ? `: ${esc(n.resolution)}` : ''}</div>` : ''}
      <div class="ctb-row ctb-votes">${thumb(1, votes.up)}${thumb(-1, votes.down)}${can.vote ? '' : '<span class="ctb-hint">your own note</span>'}</div>
      <div class="ctb-row">
        <button class="ctb-btn sm" data-d="fly" title="Autopilot there">Fly</button>
        ${d.here ? `<button class="ctb-btn sm${d.looking ? ' on' : ''}" data-d="look" title="Camera to it (Esc: back)">Look</button>` : ''}
        ${d.canWarp ? '<button class="ctb-btn sm" data-d="warp" title="Warp there (dev tool)">Warp</button>' : ''}
        ${can.edit ? `<button class="ctb-btn sm" data-d="edit">Edit</button>
        <select class="ctb-in" data-d="status" style="font-size:11px;padding:0 2px">${(['open', 'done', 'wontdo'] as const).map((s) => `<option value="${s}"${s === n.status ? ' selected' : ''}>${STATUS_WORD[s]}</option>`).join('')}</select>
        <button class="ctb-btn sm bad" data-d="delete">${d.armed === n.id ? 'Sure? Delete' : 'Delete'}</button>` : ''}
      </div>
      <div class="ctb-msg ${d.message?.ok ? 'ok' : 'bad'}">${esc(d.message?.text ?? '')}</div>
      <div class="ctb-sec">Comments (${comments.length})</div>
      <div class="ctb-comments">${comments.length ? comments.map((c) => `<div class="ctb-cmt" data-cid="${esc(c.id)}">
        <div class="who"><b>${esc(c.author)}</b> · ${when(c.at)}${mayRemoveComment(c, d.viewer) ? `<span class="ctb-grow"></span><button class="ctb-btn sm bad" data-d="uncomment">${d.armed === c.id ? 'Sure?' : 'Delete'}</button>` : ''}</div>
        <div class="txt">${esc(c.text)}</div>
      </div>`).join('') : '<div class="ctb-hint">No comments yet.</div>'}</div>
      ${comments.length >= NOTE_FEEDBACK_LIMITS.commentsPerNote ? '<div class="ctb-hint">This note has as many comments as it keeps.</div>' : `
      <textarea class="ctb-in" data-k="comment" maxlength="${NOTE_FEEDBACK_LIMITS.comment}" placeholder="Add a comment. Ctrl+Enter posts it.">${esc(d.commentText)}</textarea>
      <div class="ctb-row"><button class="ctb-btn" data-d="post">Post comment</button></div>`}
    </div>`;
}
