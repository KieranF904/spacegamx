/**
 * @contract server.enemies.placement
 * owns:       where packs go and come from: nest tending, nomads, wandering, arrivals through gates, spawn points
 * needs:      Enemies (rng, packs, host, data, bosses), ../Roaming; npm: @space-game/common
 * invariants: a nest's ships are tended one at a time, and nomads travel between places and never into safe space — server/src/game/nests.test.ts
 * extend:     a new way a pack gets about is a Roaming style handled in steerNomad/wander
 */

import { Position, InSystem, Radius, nestPosition, nestPost, insideTerrain, rayTerrain, terrainRadius, dcos, dhypot, dsin } from '@space-game/common';
import { clampBand, stepRound, placesOfInterest, looseWaypoint, nomadDestination, type ClearRun, type XY } from '../Roaming.js';
import type { Enemies } from '../Enemies.js';
import type { SpawnGroup, SpawnNest, SpawnZone, Pack } from './model.js';

/** How fast a nomad pack's home moves on (units a tick: about cruising speed) */
const NOMAD_SPEED = 2.2;

/**
 * A nest, every half second: its loaded packs' home follows it round its
 * orbit, and a loaded nomad near a pilot travels on (its home slides to
 * where it's heading). Its packs are its population (below): they're out
 * round it whether anyone's near or not, and nothing is launched here.
 */
export function tendNest(self: Enemies, num: number, n: SpawnNest, players: number[], all: Pack[], now: number): void {
  if (!n.place) return;
  const key = `${num}:${n.id}`;
  const at = nestPost(n, n.place, n.planets, now);
  const wake = loadRange(self);
  for (const p of all) {
    if (p.nest !== key) continue;
    // A nomad is awake while a pilot is near it, wherever it's got to; the rest go where the nest goes
    if (p.style === 'nomad') {
      if (players.some((q) => dhypot(Position.x[q] - p.home.x, Position.y[q] - p.home.y) < wake)) steerNomad(self, num, n, p, players, now);
      continue;
    }
    p.home = at;
  }
}

/** Places a pack might head for: planets, belts, stations' outskirts, gates, the system's other nests (in its band) */
export function places(self: Enemies, num: number, n: SpawnNest, now: number, rng = self.rng): XY[] {
  const extra: XY[] = [];
  const out = (x: number, y: number, d: number) => { const r = dhypot(x, y) || 1; extra.push({ x: x + (x / r) * d, y: y + (y / r) * d }); };
  for (const st of self.host.stations(num)) out(Position.x[st], Position.y[st], 9000);
  for (const g of self.host.gates?.(num) ?? []) out(g.x, g.y, 6000);
  for (const o of self.data.spawns[self.host.systemId(num) ?? '']?.nests ?? []) if (o !== n && o.place) extra.push(nestPosition(o.place, o.planets, now));
  return placesOfInterest(n.sys, n.planets, now, extra, n.band ?? { min: 0, max: 1e9 }, rng);
}

/** A nomad pack, every half second while awake: its home slides on to where it's heading; settled a while, it picks somewhere new */
export function steerNomad(self: Enemies, num: number, n: SpawnNest, p: Pack, players: number[], now: number): void {
  const band = n.band ?? { min: 0, max: 1e9 };
  if (p.dest) {
    const { at, arrived } = stepRound(p.home, p.dest, NOMAD_SPEED * 30);
    p.home = clampBand(at, band);
    if (arrived) { p.dest = undefined; p.settleUntil = now + 60 * (40 + self.rng() * 80); p.wpUntil = 0; }
    return;
  }
  if (now < (p.settleUntil ?? 0)) return;
  p.dest = nomadDestination(p.home, places(self, num, n, now), players.map((q) => ({ x: Position.x[q], y: Position.y[q] })), band, self.rng);
}

/**
 * A loose or nomad pack's waypoint (the pack's, shared): re-picked once its
 * lead gets there or it's taken too long. `from`: where the lead is, if not
 * its components (a distant one's route: SimLod), with that route's dice.
 */
