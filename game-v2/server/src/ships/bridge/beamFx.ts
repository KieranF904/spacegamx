/**
 * @contract server.ships.bridge.beam-fx
 * owns:       what a weapon modifier's effects add to a beam's burn (common ships/modifiers/fxDef.ts): the hulls a
 *             piercing or wave beam burns past its first, what happens at every hull it burns (a blast where it goes
 *             in and where it comes out, arcs, a fire by a roll), and the burn a held beam's end goes by (heldBurn,
 *             heldDeep); a split beam's fan is bridge/weapons.ts fireBeam's
 * needs:      BridgeCtx (bridge/core.ts) as a type, bitecs components, @space-game/common
 * invariants: a beam without pierceFracs or beamEnd never gets here (bridge/weapons.ts fireBeam), so a ship without
 *             modifiers burns as it did — server/src/game/beamsPulse.test.ts
 *             a piercing or wave beam's first hull takes the first share and the hulls behind the later ones; a blast,
 *             arcs and a fire come from beamEnd alone, by the damage it is given — server/src/ships/bridge/beamFx.test.ts
 *             a hull behind is struck as the first is: a live shaped shield its line crosses stops it there, armour
 *             takes the gun's armour bonus — server/src/ships/bridge/beamFx.test.ts
 *             a held beam's end goes by the burn its first hull took since the last step, never an assumed ten
 *             ticks; its fire burns at the beam's rate now, not its hottest — server/src/ships/bridge/beamFx.test.ts
 *             every hull a sharing beam burns counts as a hit: each has its own blast, arcs and fire by the burn it
 *             took, a second blast where the beam leaves each hull it goes right through, and no arc goes to a hull
 *             the beam burns or an earlier arc struck — server/src/game/modifierCombos.test.ts
 *             a sharing beam's fire is on every hull it burns, as hot as that hull's share against the first's, and
 *             on `layers` parts along its line into each; a held beam lights the deeper layers once, on the tick it
 *             comes onto the hull, not every step — server/src/game/modifierCombos.test.ts
 *             a Burn modifier's beam with a blast lights parts the blast reaches, and with arcs what each arc
 *             strikes; every fire a beam lights is told to everyone near — server/src/game/burnSpread.test.ts
 *             reads only the def's own fields (tuning.ts pierceFracs, pierce, beamEnd), never an effect's name, and
 *             all damage goes through the bridge (b.hurt, b.splashAt, b.ignite) — untestable: a rule about the code's shape
 * extend:     a new beam effect is a field of beamEnd, set by fxDef and acted on here
 */

import { Position, Rotation, InSystem, weaponHit, shooterGrade, beamFalloff, nearShipSegment, shapedReachWorld, shapedStopAt, exitHeading, MAX_RAYS, type ShipState, type WeaponInfo, type WeaponTuning } from '@space-game/common';
import type { BridgeCtx } from './core.js';

/** Ticks between a held beam's damage steps (its damage told, its end set off: bridge/weapons.ts fireBeam) */
export const BEAM_STEP = 10;

/** A held beam's fire outlasts its last damage step by this (it is lit again each step the beam stays on) */
const HELD_BURN_TICKS = 20;
/** An arc's small burst where it lands (as a Tesla's, bridge/weapons.ts zap) */
const ARC_RADIUS = 30;

/** The first hull a beam burned this tick, `t` of the way along its line */
export interface BeamStrike { eid: number; ship: ShipState; part: number; t: number }
/** A hull behind the first a sharing beam burned: `full`, its burn into it before armour (this tick's; a held beam's since its last step, once heldDeep has counted it) */
export interface DeepStrike extends BeamStrike { full: number }
const NONE: readonly DeepStrike[] = [];

/** One beam of a gun's (a split beam's fan has several: tuning.ts beamFan), as a key for what the bridge keeps of it */
export const gunRay = (eid: number, part: number, ray: number): number => (eid * 1024 + part) * MAX_RAYS + ray;

/** Forget what the bridge keeps of a ship's beams (its ship gone or rebuilt: bridge/rebuild.ts) */
export function dropBeams(b: BridgeCtx, eid: number): void {
  for (let k = gunRay(eid, 0, 0), end = gunRay(eid, 64, 0); k < end; k++) { b.ramps.delete(k); b.beamBurns.delete(k); }
}

