/**
 * ShipBridge damage: how ships take harm and what comes of it. Hits (hurt, damagePartBy, splashAt, blasts), EMP and
 * cold (empUntil, warmth), fire (ignite, stepBurns), nearest-part queries, part hp edits (heal, scale, harden, ghosts),
 * and the end of a hit: partDeaths. ShipBridge keeps one-line delegators with the same names.
 *
 * Modules reach each other through the bridge (b.rebuildNow, b.hurt), never by import, so they can't form a cycle.
 */

import { hasComponent } from 'bitecs';
import {
  Position, Velocity, Player, InSystem, ShipState, Vec2, damagePart, coreHp, healPart, restorePart, hitMultiplier,
  type HitInfo, warmthStage, warmthPercent, insulationOf, THAW, WARMTH_STAGES, type WarmthStage, fartherThan,
  nearestParts, partDistance, standing, stageOf, currentStage, RUIN_HP, seededRng, hashInts, flashRestore,
} from '@space-game/common';
import { GLANCING, STAGE_COVER, EMP_IMMUNE_TICKS, type PendingBlast, type BridgeCtx } from './core.js';

/** Seize a ship up (as an EMP) for `ticks`: hazards' storms */
export function emp(b: BridgeCtx, eid: number, ticks: number): void {
  b.empUntil.set(eid, Math.max(b.empUntil.get(eid) ?? 0, b.host.getTick() + ticks));
}

/** A frost hit landed (a gemmed gun, the Brood Mother's cold): it takes `amount` of warmth, less what the hull keeps out; frozen through, the ship seizes up for `ticks` */
export function frostHit(b: BridgeCtx, eid: number, amount: number, ticks: number): void {
  const ship = b.bodies.get(eid);
  if (!ship || ship.kind !== 'ship') return;
  b.warm(eid, -amount * (1 - insulationOf(ship.derived)), ticks);
}

/** A ship's warmth (0 frozen through .. 1 warm) */
export function warmthOf(b: BridgeCtx, eid: number): number {
  return b.warmth.get(eid) ?? 1;
}

/** Ships that aren't fully warm */
export function chilled(b: BridgeCtx): IterableIterator<number> {
  return b.warmth.keys();
}

/**
 * Change a ship's warmth by `delta`. Reaching 0, it seizes up (as an EMP) for `seizeTicks` and comes out of it
 * with THAW back; not while it's already seized up, nor just after (EMP_IMMUNE_TICKS): it stays at 0 till then.
 */
export function warm(b: BridgeCtx, eid: number, delta: number, seizeTicks: number): void {
  const w = Math.max(0, Math.min(1, b.warmthOf(eid) + delta));
  if (w >= 1) { b.warmth.delete(eid); return; }
  if (w > 0) { b.warmth.set(eid, w); return; }
  const now = b.host.getTick();
  const until = b.empUntil.get(eid) ?? -Infinity;
  if (now < until + EMP_IMMUNE_TICKS) { b.warmth.set(eid, 0); return; }
  b.empUntil.set(eid, now + seizeTicks);
  b.warmth.set(eid, THAW);
}

/** What the cold costs a pilot's ship now (others aren't slowed: the meter only seizes them up) */
export function coldStage(b: BridgeCtx, eid: number): WarmthStage {
  if (!b.warmth.has(eid) || !hasComponent(b.host.world, Player, eid)) return WARMTH_STAGES[0];
  return warmthStage(warmthPercent(b.warmthOf(eid)));
}

/** Hull left, as a fraction of the ship's full HP (every part counted) */
export function integrity(b: BridgeCtx, eid: number): number {
  const ship = b.bodies.get(eid);
  if (!ship) return 0;
  let hp = 0, max = 0;
  ship.maxHp.forEach((m, i) => { max += m; if (!ship.detached[i]) hp += Math.max(0, ship.hp[i]); });
  return max > 0 ? hp / max : 0;
}

