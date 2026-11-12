/**
 * What a weapon modifier's effects add to a beam's burn (bridge/beamFx.ts), on a real bridge: a pilot and three pirate
 * skiffs in a running server, the functions called as fireBeam calls them (bridge/weapons.ts) with a beam's tuning
 * made by fxDef (common ships/modifiers/fxDef.ts) from tuning.json's own numbers. A beam without effects is left
 * alone; a piercing or wave beam burns the hulls behind for their shares; a blast, arcs and a fire come only from
 * beamEnd, by the damage it is given. A hull behind is struck as the first is (its shaped shield, its armour); a held
 * beam's end goes by what it really burned since its last step; a split beam burns as its fan (fireBeam itself).
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { readFileSync } from 'fs';
import * as bitecs from 'bitecs';
import {
  InSystem, Position, Velocity, Rotation, fxDef, fxTo, arcRadius, FX_STEPS, parseBlueprint, shapedOf, shieldHp, shieldUp, shipPointToWorld,
  type GunFx, type ModifierTuning, type ShipState, type WeaponInfo, type WeaponTuning,
} from '@space-game/common';
import { LocalTransport } from '../../net/LocalTransport.js';
import { MemoryProfileStore } from '../../profile/ProfileStore.js';
import { makeEmptyServer } from '../../testkits/world.testkit.js';
import { feedParts } from '../../../../common/src/ships/testData.js';
import type { BridgeCtx } from './core.js';
import { beamHasFx, beamFirstShare, beamThrough, beamEnd, heldBurn, gunRay, BEAM_STEP, type BeamLine, type BeamStrike } from './beamFx.js';
import { fireBeam } from './weapons.js';

const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const X = 25000, Y = 20000;
/** A plain held beam: nothing of an effect's on it already, and no fading with distance */
const beam: WeaponTuning = { type: 'beam', dps: 60, range: 900, width: 4 };

/**
 * A pilot at (X, Y) and three pirate skiffs in a row east of it (300, 450 and 600 out), on a beam's line from the
 * pilot; what the bridge was asked to do by the pilot is recorded (and still done)
 */
