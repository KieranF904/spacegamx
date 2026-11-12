/**
 * Weapon modifier effects together (docs/design/weapon-modifiers-2026-11.md, Combos): every hull a shot goes through
 * counts as a hit. On a running server: a pilot, three pirate skiffs in a row on its line of fire and two beside the
 * row for arcs to find; shells fired through game/Weapons.ts as a gun fires them, beams through bridge/weapons.ts
 * fireBeam and bridge/beamFx.ts, their tuning made by fxDef from tuning.json's own numbers.
 *   - a sharing shell or beam with a blast: one where it goes into each hull, of that hull's share, and one where it
 *     comes out (told with `out`); its fire on every hull, as hot as that hull's share against the first's, and on a
 *     few layers of parts along its line into each; its arcs from each hull, never to a ship struck
 *   - Burn with the others: a split's shells each light what they hit, cooler; a blast lights parts it reaches; an
 *     arc lights what it strikes
 *   - every pair of pierce, wave, explosive, burn, chain and split does something neither does alone
 *   - a Prism's shards carry its gun's effects (not rapid, not split), and break out once
 *   - a gun without modifiers says and does what it always did
 */
import { describe, it, expect } from 'vitest';
import * as bitecs from 'bitecs';
import {
  InSystem, Position, Velocity, Rotation, fxDef, passShare, hitEndFx, FX_STEPS, dhypot,
  type GunFx, type ModifierTuning, type ServerMessage, type ShipState, type WeaponInfo, type WeaponTuning,
} from '@space-game/common';
import { LocalTransport } from '../net/LocalTransport.js';
import { MemoryProfileStore } from '../profile/ProfileStore.js';
import { makeEmptyServer } from '../testkits/world.testkit.js';
import type { BridgeCtx } from '../ships/bridge/core.js';
import { beamThrough, beamEnd, BEAM_STEP, type BeamLine, type BeamStrike } from '../ships/bridge/beamFx.js';
import { fireBeam, beamFrom } from '../ships/bridge/weapons.js';

const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const X = 25000, Y = 20000;
/** Shells fired this light: nothing on the row dies of a test */
const SCALE = 0.05;
const beam: WeaponTuning = { type: 'beam', dps: 60, range: 3000, width: 4 };
/** How far beside the row its two neighbours sit: clear of anything fired along it, within an arc's reach of where a shot goes into the hull next to them */
const BESIDE = 90;
const PAIRED = ['pierce', 'wave', 'explosive', 'burn', 'chain', 'split'];
type Fx = [string, number][];
const full = (...names: string[]): Fx => names.map((n) => [n, FX_STEPS]);

/**
 * The pilot at (X, Y) facing east; skiffs 0..2 in a row east of it, too far apart for an arc to leap along the row;
 * skiff 3 beside the first and skiff 4 beside the last, each within an arc's reach of its neighbour only
 */
