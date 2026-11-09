/**
 * Field machines in the full server (docs/design/field-fabrication.md sections 5 and 5.1): a pilot's fabricator
 * rebuilds and repairs parts from the hold while the ship flies, the core's own does it slowly without power, jobs
 * progress by the energy the machine took (machEu) and nothing streams, the hold full stalls a machine with nothing
 * lost, finished parts follow the orphan rule, recycling gives half back leaf first, a build view save is free, adds
 * its new parts as missing parts (no ghosts) and keeps the live blueprint valid, and packs pay one unit each and go faster.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import {
  Position, Velocity, Rotation, MACHINE_FAB, attachWork, fabWork, jobEu, jobTicks, portsMachineEu, portsMachinePart, recycleReturn,
  tierRule, partItemId, loadCatalog, packShare, fieldPay, packDefs, type Bag, type Blueprint, type PlacedPart, type Rot, type ServerMessage,
} from '@space-game/common';
import { GameServer } from '../../GameServer.js';
import { GameData } from '../../data/GameData.js';
import { LocalTransport } from '../../net/LocalTransport.js';
import { readGameDataFiles } from '../../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../../ships/loadShipConfig.js';
import { createShipBridge } from '../../proto/createProtoServer.js';
import type { FieldShips } from './FieldShips.js';
import { ShipStore } from '../../../../client/src/ships/ShipStore.js';

const dataDir = join(__dirname, '../../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);
const config = loadShipConfigCached(dataDir);
const catalog = loadCatalog(config.catalog);

const part = (uid: number, piece: string, fn: string, x: number, y: number, extra: Partial<PlacedPart> = {}): PlacedPart =>
  ({ uid, piece, fn, material: catalog.functions.get(fn)?.material ?? 'alloy', x, y, rot: 0 as Rot, flip: false, ...extra });

/**
 * A 2x1 core with two Pips on top; a Field Fabricator under it, fed by `reactors` Cell Reactors under that (none: no
 * fabricator part at all, and no power)
 */
function design(opts: { reactors?: number; fabricator?: boolean; fabRot?: Rot } = {}): Blueprint {
  const parts: PlacedPart[] = [
    part(0, 'rect2', 'core', 0, 0),
    part(1, 'sq', 'cannon_pip', 0, -1, { facing: 'N' }), part(2, 'sq', 'cannon_pip', 1, -1, { facing: 'N' }),
  ];
  if (opts.fabricator !== false) {
    parts.push(part(3, 'rect2', 'fabricator_field', 0, 1, { rot: opts.fabRot ?? 0 }));
    const r = opts.reactors ?? 2;
    if (r >= 1) parts.push(part(4, 'sq', 'power_cell_reactor', 0, 2));
    if (r >= 2) parts.push(part(5, 'sq', 'power_cell_reactor', 1, 2));
  }
  return { name: 'Field test', catalogVersion: catalog.version, power: 'ports', parts };
}

/** `bank`: keep the repair bank's free part (full; its spare pays repairs and rebuilds of the ship's own parts). Off: emptied, so the hold alone pays */
function world(bp: Blueprint, opts: { bank?: boolean } = {}) {
  resetGlobals();
  const server = new GameServer({
    gameData: new GameData(files),
    userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as any,
    scene: 'sectors',
    autoStart: false,
    ships: createShipBridge(config),
    clock: () => 1_000_000,
  });
  const t = new LocalTransport(server);
  const got: ServerMessage[] = [];
  t.onMessage = (m) => got.push(m);
  t.connect();
  t.send({ type: 'join', username: 'wright' } as any);
  const pid = t.getPlayerId();
  const conn = server.pilots.connOf(pid)!;
  const prof = server.pilots.get(conn)!;
  // Out in open space, away from anything (no station, no repairs but our own)
  Position.x[pid] = 40000; Position.y[pid] = 40000; Velocity.x[pid] = 0; Velocity.y[pid] = 0; Rotation.angle[pid] = -Math.PI / 2;
  prof.cargo = [];
  prof.ship.blueprint = JSON.parse(JSON.stringify(bp));
  prof.ship.hp = {};
  prof.ship.ghosts = [];
  delete prof.ship.field;
  if (!opts.bank) server.pilots.bank.dev(prof, 'empty', undefined, 1_000_000);
  server.pilots.reapplyShip(conn);
  const ships = server.getShips()!;
  const run = (n: number) => { for (let k = 0; k < n; k++) server.step(); };
  const field = () => (server as any).features.get('machines') as FieldShips;
  const ship = () => ships.get(pid)!;
  const idx = (uid: number) => ship().blueprint.parts.findIndex((p) => p.uid === uid);
  const alive = (uid: number) => { const i = idx(uid); return i >= 0 && !!ship().derived.alive[i]; };
  const give = (items: Bag) => server.pilots.give(conn, items, { quiet: true });
  const hold = (id: string) => prof.cargo.find((s) => s.id === id)?.n ?? 0;
  const send = (msg: Record<string, unknown>) => t.send(msg as any);
  const states = () => got.filter((m) => m.type === 'fieldState') as Extract<ServerMessage, { type: 'fieldState' }>[];
  const dones = () => got.filter((m) => m.type === 'fieldDone') as Extract<ServerMessage, { type: 'fieldDone' }>[];
  const lastState = () => states().at(-1)!;
  const fabView = () => lastState().machines.find((m) => m.kind === 'fabricator')!;
  /** Destroy a part (its HP to nothing; the ship rebuilds at the tick's rebuild point) */
  const destroy = (uid: number) => { const i = idx(uid); ships.damagePartBy(pid, i, ship().hp[i] + 1, -1); run(2); expect(alive(uid)).toBe(false); };
  run(2);
  return { server, t, got, pid, conn, prof, ships, run, field, ship, idx, alive, give, hold, send, states, dones, lastState, fabView, destroy };
}

