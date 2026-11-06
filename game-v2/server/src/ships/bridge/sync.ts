/**
 * ShipBridge sync: the plain readers and writers between a ship's ShipState and the engine's components (body
 * pose, health), the jump fields where it is, Tow Beam glue, and the state the snapshot and keyframes read
 * (charge, beams, heat, shield). ShipBridge keeps one-line delegators with the same names.
 *
 * readBody/writeBody/pose/syncHealth run every tick for every ship: plain functions, no receiver.
 */

import { hasComponent } from 'bitecs';
import {
  Position, Velocity, Rotation, Health, Boost, Player, InSystem,
  coreHp, jumpPhase, jumpTuning, jumpFieldAt, fieldRangeBoost, NO_FIELD, worldToLocalDir, chargeTotal, FULL_CHARGE,
  type ShipState, type Vec2, type FlightBody, type JumpField, type Charge,
} from '@space-game/common';
import type { BridgeCtx } from './core.js';
import { dhypot } from '@space-game/common';

/** A ship's battery charge (energy.ts) */
export function chargeOf(b: BridgeCtx, eid: number): Charge {
  return b.charge.get(eid) ?? FULL_CHARGE;
}

/** Set it (a player's total is mirrored to Boost.fuel, which the HUD's gauge reads) */
export function setCharge(b: BridgeCtx, eid: number, c: Charge): void {
  b.charge.set(eid, c);
  const ship = b.bodies.get(eid);
  if (ship && hasComponent(b.host.world, Player, eid)) Boost.fuel[eid] = chargeTotal(ship.derived, c);
}

/** Weapon beam state for the snapshot */
export function weaponBeamState(b: BridgeCtx, eid: number): { on: boolean; hit: number } {
  const f = b.weaponBeams.get(eid);
  return f === undefined ? { on: false, hit: 1 } : { on: true, hit: f };
}

/** Shield charge 0..1 for the snapshot (0 also without a shield) */
export function shieldFraction(b: BridgeCtx, eid: number): number {
  const ship = b.bodies.get(eid);
  return ship && ship.derived.shieldMax > 0 ? ship.shield / ship.derived.shieldMax : 0;
}

export function beamState(b: BridgeCtx, eid: number): { on: boolean; hit: number } {
  const f = b.beams.get(eid);
  return f === undefined ? { on: false, hit: 1 } : { on: true, hit: f };
}

export function syncHealth(eid: number, ship: ShipState): void {
  const c = coreHp(ship);
  Health.max[eid] = c.max;
  Health.current[eid] = c.hp;
}

export function pose(eid: number) {
  return { x: Position.x[eid], y: Position.y[eid], angle: Rotation.angle[eid] };
}

export function readBody(eid: number, ship: ShipState): FlightBody {
  return { x: Position.x[eid], y: Position.y[eid], vx: Velocity.x[eid], vy: Velocity.y[eid], angle: Rotation.angle[eid], angVel: ship.angVel, jump: ship.jump, jumpScale: ship.jumpScale, jumpAim: ship.jumpAim, jumpTo: ship.jumpTo, cargo: ship.cargo, dodge: ship.dodge, dodgeDir: ship.dodgeDir };
}

/** Jump range multiplier where this ship is (a star's ring, or a lodestone's priming) */
export function jumpBoost(b: BridgeCtx, eid: number): number {
  return fieldRangeBoost(b.fieldAt(eid).ring, b.bodies.get(eid)?.jumpPrime ?? 0, jumpTuning(b.tuning));
}

/** The charging fields where this ship is now */
export function fieldAt(b: BridgeCtx, eid: number): JumpField {
  const env = b.host.jumpFields?.(eid);
  return env ? jumpFieldAt(Position.x[eid], Position.y[eid], env, b.host.getTick(), jumpTuning(b.tuning)) : NO_FIELD;
}

/** For the pilot's snapshot: 1 = in a star's charging ring, 2 = in a lodestone's field (bits), and the priming left */
export function jumpFieldState(b: BridgeCtx, eid: number): { flags: number; prime: number } {
  const f = b.fieldAt(eid);
  return { flags: (f.ring ? 1 : 0) | (f.lodestone ? 2 : 0), prime: b.bodies.get(eid)?.jumpPrime ?? 0 };
}