function rig() {
  resetGlobals();
  const server = makeEmptyServer({ profileStore: new MemoryProfileStore() });
  const t = new LocalTransport(server);
  t.connect();
  t.send({ type: 'join', username: 'pilot' } as any);
  const pid = t.getPlayerId();
  const ships = server.getShips()!;
  const b = ships as unknown as BridgeCtx, any = b as any;
  const sys = InSystem.systemId[pid];
  const skiffs = [0, 1, 2, 3, 4].map((i) => server.enemies.spawnPack(sys, { faction: 'pirates', ships: ['pirate_skiff'] }, X + 300 + i * 400, Y)[0]);
  // (the row spaced by an arc's reach, tuning.json modifiers.chain: no arc leaps along it, whatever that reach is)
  const R = ships.get(skiffs[0])!.derived.radius, gap = 2 * R + ships.tuning.modifiers!.chain.reach + 80;
  const spots: [number, number][] = [[X + 300, Y], [X + 300 + gap, Y], [X + 300 + 2 * gap, Y], [X + 300, Y + BESIDE], [X + 300 + 2 * gap, Y + BESIDE]];
  const place = (eid: number, x: number, y: number) => { Position.x[eid] = x; Position.y[eid] = y; Velocity.x[eid] = 0; Velocity.y[eid] = 0; Rotation.angle[eid] = 0; };
  const mend = (eid: number) => { const s = ships.get(eid)!; s.shield = 0; for (let i = 0; i < s.hp.length; i++) s.hp[i] = s.maxHp[i]; };
  const hold = () => { place(pid, X, Y); skiffs.forEach((s, i) => place(s, spots[i][0], spots[i][1])); };
  hold(); server.step(); hold();

  const blasts: { x: number; y: number; radius: number; damage: number }[] = [];
  /** Every fire lit: a shell's own on the part it struck (`gen` 0), and each one told (a layer's, a blast's, an arc's, a beam's: 1; one that spread or burned on: 2 and up) */
  const fires: { eid: number; part: number; dps: number; ticks: number; tick: number; gen: number }[] = [];
  const arcTo: number[] = [];
  const arcs: { fromX: number; fromY: number }[] = [];
  const msgs: ServerMessage[] = [];
  const hits: { proj: number; eid: number; tick: number }[] = [];
  const spawns: { kind: string; shape: any; eid: number }[] = [];
  const beamBlasts: { x: number; y: number; radius: number; kind: string; out?: number }[] = [];
  const hurts: { eid: number; amount: number }[] = [];
  let tick: number | null = null;
  const now = () => tick ?? server.currentTick;
  b.host.getTick = now;
  const splashAt = any.splashAt.bind(b), ignite = any.ignite.bind(b), nearest = any.nearestTarget.bind(b), hurt = any.hurt.bind(b);
  let inBlast = false, arcing = false;
  any.hurt = (eid: number, ship: unknown, part: number, amount: number, src: number, opts?: unknown) => { if (src === pid && !inBlast) hurts.push({ eid, amount }); return hurt(eid, ship, part, amount, src, opts); };
  any.splashAt = (s: number, x: number, y: number, radius: number, damage: number, src: number, ...rest: unknown[]) => {
    // (an arc's small burst is counted with the arcs)
    if (src === pid && !arcing) blasts.push({ x, y, radius, damage });
    arcing = false;
    inBlast = true;
    try { return splashAt(s, x, y, radius, damage, src, ...rest); } finally { inBlast = false; }
  };
  any.ignite = (eid: number, x: number, y: number, dps: number, ticks: number, radius: number, src: number, ...rest: unknown[]) => { const part = ignite(eid, x, y, dps, ticks, radius, src, ...rest); if (src === pid && part >= 0) fires.push({ eid, part, dps, ticks, tick: now(), gen: 0 }); return part; };
  b.host.fireLit = (eid, part, ticks, gen) => { const f = b.burns.find((o) => o.eid === eid && o.part === part); if (f && f.source === pid) fires.push({ eid, part, dps: f.dps, ticks, tick: now(), gen: gen ?? 1 }); };
  any.nearestTarget = (from: number, x: number, y: number, radius: number, ok: unknown, hull: unknown) => {
    const n = nearest(from, x, y, radius, ok, hull);
    if (from === pid && n >= 0) { arcTo.push(n); arcs.push({ fromX: x, fromY: y }); arcing = true; }
    return n;
  };
  b.host.beamBlast = (_s, x, y, radius, kind, out) => { beamBlasts.push({ x, y, radius, kind, ...(out !== undefined ? { out } : {}) }); };
  b.host.arcHop = () => {};
  const weapons = server.weapons as any, wh = weapons.host, broadcast = wh.broadcast.bind(wh), hitFx = wh.hitFx?.bind(wh);
  const keep = (m: ServerMessage) => { if (m.type === 'detonation' || m.type === 'ignite') msgs.push(m); };
  wh.broadcast = (s: number, m: ServerMessage) => { keep(m); return broadcast(s, m); };
  wh.hitFx = (proj: number, m: ServerMessage) => { keep(m); return hitFx ? hitFx(proj, m) : false; };
  const onShipHit = weapons.onShipHit.bind(weapons), spawn = weapons.spawn.bind(weapons);
  const mine = new Set<number>();
  weapons.onShipHit = (proj: number, hit: { eid: number }) => { if (mine.has(proj)) hits.push({ proj, eid: hit.eid, tick: server.currentTick }); return onShipHit(proj, hit); };
  weapons.spawn = (owner: number, kind: string, x: number, y: number, angle: number, scale: number, shape: unknown, out?: number[]) => {
    const eid = spawn(owner, kind, x, y, angle, scale, shape, out);
    if (owner === pid) { mine.add(eid); spawns.push({ kind, shape, eid }); }
    return eid;
  };

  const ship = ships.get(pid)! as ShipState;
  const w: WeaponInfo = ship.derived.weapons[0];
  const mt: ModifierTuning = ships.tuning.modifiers!;
  const list = (fx: Fx): GunFx[] => fx.map(([name, q]) => ({ fx: mt.effects.indexOf(name), q }));
  const reset = () => {
    hold();
    for (const s of skiffs) mend(s);
    mend(pid);
    b.burns.length = 0;
    b.beamBurns.clear();
    for (const a of [blasts, fires, arcTo, arcs, msgs, hits, spawns, beamBlasts, hurts]) a.length = 0;
    mine.clear();
  };
  /** What the row lost, a skiff at a time (to a hundredth) */
  const lost = () => skiffs.map((s) => { const k = ships.get(s)!; let d = 0; for (let i = 0; i < k.hp.length; i++) d += k.maxHp[i] - k.hp[i]; return Math.round(d * 100); });

  /** One shot of `kind` with these effects, due east along the row, after `wait` idle ticks; flown for `ticks` */
  const shoot = (fx: Fx, kind = 'cannon', wait = 0, ticks = 70) => {
    tick = null;
    for (let i = 0; i < wait; i++) { hold(); mend(pid); server.step(); }
    reset();
    const gunFx = list(fx), ids: number[] = [];
    weapons.spawn(pid, kind, X + 60, Y, 0, SCALE, fx.length ? { speedScale: 1, sizeScale: 1, turret: false, gunFx, fx: (1 << gunFx.length) - 1, seed: 'combo' } : { speedScale: 1, sizeScale: 1, turret: false, seed: 'combo' }, ids);
    // (a lone shell dead along the row, whatever its spread)
    if (ids.length === 1) { Velocity.x[ids[0]] = dhypot(Velocity.x[ids[0]], Velocity.y[ids[0]]); Velocity.y[ids[0]] = 0; }
    const def: WeaponTuning = weapons.extras.get(ids[ids.length - 1])?.def ?? weapons.def(kind);
    for (let i = 0; i < ticks; i++) { hold(); mend(pid); server.step(); }
    return { def, ids, shells: ids.length };
  };
  const beamOf = (fx: Fx): WeaponTuning => { const l = list(fx); return fxDef(beam, mt, l, (1 << l.length) - 1); };
  const line = (def: WeaponTuning): BeamLine => ({ x: X, y: Y, x1: X + def.range!, y1: Y, half: (def.width ?? 0) / 2, range: def.range!, wall: 1 });
  const strike = (l: BeamLine, at = 0): BeamStrike => {
    const eid = skiffs[at], s = ships.get(eid)!, h = any.castShip(eid, s, l.x, l.y, l.x1, l.y1, l.half) as { part: number; t: number } | null;
    if (!h) throw new Error('the beam misses the skiff on its line');
    return { eid, ship: s, part: h.part, t: h.t };
  };
  /** A held beam with these effects, fired for the ten ticks up to a damage step */
  const burn = (fx: Fx, from = 101) => {
    reset();
    const def = beamOf(fx);
    // (the pilot moved so its gun's muzzle, not its middle, is on the row's line)
    Position.y[pid] -= beamFrom(b, pid, ship, w).y - Y;
    for (tick = from; tick <= from + BEAM_STEP - 1; tick++) fireBeam(b, pid, ship, w, def);
    tick = null;
    return def;
  };
  const setTick = (n: number | null) => { tick = n; };
  /** Everything a shot did, as one string: two that differ did something different */
  const sig = (shells = 1) => JSON.stringify({
    shells, lost: lost(), blasts: blasts.map((s) => [Math.round(s.x), s.radius, Math.round(s.damage * 1e4)]), fires: fires.filter((f) => f.gen <= 1).map((f) => [f.eid, f.part, Math.round(f.dps * 1e4)]),
    arcs: arcTo.slice(), out: msgs.filter((m) => m.type === 'detonation' && m.out !== undefined).length + beamBlasts.length,
  });
  return { server, b, pid, ship, w, mt, skiffs, spots, R, weapons, blasts, fires, arcTo, arcs, msgs, hits, spawns, beamBlasts, hurts, reset, shoot, beamOf, line, strike, burn, setTick, sig, lost, list };
}