const pip = { fn: 'cannon_pip', material: 'alloy', piece: 'sq' };

/** Run until `done` (at most `max` ticks): how many ticks it took */
function until(w: ReturnType<typeof world>, done: () => boolean, max: number): number {
  for (let k = 1; k <= max; k++) { w.run(1); if (done()) return k; }
  return -1;
}

describe('field fabricator: rebuilding a lost part', () => {
  it('makes then attaches a destroyed Pip from the hold, in the ticks jobEu gives at full power', () => {
    const w = world(design());
    const e = (w.server as any).econ;
    const inputs = e.recipes.partInputs(pip) as Bag;
    w.destroy(1);
    w.give(inputs);
    const L = w.ship().derived.ports!;
    const fab = portsMachinePart(L, MACHINE_FAB);
    expect(fab).toBe(w.idx(3));
    const rate = L.rate[fab];
    const speed = tierRule('fabricator', 1).speed;
    const make = jobEu(fabWork(e, pip), speed, rate), attach = jobEu(attachWork(w.ships.catalog, pip), speed, rate);
    w.send({ type: 'machine', kind: 'fabricator', on: true });
    w.run(1);
    // Started: inputs out of the hold, into the job; drawing
    expect(w.hold('alloy_plate')).toBe(0);
    const v = w.fabView();
    expect(v.drawing).toBe(true);
    expect(v.job?.kind).toBe('build');
    expect(v.job?.uid).toBe(1);
    expect(v.job?.need).toBe(make);
    expect(v.job?.attachNeed).toBe(attach);
    expect(v.job?.held).toEqual(inputs);
    const eu0 = portsMachineEu(w.ships.chargeOf(w.pid).e!, MACHINE_FAB);
    const ticks = until(w, () => w.alive(1), 5000);
    // (Fed in full: one tick's draw a tick, so the ticks are the eu over the rate, a tick or two either side for the switch and the rebuild point)
    expect(Math.abs(ticks - (make + attach) / rate)).toBeLessThanOrEqual(3);
    expect(portsMachineEu(w.ships.chargeOf(w.pid).e!, MACHINE_FAB) - eu0).toBeGreaterThanOrEqual(make + attach);
    const d = w.dones().at(-1)!;
    expect(d).toMatchObject({ kind: 'fabricator', item: partItemId(pip), to: 'ship', uid: 1 });
    // The record follows the live ship
    expect(w.prof.ship.blueprint.parts.length).toBe(w.ship().blueprint.parts.length);
    // (The blast that took the Pip also scratched the core: the machine mends that, free, then rests)
    expect(until(w, () => !w.fabView().drawing, 3000)).toBeGreaterThan(0);
  });

  it('at half power it takes twice as long; switched off it draws nothing and stands still', () => {
    const full = world(design());
    const e = (full.server as any).econ;
    full.destroy(1);
    full.give(e.recipes.partInputs(pip));
    full.send({ type: 'machine', kind: 'fabricator', on: true });
    const tFull = until(full, () => full.alive(1), 5000);

    // Half power: no generator; the Field Fabricator turned to take its power from the core, whose store is topped up
    // by half the machine's draw each tick (as a generator making half of it would), the stores empty to begin with
    const half = world(design({ reactors: 0, fabRot: 2 }));
    half.destroy(1);
    half.give(e.recipes.partInputs(pip));
    const c = () => half.ships.chargeOf(half.pid).e!;
    const L = () => half.ship().derived.ports!;
    const fab = () => portsMachinePart(L(), MACHINE_FAB);
    const rate = L().rate[fab()];
    c().held[0] = 0; c().held[fab()] = 0;
    const step = (n: number) => { for (let k = 0; k < n; k++) { c().held[0] = Math.min(L().cap[0], c().held[0] + rate / 2); half.run(1); } };
    half.send({ type: 'machine', kind: 'fabricator', on: true });
    step(30);
    const eu0 = portsMachineEu(c(), MACHINE_FAB);
    step(60);
    const perTick = (portsMachineEu(c(), MACHINE_FAB) - eu0) / 60;
    expect(perTick).toBeCloseTo(rate / 2, 0);
    // Off: no draw, no progress (and its progress and inputs kept)
    half.send({ type: 'machine', kind: 'fabricator', on: false });
    step(1);
    const job = half.fabView().job!;
    expect(half.fabView().drawing).toBe(false);
    const euOff = portsMachineEu(c(), MACHINE_FAB);
    // (No top-up while it is off: a generator with nothing to feed makes nothing it keeps here)
    half.run(120);
    expect(portsMachineEu(c(), MACHINE_FAB)).toBe(euOff);
    expect(half.alive(1)).toBe(false);
    half.send({ type: 'machine', kind: 'fabricator', on: true });
    step(1);
    expect(half.fabView().job!.id).toBe(job.id);
    expect(half.fabView().job!.done).toBe(job.done);
    let tHalf = 90;
    for (; tHalf < 10000 && !half.alive(1); tHalf++) step(1);
    // (Twice the full-power time, give or take the ticks around the switches)
    expect(Math.abs(tHalf - 2 * tFull)).toBeLessThanOrEqual(12);
  });

  it('with no fabricator and no generator, the core builds a Pip itself at a quarter speed', () => {
    const w = world(design({ fabricator: false }));
    const e = (w.server as any).econ;
    expect(w.ship().derived.ports?.machineDraw ?? 0).toBe(0);
    w.destroy(2);
    w.give(e.recipes.partInputs(pip));
    w.send({ type: 'machine', kind: 'fabricator', on: true });
    w.run(1);
    const v = w.fabView();
    expect(v).toMatchObject({ tier: 0, uid: -1, drawing: true });
    const ticks = jobTicks(fabWork(e, pip), 0.25) + jobTicks(attachWork(w.ships.catalog, pip), 0.25);
    expect(v.job!.need + v.job!.attachNeed).toBe(ticks);
    const took = until(w, () => w.alive(2), 5000);
    expect(Math.abs(took - ticks)).toBeLessThanOrEqual(3);
  });

  it('a damaged core is mended in the field, free, by the core\'s own slow fabricator (no fabricator part, no hold)', () => {
    const w = world(design({ fabricator: false }));
    const core = w.idx(0);
    w.ships.damagePartFraction(w.pid, core, 0.5);
    w.run(2);
    expect(w.ship().hp[core]).toBeLessThan(w.ship().maxHp[core] * 0.6);
    w.send({ type: 'machine', kind: 'fabricator', on: true });
    w.run(1);
    expect(w.fabView()).toMatchObject({ tier: 0, uid: -1, drawing: true });
    const took = until(w, () => w.ship().hp[core] >= w.ship().maxHp[core] - 1e-6, 6000);
    expect(took).toBeGreaterThan(0);
    expect(w.prof.cargo).toEqual([]);
  });

  it('a damaged core is mended by a fabricator part too', () => {
    const w = world(design());
    const core = w.idx(0);
    w.ships.damagePartFraction(w.pid, core, 0.5);
    w.run(2);
    w.send({ type: 'machine', kind: 'fabricator', on: true });
    const took = until(w, () => w.ship().hp[core] >= w.ship().maxHp[core] - 1e-6, 6000);
    expect(took).toBeGreaterThan(0);
  });

  it("refuses what is past the machine's grade and says so", () => {
    const steelPip: Blueprint = design({ fabricator: false });
    // (A Field Fabricator can make up to Mk II; the core only starter parts: a steel hull is past the core)
    steelPip.parts.push(part(6, 'sq', 'hull', -1, 0, { material: 'steel' }));
    const w = world(steelPip);
    w.destroy(6);
    const e = (w.server as any).econ;
    w.give(e.recipes.partInputs({ fn: 'hull', material: 'steel', piece: 'sq' }));
    w.send({ type: 'machine', kind: 'fabricator', on: true });
    w.run(2);
    expect(w.fabView().job).toBeUndefined();
    expect(w.fabView().blocked).toBe('grade');
    w.run(600);
    expect(w.alive(6)).toBe(false);
  });
});