/**
 * A held beam's burn into its first hull this tick, counted towards its next damage step: returns what it has burned
 * into that hull since the last step (this tick's too). A tick off the hull burns nothing, another hull starts over,
 * so its end goes by what was really delivered. `step`: this is a step, the count starts again after it
 */
export function heldBurn(b: BridgeCtx, key: number, target: number, burn: number, tick: number, step: boolean): number {
  const span = Math.floor((tick + BEAM_STEP - 1) / BEAM_STEP);
  let r = b.beamBurns.get(key);
  if (!r) b.beamBurns.set(key, (r = { target, span, sum: 0, since: tick, last: tick }));
  else {
    // (`since`: the tick it came onto this hull, what its fire's roll goes by, beamEnd: a tick off it starts another)
    if (r.target !== target || tick - (r.last ?? tick) > 1) r.since = tick;
    if (r.target !== target || r.span !== span) { r.target = target; r.span = span; r.sum = 0; }
    r.last = tick;
  }
  const sum = (r.sum += burn);
  if (step) r.sum = 0;
  return sum;
}

/**
 * The same count for the hulls a held beam burns behind its first (after heldBurn, which keeps the beam's record):
 * each one's `full` becomes what it has taken since the last step, and the tick the beam came onto it is kept
 */
export function heldDeep(b: BridgeCtx, key: number, more: readonly DeepStrike[], tick: number, step: boolean): void {
  const r = b.beamBurns.get(key);
  if (!r || (!more.length && !r.deep)) return;
  const span = Math.floor((tick + BEAM_STEP - 1) / BEAM_STEP), deep = (r.deep ??= new Map());
  for (const m of more) {
    let d = deep.get(m.eid);
    if (!d) deep.set(m.eid, (d = { span, sum: 0, since: tick, last: tick }));
    else {
      if (tick - d.last > 1) d.since = tick;
      if (d.span !== span) { d.span = span; d.sum = 0; }
      d.last = tick;
    }
    m.full = d.sum += m.full;
    if (step) d.sum = 0;
  }
  // (a hull it has left is forgotten at the step)
  if (step) for (const [k, d] of deep) if (d.last !== tick) deep.delete(k);
}

/** A beam's line this tick: muzzle to full reach, half its width, and how far along rock stops it (0..1) */
export interface BeamLine { x: number; y: number; x1: number; y1: number; half: number; range: number; wall: number }

/** Has this beam anything of a weapon modifier's to do (fireBeam asks before it calls anything here)? */
export function beamHasFx(def: WeaponTuning): boolean {
  return !!(def.pierceFracs || def.beamEnd);
}

/** The share of its burn a beam's first hull takes (a piercing or wave beam's: tuning.ts pierceFracs) */
export function beamFirstShare(def: WeaponTuning): number {
  return def.pierceFracs ? def.pierceFracs[0] : 1;
}

/**
 * The hulls a piercing beam burns past its first: up to `def.pierce` more along its line (nearest first, up to where
 * rock stops it), each for its share of `burn` (this tick's damage before any share), faded by its own distance.
 * Each is struck as the first hull is: a live shaped shield its line crosses first takes it, armour the gun's bonus.
 * `tell`: this is a tick its damage is told on (× `told` ticks' worth, as fireBeam tells a held beam's). Returns the
 * hulls it burned, nearest first, for beamEnd (each is a hit of its own there)
 */