/** Mark these parts (uids) as not built yet */
export function setGhosts(b: BridgeCtx, eid: number, uids: number[]): void {
  const ship = b.bodies.get(eid);
  if (!ship) return;
  const want = new Set(uids);
  const set = new Set<number>();
  ship.blueprint.parts.forEach((p, i) => {
    ship.ghost[i] = false;
    if (!want.has(p.uid) || p.fn === 'core') return;
    set.add(i);
    ship.ghost[i] = true;
    ship.hp[i] = 0;
    ship.rebuildHp[i] = 0;
    ship.detached[i] = false;
  });
  if (set.size) b.ghosts.set(eid, set); else b.ghosts.delete(eid);
  b.rebuildNow(eid, ship);
  if (hasComponent(b.host.world, Player, eid)) b.syncHealth(eid, ship);
}

export function isGhost(b: BridgeCtx, eid: number, part: number): boolean {
  return !!b.ghosts.get(eid)?.has(part);
}

/** A ghost part arrived: build it in at full HP */
export function installGhost(b: BridgeCtx, eid: number, uid: number): boolean {
  const ship = b.bodies.get(eid);
  const set = b.ghosts.get(eid);
  if (!ship || !set) return false;
  const i = ship.blueprint.parts.findIndex((p) => p.uid === uid);
  if (i < 0 || !set.has(i)) return false;
  set.delete(i);
  ship.ghost[i] = false;
  restorePart(ship, i, 1);
  ship.rebuildHp[i] = 0;
  return true;
}

/** Make a ship tougher (elite enemies): every part's max HP × k, at full HP */
export function scaleHp(b: BridgeCtx, eid: number, k: number): void {
  const ship = b.bodies.get(eid);
  if (!ship) return;
  ship.maxHp = ship.maxHp.map((h) => h * k);
  ship.hp = [...ship.maxHp];
  ship.rebuildHp = [...ship.hp];
  if (k !== 1) ship.scaledHp = true;
}

/** Toughen one function's parts (a boss's core) by `k` */
export function hardenParts(b: BridgeCtx, eid: number, fn: string, k: number): void {
  const ship = b.bodies.get(eid);
  if (!ship) return;
  ship.blueprint.parts.forEach((p, i) => {
    if (p.fn !== fn) return;
    ship.scaledHp = true;
    ship.maxHp[i] *= k;
    ship.hp[i] = ship.maxHp[i];
    ship.rebuildHp[i] = ship.hp[i];
  });
}

/** Core HP as a fraction of its max (0 when lost) */
export function coreFraction(b: BridgeCtx, eid: number): number {
  const ship = b.bodies.get(eid);
  if (!ship) return 0;
  const c = coreHp(ship);
  return c.max > 0 ? c.hp / c.max : 0;
}

/**
 * Set every part's HP as a fraction of its max (a saved ship coming back).
 * 0 = destroyed. No destruction effects: these parts were lost before.
 */
export function setPartHp(b: BridgeCtx, eid: number, fraction: (uid: number) => number): void {
  const ship = b.bodies.get(eid);
  if (!ship) return;
  ship.blueprint.parts.forEach((p, i) => {
    const f = Math.max(0, Math.min(1, fraction(p.uid)));
    ship.hp[i] = p.fn === 'core' ? Math.max(ship.maxHp[i] * f, ship.maxHp[i] * 0.25) : ship.maxHp[i] * f;
    ship.detached[i] = false;
    ship.rebuildHp[i] = ship.hp[i];
  });
  b.rebuildNow(eid, ship);
  if (hasComponent(b.host.world, Player, eid)) b.syncHealth(eid, ship);
}

/** Heal every intact part by a fraction of its max HP (repair kits) */
export function healAll(b: BridgeCtx, eid: number, fraction: number): void {
  const ship = b.bodies.get(eid);
  if (!ship) return;
  ship.hp.forEach((_, i) => { if (ship.derived.alive[i]) healPart(ship, i, ship.maxHp[i] * fraction, b.tuning); });
  if (ship.dirty) b.rebuildNow(eid, ship);
  if (hasComponent(b.host.world, Player, eid)) b.syncHealth(eid, ship);
}

/** Last tick this body took damage (-Infinity if never) */
/** Who last hit this body (-1: nobody yet) */
export function lastHitter(b: BridgeCtx, eid: number): number {
  return b.lastHitBy.get(eid) ?? -1;
}

export function lastDamagedTick(b: BridgeCtx, eid: number): number {
  return b.lastDamaged.get(eid) ?? -Infinity;
}

