import { describe, it, expect } from 'vitest';
import { readDonations } from './donations.js';
import { donationsPage, money } from '../views/donations.js';
import type { PageCtx } from '../views/layout.js';

const REPORT = { success: true, enabled: true, currency: 'USD', total: 1250, count: 2,
  recent: [{ id: 2, userId: null, username: null, amount: 500, currency: 'USD', status: 'COMPLETED', orderId: 'O2', captureId: 'C2', createdAt: 1, completedAt: 2 },
    { id: 1, userId: 7, username: '<b>al', amount: 750, currency: 'USD', status: 'COMPLETED', orderId: 'O1', captureId: 'C1', createdAt: 1, completedAt: 2 }],
  accounts: [{ userId: 7, username: '<b>al', total: 750, count: 1 }, { userId: null, username: null, total: 500, count: 1 }] };
const ctx = { siteName: 'Space Game', user: { id: 1, username: 'boss', isAdmin: true, isOwner: true }, csrf: 'c', path: '/admin/donations', live: null, origin: 'http://x' } as PageCtx;

describe('admin donations page', () => {
  it('asks the lobby with the admin secret, from the server', async () => {
    const calls: any[] = [];
    const r = await readDonations('http://lobby', 'sssh', async (url, init) => { calls.push({ url, init }); return { status: 200, json: async () => REPORT }; });
    expect(calls[0].url).toBe('http://lobby/admin/donations');
    expect(calls[0].init.headers.Authorization).toBe('Bearer sssh');
    expect(r).toMatchObject({ enabled: true, total: 1250, count: 2 });
  });

  it('no secret, a refusal, nonsense or no answer reads as null', async () => {
    expect(await readDonations('http://lobby', '', async () => { throw new Error('must not be called'); })).toBeNull();
    expect(await readDonations('http://lobby', 's', async () => ({ status: 403, json: async () => ({ success: false }) }))).toBeNull();
    expect(await readDonations('http://lobby', 's', async () => ({ status: 200, json: async () => ({ success: true }) }))).toBeNull();
    expect(await readDonations('http://lobby', 's', async () => { throw new Error('down'); })).toBeNull();
  });

  it('shows totals and rows with names escaped, and never the secret', () => {
    const page = String(donationsPage(ctx, { ...REPORT }));
    expect(page).toContain('$12.50');
    expect(page).toContain('$7.50');
    expect(page).toContain('Guest (no account)');
    expect(page).not.toContain('<b>al');
    expect(String(donationsPage(ctx, null))).toContain('answering. Try again');
    expect(money(500, 'EUR')).toBe('5.00 EUR');
  });
});
