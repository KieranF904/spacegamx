/**
 * The pickup panel and the hold's ghosts (docs/design/loot-pickup-2026-11.md C, D; LootPods.ts, pilots/pickup.ts):
 * ore comes in by itself, anything else waits in its pod for the panel unless the hold has a ghost of it; the panel's
 * take is one message, checked for reach, a wreck's keeping and room; each pilot hears what is in reach when it changes.
 */
import { describe, it, expect } from 'vitest';
import { Position, Velocity, InSystem, countOf, GHOST_RESERVE, type ServerMessage } from '@space-game/common';
import { joinPilot, makeEmptyServer, resetGlobals, stepServer } from '../testkits/world.testkit.js';

function rig() {
  resetGlobals();
  const server = makeEmptyServer();
  const a = joinPilot(server, 'Picker');
  const b = joinPilot(server, 'Other');
  const ca = a.conn, cb = b.conn;
  const num = InSystem.systemId[a.pid];
  const park = (pid: number, x: number, y: number) => { InSystem.systemId[pid] = num; Position.x[pid] = x; Position.y[pid] = y; Velocity.x[pid] = 0; Velocity.y[pid] = 0; };
  park(a.pid, 90000, 90000);
  park(b.pid, -90000, -90000);
  const p = () => server.pilots.get(ca)!;
  const pod = (items: Record<string, number>, dx = 150) => server.pods.spawn(num, 90000 + dx, 90000, 0, 0, items);
  /** Step, keeping both ships where they are */
  const step = (n: number) => { for (let i = 0; i < n; i++) { Velocity.x[a.pid] = 0; Velocity.y[a.pid] = 0; Velocity.x[b.pid] = 0; Velocity.y[b.pid] = 0; stepServer(server, 1); } };
  const last = <T extends ServerMessage['type']>(got: ServerMessage[], type: T) => [...got].reverse().find((m) => m.type === type) as Extract<ServerMessage, { type: T }> | undefined;
  const send = (m: unknown) => a.t.send(m as never);
  return { server, a, b, ca, cb, num, park, p, pod, step, last, send };
}

describe('auto pickup', () => {
  it('ore comes in by itself; the rest of the pod waits, and the panel hears what is in reach', () => {
    const w = rig();
    const eid = w.pod({ iron_ore: 4, scrap_electronics: 2 });
    w.step(120);
    expect(countOf(w.p().cargo, 'iron_ore')).toBe(4);
    expect(countOf(w.p().cargo, 'scrap_electronics')).toBe(0);
    expect(w.server.pods.get(eid)).toEqual({ scrap_electronics: 2 });
    const near = w.last(w.a.got, 'lootNear')!;
    expect(near.pods).toEqual([{ id: eid, items: { scrap_electronics: 2 } }]);
    // (Only when it changes: nothing new is sent while it stays as it is)
    const count = w.a.got.filter((m) => m.type === 'lootNear').length;
    w.step(60);
    expect(w.a.got.filter((m) => m.type === 'lootNear').length).toBe(count);
  });

  it('mining mode off: ore waits too', () => {
    const w = rig();
    w.send({ type: 'pickupPrefs', mining: false });
    expect(w.p().pickup?.miningOff).toBe(true);
    const eid = w.pod({ iron_ore: 4 });
    w.step(120);
    expect(countOf(w.p().cargo, 'iron_ore')).toBe(0);
    expect(w.server.pods.get(eid)).toEqual({ iron_ore: 4 });
    w.send({ type: 'pickupPrefs', mining: true });
    expect(w.p().pickup).toBeUndefined();
  });

  it('Blacklist & jettison: the ore is thrown out and mining mode leaves it from then on; only ores can be listed', () => {
    const w = rig();
    w.server.pilots.give(w.ca, { nickel_ore: 6 }, { quiet: true });
    w.send({ type: 'oreBlacklist', item: 'nickel_ore', on: true, jettison: true });
    expect(countOf(w.p().cargo, 'nickel_ore')).toBe(0);
    expect(w.p().pickup?.blacklist).toEqual(['nickel_ore']);
    w.send({ type: 'oreBlacklist', item: 'servo_motor', on: true });
    expect(w.p().pickup?.blacklist).toEqual(['nickel_ore']);
    const eid = w.pod({ nickel_ore: 3, iron_ore: 2 }, -150);
    w.step(120);
    expect(countOf(w.p().cargo, 'iron_ore')).toBe(2);
    expect(countOf(w.p().cargo, 'nickel_ore')).toBe(0);
    expect(w.server.pods.get(eid)).toEqual({ nickel_ore: 3 });
    // (A ghost of it still collects it)
    w.send({ type: 'ghost', item: 'nickel_ore' });
    w.step(120);
    expect(countOf(w.p().cargo, 'nickel_ore')).toBe(3);
    w.send({ type: 'oreBlacklist', item: 'nickel_ore', on: false });
    expect(w.p().pickup).toBeUndefined();
  });

  it('a ghost collects its item; with a target it stops there and the stack is real', () => {
    const w = rig();
    w.send({ type: 'ghost', item: 'servo_motor', n: 3 });
    expect(w.p().ship.wants).toEqual([{ item: 'servo_motor', n: 3 }]);
    w.step(5);
    expect(w.last(w.a.got, 'items')!.ghosts).toEqual([{ item: 'servo_motor', n: 3 }]);
    const eid = w.pod({ servo_motor: 5 });
    w.step(120);
    expect(countOf(w.p().cargo, 'servo_motor')).toBe(3);
    expect(w.server.pods.get(eid)).toEqual({ servo_motor: 2 });
    expect(w.p().ship.wants).toBeUndefined();
    // Unlimited: always
    w.send({ type: 'ghost', item: 'servo_motor' });
    w.step(120);
    expect(countOf(w.p().cargo, 'servo_motor')).toBe(5);
    w.send({ type: 'ghost', item: 'servo_motor', remove: true });
    expect(w.p().ship.wants).toBeUndefined();
  });

  it("ore can't use the space an unlimited ghost keeps", () => {
    const w = rig();
    const cap = w.server.pilots.cargoCapacity(w.ca);
    w.send({ type: 'ghost', item: 'servo_motor' });
    w.pod({ iron_ore: cap + 10 });
    w.step(120);
    expect(countOf(w.p().cargo, 'iron_ore')).toBe(cap - GHOST_RESERVE);
    // ...which the ghost's own item may
    w.pod({ servo_motor: 9 }, -150);
    w.step(120);
    expect(countOf(w.p().cargo, 'servo_motor')).toBe(GHOST_RESERVE);
  });
});