function rig() {
  resetGlobals();
  const server = makeEmptyServer({ profileStore: new MemoryProfileStore() });
  const t = new LocalTransport(server);
  t.connect();
  t.send({ type: 'join', username: 'pilot' } as any);
  const pid = t.getPlayerId();
  const ships = server.getShips()!;
  // (The bridge is its own BridgeCtx: ShipBridge.ctx, core.ts)
  const b = ships as unknown as BridgeCtx;
  const sys = InSystem.systemId[pid];
  const skiffs = [300, 450, 600].map((gap) => server.enemies.spawnPack(sys, { faction: 'pirates', ships: ['pirate_skiff'] }, X + gap, Y)[0]);
  const place = (eid: number, x: number, y: number) => { Position.x[eid] = x; Position.y[eid] = y; Velocity.x[eid] = 0; Velocity.y[eid] = 0; Rotation.angle[eid] = 0; };
  const row = () => { place(pid, X, Y); skiffs.forEach((s, i) => place(s, X + 300 + i * 150, Y)); };
  // (A tick so the skiffs are filed where a beam looks for them, then back where it moved them from)
  row(); server.step(); row();
  for (const s of skiffs) { const sk = ships.get(s)!; sk.shield = 0; for (let i = 0; i < sk.hp.length; i++) sk.hp[i] = sk.maxHp[i]; }

  const hurts: { eid: number; part: number; amount: number }[] = [];
  const blasts: { x: number; y: number; radius: number; damage: number }[] = [];
  const fires: { eid: number; dps: number; ticks: number; part: number }[] = [];
  const arcs: { x: number; y: number; fromX: number; fromY: number; fx?: number }[] = [];
  const told: { eid: number; amount: number }[] = [];
  const any = b as any, hurt = any.hurt.bind(b), splashAt = any.splashAt.bind(b), ignite = any.ignite.bind(b), notify = b.host.notifyDamage.bind(b.host);
  // (A blast's own hurts aren't the beam's: only what is asked for outside one is kept)
  let inBlast = false;
  any.hurt = (eid: number, ship: unknown, part: number, amount: number, src: number, opts?: unknown) => { if (src === pid && !inBlast) hurts.push({ eid, part, amount }); return hurt(eid, ship, part, amount, src, opts); };
  any.splashAt = (s: number, x: number, y: number, radius: number, damage: number, src: number, ...rest: unknown[]) => {
    blasts.push({ x, y, radius, damage });
    inBlast = true;
    try { return splashAt(s, x, y, radius, damage, src, ...rest); } finally { inBlast = false; }
  };
  any.ignite = (eid: number, x: number, y: number, dps: number, ticks: number, radius: number, src: number, hit?: unknown, struck = -1, held = -1) => { fires.push({ eid, dps, ticks, part: struck }); return ignite(eid, x, y, dps, ticks, radius, src, hit, struck, held); };
  // (a beam's fires are lit and told in one: bridge/damage.ts igniteTold)
  const igniteTold = any.igniteTold.bind(b);
  any.igniteTold = (eid: number, x: number, y: number, dps: number, ticks: number, radius: number, src: number, hit?: unknown, struck = -1, held = -1, fire?: unknown) => { fires.push({ eid, dps, ticks, part: struck }); return igniteTold(eid, x, y, dps, ticks, radius, src, hit, struck, held, fire); };
  b.host.arcHop = (_sys, x, y, fromX, fromY, fx) => { arcs.push({ x, y, fromX, fromY, fx }); };
  b.host.notifyDamage = (eid, amount, src, ...rest) => { if (src === pid) told.push({ eid, amount }); return notify(eid, amount, src, ...rest); };

  const ship = ships.get(pid)! as ShipState;
  const w: WeaponInfo = ship.derived.weapons[0];
  const mt: ModifierTuning = ships.tuning.modifiers!;
  /** The beam with these effects live on it, each at its strength step */
  const withFx = (...fx: [string, number][]): WeaponTuning => {
    const list: GunFx[] = fx.map(([name, q]) => ({ fx: mt.effects.indexOf(name), q }));
    return fxDef(beam, mt, list, (1 << list.length) - 1);
  };
  /** The beam's line from the pilot due east, and the first hull on it (the nearest skiff) */
  const line = (def: WeaponTuning): BeamLine => ({ x: X, y: Y, x1: X + def.range!, y1: Y, half: (def.width ?? 0) / 2, range: def.range!, wall: 1 });
  const strike = (l: BeamLine, at = 0): BeamStrike => {
    const eid = skiffs[at], s = ships.get(eid)!, h = (b as any).castShip(eid, s, l.x, l.y, l.x1, l.y1, l.half) as { part: number; t: number } | null;
    if (!h) throw new Error('the beam misses the skiff on its line');
    return { eid, ship: s, part: h.part, t: h.t };
  };
  return { server, b, pid, ship, w, mt, skiffs, place, hurts, blasts, fires, arcs, told, withFx, line, strike };
}

describe('a beam without a modifier', () => {
  it('has nothing here to do: no effects, its first hull takes the whole burn', () => {
    const r = rig();
    expect(beamHasFx(beam)).toBe(false);
    expect(beamFirstShare(beam)).toBe(1);
    // (an effect that only scales the burn or the reach changes the def, and still asks nothing of beamFx)
    for (const name of ['velocity', 'heavy', 'hyper', 'rapid', 'split']) {
      const d = r.withFx([name, FX_STEPS]);
      expect(d, name).not.toBe(beam);
      expect(beamHasFx(d), name).toBe(false);
      expect(beamFirstShare(d), name).toBe(1);
    }
  });

  it('called all the same, it burns nothing past its first hull and sets nothing off where it ends', () => {
    const r = rig(), l = r.line(beam), first = r.strike(l);
    beamThrough(r.b, r.pid, r.ship, r.w, beam, first, 6, l, 10);
    beamEnd(r.b, r.pid, r.ship, r.w, beam, first, 60, 360, l);
    expect(r.hurts).toEqual([]);
    expect(r.blasts).toEqual([]);
    expect(r.fires).toEqual([]);
    expect(r.arcs).toEqual([]);
    expect(r.told).toEqual([]);
  });
});