export function wander(self: Enemies, p: Pack, lead: number, now: number, from?: XY, rng = self.rng): XY {
  const n = p.nestDef!;
  // Travelling: a little ahead of its home, on the way
  if (p.style === 'nomad' && p.dest) return stepRound(p.home, p.dest, 2500).at;
  const at = from ? { x: from.x, y: from.y } : { x: Position.x[lead], y: Position.y[lead] };
  if (p.wp && now < (p.wpUntil ?? 0) && dhypot(at.x - p.wp.x, at.y - p.wp.y) > 600) return p.wp;
  const lane = p.style !== 'nomad' && n.place && n.place.around === undefined ? n.place.orbit.radius : 0;
  const w = looseWaypoint(at, homeAt(self, p, now), p.roam ?? 2400, n.bias ?? 0.5, n.band ?? { min: 0, max: 1e9 }, places(self, p.systemNum, n, now, rng), lane, rng);
  p.wp = w.wp;
  p.wpUntil = now + 60 * (25 + rng() * 35);
  if (w.pause) p.pauseUntil = now + 60 * (6 + rng() * 10);
  return p.wp;
}

/** A nest's packs out now (their ships), and where it is (tests, tools) */
export function nest(self: Enemies, systemNum: number, id: string): { x: number; y: number; packs: number[][] } | null {
  const sp = self.data.spawns[self.host.systemId(systemNum) ?? ''];
  const n = sp?.nests?.find((q) => q.id === id);
  if (!n?.place) return null;
  const key = `${systemNum}:${id}`;
  const packs = [...self.packs.values()].filter((p) => p.nest === key).map((p) => [...p.members]);
  return { ...nestPosition(n.place, n.planets, self.host.tick()), packs };
}

export function pickGroup(self: Enemies, groups: { faction: string; ships: string[]; weight: number }[]) {
  const total = groups.reduce((t, g) => t + g.weight, 0);
  let roll = self.rng() * total;
  for (const g of groups) { roll -= g.weight; if (roll <= 0) return g; }
  return groups[0];
}

/** In a zone's ring, near one of the pilots there but out of their sight */
export function zonePoint(self: Enemies, num: number, players: number[], z: SpawnZone): { x: number; y: number } | null {
  const stations = self.host.stations(num);
  const [lo, hi] = spawnRange(self);
  for (let tries = 0; tries < 40; tries++) {
    const p = players[Math.floor(self.rng() * players.length)];
    // Out past the radar, in the zone's ring (a narrow ring: as far as it allows)
    const a = self.rng() * Math.PI * 2, d = (tries < 30 ? lo : lo * 0.7) + self.rng() * (hi - lo);
    const x = Position.x[p] + dcos(a) * d, y = Position.y[p] + dsin(a) * d;
    const r = dhypot(x - (z.x ?? 0), y - (z.y ?? 0));
    if (r < z.inner || r > z.outer || self.host.unsafe(num, x, y)) continue;
    if (players.some((q) => dhypot(Position.x[q] - x, Position.y[q] - y) < (tries < 30 ? lo : lo * 0.7))) continue;
    if (stations.some((s) => dhypot(Position.x[s] - x, Position.y[s] - y) < self.data.rules.minStationDistance)) continue;
    return { x, y };
  }
  return null;
}

/**
 * A pack comes into the system, never out of nowhere beside a pilot: from
 * its faction's outpost if it stands, through a gate (spooling up first,
 * for all to see), or out past the radar's reach; then most fly in towards
 * where the pilots are, the rest patrol where they came in.
 */
