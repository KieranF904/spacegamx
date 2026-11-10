/**
 * Mine blasts found on the clients (docs/design/groups-mines-docking.md 2.4, stage M2): the server's trigger pass and
 * a client's search of its windows (common blasts.ts findMineBlasts, through the client's own MineStore) agree, so the
 * server tells only what the client can't find; a blast the client would find that never happened is taken back
 * (minesKept); and nothing is drawn twice. The client here is the real client store fed the messages its pilot gets,
 * its tick layer the server's own poses (an exact replica: what the tick-faithful layer is).
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import {
  Position, Velocity, Rotation, InSystem, MINES, loadCatalog, mineId, mineRest,
  type Blueprint, type PlacedPart, type Rot, type ServerMessage, type SearchShips,
} from '@space-game/common';
import { GameData } from '../../../data/GameData.js';
import { LocalTransport } from '../../../net/LocalTransport.js';
import { readGameDataFiles } from '../../../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../../../ships/loadShipConfig.js';
import { createShipBridge } from '../../../ships/createShipBridge.js';
import { MineStore } from '../../../../../client/src/ships/features/minebay/mines';
import type { Minefield } from './Minefield.js';
import { makeServer } from '../../../testkits/world.testkit.js';

const dataDir = join(__dirname, '../../../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);
const config = loadShipConfigCached(dataDir);
const catalog = loadCatalog(config.catalog);

const BAY = 7;
const part = (uid: number, piece: string, fn: string, x: number, y: number, extra: Partial<PlacedPart> = {}): PlacedPart =>
  ({ uid, piece, fn, material: catalog.functions.get(fn)?.material ?? 'alloy', x, y, rot: 0 as Rot, flip: false, ...extra });
const design = (): Blueprint => ({
  name: 'Mine test', catalogVersion: catalog.version,
  parts: [part(0, 'rect2', 'core', 0, 0), part(1, 'sq', 'cannon_pip', 0, -1, { facing: 'N' }), part(BAY, 'rect2', 'mine_bay', 0, 1, { facing: 'S' })],
});

type Msg = ServerMessage;
const of = <T extends Msg['type']>(got: Msg[], type: T) => got.filter((m) => m.type === type) as Extract<Msg, { type: T }>[];

function world() {
  resetGlobals();
  const server = makeServer({
    gameData: new GameData(files),
    ships: createShipBridge(config),
    clock: () => 1_000_000,
  });
  const ships = server.getShips()!;
  // Every ship's pose at the end of each tick: the tick-faithful layer an exact replica gives a client
  const poses = new Map<number, Map<number, { x: number; y: number }>>();
  const clients: Client[] = [];
  const run = (n: number) => {
    for (let k = 0; k < n; k++) {
      // (as the next tick's pass finds them: where they were at the end of the last tick, the tests' pins included)
      const m = new Map<number, { x: number; y: number }>();
      for (const [eid] of ships.bodies) m.set(eid, { x: Position.x[eid], y: Position.y[eid] });
      poses.set(server.currentTick, m);
      server.step();
      for (const c of clients) c.pump();
    }
  };
  (server as any).limiter.allow = () => true;
  const field = () => (server as any).features.get('minebay') as Minefield;
  const sideOf = (eid: number) => (server as any).sideOf(eid) as number;

  /** A pilot and its client's mine store, fed what the pilot is sent, searching each snapshot's window on the exact layer */
  interface Client { pid: number; got: Msg[]; store: MineStore; windows: number; pump(): void; load(n: number): void; place(x: number, y: number): void; send(m: object): void }
  const pilot = (name: string, x: number, y: number): Client => {
    const t = new LocalTransport(server);
    const got: Msg[] = [];
    t.onMessage = (m) => got.push(m);
    t.connect();
    t.send({ type: 'join', username: name } as any);
    const pid = t.getPlayerId();
    const conn = server.pilots.connOf(pid)!;
    const prof = server.pilots.get(conn)!;
    Position.x[pid] = x; Position.y[pid] = y; Velocity.x[pid] = 0; Velocity.y[pid] = 0; Rotation.angle[pid] = -Math.PI / 2;
    prof.ship.blueprint = design();
    prof.ship.hp = {};
    prof.ship.ghosts = [];
    delete prof.ship.field;
    server.pilots.reapplyShip(conn);
    const store = new MineStore();
    let read = 0, last = -1;
    const c: Client = {
      pid, got, store, windows: 0,
      pump() {
        for (; read < got.length; read++) {
          const m = got[read];
          if (m.type === 'minesLaid') store.laid(m, pid);
          else if (m.type === 'minesGone') store.gone(m, 0);
          else if (m.type === 'minesKept') store.kept(m);
          else if (m.type === 'snapshot') {
            // (its window searched once it's in, as SelfHits.detect does: the ships it holds, at their exact poses)
            const finds = !!(conn as any).started && last >= 0;
            const held = [...conn.shipView].filter((id) => ships.get(id)?.kind === 'ship');
            const exact: SearchShips = {
              ids: held, side: sideOf,
              radius: (id) => ships.get(id)?.derived.radius,
              at: (id, tick) => poses.get(tick)?.get(id) ?? null,
            };
            store.window(last, m.tick, finds ? exact : null, 0);
            if (finds) c.windows++;
            last = m.tick;
          }
        }
      },
      load(n) { (prof.ship.field ??= {}).mines = { [BAY]: n }; },
      place(px, py) { Position.x[pid] = px; Position.y[pid] = py; Velocity.x[pid] = 0; Velocity.y[pid] = 0; },
      send(m) { t.send(m as any); },
    };
    clients.push(c);
    return c;
  };
  return { server, ships, run, pilot, field, poses };
}