describe('a piercing beam', () => {
  it('its first hull takes the first share, the hulls behind the later ones, nearest first', () => {
    const r = rig(), def = r.withFx(['pierce', FX_STEPS]), f = r.mt.pierce.fracs;
    expect(beamHasFx(def)).toBe(true);
    expect(def.pierceFracs).toEqual(f);
    expect(beamFirstShare(def)).toBe(f[0]);
    const l = r.line(def), first = r.strike(l);
    beamThrough(r.b, r.pid, r.ship, r.w, def, first, 6, l, 0);
    expect(r.hurts.map((h) => h.eid)).toEqual([r.skiffs[1], r.skiffs[2]]);
    expect(r.hurts[0].amount).toBeCloseTo(6 * f[1], 9);
    expect(r.hurts[1].amount).toBeCloseTo(6 * f[2], 9);
    // (not a tick its damage is told on: nothing told; and nothing of an end's)
    expect(r.told).toEqual([]);
    expect(r.blasts.length + r.fires.length + r.arcs.length).toBe(0);
  });

  it('part way: the shares between none and full, and a told tick tells each hull behind its ten ticks', () => {
    const r = rig(), q = 9, k = q / FX_STEPS, def = r.withFx(['pierce', q]), f = r.mt.pierce.fracs;
    expect(beamFirstShare(def)).toBeCloseTo(1 - (1 - f[0]) * k, 9);
    const l = r.line(def), first = r.strike(l);
    beamThrough(r.b, r.pid, r.ship, r.w, def, first, 6, l, 10);
    expect(r.hurts.map((h) => h.eid)).toEqual([r.skiffs[1], r.skiffs[2]]);
    expect(r.hurts[0].amount).toBeCloseTo(6 * f[1] * k, 9);
    expect(r.hurts[1].amount).toBeCloseTo(6 * f[2] * k, 9);
    // (what a hull is told is what it took, not what was sent: its armour's say is the bridge's)
    expect(r.told.map((n) => n.eid)).toEqual([r.skiffs[1], r.skiffs[2]]);
    for (const n of r.told) expect(n.amount).toBeGreaterThan(0);
  });

  it('stops where rock stops it, and burns nothing when there is no burn', () => {
    const r = rig(), def = r.withFx(['pierce', FX_STEPS]), l = r.line(def), first = r.strike(l);
    // (rock between the second skiff and the third)
    beamThrough(r.b, r.pid, r.ship, r.w, def, first, 6, { ...l, wall: 525 / def.range! }, 0);
    expect(r.hurts.map((h) => h.eid)).toEqual([r.skiffs[1]]);
    r.hurts.length = 0;
    beamThrough(r.b, r.pid, r.ship, r.w, def, first, 0, l, 0);
    expect(r.hurts).toEqual([]);
  });

  it('a wave beam: every hull it crosses for the same share', () => {
    const r = rig(), def = r.withFx(['wave', FX_STEPS]), per = fxTo(r.mt.wave.perTarget, 1);
    expect(beamHasFx(def)).toBe(true);
    expect(beamFirstShare(def)).toBeCloseTo(per, 9);
    const l = r.line(def), first = r.strike(l);
    beamThrough(r.b, r.pid, r.ship, r.w, def, first, 6, l, 0);
    expect(r.hurts.map((h) => h.eid)).toEqual([r.skiffs[1], r.skiffs[2]]);
    for (const h of r.hurts) expect(h.amount).toBeCloseTo(6 * per, 9);
  });
});

