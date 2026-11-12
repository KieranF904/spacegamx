/**
 * @contract world.contributor-feedback
 * owns:       the rules about people on contributor notes: who wrote a note, who may edit, delete, vote and comment;
 *             comments and votes (limits, cleaning, the tally), what a viewer is sent, and the list's sort
 * needs:      type-only import of world/contributorNotes
 * invariants: a note's `voters` never leave the server (noteForViewer drops them); one vote a voter key; nobody votes
 *             on their own note; a note stored before comments and votes existed reads as none of either —
 *             common/src/world/contributorFeedback.test.ts
 * extend:     a new rule is a pure function here, used by the server (server/src/game/ContributorNotes.ts) and the
 *             panel (client/src/ui/contributorModel.ts) alike
 */

/**
 * Feedback on contributor notes (world/contributorNotes.ts has the notes):
 * contributors see each other's notes, comment on any of them and give other
 * people's a thumbs up or down. Admins may edit or delete any note and delete
 * any comment. All of it pure: the server enforces these rules, the panel
 * uses the same ones to decide which controls to show.
 */

import type { ContributorNote } from './contributorNotes.js';

/** A thumbs up or a thumbs down */
export type NoteVote = 1 | -1;

export interface NoteComment {
  id: string;
  /** Username, and account id (null: a guest on a dev server) */
  author: string;
  authorId: number | null;
  /** ISO time */
  at: string;
  text: string;
}

/** A note's votes as a client is sent them: the counts and the viewer's own (0: none) */
export interface NoteVotes { up: number; down: number; mine: NoteVote | 0 }

/** Whoever is acting or looking (a connection on the server; the signed-in pilot on a client, `userId` null there) */
export interface NoteActor { username: string; userId: number | null; isAdmin: boolean }

export const NOTE_FEEDBACK_LIMITS = {
  /** A comment's length */
  comment: 500,
  /** Comments one note keeps */
  commentsPerNote: 50,
} as const;

export type NoteSort = 'newest' | 'liked';

// ============================================
// Who may do what
// ============================================

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Did this actor write it: by account id when both have one, else by name */
function wrote(a: NoteActor, author: string, authorId: number | null): boolean {
  return authorId !== null && a.userId !== null ? authorId === a.userId : sameName(author, a.username);
}

export function isNoteAuthor(a: NoteActor, n: Pick<ContributorNote, 'author' | 'authorId'>): boolean {
  return wrote(a, n.author, n.authorId);
}

/** Edit, delete and set the status: its author, or an admin */
export function mayEditNote(a: NoteActor, n: Pick<ContributorNote, 'author' | 'authorId'>): boolean {
  return a.isAdmin || isNoteAuthor(a, n);
}

/** Thumbs up or down: anyone's note but your own (admins too) */
export function mayVoteNote(a: NoteActor, n: Pick<ContributorNote, 'author' | 'authorId'>): boolean {
  return !isNoteAuthor(a, n);
}

/** Delete a comment: whoever wrote it, or an admin */
export function mayDeleteComment(a: NoteActor, c: Pick<NoteComment, 'author' | 'authorId'>): boolean {
  return a.isAdmin || wrote(a, c.author, c.authorId);
}

/** The key an actor's vote is kept under: the account, or the name for one without an account */
export function voterKey(a: Pick<NoteActor, 'username' | 'userId'>): string {
  return a.userId !== null ? `u${a.userId}` : `n:${a.username.toLowerCase()}`;
}

// ============================================
// Cleaning what a client sends
// ============================================

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** A comment's text: no control characters (newlines kept), trimmed, 1 to NOTE_FEEDBACK_LIMITS.comment long */
export function parseComment(raw: unknown): Parsed<string> {
  if (typeof raw !== 'string') return { ok: false, error: 'No comment' };
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return { ok: false, error: 'Type a comment first' };
  if (clean.length > NOTE_FEEDBACK_LIMITS.comment) return { ok: false, error: `That comment is too long (up to ${NOTE_FEEDBACK_LIMITS.comment} characters)` };
  return { ok: true, value: clean };
}

/** A vote: 1 (up), -1 (down) or 0 (take it back); anything else is null */
export function parseVote(raw: unknown): NoteVote | 0 | null {
  return raw === 1 || raw === -1 || raw === 0 ? raw : null;
}

// ============================================
// Votes and comments on a note
// ============================================

/** A note's comments, oldest first (none on a note stored before there were any) */
export function noteComments(n: Pick<ContributorNote, 'comments'>): NoteComment[] {
  return Array.isArray(n.comments) ? n.comments : [];
}

/** The voters with `key`'s vote set (0: removed); a fresh object, the old one untouched */
export function withVote(voters: Readonly<Record<string, NoteVote>> | undefined, key: string, vote: NoteVote | 0): Record<string, NoteVote> {
  const next: Record<string, NoteVote> = { ...(voters ?? {}) };
  if (vote === 0) delete next[key]; else next[key] = vote;
  return next;
}

/** Thumbs up and down: counted from the voters (the server's copy), else as sent (a client's) */
export function noteTally(n: Pick<ContributorNote, 'voters' | 'votes'>): { up: number; down: number } {
  if (n.voters && typeof n.voters === 'object') {
    let up = 0, down = 0;
    for (const v of Object.values(n.voters)) { if (v === 1) up++; else if (v === -1) down++; }
    return { up, down };
  }
  return { up: n.votes?.up ?? 0, down: n.votes?.down ?? 0 };
}

/** Up minus down: what "most liked" sorts by */
export function noteScore(n: Pick<ContributorNote, 'voters' | 'votes'>): number {
  const t = noteTally(n);
  return t.up - t.down;
}

/** A note as one viewer is sent it: the tally and their own vote, never who voted */
export function noteForViewer(n: ContributorNote, viewer: Pick<NoteActor, 'username' | 'userId'>): ContributorNote {
  const { voters, ...rest } = n;
  const mine = voters?.[voterKey(viewer)];
  return { ...rest, comments: noteComments(n), votes: { ...noteTally(n), mine: mine === 1 || mine === -1 ? mine : 0 } };
}

/** Newest first, or most liked first (ties: newest first) */
export function sortNotes<T extends Pick<ContributorNote, 'createdAt' | 'voters' | 'votes'>>(notes: readonly T[], by: NoteSort): T[] {
  const newest = (a: T, b: T) => b.createdAt.localeCompare(a.createdAt);
  return [...notes].sort(by === 'liked' ? (a, b) => noteScore(b) - noteScore(a) || newest(a, b) : newest);
}
