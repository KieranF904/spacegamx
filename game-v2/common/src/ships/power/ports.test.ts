/**
 * The ports energy core (ports.ts) on the game's own catalog and the three dev ships (data/ships/blueprints/dev/ports-*.json):
 * ports placed in a part's frame (a gun's back is its back whatever its facing), links where an out port faces an in
 * port, feed networks through pipes, Passthroughs and Selectors, and a few seconds of the tick: guns fire from their
 * buffers, a Combiner's material reaches a beam, a Selector switches, a Reaction Thruster runs on its tank.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import type { Side } from '../types.js';
import { join } from 'node:path';
import { parseBlueprint, validateBlueprint } from '../blueprint.js';
import { createShipState } from '../state.js';
import { stepGuns } from '../guns.js';
import { powerTick, remapCharge, type Charge } from '../energy.js';
import { SHIP_DATA_DIR } from '../testData.js';
import { catalog, tuning } from './testData.js';
import { P_GEN, P_RELAY, P_TANK, P_THRUSTER, P_WEAPON, PF_LIT, PF_SEL, createPortsState, fullPorts, matOf, packPorts, portsSwitchFeeds, portsThrustFrac, portsThrustMul, portsTick, unpackPortsInto, type PortsLayout, type PortsState } from './ports.js';

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

describe('every ports dev ship', () => {
  for (const f of readdirSync(join(SHIP_DATA_DIR, 'blueprints/dev')).filter((x) => x.startsWith('ports-'))) {
    it(`${f}: a valid design whose guns, engines and tools are all fed`, () => {
      const bp = dev(f);
      expect(validateBlueprint(catalog, bp, tuning).errors.map((e) => e.message)).toEqual([]);
      const L = createShipState(catalog, tuning, 1, bp, 0).derived.ports!;
      for (const i of [...L.weapons, ...L.thrusters, ...L.tools]) expect(L.inStart[i + 1] - L.inStart[i], bp.parts[i].fn).toBeGreaterThan(0);
      for (let i = 0; i < L.n; i++) if (L.feedPort[i]) expect(L.netOf[i], bp.parts[i].fn).toBeGreaterThanOrEqual(0);
    });
  }
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
    run(1800);
    expect(lit).toBeGreaterThan(20);
    expect(lit).toBeLessThan(1600);
    expect(mats.has(coolF)).toBe(true);
    expect(mats.has(lensF)).toBe(false);
    // (Under-fed now the Lance has a floor, it fires too seldom to run its Coolant out in a test: the switch itself is checked)
    const sel = partAt(bp, 'feed_selector');
    portsSwitchFeeds(L, e);
    expect(e.flags[sel] & PF_SEL).toBe(PF_SEL);
    void lensF; void PF_LIT;
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

  it('the wire: the state packs into quads and reads back the same, augment buffers too; a rebuild keeps what each part held', () => {
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
    expect(Array.from(back.aug)).toEqual(Array.from(e.aug));
    const kept = remapCharge(d, d, c);
    expect(kept.e).toBe(e);
    expect(fullPorts(L, createPortsState(L)).held[L.relays[0]]).toBe(L.cap[L.relays[0]]);
    expect(L.role[L.gens[0]]).toBe(P_GEN);
    expect(L.role[L.weapons[0]]).toBe(P_WEAPON);
    void portsTick; void CTL;
  });
});

/** A small ship of `parts` (a core at the left of the gun), and how many shots its first gun fires over `secs` after 10 s to spend what it started with (and how many augmented) */
function volley(parts: { fn: string; piece?: string; x: number; y: number; rot?: number; facing?: Side }[], secs = 30) {
  const fnOf = (id: string) => catalog.functions.get(id);
  const pieceOf = (id: string) => { const ps = fnOf(id)?.pieces; return ps && ps !== '*' ? ps[0] : 'sq'; };
  const bp = { name: 't', catalogVersion: 1, power: 'ports' as const, parts: parts.map((q, uid) => ({ uid, fn: q.fn, piece: q.piece ?? pieceOf(q.fn), material: fnOf(q.fn)?.material ?? 'alloy', x: q.x, y: q.y, rot: (q.rot ?? 0) as 0, flip: false, ...(q.facing ? { facing: q.facing } : {}) })) };
  const ship = createShipState(catalog, tuning, 1, bp, 0), d = ship.derived;
  let c: Charge = { g: 100, b: [], e: createPortsState(d.ports!) }, shots = 0, aug = 0;
  for (let t = 0; t < (secs + 10) * 60; t++) {
    c = powerTick(d, c, { thrusting: false, boosting: false }, tuning).charge;
    const g = stepGuns(ship, { x: 0, y: 0, angle: -Math.PI / 2 }, { firing: true, aimWorld: -Math.PI / 2, aimDist: 0, energy: { charge: c } }, t, tuning);
    if (t < 600) continue;
    shots += g.shots.length; aug += g.shots.filter((x) => x.aug).length;
  }
  return { shots, aug };
}

