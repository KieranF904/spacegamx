import { describe, it, expect } from 'vitest';
import { rankLine, amountText, lobbySupport, dollars, readAmount, sdkUrl } from './api';

const CONFIG = { success: true, enabled: true, clientId: 'public-id', sandbox: true, currency: 'USD', min: 100, max: 50000, presets: [300, 500, 1000, 2000], account: { username: 'alice' }, total: 800, contributorAt: 1000 };

function fakeFetch(answer: (url: string, body: any) => unknown) {
  const calls: { url: string; body: any }[] = [];
  const f = (async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    const a = answer(url, body);
    if (a instanceof Error) throw a;
    return { json: async () => a };
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe('donation page: the lobby', () => {
  it('reads the config, and sends the session token only when there is one', async () => {
    const { f, calls } = fakeFetch(() => CONFIG);
    const api = lobbySupport(f, 'http://lobby');
    expect(await api.config('tok')).toEqual({ enabled: true, clientId: 'public-id', sandbox: true, currency: 'USD', min: 100, max: 50000, presets: [300, 500, 1000, 2000], account: { username: 'alice' }, total: 800, contributorAt: 1000 });
    await api.config(null);
    await api.create(null, '5.00');
    await api.create('tok', '7.50');
    await api.capture('ORDER1');
    expect(calls).toEqual([
      { url: 'http://lobby/donations/config', body: { token: 'tok' } },
      { url: 'http://lobby/donations/config', body: {} },
      { url: 'http://lobby/donations/create', body: { amount: '5.00' } },
      { url: 'http://lobby/donations/create', body: { token: 'tok', amount: '7.50' } },
      { url: 'http://lobby/donations/capture', body: { orderId: 'ORDER1' } },
    ]);
  });

  it('a lobby that is off, unreachable or answers nonsense is "unavailable", never a throw', async () => {
    for (const answer of [{ success: false, enabled: false, error: 'off' }, new Error('network'), null, 'nope', { success: true, enabled: true }, { ...CONFIG, clientId: '' }]) {
      expect(await lobbySupport(fakeFetch(() => answer).f, 'http://lobby').config('tok')).toEqual({ enabled: false });
    }
    const down = lobbySupport(fakeFetch(() => new Error('network')).f, 'http://lobby');
    expect(await down.create(null, '5.00')).toMatchObject({ success: false, error: expect.stringContaining("Can't reach") });
    expect(await down.capture('X')).toMatchObject({ success: false });
    expect(await lobbySupport(fakeFetch(() => 'nope').f, 'http://lobby').capture('X')).toMatchObject({ success: false });
  });

  it("passes the lobby's own answer through", async () => {
    const api = lobbySupport(fakeFetch((url) => (url.endsWith('create') ? { success: true, orderId: 'O1' } : { success: false, declined: true, error: 'Declined' })).f, 'http://lobby');
    expect(await api.create(null, '5.00')).toEqual({ success: true, orderId: 'O1' });
    expect(await api.capture('O1')).toEqual({ success: false, declined: true, error: 'Declined' });
  });
});

describe('donation page: the contributor rank line', () => {
  it('says "have it" at or past the threshold, the exact amount to go below it, and nothing without a threshold', () => {
    expect(rankLine(1000, 1000)).toBe('You have the contributor rank.');
    expect(rankLine(5000, 1000)).toBe('You have the contributor rank.');
    // (below it nothing is said: no running count towards the rank)
    expect(rankLine(0, 1000)).toBe('');
    expect(rankLine(999, 1000)).toBe('');
    expect(rankLine(500, 0)).toBe('');
  });
});

describe('donation page: amounts', () => {
  it('writes money plainly', () => {
    expect(dollars(500)).toBe('$5');
    expect(dollars(750)).toBe('$7.50');
    expect(dollars(1905)).toBe('$19.05');
    expect(dollars(123400)).toBe('$1,234');
    expect(amountText(500)).toBe('5.00');
    expect(amountText(1905)).toBe('19.05');
  });

  it('reads a typed amount as whole cents within the limits, or says why not', () => {
    expect(readAmount('5', 100, 50000)).toEqual({ minor: 500 });
    expect(readAmount(' $7.5 ', 100, 50000)).toEqual({ minor: 750 });
    expect(readAmount('1', 100, 50000)).toEqual({ minor: 100 });
    expect(readAmount('500.00', 100, 50000)).toEqual({ minor: 50000 });
    for (const bad of ['', ' ', '0.99', '500.01', '5.001', '-5', 'five', '1e3', '5,00']) expect(readAmount(bad, 100, 50000)).toHaveProperty('error');
    expect((readAmount('0.50', 100, 50000) as { error: string }).error).toContain('$1');
    expect((readAmount('900', 100, 50000) as { error: string }).error).toContain('$500');
  });

  it("PayPal's script comes from PayPal with the public client id and nothing else of ours", () => {
    const u = new URL(sdkUrl('public id&x', 'USD'));
    expect(u.origin).toBe('https://www.paypal.com');
    expect(u.pathname).toBe('/sdk/js');
    expect(Object.fromEntries(u.searchParams)).toEqual({ 'client-id': 'public id&x', currency: 'USD', intent: 'capture', components: 'buttons' });
  });
});
