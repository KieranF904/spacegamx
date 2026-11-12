/**
 * Weapon modifiers on the ports core (docs/design/weapon-modifiers-2026-11.md): the modifier lab's checks
 * (prototypes/modifier-lab/treat.check.mjs) on real parts. Every ship here is a line running W to E along y = -2, its
 * modifier blocks above it, on a row of hull that joins it to the core.
 */

import { describe, it, expect } from 'vitest';
import type { Blueprint, PlacedPart, Rot, Side } from '../types.js';
import { createShipState } from '../state.js';
import type { ShipTuning } from '../tuning.js';
import { FX_STEPS } from '../modifiers/types.js';
import {
  PF_LATCH, P_INERT, createPortsState, effShot, packPorts, portsFxLive, portsGunReady, portsLastFx, portsRapidStep, portsSig, portsSpendShot, portsTick,
  unpackPortsInto, portsDigest, type PortsControls, type PortsLayout, type PortsState,
} from './ports.js';
import { toEu } from './units.js';
import { catalog, tuning } from './testData.js';

type Item = [key: string, fn: string, x: number, y: number, extra?: Partial<PlacedPart>];
/** A line part passing W to E; a Mount doing so with its socket up; a gun firing E (its input at its W) */
const R = { rot: 1 as Rot }, RM = { rot: 1 as Rot, flip: true }, E = { facing: 'E' as Side }, N = { facing: 'N' as Side }, S = { facing: 'S' as Side };
const CTL: PortsControls = { active: null, boosting: false, toolWant: null, reload: false };
const mt = tuning.modifiers!, fx = (name: string) => mt.effects.indexOf(name);

function ship(items: Item[], t: ShipTuning = tuning) {
  const part = (uid: number, fn: string, x: number, y: number, extra: Partial<PlacedPart> = {}): PlacedPart => {
    const def = catalog.functions.get(fn), piece = fn === 'core' ? 'rect2' : Array.isArray(def?.pieces) ? def.pieces[0] : 'sq';
    return { uid, piece, fn, material: def?.material ?? 'alloy', x, y, rot: 0 as Rot, flip: false, ...extra };
  };
  const parts = [part(0, 'core', 0, 0), ...items.map(([, fn, x, y, extra], i) => part(i + 1, fn, x, y, extra))];
  // (The hull row: every cell of y = -1 a ship's own parts leave free)
  const taken = new Set(items.filter((q) => q[3] === -1).map((q) => q[2]));
  for (let x = -8; x <= 6; x++) if (!taken.has(x)) parts.push(part(parts.length, 'hull', x, -1));
  const b: Blueprint = { name: 'test', catalogVersion: 1, parts };
  const d = createShipState(catalog, t, 1, b, 0).derived;
  expect(d.alive.every(Boolean)).toBe(true);
  const L = d.ports!, at = (key: string) => 1 + items.findIndex((q) => q[0] === key);
  return { L, at, e: createPortsState(L) };
}
const run = (L: PortsLayout, e: PortsState, ticks: number) => { for (let i = 0; i < ticks; i++) portsTick(L, e, CTL); };
/** A gun's effects by name, with their strength steps */
const fxOf = (L: PortsLayout, p: number) => (L.mod?.gunFx[p] ?? []).map((g) => [mt.effects[g.fx], g.q]);
const q = (treated: number, load: number) => Math.round(Math.min(1, treated / load) * FX_STEPS);

/** A reactor, a Mount with `block` on it, a gun */
const single = (block: string, gun = 'cannon_pip', more: Item[] = []): Item[] =>
  [['gen', 'power_cell_reactor', -3, -2, R], ['mount', 'mod_mount', -2, -2, RM], ['block', block, -2, -3], ['gun', gun, -1, -2, E], ...more];
/** A reactor, a Double or Triple Mount with its blocks (front left, front right, back left), a Longbarrel (170 E a second) */
const multi = (mount: string, blocks: string[]): Item[] => [
  ['gen', 'power_cell_reactor', -3, -2, R], ['mount', mount, -2, -2], ['gun', 'cannon_longbarrel', 0, -2, E],
  ...blocks.map((fn, i): Item => [`b${i}`, fn, i === 2 ? -2 : -2 + i, i === 2 ? -1 : -3]),
];

