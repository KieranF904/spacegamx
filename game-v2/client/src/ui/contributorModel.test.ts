import { describe, it, expect } from 'vitest';
import type { ContributorNote } from '@space-game/common';
import { MINE, detailHtml, fmtWhen, listNotes, mayRemoveComment, nextVote, noteAuthors, noteControls, noteCounts, rowMeta, type DetailView, type NoteListFilter } from './contributorModel';

const NOW = Date.parse('2026-11-12T12:00:00.000Z');
const note = (o: Partial<ContributorNote> = {}): ContributorNote => ({
  id: 'n_1', author: 'alice', authorId: 11, createdAt: '2026-11-10T12:00:00.000Z', updatedAt: '2026-11-10T12:00:00.000Z',
  system: 'sol', title: 'Water world', text: 'A planet here', status: 'open', shape: { kind: 'point' }, color: '#38bdf8',
  anchor: { kind: 'fixed', x: 0, y: 0 }, comments: [], votes: { up: 0, down: 0, mine: 0 }, ...o,
});
const alice = { name: 'Alice', isAdmin: false };
const bob = { name: 'bob', isAdmin: false };
const boss = { name: 'boss', isAdmin: true };
const view = (o: Partial<DetailView> = {}): DetailView => ({ viewer: bob, now: NOW, systemName: 'Sol System', here: true, canWarp: false, looking: false, armed: null, commentText: '', message: null, ...o });
const filter = (o: Partial<NoteListFilter> = {}): NoteListFilter => ({ system: 'sol', scope: 'here', author: '', status: 'open', sort: 'newest', ...o });

const notes = [
  note({ id: 'a1', votes: { up: 1, down: 0, mine: 0 } }),
  note({ id: 'b1', author: 'bob', authorId: 12, createdAt: '2026-11-11T12:00:00.000Z', votes: { up: 0, down: 2, mine: 0 } }),
  note({ id: 'b2', author: 'bob', authorId: 12, createdAt: '2026-11-09T12:00:00.000Z', status: 'done', votes: { up: 5, down: 0, mine: 1 } }),
  note({ id: 'c1', author: 'cy', authorId: 13, system: 'ashfall', createdAt: '2026-11-12T11:00:00.000Z', votes: { up: 3, down: 0, mine: 0 } }),
];

describe('the contributor list', () => {
  it('shows everyone\'s notes here, newest first; Mine and one author narrow it', () => {
    expect(listNotes(notes, filter(), bob).map((n) => n.id)).toEqual(['b1', 'a1']);
    expect(listNotes(notes, filter({ author: MINE }), bob).map((n) => n.id)).toEqual(['b1']);
    expect(listNotes(notes, filter({ author: MINE }), alice).map((n) => n.id)).toEqual(['a1']);
    expect(listNotes(notes, filter({ author: 'alice' }), bob).map((n) => n.id)).toEqual(['a1']);
    expect(listNotes(notes, filter({ status: 'all', author: MINE }), bob).map((n) => n.id)).toEqual(['b1', 'b2']);
  });

  it('every system, most liked first (up minus down)', () => {
    expect(listNotes(notes, filter({ scope: 'all', status: 'all', sort: 'liked' }), bob).map((n) => n.id)).toEqual(['b2', 'c1', 'a1', 'b1']);
    expect(listNotes(notes, filter({ scope: 'all' }), bob).map((n) => n.id)).toEqual(['c1', 'b1', 'a1']);
  });

  it('offers the authors with notes in view', () => {
    expect(noteAuthors(notes, { system: 'sol', scope: 'here' })).toEqual(['alice', 'bob']);
    expect(noteAuthors(notes, { system: 'sol', scope: 'all' })).toEqual(['alice', 'bob', 'cy']);
  });

  it('a row says who, when, whether it was edited, and how it has been received', () => {
    expect(rowMeta(notes[0], NOW)).toBe('alice · 2 d ago');
    expect(rowMeta(note({ editedAt: '2026-11-11T00:00:00.000Z' }), NOW, 'Sol System')).toBe('alice · Sol System · 2 d ago · edited');
    expect(noteCounts(note({ votes: { up: 4, down: 1, mine: 0 }, comments: [{ id: 'c_1', author: 'bob', authorId: 12, at: '2026-11-11T12:00:00.000Z', text: 'x' }] }))).toEqual({ up: 4, down: 1, comments: 1 });
    // A note from an older server: no counts sent
    const { comments: _c, votes: _v, ...old } = note();
    expect(noteCounts(old)).toEqual({ up: 0, down: 0, comments: 0 });
  });

  it('writes times as how long ago, then the date', () => {
    const ago = (ms: number) => fmtWhen(new Date(NOW - ms).toISOString(), NOW);
    expect(ago(5_000)).toBe('just now');
    expect(ago(5 * 60_000)).toBe('5 min ago');
    expect(ago(3 * 3_600_000)).toBe('3 h ago');
    expect(ago(2 * 86_400_000)).toBe('2 d ago');
    expect(fmtWhen('2026-10-01T08:00:00.000Z', NOW)).toBe('2026-10-01');
    expect(fmtWhen('not a date', NOW)).toBe('');
    // (A clock a little behind the server's)
    expect(fmtWhen(new Date(NOW + 30_000).toISOString(), NOW)).toBe('just now');
  });
});

