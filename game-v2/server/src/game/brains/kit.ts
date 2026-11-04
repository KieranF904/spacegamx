/**
 * What a boss's brain (bosses.json `brain`) can do: the moves are its own,
 * these are the pieces they're made of. Every attack that hurts is warned of
 * first (telegraphs), so a fight is about reading it and getting out of the
 * way, not about how much hull you brought.
 *
 * A brain flies its ship from the enemy AI's orders (who to fight, where to
 * aim the turrets) and changes what it likes: dashes and charges are impulses
 * (PilotOrders.impulse); a heavy hull turns as its blueprint's `turn` lets it (flight.ts), as every client replays it.
 */

import { Position, Velocity, Rotation, InSystem, ServerMessage, ShipState, shipPointToWorld, localToWorldDir, isRuined, type Vec2, type Terrain, type BodyState, datan2, dcos, dsin } from '@space-game/common';
import type { ShipBridge, PilotOrders } from '../../ships/ShipBridge.js';
import type { Mobs } from '../Mobs.js';

export interface BrainHost {
  tick(): number;
  rng(): number;
  readonly ships: ShipBridge;
  readonly mobs: Mobs | undefined;
  send(systemNum: number, msg: ServerMessage): void;
  /** Fire a shot from the boss (its own volleys): `target`, who a homing one hunts; `speed`, × its usual speed */
  fire(owner: number, kind: string, x: number, y: number, angle: number, damageScale: number, opts?: { target?: number; speed?: number }): void;
  /** A flash where something comes out of its hull */
  launchFx(systemNum: number, x: number, y: number): void;
  /** Living pilots in the boss's system */
  players(systemNum: number): number[];
  /** A surface's rock (its lance stops at it) */
  terrain?(systemNum: number): Terrain | undefined;
  /**
   * A decision its brain took for its body this tick (common bodies/decisions.ts), with the state it leaves: sent to the
   * clients that run the body (server/src/net/decisions). Absent: nobody runs bodies (tests)
   */
  decide?(eid: number, op: number, args: readonly number[], state: BodyState): void;
}

/** A brain's view of its boss right now */
export interface BossView {
  eid: number;
  systemNum: number;
  /** How many phases it's entered (0 at full health) */
  phase: number;
  /** Its damage multiplier (bosses.json damage × rage) */
  damage: number;
  /** How many pilots are fighting it (more come in harder) */
  fighters: number;
  /** Where it holds ground (its lair): it keeps near here, out of the rock round it */
  home: { x: number; y: number };
  /** Its pilots, in slot order: those inside its arena (the dev tools' dummies too); absent, those near it */
  present?: number[];
}

export interface BossBrain {
  /** This tick's orders, from what the enemy AI would do */
  orders(base: PilotOrders | null, ship: ShipState, view: BossView): PilotOrders | null;
  /** It's gone (dead, or reset): tidy up what it launched */
  dispose?(): void;
  /** How whole it is (0..1) for its phases, if not its hull's integrity (what it sheds on purpose isn't damage) */
  integrity?(): number;
  /** (dev) its first `n` shedding steps done now */
  forceShed?(n: number): void;
  /**
   * Nothing under way (no move, no stage being blown away, not dying): it may
   * be put to sleep far from pilots (ships/SimLod.ts) and pick up as it was.
   * Absent: never.
   */
  idle?(): boolean;
  /** It can't be hurt now (between its stages, as it blows the last one away) */
  invulnerable?(): boolean;
  /** What share of a hit it takes now (braced, or laid open): absent, all of it */
  taken?(): number;
  /** What share its weak-point windows let through now (common bosses/windows.ts): absent, all of it */
  windowShare?(): number;
  /** Damage it took (as taken): counted into its window (a crack's bonus follows) */
  landed?(amount: number): void;
  /** What it's doing now, for the dev damage log (its move, or whose personal attack) */
  readonly fight?: { cause: string };
}

/** What the boss tools (game/dev/bossDev.ts) can ask of a brain that has them (StagedBrain) */
export interface BossDevHooks {
  devHold: boolean;
  readonly moveName: string;
  readonly stageNow: number;
  devMoves(): string[];
  devPersonal(): string[];
  devPlay(name: string): void;
  devWindow(name?: string): void;
  devPersonalOn(name: string, target: number): boolean;
  readonly fight: import('./fightRules.js').FightRules;
}

export function devHooks(b: BossBrain | undefined): BossDevHooks | undefined {
  return b && typeof (b as Partial<BossDevHooks>).devPlay === 'function' ? (b as unknown as BossDevHooks) : undefined;
}

/** Parts still on the ship whose function has this ability (bosses' own parts: functions.json `ability`) */
export function partsWith(host: BrainHost, ship: ShipState, ability: string): number[] {
  const out: number[] = [];
  ship.blueprint.parts.forEach((p, i) => {
    // (a wrecked one does nothing: stages.ts)
    if (ship.derived.alive[i] && !isRuined(host.ships.catalog, ship, i) && host.ships.catalog.functions.get(p.fn)?.ability === ability) out.push(i);
  });
  return out;
}

export function pose(eid: number): { x: number; y: number; angle: number } {
  return { x: Position.x[eid], y: Position.y[eid], angle: Rotation.angle[eid] };
}

/** A part's mount (or its middle) in the world, and the way it points */
export function partMount(host: BrainHost, eid: number, ship: ShipState, part: number): { x: number; y: number; dir: number } {
  const g = host.ships.geometry(ship)[part];
  const at: Vec2 = g.mount?.at ?? g.centroid;
  const d: Vec2 = g.mount?.dir ?? [0, -1];
  const p = pose(eid);
  const [x, y] = shipPointToWorld(ship, p, at, host.ships.tuning.cellSize);
  const [dx, dy] = localToWorldDir(d, p.angle);
  return { x, y, dir: datan2(dy, dx) };
}

/** A point on the body in its own frame (world units, nose along +x): what telegraphs and beams ride on */
export function bodyFrame(host: BrainHost, eid: number, ship: ShipState, part: number): { x: number; y: number } {
  const m = partMount(host, eid, ship, part);
  const p = pose(eid);
  const dx = m.x - p.x, dy = m.y - p.y, c = dcos(-p.angle), s = dsin(-p.angle);
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}

export const wrap = (a: number) => {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
};

/** Where a pilot will be in `ticks` (straight on, at the speed they're going) */
export function lead(t: number, ticks: number): { x: number; y: number } {
  return { x: Position.x[t] + Velocity.x[t] * ticks, y: Position.y[t] + Velocity.y[t] * ticks };
}

/**
 * Hurt every pilot's ship within `radius` of a point (a shell coming down):
 * full damage at the middle, half at the edge
 */
export function strike(host: BrainHost, systemNum: number, x: number, y: number, radius: number, damage: number, source: number): void {
  host.ships.splashAt(systemNum, x, y, radius, damage, source);
  void InSystem;
}