type Rig = ReturnType<typeof rig>;
/** The fire a shell lit on the part it struck */
const own0 = (r: Rig) => r.fires.find((f) => f.gen === 0)!;
const dets = (r: Rig) => r.msgs.filter((m): m is Extract<ServerMessage, { type: 'detonation' }> => m.type === 'detonation');

describe('a sharing shell: every hull it goes through is a hit', () => {
  it('pierce + explosive: a blast where it goes into each hull and one where it comes out, each of that hull\'s share', () => {
    const r = rig(), { def } = r.shoot(full('pierce', 'explosive'));
    const sp = def.splash!;
    expect(def.pierceFracs).toBeTruthy();
    expect(r.hits.map((h) => h.eid)).toEqual(r.skiffs.slice(0, 3));
    const d = dets(r).filter((m) => m.kind === 'cannon');
    const ins = d.filter((m) => m.out === undefined), outs = d.filter((m) => m.out !== undefined);
    // (three hulls, the shell alive past the last of them: three entries, three exits, due east)
    expect(ins).toHaveLength(3);
    expect(outs).toHaveLength(3);
    for (const m of d) expect(m.radius).toBe(sp.radius);
    for (const m of outs) expect(m.out).toBe(0);
    for (let i = 0; i < 3; i++) {
      expect(outs[i].x).toBeGreaterThan(ins[i].x);
      expect(outs[i].x).toBeLessThanOrEqual(Math.round(r.spots[i][0] + r.R + 2));
      if (i) expect(ins[i].x).toBeGreaterThan(outs[i - 1].x);
    }
    // (each blast its hull's share of the shell's, the radius unchanged: in, out, in, out, ...)
    expect(r.blasts).toHaveLength(6);
    r.blasts.sort((p, q) => p.x - q.x);
    for (let i = 0; i < 6; i++) {
      expect(r.blasts[i].radius).toBe(sp.radius);
      expect(r.blasts[i].damage).toBeCloseTo(sp.damage * SCALE * passShare(def, i >> 1), 9);
    }
    expect(passShare(def, 0)).toBeGreaterThan(passShare(def, 1));
  });

  it('the blast where it comes out waits for the shell to get there: inside the first hull, only the one where it went in', () => {
    const r = rig();
    // (five ticks: into the first hull, not yet out of it)
    r.shoot(full('pierce', 'explosive'), 'cannon', 0, 5);
    expect(r.hits).toHaveLength(1);
    expect(dets(r).filter((m) => m.out === undefined)).toHaveLength(1);
    expect(dets(r).filter((m) => m.out !== undefined)).toHaveLength(0);
    expect(r.blasts).toHaveLength(1);
  });

  it('pierce + burn: every hull it goes through burns, the first at full heat and the rest by their share, a few layers deep along its line', () => {
    const r = rig();
    const alone = r.shoot(full('burn'));
    // (alone: the one part it struck on the one hull, and nothing behind it)
    expect(r.fires.filter((f) => f.gen <= 1)).toHaveLength(1);
    expect(r.fires[0]).toMatchObject({ eid: r.skiffs[0], gen: 0, ticks: alone.def.ignite!.ticks });
    expect(r.fires[0].dps).toBeCloseTo(alone.def.ignite!.dps * SCALE, 9);
    expect(alone.def.ignite!.layers).toBeUndefined();
    const { def } = r.shoot(full('pierce', 'burn')), ig = def.ignite!;
    expect(ig.layers).toBe(r.mt.burn.layers);
    expect(r.hits.map((h) => h.eid)).toEqual(r.skiffs.slice(0, 3));
    let deep = 0;
    r.hits.forEach((h, i) => {
      const lit = r.fires.filter((f) => f.eid === h.eid && f.gen <= 1);
      // (no dice: every hull lights, the struck part first, then the parts behind it, each one cooler)
      const heat = ig.dps * SCALE * (passShare(def, i) / passShare(def, 0));
      expect(lit.length, `hull ${i}`).toBeGreaterThanOrEqual(1);
      expect(lit.length, `hull ${i}`).toBeLessThanOrEqual(ig.layers!);
      expect(new Set(lit.map((f) => f.part)).size).toBe(lit.length);
      lit.forEach((f, k) => { expect(f.dps, `hull ${i} layer ${k}`).toBeCloseTo(heat * Math.pow(ig.layerKeep!, k), 9); expect(f.ticks).toBe(ig.ticks); });
      deep += lit.length - 1;
    });
    expect(deep).toBeGreaterThan(0);
    // (a hull behind burns cooler than the first: a weaker fire, never a missed one)
    expect(passShare(def, 1)).toBeLessThan(passShare(def, 0));
    // The same shot again lights the same parts: nothing of it is left to chance
    const first = r.fires.filter((f) => f.gen <= 1).map((f) => [f.eid, f.part, Math.round(f.dps * 1e6)]);
    r.shoot(full('pierce', 'burn'), 'cannon', 3);
    expect(r.fires.filter((f) => f.gen <= 1).map((f) => [f.eid, f.part, Math.round(f.dps * 1e6)])).toEqual(first);
  });

  it('split + burn: every shell of the fan lights what it hits, always, each a cooler fire of its share', () => {
    const r = rig();
    const alone = r.shoot(full('burn')), whole = alone.def.ignite!.dps * SCALE;
    const { shells } = r.shoot(full('split', 'burn'));
    expect(shells).toBe(r.mt.split.shots);
    const own = r.fires.filter((f) => f.gen === 0);
    // (each shell that hit lit a fire, and no shell's is as hot as the whole shot's)
    expect(r.hits.length).toBeGreaterThanOrEqual(2);
    expect(own).toHaveLength(r.hits.length);
    for (const f of own) { expect(f.dps).toBeGreaterThan(0); expect(f.dps).toBeLessThan(whole); }
  });

  it('explosive + burn: parts the blast reaches may catch, a cooler fire, no more than its cap a blast', () => {
    const r = rig();
    let caught = 0;
    for (let wait = 0; wait < 6; wait++) {
      const { def } = r.shoot(full('explosive', 'burn'), 'cannon', wait), ig = def.ignite!;
      expect(ig.blast).toEqual({ chance: r.mt.burn.blast.chance, scale: r.mt.burn.blast.scale, max: r.mt.burn.blast.max });
      const own = r.fires.filter((f) => f.gen === 0), blast = r.fires.filter((f) => f.gen === 1 && !(f.eid === own0(r).eid && f.part === own0(r).part));
      expect(own).toHaveLength(1);
      expect(blast.length).toBeLessThanOrEqual(ig.blast!.max);
      for (const f of blast) expect(f.dps).toBeCloseTo(ig.dps * SCALE * ig.blast!.scale, 9);
      caught += blast.length;
    }
    expect(caught).toBeGreaterThan(0);
    // (explosive alone, or burn alone: no part catches from a blast)
    r.shoot(full('burn'));
    expect(r.fires.filter((f) => f.gen === 1)).toEqual([]);
  });

  it('chain + burn: each arc lights what it strikes, as hot as the arc\'s share of the shot', () => {
    const r = rig(), { def } = r.shoot(full('chain', 'burn')), ig = def.ignite!;
    expect(ig.arc).toBe(r.mt.burn.arc);
    expect(r.arcTo).toEqual([r.skiffs[3]]);
    const arc = r.fires.filter((f) => f.eid === r.skiffs[3] && f.gen === 1);
    expect(arc).toHaveLength(1);
    expect(arc[0].dps).toBeCloseTo(ig.dps * SCALE * def.chain!.falloff * ig.arc!, 9);
    expect(r.fires.filter((f) => f.gen === 0)).toHaveLength(1);
  });

  it('pierce + chain: arcs from each hull it goes through, never to a ship that shot has struck', () => {
    const r = rig();
    r.shoot(full('chain'));
    // (alone: it ends in the first hull, and arcs from there to the skiff beside it)
    expect(r.arcTo).toEqual([r.skiffs[3]]);
    r.shoot(full('pierce', 'chain'));
    expect(r.hits.map((h) => h.eid)).toEqual(r.skiffs.slice(0, 3));
    // (from the first hull to its neighbour, from the last to its own: nothing twice, nothing the shell went through)
    expect(r.arcTo).toEqual([r.skiffs[3], r.skiffs[4]]);
    expect(r.arcs[1].fromX).toBeGreaterThan(r.arcs[0].fromX + r.R);
    expect(new Set(r.arcTo).size).toBe(r.arcTo.length);
  });

  it('every pair of pierce, wave, explosive, burn, chain and split does what neither does alone', () => {
    const r = rig();
    const run = (fx: Fx, wait: number) => { const s = r.shoot(fx, 'cannon', wait); return r.sig(s.shells); };
    for (let i = 0; i < PAIRED.length; i++) for (let j = i + 1; j < PAIRED.length; j++) {
      const a = PAIRED[i], c = PAIRED[j];
      // (a blast's fire is a roll by the tick: a pair is tried on a few)
      let differs = false;
      for (let wait = 0; wait < 4 && !differs; wait++) {
        const both = run(full(a, c), wait), one = run(full(a), 0), other = run(full(c), 0);
        differs = both !== one && both !== other;
      }
      expect(differs, `${a} + ${c}`).toBe(true);
    }
  });
});