function pin(eid: number, x: number, y: number) { Position.x[eid] = x; Position.y[eid] = y; Velocity.x[eid] = 0; Velocity.y[eid] = 0; }

/** A pilot's armed field of 4, and a pilotless ship it may hurt parked off it */
function armed() {
  const w = world();
  const a = w.pilot('layer', 40000, 40000);
  a.load(12);
  w.run(2);
  a.send({ type: 'mineDrop' });
  w.run(1);
  const d = of(a.got, 'minesLaid')[0];
  w.run(MINES.armTicks + 2);
  a.place(40000, 38000);
  const rest = mineRest(d, 0);
  const sys = InSystem.systemId[a.pid];
  const dummy = w.ships.spawnDummy(w.ships.enemyDesigns.frost_shard, rest[0] + 900, rest[1], 0, sys);
  w.run(8);
  // (Where the hull touches mine 0 and no other: on the far side of it from the rest of the batch)
  const r = w.ships.get(dummy)!.derived.radius, next = mineRest(d, 1);
  const ux = rest[0] - next[0], uy = rest[1] - next[1], u = Math.hypot(ux, uy);
  const touch: [number, number] = [rest[0] + (ux / u) * (r + MINES.triggerReach - 2), rest[1] + (uy / u) * (r + MINES.triggerReach - 2)];
  /** It drifts in to mine 0 from outside (flown there, not placed: a ship placed by hand is keyframed, and its blasts told) */
  const driftIn = () => {
    pin(dummy, rest[0] + (ux / u) * (r + MINES.triggerReach + 30), rest[1] + (uy / u) * (r + MINES.triggerReach + 30));
    Velocity.x[dummy] = (-ux / u) * 1.5; Velocity.y[dummy] = (-uy / u) * 1.5;
    w.run(4);
    for (let k = 0; k < 80; k++) {
      w.run(1);
      if (!w.field().liveMines(a.pid).some((m) => m.id === mineId(a.pid, d.tick, 0))) return w.server.currentTick;
    }
    return -1;
  };
  return { w, a, d, rest, dummy, touch, driftIn };
}

