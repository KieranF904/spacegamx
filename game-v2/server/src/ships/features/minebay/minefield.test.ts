/**
 * The Mine Bay in the full server (docs/design/groups-mines-docking.md section 2): magazines and the cooldown,
 * drops told to holders and resent to a late joiner, owner and party never set a mine off, an armed mine in reach goes
 * off once through the damage funnel (shields first), the cap fizzles the oldest, a field is cleared when its owner
 * goes, and the field fabricator's rearm job comes after repairs and fills the magazine at the placeholder cost.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import {
  Position, Velocity, Rotation, InSystem, MINES, REARM, jobTicks, loadCatalog, mineArmed, mineId, minePos, rearmBill, rearmWork, tierRule,
  type Blueprint, type MineDrop, type PlacedPart, type Rot, type ServerMessage,
} from '@space-game/common';
import { GameServer } from '../../../GameServer.js';
import { GameData } from '../../../data/GameData.js';
import { LocalTransport } from '../../../net/LocalTransport.js';
import { readGameDataFiles } from '../../../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../../../ships/loadShipConfig.js';
import { createShipBridge } from '../../../ships/createShipBridge.js';
import { TELL_REACH, type Minefield } from './Minefield.js';

const dataDir = join(__dirname, '../../../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);
const config = loadShipConfigCached(dataDir);
const catalog = loadCatalog(config.catalog);

const BAY = 7;
const part = (uid: number, piece: string, fn: string, x: number, y: number, extra: Partial<PlacedPart> = {}): PlacedPart =>
  ({ uid, piece, fn, material: catalog.functions.get(fn)?.material ?? 'alloy', x, y, rot: 0 as Rot, flip: false, ...extra });

/** A 2x1 core with a Mine Bay under it, its open edge facing back (S) */
const design = (): Blueprint => ({
  name: 'Mine test', catalogVersion: catalog.version,
  parts: [part(0, 'rect2', 'core', 0, 0), part(1, 'sq', 'cannon_pip', 0, -1, { facing: 'N' }), part(BAY, 'rect2', 'mine_bay', 0, 1, { facing: 'S' })],
});
/** A target with a shield: a pilotless ship (anyone may hurt it), a small shielded hostile's design */
const target = (w: { ships: { enemyDesigns: Record<string, Blueprint> } }): Blueprint => w.ships.enemyDesigns.frost_shard;

type Msg = ServerMessage;
const of = <T extends Msg['type']>(got: Msg[], type: T) => got.filter((m) => m.type === type) as Extract<Msg, { type: T }>[];

function world() {
  resetGlobals();
  const server = new GameServer({
    gameData: new GameData(files),
    userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as any,
    scene: 'sectors',
    autoStart: false,
    ships: createShipBridge(config),
    clock: () => 1_000_000,
  });
  const ships = server.getShips()!;
  const run = (n: number) => { for (let k = 0; k < n; k++) server.step(); };
  /** A pilot joined, at (x, y) heading north, flying `bp` */
  const pilot = (name: string, x: number, y: number, bp: Blueprint = design()) => {
    const t = new LocalTransport(server);
    const got: Msg[] = [];
    t.onMessage = (m) => got.push(m);
    t.connect();
    t.send({ type: 'join', username: name } as any);
    const pid = t.getPlayerId();
    const conn = server.pilots.connOf(pid)!;
    const prof = server.pilots.get(conn)!;
    Position.x[pid] = x; Position.y[pid] = y; Velocity.x[pid] = 0; Velocity.y[pid] = 0; Rotation.angle[pid] = -Math.PI / 2;
    prof.cargo = [];
    prof.ship.blueprint = JSON.parse(JSON.stringify(bp));
    prof.ship.hp = {};
    prof.ship.ghosts = [];
    delete prof.ship.field;
    server.pilots.bank.dev(prof, 'empty', undefined, 1_000_000);
    server.pilots.reapplyShip(conn);
    const load = (n: number) => { (prof.ship.field ??= {}).mines = { [BAY]: n }; };
    const send = (msg: Record<string, unknown>) => t.send(msg as any);
    const place = (px: number, py: number) => { Position.x[pid] = px; Position.y[pid] = py; Velocity.x[pid] = 0; Velocity.y[pid] = 0; };
    return { t, got, pid, conn, prof, load, send, place };
  };
  const field = () => (server as any).features.get('minebay') as Minefield;
  // (Message limits go by the wall clock; these tests press far faster than a player could)
  (server as any).limiter.allow = () => true;
  return { server, ships, run, pilot, field };
}