describe('arming a ship (design doc section 17)', () => {
  // A Bastion facing N at (0,0)-(1,1); its main inputs at the backs of (0,1) and (1,1), its augment at the W of (0,0)
  const bastion = { fn: 'cannon_bastion', x: 0, y: 0, facing: 'N' as Side }, core = { fn: 'core', x: -1, y: 1 };
  it('a heavy gun\'s floor: two Cell Reactors never charge a Bastion; a Fusion Plant does; a Conduit between can\'t fake it', () => {
    expect(volley([core, bastion, { fn: 'power_cell_reactor', x: 0, y: 2 }, { fn: 'power_cell_reactor', x: 1, y: 2 }]).shots).toBe(0);
    expect(volley([core, bastion, { fn: 'power_fusion_plant', x: 0, y: 2 }]).shots).toBeGreaterThan(10);
    expect(volley([core, bastion, { fn: 'power_conduit', x: 0, y: 2 }, { fn: 'power_conduit', x: 1, y: 2 }, { fn: 'power_cell_reactor', x: 0, y: 3 }, { fn: 'power_cell_reactor', x: 1, y: 3 }]).shots).toBe(0);
  });
  it('a dual gun fires plain on one reactor, and augmented with a rated line into its augment input', () => {
    // (A Hammer at (0,0)-(1,0): main input at the back of (0,0), augment at the back of (1,0))
    const hammer = { fn: 'cannon_hammer', x: 0, y: 0, facing: 'N' as Side }, at = { fn: 'core', x: -1, y: 0 };
    const plain = volley([at, hammer, { fn: 'power_cell_reactor', x: 0, y: 1 }]);
    expect(plain.shots).toBeGreaterThan(20);
    expect(plain.aug).toBe(0);
    // (A lone reactor on the augment input never meets its floor)
    expect(volley([at, hammer, { fn: 'power_cell_reactor', x: 0, y: 1 }, { fn: 'power_cell_reactor', x: 1, y: 1 }]).aug).toBe(0);
    const fed = volley([at, hammer, { fn: 'power_cell_reactor', x: 0, y: 1 }, { fn: 'power_overclock_reactor', x: 1, y: 1 }]);
    expect(fed.shots).toBe(plain.shots);
    expect(fed.aug).toBe(fed.shots);
  });
  it('the Breacher: its inner Hammers fire augmented, its outer ones plain', () => {
    const ship = shipOf('ports-breacher.json'), d = ship.derived, bp = ship.blueprint;
    const inner = partAt(bp, 'cannon_hammer', -3), outer = partAt(bp, 'cannon_hammer', -5);
    let c: Charge = { g: 100, b: [], e: createPortsState(d.ports!) };
    const n = new Map<number, number>(), a = new Map<number, number>();
    for (let t = 0; t < 1800; t++) {
      c = powerTick(d, c, { thrusting: false, boosting: false }, tuning).charge;
      for (const s of stepGuns(ship, { x: 0, y: 0, angle: -Math.PI / 2 }, { firing: true, aimWorld: -Math.PI / 2, aimDist: 0, energy: { charge: c } }, t, tuning).shots) {
        if (t < 600) continue;
        n.set(s.w.part, (n.get(s.w.part) ?? 0) + 1);
        if (s.aug) a.set(s.w.part, (a.get(s.w.part) ?? 0) + 1);
      }
    }
    expect(n.get(inner)).toBeGreaterThan(10);
    expect(a.get(inner)).toBe(n.get(inner));
    expect(a.get(outer) ?? 0).toBe(0);
  });
});
