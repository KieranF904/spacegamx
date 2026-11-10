/**
 * A pilot's wreck (game/pilots/death.ts onDestroyed): the cargo that is not in the secure hold is kept for its pilot's
 * account for DeathRules.wreckMinutes: another pilot beside it takes nothing until the keeping runs out, then anyone can.
 */
import { describe, it, expect, vi } from 'vitest';
import { Position, Velocity, InSystem } from '@space-game/common';
import { DEFAULT_DEATH_RULES } from '../Pilots.js';
import { joinPilot, makeServer, resetGlobals, stepServer } from '../../testkits/world.testkit.js';

const TICKS_PER_MIN = 60 * 60;

function rig() {
  resetGlobals();
  const clock = { t: 1_000_000 };
  const server = makeServer({ clock: () => clock.t });
  const a = joinPilot(server, 'Victim');
  const b = joinPilot(server, 'Thief');
  const ca = server.pilots.connOf(a.pid)!;
  const cb = server.pilots.connOf(b.pid)!;
  const num = InSystem.systemId[a.pid];
  const spot = { x: 90000, y: 90000 };
  const park = (pid: number) => { InSystem.systemId[pid] = num; Position.x[pid] = spot.x; Position.y[pid] = spot.y; Velocity.x[pid] = 0; Velocity.y[pid] = 0; };
  return { server, clock, a, b, ca, cb, num, spot, park };
}

describe('a wreck', () => {
  it('is kept for its pilot for wreckMinutes: the pod, the pilot\'s marker and the pod\'s keeping agree', () => {
    const { server, clock, ca, num, spot } = rig();
    // (The spot is outside safe space, so the cargo is not kept whole)
    expect(server.pilots.host.safeAt?.(num, spot.x, spot.y)).toBe(false);
    const keep = vi.spyOn(server.pods, 'keep');
    // (Many stacks: the secure hold keeps a few, the rest goes with the wreck)
    const items = ['steel_plate', 'copper_wire', 'alloy_plate', 'crystal_lens', 'coolant', 'nickel_ore', 'power_coupling', 'cryogen'];
    for (const id of items) server.pilots.give(ca, { [id]: 3 }, { quiet: true });
    server.pilots.onDestroyed(ca, num, spot.x, spot.y, 0, 0);
    expect(keep).toHaveBeenCalledTimes(1);
    const [, key, until] = keep.mock.calls[0];
    expect(key).toBe(server.pilots.keyOf(ca));
    expect(until).toBe(server.currentTick + DEFAULT_DEATH_RULES.wreckMinutes * TICKS_PER_MIN);
    const w = server.pilots.get(ca)!.wreck!;
    expect(w.until - clock.t).toBe(DEFAULT_DEATH_RULES.wreckMinutes * 60_000);
    expect([w.x, w.y]).toEqual([spot.x, spot.y]);
  });

  it('is not collected by another pilot beside it until the keeping runs out', () => {
    const { server, ca, cb, b, num, spot, park } = rig();
    const keep = vi.spyOn(server.pods, 'keep');
    for (const id of ['steel_plate', 'copper_wire', 'alloy_plate', 'crystal_lens', 'coolant', 'nickel_ore', 'power_coupling', 'cryogen']) server.pilots.give(ca, { [id]: 3 }, { quiet: true });
    server.pilots.onDestroyed(ca, num, spot.x, spot.y, 0, 0);
    const until = keep.mock.calls[0][2] as number;
    const held = () => server.pilots.get(cb)!.cargo.reduce((n, s) => n + s.n, 0);
    const before = held();
    // (The thief sits on the wreck: it would be pulled in at once if it were not kept)
    for (let i = 0; i < 20; i++) { park(b.pid); stepServer(server, 1); }
    expect(held()).toBe(before);
    // (The keeping over)
    server.currentTick = until;
    for (let i = 0; i < 20; i++) { park(b.pid); stepServer(server, 1); }
    expect(held()).toBeGreaterThan(before);
  });
});