/** Hold a ship still at a point (tests place ships by hand) */
function pin(eid: number, x: number, y: number) { Position.x[eid] = x; Position.y[eid] = y; Velocity.x[eid] = 0; Velocity.y[eid] = 0; }

describe('mine bay: magazines and drops', () => {
  it('a new bay starts empty; a press drops a batch from the magazine, then waits out the cooldown', () => {
    const w = world();
    const a = w.pilot('layer', 40000, 40000);
    w.run(2);
    // (Empty: the press is refused and the client told so)
    a.send({ type: 'mineDrop' });
    w.run(1);
    expect(of(a.got, 'minesLaid')).toHaveLength(0);
    expect(of(a.got, 'mineBay').at(-1)).toMatchObject({ refused: true, loaded: { [BAY]: 0 } });
    a.load(12);
    w.run(1);
    expect(of(a.got, 'mineBay').at(-1)!.loaded).toEqual({ [BAY]: 12 });
    a.send({ type: 'mineDrop' });
    w.run(1);
    const laid = of(a.got, 'minesLaid');
    expect(laid).toHaveLength(1);
    const d = laid[0];
    expect(d).toMatchObject({ owner: a.pid, bay: BAY, n: MINES.capPerPilot >= 4 ? 4 : 0 });
    const bay = of(a.got, 'mineBay').at(-1)!;
    expect(bay.loaded).toEqual({ [BAY]: 8 });
    expect(bay.readyAt).toBe(d.tick + 120);
    expect(a.prof.ship.field?.mines).toEqual({ [BAY]: 8 });
    // (Cooling down: refused)
    a.send({ type: 'mineDrop' });
    w.run(1);
    expect(of(a.got, 'minesLaid')).toHaveLength(1);
    expect(of(a.got, 'mineBay').at(-1)!.refused).toBe(true);
    w.run(120);
    a.send({ type: 'mineDrop' });
    w.run(1);
    expect(of(a.got, 'minesLaid')).toHaveLength(2);
    // Fewer left than the batch: drops what is there
    a.load(2);
    w.run(121);
    a.send({ type: 'mineDrop' });
    w.run(1);
    expect(of(a.got, 'minesLaid').at(-1)!.n).toBe(2);
    expect(a.prof.ship.field?.mines).toBeUndefined();
  }, 60_000);

  it('a press stamped with a tick still ahead drops on that tick', () => {
    const w = world();
    const a = w.pilot('layer', 40000, 40000);
    a.load(12);
    w.run(2);
    const at = w.server.currentTick + 10;
    a.send({ type: 'mineDrop', tick: at });
    w.run(5);
    expect(of(a.got, 'minesLaid')).toHaveLength(0);
    w.run(6);
    expect(of(a.got, 'minesLaid')[0].tick).toBe(at);
  }, 60_000);

  it('the drop record gives the server the same mines every client derives', () => {
    const w = world();
    const a = w.pilot('layer', 40000, 40000);
    a.load(12);
    w.run(2);
    a.send({ type: 'mineDrop' });
    w.run(1);
    // (What a client has: the JSON record)
    const d = JSON.parse(JSON.stringify(of(a.got, 'minesLaid')[0])) as MineDrop & { type?: string };
    for (const t of [1, 20, 45, 70]) {
      w.run(t === 1 ? 0 : t - (w.server.currentTick - d.tick));
      const now = w.server.currentTick;
      const live = w.field().liveMines(a.pid);
      expect(live.map((m) => m.id)).toEqual([0, 1, 2, 3].map((i) => mineId(a.pid, d.tick, i)));
      live.forEach((m, i) => {
        expect([m.x, m.y]).toEqual(minePos(d, i, now));
        expect(m.armed).toBe(mineArmed(d, now));
      });
    }
    // Out of the bay's open edge: behind a ship heading north (+y)
    expect(minePos(d, 0, d.tick + 100)[1]).toBeGreaterThan(Position.y[a.pid]);
  }, 60_000);
});