describe('field fabricator: stalls and placement', () => {
  it('a full hold keeps the finished output inside the machine, stalled, and it comes out once there is room', () => {
    const w = world(design());
    const e = (w.server as any).econ;
    // Queue a Pip for recycling; then fill the hold to the brim with ore
    w.send({ type: 'fieldRecycle', uids: [2] });
    w.send({ type: 'machine', kind: 'fabricator', on: true });
    w.run(1);
    expect(w.fabView().job?.kind).toBe('recycle');
    const free = w.server.pilots.cargoFree(w.conn);
    w.give({ iron_ore: Math.floor(free / e.items.volume('iron_ore')) });
    expect(w.server.pilots.cargoFree(w.conn)).toBeLessThan(e.items.volume('alloy_plate'));
    const back = recycleReturn(e, pip);
    until(w, () => w.idx(2) < 0, 5000);
    w.run(2);
    expect(w.dones().at(-1)).toMatchObject({ to: 'machine' });
    expect(w.fabView()).toMatchObject({ blocked: 'cargo', drawing: false, holding: back });
    expect(w.prof.ship.field?.held).toEqual(back);
    // Room made: it comes out, and the machine is free again
    const ore = w.hold('iron_ore');
    w.server.pilots.take(w.conn, { iron_ore: ore }, 'cargo');
    w.run(40);
    for (const [id, n] of Object.entries(back)) expect(w.hold(id)).toBe(n);
    expect(w.fabView().holding).toBeUndefined();
    expect(w.fabView().blocked).not.toBe('cargo');
    expect(w.prof.ship.field?.held).toBeUndefined();
  });

  /** Two Pips on the core, a hull left of the core and a Pip on its far side (held on by the hull alone) */
  const orphanShip = () => {
    const bp = design();
    bp.parts.push(part(6, 'sq', 'hull', -1, 0), part(7, 'sq', 'cannon_pip', -2, 0, { facing: 'W' }));
    return world(bp);
  };
  /** Start building Pip 7, then lose `also` while it's made (hull 6 first: Pip 7's spot is cut off) */
  const cutOff = (w: ReturnType<typeof world>, also: number[]) => {
    const e = (w.server as any).econ;
    w.destroy(7);
    w.give(e.recipes.partInputs(pip));
    w.send({ type: 'machine', kind: 'fabricator', on: true });
    w.run(1);
    expect(w.fabView().job).toMatchObject({ kind: 'build', uid: 7, phase: 'make' });
    for (const u of also) w.destroy(u);
    expect(w.fabView().job?.uid).toBe(7);
  };

  it('orphan rule: a finished part goes back on its own spot when that is joined', () => {
    const w = orphanShip();
    cutOff(w, []);
    until(w, () => w.alive(7), 5000);
    expect(w.dones().at(-1)).toMatchObject({ to: 'ship', uid: 7 });
  });

  it('orphan rule: its spot cut off, it goes to another open spot that wants the same part', () => {
    const w = orphanShip();
    cutOff(w, [6, 2]);
    until(w, () => w.alive(2), 5000);
    expect(w.alive(7)).toBe(false);
    expect(w.dones().at(-1)).toMatchObject({ item: partItemId(pip), to: 'ship', uid: 2 });
  });

  it('orphan rule: no spot wants it, so it goes to the hold, and is fitted from there later (attach only)', () => {
    const w = orphanShip();
    const e = (w.server as any).econ;
    cutOff(w, [6]);
    until(w, () => w.dones().length > 0, 5000);
    expect(w.dones().at(-1)).toMatchObject({ item: partItemId(pip), to: 'cargo' });
    expect(w.hold(partItemId(pip))).toBe(1);
    expect(w.alive(7)).toBe(false);
    // The hull's plates arrive: the hull is made, then the Pip from the hold, attach only
    // (Plates enough for the hull and whatever repairs its loss called for)
    w.give({ alloy_plate: 10 });
    until(w, () => w.alive(6), 5000);
    expect(until(w, () => w.fabView().job?.uid === 7, 3000)).toBeGreaterThan(0);
    const v = w.fabView();
    expect(v.job).toMatchObject({ kind: 'build', uid: 7, need: 0, phase: 'attach' });
    expect(w.hold(partItemId(pip))).toBe(0);
    until(w, () => w.alive(7), 5000);
  });
});