export function beamThrough(b: BridgeCtx, eid: number, ship: ShipState, w: WeaponInfo, def: WeaponTuning, first: BeamStrike, burn: number, line: BeamLine, told: number): readonly DeepStrike[] {
  const f = def.pierceFracs, n = def.pierce ?? 0;
  if (!f || n <= 0 || !(burn > 0)) return NONE;
  const sys = InSystem.systemId[eid], { x, y, x1, y1, half } = line, cs = b.tuning.cellSize;
  let more: (BeamStrike & { shield?: number; spill?: boolean })[] | undefined;
  for (const other of b.alongBeam(sys, x, y, x1, y1, half)) {
    const os = b.bodies.get(other);
    if (!os || other === eid || other === first.eid || InSystem.systemId[other] !== sys || b.isJumping(os) || b.intangible.has(other) || b.dormant.has(other)) continue;
    // (as the first hull is found, bridge/weapons.ts fireBeam: a shaped shield may stand past the hull, and stops the beam's centre line)
    const sReach = (def.vsShield ?? 1) > 0 ? shapedReachWorld(os, cs) : 0;
    if (sReach > 0 ? !nearShipSegment(Position.x[other], Position.y[other], Math.max(os.derived.radius, sReach), x, y, x1, y1, half) : !b.nearSegment(other, os, x, y, x1, y1, half)) continue;
    if (b.host.canDamage && !b.host.canDamage(eid, other)) continue;
    const hull = b.castShip(other, os, x, y, x1, y1, half);
    const h = sReach > 0 ? shapedStopAt(os, cs, Position.x[other], Position.y[other], Rotation.angle[other], x, y, x1, y1, hull) ?? hull : hull;
    if (h && h.t > first.t && h.t <= line.wall) (more ??= []).push({ eid: other, ship: os, ...h });
  }
  if (!more) return NONE;
  more.sort((p, q) => p.t - q.t || p.eid - q.eid);
  const out: DeepStrike[] = [];
  const hit = weaponHit(w.kind, def, shooterGrade(b.catalog, ship.blueprint.parts[w.part]));
  for (let i = 0; i < more.length && i < n; i++) {
    const m = more[i], share = f[Math.min(i + 1, f.length - 1)];
    if (!(share > 0)) continue;
    const at = b.worldToGrid(m.eid, m.ship, x + (x1 - x) * m.t, y + (y1 - y) * m.t);
    const armor = m.ship.blueprint.parts[m.part].fn === 'armor' ? def.armorBonus ?? 1 : 1;
    const full = burn * share * beamFalloff(def, m.t * line.range);
    const dealt = b.hurt(m.eid, m.ship, m.part, full * armor, eid, { hit, at, ...(m.shield !== undefined ? { shaped: { i: m.shield, spill: !!m.spill } } : {}) });
    if (dealt > 0 && told > 0) b.host.notifyDamage(m.eid, dealt * told, eid);
    out.push({ eid: m.eid, ship: m.ship, part: m.part, t: m.t, full });
  }
  return out;
}

/** Where a beam comes out of a hull it burned (its line cast back from where it stops): null when it stops inside, or the hull is gone */
function beamExit(b: BridgeCtx, m: BeamStrike, line: BeamLine): [number, number] | null {
  const dx = line.x1 - line.x, dy = line.y1 - line.y;
  const ex = line.x + dx * line.wall, ey = line.y + dy * line.wall, ix = line.x + dx * m.t, iy = line.y + dy * m.t;
  const h = b.castShip(m.eid, m.ship, ex, ey, ix, iy, line.half);
  return h && h.t > 0 && h.t < 1 ? [ex + (ix - ex) * h.t, ey + (iy - ey) * h.t] : null;
}

/**
 * Where a beam ends on a hull, on a damage step (`full`: the step's damage into that hull, its first share of the
 * burn, before armour; `perSec`: its burn a second, 0 for a pulse or a zap, whose `full` is the whole hit): its blast
 * around the point, its arcs on to the ships nearest (each `falloff` of the last), and its fire on the part it struck.
 * `held`: a held beam's key (gunRay): its fire, lit again each step, burns at this step's rate.
 * `more`: the hulls a sharing beam burned behind that one (beamThrough's, each with its own `full`). Every hull is a
 * hit: each has the blast, the arcs and the fire by its own burn, and a second blast where the beam comes out of each
 * hull it goes right through (told to everyone with the first hull's exit and the later hulls' entries, host.beamBlast:
 * a client draws a beam's first end itself). Its fire is on every hull, a deeper hull's as hot as its share against
 * the first's; a Burn modifier's also lights `layers` parts along the line into each hull (a held beam's: once, on the
 * tick it came onto that hull), parts its blast reaches, and what each arc strikes. Every fire is told (igniteTold).
 */
