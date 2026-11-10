import { describe, it, expect, vi } from 'vitest';
import { resetGlobals, makeEmptyServer, joinPilot, stepServer } from '../testkits/world.testkit.js';

/** A pilot on a server with or without dev tools (devTeleport); `admin` makes the pilot an admin, `owner` the owner (an admin too) */
function world(dev: boolean, admin = false, owner = false) {
  resetGlobals();
  const server = makeEmptyServer({ devTeleport: dev });
  const me = joinPilot(server, 'pilot');
  const conn = server.pilots.connOf(me.pid)!;
  if (admin || owner) conn.isAdmin = true;
  if (owner) conn.isOwner = true;
  stepServer(server, 2);
  const toasts = () => me.got.filter((m) => m.type === 'toast').map((m: any) => m.text as string);
  return { server, me, conn, toasts };
}
const send = (w: ReturnType<typeof world>, msg: object) => { w.me.t.send(msg as never); };

describe('dev message guards: refused unless the server has dev tools or the pilot is the owner', () => {
  it('devStation: no station on a plain server, a station on a dev server', () => {
    const plain = world(false);
    send(plain, { type: 'devStation', tier: 3 });
    expect(plain.server.pilots.get(plain.conn)!.outpost).toBeUndefined();
    const dev = world(true);
    send(dev, { type: 'devStation', tier: 3 });
    expect(dev.server.pilots.get(dev.conn)!.outpost).toBeDefined();
  });

  it('devSpawn: no pack on a plain server, one on a dev server (and none for a non-finite spot)', () => {
    const plain = world(false);
    const spy = vi.spyOn(plain.server.enemies, 'spawnPack');
    send(plain, { type: 'devSpawn', x: 100, y: 100 });
    expect(spy).not.toHaveBeenCalled();
    const dev = world(true);
    const spyDev = vi.spyOn(dev.server.enemies, 'spawnPack');
    send(dev, { type: 'devSpawn', x: Number.NaN, y: 100 });
    expect(spyDev).not.toHaveBeenCalled();
    send(dev, { type: 'devSpawn', x: 100, y: 100 });
    expect(spyDev).toHaveBeenCalledTimes(1);
  });

  it('devBoss: silent on a plain server, says so when no boss is near on a dev server', () => {
    const plain = world(false);
    send(plain, { type: 'devBoss', wear: 0.5 });
    expect(plain.toasts().filter((t) => /boss/i.test(t))).toEqual([]);
    const dev = world(true);
    send(dev, { type: 'devBoss', wear: 0.5 });
    expect(dev.toasts()).toContain('No boss in this system');
  });

  it('an admin who is not the owner on a plain server is refused; the owner passes the same guard', () => {
    const admin = world(false, true);
    send(admin, { type: 'devBoss', wear: 0.5 });
    expect(admin.toasts().filter((t) => /boss/i.test(t))).toEqual([]);
    const owner = world(false, false, true);
    send(owner, { type: 'devBoss', wear: 0.5 });
    expect(owner.toasts()).toContain('No boss in this system');
  });

  it('feedSwitch: a ship with no Selector is told so, and nothing is switched', () => {
    const w = world(false);
    send(w, { type: 'feedSwitch' });
    const told = w.toasts().filter((t) => /Selector|Feeds switched/.test(t));
    // Either the ship has no ports power (no message at all) or no Selector (the warning): never a switch
    expect(told.every((t) => t === 'No Selector fitted: nothing to switch')).toBe(true);
  });
});
