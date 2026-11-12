import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'path';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import * as bitecs from 'bitecs';
import { Position, Station, ServerMessage, stationPositionAt, type NoteDraft } from '@space-game/common';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { ContributorNotes, type ContribConn, type ContribHost } from './ContributorNotes.js';
import { contribFileStore } from './contribFiles.js';
import { makeServer } from '../testkits/world.testkit.js';

const dataDir = join(__dirname, '../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);
const gameData = new GameData(files);

/** Accounts: a token "tok:<id>:<name>" signs in as that account */
const userDB = {
  validateSession: async (t: string) => {
    const [, id, name] = t.split(':');
    return { id: Number(id), username: name, email: '', is_admin: name === 'boss', created_at: '' };
  },
  cleanupExpiredSessions: async () => {},
};

function world(clock = { t: Date.UTC(2026, 9, 25, 12) }) {
  resetGlobals();
  const server = makeServer({
    gameData: new GameData(files), userDB: userDB as any, clock: () => clock.t,
  });
  const join = async (name: string, id?: number) => {
    const t = new LocalTransport(server);
    const got: ServerMessage[] = [];
    t.onMessage = (m) => got.push(m);
    t.connect();
    t.send({ type: 'join', username: name, ...(id ? { token: `tok:${id}:${name}` } : {}) } as any);
    await new Promise((r) => setTimeout(r, 0));
    const pid = t.getPlayerId();
    const conn = [...(server as any).clients.values()].find((c: any) => c.playerId === pid);
    return { t, got, pid, conn, send: (m: object) => { t.send({ type: 'contrib', ...m } as any); server.step(); } };
  };
  return { server, join, clock };
}

const of = <T extends ServerMessage['type']>(got: ServerMessage[], type: T) => got.filter((m) => m.type === type) as Extract<ServerMessage, { type: T }>[];
const draft = (o: Partial<NoteDraft> = {}): NoteDraft => ({
  system: 'sol', title: 'Water world', text: 'Place a large water planet here the same size as the circle', color: '#38bdf8',
  shape: { kind: 'circle', radius: 4200 }, anchor: { kind: 'orbit', around: { kind: 'center' }, radius: 52000, phaseDeg: 30, periodMinutes: 45, direction: 1 }, ...o,
});

describe('contributor rank', () => {
  it('a non-contributor can\'t make notes or be sent them; a contributor can; admins are contributors', async () => {
    const { server, join } = world();
    const pilot = await join('pilot', 5);
    const helper = await join('helper', 6);
    const boss = await join('boss', 1);
    expect((of(pilot.got, 'authResult').at(-1) as any).isContributor).toBe(false);
    expect((of(boss.got, 'authResult').at(-1) as any).isContributor).toBe(true);

    pilot.send({ op: 'overlay', on: true, system: 'sol' });
    pilot.send({ op: 'create', note: draft() });
    expect(of(pilot.got, 'contribResult').every((r) => !r.ok)).toBe(true);
    expect(server.contrib.all()).toHaveLength(0);

    // The admin grants it by chat: live, and kept for their next sign-in
    boss.t.send({ type: 'chat', text: '/contributor helper on' } as any);
    server.step();
    expect(of(boss.got, 'adminResult').at(-1)?.ok).toBe(true);
    expect(of(helper.got, 'contribRank').at(-1)?.on).toBe(true);
    helper.send({ op: 'overlay', on: true, system: 'sol' });
    boss.send({ op: 'overlay', on: true, system: 'sol' });
    expect(of(helper.got, 'contribNotes').at(-1)?.notes).toEqual([]);
    helper.send({ op: 'create', note: draft() });
    const made = of(helper.got, 'contribResult').at(-1)!;
    expect(made.ok).toBe(true);
    const note = server.contrib.get(made.id!)!;
    expect(note.author).toBe('helper');
    expect(note.authorId).toBe(6);
    // Watchers with the rank hear of it; the pilot (overlay asked for, refused) hears nothing
    expect(of(boss.got, 'contribNote').map((m) => m.note.id)).toContain(note.id);
    expect(of(pilot.got, 'contribNote')).toHaveLength(0);
    expect(of(pilot.got, 'contribNotes')).toHaveLength(0);
    pilot.send({ op: 'list', system: '*' });
    expect(of(pilot.got, 'contribNotes')).toHaveLength(0);

    // Revoked: no more notes, even with the overlay still on
    boss.t.send({ type: 'chat', text: '/contributor helper off' } as any);
    server.step();
    expect(of(helper.got, 'contribRank').at(-1)?.on).toBe(false);
    const before = helper.got.length;
    boss.send({ op: 'create', note: draft({ title: 'Second' }) });
    expect(helper.got.slice(before).some((m) => m.type === 'contribNote')).toBe(false);
    helper.send({ op: 'create', note: draft() });
    expect(of(helper.got, 'contribResult').at(-1)?.ok).toBe(false);
  });

  it('a rank granted by name while offline applies at their next sign-in; guests can\'t have it', async () => {
    const { server, join } = world();
    const boss = await join('boss', 1);
    const guest = await join('drifter');
    boss.t.send({ type: 'chat', text: '/contributor drifter on' } as any);
    server.step();
    expect(of(boss.got, 'adminResult').at(-1)?.ok).toBe(false);
    boss.t.send({ type: 'chat', text: '/contributor Mapper on' } as any);
    server.step();
    expect(of(boss.got, 'adminResult').at(-1)?.text).toMatch(/next sign-in/);
    const mapper = await join('mapper', 42);
    expect((of(mapper.got, 'authResult').at(-1) as any).isContributor).toBe(true);
    expect(server.contrib.contributors()).toEqual([expect.objectContaining({ id: 42, username: 'mapper' })]);
    expect(guest.conn.isContributor).toBe(false);
    boss.t.send({ type: 'chat', text: '/contributors' } as any);
    server.step();
    expect(of(boss.got, 'adminResult').at(-1)?.text).toBe('Contributors: mapper');
    // A non-admin's /contributor is just chat
    mapper.t.send({ type: 'chat', text: '/contributor drifter on' } as any);
    server.step();
    expect(guest.conn.isContributor).toBe(false);
  });

  it('only the author or an admin edits, deletes or sets the status', async () => {
    const { server, join } = world();
    const a = await join('alice', 11); a.conn.isContributor = true;
    const b = await join('bob', 12); b.conn.isContributor = true;
    const boss = await join('boss', 1);
    a.send({ op: 'create', note: draft() });
    const id = of(a.got, 'contribResult').at(-1)!.id!;
    b.send({ op: 'update', id, note: draft({ title: 'Mine now' }) });
    b.send({ op: 'status', id, status: 'done' });
    b.send({ op: 'delete', id });
    expect(of(b.got, 'contribResult').every((r) => !r.ok)).toBe(true);
    expect(server.contrib.get(id)?.title).toBe('Water world');

    a.send({ op: 'update', id, note: draft({ title: 'Bigger water world', shape: { kind: 'circle', radius: 6000 } }) });
    expect(server.contrib.get(id)?.title).toBe('Bigger water world');
    boss.send({ op: 'update', id, note: draft({ title: 'Edited by an admin' }) });
    boss.send({ op: 'status', id, status: 'done', resolution: 'Added Halcyon II' });
    const n = server.contrib.get(id)!;
    expect(n).toMatchObject({ title: 'Edited by an admin', author: 'alice', status: 'done', resolution: 'Added Halcyon II', statusBy: 'boss' });
    boss.send({ op: 'delete', id });
    expect(server.contrib.get(id)).toBeUndefined();
  });

  it('an edit is marked with its time (and who, when it wasn\'t the author) and keeps the note\'s comments and votes', async () => {
    const { server, join, clock } = world();
    const a = await join('alice', 11); a.conn.isContributor = true;
    const b = await join('bob', 12); b.conn.isContributor = true;
    const boss = await join('boss', 1);
    a.send({ op: 'create', note: draft() });
    const id = of(a.got, 'contribResult').at(-1)!.id!;
    expect(server.contrib.get(id)!.editedAt).toBeUndefined();
    b.send({ op: 'vote', id, value: 1 });
    b.send({ op: 'comment', id, text: 'Bigger' });
    clock.t += 60_000;
    a.send({ op: 'update', id, note: draft({ text: 'Twice the size' }) });
    const mine = server.contrib.get(id)!;
    expect(mine.editedAt).toBe(new Date(clock.t).toISOString());
    expect(mine.editedBy).toBeUndefined();
    expect(mine.createdAt).not.toBe(mine.editedAt);
    clock.t += 60_000;
    boss.send({ op: 'update', id, note: draft({ title: 'Tidied' }) });
    const n = server.contrib.get(id)!;
    expect(n).toMatchObject({ title: 'Tidied', author: 'alice', authorId: 11, editedBy: 'boss', editedAt: new Date(clock.t).toISOString() });
    expect(n.comments).toHaveLength(1);
    expect(n.voters).toEqual({ u12: 1 });
    // The status alone isn't an edit of what it says
    boss.send({ op: 'status', id, status: 'done' });
    expect(server.contrib.get(id)!.editedAt).toBe(n.editedAt);
    // The author's own edit after an admin's is theirs again
    a.send({ op: 'update', id, note: draft({ title: 'Mine again' }) });
    expect(server.contrib.get(id)!.editedBy).toBeUndefined();
  });

  it('contributors see each other\'s notes, with the counts and their own vote, never who voted', async () => {
    const { server, join } = world();
    const a = await join('alice', 11); a.conn.isContributor = true;
    const b = await join('bob', 12); b.conn.isContributor = true;
    const c = await join('cy', 13); c.conn.isContributor = true;
    const pilot = await join('pilot', 5);
    for (const p of [a, b, c, pilot]) p.send({ op: 'overlay', on: true, system: 'sol' });
    a.send({ op: 'create', note: draft() });
    const id = of(a.got, 'contribResult').at(-1)!.id!;
    expect(of(b.got, 'contribNote').at(-1)!.note).toMatchObject({ id, author: 'alice', comments: [], votes: { up: 0, down: 0, mine: 0 } });

    b.send({ op: 'vote', id, value: 1 });
    c.send({ op: 'vote', id, value: -1 });
    expect(of(b.got, 'contribNote').at(-1)!.note.votes).toEqual({ up: 1, down: 1, mine: 1 });
    expect(of(c.got, 'contribNote').at(-1)!.note.votes).toEqual({ up: 1, down: 1, mine: -1 });
    expect(of(a.got, 'contribNote').at(-1)!.note.votes).toEqual({ up: 1, down: 1, mine: 0 });
    for (const p of [a, b, c]) expect(JSON.stringify(of(p.got, 'contribNote'))).not.toContain('voters');
    // A list says the same
    c.send({ op: 'list', system: '*' });
    const listed = of(c.got, 'contribNotes').at(-1)!.notes;
    expect(listed.map((n) => n.id)).toEqual([id]);
    expect(listed[0].votes).toEqual({ up: 1, down: 1, mine: -1 });
    expect(listed[0].voters).toBeUndefined();
    // A pilot without the rank gets none of it, and can't vote or comment
    pilot.send({ op: 'vote', id, value: 1 });
    pilot.send({ op: 'comment', id, text: 'Me too' });
    expect(of(pilot.got, 'contribNote')).toHaveLength(0);
    expect(of(pilot.got, 'contribResult').every((r) => !r.ok && r.text === 'Contributors only')).toBe(true);
    expect(server.contrib.get(id)).toMatchObject({ voters: { u12: 1, u13: -1 } });
    expect(server.contrib.get(id)!.comments ?? []).toHaveLength(0);
  });

  it('one vote an account a note: changed, taken back, never on your own, only up, down or none', async () => {
    const { server, join } = world();
    const a = await join('alice', 11); a.conn.isContributor = true;
    const b = await join('bob', 12); b.conn.isContributor = true;
    const boss = await join('boss', 1);
    a.send({ op: 'create', note: draft() });
    const id = of(a.got, 'contribResult').at(-1)!.id!;
    const voters = () => server.contrib.get(id)!.voters ?? {};

    b.send({ op: 'vote', id, value: 1 });
    b.send({ op: 'vote', id, value: 1 });
    expect(voters()).toEqual({ u12: 1 });
    b.send({ op: 'vote', id, value: -1 });
    expect(voters()).toEqual({ u12: -1 });
    boss.send({ op: 'vote', id, value: 1 });
    expect(voters()).toEqual({ u12: -1, u1: 1 });
    b.send({ op: 'vote', id, value: 0 });
    expect(voters()).toEqual({ u1: 1 });

    a.send({ op: 'vote', id, value: 1 });
    expect(of(a.got, 'contribResult').at(-1)).toMatchObject({ ok: false, text: "You can't vote on your own note" });
    for (const bad of [2, -5, '1', null, 0.5]) b.send({ op: 'vote', id, value: bad });
    b.send({ op: 'vote', id: 'n_nosuch', value: 1 });
    expect(of(b.got, 'contribResult').slice(-6).every((r) => !r.ok)).toBe(true);
    expect(voters()).toEqual({ u1: 1 });
    // An admin can't vote on their own either
    boss.send({ op: 'create', note: draft({ title: "Boss's" }) });
    const bid = of(boss.got, 'contribResult').at(-1)!.id!;
    boss.send({ op: 'vote', id: bid, value: 1 });
    expect(server.contrib.get(bid)!.voters).toBeUndefined();
  });

  it('comments: anyone with the rank adds one, cleaned and limited; its author or an admin deletes it', async () => {
    const { server, join, clock } = world();
    const a = await join('alice', 11); a.conn.isContributor = true;
    const b = await join('bob', 12); b.conn.isContributor = true;
    const boss = await join('boss', 1);
    for (const p of [a, b]) p.send({ op: 'overlay', on: true, system: 'sol' });
    a.send({ op: 'create', note: draft() });
    const id = of(a.got, 'contribResult').at(-1)!.id!;
    const comments = () => server.contrib.get(id)!.comments ?? [];

    b.send({ op: 'comment', id, text: '  Make it <b>bigger</b>\u0007 ' });
    clock.t += 5000;
    a.send({ op: 'comment', id, text: 'Will do' });
    expect(comments().map((c) => [c.author, c.authorId, c.text])).toEqual([['bob', 12, 'Make it <b>bigger</b>'], ['alice', 11, 'Will do']]);
    expect(comments()[1].at).toBe(new Date(clock.t).toISOString());
    expect(of(a.got, 'contribNote').at(-1)!.note.comments).toHaveLength(2);
    // The note's own times don't move for a comment
    expect(server.contrib.get(id)!.updatedAt).toBe(server.contrib.get(id)!.createdAt);

    for (const bad of ['', '   ', 'x'.repeat(501), 7, undefined]) { clock.t += 5000; b.send({ op: 'comment', id, text: bad }); }
    clock.t += 5000;
    b.send({ op: 'comment', id: 'n_nosuch', text: 'hello' });
    expect(of(b.got, 'contribResult').slice(-6).every((r) => !r.ok)).toBe(true);
    expect(comments()).toHaveLength(2);

    // Alice can't delete bob's comment, though the note is hers; bob can; an admin can delete anyone's
    const [bobs, alices] = comments();
    clock.t += 5000;
    a.send({ op: 'commentDelete', id, commentId: bobs.id });
    expect(of(a.got, 'contribResult').at(-1)!.ok).toBe(false);
    a.send({ op: 'commentDelete', id, commentId: 'c_nosuch' });
    expect(of(a.got, 'contribResult').at(-1)!.text).toBe('No such comment');
    expect(comments()).toHaveLength(2);
    b.send({ op: 'commentDelete', id, commentId: bobs.id });
    expect(comments().map((c) => c.id)).toEqual([alices.id]);
    boss.send({ op: 'commentDelete', id, commentId: alices.id });
    expect(comments()).toEqual([]);
    expect(of(b.got, 'contribNote').at(-1)!.note.comments).toEqual([]);

    // A note keeps so many comments
    for (let i = 0; i < 52; i++) { clock.t += 4000; b.send({ op: 'comment', id, text: `c${i}` }); }
    expect(comments()).toHaveLength(50);
    expect(of(b.got, 'contribResult').at(-1)!.text).toMatch(/50 comments already/);
  });

  it('clears up many at once (one change against the rate limit), leaving those that aren\'t yours', async () => {
    const { server, join, clock } = world();
    const a = await join('alice', 11); a.conn.isContributor = true;
    const b = await join('bob', 12); b.conn.isContributor = true;
    const mine: string[] = [];
    for (let i = 0; i < 8; i++) {
      a.send({ op: 'create', note: draft({ title: `Stray ${i}` }) });
      mine.push(of(a.got, 'contribResult').at(-1)!.id!);
      clock.t += 4000;
    }
    b.send({ op: 'create', note: draft({ title: "Bob's" }) });
    const bobs = of(b.got, 'contribResult').at(-1)!.id!;
    clock.t += 60_000;
    a.send({ op: 'deleteMany', ids: [...mine, bobs, 'n_nosuch'] });
    const r = of(a.got, 'contribResult').at(-1)!;
    expect(r.ok).toBe(true);
    for (const id of mine) expect(server.contrib.get(id)).toBeUndefined();
    expect(server.contrib.get(bobs)?.title).toBe("Bob's");
    // Nothing of yours among them: refused
    a.send({ op: 'deleteMany', ids: [bobs] });
    expect(of(a.got, 'contribResult').at(-1)!.ok).toBe(false);
  });

  it('checks every note and limits how fast and how many', async () => {
    const { server, join, clock } = world();
    const a = await join('alice', 11); a.conn.isContributor = true;
    for (const bad of [draft({ system: 'atlantis' }), draft({ title: 'x'.repeat(200) }), { ...draft(), shape: { kind: 'circle', radius: Infinity } },
      draft({ anchor: { kind: 'attached', to: { kind: 'planet', id: 'nowhere' }, dx: 0, dy: 0 } })]) {
      a.send({ op: 'create', note: bad });
      clock.t += 10_000;
    }
    expect(of(a.got, 'contribResult').map((r) => r.ok)).toEqual([false, false, false, false]);
    // A burst: the first few go through, then it says slow down
    for (let i = 0; i < 15; i++) a.send({ op: 'create', note: draft({ title: `n${i}` }) });
    const burst = of(a.got, 'contribResult').slice(4);
    expect(burst.filter((r) => r.ok).length).toBeGreaterThan(2);
    expect(burst.at(-1)?.text).toMatch(/Slow down/);
    // Spread out, until the per-author cap
    for (let i = 0; i < 260; i++) { clock.t += 4000; a.send({ op: 'create', note: draft({ title: `m${i}` }) }); }
    expect(server.contrib.all().length).toBe(200);
    expect(of(a.got, 'contribResult').at(-1)?.text).toMatch(/200 notes already/);
  });

  it('places notes where the game\'s bodies are: a station note rides with the station entity', () => {
    const { server } = world();
    const st = gameData.getStation('sol_station_central')!;
    const num = gameData.getStationNum(st.id);
    for (let i = 0; i < 600; i++) server.step();
    const w = (server as any).world;
    const eid = bitecs.defineQuery([Station, Position])(w).find((e: number) => Station.stationId[e] === num)!;
    const tick = (server as any).currentTick as number;
    const p = stationPositionAt(st, tick);
    expect(Math.abs(Position.x[eid] - p.x)).toBeLessThan(1);
    expect(Math.abs(Position.y[eid] - p.y)).toBeLessThan(1);
    expect(Math.hypot(p.x - st.position.x, p.y - st.position.y)).toBeGreaterThan(0);
  });
});

describe('contributor notes on disk', () => {
  let dir = '';
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });

  type Conn = ContribConn & { sent: ServerMessage[] };
  const host = (conns: Conn[]): ContribHost<Conn> => ({
    conns: () => conns,
    send: (c, m) => c.sent.push(m),
    bodies: (id) => {
      const s = gameData.getSystem(id);
      return s ? { planets: s.planets, nests: s.nests, lodestones: s.lodestones, stations: gameData.getSystemStations(id) } : null;
    },
    tick: () => 4321,
  });

  it('round-trips notes and ranks, and applies the terminal\'s inbox', async () => {
    dir = mkdtempSync(join(tmpdir(), 'contrib-'));
    const me: Conn = { username: 'alice', userId: 11, isAdmin: false, isContributor: true, sent: [] };
    const admin: Conn = { username: 'boss', userId: 1, isAdmin: true, isContributor: false, sent: [] };
    const a = new ContributorNotes(host([me, admin]), contribFileStore(dir));
    a.handle(me, { op: 'create', note: draft() });
    a.handle(me, { op: 'create', note: draft({ title: 'Pin', shape: { kind: 'point' }, anchor: { kind: 'attached', to: { kind: 'moon', id: 'terra_nova', moon: 0 }, dx: 50, dy: 0 } }) });
    a.setRank('mapper', null, true, 'boss');
    await a.flush();
    a.close();
    const disk = JSON.parse(readFileSync(join(dir, 'notes.json'), 'utf-8'));
    expect(disk.notes).toHaveLength(2);
    expect(JSON.parse(readFileSync(join(dir, 'clock.json'), 'utf-8')).tick).toBe(4321);
    expect(existsSync(join(dir, 'notes.json.tmp'))).toBe(false);

    const id = disk.notes[0].id;
    writeFileSync(join(dir, 'inbox', '1-x.json'), JSON.stringify({ op: 'status', id, status: 'done', resolution: 'Added it', by: 'terminal' }));
    writeFileSync(join(dir, 'inbox', '2-y.json'), '{ broken');
    const b = new ContributorNotes(host([me, admin]), contribFileStore(dir));
    expect(b.all().map((n) => n.title).sort()).toEqual(['Pin', 'Water world']);
    expect(b.get(id)).toMatchObject({ status: 'done', resolution: 'Added it', statusBy: 'terminal' });
    expect(b.hasRank(77, 'Mapper')).toBe(true);
    expect(b.hasRank(78, 'someone')).toBe(false);
    await b.flush();
    b.close();
    // What the inbox did is saved, and the account id the rank picked up
    const c = new ContributorNotes(host([]), contribFileStore(dir));
    expect(c.get(id)?.status).toBe('done');
    expect(c.contributors()).toEqual([expect.objectContaining({ id: 77, username: 'Mapper' })]);
    c.close();
  });

  it('notes stored before comments and votes load unchanged, as none of either; new ones round-trip', async () => {
    dir = mkdtempSync(join(tmpdir(), 'contrib-'));
    // (As production's notes.json is today)
    const old = {
      id: 'n_537d9df105', author: 'alice', authorId: 11, createdAt: '2026-11-11T23:49:05.282Z', updatedAt: '2026-11-11T23:49:05.282Z', status: 'open',
      system: 'sol', title: 'contributor circle', text: "here's a circle", shape: { kind: 'circle', radius: 5622 }, color: '#38bdf8',
      anchor: { kind: 'orbit', around: { kind: 'center' }, radius: 40188.39, phaseDeg: 175.38, periodMinutes: 330, direction: 1 },
    };
    const broken = { ...old, id: 'n_broken', comments: 'junk', voters: { u5: 7 }, votes: { up: 9, down: 0, mine: 1 } };
    writeFileSync(join(dir, 'notes.json'), JSON.stringify({ version: 1, notes: [old, broken] }));
    const me: Conn = { username: 'alice', userId: 11, isAdmin: false, isContributor: true, sent: [] };
    const bob: Conn = { username: 'bob', userId: 12, isAdmin: false, isContributor: true, sent: [] };
    const a = new ContributorNotes(host([me, bob]), contribFileStore(dir));
    expect(a.get(old.id)).toEqual(old);
    // A hand-edited note's bad comments, voters and a stray tally are dropped, the note kept
    expect(a.get('n_broken')).toEqual({ ...old, id: 'n_broken' });
    a.handle(bob, { op: 'list', system: 'sol' });
    const sent = of(bob.sent, 'contribNotes').at(-1)!.notes.find((n) => n.id === old.id)!;
    expect(sent).toEqual({ ...old, comments: [], votes: { up: 0, down: 0, mine: 0 } });

    a.handle(bob, { op: 'vote', id: old.id, value: 1 });
    a.handle(bob, { op: 'comment', id: old.id, text: 'Good spot' });
    a.handle(me, { op: 'update', id: old.id, note: draft({ title: 'Circle, edited' }) });
    await a.flush();
    a.close();
    const disk = JSON.parse(readFileSync(join(dir, 'notes.json'), 'utf-8'));
    expect(disk.version).toBe(1);
    const saved = disk.notes.find((n: any) => n.id === old.id);
    expect(saved).toMatchObject({ title: 'Circle, edited', voters: { u12: 1 }, comments: [{ author: 'bob', authorId: 12, text: 'Good spot' }] });
    expect(saved.votes).toBeUndefined();
    expect(typeof saved.editedAt).toBe('string');
    const b = new ContributorNotes(host([me, bob]), contribFileStore(dir));
    expect(b.get(old.id)).toEqual(saved);
    b.close();

    // The terminal script prints the votes and comments from that file
    const script = join(__dirname, '../../../scripts/contributor-notes.mjs');
    const out = execFileSync(process.execPath, [script, '--file', join(dir, 'notes.json'), '--status', 'all', '--tick', '0'], { encoding: 'utf-8' });
    expect(out).toContain('"Circle, edited"');
    expect(out).toContain('Votes: 1 up, 0 down (score +1)');
    expect(out).toMatch(/Comments \(1\):\n\s+bob \(.* UTC\): Good spot/);
    const json = JSON.parse(execFileSync(process.execPath, [script, '--file', join(dir, 'notes.json'), '--status', 'all', '--tick', '0', '--json'], { encoding: 'utf-8' }));
    const j = json.notes.find((n: any) => n.id === old.id);
    expect(j.votes).toEqual({ up: 1, down: 0 });
    expect(j.voters).toBeUndefined();
    expect(j.comments).toHaveLength(1);
    expect(j.positionNow).toBeTruthy();
  });
});