describe('weapon modifiers: sockets and recipes', () => {
  it('a Mount with a Coil on its socket gives the gun down its line Velocity at full strength', () => {
    const { L, at } = ship(single('mod_coil'));
    const M = L.mod!, g = at('gun');
    expect(fxOf(L, g)).toEqual([['velocity', 15]]);
    expect(M.gunMounts[g]).toEqual([[at('mount')]]);
    expect(M.gunFeeds[g]).toEqual([[]]);
    expect([...M.mounts]).toEqual([at('mount')]);
    // (1 E a second for its one filled socket, rounded up to the eu)
    expect([...M.upkeep]).toEqual([5]);
  });

  it('a Coil on a side with no socket does nothing; the Mount flipped takes it', () => {
    const blank = single('mod_coil');
    blank[1] = ['mount', 'mod_mount', -2, -2, R];
    expect(ship(blank).L.mod).toBeUndefined();
    expect(ship(single('mod_coil')).L.mod).toBeDefined();
  });

  it('a Double Mount fuses a recipe into its own effect at the whole mount\'s amount', () => {
    const a = ship(multi('mod_mount_double', ['mod_coil', 'mod_prism']));
    expect(fxOf(a.L, a.at('gun'))).toEqual([['pierce', q(60, 170)]]);
    const b = ship(multi('mod_mount_double', ['mod_chamber', 'mod_resonator']));
    expect(fxOf(b.L, b.at('gun'))).toEqual([['wave', q(60, 170)]]);
  });

  it('a mount takes one kind: the first in socket order; the other block does nothing', () => {
    const a = ship(multi('mod_mount_double', ['mod_coil', 'mod_chamber']));
    expect(fxOf(a.L, a.at('gun'))).toEqual([['velocity', q(30, 170)]]);
    expect([...a.L.mod!.upkeep]).toEqual([5]);
    const b = ship(multi('mod_mount_double', ['mod_coil', 'mod_coil']));
    expect(fxOf(b.L, b.at('gun'))).toEqual([['velocity', q(60, 170)]]);
    expect([...b.L.mod!.upkeep]).toEqual([9]);
    // (Three kinds are no recipe)
    const c = ship(multi('mod_mount_triple', ['mod_coil', 'mod_prism', 'mod_chamber']));
    expect(fxOf(c.L, c.at('gun'))).toEqual([['velocity', q(40, 170)]]);
  });

  it('a Triple Mount with two Coils and a Prism fuses at its full amount', () => {
    const { L, at } = ship(multi('mod_mount_triple', ['mod_coil', 'mod_coil', 'mod_prism']));
    expect(fxOf(L, at('gun'))).toEqual([['pierce', q(120, 170)]]);
    expect(q(120, 170)).toBe(11);
  });

  it('single Mounts never fuse: a Coil and a Prism on two give Velocity and Split', () => {
    const { L, at } = ship([
      ['gen', 'power_cell_reactor', -4, -2, R], ['m1', 'mod_mount', -3, -2, RM], ['b1', 'mod_coil', -3, -3],
      ['m2', 'mod_mount', -2, -2, RM], ['b2', 'mod_prism', -2, -3], ['gun', 'cannon_pip', -1, -2, E],
    ]);
    expect(fxOf(L, at('gun'))).toEqual([['velocity', 15], ['split', 15]]);
    expect(L.mod!.gunMounts[at('gun')]).toEqual([[at('m1')], [at('m2')]]);
  });
});