describe('field fabricator: recycling', () => {
  it('breaks parts down leaf first, gives half their materials back, and never strands a part', () => {
    const bp = design();
    // A hull under the left of the core with a Pip on its left: the hull can only go after the Pip
    bp.parts.push(part(6, 'sq', 'hull', -1, 0), part(7, 'sq', 'cannon_pip', -2, 0, { facing: 'W' }));
    const w = world(bp);
    const e = (w.server as any).econ;
    w.send({ type: 'fieldRecycle', uids: [6, 7] });
    w.send({ type: 'machine', kind: 'fabricator', on: true });
    w.run(1);
    expect(w.fabView().job).toMatchObject({ kind: 'recycle', uid: 7 });
    until(w, () => w.idx(7) < 0, 5000);
    for (const [id, n] of Object.entries(recycleReturn(e, pip))) expect(w.hold(id)).toBe(n);
    w.run(1);
    expect(w.fabView().job).toMatchObject({ kind: 'recycle', uid: 6 });
    until(w, () => w.idx(6) < 0, 5000);
    expect(w.ships.validate(w.ship().blueprint, { mounting: false }).ok).toBe(true);
    expect(w.prof.ship.field?.recycle).toBeUndefined();
    // Every standing part is still on
    for (const p of w.ship().blueprint.parts) expect(w.alive(p.uid)).toBe(true);
    // (A hull is structure: it gives back plates)
    const hullBack = recycleReturn(e, { fn: 'hull', material: 'alloy', piece: 'sq' });
    for (const [id, n] of Object.entries(hullBack)) expect(w.hold(id)).toBeGreaterThanOrEqual(n);
  });

  it('a part holding others on is not recycled while they stand', () => {
    const bp = design();
    bp.parts.push(part(6, 'sq', 'hull', -1, 0), part(7, 'sq', 'cannon_pip', -2, 0, { facing: 'W' }));
    const w = world(bp);
    w.send({ type: 'fieldRecycle', uids: [6] });
    w.send({ type: 'machine', kind: 'fabricator', on: true });
    w.run(600);
    expect(w.idx(6)).toBeGreaterThanOrEqual(0);
    expect(w.fabView().job).toBeUndefined();
  });
});

