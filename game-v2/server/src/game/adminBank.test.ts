import { describe, it, expect } from 'vitest';
import { AdminTools, type AdminConn, type AdminHost } from './AdminTools.js';

/** Just enough of a host for /bank: the replies, whether this is a dev server, and what the bank was asked */
function tools(opts: { dev?: boolean; bank?: boolean } = {}) {
  const replies: any[] = [];
  const asked: any[] = [];
  const host = {
    conns: () => [],
    reply: (_c: AdminConn, m: object) => replies.push(m),
    freeBuildAllowed: () => !!opts.dev,
    devBank: opts.bank === false ? undefined : (_c: AdminConn, action: string, items?: object) => { asked.push({ action, items }); return { ok: true, text: `bank ${action}` }; },
  } as unknown as AdminHost;
  return { admin: new AdminTools(host), replies, asked };
}

const admin = (): AdminConn => ({ playerId: 1, username: 'kieran', isAdmin: true, ping: 0, userId: null });

describe('/bank', () => {
  it('fill, empty, clear and grant reach the repair bank on a dev server', () => {
    const t = tools({ dev: true });
    for (const w of ['fill', 'empty', 'clear']) t.admin.chat(admin(), `/bank ${w}`);
    t.admin.chat(admin(), '/bank grant');
    t.admin.chat(admin(), '/bank grant pack_hull 5');
    expect(t.asked).toEqual([
      { action: 'fill', items: undefined }, { action: 'empty', items: undefined }, { action: 'clearDeposits', items: undefined },
      { action: 'grant', items: undefined }, { action: 'grant', items: { pack_hull: 5 } },
    ]);
    expect(t.replies.every((r) => r.ok)).toBe(true);
  });

  it('is refused away from a dev server, and for anything it does not know', () => {
    const prod = tools({ dev: false });
    prod.admin.chat(admin(), '/bank fill');
    expect(prod.asked).toEqual([]);
    expect(prod.replies[0]).toMatchObject({ ok: false });
    const dev = tools({ dev: true });
    dev.admin.chat(admin(), '/bank withdraw');
    expect(dev.asked).toEqual([]);
    expect(dev.replies[0].ok).toBe(false);
    const none = tools({ dev: true, bank: false });
    none.admin.chat(admin(), '/bank fill');
    expect(none.replies[0].ok).toBe(false);
  });
});
