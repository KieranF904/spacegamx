/**
 * Hostile populations (factions.json spawns: nests, and zones with packs of their own): each spawner has `packs`
 * slots, each slot a pack of a group's ships, alive or not ship by ship. They're always there: a slot nobody's
 * near isn't simulated at all, it's a ghost, and where it is comes from here, the same on the server and on every
 * client, from the spawner, the slot and the tick stepped every GHOST_STEP ticks. So the map draws ghosts for free:
 * all a client is told is which slots' ships are alive, which group each slot is, and which are loaded (real ships,
 * sent as ships). A ghost a pilot comes near is loaded where its ghost is (the server spawns each ship at
 * `ghostShip`). Persistence and respawning are the server's (server/src/game/Enemies.ts).
 */

import type { NestData, PlanetData, StarSystemData } from '../data/schemas.js';
import { hashString, mulberry32 } from '../math/rng.js';
import { datan2, dcos, dhypot, dsin } from '../math/detTrig.js';
import { nestPosition, nestReach } from './nests.js';

export type RoamStyle = 'anchored' | 'loose' | 'nomad';
export type XY = { x: number; y: number };
export interface Band { min: number; max: number }

/** A ghost's place moves on this often (ticks): positions are worked out at the start of each step */
export const GHOST_STEP = 300;

/** A spawner's group as in factions.json (only what a population needs) */
export interface PopGroup { faction: string; ships: string[]; weight: number; passive?: boolean; limit?: number; style?: RoamStyle }
/** A nest or zone as in factions.json (only what a population needs) */
export interface PopSpawnerDef { id: string; packs: number; roam?: number; style?: RoamStyle; groups: PopGroup[]; inner?: number; outer?: number; x?: number; y?: number; post?: XY }

/**
 * Where a nest's packs keep round (all but nomads): its `post` if it has one (a den's heap is piled against its
 * chamber's wall, so its packs keep to the chamber's open middle, not the heap), else the nest itself
 */
export function nestPost(def: { post?: XY }, place: NestData, planets: readonly PlanetData[] | undefined, tick: number): XY {
  return def.post ? { x: def.post.x, y: def.post.y } : nestPosition(place, planets, tick);
}

/** One of a system's populations, in a fixed order both ends work out alike: its nests, then its zones */
export interface Spawner {
  kind: 'nest' | 'zone';
  /** Its place in the system's list (the wire names it by this) */
  index: number;
  def: PopSpawnerDef;
  /** A nest's place (systems.json), and the band of the system its packs keep to */
  place?: NestData;
  band?: Band;
}

/** A system's populations: nests that have a place and packs, then zones with packs of their own */
export function spawnersOf(spawns: { nests?: PopSpawnerDef[]; zones?: PopSpawnerDef[] } | undefined, sys: StarSystemData | undefined): Spawner[] {
  const out: Spawner[] = [];
  for (const def of spawns?.nests ?? []) {
    const place = sys?.nests?.find((n) => n.id === def.id);
    if (!place || !(def.packs > 0) || !def.groups.length) continue;
    out.push({ kind: 'nest', index: out.length, def, place, band: nestBand(sys, place) });
  }
  for (const def of spawns?.zones ?? []) {
    if (!(def.packs > 0) || !def.groups.length) continue;
    // (A spot zone's centre is systems.json's zone of the same id)
    const at = sys?.zones?.find((z) => z.id === def.id);
    const d = def.x === undefined && at?.x !== undefined ? { ...def, x: at.x, y: at.y } : def;
    out.push({ kind: 'zone', index: out.length, def: d });
  }
  return out;
}

/** How a slot's pack gets about: its group's style, else its spawner's (a zone's packs keep round their spot) */
export function slotStyle(sp: Spawner, group: number): RoamStyle {
  return sp.def.groups[group]?.style ?? sp.def.style ?? (sp.kind === 'zone' ? 'anchored' : 'loose');
}

/** A slot's dice (the same every time for this system, spawner and slot) */
function dice(sysId: string, sp: Spawner, slot: number): () => number {
  return mulberry32(hashString(`pop:${sysId}:${sp.def.id}:${slot}`));
}

/** Which group each slot starts as (a fresh world): by weight, keeping to each group's limit */
export function seedGroups(sysId: string, sp: Spawner): number[] {
  const rng = mulberry32(hashString(`popgroups:${sysId}:${sp.def.id}`));
  const out: number[] = [];
  for (let s = 0; s < sp.def.packs; s++) out.push(pickGroup(sp.def.groups, out, rng));
  return out;
}