describe('field plan', () => {
  it('a save is free: standing parts stay, removals queue for recycling, new parts are appended as missing parts (no ghosts), and the blueprint stays valid', () => {
    const w = world(design());
    const before = JSON.stringify(w.prof.cargo);
    const live = w.ship().blueprint;
    const charge = w.ships.chargeOf(w.pid).e!;
    // Drain the stores a little: a save must not fill them again
    for (let i = 0; i < charge.held.length; i++) charge.held[i] = Math.floor(charge.held[i] / 2);
    const held = Array.from(charge.held);
    // Drop Pip 2, add a hull on the right of the core and a Pip on it
    const target: Blueprint = {
      ...live,
      parts: [...live.parts.filter((p) => p.uid !== 2), part(10, 'sq', 'hull', 2, 0), part(11, 'sq', 'cannon_pip', 2, -1, { facing: 'N' })],
    };
    w.send({ type: 'fieldPlan', blueprint: target });
    w.run(1);
    const bp = w.ship().blueprint;
    expect(bp.parts.slice(0, live.parts.length).map((p) => p.uid)).toEqual(live.parts.map((p) => p.uid));
    expect(bp.parts.slice(live.parts.length).map((p) => p.uid).sort()).toEqual([10, 11]);
    // (missing, as a part shot off is: in the blueprint, not on the ship, and no placeholder flag)
    for (const u of [10, 11]) {
      expect(w.ships.isGhost(w.pid, w.idx(u))).toBe(false);
      expect(w.ship().ghost[w.idx(u)]).toBe(false);
      expect(w.alive(u)).toBe(false);
      expect(w.prof.ship.hp[u]).toBe(0);
    }
    expect(w.alive(2)).toBe(true);
    expect(w.prof.ship.field?.recycle).toEqual([2]);
    expect(w.prof.ship.ghosts ?? []).toEqual([]);
    expect(w.prof.ship.blueprint).toBe(bp);
    expect(w.ships.validate(bp, { mounting: false }).ok).toBe(true);
    expect(JSON.stringify(w.prof.cargo)).toBe(before);
    expect(w.lastState().recycle).toEqual([2]);
    // (The stores carried over by index: nothing refilled)
    const after = w.ships.chargeOf(w.pid).e!;
    for (let i = 0; i < live.parts.length; i++) expect(after.held[i]).toBeLessThanOrEqual(Math.max(held[i], w.ship().derived.ports!.cap[i]) );
    const sum = (a: ArrayLike<number>, n: number) => { let s = 0; for (let i = 0; i < n; i++) s += a[i]; return s; };
    const cap = w.ship().derived.ports!.cap;
    expect(sum(after.held, after.held.length)).toBeLessThan(sum(cap, cap.length) * 0.75);
  });

  it('a new part on the cells of a part still being recycled is refused; once that part is gone it goes in, and is built', () => {
    const w = world(design());
    const e = (w.server as any).econ;
    const live = w.ship().blueprint;
    // Swap Pip 2 for a hull in the same cell: Pip 2 still stands while it is broken down, so not yet
    const target: Blueprint = { ...live, parts: [...live.parts.filter((p) => p.uid !== 2), part(12, 'sq', 'hull', 1, -1)] };
    w.send({ type: 'fieldPlan', blueprint: target });
    w.run(1);
    expect(w.idx(12)).toBe(-1);
    expect(w.ship().blueprint).toBe(live);
    expect(w.prof.ship.field?.recycle).toBeUndefined();
    expect(JSON.stringify(w.got.slice(-20))).toMatch(/still being recycled/);
    // Recycle it first, then the same part goes in
    w.send({ type: 'fieldRecycle', uids: [2] });
    w.send({ type: 'machine', kind: 'fabricator', on: true });
    until(w, () => w.idx(2) < 0, 5000);
    w.send({ type: 'fieldPlan', blueprint: { ...w.ship().blueprint, parts: [...w.ship().blueprint.parts, part(12, 'sq', 'hull', 1, -1)] } });
    w.run(1);
    expect(w.idx(12)).toBeGreaterThanOrEqual(0);
    expect(w.alive(12)).toBe(false);
    // And it's built from the hold once the plates are there
    w.give(e.recipes.partInputs({ fn: 'hull', material: 'alloy', piece: 'sq' }));
    until(w, () => w.alive(12), 5000);
    expect(w.ships.validate(w.ship().blueprint, { mounting: false }).ok).toBe(true);
  });

  it('a planned part that joins nothing is saved but never built, until a part joins it to the ship', () => {
    const w = world(design());
    const e = (w.server as any).econ;
    const live = w.ship().blueprint;
    const hull = { fn: 'hull', material: 'alloy', piece: 'sq' };
    w.send({ type: 'machine', kind: 'fabricator', on: true });
    // A hull two cells off the ship's edge: nothing joins it
    w.send({ type: 'fieldPlan', blueprint: { ...live, parts: [...live.parts, part(15, 'sq', 'hull', 4, 0)] } });
    w.run(1);
    expect(w.idx(15)).toBeGreaterThanOrEqual(0);
    expect(w.ships.validate(w.ship().blueprint, { mounting: false }).unreachable).toEqual([15]);
    expect(w.prof.ship.hp[15]).toBe(0);
    // Even with the plates in the hold the fabricator leaves it alone, and the ship never counts it
    w.give(e.recipes.partInputs(hull));
    w.run(900);
    expect(w.alive(15)).toBe(false);
    expect(w.ship().derived.alive.filter(Boolean).length).toBe(live.parts.length);
    expect(w.ship().blueprint.parts.some((p) => p.uid === 15)).toBe(true);
    // A bridge joins it: the bridge is built first, then it
    w.send({ type: 'fieldPlan', blueprint: { ...w.ship().blueprint, parts: [...w.ship().blueprint.parts, part(16, 'sq', 'hull', 2, 0), part(17, 'sq', 'hull', 3, 0)] } });
    w.run(1);
    expect(w.ships.validate(w.ship().blueprint, { mounting: false }).unreachable).toEqual([]);
    w.give(e.recipes.partInputs(hull));
    w.give(e.recipes.partInputs(hull));
    w.give(e.recipes.partInputs(hull));
    until(w, () => w.alive(16) && w.alive(17) && w.alive(15), 20000);
    expect(w.alive(15)).toBe(true);
  });

  it("an old save's waiting parts join the blueprint as missing parts", () => {
    const w = world(design());
    const live = w.ship().blueprint;
    w.prof.ship.field = { waiting: [part(13, 'sq', 'hull', 2, 0), part(14, 'sq', 'hull', 9, 9)] };
    w.server.pilots.reapplyShip(w.conn);
    w.run(2);
    // (14 joins nothing: planned, not connected, so kept rather than dropped)
    expect(w.ship().blueprint.parts.map((p) => p.uid)).toEqual([...live.parts.map((p) => p.uid), 13, 14]);
    expect(w.alive(13)).toBe(false);
    expect(w.alive(14)).toBe(false);
    expect(w.ship().ghost[w.idx(13)]).toBe(false);
    expect(w.prof.ship.field?.waiting).toBeUndefined();
  });

  it('as it stands: every missing part (planned or shot off) leaves the design and the recycling queue empties', () => {
    const w = world(design());
    const live = w.ship().blueprint;
    w.destroy(1);
    w.send({ type: 'fieldPlan', blueprint: { ...live, parts: [...live.parts.filter((p) => p.uid !== 2), part(10, 'sq', 'hull', 2, 0)] } });
    w.run(1);
    w.send({ type: 'fieldPlanClear' });
    w.run(1);
    expect(w.ship().blueprint.parts.map((p) => p.uid)).toEqual(live.parts.filter((p) => p.uid !== 1).map((p) => p.uid));
    expect(w.prof.ship.field?.recycle).toBeUndefined();
    expect(w.ship().ghost.some(Boolean)).toBe(false);
  });

  it('refuses a plan that moves the core', () => {
    const w = world(design());
    const live = w.ship().blueprint;
    w.send({ type: 'fieldPlan', blueprint: { ...live, parts: live.parts.map((p) => (p.fn === 'core' ? { ...p, x: 5 } : p)) } });
    w.run(1);
    expect(w.ship().blueprint).toBe(live);
  });
});