describe('mine bay: who sets a mine off', () => {
  function armedField() {
    const w = world();
    const a = w.pilot('layer', 40000, 40000);
    a.load(12);
    w.run(2);
    a.send({ type: 'mineDrop' });
    w.run(1);
    const d = of(a.got, 'minesLaid')[0];
    const rest = minePos(d, 0, d.tick + MINES.slideTicks);
    return { w, a, d, rest };
  }

  it('never for the owner; an armed mine goes off once for a ship in reach, through the damage funnel (shields first)', () => {
    const { w, a, d, rest } = armedField();
    // The owner sits right over its own mine: nothing
    w.run(MINES.armTicks + 5);
    a.place(rest[0], rest[1]);
    w.run(5);
    expect(of(a.got, 'minesGone')).toHaveLength(0);
    a.place(40000, 40000);
    // A ship it may hurt comes into reach of the armed mine
    const sys = InSystem.systemId[a.pid];
    const dummy = w.ships.spawnDummy(target(w), rest[0], rest[1] + 300, 0, sys);
    w.run(3);
    const ship = w.ships.get(dummy)!;
    expect(ship.derived.shieldMax).toBeGreaterThan(0);
    ship.shield = ship.derived.shieldMax;
    const shield0 = ship.shield, hp0 = ship.hp.reduce((s, v) => s + v, 0);
    expect(of(a.got, 'minesGone')).toHaveLength(0);
    pin(dummy, rest[0], rest[1] + ship.derived.radius + MINES.triggerReach - 2);
    w.run(1);
    const tick = w.server.currentTick;
    expect(w.field().liveMines(a.pid).some((m) => m.id === mineId(a.pid, d.tick, 0))).toBe(false);
    // (The shield took it first)
    expect(ship.shield).toBeLessThan(shield0);
    expect(ship.hp.reduce((s, v) => s + v, 0)).toBeLessThanOrEqual(hp0);
    // Told with the snapshot that closes its window (a ship placed by hand is keyframed: no client finds it on its
    // tick layer, blasts.test.ts), and once: mine 0 is gone for good
    w.run(5);
    const gone = of(a.got, 'minesGone').filter((g) => g.ids.includes(mineId(a.pid, d.tick, 0)));
    expect(gone).toHaveLength(1);
    expect(gone[0]).toMatchObject({ how: 'blast', by: dummy, tick });
    w.run(5);
    expect(of(a.got, 'minesGone').filter((g) => g.ids.includes(mineId(a.pid, d.tick, 0)))).toHaveLength(1);
    expect(w.field().liveMines(a.pid).some((m) => m.id === mineId(a.pid, d.tick, 0))).toBe(false);
  }, 60_000);

  it('a mine not yet armed does not go off', () => {
    const { w, a, rest } = armedField();
    const dummy = w.ships.spawnDummy(target(w), rest[0], rest[1], 0, InSystem.systemId[a.pid]);
    for (let k = 0; k < MINES.armTicks - 3; k++) { pin(dummy, rest[0], rest[1]); w.run(1); }
    expect(of(a.got, 'minesGone')).toHaveLength(0);
    for (let k = 0; k < 6; k++) { pin(dummy, rest[0], rest[1]); w.run(1); }
    expect(of(a.got, 'minesGone').length).toBeGreaterThan(0);
  }, 60_000);

  it("never for the owner's party, even where they may hurt each other", () => {
    const w = world();
    const a = w.pilot('layer', 40000, 40000);
    const b = w.pilot('mate', 40000, 39000);
    // (As in a PvP zone: the pilots may hurt each other)
    (w.server as any).canDamage = () => true;
    w.server.party.invite(a.conn, { id: b.pid });
    w.server.party.respond(b.conn, true);
    expect(w.server.party.same(a.conn, b.conn)).toBe(true);
    a.load(12);
    w.run(2);
    a.send({ type: 'mineDrop' });
    w.run(1);
    const d = of(a.got, 'minesLaid')[0];
    const rest = minePos(d, 0, d.tick + MINES.slideTicks);
    w.run(MINES.armTicks + 2);
    for (let k = 0; k < 5; k++) { b.place(rest[0], rest[1]); w.run(1); }
    expect(of(a.got, 'minesGone')).toHaveLength(0);
    // Out of the party: now it goes off
    w.server.party.leave(b.conn);
    for (let k = 0; k < 3; k++) { b.place(rest[0], rest[1]); w.run(1); }
    expect(of(a.got, 'minesGone').some((g) => g.how === 'blast' && g.by === b.pid)).toBe(true);
  }, 60_000);
});

