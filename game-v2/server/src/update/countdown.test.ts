import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UpdateCountdown, UPDATE_EXIT_CODE, JOIN_REFUSED, type UpdateHost } from './UpdateCountdown.js';
import { handleJoin } from '../net/auth.js';
import { buildId, heartbeatIdentity } from './install.js';

const MIN = 60_000;

function rig() {
  const said: string[] = [];
  const banners: number[] = [];
  const exits: number[] = [];
  const order: string[] = [];
  const host: UpdateHost = {
    now: () => Date.now(),
    say: (t) => said.push(t),
    banner: (n) => banners.push(n),
    exit: (c) => { exits.push(c); order.push('exit'); },
  };
  const cd = new UpdateCountdown(host);
  // (the real wiring: a tick every second)
  const timer = setInterval(() => cd.tick(), 1000);
  return { cd, said, banners, exits, stop: () => clearInterval(timer) };
}

describe('update countdown', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
  afterEach(() => { vi.useRealTimers(); });

  it('does nothing with no schedule (one server, as before)', () => {
    const r = rig();
    r.cd.onLobby(undefined);
    vi.advanceTimersByTime(30 * MIN);
    expect(r.said).toEqual([]);
    expect(r.exits).toEqual([]);
    expect(r.cd.joinRefusal()).toBeNull();
    r.stop();
  });

  it('announces at once, then 5 and 1 minutes, once each; blocks sign-ins in the last minute; exits at the time', () => {
    const r = rig();
    r.cd.onLobby({ inMs: 15 * MIN });
    expect(r.said).toHaveLength(1);
    expect(r.said[0]).toContain('15 min');
    expect(r.banners[0]).toBe(15 * MIN);
    // (heartbeats repeating the schedule with jitter say nothing new)
    vi.advanceTimersByTime(10_000);
    r.cd.onLobby({ inMs: 15 * MIN - 10_000 + 300 });
    expect(r.said).toHaveLength(1);

    vi.advanceTimersByTime(10 * MIN - 10_000 + 1000);
    expect(r.said.filter((t) => /in 5 min/.test(t))).toHaveLength(1);
    expect(r.cd.joinRefusal()).toBeNull();

    vi.advanceTimersByTime(4 * MIN - 1000 + 1000);
    expect(r.said.filter((t) => /in 1 min/.test(t))).toHaveLength(1);
    expect(r.cd.joinRefusal()).toBe(JOIN_REFUSED);
    expect(r.exits).toEqual([]);

    // (the banner goes out again every 30 s while it counts down)
    expect(r.banners.length).toBeGreaterThan(4);

    vi.advanceTimersByTime(MIN + 5000);
    expect(r.exits).toEqual([UPDATE_EXIT_CODE]);
    expect(r.cd.joinRefusal()).toBe(JOIN_REFUSED);
    r.stop();
  });

  it('a schedule made late says only what is still ahead', () => {
    const r = rig();
    r.cd.onLobby({ inMs: 3 * MIN });
    expect(r.said).toHaveLength(1);
    expect(r.said[0]).toContain('3 min');
    vi.advanceTimersByTime(2 * MIN + 1000);
    expect(r.said).toHaveLength(2);
    expect(r.said[1]).toContain('1 min');
    expect(r.said.some((t) => t.includes('15 min') || t.includes('5 min'))).toBe(false);
    r.stop();
  });

  it('a schedule gone from the lobby answer is a cancellation, and a due one is ignored', () => {
    const r = rig();
    r.cd.onLobby({ inMs: 10 * MIN });
    r.cd.onLobby(undefined);
    expect(r.said.at(-1)).toContain('cancelled');
    expect(r.banners.at(-1)).toBe(0);
    vi.advanceTimersByTime(20 * MIN);
    expect(r.exits).toEqual([]);
    // (an update already due: this server started after it, on the new build)
    r.cd.onLobby({ inMs: 0 });
    vi.advanceTimersByTime(MIN);
    expect(r.exits).toEqual([]);
    expect(r.cd.joinRefusal()).toBeNull();
    r.stop();
  });

  it('exits once, even if the lobby repeats itself afterwards', () => {
    const r = rig();
    r.cd.onLobby({ inMs: 2 * MIN });
    vi.advanceTimersByTime(2 * MIN + 1000);
    r.cd.onLobby({ inMs: 30_000 });
    r.cd.onLobby(undefined);
    vi.advanceTimersByTime(5 * MIN);
    expect(r.exits).toHaveLength(1);
    r.stop();
  });
});

describe('join gate in auth', () => {
  it('refuses a join with the gate message, and lets it through when open', async () => {
    const sent: any[] = [];
    const conn: any = { ws: { close: vi.fn() }, joined: false };
    let why: string | null = JOIN_REFUSED;
    const ctx: any = {
      joinGate: () => why,
      send: (_ws: unknown, m: unknown) => sent.push(m),
      userDB: {},
      clients: new Map(),
      everyoneAdmin: false,
      guestAdmin: false,
      contrib: { allowed: () => false },
      enter: () => {},
    };
    await handleJoin(ctx, conn, { username: 'Zed' });
    expect(sent[0]).toMatchObject({ type: 'authResult', success: false, error: JOIN_REFUSED });
    expect(conn.joined).toBe(false);
    why = null;
    await handleJoin(ctx, conn, { username: 'Zed' });
    expect(conn.joined).toBe(true);
  });
});

describe('heartbeat identity', () => {
  it('reports protocol and build, and the server id when set', () => {
    expect(heartbeatIdentity({ BUILD_ID: 'abc123', SERVER_ID: 'fly-lhr' } as never)).toMatchObject({ serverId: 'fly-lhr', build: 'abc123', protocol: expect.any(Number) });
    expect(heartbeatIdentity({} as never).serverId).toBeUndefined();
    expect(buildId({ GIT_COMMIT: 'dead' } as never)).toBe('dead');
  });
});
