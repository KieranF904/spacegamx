import { describe, expect, it } from 'vitest';
import { HttpActivityClient, mergeEvents } from './activity.js';
import { parseActivityLobbies, PRODUCTION_LOBBY } from './config.js';

const prod = { id: 'production', name: 'Production', url: PRODUCTION_LOBBY, own: false };

/** A fetch that answers one way (or throws: offline) */
function answering(status: number, body: string | object | Error) {
  const calls: { url: string; body: any }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    if (body instanceof Error) throw body;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': typeof body === 'string' ? 'text/html' : 'application/json' } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('activity sources', () => {
  it('dev reads the local lobby (with the site session) and production; production reads its own lobby alone', () => {
    expect(parseActivityLobbies(undefined, 'http://localhost:8787', false)).toEqual([
      { id: 'local', name: 'Local', url: 'http://localhost:8787', own: true },
      { id: 'production', name: 'Production', url: 'https://space.brotherk3d.com/lobby', own: false },
    ]);
    expect(parseActivityLobbies(undefined, 'http://127.0.0.1:8790', true)).toEqual([{ id: 'live', name: 'Live', url: 'http://127.0.0.1:8790', own: true }]);
    expect(parseActivityLobbies('A=http://a:1/, B=ftp://nope, =http://x, A=http://dup', 'http://a:1', false)).toEqual([{ id: 'a', name: 'A', url: 'http://a:1', own: true }]);
  });

  it("a lobby without the feed (a 404 page, the game's index.html, offline) is not available yet; one with it says sign in or not an admin", async () => {
    const q = { limit: 10 };
    expect((await new HttpActivityClient(answering(404, '<html>Not found</html>').fn).read(prod, null, q)).state).toBe('unavailable');
    expect((await new HttpActivityClient(answering(200, '<!doctype html><title>Space Game</title>').fn).read(prod, null, q)).state).toBe('unavailable');
    expect((await new HttpActivityClient(answering(404, { error: 'Not found' }).fn).read(prod, null, q)).state).toBe('unavailable');
    expect((await new HttpActivityClient(answering(0, new Error('ECONNREFUSED')).fn).read(prod, null, q)).state).toBe('unavailable');
    expect((await new HttpActivityClient(answering(401, { success: false, feed: true }).fn).read(prod, null, q)).state).toBe('signin');
    expect(await new HttpActivityClient(answering(403, { success: false, feed: true, error: 'Only an admin can do that' }).fn).read(prod, 't', q)).toEqual({ state: 'forbidden', error: 'Only an admin can do that' });
  });

  it('reads with the session and filters in the body (never the URL), and keeps only clean events', async () => {
    const f = answering(200, { success: true, feed: true, events: [{ id: 3, at: 5, server: 'AUS Main', type: 'join', player: 'a', other: '', detail: 'x'.repeat(900) }, { id: 'bad' }], servers: ['AUS Main'], types: ['join'], live: [] });
    const r = await new HttpActivityClient(f.fn).read(prod, 'tok', { limit: 10, player: 'a', after: 2 });
    expect(f.calls[0].url).toBe('https://space.brotherk3d.com/lobby/activity/read');
    expect(f.calls[0].body).toEqual({ token: 'tok', limit: 10, player: 'a', after: 2 });
    expect(r.state === 'ok' && r.events.length === 1 && r.events[0].detail.length === 200).toBe(true);
  });

  it("signing in to another lobby is for its admins only", async () => {
    expect(await new HttpActivityClient(answering(200, { success: true, token: 't'.repeat(40), isAdmin: false }).fn).login(prod, 'p', 'x', '1.2.3.4')).toEqual({ ok: false, error: 'That account is not an admin there' });
    expect((await new HttpActivityClient(answering(200, { success: true, token: 't'.repeat(40), isAdmin: true }).fn).login(prod, 'k', 'x', '1.2.3.4')).ok).toBe(true);
    expect(await new HttpActivityClient(answering(401, { success: false, error: 'Invalid username or password' }).fn).login(prod, 'k', 'x', '1.2.3.4')).toEqual({ ok: false, error: 'Invalid username or password' });
  });

  it('merges sources newest first', () => {
    const e = (id: number, at: number) => ({ id, at, server: 's', type: 'join', player: '', other: '', detail: '' });
    expect(mergeEvents([{ source: 'a', events: [e(2, 30), e(1, 10)] }, { source: 'b', events: [e(7, 20)] }], 10).map((x) => `${x.source}${x.id}`)).toEqual(['a2', 'b7', 'a1']);
  });
});
