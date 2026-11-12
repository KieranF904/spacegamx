/**
 * The hangar's explanation of weapon modifiers (portsModsExplain.ts) against the layout it explains: on portsMods.test.ts's
 * kind of ship (a line W to E along y = -2, blocks above it) and on the showcase blueprint.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Blueprint, PlacedPart, Rot, Side } from '../types.js';
import { createShipState } from '../state.js';
import type { ShipTuning } from '../tuning.js';
import { explainShipMods } from './portsModsExplain.js';
import { catalog, tuning } from './testData.js';

type Item = [key: string, fn: string, x: number, y: number, extra?: Partial<PlacedPart>];
const R = { rot: 1 as Rot }, RM = { rot: 1 as Rot, flip: true }, E = { facing: 'E' as Side };
const mt = tuning.modifiers!, fx = (name: string) => mt.effects.indexOf(name);

function explain(b: Blueprint, t: ShipTuning = tuning) {
  const d = createShipState(catalog, t, 1, b, 0).derived;
  expect(d.alive.every(Boolean)).toBe(true);
  const before = JSON.stringify(d.ports!.mod ?? null);
  const ex = explainShipMods(catalog, t, b.parts, d);
  // (Read-only: the layout's modifier side is as it was)
  expect(JSON.stringify(d.ports!.mod ?? null)).toBe(before);
  // (The guns' effects it works out are the layout's own)
  const mine = [...(ex?.guns.values() ?? [])].filter((g) => g.slots.length).map((g) => [g.part, g.slots.map((s) => [s.fx, s.q])]);
  const theirs = (d.ports!.mod?.gunFx ?? []).flatMap((g, p) => (g?.length ? [[p, g.map((s) => [s.fx, s.q])]] : []));
  expect(mine).toEqual(theirs);
  return { ex, L: d.ports! };
}

function ship(items: Item[], t: ShipTuning = tuning) {
  const part = (uid: number, fn: string, x: number, y: number, extra: Partial<PlacedPart> = {}): PlacedPart => {
    const def = catalog.functions.get(fn), piece = fn === 'core' ? 'rect2' : Array.isArray(def?.pieces) ? def.pieces[0] : 'sq';
    return { uid, piece, fn, material: def?.material ?? 'alloy', x, y, rot: 0 as Rot, flip: false, ...extra };
  };
  const parts = [part(0, 'core', 0, 0), ...items.map(([, fn, x, y, extra], i) => part(i + 1, fn, x, y, extra))];
  const taken = new Set(items.filter((q) => q[3] === -1).map((q) => q[2]));
  for (let x = -8; x <= 6; x++) if (!taken.has(x)) parts.push(part(parts.length, 'hull', x, -1));
  const at = (key: string) => 1 + items.findIndex((q) => q[0] === key);
  return { ...explain({ name: 'test', catalogVersion: 1, parts }, t), at };
}

const single = (block: string, more: Item[] = [], mount: Partial<PlacedPart> = RM): Item[] =>
  [['gen', 'power_cell_reactor', -3, -2, R], ['mount', 'mod_mount', -2, -2, mount], ['block', block, -2, -3], ['gun', 'cannon_pip', -1, -2, E], ...more];
const multi = (mount: string, blocks: string[]): Item[] => [
  ['gen', 'power_cell_reactor', -3, -2, R], ['mount', mount, -2, -2], ['gun', 'cannon_longbarrel', 0, -2, E],
  ...blocks.map((fn, i): Item => [`b${i}`, fn, i === 2 ? -2 : -2 + i, i === 2 ? -1 : -3]),
];
const three = (line: string): Item[] => [
  ['gen', 'power_cell_reactor', -6, -2, R],
  ['m1', 'mod_mount', -5, -2, RM], ['b1', 'mod_coil', -5, -3], ['m2', 'mod_mount', -4, -2, RM], ['b2', 'mod_chamber', -4, -3], ['m3', 'mod_mount', -3, -2, RM], ['b3', 'mod_prism', -3, -3],
  ['line', line, -2, -2, R], ['gun', 'cannon_pip', -1, -2, E],
];

describe('weapon modifiers explained: mounts and blocks', () => {
  it('a ship with no mount, block or hopper has nothing to explain', () => {
    expect(ship([['gen', 'power_cell_reactor', -2, -2, R], ['gun', 'cannon_pip', -1, -2, E]]).ex).toBeUndefined();
  });

  it('a Mount with a Coil: its socket filled, its effect, what it treats and burns, the gun it reaches', () => {
    const { ex, at } = ship(single('mod_coil'));
    const m = ex!.mounts.get(at('mount'))!;
    expect(m.sockets.map((s) => s.block)).toEqual([at('block')]);
    expect(m).toMatchObject({ kinds: ['coil'], fused: false, fx: fx('velocity'), treat: 24, upkeep: 1, guns: [at('gun')], cover: 1, working: true });
    expect(ex!.blocks.get(at('block'))).toMatchObject({ kind: 'coil', mount: at('mount') });
    expect(ex!.blocks.get(at('block'))!.idle).toBeUndefined();
    expect(ex!.guns.get(at('gun'))!.lost).toEqual([]);
  });

  it('a block no socket faces says so, and the mount shows its socket empty', () => {
    const { ex, at } = ship(single('mod_coil', [], R));
    expect(ex!.blocks.get(at('block'))!.idle).toBe('noSocket');
    expect(ex!.mounts.get(at('mount'))!.sockets.map((s) => s.block)).toEqual([-1]);
    expect(ex!.mounts.get(at('mount'))!.working).toBe(false);
    expect(ex!.guns.size).toBe(0);
  });

  it('a Double Mount names the recipe it fused; with two kinds of no recipe the second block is the wrong kind', () => {
    const a = ship(multi('mod_mount_double', ['mod_coil', 'mod_prism']));
    expect(a.ex!.mounts.get(a.at('mount'))).toMatchObject({ fused: true, fx: fx('pierce'), treat: 60, blocks: [a.at('b0'), a.at('b1')] });
    expect([...a.ex!.mounts.get(a.at('mount'))!.kinds].sort()).toEqual(['coil', 'prism']);
    const b = ship(multi('mod_mount_double', ['mod_coil', 'mod_chamber']));
    expect(b.ex!.mounts.get(b.at('mount'))).toMatchObject({ fused: false, fx: fx('velocity'), kinds: ['coil'], treat: 30 });
    expect(b.ex!.blocks.get(b.at('b1'))!.idle).toBe('wrongKind');
    expect(b.ex!.blocks.get(b.at('b0'))!.idle).toBeUndefined();
  });

  it('a mount whose guns draw more than it treats covers a share of them', () => {
    const { ex, at } = ship(multi('mod_mount_double', ['mod_coil', 'mod_coil']));
    expect(ex!.mounts.get(at('mount'))!.cover).toBeCloseTo(60 / 170, 6);
  });

  it('a special with no hopper of its material, or no power line of its own, says which', () => {
    const a = ship(single('mod_arc', [['hop', 'hopper_cryo', -2, -4]]));
    expect(a.ex!.blocks.get(a.at('block'))!.idle).toBe('noHopper');
    expect(a.ex!.hoppers.get(a.at('hop'))).toMatchObject({ mat: 'cryo', blocks: [] });
    const b = ship(single('mod_rail'));
    expect(b.ex!.blocks.get(b.at('block'))!.idle).toBe('noPower');
    const c = ship(single('mod_condenser', [['hop', 'hopper_cryo', -2, -4]]));
    expect(c.ex!.blocks.get(c.at('block'))!.idle).toBeUndefined();
    expect(c.ex!.blocks.get(c.at('block'))!.hoppers).toEqual([c.at('hop')]);
    expect(c.ex!.hoppers.get(c.at('hop'))!.blocks).toEqual([c.at('block')]);
  });

  it('a mount whose line reaches no gun leaves its block idle', () => {
    const { ex, at } = ship([['gen', 'power_cell_reactor', -3, -2, R], ['mount', 'mod_mount', -2, -2, RM], ['block', 'mod_coil', -2, -3]]);
    expect(ex!.blocks.get(at('block'))!.idle).toBe('noGuns');
  });
});

describe('weapon modifiers explained: line parts', () => {
  it('a Conduit names the effect it dropped, and the gun who dropped it', () => {
    const { ex, at } = ship(three('power_conduit'));
    const l = ex!.lines.get(at('line'))!;
    expect(l).toMatchObject({ tier: 1, max: 2, dropped: [fx('split')], scale: 1 });
    expect(l.carried.map((c) => c.fx)).toEqual([fx('velocity'), fx('explosive')]);
    expect(ex!.guns.get(at('gun'))!.lost).toEqual([{ fx: fx('split'), by: at('line') }]);
  });

  it('a Conduit II carries all three', () => {
    const { ex, at } = ship(three('power_conduit_2'));
    expect(ex!.lines.get(at('line'))).toMatchObject({ tier: 2, max: 3, dropped: [], scale: 1 });
    expect(ex!.lines.get(at('line'))!.carried.length).toBe(3);
    expect(ex!.guns.get(at('gun'))!.lost).toEqual([]);
  });

  it('a line part over its cap says what it left', () => {
    const tight: ShipTuning = { ...tuning, modifiers: { ...mt, lines: [{ fx: 2, cap: 10 }, ...mt.lines.slice(1)] } };
    const { ex, at } = ship([['gen', 'power_cell_reactor', -4, -2, R], ['mount', 'mod_mount', -3, -2, RM], ['block', 'mod_coil', -3, -3], ['line', 'power_conduit', -2, -2, R], ['gun', 'laser_glint', -1, -2, E]], tight);
    const l = ex!.lines.get(at('line'))!;
    expect(l.scale).toBeCloseTo(10 / 15, 6);
    expect(l.carried.map((c) => [c.fx, Math.round(c.amt)])).toEqual([[fx('velocity'), 10]]);
  });
});

describe('weapon modifiers explained: the showcase ship', () => {
  it('data/ships/blueprints/dev/mod-showcase-1.json gives its guns the effects it is there to show', () => {
    const bp = JSON.parse(readFileSync(join(__dirname, '../../../../data/ships/blueprints/dev/mod-showcase-1.json'), 'utf8')) as Blueprint;
    const { ex, L } = explain(bp);
    const gun = (fn: string, x: number) => bp.parts.findIndex((p) => p.fn === fn && p.x === x);
    const names = (p: number) => (L.mod!.gunFx[p] ?? []).map((g) => [mt.effects[g.fx], g.q]);
    // (Four single effects through a Conduit III; a single effect; a special off its hopper; a fused Double; another special)
    expect(names(gun('cannon_pip', -1))).toEqual([['velocity', 15], ['rapid', 15], ['explosive', 15], ['split', 15]]);
    expect(names(gun('cannon_pip', -3))).toEqual([['velocity', 15]]);
    expect(names(gun('autocannon_rattler', -5))).toEqual([['chain', 15]]);
    expect(names(gun('cannon_hammer', 2))).toEqual([['pierce', 15]]);
    expect(names(gun('autocannon_stinger', 4))).toEqual([['heavy', 15]]);
    expect([...ex!.mounts.values()].filter((m) => m.fused).map((m) => mt.effects[m.fx])).toEqual(['pierce']);
    expect([...ex!.lines.values()].map((l) => [l.tier, l.carried.length, l.dropped.length])).toEqual([[3, 4, 0]]);
    expect([...ex!.blocks.values()].every((b) => !b.idle)).toBe(true);
    expect([...ex!.hoppers.values()].map((h) => h.blocks.length)).toEqual([1, 1]);
  });
});