describe('mine bay: the PvP and party rules (the guns own: GameServer.canDamage)', () => {
  /** A lays a field; B parked near the mine, an enemy ship brought in beside it. Returns what B and the enemy lost */
  function scene(setup: (w: ReturnType<typeof world>, a: ReturnType<ReturnType<typeof world>['pilot']>, b: ReturnType<ReturnType<typeof world>['pilot']>) => void = () => {}) {
    const w = world();
    const a = w.pilot('layer', 40000, 40000);
    const b = w.pilot('other', 40000, 38000);
    setup(w, a, b);
    a.load(12);
    w.run(2);
    a.send({ type: 'mineDrop' });
    w.run(1);
    const d = of(a.got, 'minesLaid')[0];
    const rest = minePos(d, 0, d.tick + MINES.slideTicks);
    w.run(MINES.armTicks + 2);
    return { w, a, b, d, rest, id0: mineId(a.pid, d.tick, 0) };
  }
  const hpOf = (w: ReturnType<typeof world>, eid: number) => { const sh = w.ships.get(eid); if (!sh) return 0; return sh.hp.reduce((t, v) => t + v, 0) + sh.shield; };
  const live = (w: ReturnType<typeof world>, a: { pid: number }, id: number) => w.field().liveMines(a.pid).some((m) => m.id === id);

  it('outside PvP another pilot never sets a mine off: it stays live, and nothing is hurt', () => {
    const { w, a, b, rest, id0 } = scene();
    expect((w.server as any).canDamage(a.pid, b.pid)).toBe(false);
    const hp0 = hpOf(w, b.pid);
    for (let k = 0; k < 10; k++) { b.place(rest[0], rest[1]); w.run(1); }
    expect(live(w, a, id0)).toBe(true);
    expect(of(a.got, 'minesGone')).toHaveLength(0);
    expect(of(b.got, 'minesGone')).toHaveLength(0);
    expect(hpOf(w, b.pid)).toBe(hp0);
  }, 60_000);

  it('outside PvP a blast an enemy sets off never hurts a pilot standing in it', () => {
    const { w, a, b, rest, id0 } = scene();
    const dummy = w.ships.spawnDummy(target(w), rest[0], rest[1] + 300, 0, InSystem.systemId[a.pid]);
    w.run(1);
    const ship = w.ships.get(dummy)!;
    const hp0 = hpOf(w, b.pid), dummy0 = hpOf(w, dummy);
    for (let k = 0; k < 4; k++) { b.place(rest[0], rest[1]); pin(dummy, rest[0], rest[1] + ship.derived.radius + MINES.triggerReach - 2); w.run(1); }
    // (it went off, on the enemy, and B was in the blast)
    expect(live(w, a, id0)).toBe(false);
    expect(hpOf(w, dummy)).toBeLessThan(dummy0);
    expect(hpOf(w, b.pid)).toBe(hp0);
  }, 60_000);

  it('in a PvP zone the other pilot sets it off and is hurt by the funnel; a party mate is neither triggered nor spared by anything the guns would not', () => {
    const { w, a, b, rest, id0 } = scene((w) => { (w.server as any).inPvpZone = () => true; });
    expect((w.server as any).canDamage(a.pid, b.pid)).toBe(true);
    const hp0 = hpOf(w, b.pid);
    for (let k = 0; k < 3; k++) { b.place(rest[0], rest[1]); w.run(1); }
    expect(live(w, a, id0)).toBe(false);
    expect(of(a.got, 'minesGone').some((g) => g.how === 'blast' && g.by === b.pid)).toBe(true);
    expect(hpOf(w, b.pid)).toBeLessThan(hp0);
  }, 60_000);

  it('in a PvP zone a party mate does not set it off, and a blast an enemy sets off hurts them exactly as a gun splash would (canDamage)', () => {
    const { w, a, b, rest, id0 } = scene((w, a, b) => {
      (w.server as any).inPvpZone = () => true;
      w.server.party.invite(a.conn, { id: b.pid });
      w.server.party.respond(b.conn, true);
      expect(w.server.party.same(a.conn, b.conn)).toBe(true);
    });
    const hp0 = hpOf(w, b.pid);
    for (let k = 0; k < 5; k++) { b.place(rest[0], rest[1]); w.run(1); }
    expect(live(w, a, id0)).toBe(true);
    expect(hpOf(w, b.pid)).toBe(hp0);
    // (an enemy sets it off with B in it: B takes what any splash of the owner takes where canDamage says yes)
    const dummy = w.ships.spawnDummy(target(w), rest[0], rest[1] + 300, 0, InSystem.systemId[a.pid]);
    w.run(1);
    const ship = w.ships.get(dummy)!;
    const may = (w.server as any).canDamage(a.pid, b.pid) as boolean;
    for (let k = 0; k < 3; k++) { b.place(rest[0], rest[1]); pin(dummy, rest[0], rest[1] + ship.derived.radius + MINES.triggerReach - 2); w.run(1); }
    expect(live(w, a, id0)).toBe(false);
    expect(hpOf(w, b.pid) < hp0).toBe(may);
  }, 60_000);
});