describe('weapon modifiers: reach and shares', () => {
  /** A reactor, `mounts` Mounts with Coils, a Tee Splitter, a gun out of its front and one out of its back */
  const two = (a: string, b: string, mounts = 1, gen = 'power_cell_reactor'): Item[] => [
    ['gen', gen, -3 - mounts, -2, gen === 'hull' ? {} : R],
    ...Array.from({ length: mounts }, (_, i): Item[] => [[`m${i}`, 'mod_mount', -2 - mounts + i, -2, RM], [`c${i}`, 'mod_coil', -2 - mounts + i, -3]]).flat(),
    ['tee', 'power_splitter_tee', -2, -2], ['a', a, -2, -3, N], ['b', b, -2, -1, S],
  ];

  it('a mount shared by two guns treats each by its load', () => {
    const { L, at } = ship(two('laser_glint', 'arc_spark'));
    // (24 E a second over 15 + 18: the same share of each)
    expect(fxOf(L, at('a'))).toEqual([['velocity', q(24, 33)]]);
    expect(fxOf(L, at('b'))).toEqual([['velocity', q(24, 33)]]);
    expect(q(24, 33)).toBe(11);
  });

  it('two mounts in line add up, and a strength is never over full', () => {
    const { L, at } = ship(two('laser_glint', 'arc_spark', 2));
    expect(fxOf(L, at('a'))).toEqual([['velocity', 15]]);
    expect(fxOf(L, at('b'))).toEqual([['velocity', 15]]);
    expect(L.mod!.gunMounts[at('a')]).toEqual([[at('m0'), at('m1')]]);
  });

  it('what the line supplies changes nothing: the shares are the layout\'s', () => {
    const fed = ship(two('laser_glint', 'arc_spark')), dry = ship(two('laser_glint', 'arc_spark', 1, 'hull'));
    expect(fxOf(dry.L, dry.at('a'))).toEqual(fxOf(fed.L, fed.at('a')));
    expect(fxOf(dry.L, dry.at('b'))).toEqual(fxOf(fed.L, fed.at('b')));
  });

  it('effects do not pass a battery or a capacitor', () => {
    for (const store of ['power_battery', 'power_capacitor']) {
      const before = ship([['gen', 'power_cell_reactor', -4, -2, R], ['mount', 'mod_mount', -3, -2, RM], ['block', 'mod_coil', -3, -3], ['store', store, -2, -2, R], ['gun', 'cannon_pip', -1, -2, E]]);
      expect(before.L.mod).toBeDefined();
      expect(fxOf(before.L, before.at('gun'))).toEqual([]);
      const after = ship([['gen', 'power_cell_reactor', -4, -2, R], ['store', store, -3, -2, R], ['mount', 'mod_mount', -2, -2, RM], ['block', 'mod_coil', -2, -3], ['gun', 'cannon_pip', -1, -2, E]]);
      expect(fxOf(after.L, after.at('gun'))).toEqual([['velocity', 15]]);
    }
  });
});

describe('weapon modifiers: line tiers', () => {
  /** Three Mounts (Coil, Chamber, Prism), then `line` (a line part, or none), then a Pip */
  const three = (line?: string): Item[] => [
    ['gen', 'power_cell_reactor', -6, -2, R],
    ['m1', 'mod_mount', -5, -2, RM], ['b1', 'mod_coil', -5, -3], ['m2', 'mod_mount', -4, -2, RM], ['b2', 'mod_chamber', -4, -3], ['m3', 'mod_mount', -3, -2, RM], ['b3', 'mod_prism', -3, -3],
    ...(line ? [['line', line, -2, -2, R] as Item, ['gun', 'cannon_pip', -1, -2, E] as Item] : [['gun', 'cannon_pip', -2, -2, E] as Item]),
  ];

  it('a Conduit carries two effects: the weakest is dropped, and of equals the last put in', () => {
    const { L, at } = ship(three('power_conduit'));
    expect(fxOf(L, at('gun'))).toEqual([['velocity', 15], ['explosive', 15]]);
  });

  it('a Conduit II carries three, and mounts with no line part after them carry all', () => {
    const a = ship(three('power_conduit_2'));
    expect(fxOf(a.L, a.at('gun'))).toEqual([['velocity', 15], ['explosive', 15], ['split', 15]]);
    const b = ship(three());
    expect(fxOf(b.L, b.at('gun'))).toEqual([['velocity', 15], ['explosive', 15], ['split', 15]]);
  });

  it('over a line part\'s cap every effect scales to fit', () => {
    const tight: ShipTuning = { ...tuning, modifiers: { ...mt, lines: [{ fx: 2, cap: 10 }, ...mt.lines.slice(1)] } };
    const items: Item[] = [['gen', 'power_cell_reactor', -4, -2, R], ['mount', 'mod_mount', -3, -2, RM], ['block', 'mod_coil', -3, -3], ['line', 'power_conduit', -2, -2, R], ['gun', 'laser_glint', -1, -2, E]];
    const a = ship(items), b = ship(items, tight);
    expect(fxOf(a.L, a.at('gun'))).toEqual([['velocity', 15]]);
    // (10 of the Glint's 15 E a second)
    expect(fxOf(b.L, b.at('gun'))).toEqual([['velocity', 10]]);
  });
});