export function beamEnd(b: BridgeCtx, eid: number, ship: ShipState, w: WeaponInfo, def: WeaponTuning, first: BeamStrike, full: number, perSec: number, line: BeamLine, held = -1, more: readonly DeepStrike[] = NONE): void {
  const e = def.beamEnd;
  if (!e || !(full > 0)) return;
  const sys = InSystem.systemId[eid];
  const dx = line.x1 - line.x, dy = line.y1 - line.y;
  const hit = weaponHit(w.kind, def, shooterGrade(b.catalog, ship.blueprint.parts[w.part]));
  const f = def.pierceFracs, through = f ? def.pierce ?? 0 : 0;
  // (A handful of ships, a few times a second: the small list costs nothing. One list for the whole beam: no arc goes
  // to a hull it burns, or back to one an earlier arc struck)
  const struck = e.chain ? [eid, first.eid] : undefined;
  if (struck) for (const m of more) struck.push(m.eid);
  const rec = held >= 0 ? b.beamBurns.get(held) : undefined;
  for (let j = 0; j <= more.length; j++) {
    const m = j ? more[j - 1] : first, d = j ? more[j - 1].full : full;
    if (!(d > 0)) continue;
    const hx = line.x + dx * m.t, hy = line.y + dy * m.t;
    if (e.blast) {
      b.splashAt(sys, hx, hy, e.blast.radius, d * e.blast.frac, eid, hit);
      if (j) b.host.beamBlast?.(sys, hx, hy, e.blast.radius, w.kind);
      const out = j < through ? beamExit(b, m, line) : null;
      if (out) {
        b.splashAt(sys, out[0], out[1], e.blast.radius, d * e.blast.frac, eid, hit);
        b.host.beamBlast?.(sys, out[0], out[1], e.blast.radius, w.kind, exitHeading(dx, dy));
      }
    }
    if (e.chain && struck) {
      let fx = hx, fy = hy, a = d;
      for (let i = 0; i < e.chain.count; i++) {
        const next = b.nearestTarget(eid, fx, fy, e.chain.radius, (o) => !struck.includes(o), true);
        if (next < 0) break;
        struck.push(next);
        a *= e.chain.falloff;
        const p = b.nearestPartPoint(next, fx, fy);
        const tx = p ? p[0] : Position.x[next], ty = p ? p[1] : Position.y[next];
        b.splashAt(sys, tx, ty, ARC_RADIUS, a, eid, hit);
        // (a Burn modifier's arc lights what it strikes, by the arc's share of the burn)
        if (e.burn?.arc) b.igniteTold(next, tx, ty, (perSec > 0 ? a * (perSec / full) * e.burn.frac : (a * e.burn.frac) / (e.burn.ticks / 60)) * e.burn.arc, e.burn.ticks, 0, eid, hit, -1, -1, e.burn.fire);
        b.host.arcHop?.(sys, tx, ty, fx, fy, e.chain.fx);
        fx = tx; fy = ty;
      }
    }
    // (A pulse's or a zap's fire: `frac` of the hit again over its time. A held beam's: `frac` of its burn for as long as it stays on, and a moment after)
    if (e.burn) {
      // (the first hull's as hot as a beam's that shares nothing; a deeper hull's by its burn against the first's)
      const whole = f ? d / (f[0] || 1) : d;
      // (a pulse's by its hit, over its time; a held beam's by its burn a second)
      const once = perSec > 0 ? whole * (perSec / full) * e.burn.frac : (whole * e.burn.frac) / (e.burn.ticks / 60);
      if (perSec > 0) b.igniteTold(m.eid, hx, hy, once, HELD_BURN_TICKS, 0, eid, hit, m.part, held, e.burn.fire);
      else b.igniteTold(m.eid, hx, hy, once, e.burn.ticks, 0, eid, hit, m.part, -1, e.burn.fire);
      // (the layers behind the struck part, along the beam: a held beam's once, when it came onto this hull)
      if ((e.burn.layers ?? 1) > 1) {
        const r = held >= 0 ? (j ? rec?.deep?.get(m.eid) : rec) : undefined;
        if (!r || r.layered !== r.since) {
          if (r) r.layered = r.since;
          b.igniteLayers(m.eid, hx, hy, line.x + dx * line.wall, line.y + dy * line.wall, m.part, e.burn.layers!, e.burn.layerKeep ?? 1, once, e.burn.ticks, 0, eid, hit, e.burn.fire);
        }
      }
      if (e.burn.blast && e.blast) b.blastIgnite(sys, hx, hy, e.blast.radius, e.burn.blast, once * e.burn.blast.scale, e.burn.ticks, eid, hit, e.burn.fire);
    }
  }
}