/**
 * All weapon and impact damage to a ship part goes through here: the shield
 * soaks it first (and stops recharging for a while), the part takes the rest,
 * as much of it as gets through (`vs.hit`: the weapon's damage type and
 * penetration against the part's armour and material: damage.ts).
 * Returns the damage dealt (shield + hull).
 */
export function hurt(b: BridgeCtx, eid: number, ship: ShipState, part: number, amount: number, source = -1, vs?: { shield?: number; hull?: number; hit?: HitInfo; at?: Vec2; bane?: { faction: string; damage: number } }): number {
  if (amount <= 0 || b.host.invulnerable?.(eid)) return 0;
  const struck = part;
  part = b.cover(ship, part, vs?.at);
  if (part < 0) return 0;
  // (a later stage's part: the plate covering it takes only a share, so the stage being fought is what to aim at)
  if (part !== struck && stageOf(b.catalog, ship, struck) > currentStage(b.catalog, ship)) amount *= b.host.stageCover?.(eid) ?? STAGE_COVER;
  // (ammunition made for one faction's ships: Quench Slugs on the Cinder Cult)
  if (vs?.bane && b.host.baneFaction?.(eid) === vs.bane.faction) amount *= vs.bane.damage;
  const taken = b.host.takenScale?.(eid) ?? 1;
  amount *= taken;
  const tick = b.host.getTick();
  let dealt = 0;
  if (ship.shield > 0 && ship.kind === 'ship' && (vs?.shield ?? 1) > 0) {
    // What it does to shields (× vs.shield), and the rest of the shot goes on to the hull (a torpedo: shields don't stop it)
    const k = vs?.shield ?? 1;
    const soak = Math.min(ship.shield, amount * k);
    ship.shield -= soak;
    amount -= soak / k;
    dealt += soak;
    ship.shieldHitTick = tick;
    // (Surge: broken, a capacitor bank touching a shield generator puts part of it back at once: surge.ts flashRestore)
    if (ship.shield <= 0 && soak > 0) {
      const flash = flashRestore(ship.derived, b.chargeOf(eid), b.tuning);
      if (flash) { ship.shield = flash.restore; b.setCharge(eid, flash.charge); }
    }
  }
  const through = vs?.hit && ship.blueprint.parts[part] ? hitMultiplier(b.catalog, b.tuning, ship.blueprint.parts[part], vs.hit) : 1;
  // (a braced boss shows the hit as glancing: wait for its opening)
  b.lastThrough = through * Math.min(1, taken);
  // (a piece that ruins never breaks: it's left wrecked, RUIN_HP to it)
  const floor = b.catalog.pieces.get(ship.blueprint.parts[part]?.piece)?.ruin ? RUIN_HP : 0;
  if (amount > 0) dealt += damagePart(ship, part, Math.min(amount * (vs?.hull ?? 1) * through, Math.max(0, ship.hp[part] - floor)), b.tuning);
  if (dealt > 0) {
    b.lastDamaged.set(eid, tick);
    if (source >= 0 && source !== eid) b.lastHitBy.set(eid, source);
  }
  return dealt;
}

/** Damage one part from outside the usual weapons (a boss's beam): hurt, and reported as any hit is */
export function damagePartBy(b: BridgeCtx, eid: number, part: number, amount: number, source: number, hit?: HitInfo): number {
  const ship = b.bodies.get(eid);
  if (!ship) return 0;
  const dealt = b.hurt(eid, ship, part, amount, source, hit ? { hit } : undefined);
  if (dealt > 0) b.host.notifyDamage(eid, dealt, source, !!hit && b.lastThrough < GLANCING);
  return dealt;
}

/** Is this ship's electronics knocked out by an EMP? */
export function isEmped(b: BridgeCtx, eid: number): boolean {
  return (b.empUntil.get(eid) ?? -1) > b.host.getTick();
}

/** How many more ticks it stays knocked out (0: it isn't), so the pilot's prediction drifts exactly as long as the server does */
export function empTicksLeft(b: BridgeCtx, eid: number): number {
  return Math.max(0, (b.empUntil.get(eid) ?? 0) - b.host.getTick());
}

/**
 * Splash damage around a point (missiles, flak), falling off with distance.
 * The outer layer shields what's behind it: only the few parts nearest the
 * blast take it, so a buried core survives a burst against the hull.
 */
