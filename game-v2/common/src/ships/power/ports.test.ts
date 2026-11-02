/**
 * The ports energy core (ports.ts) on the game's own catalog and the three dev ships (data/ships/blueprints/dev/ports-*.json):
 * ports placed in a part's frame (a gun's back is its back whatever its facing), links where an out port faces an in
 * port, feed networks through pipes, Passthroughs and Selectors, and a few seconds of the tick: guns fire from their
 * buffers, a Combiner's material reaches a beam, a Selector switches, a Reaction Thruster runs on its tank.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBlueprint } from '../blueprint.js';
import { createShipState } from '../state.js';
import { stepGuns } from '../guns.js';
import { powerTick, remapCharge, type Charge } from '../energy.js';
import { SHIP_DATA_DIR } from '../testData.js';
import { catalog, tuning } from './testData.js';
import { P_GEN, P_RELAY, P_TANK, P_THRUSTER, P_WEAPON, PF_LIT, createPortsState, fullPorts, matOf, packPorts, portsSwitchFeeds, portsThrustFrac, portsThrustMul, portsTick, unpackPortsInto, type PortsLayout, type PortsState } from './ports.js';

const dev = (name: string) => parseBlueprint(readFileSync(join(SHIP_DATA_DIR, 'blueprints/dev', name), 'utf8'));
const shipOf = (name: string) => createShipState(catalog, tuning, 1, dev(name), 0);
const partAt = (bp: ReturnType<typeof dev>, fn: string, x?: number) => bp.parts.findIndex((p) => p.fn === fn && (x === undefined || p.x === x));
const linksInto = (L: PortsLayout, p: number) => Array.from(L.inLink.subarray(L.inStart[p], L.inStart[p + 1]), (l) => L.linkFrom[l]);
const CTL = { active: null, boosting: false, toolWant: null, reload: false };

describe('ports layout on the dev ships', () => {
  it('the Gunship: every consumer is fed, the core by two reactors, the rattlers through corner conduits', () => {
    const ship = shipOf('ports-gunship.json'), L = ship.derived.ports!, bp = ship.blueprint;
    expect(ship.derived.power).toBeUndefined();
    expect(L.role[partAt(bp, 'core')]).toBe(P_RELAY);
    expect(L.gens.length).toBe(6);
    for (const w of L.weapons) expect(linksInto(L, w).length).toBeGreaterThan(0);
    for (const t of L.thrusters) expect(linksInto(L, t).length).toBe(1);
    expect(linksInto(L, partAt(bp, 'core')).sort()).toEqual([partAt(bp, 'power_cell_reactor', -1), partAt(bp, 'power_cell_reactor', 1)].sort());
    expect(linksInto(L, partAt(bp, 'autocannon_rattler', -1))).toEqual([partAt(bp, 'power_corner', -1)]);
    expect(linksInto(L, partAt(bp, 'power_corner', -1))).toEqual([partAt(bp, 'power_cell_reactor', -2)]);
    // (nothing is starved by the old networks)
    expect(ship.derived.satisfaction.every((s) => s === 1)).toBe(true);
  });

  it('the Lancer: the Lance takes at both back ports, its Combiner line carries the Selector\'s material', () => {
    const ship = shipOf('ports-lancer.json'), L = ship.derived.ports!, bp = ship.blueprint;
    const lance = partAt(bp, 'lance_lance'), comb = partAt(bp, 'power_combiner'), sel = partAt(bp, 'feed_selector');
    expect(linksInto(L, lance).sort()).toEqual([partAt(bp, 'power_conduit', 0), partAt(bp, 'power_corner', 1)].sort());
    expect(L.role[sel]).toBe(7);
    expect(L.selOut[sel]).toBe(L.netOf[comb]);
    expect(L.selIn[2 * sel]).toBe(L.netOf[partAt(bp, 'feed_tank_coolant')]);
    expect(L.selIn[2 * sel + 1]).toBe(L.netOf[partAt(bp, 'feed_tank_lens')]);
    expect(L.takes[lance]).not.toBe(0);
    expect(L.burst[lance]).toBe(1);
  });

  it('the Raider: the Slurry Cannon\'s feed crosses the power line through the Passthrough; the thrusters share a tank', () => {
    const ship = shipOf('ports-raider.json'), L = ship.derived.ports!, bp = ship.blueprint;
    const gun = partAt(bp, 'cannon_slurry'), pass = partAt(bp, 'power_passthrough');
    expect(linksInto(L, gun)).toEqual([pass]);
    expect(L.feedPort[gun]).toBe(2);
    expect(L.netOf[gun]).toBe(L.netOf[partAt(bp, 'feed_tank_accelerant')]);
    expect(L.netOf[partAt(bp, 'feed_pipe')]).toBe(L.netOf[gun]);
    const t1 = partAt(bp, 'engine_reaction_thruster', -1), t2 = partAt(bp, 'engine_reaction_thruster', 1), tank = partAt(bp, 'feed_tank_reaction');
    expect(L.netOf[t1]).toBe(L.netOf[tank]);
    expect(L.netOf[t2]).toBe(L.netOf[tank]);
    expect(L.role[tank]).toBe(P_TANK);
    expect(L.role[t1]).toBe(P_THRUSTER);
  });
});

describe('ports tick', () => {
  it('the Gunship fires its guns from their buffers and refills them; its engines burn and are fed', () => {
    const ship = shipOf('ports-gunship.json'), L = ship.derived.ports!, d = ship.derived;
    let c: Charge = { g: 100, b: [], e: createPortsState(L) };
    let shots = 0;
    for (let t = 0; t < 600; t++) {
      c = powerTick(d, c, { thrusting: true, boosting: false, dir: [0, -1] }, tuning).charge;
      const out = stepGuns(ship, { x: 0, y: 0, angle: -Math.PI / 2 }, { firing: true, aimWorld: -Math.PI / 2, aimDist: 0, energy: { charge: c } }, t, tuning);
      shots += out.shots.length;
    }
    expect(shots).toBeGreaterThan(20);
    const e = c.e!;
    for (const w of L.weapons) expect(e.held[w]).toBeLessThanOrEqual(L.cap[w]);
    for (const t of L.thrusters) expect(portsThrustFrac()[t]).toBeGreaterThan(0.9);
    expect(e.gauge).toBeGreaterThan(0);
  });

  it('the Lancer: the Lance lights when full, burns, rests; on Coolant first, then Lens after a switch', () => {
    const ship = shipOf('ports-lancer.json'), L = ship.derived.ports!, d = ship.derived, bp = ship.blueprint;
    const lance = partAt(bp, 'lance_lance'), lensF = L.feeds.indexOf('lens'), coolF = L.feeds.indexOf('coolant');
    let c: Charge = { g: 100, b: [], e: createPortsState(L) };
    const e = c.e!;
    let lit = 0, mats = new Set<number>();
    const run = (ticks: number) => {
      for (let t = 0; t < ticks; t++) {
        c = powerTick(d, c, { thrusting: false, boosting: false }, tuning).charge;
        const out = stepGuns(ship, { x: 0, y: 0, angle: -Math.PI / 2 }, { firing: true, aimWorld: -Math.PI / 2, aimDist: 0, energy: { charge: c } }, t, tuning);
        if (out.beams.length) { lit++; mats.add(matOf(L, e, lance)); }
      }
    };
    run(900);
    expect(lit).toBeGreaterThan(60);
    expect(lit).toBeLessThan(800);
    expect(mats.has(coolF)).toBe(true);
    expect(mats.has(lensF)).toBe(false);
    portsSwitchFeeds(L, e);
    mats = new Set();
    run(3600);
    expect(mats.has(lensF)).toBe(true);
    expect(e.flags[lance] & PF_LIT).toBeDefined();
  });

  it('the Raider: the Slurry Cannon fires only with feed; the Reaction Thrusters push five times harder on their tank', () => {
    const ship = shipOf('ports-raider.json'), L = ship.derived.ports!, d = ship.derived, bp = ship.blueprint;
    const tank = partAt(bp, 'feed_tank_reaction'), t1 = partAt(bp, 'engine_reaction_thruster', -1);
    let c: Charge = { g: 100, b: [], e: createPortsState(L) };
    const e = c.e!;
    let shots = 0;
    for (let t = 0; t < 600; t++) {
      c = powerTick(d, c, { thrusting: true, boosting: false, dir: [0, -1] }, tuning).charge;
      shots += stepGuns(ship, { x: 0, y: 0, angle: -Math.PI / 2 }, { firing: true, aimWorld: -Math.PI / 2, aimDist: 0, energy: { charge: c } }, t, tuning).shots.length;
    }
    expect(shots).toBeGreaterThan(5);
    expect(portsThrustMul()[t1]).toBe(5);
    expect(e.held[tank]).toBeLessThan(L.cap[tank]);
    // Dry: the accelerant gone, the cannon stops; the thrusters fall back to 1
    for (const k of L.tanks) e.held[k] = 0;
    for (let p = 0; p < L.n; p++) if (L.role[p] !== P_TANK) { e.amt[p] = 0; e.mat[p] = 0; }
    shots = 0;
    for (let t = 0; t < 300; t++) {
      c = powerTick(d, c, { thrusting: true, boosting: false, dir: [0, -1] }, tuning).charge;
      shots += stepGuns(ship, { x: 0, y: 0, angle: -Math.PI / 2 }, { firing: true, aimWorld: -Math.PI / 2, aimDist: 0, energy: { charge: c } }, t, tuning).shots.length;
    }
    expect(shots).toBe(0);
    expect(portsThrustMul()[t1]).toBe(1);
  });

  it('the wire: the state packs into triples and reads back the same; a rebuild keeps what each part held', () => {
    const ship = shipOf('ports-lancer.json'), L = ship.derived.ports!, d = ship.derived;
    let c: Charge = { g: 100, b: [], e: createPortsState(L) };
    for (let t = 0; t < 200; t++) {
      c = powerTick(d, c, { thrusting: true, boosting: true, dir: [0, -1] }, tuning).charge;
      stepGuns(ship, { x: 0, y: 0, angle: -Math.PI / 2 }, { firing: true, aimWorld: -Math.PI / 2, aimDist: 0, energy: { charge: c } }, t, tuning);
    }
    const e = c.e!, row: number[] = new Array(13).fill(0);
    row[8] = L.sig; row[9] = -packPorts(L, e, row);
    const back: PortsState = createPortsState(L);
    expect(unpackPortsInto(L, back, row)).toBe(true);
    expect(Array.from(back.held)).toEqual(Array.from(e.held));
    expect(Array.from(back.amt)).toEqual(Array.from(e.amt));
    expect(Array.from(back.mat)).toEqual(Array.from(e.mat));
    expect(Array.from(back.flags)).toEqual(Array.from(e.flags));
    expect(Array.from(back.closed)).toEqual(Array.from(e.closed));
    const kept = remapCharge(d, d, c);
    expect(kept.e).toBe(e);
    expect(fullPorts(L, createPortsState(L)).held[L.relays[0]]).toBe(L.cap[L.relays[0]]);
    expect(L.role[L.gens[0]]).toBe(P_GEN);
    expect(L.role[L.weapons[0]]).toBe(P_WEAPON);
    void portsTick; void CTL;
  });
});
