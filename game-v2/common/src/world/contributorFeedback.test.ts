import { describe, it, expect } from 'vitest';
import {
  NOTE_FEEDBACK_LIMITS, isNoteAuthor, mayEditNote, mayVoteNote, mayDeleteComment, voterKey, parseComment, parseVote,
  noteComments, withVote, noteTally, noteScore, noteForViewer, sortNotes, type NoteActor, type NoteComment,
} from './contributorFeedback.js';
import { formatNotes, type ContributorNote } from './contributorNotes.js';

const note = (o: Partial<ContributorNote> = {}): ContributorNote => ({
  id: 'n_1', author: 'alice', authorId: 11, createdAt: '2026-11-01T10:00:00.000Z', updatedAt: '2026-11-01T10:00:00.000Z',
  system: 'sol', title: 'Water world', text: 'A planet here', status: 'open', shape: { kind: 'point' }, color: '#38bdf8',
  anchor: { kind: 'fixed', x: 0, y: 0 }, ...o,
});
const alice: NoteActor = { username: 'alice', userId: 11, isAdmin: false };
const bob: NoteActor = { username: 'bob', userId: 12, isAdmin: false };
const boss: NoteActor = { username: 'boss', userId: 1, isAdmin: true };
const comment = (o: Partial<NoteComment> = {}): NoteComment => ({ id: 'c_1', author: 'bob', authorId: 12, at: '2026-11-02T09:00:00.000Z', text: 'Nice', ...o });

describe('who may do what on a contributor note', () => {
  it('the author is known by account id when both have one, else by name (any case)', () => {
    expect(isNoteAuthor(alice, note())).toBe(true);
    expect(isNoteAuthor(bob, note())).toBe(false);
    // Renamed since: still theirs; someone else who took the old name: not theirs
    expect(isNoteAuthor({ ...alice, username: 'alicia' }, note())).toBe(true);
    expect(isNoteAuthor({ username: 'alice', userId: 99, isAdmin: false }, note())).toBe(false);
    // No id on one side (a note granted from the terminal, a client's own view): the name decides
    expect(isNoteAuthor({ username: 'ALICE', userId: null, isAdmin: false }, note())).toBe(true);
    expect(isNoteAuthor(alice, note({ authorId: null, author: 'Alice' }))).toBe(true);
  });

  it('edit and delete: the author or an admin; vote: anyone but the author, admins included', () => {
    expect(mayEditNote(alice, note())).toBe(true);
    expect(mayEditNote(bob, note())).toBe(false);
    expect(mayEditNote(boss, note())).toBe(true);
    expect(mayVoteNote(alice, note())).toBe(false);
    expect(mayVoteNote(bob, note())).toBe(true);
    expect(mayVoteNote(boss, note())).toBe(true);
    expect(mayVoteNote(boss, note({ author: 'boss', authorId: 1 }))).toBe(false);
  });

  it('a comment is deleted by whoever wrote it or an admin, not by the note\'s author', () => {
    expect(mayDeleteComment(bob, comment())).toBe(true);
    expect(mayDeleteComment(alice, comment())).toBe(false);
    expect(mayDeleteComment(boss, comment())).toBe(true);
  });

  it('a vote is kept by account, or by name for one without an account', () => {
    expect(voterKey(alice)).toBe('u11');
    expect(voterKey({ username: 'Drifter', userId: null })).toBe('n:drifter');
  });
});

describe('comments and votes, cleaned', () => {
  it('takes a comment trimmed, without control characters, newlines kept', () => {
    expect(parseComment('  Looks good\u0007\nbut bigger\n\n\n\nplease ')).toEqual({ ok: true, value: 'Looks good\nbut bigger\n\nplease' });
    expect(parseComment('<b>hi</b>')).toEqual({ ok: true, value: '<b>hi</b>' });
    expect(parseComment('x'.repeat(NOTE_FEEDBACK_LIMITS.comment)).ok).toBe(true);
  });

  it('refuses an empty one, a long one and anything that isn\'t text', () => {
    for (const bad of ['', '   \n ', 'x'.repeat(NOTE_FEEDBACK_LIMITS.comment + 1), 5, null, undefined, { text: 'x' }]) expect(parseComment(bad).ok, String(bad).slice(0, 20)).toBe(false);
  });

  it('a vote is 1, -1 or 0', () => {
    expect([1, -1, 0].map(parseVote)).toEqual([1, -1, 0]);
    for (const bad of [2, -2, 0.5, '1', true, null, undefined, NaN]) expect(parseVote(bad)).toBeNull();
  });
});