export function splashAt(b: BridgeCtx, systemNum: number, x: number, y: number, radius: number, damage: number, source: number, hit?: HitInfo): void {
  const reach = Math.max(3, Math.round(radius / b.tuning.cellSize));
  for (const [eid, ship] of b.bodies) {
    // (Out of reach first: the cheapest test, and it rules out most; the rest have no side effects)
    if (eid === source || InSystem.systemId[eid] !== systemNum || fartherThan(Position.x[eid] - x, Position.y[eid] - y, radius + ship.derived.radius)) continue;
    if (b.isJumping(ship) || b.intangible.has(eid) || b.dormant.has(eid)) continue;
    if (source >= 0 && b.host.canDamage && !b.host.canDamage(source, eid)) continue;
    // Each part by how far the blast is from its own outline (not its middle: a boss's great plate is hit where it's struck)
    const cs = b.tuning.cellSize, [gx, gy] = b.worldToGrid(eid, ship, x, y), at: Vec2 = [gx, gy];
    const near = nearestParts(b.geometry(ship), (i) => ship.hp[i] > 0 && !ship.detached[i] && standing(b.catalog, ship, i), gx, gy, radius / cs);
    let dealt = 0, through = 0;
    b.coverMemo = { ship, at, first: 0, best: -1 };
    try {
      for (let k = 0; k < near.length && k < reach; k++) {
        const { i, d } = near[k];
        dealt += b.hurt(eid, ship, i, damage * (1 - 0.7 * ((d * cs) / radius)), source, { hit, at });
        through = Math.max(through, b.lastThrough);
      }
    } finally {
      b.coverMemo = null;
    }
    if (dealt > 0) b.host.notifyDamage(eid, dealt, source, !!hit && through < GLANCING);
  }
  // Single-body enemies (mobs) in reach too
  b.host.splashMobs?.(systemNum, x, y, radius, damage, source);
}

/** An EMP burst: ships in range lose engines and guns for `ticks` (shields halve it) */
export function empAt(b: BridgeCtx, systemNum: number, x: number, y: number, radius: number, ticks: number, source: number): number[] {
  const hit: number[] = [];
  const now = b.host.getTick();
  for (const [eid, ship] of b.bodies) {
    if (InSystem.systemId[eid] !== systemNum || ship.kind !== 'ship' || eid === source || b.dormant.has(eid)) continue;
    if (source >= 0 && b.host.canDamage && !b.host.canDamage(source, eid)) continue;
    if (fartherThan(Position.x[eid] - x, Position.y[eid] - y, radius + ship.derived.radius)) continue;
    // (Its hull in reach, not just its bounding circle)
    if (b.hullDistance(eid, x, y, radius) > radius) continue;
    const t = ship.shield > ship.derived.shieldMax * 0.25 ? Math.round(ticks / 2) : ticks;
    // No stun-lock: a ship that just came out of an EMP shrugs off the next for a moment
    if (!b.isEmped(eid) && now < (b.empUntil.get(eid) ?? -Infinity) + EMP_IMMUNE_TICKS) continue;
    b.empUntil.set(eid, Math.max(b.empUntil.get(eid) ?? 0, now + t));
    ship.shield = Math.max(0, ship.shield - ship.derived.shieldMax * 0.5);
    ship.shieldHitTick = now;
    hit.push(eid);
  }
  return hit;
}

/**
 * Set the part nearest (x, y) burning for `ticks`. Returns the part (or -1).
 * Burning parts take `dps`; when one is gone the fire jumps to a neighbour
 * within `radius` cells.
 */
export function ignite(bridge: BridgeCtx, eid: number, x: number, y: number, dps: number, ticks: number, radius: number, source: number, hit?: HitInfo, struck = -1): number {
  const ship = bridge.bodies.get(eid);
  if (!ship || ship.kind !== 'ship') return -1;
  // The part the shot struck, or the one whose outline is nearest the point
  const part = struck >= 0 && ship.hp[struck] > 0 && !ship.detached[struck] ? struck : bridge.closestPart(eid, ship, x, y);
  if (part < 0) return -1;
  const until = bridge.host.getTick() + ticks;
  const cur = bridge.burns.find((b) => b.eid === eid && b.part === part);
  if (cur) { cur.until = Math.max(cur.until, until); cur.dps = Math.max(cur.dps, dps); }
  else bridge.burns.push({ eid, part, until, dps, radius, source, hit });
  return part;
}

