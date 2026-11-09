import { describe, it, expect } from 'vitest';
import { UpdateSchedule, UpdateRoutes, GRACE_MS } from './schedule.js';

const MIN = 60_000;

describe('update schedule', () => {
  it('tells servers the time left, never negative, and forgets it after the grace', () => {
    let t = 1_000_000;
    const s = new UpdateSchedule(null, () => t);
    expect(s.forHeartbeat()).toBeUndefined();
    expect(s.schedule(t + 15 * MIN, 'kieran')).toMatchObject({ ok: true });
    expect(s.forHeartbeat()).toEqual({ inMs: 15 * MIN });
    t += 15 * MIN + 1000;
    expect(s.forHeartbeat()).toEqual({ inMs: 0 });
    t += GRACE_MS;
    expect(s.forHeartbeat()).toBeUndefined();
  });

  it('refuses too little or too much notice, and cancels', () => {
    const s = new UpdateSchedule(null, () => 0);
    expect(s.schedule(30_000, 'a')).toMatchObject({ ok: false });
    expect(s.schedule(30 * 24 * 3600_000, 'a')).toMatchObject({ ok: false });
    expect(s.schedule(NaN, 'a')).toMatchObject({ ok: false });
    s.schedule(5 * MIN, 'a');
    expect(s.cancel()).toBe(true);
    expect(s.cancel()).toBe(false);
  });
});

function call(routes: UpdateRoutes, url: string, auth: string | null, body: unknown = {}) {
  let out: { status: number; body: any } | null = null;
  const req: any = { method: 'POST', headers: auth === null ? {} : { authorization: `Bearer ${auth}` } };
  const res: any = {};
  (routes as any).sendJson = (_r: unknown, status: number, b: unknown) => { out = { status, body: b }; };
  (routes as any).parseJson = async () => body;
  return routes.handle(req, res, url).then((handled) => ({ handled, out: out as { status: number; body: any } | null }));
}

describe('update admin routes', () => {
  const mk = () => new UpdateRoutes(new UpdateSchedule(null, () => 5000), () => {}, async () => ({}), 'secret', () => 5000);

  it('answers only to the admin secret', async () => {
    const r = mk();
    expect((await call(r, '/admin/update/schedule', null, { inMinutes: 5 })).out?.status).toBe(403);
    expect((await call(r, '/admin/update/schedule', 'wrong', { inMinutes: 5 })).out?.status).toBe(403);
    expect(r.schedule.get()).toBeNull();
  });

  it('schedules, reports and cancels', async () => {
    const r = mk();
    const a = await call(r, '/admin/update/schedule', 'secret', { inMinutes: 15, by: 'k' });
    expect(a.out?.body).toMatchObject({ success: true, inMs: 15 * MIN });
    expect((await call(r, '/admin/update/status', 'secret')).out?.body).toMatchObject({ scheduled: true, inMs: 15 * MIN });
    expect((await call(r, '/admin/update/cancel', 'secret')).out?.body).toMatchObject({ cancelled: true });
    expect((await call(r, '/admin/update/status', 'secret')).out?.body).toMatchObject({ scheduled: false });
    expect((await call(r, '/admin/update/schedule', 'secret', { inMinutes: 0 })).out?.status).toBe(400);
  });

  it('ignores other urls', async () => {
    expect((await call(mk(), '/list', 'secret')).handled).toBe(false);
  });
});