/** A plain shell through two hulls and into a third told only what hitEndFx says of each (a pass, a pass, its end), with the fields a detonation always had */
function plainPasses(r: Rig, kind: string, def: WeaponTuning): void {
  const pass = hitEndFx(kind, def, false), end = hitEndFx(kind, def, true);
  const want = [pass, pass, end].filter((x) => !!x);
  expect(r.msgs).toHaveLength(want.length);
  r.msgs.forEach((m, i) => {
    expect(Object.keys(m).sort()).toEqual(['kind', 'radius', 'type', 'x', 'y']);
    expect(m).toMatchObject({ type: 'detonation', kind: want[i]!.kind, radius: want[i]!.radius });
  });
  expect(r.blasts).toEqual([]);
  expect(r.fires).toEqual([]);
  expect(r.arcTo).toEqual([]);
}

describe('a gun without modifiers says what it always did', () => {
  it('a plain slug: no detonation, no fire, no blast', () => {
    const r = rig();
    r.shoot([]);
    expect(r.lost()[0]).toBeGreaterThan(0);
    expect(r.msgs).toEqual([]);
    expect(r.blasts).toEqual([]);
    expect(r.fires).toEqual([]);
    expect(r.arcTo).toEqual([]);
  });

  it('a plain shell that keeps its damage through a hull (the Phase Lance): a flash at each pass as ever, no `out`, no blast, no fire', () => {
    const r = rig(), { def } = r.shoot([], 'phase');
    expect(def).toBe(r.weapons.def('phase'));
    expect(def.pierceFracs).toBeUndefined();
    expect(r.hits.map((h) => h.eid)).toEqual(r.skiffs.slice(0, 3));
    expect(hitEndFx('phase', def, false)).toBeTruthy();
    plainPasses(r, 'phase', def);
  });

  it('a plain railgun: through two hulls and into the third, told as ever', () => {
    const r = rig(), { def } = r.shoot([], 'railgun');
    expect(def.pierceFracs).toBeUndefined();
    expect(r.hits.map((h) => h.eid)).toEqual(r.skiffs.slice(0, 3));
    plainPasses(r, 'railgun', def);
  });
});