describe('mine bay: the field', () => {
  it('the cap fizzles the oldest mines first', () => {
    const w = world();
    const a = w.pilot('layer', 40000, 40000);
    const drops = Math.ceil(MINES.capPerPilot / 4) + 1;
    for (let k = 0; k < drops; k++) {
      a.load(12);
      w.run(121);
      a.send({ type: 'mineDrop' });
      w.run(1);
    }
    const laid = of(a.got, 'minesLaid');
    expect(laid).toHaveLength(drops);
    const live = w.field().liveMines(a.pid);
    expect(live).toHaveLength(MINES.capPerPilot);
    const fizzled = of(a.got, 'minesGone').filter((g) => g.how === 'fizzle').flatMap((g) => g.ids);
    expect(fizzled).toEqual([0, 1, 2, 3].map((i) => mineId(a.pid, laid[0].tick, i)));
  }, 60_000);

  it('is told to pilots that hold it, and resent to one that comes to (a late joiner, one that flies near)', () => {
    const w = world();
    const a = w.pilot('layer', 40000, 40000);
    a.load(12);
    w.run(2);
    a.send({ type: 'mineDrop' });
    w.run(1);
    const d = of(a.got, 'minesLaid')[0];
    // A pilot joining far off, its client holding nothing of the owner: not told
    const b = w.pilot('late', 40000 + TELL_REACH * 3, 40000);
    w.run(40);
    expect(InSystem.systemId[b.pid]).toBe(InSystem.systemId[a.pid]);
    expect(of(b.got, 'minesLaid')).toHaveLength(0);
    // It comes near: told within a pass
    b.place(40000 + 500, 40000);
    w.run(20);
    const told = of(b.got, 'minesLaid');
    expect(told).toHaveLength(1);
    const { type: _t, ...rec } = told[0];
    const { type: _u, ...orig } = d;
    expect(rec).toEqual(orig);
    // ...and once only
    w.run(40);
    expect(of(b.got, 'minesLaid')).toHaveLength(1);
    // A third joining near: told without any press
    const c = w.pilot('near', 40300, 40000);
    w.run(20);
    expect(of(c.got, 'minesLaid')).toHaveLength(1);
    // The owner leaves: everyone told is told it's cleared
    a.t.disconnect();
    w.run(3);
    expect(of(b.got, 'minesGone').at(-1)).toMatchObject({ how: 'clear' });
    expect(of(c.got, 'minesGone').at(-1)).toMatchObject({ how: 'clear' });
  }, 60_000);

  it('a life ends where every end works it out: nothing sent', () => {
    const w = world();
    const a = w.pilot('layer', 40000, 40000);
    a.load(12);
    w.run(2);
    a.send({ type: 'mineDrop' });
    w.run(1);
    w.run(MINES.lifeTicks + 2);
    expect(w.field().liveMines(a.pid)).toHaveLength(0);
    expect(of(a.got, 'minesGone')).toHaveLength(0);
  }, 120_000);
});