describe('weapon modifiers: what is live', () => {
  const battery = (block?: string): Item[] =>
    [['bat', 'power_battery', -3, -2, R], ['mount', 'mod_mount', -2, -2, RM], ['block', block ?? 'hull', -2, -3], ['gun', 'cannon_pip', -1, -2, E]];
  const total = (L: PortsLayout, e: PortsState) => { let t = 0; for (let i = 0; i < L.n; i++) t += e.held[i] + e.aug[i]; return t; };

  it('a working mount burns its upkeep from the line', () => {
    const plain = ship(battery()), mod = ship(battery('mod_coil'));
    expect(plain.L.mod).toBeUndefined();
    const p0 = total(plain.L, plain.e), m0 = total(mod.L, mod.e);
    run(plain.L, plain.e, 120); run(mod.L, mod.e, 120);
    expect(p0 - total(plain.L, plain.e)).toBe(0);
    expect(m0 - total(mod.L, mod.e)).toBe(120 * mod.L.mod!.upkeep[0]);
    expect(portsFxLive(mod.L, mod.e, mod.at('gun'))).toBe(1);
  });

  it('an unpowered mount still passes power, its effect off; powered again it is back', () => {
    const { L, e, at } = ship(battery('mod_coil')), m = at('mount'), g = at('gun');
    run(L, e, 10);
    e.held[at('bat')] = 0; e.held[m] = 0; e.aug[m] = 0;
    run(L, e, 1);
    expect(e.flags[m] & PF_LATCH).toBe(PF_LATCH);
    expect(portsFxLive(L, e, g)).toBe(0);
    // (The gun still holds its shots: it fires them plain)
    expect(portsGunReady(L, e, g)).toBe(true);
    portsSpendShot(L, e, g);
    expect(portsLastFx()).toBe(0);
    const held = e.held[g];
    e.held[at('bat')] = toEu(50);
    run(L, e, 6);
    expect(e.held[g]).toBeGreaterThan(held);
    expect(e.flags[m] & PF_LATCH).toBe(0);
    expect(portsFxLive(L, e, g)).toBe(1);
    portsSpendShot(L, e, g);
    expect(portsLastFx()).toBe(1);
  });

  it('a special uses up its hopper a shot, and drops off the shot when it runs out', () => {
    const { L, e, at } = ship(single('mod_arc', 'cannon_pip', [['hop', 'hopper_arcsalt', -2, -4]]));
    const g = at('gun'), h = at('hop');
    expect(fxOf(L, g)).toEqual([['chain', 15]]);
    expect(L.mod!.gunFeeds[g]).toEqual([[{ part: h, per4096: Math.round(mt.kinds.arc.needs!.per * 4096) }]]);
    // (A hopper is not power: no role, no ports, not in the gauge, and nothing flows into or out of it)
    expect(L.role[h]).toBe(P_INERT);
    expect(L.relays.includes(h)).toBe(false);
    expect(L.ports.some((x) => x.part === h)).toBe(false);
    expect(e.held[h]).toBe(toEu(60));
    run(L, e, 120);
    expect(e.held[h]).toBe(toEu(60));
    const shot = L.shot[g];
    portsSpendShot(L, e, g);
    expect(portsLastFx()).toBe(1);
    expect(toEu(60) - e.held[h]).toBe(Math.ceil((shot * L.mod!.gunFeeds[g]![0][0].per4096) / 4096));
    // (The state travels and hashes as any other)
    const out: number[] = new Array(13).fill(0), back = createPortsState(L);
    out[8] = L.sig; out[9] = -packPorts(L, e, out);
    expect(unpackPortsInto(L, back, out)).toBe(true);
    expect(back.held[h]).toBe(e.held[h]);
    expect(portsDigest(L, back)).toBe(portsDigest(L, e));
    e.held[h] = 1; e.held[g] = L.cap[g];
    expect(portsFxLive(L, e, g)).toBe(0);
    portsSpendShot(L, e, g);
    expect(portsLastFx()).toBe(0);
    expect(e.held[h]).toBe(1);
  });

  it('a special with no hopper, or the wrong one, does nothing', () => {
    expect(ship(single('mod_arc')).L.mod).toBeUndefined();
    expect(ship(single('mod_arc', 'cannon_pip', [['hop', 'hopper_cryo', -2, -4]])).L.mod).toBeUndefined();
    expect(ship(single('mod_condenser', 'cannon_pip', [['hop', 'hopper_cryo', -2, -4]])).L.mod).toBeDefined();
  });

  it('a Rail Driver Module works off a power line of its own, and pays from its buffer', () => {
    expect(ship(single('mod_rail')).L.mod).toBeUndefined();
    const items = single('mod_rail', 'cannon_pip', [['gen2', 'power_cell_reactor', -3, -3, R]]);
    items[2] = ['block', 'mod_rail', -2, -3, R];
    const { L, e, at } = ship(items), g = at('gun'), r = at('block');
    expect(fxOf(L, g)).toEqual([['hyper', 15]]);
    const before = e.held[r];
    portsSpendShot(L, e, g);
    expect(portsLastFx()).toBe(1);
    expect(before - e.held[r]).toBe(Math.ceil(L.shot[g] * mt.kinds.rail.needs!.per));
    e.held[r] = 0; e.held[g] = L.cap[g];
    portsSpendShot(L, e, g);
    expect(portsLastFx()).toBe(0);
  });

  it('Rapid is energy neutral: a shot costs the gun\'s over the rate while it is live', () => {
    const { L, e, at } = ship(single('mod_resonator')), g = at('gun'), m = at('mount');
    expect(fxOf(L, g)).toEqual([['rapid', 15]]);
    const cost = Math.round(L.shot[g] / mt.rapid.rate);
    expect(Math.abs(effShot(L, e, g) - cost)).toBeLessThanOrEqual(1);
    expect(portsRapidStep(L, e, g)).toBe(15);
    e.held[g] = effShot(L, e, g);
    expect(portsGunReady(L, e, g)).toBe(true);
    portsSpendShot(L, e, g);
    expect(e.held[g]).toBe(0);
    expect(portsLastFx()).toBe(1);
    // (Its mount unpowered: the gun's own shot again)
    e.flags[m] |= PF_LATCH;
    expect(effShot(L, e, g)).toBe(L.shot[g]);
    expect(portsRapidStep(L, e, g)).toBe(0);
  });
});

