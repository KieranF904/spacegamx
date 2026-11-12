import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'path';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import http from 'http';
import type { AddressInfo } from 'net';
import type { ServerMessage } from '@space-game/common';
import { ContributorNotes, DONOR_GRANT, type ContribConn, type ContribHost } from './ContributorNotes.js';
import { contribFileStore } from './contribFiles.js';
import { contributorAtSignIn } from '../net/auth.js';
import type { ServerCtx } from '../net/ServerCtx.js';
import { LobbyAccounts } from '../auth/LobbyAccounts.js';

/** The contributor rank earned by donating: the lobby says who qualifies (server-browser/src/donations), this grants it */

interface Conn extends ContribConn { sent: ServerMessage[] }
const conn = (username: string, userId: number | null, over: Partial<Conn> = {}): Conn => ({ username, userId, isAdmin: false, isContributor: false, sent: [], ...over });
const host = (conns: Conn[]): ContribHost<Conn> => ({ conns: () => conns, send: (c, m) => { c.sent.push(m); }, bodies: () => null, tick: () => 1 });
const rankMsgs = (c: Conn) => c.sent.filter((m) => m.type === 'contribRank');

let dir = '';
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });

describe('contributor rank from donations', () => {
  it('a donor who is online gets the rank at once, told once; the grant is recorded as a donation', () => {
    const alice = conn('alice', 11);
    const notes = new ContributorNotes(host([alice]), null);
    expect(notes.grantDonor(11, 'alice', alice)).toBe(true);
    expect(alice.isContributor).toBe(true);
    expect(notes.allowed(alice)).toBe(true);
    expect(rankMsgs(alice)).toEqual([{ type: 'contribRank', on: true }]);
    expect(notes.contributors()).toMatchObject([{ id: 11, username: 'alice', grantedBy: DONOR_GRANT }]);
    // (The lobby says it again on later heartbeats: nothing more happens)
    expect(notes.grantDonor(11, 'alice', alice)).toBe(false);
    expect(notes.grantDonor(11, 'alice', alice)).toBe(false);
    expect(rankMsgs(alice)).toHaveLength(1);
    expect(notes.contributors()).toHaveLength(1);
  });

  it('a donor who is offline has it from their next sign-in', () => {
    const notes = new ContributorNotes(host([]), null);
    expect(notes.grantDonor(11, 'alice', null)).toBe(true);
    expect(notes.hasRank(11, 'alice')).toBe(true);
    expect(notes.hasRank(12, 'bob')).toBe(false);
  });

  it('signed in before the grant was made elsewhere: their connection is still told', () => {
    const alice = conn('alice', 11);
    const notes = new ContributorNotes(host([alice]), null);
    notes.grantDonor(11, 'alice', null);
    expect(alice.isContributor).toBe(false);
    expect(notes.grantDonor(11, 'alice', alice)).toBe(false);
    expect(alice.isContributor).toBe(true);
    expect(rankMsgs(alice)).toHaveLength(1);
  });

  it("an admin-granted contributor is left as they are: one entry, still the admin's grant", () => {
    const alice = conn('alice', 11);
    const notes = new ContributorNotes(host([alice]), null);
    notes.setRank('alice', alice, true, 'boss');
    const sentBefore = alice.sent.length;
    expect(notes.grantDonor(11, 'alice', alice)).toBe(false);
    expect(notes.contributors()).toMatchObject([{ id: 11, grantedBy: 'boss' }]);
    expect(alice.sent).toHaveLength(sentBefore);
    // (And one granted by name while offline: matched by name, not doubled)
    notes.setRank('Mapper', null, true, 'boss');
    expect(notes.grantDonor(77, 'mapper', null)).toBe(false);
    expect(notes.contributors().filter((r) => r.username.toLowerCase() === 'mapper')).toMatchObject([{ id: 77, grantedBy: 'boss' }]);
  });

  it('a guest, or a nonsense id, never gets it', () => {
    const guest = conn('Guest_1', null);
    const notes = new ContributorNotes(host([guest]), null);
    for (const id of [0, -1, NaN, 1.5]) expect(notes.grantDonor(id, 'x', null)).toBe(false);
    expect(notes.hasRank(null, 'Guest_1')).toBe(false);
    expect(notes.contributors()).toEqual([]);
  });

  it('nothing here takes the rank away: only an admin does, and then donating does not hand it back', async () => {
    dir = mkdtempSync(join(tmpdir(), 'contrib-donor-'));
    const alice = conn('alice', 11);
    const a = new ContributorNotes(host([alice]), contribFileStore(dir));
    a.grantDonor(11, 'alice', alice);
    expect(a.setRank('alice', alice, false, 'boss').ok).toBe(true);
    expect(alice.isContributor).toBe(false);
    expect(a.grantDonor(11, 'alice', alice)).toBe(false);
    expect(a.hasRank(11, 'alice')).toBe(false);
    await a.flush();
    a.close();
    expect(JSON.parse(readFileSync(join(dir, 'contributors.json'), 'utf-8'))).toMatchObject({ contributors: [], revoked: [11] });
    // (Remembered across a restart)
    const b = new ContributorNotes(host([alice]), contribFileStore(dir));
    expect(b.grantDonor(11, 'alice', alice)).toBe(false);
    // (An admin giving it back clears that)
    expect(b.setRank('alice', alice, true, 'boss').ok).toBe(true);
    b.setRank('alice', alice, false, 'boss');
    b.setRank('alice', null, true, 'boss');
    expect(b.hasRank(11, 'alice')).toBe(true);
    await b.flush();
    b.close();
    expect(JSON.parse(readFileSync(join(dir, 'contributors.json'), 'utf-8')).contributors).toHaveLength(1);
  });

  it('a file from before donations (no revoked list) loads as it was', async () => {
    dir = mkdtempSync(join(tmpdir(), 'contrib-donor-'));
    const a = new ContributorNotes(host([]), contribFileStore(dir));
    a.setRank('mapper', null, true, 'boss');
    await a.flush();
    a.close();
    expect(JSON.parse(readFileSync(join(dir, 'contributors.json'), 'utf-8'))).not.toHaveProperty('revoked');
    const b = new ContributorNotes(host([]), contribFileStore(dir));
    expect(b.hasRank(77, 'Mapper')).toBe(true);
    b.close();
  });
});