describe('a Prism\'s shards', () => {
  const shards = (r: Rig) => r.spawns.filter((s) => s.kind === 'prism_shard');

  it('without modifiers: the five it always threw, each the plain shard, asked for as ever', () => {
    const r = rig();
    r.shoot([], 'prism');
    const s = shards(r);
    expect(s).toHaveLength(r.weapons.def('prism').split.count);
    for (const x of s) expect(x.shape).toEqual({ speedScale: 1, sizeScale: 1, turret: false, noBurst: true });
    expect(r.blasts).toEqual([]);
    expect(r.fires).toEqual([]);
  });

  it('with modifiers: each shard carries the gun\'s effects, all but rapid and split', () => {
    const r = rig(), fx = full('explosive', 'burn', 'rapid'), gunFx = r.list(fx);
    const live = new Map<number, WeaponTuning>();
    const spawn = r.weapons.spawn;
    r.weapons.spawn = (...a: unknown[]) => { const eid = spawn(...a); const d = r.weapons.extras.get(eid)?.def; if (d) live.set(eid, d); return eid; };
    r.shoot(fx, 'prism');
    r.weapons.spawn = spawn;
    const s = shards(r), base: WeaponTuning = r.weapons.def('prism_shard');
    expect(s).toHaveLength(r.weapons.def('prism').split.count);
    const want = fxDef(base, r.mt, gunFx, 7, true);
    for (const x of s) {
      expect(x.shape).toMatchObject({ child: true, fx: 7, noBurst: true });
      // (the same cached def for every shard: built once)
      expect(live.get(x.eid)).toBe(live.get(s[0].eid));
    }
    expect(live.get(s[0].eid)).toEqual(want);
    expect(want.splash).toBeTruthy();
    expect(want.ignite).toBeTruthy();
    // (rapid is the gun's cycle: a shard is as heavy as explosive and burn alone leave it)
    expect(want).toEqual(fxDef(base, r.mt, r.list(full('explosive', 'burn')), 3));
    expect(want.damage).not.toBe(fxDef(base, r.mt, gunFx, 7).damage);
    // (and they do it: blasts and fires of the shards' own)
    expect(r.blasts.length).toBeGreaterThan(1);
  });

  it('split on a Prism: more shards from the one bolt, no volley, and the shards do not break again', () => {
    const r = rig(), { shells, def } = r.shoot(full('split'), 'prism');
    expect(shells).toBe(1);
    expect(def.burst ?? 1).toBe(1);
    const n = r.weapons.def('prism').split.count + r.mt.split.shots - 1;
    expect(def.split!.count).toBe(n);
    expect(shards(r)).toHaveLength(n);
    for (const x of shards(r)) expect(r.weapons.extras.get(x.eid)?.def.split ?? fxDef(r.weapons.def('prism_shard'), r.mt, r.list(full('split')), 1, true).split).toBeUndefined();
  });

  it('pierce on a Prism: it breaks once, at the first hull, and its core carries on through the row', () => {
    const r = rig(), { ids } = r.shoot(full('pierce'), 'prism');
    expect(shards(r)).toHaveLength(r.weapons.def('prism').split.count);
    expect(r.hits.filter((h) => h.proj === ids[0]).map((h) => h.eid)).toEqual(r.skiffs.slice(0, 3));
  });
});