export function arrive(self: Enemies, num: number, group: SpawnGroup, players: number[], zone?: SpawnZone): void {
  const R = self.data.rules;
  const passive = !!(group as { passive?: boolean }).passive;
  const towards = (): { x: number; y: number } | undefined => {
    const out = players.filter((p) => !self.host.safeAt?.(num, Position.x[p], Position.y[p]));
    if (passive || self.rng() >= (R.approachChance ?? 0.6) || !out.length) return undefined;
    const p = out[Math.floor(self.rng() * out.length)];
    const a = self.rng() * Math.PI * 2, d = 2500 + self.rng() * 2500;
    return { x: Position.x[p] + dcos(a) * d, y: Position.y[p] + dsin(a) * d };
  };
  // Launched from the faction's outpost (the Redtooth Hold sends its cutters out)
  const base = self.bosses?.launcher(num, group.faction);
  if (base && self.rng() < 0.5) {
    const a = self.rng() * Math.PI * 2;
    const x = base.x + dcos(a) * base.r, y = base.y + dsin(a) * base.r;
    self.host.effect?.(num, x, y, 'launch');
    const eids = self.spawnPack(num, group, x, y, zone?.id);
    self.own(eids, zone ? 'zone' : 'system');
    const to = towards();
    if (to) self.sendPack(eids, to);
    return;
  }
  // Through a gate, seen spooling up first (not one a pilot's sitting on)
  const gates = (self.host.gates?.(num) ?? []).filter((g) => players.every((p) => dhypot(Position.x[p] - g.x, Position.y[p] - g.y) > 6000));
  if (gates.length && self.rng() < (R.gateChance ?? 0.3)) {
    const g = gates[Math.floor(self.rng() * gates.length)];
    const a = self.rng() * Math.PI * 2;
    const x = g.x + dcos(a) * 600, y = g.y + dsin(a) * 600;
    self.host.effect?.(num, x, y, 'warning');
    self.arrivals.push({ due: self.host.tick() + Math.round((R.warnSeconds ?? 3) * 60), num, group, x, y, zone: zone?.id, approach: towards() });
    return;
  }
  const at = zone ? zonePoint(self, num, players, zone) : spawnPoint(self, num, players, passive);
  if (!at) return;
  const eids = self.spawnPack(num, group, at.x, at.y, zone?.id);
  self.own(eids, zone ? 'zone' : 'system');
  const to = towards();
  if (to) self.sendPack(eids, to);
}

/** How far from every pilot a pack may come in: past the radar's reach */
export function spawnRange(self: Enemies): [number, number] {
  return self.data.rules.spawnRange ?? [12000, 18000];
}

/** Somewhere out past the pilots' radar, and far from stations */
export function spawnPoint(self: Enemies, num: number, players: number[], passive = false): { x: number; y: number } | null {
  const R = self.host.systemRadius(num);
  const stations = self.host.stations(num);
  const [lo, hi] = spawnRange(self);
  for (let tries = 0; tries < 40; tries++) {
    // Near a player's part of the system, so packs are found, but beyond their sight
    const p = players[Math.floor(self.rng() * players.length)];
    const a = self.rng() * Math.PI * 2, d = lo + self.rng() * (hi - lo);
    const x = Position.x[p] + dcos(a) * d, y = Position.y[p] + dsin(a) * d;
    if (dhypot(x, y) > R * 1.2 || self.host.unsafe(num, x, y)) continue;
    // Hostiles come in outside the safe space
    if (!passive && self.host.safeAt?.(num, x, y)) continue;
    if (players.some((q) => dhypot(Position.x[q] - x, Position.y[q] - y) < lo)) continue;
    if (stations.some((s) => dhypot(Position.x[s] - x, Position.y[s] - y) < self.data.rules.minStationDistance)) continue;
    return { x, y };
  }
  return null;
}

/** How close a pilot comes to a ghost pack before it's loaded (rules.nestWake); it's put back once none is within 1.25 times this */
export function loadRange(self: Enemies): number {
  return self.data.rules.nestWake ?? 36000;
}

/** Where a pack's home is at tick t: a nest's goes round with it (tendNest keeps it so while it's watched), a nomad's is where it's got to */
export function homeAt(self: Enemies, p: Pack, t: number): XY {
  const n = p.nestDef;
  return n?.place && p.style !== 'nomad' ? nestPost(n, n.place, n.planets, t) : p.home;
}

/**
 * Whether a ship can fly straight from one place to another in its system without touching rock: its centre's line
 * and both its sides', and room for it where it ends up (undefined: its system has none, any run is clear)
 */
export function clearRun(self: Enemies, eid: number): ClearRun | undefined {
  const rock = self.host.terrain?.(InSystem.systemId[eid]);
  if (!rock?.pieces.length) return undefined;
  const r = terrainRadius(self.ships.get(eid)?.derived.radius ?? Radius.value[eid] ?? 40) + 150;
  return (a, b) => {
    if (insideTerrain(rock, b.x, b.y, r)) return false;
    const d = dhypot(b.x - a.x, b.y - a.y) || 1, nx = (-(b.y - a.y) / d) * r, ny = ((b.x - a.x) / d) * r;
    return rayTerrain(rock, a.x, a.y, b.x, b.y) >= 1 && rayTerrain(rock, a.x + nx, a.y + ny, b.x + nx, b.y + ny) >= 1 && rayTerrain(rock, a.x - nx, a.y - ny, b.x - nx, b.y - ny) >= 1;
  };
}