/** A group by weight among those under their limit (`taken`: the groups of the packs out now; -1: none fits) */
export function pickGroup(groups: readonly PopGroup[], taken: readonly number[], rng: () => number, ok: (g: number) => boolean = () => true): number {
  const fits = groups.map((g, i) => ok(i) && (g.limit === undefined || taken.filter((t) => t === i).length < g.limit));
  const total = groups.reduce((t, g, i) => t + (fits[i] ? g.weight : 0), 0);
  if (total <= 0) return -1;
  let roll = rng() * total;
  for (let i = 0; i < groups.length; i++) {
    if (!fits[i]) continue;
    roll -= groups[i].weight;
    if (roll <= 0) return i;
  }
  return fits.findIndex((f) => f);
}

/** Where a slot's pack is while it's a ghost: its lead's place at `tick` (stepped to GHOST_STEP) */
/**
 * Where a spawner's nomads are drawn to (both ends have it: the server works it out, `pops` tells the clients): the
 * sector of the system (LURE_SECTORS round the star) its band's pilots were last seen in, `l2`, from coarse tick `s2`
 * (in GHOST_STEPs), and the one before it, `l1` from `s1` (its pull frozen at `s2`, so a new lure starts from where the
 * ghosts had got to). -1: none. Nobody in the band any more leaves the last one standing: they stay where pilots were.
 */
export interface Lure { l1: number; s1: number; l2: number; s2: number }
export const LURE_SECTORS = 16;
/** How long a lure takes to draw its nomads (ticks) as far as they go: LURE_PULL of the way round to its sector */
export const LURE_RAMP = 60 * 240;
export const LURE_PULL = 0.9;

/** Which lure sector a point is in */
export function lureSector(x: number, y: number): number {
  const a = datan2(y, x);
  return ((Math.floor((a / (Math.PI * 2)) * LURE_SECTORS) % LURE_SECTORS) + LURE_SECTORS) % LURE_SECTORS;
}

/** A lure on the wire (pops `n`): [spawner index, l1, s1, l2, s2] */
export function packLure(out: number[], index: number, l: Lure): void {
  out.push(index, l.l1, l.s1, l.l2, l.s2);
}

/** An angle drawn round towards its lures by coarse tick `t` */
function lured(a: number, l: Lure, t: number): number {
  const pull = (sector: number, since: number, until: number, at: number) => {
    const w = Math.min(LURE_PULL, Math.max(0, (until - since * GHOST_STEP) / LURE_RAMP));
    if (sector < 0 || w <= 0) return at;
    const to = ((sector + 0.5) / LURE_SECTORS) * Math.PI * 2;
    return at + datan2(dsin(to - at), dcos(to - at)) * w;
  };
  return pull(l.l2, l.s2, t, pull(l.l1, l.s1, Math.min(t, l.s2 * GHOST_STEP), a));
}

export function ghostCentre(sys: StarSystemData | undefined, sysId: string, sp: Spawner, slot: number, style: RoamStyle, tick: number, lure?: Lure): XY {
  const t = Math.floor(tick / GHOST_STEP) * GHOST_STEP;
  const rng = dice(sysId, sp, slot);
  const h1 = rng(), h2 = rng(), h3 = rng(), h4 = rng(), h5 = rng();
  const roam = sp.def.roam ?? 2400, dir = h3 < 0.5 ? -1 : 1;
  if (sp.kind === 'zone') {
    // Round a spot of the ring (or of a spot zone) the slot keeps to
    const inner = sp.def.inner ?? 0, outer = Math.max(inner, sp.def.outer ?? inner);
    const ra = h4 * Math.PI * 2, rr = inner + (outer - inner) * (0.15 + 0.7 * h1);
    const ax = (sp.def.x ?? 0) + dcos(ra) * rr, ay = (sp.def.y ?? 0) + dsin(ra) * rr;
    const a = h5 * Math.PI * 2 + (dir * Math.PI * 2 * t) / (60 * (240 + 240 * h2)), r = roam * (0.3 + 0.4 * h1);
    return { x: ax + dcos(a) * r, y: ay + dsin(a) * r };
  }
  const n = sp.place!, planets = sys?.planets;
  const band = sp.band ?? { min: 0, max: 1e9 };
  if (style === 'nomad') {
    // Slowly round the system in its band, in and out a little
    const span = Math.max(0, band.max - band.min);
    const r = band.min + span * (0.3 + 0.4 * h1 + 0.2 * dsin((Math.PI * 2 * t) / (60 * (900 + 900 * h2)) + h5 * 6.283));
    const home = nestPosition(n, planets, 0);
    const a0 = datan2(home.y, home.x) + h4 * Math.PI * 2 + (dir * Math.PI * 2 * t) / (60 * (2400 + 2400 * h2));
    // (Drawn round towards where its band's pilots were last seen)
    const a = lure ? lured(a0, lure, t) : a0;
    return clampBand({ x: dcos(a) * r, y: dsin(a) * r }, band);
  }
  // Round the nest (or its post) as it goes round its orbit: guards close, loose packs wider
  const at = nestPost(sp.def, n, planets, t);
  const r = style === 'anchored' ? roam * (0.3 + 0.45 * h1) : roam * (0.6 + 1.2 * h1);
  const a = h4 * Math.PI * 2 + (dir * Math.PI * 2 * t) / (60 * (240 + 300 * h2));
  return clampBand({ x: at.x + dcos(a) * r, y: at.y + dsin(a) * r }, band);
}