describe('where a modified beam ends', () => {
  it('a blast, arcs and a fire come from beamEnd alone: burning on through sets none off', () => {
    const r = rig(), def = r.withFx(['explosive', FX_STEPS], ['chain', FX_STEPS], ['burn', FX_STEPS]);
    expect(beamHasFx(def)).toBe(true);
    expect(def.beamEnd).toBeTruthy();
    // (no pierce on it: its first hull takes all of what explosive leaves its burn)
    expect(beamFirstShare(def)).toBe(1);
    const l = r.line(def), first = r.strike(l);
    beamThrough(r.b, r.pid, r.ship, r.w, def, first, 6, l, 10);
    expect(r.hurts.length + r.blasts.length + r.fires.length + r.arcs.length).toBe(0);
    // (and an end with no damage behind it is no end)
    beamEnd(r.b, r.pid, r.ship, r.w, def, first, 0, 0, l);
    expect(r.blasts.length + r.fires.length + r.arcs.length).toBe(0);
  });

  it('explosive: a blast at the point it struck, its share of the damage given', () => {
    const r = rig(), def = r.withFx(['explosive', FX_STEPS]), l = r.line(def), first = r.strike(l);
    beamEnd(r.b, r.pid, r.ship, r.w, def, first, 10, 60, l);
    beamEnd(r.b, r.pid, r.ship, r.w, def, first, 20, 120, l);
    expect(r.blasts).toHaveLength(2);
    expect(r.blasts[0].x).toBeCloseTo(X + def.range! * first.t, 6);
    expect(r.blasts[0].y).toBeCloseTo(Y, 6);
    expect(r.blasts[0].radius).toBe(r.mt.explosive.radius[1]);
    expect(r.blasts[0].damage).toBeCloseTo(10 * r.mt.explosive.blast, 9);
    expect(r.blasts[1].damage).toBeCloseTo(20 * r.mt.explosive.blast, 9);
    expect(r.fires.length + r.arcs.length).toBe(0);
  });

  it('chain: arcs on to the ships nearest, never back to the first hull, each a share of the last', () => {
    const r = rig(), def = r.withFx(['chain', FX_STEPS]), l = r.line(def), first = r.strike(l);
    const hx = X + def.range! * first.t, c = def.beamEnd!.chain!;
    expect(c.falloff).toBeCloseTo(r.mt.chain.frac, 9);
    // (the other two skiffs drawn up beside where it struck, one beyond the other, within an arc's reach)
    const rad = r.b.bodies.get(r.skiffs[1])!.derived.radius;
    r.place(r.skiffs[1], hx, Y + rad + 10);
    r.place(r.skiffs[2], hx, Y + rad + 10 + 50);
    beamEnd(r.b, r.pid, r.ship, r.w, def, first, 40, 0, l);
    expect(r.arcs).toHaveLength(2);
    expect(r.arcs[0].fromX).toBeCloseTo(hx, 6);
    expect(r.arcs[0].fromY).toBeCloseTo(Y, 6);
    // (each arc leaves from where the last landed, and carries the effect's strength step for the client to draw it by)
    expect([r.arcs[1].fromX, r.arcs[1].fromY]).toEqual([r.arcs[0].x, r.arcs[0].y]);
    for (const a of r.arcs) expect(a.fx).toBe(FX_STEPS);
    expect(r.blasts.map((s) => s.radius)).toEqual([arcRadius(0), arcRadius(0)]);
    expect(r.blasts[0].damage).toBeCloseTo(40 * c.falloff, 9);
    expect(r.blasts[1].damage).toBeCloseTo(40 * c.falloff * c.falloff, 9);
    expect([r.blasts[0].x, r.blasts[0].y]).toEqual([r.arcs[0].x, r.arcs[0].y]);
    // Twice the damage, twice each arc
    r.blasts.length = 0;
    beamEnd(r.b, r.pid, r.ship, r.w, def, first, 80, 0, l);
    expect(r.blasts[0].damage).toBeCloseTo(80 * c.falloff, 9);
    expect(r.fires).toEqual([]);
  });

  it('burn: a pulse\'s fire is its share of the hit over its time; a held beam\'s its share of the burn, for a moment', () => {
    const r = rig(), def = r.withFx(['burn', FX_STEPS]), l = r.line(def), first = r.strike(l), e = def.beamEnd!.burn!;
    expect(e.frac).toBeCloseTo(r.mt.burn.total, 9);
    // A pulse or a zap (no burn a second): the whole hit's share, spread over the effect's time
    beamEnd(r.b, r.pid, r.ship, r.w, def, first, 30, 0, l);
    expect(r.fires).toHaveLength(1);
    expect(r.fires[0]).toMatchObject({ eid: first.eid, part: first.part, ticks: e.ticks });
    expect((r.fires[0].dps * e.ticks) / 60).toBeCloseTo(30 * e.frac, 9);
    // A held beam: its share of the burn a second, lit again each damage step
    beamEnd(r.b, r.pid, r.ship, r.w, def, first, 10, 60, l);
    expect(r.fires[1].dps).toBeCloseTo(60 * e.frac, 9);
    expect(r.fires[1].ticks).toBeLessThan(e.ticks);
    beamEnd(r.b, r.pid, r.ship, r.w, def, first, 20, 120, l);
    expect(r.fires[2].dps).toBeCloseTo(120 * e.frac, 9);
    // (the part it struck is the one alight)
    expect(r.b.burns.some((f) => f.eid === first.eid && f.part === first.part)).toBe(true);
    expect(r.blasts.length + r.arcs.length).toBe(0);
  });
});

