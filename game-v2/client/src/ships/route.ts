/**
 * Routes between systems: jump gates (fly in, press X), rifts (fly into
 * them), the way down to a planet's surface (fly close, press X) and the way
 * back up (fly out past the surface's edge), and the same for a pocket (a
 * boss's nest: press X at its way in; fly out past its edge). The shortest route is by hops;
 * each step says where to fly in this system and what happens there.
 *
 * Jobs' arenas aren't on any route: a job sends you there.
 */

import { StarSystemData, planetPosition, moonOffset, pocketsFrom } from '@space-game/common';
import systemsData from '../../../data/systems.json';

const SYSTEMS = (systemsData as { systems: StarSystemData[] }).systems;

export interface RouteStep {
  kind: 'gate' | 'rift' | 'planet' | 'edge';
  /** The system it leads to */
  to: string;
  x: number;
  y: number;
  /** Close enough to act (gates and planets: press X; 0: fly right into it) */
  reach: number;
  /** In words: "gate to Borealis", "down to Terra Nova" */
  label: string;
}

const nameOf = (id: string) => SYSTEMS.find((s) => s.id === id)?.name ?? id;

/** Where each way out of a system leads (positions as of `tick`; `me` picks the nearest edge of a surface) */
function exits(from: string, tick: number, me?: { x: number; y: number }): RouteStep[] {
  const sys = SYSTEMS.find((s) => s.id === from);
  if (!sys) return [];
  const out: RouteStep[] = [];
  for (const g of sys.portals ?? []) out.push({ kind: 'gate', to: g.targetSystem, x: g.position.x, y: g.position.y, reach: 260, label: `gate to ${nameOf(g.targetSystem)}` });
  for (const r of sys.rifts ?? []) out.push({ kind: 'rift', to: r.destination.system, x: r.position.x, y: r.position.y, reach: 0, label: r.label ?? `rift to ${nameOf(r.destination.system)}` });
  for (const s of SYSTEMS) {
    const sd = s.surface;
    if (!sd || sd.of !== from || sd.arena || sd.bastion) continue;
    const planet = sys.planets?.find((p) => p.id === sd.planet);
    if (!planet) continue;
    const p = planetPosition(planet, tick);
    const m = sd.moon !== undefined ? moonOffset(planet, sd.moon, tick) : { x: 0, y: 0 };
    const r = sd.moon !== undefined ? planet.moons?.[sd.moon]?.radius ?? planet.radius : planet.radius;
    out.push({ kind: 'planet', to: s.id, x: p.x + m.x, y: p.y + m.y, reach: r + 700, label: `down to ${s.name}` });
  }
  // Pockets: in at their way in here (press X), out past their edge
  for (const s of pocketsFrom(SYSTEMS, from)) {
    const e = s.pocket!.entrance;
    out.push({ kind: 'planet', to: s.id, x: e.x, y: e.y, reach: e.radius * 0.8, label: `into ${e.name}` });
  }
  if (sys.pocket) {
    const a = me ? Math.atan2(me.y, me.x) : Math.PI / 2;
    const d = sys.pocket.radius + 900;
    out.push({ kind: 'edge', to: sys.pocket.entrance.system, x: Math.cos(a) * d, y: Math.sin(a) * d, reach: 0, label: `out of ${sys.pocket.entrance.name}` });
  }
  if (sys.surface) {
    const a = me ? Math.atan2(me.y, me.x) : Math.PI / 2;
    const d = sys.surface.radius + 900;
    out.push({ kind: 'edge', to: sys.surface.of, x: Math.cos(a) * d, y: Math.sin(a) * d, reach: 0, label: `up to orbit (${nameOf(sys.surface.of)})` });
  }
  return out;
}

/** The first step of the shortest route from one system to another (null: you're there, or there's no way) */
export function routeStep(from: string, to: string, tick = 0, me?: { x: number; y: number }): RouteStep | null {
  if (from === to) return null;
  const prev = new Map<string, string>([[from, '']]);
  const queue = [from];
  while (queue.length && !prev.has(to)) {
    const at = queue.shift()!;
    for (const e of exits(at, tick)) {
      if (!prev.has(e.to)) { prev.set(e.to, at); queue.push(e.to); }
    }
  }
  if (!prev.has(to)) return null;
  let next = to;
  while (prev.get(next) !== from) next = prev.get(next)!;
  // The nearest way through to it (two gates can lead the same way)
  const ways = exits(from, tick, me).filter((e) => e.to === next);
  if (!me) return ways[0] ?? null;
  return ways.sort((a, b) => Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y))[0] ?? null;
}

/** Hops between two systems on the shortest route (-1: no way) */
export function routeHops(from: string, to: string): number {
  const dist = new Map<string, number>([[from, 0]]);
  const queue = [from];
  while (queue.length) {
    const at = queue.shift()!;
    if (at === to) return dist.get(at)!;
    for (const e of exits(at, 0)) {
      if (!dist.has(e.to)) { dist.set(e.to, dist.get(at)! + 1); queue.push(e.to); }
    }
  }
  return -1;
}