describe('which controls a viewer gets', () => {
  it('edit and delete on your own (admins: anyone\'s); votes on other people\'s only', () => {
    expect(noteControls(notes[0], alice)).toEqual({ mine: true, edit: true, vote: false });
    expect(noteControls(notes[0], bob)).toEqual({ mine: false, edit: false, vote: true });
    expect(noteControls(notes[0], boss)).toEqual({ mine: false, edit: true, vote: true });
    expect(noteControls(note({ author: 'boss' }), boss)).toEqual({ mine: true, edit: true, vote: false });
  });

  it('pressing the thumb you gave takes the vote back; the other one changes it', () => {
    expect(nextVote(0, 1)).toBe(1);
    expect(nextVote(undefined, -1)).toBe(-1);
    expect(nextVote(1, 1)).toBe(0);
    expect(nextVote(1, -1)).toBe(-1);
  });

  it('a comment\'s delete is its author\'s or an admin\'s', () => {
    const c = { id: 'c_1', author: 'bob', authorId: 12, at: '2026-11-11T12:00:00.000Z', text: 'x' };
    expect(mayRemoveComment(c, bob)).toBe(true);
    expect(mayRemoveComment(c, alice)).toBe(false);
    expect(mayRemoveComment(c, boss)).toBe(true);
  });
});

describe('the detail view', () => {
  const full = note({
    title: 'Water <world>', text: 'Line one\n<script>alert(1)</script>', editedAt: '2026-11-11T12:00:00.000Z', editedBy: 'boss', votes: { up: 3, down: 1, mine: 1 },
    comments: [
      { id: 'c_1', author: 'bob', authorId: 12, at: '2026-11-11T12:00:00.000Z', text: 'Bigger <img src=x onerror=alert(1)>' },
      { id: 'c_2', author: 'cy"><b>', authorId: 13, at: '2026-11-12T11:00:00.000Z', text: 'Agreed' },
    ],
  });

  it('escapes every piece of user text', () => {
    const html = detailHtml(full, view({ commentText: '</textarea><script>x</script>', message: { ok: false, text: '<i>no</i>' } }));
    expect(html).not.toMatch(/<script|<img|cy"|<i>no/);
    expect(html).toContain('Water &lt;world&gt;');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('cy&quot;&gt;&lt;b&gt;');
    expect(html).toContain('&lt;/textarea&gt;');
  });

  it('someone else\'s note: thumbs to press (yours lit), no edit or delete; your own comment can go', () => {
    const html = detailHtml(full, view());
    expect(html).toContain('data-d="up" title="Take your vote back">👍 3</button>');
    expect(html).toMatch(/class="ctb-btn sm on" data-d="up"/);
    expect(html).toContain('data-d="down" title="Thumbs down">👎 1</button>');
    expect(html).not.toMatch(/data-d="(edit|delete|status)"/);
    expect(html).toContain('by alice · ');
    expect(html).toContain('edited <span title="2026-11-11T12:00:00.000Z">1 d ago</span> by boss');
    expect(html).toContain('Comments (2)');
    // Oldest first, and only bob's own has a delete
    expect(html.indexOf('data-cid="c_1"')).toBeLessThan(html.indexOf('data-cid="c_2"'));
    expect(html.match(/data-d="uncomment"/g)).toHaveLength(1);
    expect(html).toContain('data-k="comment"');
  });

  it('your own note: counts without thumbs, with edit, status and delete', () => {
    const html = detailHtml(full, view({ viewer: alice, armed: 'n_1' }));
    expect(html).not.toMatch(/data-d="(up|down)"/);
    expect(html).toContain('data-count="up">👍 3</span>');
    expect(html).toContain('your own note');
    expect(html).toContain('by alice (you)');
    expect(html).toMatch(/data-d="edit"/);
    expect(html).toMatch(/data-d="status"/);
    expect(html).toContain('Sure? Delete');
    expect(html).not.toMatch(/data-d="uncomment"/);
  });

  it('an admin gets edit and delete on anyone\'s note, a delete on every comment, and still votes', () => {
    const html = detailHtml(full, view({ viewer: boss, canWarp: true }));
    expect(html).toMatch(/data-d="edit"/);
    expect(html).toMatch(/data-d="delete"/);
    expect(html).toMatch(/data-d="up"/);
    expect(html).toMatch(/data-d="warp"/);
    expect(html.match(/data-d="uncomment"/g)).toHaveLength(2);
  });

  it('a note in another system has no Look; a full thread has no comment box', () => {
    expect(detailHtml(full, view({ here: false }))).not.toMatch(/data-d="look"/);
    const many = note({ comments: Array.from({ length: 50 }, (_, i) => ({ id: `c_${i}`, author: 'bob', authorId: 12, at: '2026-11-11T12:00:00.000Z', text: `c${i}` })) });
    const html = detailHtml(many, view());
    expect(html).not.toContain('data-k="comment"');
    expect(html).toContain('as many comments as it keeps');
  });
});