describe('field fabricator: packs', () => {
  for (const mode of ['fill', 'prefer'] as const) {
    it(`in ${mode} mode a pack pays one unit, and packs make the job faster`, () => {
      const w = world(design());
      const e = (w.server as any).econ;
      const inputs = e.recipes.partInputs(pip) as Bag; // 2 alloy plate, 1 copper wire
      w.destroy(1);
      // Loose: one alloy plate and the wire; packs: Hull Packs (alloy plate among them)
      w.give({ alloy_plate: 1, copper_wire: inputs.copper_wire, pack_hull: 3 });
      const pay = fieldPay(inputs, (id) => w.hold(id), packDefs(e.items), mode);
      expect(pay.short).toEqual({});
      w.send({ type: 'machine', kind: 'fabricator', on: true, packs: mode });
      w.run(1);
      const v = w.fabView();
      expect(v.packs).toBe(mode);
      expect(v.job?.packShare).toBeCloseTo(packShare(pay));
      // One pack a unit: fill uses one (the plate the loose ones couldn't pay), prefer two (both plates)
      expect(w.hold('pack_hull')).toBe(3 - (mode === 'fill' ? 1 : 2));
      const L = w.ship().derived.ports!, rate = L.rate[portsMachinePart(L, MACHINE_FAB)];
      expect(v.job!.need).toBe(jobEu(fabWork(e, pip), 1, rate, packShare(pay)));
      expect(v.job!.need).toBeLessThan(jobEu(fabWork(e, pip), 1, rate));
      until(w, () => w.alive(1), 5000);
      expect(w.alive(1)).toBe(true);
    });
  }

  it('with nothing in the hold the bank spare pays to rebuild a lost part of its own design', () => {
    const w = world(design(), { bank: true });
    const spare0 = w.server.pilots.bankSpare(w.pid);
    expect(Object.keys(spare0).length).toBeGreaterThan(0);
    w.destroy(1);
    w.send({ type: 'machine', kind: 'fabricator', on: true });
    expect(until(w, () => w.alive(1), 8000)).toBeGreaterThan(0);
    const spare1 = w.server.pilots.bankSpare(w.pid);
    expect(Object.entries(spare0).some(([id, n]) => (spare1[id] ?? 0) < n)).toBe(true);
  });

  it('in off mode packs are never used', () => {
    const w = world(design());
    w.destroy(1);
    w.give({ alloy_plate: 1, copper_wire: 1, pack_hull: 3 });
    w.send({ type: 'machine', kind: 'fabricator', on: true });
    w.run(2);
    expect(w.fabView().job).toBeUndefined();
    expect(w.fabView().blocked).toBe('materials');
    expect(w.lastState().short).toEqual({ alloy_plate: 1 });
    expect(w.hold('pack_hull')).toBe(3);
  });
});