/** Parts on fire now (for the snapshot effects): [body, part] pairs */
export function burning(bridge: BridgeCtx): { eid: number; part: number }[] {
  return bridge.burns.map((b) => ({ eid: b.eid, part: b.part }));
}

/** The intact part whose real outline is nearest a world point (-1: none) */
export function closestPart(b: BridgeCtx, eid: number, ship: ShipState, x: number, y: number): number {
  const [gx, gy] = b.worldToGrid(eid, ship, x, y), geoms = b.geometry(ship);
  let best = -1, bd = Infinity;
  for (let i = 0; i < geoms.length; i++) {
    if (ship.hp[i] <= 0 || ship.detached[i]) continue;
    const d = partDistance(geoms[i], gx, gy, bd);
    if (d < bd) { bd = d; best = i; }
    if (bd === 0) break;
  }
  return best;
}

/**
 * How far a world point is from a ship's hull: its nearest standing part's
 * real outline (0 inside one). Infinity when that's further than `within`
 * (or it has nothing standing). Fuses, EMPs and arcs go by this.
 */
export function hullDistance(b: BridgeCtx, eid: number, x: number, y: number, within = Infinity): number {
  const ship = b.bodies.get(eid);
  if (!ship) return Infinity;
  const cs = b.tuning.cellSize;
  if (Math.hypot(Position.x[eid] - x, Position.y[eid] - y) - ship.derived.radius - cs > within) return Infinity;
  const [gx, gy] = b.worldToGrid(eid, ship, x, y), geoms = b.geometry(ship);
  let bd = within / cs, found = false;
  for (let i = 0; i < geoms.length; i++) {
    // (Its box, then its outline, before the lookups standing makes)
    const d = partDistance(geoms[i], gx, gy, bd);
    if (d > bd || !standing(b.catalog, ship, i)) continue;
    bd = d; found = true;
    if (bd === 0) break;
  }
  return found ? bd * cs : Infinity;
}

/** The middle of the standing part nearest a world point by its outline (where an arc strikes), or null */
export function nearestPartPoint(b: BridgeCtx, eid: number, x: number, y: number): Vec2 | null {
  const ship = b.bodies.get(eid);
  if (!ship) return null;
  const [gx, gy] = b.worldToGrid(eid, ship, x, y), geoms = b.geometry(ship);
  let best = -1, bd = Infinity;
  for (let i = 0; i < geoms.length; i++) {
    const d = partDistance(geoms[i], gx, gy, bd);
    if (d >= bd || !standing(b.catalog, ship, i)) continue;
    bd = d; best = i;
    if (bd === 0) break;
  }
  return best < 0 ? null : b.partWorld(eid, ship, best);
}

/** The part a straight shot from (x0, y0) at a ship's centre strikes first (a station's turret), else the one nearest (x0, y0); -1 if none */
export function partFacing(b: BridgeCtx, eid: number, x0: number, y0: number): number {
  const ship = b.bodies.get(eid);
  if (!ship) return -1;
  const h = b.segmentHit(eid, ship, x0, y0, Position.x[eid], Position.y[eid]);
  return h ? h.part : b.closestPart(eid, ship, x0, y0);
}

export function nearestPart(b: BridgeCtx, eid: number, ship: ShipState, x: number, y: number, exclude = -1): number {
  let best = -1, bd = Infinity;
  ship.hp.forEach((hp, i) => {
    if (hp <= 0 || ship.detached[i] || i === exclude) return;
    const [px, py] = b.partWorld(eid, ship, i);
    const d = Math.hypot(px - x, py - y);
    if (d < bd) { bd = d; best = i; }
  });
  return best;
}

