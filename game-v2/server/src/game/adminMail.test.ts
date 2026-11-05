import { describe, it, expect } from 'vitest';
import { AdminTools, type AdminConn, type AdminHost } from './AdminTools.js';

/** Just enough of a host for /mail: the replies, and a lobby that records what it was asked */
function tools(opts: { lobby?: boolean } = {}) {
  const replies: any[] = [];
  const mailed: any[] = [];
  const host = {
    conns: () => [],
    reply: (_c: AdminConn, m: object) => replies.push(m),
    accounts: opts.lobby === false ? null : {
      mail: async (to: string | null, subject: string, body: string, actor: string) => { mailed.push({ to, subject, body, actor }); return { sent: to === null ? 12 : 1, to: to ?? '*' }; },
    },
  } as unknown as AdminHost;
  return { admin: new AdminTools(host), replies, mailed };
}

const admin = (over: Partial<AdminConn> = {}): AdminConn => ({ playerId: 1, username: 'brotherk3d', isAdmin: true, ping: 0, userId: 7, ...over });
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('/mail', () => {
  it('mails one player through the lobby, as the signed-in admin; "subject | text" splits', async () => {
    const t = tools();
    expect(t.admin.chat(admin(), '/mail alice Hello there, see you tonight')).toBe(true);
    expect(t.admin.chat(admin(), '/mail bob Patch notes | New ships are in')).toBe(true);
    await settle();
    expect(t.mailed).toEqual([
      { to: 'alice', subject: '', body: 'Hello there, see you tonight', actor: 'brotherk3d' },
      { to: 'bob', subject: 'Patch notes', body: 'New ships are in', actor: 'brotherk3d' },
    ]);
    expect(t.replies.map((r) => r.text)).toEqual(['Mailed alice', 'Mailed bob']);
  });

  it('"everyone" (or *) mails every account', async () => {
    const t = tools();
    t.admin.chat(admin(), '/mail everyone Server restart at 8');
    await settle();
    expect(t.mailed[0]).toMatchObject({ to: null, body: 'Server restart at 8' });
    expect(t.replies[0]).toMatchObject({ ok: true, text: 'Mailed everyone (12 accounts)' });
  });

  it("isn't for players, guests (dev admins without an account) or servers with no lobby", async () => {
    const t = tools();
    expect(t.admin.chat(admin({ isAdmin: false }), '/mail alice hi')).toBe(false);
    t.admin.chat(admin({ userId: null }), '/mail alice hi');
    t.admin.chat(admin(), '/mail alice');
    await settle();
    expect(t.mailed).toEqual([]);
    expect(t.replies.map((r) => r.ok)).toEqual([false, false]);
    const none = tools({ lobby: false });
    none.admin.chat(admin(), '/mail alice hi');
    await settle();
    expect(none.replies[0].ok).toBe(false);
  });
});