describe('field machines on the wire', () => {
  it('send nothing on ticks where nothing changed: no progress streams', () => {
    const w = world(design());
    const e = (w.server as any).econ;
    w.destroy(1);
    // (Whatever its loss did to its neighbours settled and mended: nothing else wants work)
    w.run(300);
    w.ships.healAll(w.pid, 1);
    w.give(e.recipes.partInputs(pip));
    w.send({ type: 'machine', kind: 'fabricator', on: true });
    w.run(1);
    const n = w.states().length;
    w.run(200);
    // (Mid-job: the client works the progress out from machEu)
    expect(w.alive(1)).toBe(false);
    expect(w.states().length).toBe(n);
    until(w, () => w.alive(1), 5000);
    w.run(3);
    const m = w.states().length;
    expect(m).toBeGreaterThan(n);
    w.run(300);
    expect(w.states().length).toBe(m);
  });

  it('a job called off gives its inputs back to the hold', () => {
    const w = world(design());
    const e = (w.server as any).econ;
    const inputs = e.recipes.partInputs(pip) as Bag;
    w.destroy(1);
    w.give(inputs);
    w.send({ type: 'machine', kind: 'fabricator', on: true });
    w.run(10);
    const job = w.fabView().job!;
    w.send({ type: 'machine', kind: 'fabricator', on: false });
    w.send({ type: 'fieldCancel', kind: 'fabricator', job: job.id });
    w.run(1);
    expect(w.fabView().job).toBeUndefined();
    for (const [id, n] of Object.entries(inputs)) expect(w.hold(id)).toBe(n);
  });

  it('isClaimed and machineContents answer for the bank (package B)', () => {
    const w = world(design());
    const e = (w.server as any).econ;
    const inputs = e.recipes.partInputs(pip) as Bag;
    w.destroy(1);
    w.give(inputs);
    w.send({ type: 'machine', kind: 'fabricator', on: true });
    w.run(1);
    expect(w.field().isClaimed(w.pid, 1)).toBe(true);
    expect(w.field().isClaimed(w.pid, 2)).toBe(false);
    expect(w.field().machineContents(w.pid)).toEqual(inputs);
    expect(w.prof.ship.field?.held).toEqual(inputs);
    expect(w.field().machineContents(w.pid, true)).toEqual(inputs);
    expect(w.field().machineContents(w.pid)).toEqual({});
    expect(w.prof.ship.field?.held).toBeUndefined();
  });
});