describe('a hull behind a piercing beam is struck as the first is', () => {
  it('armour takes the gun\'s armour bonus', () => {
    const r = rig(), def = { ...r.withFx(['pierce', FX_STEPS]), armorBonus: 2 }, f = r.mt.pierce.fracs;
    const l = r.line(def), first = r.strike(l), behind = r.strike(l, 1);
    // (the part of the second skiff the beam meets, made armour for the test, and put back after)
    const bp = behind.ship.blueprint, was = bp.parts[behind.part].fn;
    try {
      beamThrough(r.b, r.pid, r.ship, r.w, def, first, 6, l, 0);
      const plain = r.hurts.find((h) => h.eid === r.skiffs[1])!.amount;
      r.hurts.length = 0;
      behind.ship.blueprint = { ...bp, parts: bp.parts.map((q, i) => (i === behind.part ? { ...q, fn: 'armor' } : q)) };
      beamThrough(r.b, r.pid, r.ship, r.w, def, first, 6, l, 0);
      const armoured = r.hurts.find((h) => h.eid === r.skiffs[1])!;
      expect(armoured.part).toBe(behind.part);
      expect(plain).toBeCloseTo(6 * f[1] * (was === 'armor' ? 2 : 1), 9);
      expect(armoured.amount).toBeCloseTo(6 * f[1] * 2, 9);
    } finally { behind.ship.blueprint = bp; }
  });

  it('a live shaped shield its line crosses takes the burn, and the hull none', () => {
    const r = rig(), def = r.withFx(['pierce', FX_STEPS]), ships = r.server.getShips()!;
    // (the starter with a spark wall at its left, facing the pilot, where the second skiff stood; the skiffs behind moved off the line)
    const dataDir = join(__dirname, '../../../../data');
    const bp = parseBlueprint(readFileSync(join(dataDir, 'ships/blueprints/sparrow-t.json'), 'utf-8'));
    bp.parts.push({ uid: 900, piece: 'sq', fn: 'shield_spark_wall', material: 'alloy', x: -2, y: 0, rot: 0, flip: false, facing: 'W' } as never);
    const e = ships.spawnDummy(feedParts(ships.catalog, bp, [900]), X + 520, Y, 0, InSystem.systemId[r.pid]);
    // (turned so its wall faces the pilot, the wall's row on the beam's line)
    const ship = ships.get(e)!, cs = ships.tuning.cellSize, turn = -Math.PI / 2;
    const dy = shipPointToWorld(ship, { x: X + 520, y: Y, angle: turn }, [ship.derived.com[0], 0.5], cs)[1] - Y;
    const put = () => { r.place(r.pid, X, Y); r.place(r.skiffs[0], X + 300, Y); r.place(r.skiffs[1], X, Y + 3000); r.place(r.skiffs[2], X, Y + 3500); r.place(e, X + 520, Y - dy); Rotation.angle[e] = turn; };
    put(); r.server.step(); put();
    expect(shapedOf(ship)).toHaveLength(1);
    expect(shieldUp(ship, 0)).toBe(true);
    const full = shieldHp(ship, 0), hull = Array.from(ship.hp);
    const l = r.line(def), first = r.strike(l);
    beamThrough(r.b, r.pid, r.ship, r.w, def, first, 6, l, 0);
    expect(r.hurts.map((h) => h.eid)).toEqual([e]);
    expect(shieldHp(ship, 0)).toBeLessThan(full);
    expect(Array.from(ship.hp)).toEqual(hull);
  });
});

