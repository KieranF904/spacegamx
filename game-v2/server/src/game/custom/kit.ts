/**
 * What custom enemies' moves are made of on the server (custom/moves.ts): telegraphs, a beam's burn down a line, a pull
 * on a pilot, a strike, guns between moves. Every attack that hurts is warned of first, as a boss's is (brains/kit.ts).
 */
import { Position, Velocity, Rotation, datan2, dcos, dhypot, dsin, type ServerMessage } from '@space-game/common';
import type { Act } from './types.js';

/** A line drawn from a point along a world angle, for `ticks` (world space: it doesn't turn with the ship) */
export function lineWarn(a: Act, kind: string, x: number, y: number, angle: number, length: number, width: number, ticks: number): void {
  a.host.send?.(a.num, { type: 'bossTelegraph', shape: 'line', kind, x: Math.round(x), y: Math.round(y), angle, length: Math.round(length), width: Math.round(width), ticks });
}

/** A ring round the ship (it moves with it) or round a point in the world */
export function ringWarn(a: Act, kind: string, radius: number, ticks: number, at?: { x: number; y: number }): void {
  const msg: ServerMessage = at
    ? { type: 'bossTelegraph', shape: 'circle', kind, x: Math.round(at.x), y: Math.round(at.y), radius: Math.round(radius), ticks }
    : { type: 'bossTelegraph', shape: 'circle', kind, bodyId: a.eid, x: 0, y: 0, radius: Math.round(radius), ticks };
  a.host.send?.(a.num, msg);
}

/** A beam's look: from a point on the ship along a world angle (drawn on the ship's frame, as a boss's is) */
export function beamFx(a: Act, kind: string, from: { x: number; y: number }, angle: number, length: number, width: number, ticks: number): void {
  const me = poseOf(a.eid), c = dcos(-me.angle), s = dsin(-me.angle), dx = from.x - me.x, dy = from.y - me.y;
  const rel = angle - me.angle;
  a.host.send?.(a.num, { type: 'bossBeam', kind, bodyId: a.eid, x: Math.round(dx * c - dy * s), y: Math.round(dx * s + dy * c), a0: rel, a1: rel, ticks, length: Math.round(length), width: Math.round(width) });
}

/** This tick's burn down a line: the first part of each pilot's ship it crosses takes `damage` (thermal) */
export function burnLine(a: Act, x0: number, y0: number, angle: number, length: number, width: number, damage: number): void {
  const x1 = x0 + dcos(angle) * length, y1 = y0 + dsin(angle) * length, ships = a.host.ships;
  for (const p of victims(a)) {
    const sh = ships.get(p);
    if (!sh) continue;
    const h = ships.segmentHit(p, sh, x0, y0, x1, y1, width / 2);
    if (h) ships.damagePartBy(p, h.part, damage, a.eid, { type: 'thermal', pen: 1.2 });
  }
}

/** The first pilot a line meets (its distance along it), or null */
export function lineFirst(a: Act, x0: number, y0: number, angle: number, length: number, width: number): { who: number; t: number } | null {
  const x1 = x0 + dcos(angle) * length, y1 = y0 + dsin(angle) * length, ships = a.host.ships;
  let best: { who: number; t: number } | null = null;
  for (const p of victims(a)) {
    const sh = ships.get(p);
    const h = sh ? ships.segmentHit(p, sh, x0, y0, x1, y1, width / 2) : null;
    if (h && (!best || h.t < best.t)) best = { who: p, t: h.t };
  }
  return best;
}

/** Pull a ship towards a point: `k` world units a tick at its middle, falling to nothing at `r` (a pilot's: a cause to them) */
export function pullTowards(a: Act, who: number, x: number, y: number, r: number, k: number): void {
  const dx = x - Position.x[who], dy = y - Position.y[who], d = dhypot(dx, dy);
  if (d > r || d < 1) return;
  const f = k * (1 - d / r);
  a.host.ships.push(who, (dx / d) * f, (dy / d) * f);
}

/** Splash at a point, with its look */
export function strikeAt(a: Act, x: number, y: number, radius: number, damage: number, fx = 'eruption'): void {
  a.host.ships.splashAt(a.num, x, y, radius, damage, a.eid);
  if (fx) a.host.send?.(a.num, { type: 'detonation', kind: fx, x: Math.round(x), y: Math.round(y), radius });
}

/** The angle from a point to where a ship will be when a shot `speed` fast gets there */
export function leadAngle(who: number, x: number, y: number, speed: number): number {
  const t = dhypot(Position.x[who] - x, Position.y[who] - y) / Math.max(1, speed);
  return datan2(Position.y[who] + Velocity.y[who] * t - y, Position.x[who] + Velocity.x[who] * t - x);
}

/** A gun on a piece: fires at its target when it's due and in reach (factions.json custom guns) */
export function gun(a: Act, group: string, spread: readonly number[] = [0], speed = 50): void {
  const g = a.live.stats.guns?.[group];
  if (!g || a.d > g.reach || a.now < (a.live.guns[group] ?? 0) || !a.has(group)) return;
  const m = a.at(group);
  if (!m) return;
  a.live.guns[group] = a.now + g.every;
  const aim = leadAngle(a.target, m.x, m.y, speed);
  for (const o of spread) a.host.fire?.(a.eid, g.kind, m.x, m.y, aim + o, g.damage * a.live.dmg);
}

/** Pilots its moves can hurt: its target first, then the rest of the system's (by id) */
function victims(a: Act): number[] {
  const all = a.host.players(a.num).slice().sort((p, q) => p - q);
  return all.includes(a.target) ? [a.target, ...all.filter((p) => p !== a.target)] : all;
}

/** The ship's pose (centre and heading) */
function poseOf(eid: number): { x: number; y: number; angle: number } {
  return { x: Position.x[eid], y: Position.y[eid], angle: Rotation.angle[eid] };
}