/** Where a pack's ship `k` keeps off its lead (k 0 is the lead) */
export function ghostOffset(k: number): XY {
  return k <= 0 ? { x: 0, y: 0 } : { x: dcos(k * 2.4) * 380, y: dsin(k * 2.4) * 380 };
}

/** Where a ghost ship is: its pack's place and its own place in the pack */
export function ghostShip(centre: XY, k: number): XY {
  const o = ghostOffset(k);
  return { x: centre.x + o.x, y: centre.y + o.y };
}

/**
 * A slot on the wire (the `pops` message): its group (+1; 0 none), whether it's loaded (its ships are real, sent
 * as ships, not drawn as ghosts), and which of its group's ships are alive (bit k: ship k)
 */
export function packPopSlot(group: number, loaded: boolean, alive: number): number {
  return (group + 1) | (loaded ? 32 : 0) | (alive << 6);
}

export function unpackPopSlot(code: number): { group: number; loaded: boolean; alive: number } {
  return { group: (code & 31) - 1, loaded: (code & 32) !== 0, alive: code >>> 6 };
}

/** The ring of the system a nest's packs keep to: its region band (or the whole system), clear of the central body */
export function nestBand(sys: Pick<StarSystemData, 'regions' | 'centralBody' | 'starRadius' | 'asteroidBelt' | 'portals' | 'planets'> | undefined, place: NestData): Band {
  const reach = nestReach(place, sys?.planets);
  const r = (reach.min + reach.max) / 2;
  const cb = sys?.centralBody as { radius?: number; gravity?: { horizon?: number } } | undefined;
  const body = Math.max(cb?.gravity?.horizon ?? 0, cb?.radius ?? sys?.starRadius ?? 0) + 6000;
  const belts = [sys?.asteroidBelt, ...(sys?.asteroidBelt?.extra ?? [])].map((b) => b?.outerRadius ?? 0);
  const edge = Math.max(reach.max, ...belts, ...(sys?.planets ?? []).map((p: PlanetData) => p.orbit.radius + p.radius + 4000), ...(sys?.portals ?? []).map((g) => dhypot(g.position.x, g.position.y))) * 1.08;
  const regions = sys?.regions ?? [];
  if (!regions.length) return { min: body, max: edge };
  let i = regions.findIndex((g) => r <= g.outer);
  if (i < 0) i = regions.length - 1;
  const inner = i > 0 ? regions[i - 1].outer : 0;
  // (Out of a safe band by a margin: a pack's ships reach a little past their home)
  const margin = i > 0 && regions[i - 1].danger === 'safe' ? 3000 : 0;
  return { min: Math.max(body, inner + margin), max: i === regions.length - 1 ? Math.max(edge, regions[i].outer) : regions[i].outer };
}

/** A point pushed back into the band (radially) */
export function clampBand(p: XY, b: Band): XY {
  const r = dhypot(p.x, p.y);
  if (r >= b.min && r <= b.max) return p;
  if (r < 1) return { x: b.min, y: 0 };
  const k = Math.min(b.max, Math.max(b.min, r)) / r;
  return { x: p.x * k, y: p.y * k };
}

/**
 * How often a loaded hostile out of a client's view goes to it (the map feed, ticks): `mid` inside the system's first
 * danger band (inner Sol: from the star out to the inner Sol line), `far` past it; a system with no bands uses
 * `midRadius`. In view it's live (the snapshot).
 */
export interface FeedTiers { midTicks: number; farTicks: number; midRadius: number }
export const FEED_TIERS: FeedTiers = { midTicks: 120, farTicks: 300, midRadius: 76000 };

/** Where the mid band ends in a system: its first danger band's outer edge (inner Sol's line), else the default */
export function feedMidRadius(sys: Pick<StarSystemData, 'regions'> | undefined, tiers: FeedTiers = FEED_TIERS): number {
  return sys?.regions?.[0]?.outer ?? tiers.midRadius;
}
