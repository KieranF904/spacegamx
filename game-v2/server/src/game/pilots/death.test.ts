/**
 * Death, backups and the wreck (game/pilots/death.ts, backups.ts; docs/design/death-rework-2026-11.md): the ship is
 * lost to a plan in the hangar with every part missing, the pilot comes back in a backup (the free starter, or a ship
 * of their own that qualifies), and the wreck holds all of the hold and a share of the parts: its pilot's alone for
 * wreckOwnerMinutes, then anyone's for wreckOpenMinutes, then gone. A death in a boss chamber leaves it outside.
 */
import { describe, it, expect, vi } from 'vitest';
import { Position, Velocity, InSystem, Lifetime, Health, placeCost, cloneJson, type Blueprint, type ServerMessage } from '@space-game/common';
import { DEFAULT_DEATH_RULES } from '../Pilots.js';
import { joinPilot, makeEmptyServer, resetGlobals, stepServer } from '../../testkits/world.testkit.js';
import { startLinger } from '../../gameServer/combatLock.js';
import { lingerSystem } from '../../gameServer/session.js';

const TICKS_PER_MIN = 60 * 60;
const D = DEFAULT_DEATH_RULES;
const ITEMS = ['steel_plate', 'copper_wire', 'alloy_plate', 'crystal_lens', 'coolant', 'nickel_ore', 'power_coupling', 'cryogen'];

function rig() {
  resetGlobals();
  const clock = { t: 1_000_000 };
  const server = makeEmptyServer({ clock: () => clock.t });
  const a = joinPilot(server, 'Victim');
  const b = joinPilot(server, 'Thief');
  const ca = server.pilots.connOf(a.pid)!;
  const cb = server.pilots.connOf(b.pid)!;
  const num = InSystem.systemId[a.pid];
  const spot = { x: 90000, y: 90000 };
  const park = (pid: number, x = spot.x, y = spot.y) => { InSystem.systemId[pid] = num; Position.x[pid] = x; Position.y[pid] = y; Velocity.x[pid] = 0; Velocity.y[pid] = 0; };
  const pods = (server as any).pods;
  const podAt = (x: number, y: number) => [...pods.contents.keys()].find((e: number) => Math.hypot(Position.x[e] - x, Position.y[e] - y) < 50) as number | undefined;
  const last = <T extends ServerMessage['type']>(type: T) => [...a.got].reverse().find((m) => m.type === type) as Extract<ServerMessage, { type: T }> | undefined;
  return { server, clock, a, b, ca, cb, num, spot, park, pods, podAt, last };
}

/** A design of the pilot's own: the starter less its first gun (not the starter design, still a backup) */
function smallerStarter(bp: Blueprint): Blueprint {
  const out = cloneJson(bp);
  out.name = 'Little Sparrow';
  const gun = out.parts.findIndex((q) => q.fn === 'cannon_pip');
  out.parts.splice(gun, 1);
  return out;
}

/** Fly the Prospector plan (bigger than a backup may be), granted */
function flyProspector(w: ReturnType<typeof rig>) {
  const bp = w.server.ships.library.get('prospector')!;
  const p = w.server.pilots.get(w.ca)!;
  expect(w.server.hangar.save(w.ca, p.activeSlot, cloneJson(bp), { grantAll: true })).toEqual([]);
  return p.ship;
}

