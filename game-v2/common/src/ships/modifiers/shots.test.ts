/**
 * Weapon modifiers down the shot pipeline, on real parts (the ports rig of power/portsMods.test.ts: a line W to E along
 * y = -2, the modifier block above its mount): the gun step's shot carries its effects' mask, a volley built from a
 * record with that mask is the one fired (a split's shell count and shares too), a Rapid gun comes round sooner, and a
 * ship without modifiers fires exactly what it did.
 */
import { describe, it, expect } from 'vitest';
import type { Blueprint, PlacedPart, Rot, Side } from '../types.js';
import { createShipState, type ShipState } from '../state.js';
import type { Charge } from '../energy.js';
import { stepGuns, gunInterval } from '../guns.js';
import { fireVolley, rebuildVolley, shipGunDef, shipGunFx, gunCode, gunCodeFx, gunCodePlace, gunCodePart, gunCodeAmmo, gunCodeAug, shellGunCode, burstShareOf, partWeaponDef } from '../launch.js';
import { gunShell, shellAmount } from '../hitRules.js';
import { createPortsState } from '../power/ports.js';
import { catalog, tuning } from '../power/testData.js';
import { FX_STEPS, rapidRate } from './types.js';
import { fxMarks } from './fxDef.js';

type Item = [key: string, fn: string, x: number, y: number, extra?: Partial<PlacedPart>];
const R = { rot: 1 as Rot }, RM = { rot: 1 as Rot, flip: true }, E = { facing: 'E' as Side };
const mt = tuning.modifiers!;
const UP = -Math.PI / 2;
const pose = { x: 100, y: -40, angle: UP, vx: 3, vy: -1 };

function ship(items: Item[]): { s: ShipState; gun: number; charge: Charge } {
  const part = (uid: number, fn: string, x: number, y: number, extra: Partial<PlacedPart> = {}): PlacedPart => {
    const def = catalog.functions.get(fn), piece = fn === 'core' ? 'rect2' : Array.isArray(def?.pieces) ? def.pieces[0] : 'sq';
    return { uid, piece, fn, material: def?.material ?? 'alloy', x, y, rot: 0 as Rot, flip: false, ...extra };
  };
  const parts = [part(0, 'core', 0, 0), ...items.map(([, fn, x, y, extra], i) => part(i + 1, fn, x, y, extra))];
  const taken = new Set(items.filter((q) => q[3] === -1).map((q) => q[2]));
  for (let x = -8; x <= 6; x++) if (!taken.has(x)) parts.push(part(parts.length, 'hull', x, -1));
  const b: Blueprint = { name: 'test', catalogVersion: 1, parts };
  const s = createShipState(catalog, tuning, 1, b, 0);
  return { s, gun: 1 + items.findIndex((q) => q[0] === 'gun'), charge: { e: createPortsState(s.derived.ports!) } as Charge };
}
/** A reactor, a Mount with `block` on it, a gun down its line; and the same ship with a plain conduit for the mount */
const modded = (block: string, gun = 'cannon_pip') => ship([['gen', 'power_cell_reactor', -3, -2, R], ['mount', 'mod_mount', -2, -2, RM], ['block', block, -2, -3], ['gun', gun, -1, -2, E]]);
const plain = (gun = 'cannon_pip') => ship([['gen', 'power_cell_reactor', -3, -2, R], ['line', 'power_conduit', -2, -2, R], ['gun', gun, -1, -2, E]]);

/** Hold the trigger from tick 1 until the gun's first shot: the step that fired, and its tick */
function firstShot(r: { s: ShipState; charge: Charge }) {
  const box = { charge: r.charge };
  for (let t = 1; t < 200; t++) {
    const step = stepGuns(r.s, pose, { firing: true, aimWorld: 0, aimDist: 0, energy: box }, t, tuning);
    if (step.shots.length) return { step, t };
  }
  throw new Error('the gun never fired');
}