describe('mine bay: rearming in the field', () => {
  it('rearms after repairs, at the placeholder cost, into the magazine', () => {
    const w = world();
    const a = w.pilot('layer', 40000, 40000);
    w.run(2);
    const e = (w.server as any).econ;
    // A damaged Pip and an empty magazine: the repair comes first
    const ship = w.ships.get(a.pid)!;
    const i = ship.blueprint.parts.findIndex((p) => p.uid === 1);
    w.ships.damagePartBy(a.pid, i, ship.hp[i] * 0.3, -1);
    w.server.pilots.give(a.conn, { ...rearmBill(REARM.perJob * 3) }, { quiet: true });
    w.server.pilots.give(a.conn, { alloy_plate: 10, steel_plate: 10, copper_wire: 10, circuit_board: 10 }, { quiet: true });
    a.send({ type: 'machine', kind: 'fabricator', on: true });
    w.run(2);
    const fab = () => of(a.got, 'fieldState').at(-1)!.machines.find((m) => m.kind === 'fabricator')!;
    expect(fab().job?.kind).toBe('repair');
    // Then a rearm of one job's worth
    let k = 0;
    while (fab().job?.kind !== 'rearm' && k++ < 20000) w.run(1);
    const job = fab().job!;
    expect(job).toMatchObject({ kind: 'rearm', uid: BAY, count: REARM.perJob });
    expect(job.need).toBe(jobTicks(rearmWork(REARM.perJob), tierRule('fabricator', 0).speed, 0));
    expect(job.held).toEqual(rearmBill(REARM.perJob));
    // (Not a claim on the part: the repair bank may still mend the bay)
    expect(((w.server as any).features.get('machines')).isClaimed(a.pid, BAY)).toBe(false);
    for (let n = 0; n < job.need + 5 && !a.prof.ship.field?.mines; n++) w.run(1);
    expect(a.prof.ship.field?.mines).toEqual({ [BAY]: REARM.perJob });
    w.run(2);
    expect(of(a.got, 'mineBay').at(-1)!.loaded).toEqual({ [BAY]: REARM.perJob });
  }, 120_000);
});