/** No damage from the blasts (a ship broken up mid-window is synced, and its blasts told: not what these tests are about) */
const harmless = (w: ReturnType<typeof world>) => { (w.ships as any).splashAt = () => {}; };

const endOf = (s: MineStore, owner: number, tick: number, i: number) => s.drops.find((k) => k.d.owner === owner && k.d.tick === tick)?.ends[i];

describe('mine blasts: worked out on the clients (stage M2)', () => {
  it('a blast by a ship the client has exactly is found there on the server\'s tick, and not told', () => {
    const { w, a, d, rest, dummy, driftIn } = armed();
    harmless(w);
    expect(a.windows).toBeGreaterThan(0);
    const before = of(a.got, 'minesGone').length;
    // Into reach of mine 0 (and no other): it goes off on the server
    const tick = driftIn();
    expect(tick).toBeGreaterThan(0);
    // (Held where it is till the window with the blast closes: a pin inside it keyframes the ship, and a keyframed
    // pose isn't exact on the client's layer, so the blast would be told. Where the window falls shifts with the world)
    const lastSnap = () => of(a.got, 'snapshot').reduce((t, s) => Math.max(t, s.tick), -1);
    for (let k = 0; k < 12 && lastSnap() < tick; k++) w.run(1);
    pin(dummy, rest[0] + 900, rest[1]);
    w.run(4);
    // The client found it itself, on that tick: nothing told
    expect(of(a.got, 'minesGone').length).toBe(before);
    expect(endOf(a.store, a.pid, d.tick, 0)).toEqual({ tick, how: 'blast', src: 'found' });
    expect(a.store.blasts).toHaveLength(1);
    expect(a.store.blasts[0]).toMatchObject({ x: rest[0], y: rest[1], tick });
    // (and no other mine went, on either end)
    expect(w.field().liveMines(a.pid)).toHaveLength(3);
    for (const i of [1, 2, 3]) expect(endOf(a.store, a.pid, d.tick, i)).toBeUndefined();
  }, 60_000);

  it('agrees over many passes: every server blast ends the client\'s mine on the same tick, found or told, once', () => {
    const { w, a, d, dummy } = armed();
    harmless(w);
    const r = w.ships.get(dummy)!.derived.radius;
    // A sweep across the field, a little each tick: each mine goes off when the hull first comes in reach
    const spots = [0, 1, 2, 3].map((i) => mineRest(d, i));
    const ys = spots.map((p) => p[1]);
    const x0 = Math.min(...spots.map((p) => p[0])) - r - 200, x1 = Math.max(...spots.map((p) => p[0])) + r + 200;
    const y = (Math.min(...ys) + Math.max(...ys)) / 2;
    const ticks = new Map<number, number>();
    for (let x = x0; x <= x1; x += 7) {
      pin(dummy, x, y);
      const liveBefore = new Set(w.field().liveMines(a.pid).map((m) => m.id));
      w.run(1);
      const liveAfter = new Set(w.field().liveMines(a.pid).map((m) => m.id));
      for (const id of liveBefore) if (!liveAfter.has(id)) ticks.set(id, w.server.currentTick);
    }
    w.run(6);
    expect(ticks.size).toBeGreaterThan(0);
    for (let i = 0; i < 4; i++) {
      const id = mineId(a.pid, d.tick, i), t = ticks.get(id);
      const e = endOf(a.store, a.pid, d.tick, i);
      if (t === undefined) expect(e).toBeUndefined();
      else expect(e).toMatchObject({ tick: t, how: 'blast' });
    }
    // One blast drawn each
    expect(a.store.blasts).toHaveLength(ticks.size);
  }, 60_000);

  it('a blast the client cannot find (a pilot set it off) is told before the snapshot that closes its window', () => {
    const w = world();
    const a = w.pilot('layer', 40000, 40000);
    const b = w.pilot('rival', 40000, 39000);
    // (As in a PvP zone: the pilots may hurt each other)
    (w.server as any).canDamage = () => true;
    a.load(12);
    w.run(2);
    a.send({ type: 'mineDrop' });
    w.run(1);
    const d = of(a.got, 'minesLaid')[0];
    const rest = mineRest(d, 0);
    w.run(MINES.armTicks + 4);
    b.place(rest[0], rest[1]);
    w.run(1);
    const tick = w.server.currentTick;
    w.run(4);
    // Told to both (the owner's client and the rival's), the told end on the server's tick
    for (const c of [a, b]) {
      const g = of(c.got, 'minesGone').filter((m) => m.how === 'blast');
      expect(g.length).toBeGreaterThan(0);
      expect(g[0]).toMatchObject({ tick, by: b.pid });
      expect(endOf(c.store, a.pid, d.tick, 0)).toMatchObject({ tick, how: 'blast', src: 'told' });
    }
    // The owner's came just before the snapshot that closed the window it went off in
    const at = a.got.indexOf(of(a.got, 'minesGone').find((m) => m.how === 'blast')!);
    const snap = a.got.findIndex((m, k) => k > at && m.type === 'snapshot');
    expect(snap).toBeGreaterThan(at);
    expect((a.got[snap] as { tick: number }).tick).toBeGreaterThanOrEqual(tick);
    expect((a.got.slice(0, at).filter((m) => m.type === 'snapshot').at(-1) as { tick: number }).tick).toBeLessThan(tick);
    // The rival's ship was broken up by it: it gets no snapshot of that window, and is told at once (the mines that got it)
    expect(of(b.got, 'death').length).toBeGreaterThan(0);
    expect(of(b.got, 'minesGone').filter((m) => m.how === 'blast').every((m) => m.tick === tick)).toBe(true);
  }, 60_000);

  it('a blast the client would find but the server never had is taken back (minesKept), and that mine is told from then on', () => {
    const { w, a, d, dummy, touch } = armed();
    harmless(w);
    // (Only the server knows the owner may not hurt it now: as a berthed owner, a dormant ship)
    const canDamage = (w.server as any).canDamage;
    (w.server as any).canDamage = () => false;
    pin(dummy, touch[0], touch[1]);
    w.run(1);
    const tick = w.server.currentTick;
    w.run(4);
    expect(w.field().liveMines(a.pid).some((m) => m.id === mineId(a.pid, d.tick, 0))).toBe(true);
    const kept = of(a.got, 'minesKept');
    expect(kept.length).toBeGreaterThan(0);
    expect(kept[0]).toMatchObject({ tick, ids: [mineId(a.pid, d.tick, 0)] });
    // Live on the client too: no end, no blast
    w.run(3);
    expect(endOf(a.store, a.pid, d.tick, 0)).toBeUndefined();
    expect(a.store.blasts).toHaveLength(0);
    // (told once, however long it sits there)
    expect(of(a.got, 'minesKept').filter((m) => m.ids.includes(mineId(a.pid, d.tick, 0)))).toHaveLength(1);
    // Now it may be hurt: the blast is told (the client no longer searches that mine), and drawn once
    (w.server as any).canDamage = canDamage;
    w.run(1);
    const t2 = w.server.currentTick;
    w.run(4);
    const told = of(a.got, 'minesGone').filter((m) => m.how === 'blast' && m.ids.includes(mineId(a.pid, d.tick, 0)));
    expect(told).toHaveLength(1);
    expect(told[0].tick).toBe(t2);
    expect(endOf(a.store, a.pid, d.tick, 0)).toMatchObject({ tick: t2, how: 'blast', src: 'told' });
    expect(a.store.blasts).toHaveLength(1);
  }, 60_000);

  it('touches are let go once every pilot told has settled them', () => {
    const { w, rest, dummy, touch } = armed();
    harmless(w);
    pin(dummy, touch[0], touch[1]);
    w.run(1);
    expect(w.field().pendingTouches).toBeGreaterThan(0);
    pin(dummy, rest[0] + 900, rest[1]);
    w.run(6);
    expect(w.field().pendingTouches).toBe(0);
  }, 60_000);
});