describe('weapon modifiers: the shot pipeline', () => {
  it('a ship without modifiers fires exactly what it did: no mask anywhere, the same def, the same shells', () => {
    const p = plain();
    expect(p.s.derived.ports!.mod).toBeUndefined();
    const { step, t } = firstShot(p), shot = step.shots[0], w = shot.w;
    expect(shot.fx).toBeUndefined();
    expect('fx' in shot).toBe(false);
    expect(p.s.cooldown[p.gun]).toBe(gunInterval(p.s, w));
    // (a mask means nothing to it: the def is the one it always had, object for object)
    const def = partWeaponDef(tuning, w.kind, p.s.blueprint.parts[w.part], w);
    expect(shipGunDef(tuning, p.s, w)).toEqual(def);
    expect(shipGunDef(tuning, p.s, w, undefined, 5)).toBe(shipGunDef(tuning, p.s, w));
    const rec = { owner: 1, tick: t, part: p.gun, aimQ: shot.aimQ };
    const a = fireVolley(rec, p.s, pose, tuning)!, b = fireVolley({ ...rec, fx: 5 }, p.s, pose, tuning)!;
    expect(b.shells).toEqual(a.shells);
    expect(b.def).toBe(a.def);
    expect(gunShell(tuning, p.s, gunCode(p.gun, 0, false, 5))).toEqual(gunShell(tuning, p.s, p.gun));
    expect(fxMarks(shipGunFx(p.s, p.gun), 5)).toBeUndefined();
    // (and its gun code is the number it always was)
    expect(gunCode(p.gun)).toBe(p.gun);
    expect(gunCode(p.gun, 3, true)).toBe(p.gun + 256 * 3 + 65536);
    expect(shellGunCode(gunCode(p.gun, 3, true), a.def, 2)).toBe(p.gun + 256 * 3 + 65536);
  });

  it('the same ship with a working mount: the shot carries its mask, its shells the effect', () => {
    const m = modded('mod_coil'), p = plain();
    expect(shipGunFx(m.s, m.gun)).toEqual([{ fx: mt.effects.indexOf('velocity'), q: FX_STEPS }]);
    const fm = firstShot(m), fp = firstShot(p);
    expect(fm.step.shots[0].fx).toBe(1);
    const base = fireVolley({ owner: 1, tick: fp.t, part: p.gun, aimQ: fp.step.shots[0].aimQ }, p.s, pose, tuning)!;
    const fast = fireVolley({ owner: 1, tick: fm.t, part: m.gun, aimQ: fm.step.shots[0].aimQ, fx: 1 }, m.s, pose, tuning)!;
    expect(fast.def.speed).toBeCloseTo((base.def.speed ?? 48) * mt.velocity.speed, 9);
    expect(fast.shells).toHaveLength(base.shells.length);
    // (without its mask, the modded ship's volley is the plain gun's: a shot spent with the mount unpowered)
    const off = fireVolley({ owner: 1, tick: fm.t, part: m.gun, aimQ: fm.step.shots[0].aimQ }, m.s, pose, tuning)!;
    expect(off.def).toEqual(base.def);
    expect(off.shells.map((s) => s.life)).toEqual(base.shells.map((s) => s.life));
    expect(fxMarks(shipGunFx(m.s, m.gun), 1)).toEqual([{ fx: mt.effects.indexOf('velocity'), k: 1 }]);
  });

  it('a volley rebuilt from a record with a mask is the one fired: a split\'s shell count, spawn values and shares', () => {
    const m = modded('mod_prism');
    const { step, t } = firstShot(m), shot = step.shots[0];
    expect(shot.fx).toBe(1);
    const fired = fireVolley({ owner: 1, tick: t, part: m.gun, aimQ: shot.aimQ, fx: shot.fx }, m.s, pose, tuning)!;
    expect(fired.shells).toHaveLength(mt.split.shots);
    // (what a fire event's part field carries, and back)
    const code = gunCode(m.gun, 0, false, shot.fx);
    expect([gunCodePart(code), gunCodeAmmo(code), gunCodeAug(code), gunCodeFx(code), gunCodePlace(code)]).toEqual([m.gun, 0, false, 1, 0]);
    const ids = fired.shells.map((_, i) => 9000 + i);
    const back = rebuildVolley({ owner: 1, tick: t, part: gunCodePart(code), aimQ: shot.aimQ, ids, fx: gunCodeFx(code) }, m.s, pose, tuning)!;
    expect(back.def).toBe(fired.def);
    expect(back.shells).toEqual(fired.shells.map((s, i) => ({ ...s, id: ids[i] })));
    // (the mask lost, or the wrong count of ids: not that volley)
    expect(rebuildVolley({ owner: 1, tick: t, part: m.gun, aimQ: shot.aimQ, ids }, m.s, pose, tuning)).toBeNull();
    expect(rebuildVolley({ owner: 1, tick: t, part: m.gun, aimQ: shot.aimQ, ids: [9000], fx: 1 }, m.s, pose, tuning)).toBeNull();
    // A fan about the aim, the middle shell (the last) keeping most of the shot; each shell's gun code says its place,
    // and a hit worked out from it (hitRules gunShell) is that shell's share
    const whole = gunShell(tuning, m.s, m.gun)!;
    let sum = 0;
    for (let i = 0; i < fired.shells.length; i++) {
      const g = shellGunCode(code, fired.def, i);
      expect(gunCodePlace(g)).toBe(i);
      expect(gunCodeFx(g)).toBe(1);
      const sh = gunShell(tuning, m.s, g)!;
      expect(sh.def).toBe(fired.def);
      expect(sh.strength).toBeCloseTo(whole.strength * burstShareOf(fired.def, i), 9);
      sum += shellAmount(sh.def, sh.strength) / shellAmount(whole.def, whole.strength);
    }
    expect(sum).toBeCloseTo(mt.split.total, 6);
    expect(burstShareOf(fired.def, mt.split.shots - 1)).toBeGreaterThan(burstShareOf(fired.def, 0));
  });

  it('a Rapid gun comes round sooner: its interval over the rate, and only while the effect is live', () => {
    const m = modded('mod_resonator'), p = plain();
    const fm = firstShot(m), fp = firstShot(p), w = fm.step.shots[0].w;
    expect(fm.step.shots[0].fx).toBe(1);
    const q = shipGunFx(m.s, m.gun)![0].q, rate = rapidRate(mt, q);
    expect(rate).toBeGreaterThan(1);
    expect(p.s.cooldown[p.gun]).toBe(gunInterval(p.s, fp.step.shots[0].w));
    expect(m.s.cooldown[m.gun]).toBeCloseTo(gunInterval(m.s, w) / rate, 9);
    // (and each shot is the smaller one)
    const small = shipGunDef(tuning, m.s, w, undefined, 1), own = shipGunDef(tuning, m.s, w);
    expect(small.damage).toBeCloseTo(((own.damage ?? 14) * mt.rapid.total) / rate, 9);
  });
});