describe('the pickup panel', () => {
  it('takes one item, or everything, from the pods in reach; nothing out of reach', () => {
    const w = rig();
    w.send({ type: 'pickupPrefs', mining: false });
    const near = w.pod({ scrap_electronics: 2, copper_wire: 3 });
    const far = w.pod({ scrap_electronics: 7 }, 3000);
    w.send({ type: 'lootTake', item: 'scrap_electronics' });
    expect(countOf(w.p().cargo, 'scrap_electronics')).toBe(2);
    expect(w.server.pods.get(near)).toEqual({ copper_wire: 3 });
    expect(w.server.pods.get(far)).toEqual({ scrap_electronics: 7 });
    expect(w.a.got.some((m) => m.type === 'gained' && (m as any).items.scrap_electronics === 2)).toBe(true);
    w.send({ type: 'lootTake' });
    expect(countOf(w.p().cargo, 'copper_wire')).toBe(3);
    expect(w.server.pods.get(near)).toBeUndefined();
  });

  it("only what fits; a full hold says so; someone else's wreck is locked until it opens", () => {
    const w = rig();
    const cap = w.server.pilots.cargoCapacity(w.ca);
    w.server.pilots.give(w.ca, { iron_ore: cap - 1 }, { quiet: true });
    const eid = w.pod({ copper_wire: 4 });
    w.send({ type: 'lootTake' });
    expect(countOf(w.p().cargo, 'copper_wire')).toBe(1);
    expect(w.server.pods.get(eid)).toEqual({ copper_wire: 3 });
    w.a.got.length = 0;
    w.send({ type: 'lootTake' });
    expect(w.a.got.some((m) => m.type === 'toast' && /full/i.test((m as any).text))).toBe(true);
    // The other pilot's wreck, kept for them
    const wreck = w.pod({ crystal_lens: 2 }, -150);
    w.server.pods.keep(wreck, w.server.pilots.keyOf(w.cb)!, w.server.currentTick + 600);
    w.server.pilots.take(w.ca, { iron_ore: cap - 1 }, 'cargo');
    w.step(10);
    const listed = w.last(w.a.got, 'lootNear')!.pods.find((q) => q.id === wreck)!;
    expect(listed.lock).toBeGreaterThan(0);
    w.send({ type: 'lootTake', item: 'crystal_lens' });
    expect(countOf(w.p().cargo, 'crystal_lens')).toBe(0);
  });
});

describe('ghosts belong to the ship', () => {
  it('a template saves and loads them; a death clears the hold of them', () => {
    const w = rig();
    w.send({ type: 'ghost', item: 'servo_motor' });
    w.send({ type: 'ghost', item: 'copper_wire', n: 20 });
    w.send({ type: 'ghostTemplate', save: 'Salvage run' });
    expect(w.p().pickup?.templates).toEqual([{ name: 'Salvage run', ghosts: [{ item: 'servo_motor' }, { item: 'copper_wire', n: 20 }] }]);
    w.step(5);
    expect(w.last(w.a.got, 'profile')?.pickup ?? (w.last(w.a.got, 'profileDelta') as any)?.o?.pickup).toBeTruthy();
    w.server.pilots.onDestroyed(w.ca, w.num, 90000, 90000, 0, 0);
    expect(w.p().ship.wants).toBeUndefined();
    w.send({ type: 'ghostTemplate', load: 'Salvage run' });
    expect(w.p().ship.wants).toEqual([{ item: 'servo_motor' }, { item: 'copper_wire', n: 20 }]);
    w.send({ type: 'ghostTemplate', remove: 'Salvage run' });
    expect(w.p().pickup).toBeUndefined();
  });
});