export function stepBurns(bridge: BridgeCtx, tick: number): void {
  const keep: typeof bridge.burns = [];
  for (const b of bridge.burns) {
    const ship = bridge.bodies.get(b.eid);
    if (!ship || tick >= b.until || ship.kind !== 'ship') continue;
    if (ship.hp[b.part] <= 0 || ship.detached[b.part]) {
      // Spread to the nearest part still standing, if it's close enough
      const [px, py] = bridge.partWorld(b.eid, ship, b.part);
      const next = bridge.nearestPart(b.eid, ship, px, py, b.part);
      if (next < 0) continue;
      const [nx, ny] = bridge.partWorld(b.eid, ship, next);
      if (Math.hypot(nx - px, ny - py) > b.radius * bridge.tuning.cellSize * 1.5) continue;
      if (bridge.burns.some((o) => o !== b && o.eid === b.eid && o.part === next)) continue;
      b.part = next;
    }
    const dealt = bridge.hurt(b.eid, ship, b.part, (b.dps * 10) / 60, b.source, b.hit ? { hit: b.hit } : undefined);
    if (dealt > 0 && tick % 30 === 0) bridge.host.notifyDamage(b.eid, dealt * 3, b.source);
    keep.push(b);
  }
  bridge.burns = keep;
}

/**
 * Parts destroyed since the last rebuild: send their effect, and schedule the
 * ones that blow up. Returns whether any were found. Each is marked handled by
 * zeroing its rebuild HP (the rebuild later this tick does that anyway).
 */
export function partDeaths(b: BridgeCtx, eid: number, ship: ShipState, tick: number): boolean {
  let found = false;
  const cs = b.tuning.cellSize;
  const hps = ship.hp;
  for (let i = 0; i < hps.length; i++) {
    if (hps[i] > 0 || !(ship.rebuildHp[i] > 0) || ship.detached[i]) continue;
    found = true;
    ship.rebuildHp[i] = 0;
    const fn = ship.blueprint.parts[i].fn;
    const crumbled = b.crumbled.has(`${eid}:${i}`);
    // (A model's own blast, or none; a legacy part's its function's)
    const fd = b.catalog.functions.get(fn);
    const blast = crumbled ? undefined : fd?.model ? fd.blast : b.tuning.partBlast?.[fn];
    const [x, y] = b.partWorld(eid, ship, i);
    const geom = b.geometry(ship)[i];
    if (ship.blueprint.parts[i].gems?.length) b.host.partLost?.(eid, ship.blueprint.parts[i].uid);
    b.host.notifyPartDestroyed?.({
      systemId: InSystem.systemId[eid], bodyId: eid, part: i, fn,
      how: crumbled ? 'crumble' : blast ? 'blast' : 'break',
      x, y, vx: Velocity.x[eid], vy: Velocity.y[eid],
      size: blast ? blast.radius * cs : Math.sqrt(geom.area) * cs,
    });
    if (!blast) continue;
    const [lo, hi] = blast.delayTicks;
    const delay = lo + Math.floor(seededRng(hashInts(eid, i, tick))() * (hi - lo + 1));
    b.blasts.push({ due: tick + delay, systemId: InSystem.systemId[eid], x, y, radius: blast.radius * cs, damage: blast.damage, source: eid });
  }
  return found;
}

/** Damage every intact part within the blast radius (any body), falling off with distance. */
export function applyBlast(bridge: BridgeCtx, b: PendingBlast): void {
  const tick = bridge.host.getTick();
  for (const [eid, ship] of bridge.bodies) {
    if (InSystem.systemId[eid] !== b.systemId || bridge.intangible.has(eid)) continue;
    if (Math.hypot(Position.x[eid] - b.x, Position.y[eid] - b.y) > b.radius + ship.derived.radius) continue;
    let dealt = 0;
    // (By each part's own outline, as splash goes)
    const cs = bridge.tuning.cellSize, [gx, gy] = bridge.worldToGrid(eid, ship, b.x, b.y);
    for (const { i, d } of nearestParts(bridge.geometry(ship), (i) => ship.hp[i] > 0 && !ship.detached[i], gx, gy, b.radius / cs)) {
      dealt += bridge.hurt(eid, ship, i, b.damage * (1 - (d * cs) / b.radius), bridge.lastHitBy.get(b.source) ?? -1, { at: [gx, gy] });
    }
    if (dealt <= 0) continue;
    bridge.lastDamaged.set(eid, tick);
    // Whoever set off the chain gets the credit
    const by = bridge.lastHitBy.get(b.source);
    if (by !== undefined && eid !== by) bridge.lastHitBy.set(eid, by);
    bridge.host.notifyDamage(eid, dealt, b.source);
  }
}