describe('weapon modifiers: ships without them', () => {
  it('a ship with no mount, or a mount with nothing on it, has no modifier side and its signature is the core\'s', () => {
    const plain = ship([['gen', 'power_cell_reactor', -3, -2, R], ['line', 'power_conduit', -2, -2, R], ['gun', 'cannon_pip', -1, -2, E]]);
    expect(plain.L.mod).toBeUndefined();
    expect(plain.L.sig).toBe(portsSig(plain.L));
    expect(effShot(plain.L, plain.e, plain.at('gun'))).toBe(plain.L.shot[plain.at('gun')]);
    const before = portsDigest(plain.L, plain.e);
    expect(portsFxLive(plain.L, plain.e, plain.at('gun'))).toBe(0);
    expect(portsDigest(plain.L, plain.e)).toBe(before);
    portsSpendShot(plain.L, plain.e, plain.at('gun'));
    expect(portsLastFx()).toBe(0);
    const bare = ship([['gen', 'power_cell_reactor', -3, -2, R], ['mount', 'mod_mount', -2, -2, RM], ['gun', 'cannon_pip', -1, -2, E]]);
    expect(bare.L.mod).toBeUndefined();
    expect(bare.L.sig).toBe(portsSig(bare.L));
    // (A working mount is in the signature)
    const mod = ship([['gen', 'power_cell_reactor', -3, -2, R], ['mount', 'mod_mount', -2, -2, RM], ['block', 'mod_coil', -2, -3], ['gun', 'cannon_pip', -1, -2, E]]);
    expect(mod.L.sig).not.toBe(portsSig(mod.L));
  });

  it('the same design builds the same modifier side', () => {
    const a = ship(single('mod_coil')).L, b = ship(single('mod_coil')).L;
    expect(b.mod).toEqual(a.mod);
    expect(b.sig).toBe(a.sig);
  });
});