describe('a sharing beam: every hull it burns is a hit', () => {
  it('pierce + explosive: a blast into each hull by the burn it took, another out of each it goes right through', () => {
    const r = rig(), def = r.beamOf(full('pierce', 'explosive')), l = r.line(def), first = r.strike(l), e = def.beamEnd!.blast!;
    const more = beamThrough(r.b, r.pid, r.ship, r.w, def, first, 10, l, 0);
    expect(more.map((m) => m.eid)).toEqual([r.skiffs[1], r.skiffs[2]]);
    r.blasts.length = 0;
    const f = def.pierceFracs!;
    beamEnd(r.b, r.pid, r.ship, r.w, def, first, 10 * f[0], 0, l, -1, more);
    const fulls = [10 * f[0], more[0].full, more[1].full];
    expect(more[0].full).toBeCloseTo(10 * f[1], 9);
    // (in and out of each of the three, nearest first)
    expect(r.blasts).toHaveLength(6);
    for (let i = 0; i < 6; i++) {
      expect(r.blasts[i].radius).toBe(e.radius);
      expect(r.blasts[i].damage).toBeCloseTo(fulls[i >> 1] * e.frac, 9);
      if (i) expect(r.blasts[i].x).toBeGreaterThan(r.blasts[i - 1].x);
    }
    // (everyone is told the two later hulls' entries and all three exits: the first end a client draws itself)
    expect(r.beamBlasts.filter((m) => m.out === undefined).map((m) => Math.round(m.x))).toEqual([2, 4].map((i) => Math.round(r.blasts[i].x)));
    expect(r.beamBlasts.filter((m) => m.out !== undefined).map((m) => [Math.round(m.x), m.out])).toEqual([1, 3, 5].map((i) => [Math.round(r.blasts[i].x), 0]));
    for (const m of r.beamBlasts) expect(m).toMatchObject({ radius: e.radius, kind: r.w.kind });
    // Alone, explosive ends at the one hull: one blast, no exit, nothing more to tell
    r.reset();
    const alone = r.beamOf(full('explosive'));
    beamEnd(r.b, r.pid, r.ship, r.w, alone, r.strike(r.line(alone)), 10, 0, r.line(alone));
    expect(r.blasts).toHaveLength(1);
    expect(r.beamBlasts).toEqual([]);
  });

  it('rock before a hull\'s far side: no blast where it would have come out', () => {
    const r = rig(), def = r.beamOf(full('pierce', 'explosive')), l = r.line(def), first = r.strike(l);
    const walled = { ...l, wall: first.t + 2 / def.range! };
    beamEnd(r.b, r.pid, r.ship, r.w, def, first, 10, 0, walled);
    expect(r.blasts).toHaveLength(1);
    expect(r.beamBlasts).toEqual([]);
  });

  it('pierce + chain: arcs from each hull it burns, never to one it burns or one an arc has struck', () => {
    const r = rig(), def = r.beamOf(full('pierce', 'chain')), l = r.line(def), first = r.strike(l);
    const more = beamThrough(r.b, r.pid, r.ship, r.w, def, first, 10, l, 0);
    beamEnd(r.b, r.pid, r.ship, r.w, def, first, 10 * def.pierceFracs![0], 0, l, -1, more);
    expect(r.arcTo).toEqual([r.skiffs[3], r.skiffs[4]]);
    expect(r.arcs[1].fromX).toBeGreaterThan(r.arcs[0].fromX + r.R);
  });

  it('pierce + burn, a pulse: every hull it burns is set alight, the first as hot as an unshared beam\'s, the rest by their share, a few layers deep', () => {
    const r = rig(), def = r.beamOf(full('pierce', 'burn')), l = r.line(def), e = def.beamEnd!.burn!, f = def.pierceFracs!;
    expect(e.layers).toBe(r.mt.burn.layers);
    const first = r.strike(l);
    const more = beamThrough(r.b, r.pid, r.ship, r.w, def, first, 10, l, 0);
    beamEnd(r.b, r.pid, r.ship, r.w, def, first, 10 * f[0], 0, l, -1, more);
    let deep = 0;
    [first, ...more].forEach((m, j) => {
      const lit = r.fires.filter((x) => x.eid === m.eid && x.gen <= 1);
      // (10 was the whole burn: the first hull's fire is `frac` of that again over its time, a deeper hull's by its share against the first's)
      const whole = j ? more[j - 1].full / f[0] : 10;
      expect(lit.length, `hull ${j}`).toBeGreaterThanOrEqual(1);
      expect(lit.length).toBeLessThanOrEqual(e.layers!);
      expect(lit[0].part).toBe(m.part);
      expect(new Set(lit.map((x) => x.part)).size).toBe(lit.length);
      lit.forEach((x, k) => expect((x.dps * e.ticks) / 60, `hull ${j} layer ${k}`).toBeCloseTo(whole * e.frac * Math.pow(e.layerKeep!, k), 6));
      deep += lit.length - 1;
    });
    expect(deep).toBeGreaterThan(0);
    expect(more[0].full / f[0]).toBeLessThan(10);
  });

  it('pierce + burn, held: the layers behind are lit once, on the tick the beam comes onto a hull, not every step', () => {
    const r = rig();
    r.reset();
    const def = r.beamOf(full('pierce', 'burn')), e = def.beamEnd!.burn!;
    Position.y[r.pid] -= beamFrom(r.b, r.pid, r.ship, r.w).y - Y;
    const count = () => r.skiffs.slice(0, 3).map((eid) => r.fires.filter((x) => x.eid === eid && x.gen <= 1 && x.ticks === e.ticks).length);
    // (one damage step: each hull's struck part alight, the beam's own fire, and the parts behind it once)
    for (let tick = 101; tick <= 110; tick++) { r.setTick(tick); fireBeam(r.b, r.pid, r.ship, r.w, def); }
    const once = count();
    expect(once.reduce((p, q) => p + q, 0)).toBeGreaterThan(0);
    for (const n of once) expect(n).toBeLessThanOrEqual(e.layers! - 1);
    // (two more steps without a tick off the row: no layer lit again)
    for (let tick = 111; tick <= 130; tick++) { r.setTick(tick); fireBeam(r.b, r.pid, r.ship, r.w, def); }
    expect(count()).toEqual(once);
    // (every hull's struck part burns for as long as the beam is on it)
    for (const eid of r.skiffs.slice(0, 3)) expect(r.b.burns.some((x) => x.eid === eid && x.held !== undefined)).toBe(true);
    // Off the row for a tick, then on again: it has come onto the hulls anew
    r.setTick(132);
    fireBeam(r.b, r.pid, r.ship, r.w, def);
    for (let tick = 133; tick <= 140; tick++) { r.setTick(tick); fireBeam(r.b, r.pid, r.ship, r.w, def); }
    r.setTick(null);
    expect(count().reduce((p, q) => p + q, 0)).toBeGreaterThan(once.reduce((p, q) => p + q, 0));
  });

  it('split + burn: every beam of the fan lights what it burns, each a cooler fire of its share', () => {
    const r = rig();
    r.burn(full('burn'));
    const whole = Math.max(...r.b.burns.map((x) => x.dps));
    r.burn(full('split', 'burn'));
    const held = r.b.burns.filter((x) => x.held !== undefined);
    expect(held.length).toBeGreaterThanOrEqual(1);
    for (const x of held) { expect(x.dps).toBeGreaterThan(0); expect(x.dps).toBeLessThan(whole); }
  });

  it('explosive + burn and chain + burn: a blast lights parts it reaches, an arc what it strikes', () => {
    const r = rig();
    let caught = 0;
    for (let tick = 300; tick < 306; tick++) {
      r.reset();
      r.setTick(tick);
      const def = r.beamOf(full('explosive', 'burn')), l = r.line(def), first = r.strike(l), e = def.beamEnd!;
      beamEnd(r.b, r.pid, r.ship, r.w, def, first, 10, 0, l);
      const blast = r.fires.filter((x) => x.part !== first.part || x.eid !== first.eid);
      expect(blast.length).toBeLessThanOrEqual(e.burn!.blast!.max);
      for (const x of blast) expect((x.dps * e.burn!.ticks) / 60).toBeCloseTo(10 * e.burn!.frac * e.burn!.blast!.scale, 6);
      caught += blast.length;
    }
    expect(caught).toBeGreaterThan(0);
    r.reset();
    r.setTick(400);
    const def = r.beamOf(full('chain', 'burn')), l = r.line(def), first = r.strike(l), e = def.beamEnd!;
    beamEnd(r.b, r.pid, r.ship, r.w, def, first, 10, 0, l);
    r.setTick(null);
    expect(r.arcTo).toEqual([r.skiffs[3]]);
    const arc = r.fires.filter((x) => x.eid === r.skiffs[3]);
    expect(arc).toHaveLength(1);
    expect((arc[0].dps * e.burn!.ticks) / 60).toBeCloseTo(10 * e.chain!.falloff * e.burn!.frac * e.burn!.arc!, 6);
  });

  it('every pair of pierce, wave, explosive, burn, chain and split does what neither does alone', () => {
    const r = rig();
    const run = (fx: Fx, from: number) => { r.burn(fx, from); return JSON.stringify({ hurts: r.hurts.map((h) => [h.eid, Math.round(h.amount * 1e4)]), s: r.sig() }); };
    for (let i = 0; i < PAIRED.length; i++) for (let j = i + 1; j < PAIRED.length; j++) {
      const a = PAIRED[i], c = PAIRED[j];
      let differs = false;
      for (let from = 101; from < 181 && !differs; from += BEAM_STEP) {
        const both = run(full(a, c), from), one = run(full(a), from), other = run(full(c), from);
        differs = both !== one && both !== other;
      }
      expect(differs, `${a} + ${c}`).toBe(true);
    }
  });
});