describe('the tally', () => {
  it('one vote a voter: changing it replaces it, 0 removes it, the old record is left alone', () => {
    const a = withVote(undefined, 'u12', 1);
    const b = withVote(a, 'u12', -1);
    const c = withVote(withVote(b, 'u13', 1), 'u14', 1);
    expect(a).toEqual({ u12: 1 });
    expect(b).toEqual({ u12: -1 });
    expect(noteTally({ voters: c })).toEqual({ up: 2, down: 1 });
    expect(noteScore({ voters: c })).toBe(1);
    expect(withVote(c, 'u12', 0)).toEqual({ u13: 1, u14: 1 });
    expect(withVote(c, 'u99', 0)).toEqual(c);
  });

  it('a note stored before comments and votes has none of either', () => {
    const old = note();
    expect(noteComments(old)).toEqual([]);
    expect(noteTally(old)).toEqual({ up: 0, down: 0 });
    expect(noteScore(old)).toBe(0);
    expect(noteComments({ comments: 'junk' as unknown as NoteComment[] })).toEqual([]);
  });

  it('a client\'s copy is counted from what it was sent', () => {
    expect(noteTally({ votes: { up: 3, down: 1, mine: 1 } })).toEqual({ up: 3, down: 1 });
  });

  it('a viewer is sent the counts and their own vote, never who voted', () => {
    const n = note({ voters: { u12: 1, u13: -1, 'n:drifter': 1 }, comments: [comment()] });
    const forBob = noteForViewer(n, bob);
    expect(forBob.voters).toBeUndefined();
    expect(JSON.stringify(forBob)).not.toContain('u13');
    expect(forBob.votes).toEqual({ up: 2, down: 1, mine: 1 });
    expect(forBob.comments).toHaveLength(1);
    expect(noteForViewer(n, alice).votes).toEqual({ up: 2, down: 1, mine: 0 });
    expect(noteForViewer(n, { username: 'Drifter', userId: null }).votes?.mine).toBe(1);
    expect(noteForViewer(note(), bob)).toMatchObject({ comments: [], votes: { up: 0, down: 0, mine: 0 } });
    // The server's copy is untouched
    expect(n.voters).toEqual({ u12: 1, u13: -1, 'n:drifter': 1 });
  });

  it('sorts newest first, or most liked first (up minus down), ties by newest', () => {
    const list = [
      note({ id: 'old', createdAt: '2026-11-01T10:00:00.000Z', voters: { a: 1, b: 1, c: -1 } }),
      note({ id: 'mid', createdAt: '2026-11-02T10:00:00.000Z', voters: { a: -1 } }),
      note({ id: 'new', createdAt: '2026-11-03T10:00:00.000Z' }),
      note({ id: 'liked', createdAt: '2026-10-20T10:00:00.000Z', votes: { up: 4, down: 0, mine: 0 } }),
      note({ id: 'tie', createdAt: '2026-11-04T10:00:00.000Z', voters: { a: 1 } }),
    ];
    expect(sortNotes(list, 'newest').map((n) => n.id)).toEqual(['tie', 'new', 'mid', 'old', 'liked']);
    expect(sortNotes(list, 'liked').map((n) => n.id)).toEqual(['liked', 'tie', 'old', 'new', 'mid']);
    expect(list[0].id).toBe('old');
  });
});

describe('the terminal\'s print of votes and comments', () => {
  it('prints the counts, the edit, and each comment with its author and time', () => {
    const out = formatNotes([note({
      editedAt: '2026-11-03T08:30:00.000Z', editedBy: 'boss', voters: { u12: 1, u13: 1, u14: -1 },
      comments: [comment({ text: 'Make it bigger\nand bluer' }), comment({ id: 'c_2', author: 'cy', at: '2026-11-02T11:15:00.000Z', text: 'Agreed' })],
    })], { bodiesOf: () => ({}), tick: 0 });
    expect(out).toContain('updated 2026-11-01 10:00 UTC · edited 2026-11-03 08:30 UTC by boss');
    expect(out).toContain('  Votes: 2 up, 1 down (score +1)');
    expect(out).toContain('  Comments (2):\n    bob (2026-11-02 09:00 UTC): Make it bigger\n      and bluer\n    cy (2026-11-02 11:15 UTC): Agreed');
  });

  it('an old note prints no votes and no comments section', () => {
    const out = formatNotes([note()], { bodiesOf: () => ({}), tick: 0 });
    expect(out).toContain('  Votes: 0 up, 0 down (score +0)');
    expect(out).not.toContain('Comments');
    expect(out).not.toContain('edited');
  });
});
