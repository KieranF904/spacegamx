/**
 * Snapshot parts pinned on their own: when rounds are due (rounds.ts), interned row keys (rows/keys.ts), a spark a client
 * finds itself (replication/contactFx.ts), the status row's data order (rows/player.ts) and the HUD numbers sent on a
 * change only (systemEntry.ts sendPlayerState).
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { CROWD_BASE_WINDOW, type ServerContactMessage } from '@space-game/common';
import { RoundClock } from './rounds.js';
import { ownHazardKey } from './ownRow.js';
import { RowKeys } from './rows/keys.js';
import { ContactFx } from '../replication/contactFx.js';
import type { ContactWindow } from '../causes/contactsFor.js';
import type { CrowdControl } from '../crowd/CrowdControl.js';
import { joinPilot, makeEmptyServer, resetGlobals, stepServer } from '../../testkits/world.testkit.js';

describe('snapshot rounds', () => {
  it('go every CROWD_BASE_WINDOW ticks for unwidened systems, none in between', () => {
    const ticks = { currentTick: 0 };
    const clock = new RoundClock(null, ticks);
    const rounds: number[] = [];
    for (let t = 1; t <= CROWD_BASE_WINDOW * 5; t++) {
      ticks.currentTick = t;
      const due = clock.due();
      if (due !== false) { rounds.push(t); expect(due === null || due.size === 0).toBe(true); }
    }
    expect(rounds).toEqual([1, 2, 3, 4, 5].map((k) => k * CROWD_BASE_WINDOW));
  });

  it('a widened system is skipped until its wider window comes round', () => {
    const ticks = { currentTick: 0 };
    const crowd = { widened: () => new Map([[7, CROWD_BASE_WINDOW * 3]]), windowOf: (s: number) => (s === 7 ? CROWD_BASE_WINDOW * 3 : CROWD_BASE_WINDOW) } as unknown as CrowdControl;
    const clock = new RoundClock(crowd, ticks);
    const skipped: boolean[] = [];
    for (let t = 1; t <= CROWD_BASE_WINDOW * 6; t++) {
      ticks.currentTick = t;
      const due = clock.due();
      if (due !== false) skipped.push(!!due && due.has(7));
    }
    // (first round takes it, the next two skip it, then it comes round again)
    expect(skipped).toEqual([false, true, true, false, true, true]);
  });
});

describe('interned row keys', () => {
  it('an unchanged key is kept across a round, a changed one replaced; unchanged values are not joined again', () => {
    const keys = new RowKeys();
    const values = [1, 2, 3];
    expect(keys.rowKey(5, values)).toBe('1,2,3');
    expect(keys.internKey(6, 'a')).toBe('a');
    keys.swap();
    const join = vi.spyOn(values, 'join');
    expect(keys.rowKey(5, values)).toBe('1,2,3');
    expect(join).not.toHaveBeenCalled();
    expect(keys.internKey(6, 'a')).toBe('a');
    keys.swap();
    expect(keys.rowKey(5, [1, 2, 4])).toBe('1,2,4');
    expect(keys.internKey(6, 'b')).toBe('b');
  });
});

describe('contact sparks', () => {
  const msg = (n: number) => ({ type: 'contactFx', n }) as unknown as ServerContactMessage;
  const stats = () => ({ fxSent: 0, fxFound: 0 });

  it('a spark a client finds itself is never sent to it, the others are, each once', () => {
    const s = stats();
    const fx = new ContactFx(s);
    const conn = {};
    fx.noteContactFx(10, 1, 100, 101, msg(1));
    fx.noteContactFx(10, 1, 200, 201, msg(2));
    fx.noteContactFx(10, 2, 300, 301, msg(3));
    const found = { pair: (a: number) => a === 100 } as unknown as ContactWindow;
    expect(fx.contactFxFor(conn, 1, found, 10)).toEqual([msg(2)]);
    expect(s).toEqual({ fxSent: 1, fxFound: 1 });
    // (Handed up to tick 10: not again)
    expect(fx.contactFxFor(conn, 1, found, 10)).toEqual([]);
  });

  it('keeps only the last 128 ticks of sparks', () => {
    const fx = new ContactFx(stats());
    const conn = {};
    fx.contactFxFor(conn, 1, null, 0);
    fx.noteContactFx(1, 1, 1, 2, msg(1));
    fx.noteContactFx(500, 1, 3, 4, msg(2));
    expect(fx.contactFxFor(conn, 1, null, 600)).toEqual([msg(2)]);
  });
});

describe('the status row', () => {
  it('puts the tow, weaponry and zone shield values at the data indices features.wire.json gives them', () => {
    const wire = JSON.parse(readFileSync(join(__dirname, '../../../../common/src/ships/features/features.wire.json'), 'utf8')) as { status: { feature: string; index: number }[] };
    const src = readFileSync(join(__dirname, 'rows/player.ts'), 'utf8');
    const used = [...src.matchAll(/h\.features\.status\('(\w+)', eid\)/g)].map((m) => m[1]);
    expect(used).toEqual(wire.status.map((s) => s.feature));
    // (the first six slots are the fixed ones, then the features' in order)
    expect(wire.status.map((s) => s.index)).toEqual(wire.status.map((_, i) => 6 + i));
  });
});

describe('own hazards key', () => {
  it('a hazard that runs out by the next tick leaves the key as if there were none, so it is no ownSync', () => {
    const none = ownHazardKey({ empUntil: 0, slowUntil: 0, numb: 1 }, 100);
    expect(ownHazardKey({ empUntil: 101, slowUntil: 90, numb: 1 }, 100)).toBe(none);
    expect(ownHazardKey({ empUntil: 102, slowUntil: 0, numb: 1 }, 100)).not.toBe(none);
    expect(ownHazardKey({ empUntil: 0, slowUntil: 150, numb: 1 }, 100)).not.toBe(none);
    expect(ownHazardKey({ empUntil: 0, slowUntil: 0, numb: 0.5 }, 100)).not.toBe(none);
    // (A still-running one keeps one key tick after tick: it only changes when it is replaced)
    expect(ownHazardKey({ empUntil: 150, slowUntil: 0, numb: 1 }, 100)).toBe(ownHazardKey({ empUntil: 150, slowUntil: 0, numb: 1 }, 120));
  });
});

describe('playerState', () => {
  it('is sent when it changes (or every 600 ticks), not every tick', () => {
    resetGlobals();
    const server = makeEmptyServer();
    const p = joinPilot(server, 'Hud');
    const count = () => p.got.filter((m) => m.type === 'playerState').length;
    const conn = [...server.clients.values()].find((c) => c.playerId === p.pid)!;
    stepServer(server, 10);
    server.currentTick = 100;
    server.sendPlayerState(conn);
    const settled = count();
    server.sendPlayerState(conn);
    server.sendPlayerState(conn);
    expect(count()).toBe(settled);
    server.pilots.addCredits(server.pilots.connOf(p.pid)!, 50);
    server.sendPlayerState(conn);
    expect(count()).toBe(settled + 1);
    server.sendPlayerState(conn);
    expect(count()).toBe(settled + 1);
    // (Quiet again, until a multiple of 600)
    server.currentTick = 1200;
    server.sendPlayerState(conn);
    expect(count()).toBe(settled + 2);
  });
});