describe('a death', () => {
  it('loses the ship: its design goes to the hangar with every part missing, lost and on order, and the free starter flies', () => {
    const w = rig();
    const rec = flyProspector(w);
    const p = w.server.pilots.get(w.ca)!;
    const slot = p.activeSlot;
    const name = rec.blueprint.name;
    w.server.pilots.onDestroyed(w.ca, w.num, w.spot.x, w.spot.y, 0, 0);
    const lost = p.hangar[slot]!;
    expect(lost.blueprint.name).toBe(name);
    expect([...lost.ghosts!].sort()).toEqual(lost.blueprint.parts.map((q) => q.uid).sort());
    expect(lost.lost && lost.auto).toBe(true);
    expect(lost.hp).toEqual({});
    expect(lost.blueprint.parts.some((q) => q.gems?.length)).toBe(false);
    // The free starter flies, in another slot; every part of it free
    expect(p.activeSlot).not.toBe(slot);
    expect(p.ship.blueprint.name).toBe(w.server.pilots.opts.starter.blueprint.name);
    expect(p.ship.free!.length).toBe(p.ship.blueprint.parts.length);
    // Told: the backups on offer (the starter first) and what was lost
    const msg = w.last('backups')!;
    expect(msg.options[0].slot).toBe(-1);
    expect(msg.lost).toBe(name);
    // The hangar won't fly it until it's whole
    w.server.hangar.fly(w.ca, slot);
    expect(p.activeSlot).not.toBe(slot);
  });

  it('the starter is the floor: losing it makes no plan, and another takes its slot', () => {
    const w = rig();
    const p = w.server.pilots.get(w.ca)!;
    const slot = p.activeSlot, slots = p.hangar.filter(Boolean).length;
    w.server.pilots.onDestroyed(w.ca, w.num, w.spot.x, w.spot.y, 0, 0);
    expect(p.activeSlot).toBe(slot);
    expect(p.hangar.filter(Boolean).length).toBe(slots);
    expect(p.hangar.some((r) => r?.lost)).toBe(false);
    expect(w.last('backups')!.lost).toBeUndefined();
    // Again, in the free one: the same
    w.server.pilots.onDestroyed(w.ca, w.num, w.spot.x, w.spot.y, 0, 0);
    expect(p.hangar.filter(Boolean).length).toBe(slots);
    expect(p.activeSlot).toBe(slot);
  });

  it('a ship of their own that qualifies is offered as a backup and flown when chosen; one too big is not', () => {
    const w = rig();
    const p = w.server.pilots.get(w.ca)!;
    const small = smallerStarter(p.ship.blueprint);
    expect(w.server.hangar.save(w.ca, 1, small, { grantAll: true })).toEqual([]);
    const big = cloneJson(w.server.ships.library.get('prospector')!);
    expect(w.server.hangar.save(w.ca, 2, big, { grantAll: true })).toEqual([]);
    w.server.pilots.onDestroyed(w.ca, w.num, w.spot.x, w.spot.y, 0, 0);
    const offered = w.last('backups')!.options.map((o) => o.slot);
    expect(offered).toEqual([-1, 1]);
    const starterSlot = p.activeSlot;
    w.server.pilots.onRespawn(w.ca, 1);
    expect(p.activeSlot).toBe(1);
    expect(p.ship.blueprint.name).toBe('Little Sparrow');
    // (The free starter left behind goes)
    expect(p.hangar[starterSlot] ?? null).toBe(null);
    // A backup lost is lost like any ship
    w.server.pilots.onDestroyed(w.ca, w.num, w.spot.x, w.spot.y, 0, 0);
    expect(p.hangar[1]!.lost).toBe(true);
    // A choice not on offer keeps the starter
    const at = p.activeSlot;
    w.server.pilots.onRespawn(w.ca, 2);
    expect(p.activeSlot).toBe(at);
    expect(w.a.got.some((m) => m.type === 'toast' && /can't be a backup/.test((m as any).text))).toBe(true);
  });

  it('the free starter\'s parts are never salvaged, scrapped or refunded', () => {
    const w = rig();
    const p = w.server.pilots.get(w.ca)!;
    w.server.pilots.onDestroyed(w.ca, w.num, w.spot.x, w.spot.y, 0, 0); // (now in a free one)
    // Dying in it with an empty hold: no wreck at all (nothing to salvage)
    w.server.pilots.onDestroyed(w.ca, w.num, w.spot.x + 5000, w.spot.y, 0, 0);
    expect(w.podAt(w.spot.x + 5000, w.spot.y)).toBeUndefined();
    // Taking a part out of it gives nothing back
    const storage = JSON.stringify(p.storage);
    const bp = cloneJson(p.ship.blueprint);
    bp.parts.splice(bp.parts.findIndex((q) => q.fn === 'cannon_pip'), 1);
    expect(w.server.hangar.save(w.ca, p.activeSlot, bp)).toEqual([]);
    expect(JSON.stringify(p.storage)).toBe(storage);
    expect(p.ship.free!.length).toBe(bp.parts.length);
  });
});

describe('a wreck', () => {
  it('holds all of the hold and a share of the parts as salvage (modules as items, structure as materials)', () => {
    const w = rig();
    const rec = flyProspector(w);
    const standing = rec.blueprint.parts.length;
    for (const id of ITEMS) w.server.pilots.give(w.ca, { [id]: 3 }, { quiet: true });
    const p = w.server.pilots.get(w.ca)!;
    const held = Object.fromEntries(p.cargo.map((s) => [s.id, s.n]));
    w.server.pilots.onDestroyed(w.ca, w.num, w.spot.x, w.spot.y, 0, 0);
    expect(p.cargo).toEqual([]);
    const inside = { ...w.pods.get(w.podAt(w.spot.x, w.spot.y)) } as Record<string, number>;
    for (const [id, n] of Object.entries(held)) expect(inside[id]).toBeGreaterThanOrEqual(n);
    for (const [id, n] of Object.entries(held)) inside[id] -= n;
    // What's left is whole parts, round(salvageShare) of them: each part's placeCost
    const salvage = Object.fromEntries(Object.entries(inside).filter(([, n]) => n > 0));
    const want = Math.round(standing * D.salvageShare);
    expect(want).toBeGreaterThan(0);
    const ids = new Set(rec.blueprint.parts.flatMap((q) => Object.keys(placeCost(w.server.econ, q))));
    for (const id of Object.keys(salvage)) expect(ids.has(id)).toBe(true);
    expect(Object.keys(salvage).length).toBeGreaterThan(0);
    // (No more modules than the share of parts picked)
    const modules = Object.entries(salvage).filter(([id]) => id.startsWith('part:')).reduce((n, [, k]) => n + k, 0);
    expect(modules).toBeLessThanOrEqual(want);
  });

  it('is its pilot\'s alone for wreckOwnerMinutes, then anyone\'s for wreckOpenMinutes, then gone; the marker says so', () => {
    const w = rig();
    const keep = vi.spyOn(w.pods, 'keep');
    for (const id of ITEMS) w.server.pilots.give(w.ca, { [id]: 3 }, { quiet: true });
    w.server.pilots.onDestroyed(w.ca, w.num, w.spot.x, w.spot.y, 0, 0);
    expect(keep).toHaveBeenCalledTimes(1);
    const [eid, key, until] = keep.mock.calls[0] as [number, string, number];
    expect(key).toBe(w.server.pilots.keyOf(w.ca));
    expect(until).toBe(w.server.currentTick + D.wreckOwnerMinutes * TICKS_PER_MIN);
    expect(Lifetime.remaining[eid]).toBe((D.wreckOwnerMinutes + D.wreckOpenMinutes) * TICKS_PER_MIN);
    const mark = w.server.pilots.get(w.ca)!.wreck!;
    expect(mark.until - w.clock.t).toBe(D.wreckOwnerMinutes * 60_000);
    expect(mark.gone! - w.clock.t).toBe((D.wreckOwnerMinutes + D.wreckOpenMinutes) * 60_000);
    const msg = w.last('wreck')!;
    expect([msg.seconds, msg.open]).toEqual([D.wreckOwnerMinutes * 60, D.wreckOpenMinutes * 60]);
    // The thief beside it takes nothing while it's kept, then can
    const held = () => w.server.pilots.get(w.cb)!.cargo.reduce((n, s) => n + s.n, 0);
    const before = held();
    for (let i = 0; i < 20; i++) { w.park(w.b.pid); stepServer(w.server, 1); }
    expect(held()).toBe(before);
    w.server.currentTick = until;
    for (let i = 0; i < 20; i++) { w.park(w.b.pid); stepServer(w.server, 1); }
    expect(held()).toBeGreaterThan(before);
  });

  it('a death inside a boss chamber leaves it outside the barrier', () => {
    const w = rig();
    const gd = w.server.gameData;
    const sys = gd.getSystem('ashfall_cavern')!;
    const num = gd.getSystemNum('ashfall_cavern');
    const arena = sys.arena!;
    w.server.pilots.give(w.ca, { steel_plate: 4 }, { quiet: true });
    w.server.pilots.onDestroyed(w.ca, num, arena.centre.x, arena.centre.y, 30, 0);
    expect(w.podAt(arena.outside.x, arena.outside.y)).toBeDefined();
    expect(InSystem.systemId[w.podAt(arena.outside.x, arena.outside.y)!]).toBe(num);
    expect(w.server.pilots.get(w.ca)!.wreck).toMatchObject({ system: 'ashfall_cavern', x: arena.outside.x, y: arena.outside.y });
  });
});

describe('quitting mid-fight', () => {
  it('a ship destroyed while it lingers is a death like any other: lost to a plan, its hold in a wreck', async () => {
    const w = rig();
    flyProspector(w);
    const p = w.server.pilots.get(w.ca)!;
    const slot = p.activeSlot;
    w.server.pilots.give(w.ca, { steel_plate: 4 }, { quiet: true });
    const gs = w.server as any;
    const conn = gs.clients.get([...gs.clients.keys()].find((ws: any) => gs.clients.get(ws).playerId === w.a.pid));
    conn.userId = 77; // (only a signed-in pilot's ship lingers)
    gs.combat.note(w.a.pid, -1, gs.currentTick);
    // (As the socket's close does: off the clients, then the ship lingers)
    gs.clients.delete(conn.ws);
    expect(startLinger(gs, conn)).toBe(true);
    w.park(w.a.pid);
    Health.current[w.a.pid] = 0;
    stepServer(w.server, 1);
    lingerSystem(gs);
    expect(p.hangar[slot]!.lost).toBe(true);
    expect(p.wreck).toBeDefined();
  });
});