describe('contributor rank at sign-in', () => {
  const ctxOf = (notes: ContributorNotes<Conn>) => ({ contrib: notes }) as unknown as ServerCtx;

  it('an account the lobby says has donated enough gets the rank as it signs in (a grant missed while offline heals)', () => {
    const notes = new ContributorNotes(host([]), null);
    expect(contributorAtSignIn(ctxOf(notes), { id: 12, username: 'bob' })).toBe(false);
    expect(contributorAtSignIn(ctxOf(notes), { id: 11, username: 'alice', donor_contributor: true })).toBe(true);
    expect(notes.contributors()).toMatchObject([{ id: 11, grantedBy: DONOR_GRANT }]);
    // (It stays theirs even if the lobby stops saying so: never revoked from here)
    expect(contributorAtSignIn(ctxOf(notes), { id: 11, username: 'alice' })).toBe(true);
    expect(contributorAtSignIn(ctxOf(notes), { id: 11, username: 'alice', donor_contributor: false })).toBe(true);
  });

  it('an admin-granted contributor with no donations signs in with it as before', () => {
    const notes = new ContributorNotes(host([]), null);
    notes.setRank('carol', null, true, 'boss');
    expect(contributorAtSignIn(ctxOf(notes), { id: 13, username: 'carol' })).toBe(true);
    expect(notes.contributors()).toMatchObject([{ id: 13, grantedBy: 'boss' }]);
  });

  it("the lobby's answer to a session check carries the flag through (and its absence)", async () => {
    const answers: Record<string, object> = {
      donor: { success: true, id: 11, username: 'alice', isAdmin: false, isOwner: false, donorContributor: true },
      plain: { success: true, id: 12, username: 'bob', isAdmin: false, isOwner: false },
      odd: { success: true, id: 13, username: 'carol', isAdmin: false, isOwner: false, donorContributor: 'yes' },
    };
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => { raw += d; });
      req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(answers[JSON.parse(raw).token] ?? { success: false })); });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const accounts = new LobbyAccounts(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      expect((await accounts.validateSession('donor'))?.donor_contributor).toBe(true);
      expect(await accounts.validateSession('plain')).not.toHaveProperty('donor_contributor');
      expect(await accounts.validateSession('odd')).not.toHaveProperty('donor_contributor');
    } finally {
      await new Promise((r) => server.close(() => r(null)));
    }
  });
});