describe('a held beam\'s end goes by what it burned', () => {
  it('heldBurn: the burn into one hull since the last step; a new hull or a missed window starts over', () => {
    const r = rig(), key = gunRay(r.pid, 0, 0);
    // (a whole window on one hull: ten ticks' burn at its step)
    let sum = 0;
    for (let t = 11; t <= 20; t++) sum = heldBurn(r.b, key, 7, 1, t, t % BEAM_STEP === 0);
    expect(sum).toBe(10);
    // (on it only for the last four ticks of the next)
    for (let t = 27; t <= 30; t++) sum = heldBurn(r.b, key, 7, 1, t, t % BEAM_STEP === 0);
    expect(sum).toBe(4);
    // (another hull part way: only what the new one took)
    for (let t = 31; t <= 35; t++) heldBurn(r.b, key, 7, 1, t, false);
    for (let t = 36; t <= 40; t++) sum = heldBurn(r.b, key, 8, 1, t, t % BEAM_STEP === 0);
    expect(sum).toBe(5);
    // (off it over a step: the ticks before the gap are not carried into the window after)
    for (let t = 41; t <= 45; t++) heldBurn(r.b, key, 8, 1, t, false);
    for (let t = 58; t <= 60; t++) sum = heldBurn(r.b, key, 8, 1, t, t % BEAM_STEP === 0);
    expect(sum).toBe(3);
    // (and another beam of the gun's fan keeps its own count)
    expect(heldBurn(r.b, gunRay(r.pid, 0, 1), 7, 2, 61, false)).toBe(2);
  });

  it('its fire burns at the beam\'s rate now when lit again, where any other fire keeps the hotter', () => {
    const r = rig(), def = r.withFx(['burn', FX_STEPS]), l = r.line(def), first = r.strike(l), e = def.beamEnd!.burn!, key = gunRay(r.pid, r.w.part, 0);
    const fire = () => r.b.burns.find((f) => f.eid === first.eid && f.part === first.part)!;
    beamEnd(r.b, r.pid, r.ship, r.w, def, first, 20, 120, l, key);
    expect(fire().dps).toBeCloseTo(120 * e.frac, 9);
    // (the beam weaker the next step: its fire with it)
    beamEnd(r.b, r.pid, r.ship, r.w, def, first, 5, 30, l, key);
    expect(fire().dps).toBeCloseTo(30 * e.frac, 9);
    // (a fire of another's on the same part: the hotter of the two, and no longer the beam's own)
    beamEnd(r.b, r.pid, r.ship, r.w, def, first, 20, 120, l);
    beamEnd(r.b, r.pid, r.ship, r.w, def, first, 5, 30, l, key);
    expect(fire().dps).toBeCloseTo(120 * e.frac, 9);
  });

  // (a sharing beam's fire, a roll at each hull it burns: server/src/game/modifierCombos.test.ts)
  it('fireBeam: on its hull for half a window, its fire is half a window\'s', () => {
    const r = rig(), def = r.withFx(['burn', FX_STEPS]), e = def.beamEnd!.burn!;
    let tick = 100;
    r.b.host.getTick = () => tick;
    // (what one tick burns into the first hull, before armour)
    fireBeam(r.b, r.pid, r.ship, r.w, def);
    const one = r.hurts.find((h) => h.eid === r.skiffs[0])!.amount;
    expect(one).toBeGreaterThan(0);
    expect(r.fires).toHaveLength(1);
    // (tick 100 was a step with one tick behind it: one tick's burn over the step)
    expect(r.fires[0].dps).toBeCloseTo(((one * 60) / BEAM_STEP) * e.frac, 6);
    r.fires.length = 0;
    for (tick = 106; tick <= 110; tick++) fireBeam(r.b, r.pid, r.ship, r.w, def);
    expect(r.fires).toHaveLength(1);
    expect(r.fires[0].dps).toBeCloseTo(((one * 5 * 60) / BEAM_STEP) * e.frac, 6);
  });
});

describe('a split beam', () => {
  it('burns as its fan: each beam its own hull, for its share of the burn', () => {
    const r = rig(), def = r.withFx(['split', FX_STEPS]), fan = def.beamFan!;
    expect(fan.off).toHaveLength(r.mt.split.shots);
    expect(fan.share.reduce((a, s) => a + s, 0)).toBeCloseTo(r.mt.split.total, 9);
    let tick = 101;
    r.b.host.getTick = () => tick;
    // (the plain beam's tick into the first skiff, to measure the fan by)
    fireBeam(r.b, r.pid, r.ship, r.w, beam);
    expect(r.hurts.map((h) => h.eid)).toEqual([r.skiffs[0]]);
    const whole = r.hurts[0].amount;
    r.hurts.length = 0;
    // (a skiff on each beam of the fan, far enough out to stand apart)
    const out = 800;
    r.skiffs.forEach((s, i) => r.place(s, X + out * Math.cos(fan.off[i]), Y + out * Math.sin(fan.off[i])));
    r.server.step();
    r.place(r.pid, X, Y);
    r.skiffs.forEach((s, i) => r.place(s, X + out * Math.cos(fan.off[i]), Y + out * Math.sin(fan.off[i])));
    r.hurts.length = 0;
    tick = 101;
    fireBeam(r.b, r.pid, r.ship, r.w, def);
    expect(r.hurts.map((h) => h.eid)).toEqual(r.skiffs);
    r.hurts.forEach((h, i) => expect(h.amount, `beam ${i}`).toBeCloseTo(whole * fan.share[i], 6));
    // (what a role reads as struck: the middle beam's ship)
    expect(r.b.beamStruck).toBe(r.skiffs[1]);
  });
});