describe('field refiner', () => {
  it("the core's own refines a chosen recipe from the hold's ore, slowly, and refuses one past its grade", () => {
    const w = world(design());
    const e = (w.server as any).econ;
    w.give({ iron_ore: 2, nickel_ore: 1 });
    w.send({ type: 'machine', kind: 'refiner', on: true, recipe: 'alloy_plate' });
    w.run(1);
    const ref = () => w.lastState().machines.find((m) => m.kind === 'refiner')!;
    expect(ref()).toMatchObject({ tier: 0, uid: -1, drawing: true, recipe: 'alloy_plate', job: { kind: 'refine', recipe: 'alloy_plate' } });
    expect(w.hold('iron_ore')).toBeLessThan(12);
    const ticks = jobTicks(e.recipes.refining.get('alloy_plate').time, tierRule('refiner', 0).speed);
    const took = until(w, () => w.hold('alloy_plate') > 0, 5000);
    expect(Math.abs(took - ticks)).toBeLessThanOrEqual(3);
    expect(w.dones().at(-1)).toMatchObject({ kind: 'refiner', item: 'alloy_plate', to: 'cargo' });
    w.send({ type: 'machine', kind: 'refiner', recipe: 'steel_plate' });
    w.give({ iron_ore: 4, nickel_ore: 2 });
    w.run(2);
    expect(ref()).toMatchObject({ blocked: 'grade', drawing: false });
  });

  it('on auto it refines what the fabricator is short of, and the fabricator then builds', () => {
    const w = world(design());
    w.destroy(1);
    // (Losing the Pip scuffs its neighbours too: their repairs want plates as well)
    w.give({ copper_wire: 3, iron_ore: 12, nickel_ore: 6 });
    w.send({ type: 'machine', kind: 'fabricator', on: true });
    w.send({ type: 'machine', kind: 'refiner', on: true });
    w.run(2);
    expect(w.lastState().short?.alloy_plate).toBeGreaterThanOrEqual(2);
    expect(w.lastState().machines.find((m) => m.kind === 'refiner')?.job?.recipe).toBe('alloy_plate');
    expect(until(w, () => w.alive(1), 6000)).toBeGreaterThan(0);
    expect(w.hold('iron_ore')).toBeLessThan(12);
  });
});

describe('field fabricator: a planned part built in', () => {
  it('is a missing part until built, then stands: on the pilot\'s client and a watcher\'s, and the pilot\'s hangar is sent again', () => {
    const w = world(design());
    const e = (w.server as any).econ;
    // (another pilot near by, holding the ship)
    const t2 = new LocalTransport(w.server);
    const got2: ServerMessage[] = [];
    t2.onMessage = (m) => got2.push(m);
    t2.connect();
    t2.send({ type: 'join', username: 'watcher' } as any);
    const p2 = t2.getPlayerId();
    Position.x[p2] = Position.x[w.pid] + 300; Position.y[p2] = Position.y[w.pid];
    const live = w.ship().blueprint;
    w.send({ type: 'fieldPlan', blueprint: { ...live, parts: [...live.parts, part(10, 'sq', 'hull', 2, 0)] } });
    w.run(40);
    const i10 = w.idx(10);
    expect(w.ship().ghost[i10]).toBe(false);
    expect(w.alive(10)).toBe(false);
    const missing = () => {
      const h = w.got.filter((m) => m.type === 'hangar').at(-1) as Extract<ServerMessage, { type: 'hangar' }> | undefined;
      const v = h?.slots[w.prof.activeSlot];
      return v && { ghosts: v.ghosts, wrecked: v.wrecked };
    };
    // (the save is told to the hangar view too: a missing part there, as one shot off is)
    expect(missing()).toEqual({ ghosts: [], wrecked: [10] });
    w.give(e.recipes.partInputs({ fn: 'hull', material: 'alloy', piece: 'sq' }));
    w.send({ type: 'machine', kind: 'fabricator', on: true });
    expect(until(w, () => w.alive(10), 5000)).toBeGreaterThan(0);
    // (frames coalesce: time for the syncs to go)
    w.run(40);
    expect(w.ship().ghost[i10]).toBe(false);
    expect(w.prof.ship.ghosts).toEqual([]);
    // Both clients' ship stores, fed every ship sync they were sent, have the part built and standing
    for (const list of [w.got, got2]) {
      const store = new ShipStore(w.ships.catalog, w.ships.tuning);
      for (const m of list) if (m.type === 'shipSync') store.onSync(m);
      const cs = store.get(w.pid)!;
      expect(cs.rebuilds).toBe(w.ship().rebuilds);
      expect(cs.ghost[i10]).toBe(false);
      expect(cs.derived.alive[i10]).toBe(true);
    }
    // And the hangar view (the station and hangar windows read the record, not the ship): built, not missing
    expect(missing()).toEqual({ ghosts: [], wrecked: [] });
  });
});
