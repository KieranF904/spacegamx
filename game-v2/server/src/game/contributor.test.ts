import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'path';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
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
});