// ---- Tow Beam (ships/features/tow/Towing.ts; common/src/ships/features/tow/tow.ts)
/** What a Tow Beam can take hold of: debris you can touch, or a derelict wreck (never a working ship); null otherwise */
export function towable(b: BridgeCtx, eid: number): { kind: 'wreck' | 'debris'; mass: number; radius: number } | null {
  const ship = b.bodies.get(eid);
  if (!ship || b.intangible.has(eid) || b.dormant.has(eid) || hasComponent(b.host.world, Player, eid)) return null;
  if (ship.kind === 'debris') return { kind: 'debris', mass: ship.derived.mass, radius: ship.derived.radius };
  if (b.anchored.has(eid)) return { kind: 'wreck', mass: ship.derived.mass, radius: ship.derived.radius };
  return null;
}

/** Towable bodies in a system within `r` of (x, y) */
export function towablesNear(b: BridgeCtx, systemNum: number, x: number, y: number, r: number): number[] {
  const out: number[] = [];
  for (const eid of b.bodies.keys()) {
    if (InSystem.systemId[eid] !== systemNum || !b.towable(eid)) continue;
    if (dhypot(Position.x[eid] - x, Position.y[eid] - y) <= r + b.bodies.get(eid)!.derived.radius) out.push(eid);
  }
  return out;
}

/** Being towed: debris neither crumbles nor goes while a beam holds it */
export function holdTowed(b: BridgeCtx, eid: number): void {
  const ship = b.bodies.get(eid);
  if (!ship || ship.kind !== 'debris') return;
  const tick = b.host.getTick();
  // (Its life is no longer its own: told from now on)
  b.debrisNet.told.add(eid);
  ship.despawnTick = Math.max(ship.despawnTick, tick + 120);
  const at = b.decayAt.get(eid);
  if (at) for (let i = 0; i < at.length; i++) if (ship.hp[i] > 0) at[i] = Math.max(at[i], tick + 120);
}
// ---- (end Tow Beam)

/** Mid-jump (the burn itself): no guns, and the ship passes through other hulls */
export function isJumping(b: BridgeCtx, ship: ShipState): boolean {
  return jumpPhase(ship.jump, jumpTuning(b.tuning)).phase === 'burn';
}

export function writeBody(eid: number, ship: ShipState, b: { x: number; y: number; vx: number; vy: number; angle: number; angVel: number; jump?: number; jumpScale?: number; jumpAim?: number; jumpTo?: number; cargo?: number; dodge?: number; dodgeDir?: number }): void {
  if (b.jump !== undefined) ship.jump = b.jump;
  // (A charging jump's lock: stepFlight sets and clears it, so it's taken as it comes; a body without the key leaves it)
  if ('jumpAim' in b) { ship.jumpAim = b.jumpAim; ship.jumpTo = b.jumpAim === undefined ? undefined : b.jumpTo; }
  // (The Burst Strafer's: stepFlight leaves them absent at 0, so they're taken as they come)
  if ('dodge' in b) { ship.dodge = b.dodge || undefined; ship.dodgeDir = b.dodgeDir || undefined; }
  if (b.jumpScale !== undefined) ship.jumpScale = b.jumpScale;
  if (b.cargo !== undefined) ship.cargo = b.cargo || undefined;
  Position.x[eid] = b.x;
  Position.y[eid] = b.y;
  Velocity.x[eid] = b.vx;
  Velocity.y[eid] = b.vy;
  Rotation.angle[eid] = b.angle;
  ship.angVel = b.angVel;
}

export function worldToGrid(b: BridgeCtx, eid: number, ship: ShipState, x: number, y: number): Vec2 {
  const cs = b.tuning.cellSize;
  const [lx, ly] = worldToLocalDir([x - Position.x[eid], y - Position.y[eid]], Rotation.angle[eid]);
  return [lx / cs + ship.derived.com[0], ly / cs + ship.derived.com[1]];
}
