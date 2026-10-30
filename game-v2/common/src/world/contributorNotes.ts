/**
 * Contributor notes: markers contributors (and admins) pin to a system for
 * whoever builds the game next ("a large water planet here, the size of this
 * circle"). Each is a shape at an anchor that moves the way game bodies do:
 * fixed in place, on an orbit (the planets' and nests' maths, driven by the
 * server tick), or attached to a planet, moon, station, nest or lodestone.
 *
 * The server keeps them (server/src/game/ContributorNotes.ts, saved to
 * data/contributor/notes.json); only contributors and admins with the overlay
 * on are sent them. scripts/contributor-notes.mjs prints them for the
 * terminal with formatNotes() below (docs/contributor-notes.md).
 *
 * Angles are degrees here (people type them); 0° is east and angles grow
 * clockwise on screen (y points down), as the planets' do.
 */

import type { LodestoneData, NestData, PlanetData, StationData } from '../data/schemas.js';
import { planetPosition, moonOffset } from './planets.js';
import { nestPosition } from './nests.js';
import { calcAsteroidPosition, scaledOrbitTick, stationOrbitTimeScale } from '../asteroid/orbit.js';
import { TICK_RATE } from '../constants.js';

export type NoteStatus = 'open' | 'done' | 'wontdo';
export const NOTE_STATUSES: readonly NoteStatus[] = ['open', 'done', 'wontdo'];

/** What's drawn, in world units about the anchor */
export type NoteShape =
  | { kind: 'point' }
  | { kind: 'circle'; radius: number }
  | { kind: 'ring'; inner: number; outer: number }
  | { kind: 'rect'; w: number; h: number; rotationDeg: number }
  /** From the anchor to the anchor + (dx, dy); an arrow has a head at that end */
  | { kind: 'line' | 'arrow'; dx: number; dy: number }
  /** Corners relative to the anchor */
  | { kind: 'polygon'; points: [number, number][] };

export type NoteShapeKind = NoteShape['kind'];
export const NOTE_SHAPES: readonly NoteShapeKind[] = ['point', 'circle', 'ring', 'rect', 'line', 'arrow', 'polygon'];

/** A body of the system a note can ride with */
export type NoteBodyRef =
  | { kind: 'planet'; id: string }
  | { kind: 'moon'; id: string; moon: number }
  | { kind: 'station'; id: string }
  | { kind: 'nest'; id: string }
  | { kind: 'lodestone'; id: string };

/** What an orbit goes round: the system centre, a planet, or a planet's moon (as nests can) */
export type NoteOrbitCentre = { kind: 'center' } | { kind: 'planet'; id: string } | { kind: 'moon'; id: string; moon: number };

/** How a note moves */
export type NoteAnchor =
  | { kind: 'fixed'; x: number; y: number }
  /**
   * Round `around` at `radius`, `periodMinutes` a revolution (0: stays put),
   * `phaseDeg` its angle at tick 0, as systems.json orbits (phase in radians there)
   */
  | { kind: 'orbit'; around: NoteOrbitCentre; radius: number; phaseDeg: number; periodMinutes: number; direction: 1 | -1 }
  /** Rides with a body at this offset from its centre */
  | { kind: 'attached'; to: NoteBodyRef; dx: number; dy: number };

export interface ContributorNote {
  id: string;
  /** Username, and account id (null for one granted from the terminal) */
  author: string;
  authorId: number | null;
  /** ISO times */
  createdAt: string;
  updatedAt: string;
  /** System id (systems.json) */
  system: string;
  title: string;
  text: string;
  status: NoteStatus;
  /** Why it's done or won't be (and who said so) */
  resolution?: string;
  statusBy?: string;
  shape: NoteShape;
  /** #rrggbb */
  color: string;
  anchor: NoteAnchor;
  /** What the shape's size means for the request ("match circle size") */
  sizeHint?: string;
}

/** What a client sends to make or change a note */
export type NoteDraft = Pick<ContributorNote, 'system' | 'title' | 'text' | 'shape' | 'color' | 'anchor'> & { sizeHint?: string };

/** The bodies of a system a note can be placed about */
export interface NoteBodies {
  planets?: readonly PlanetData[];
  nests?: readonly NestData[];
  lodestones?: readonly LodestoneData[];
  /** This system's stations (stations.json) */
  stations?: readonly StationData[];
}

export const NOTE_LIMITS = {
  title: 80,
  text: 2000,
  sizeHint: 120,
  resolution: 500,
  /** Notes one contributor can have (admins: adminPerAuthor) */
  perAuthor: 200,
  adminPerAuthor: 1000,
  total: 5000,
  polygonPoints: 32,
  /** Farthest from the centre (or across) anything can be, world units */
  coord: 5_000_000,
  /** Longest period, minutes */
  period: 1_000_000,
} as const;

const TICKS_PER_MINUTE = TICK_RATE * 60;
const DEG = Math.PI / 180;

// ============================================
// Positions
// ============================================

/** Where a station is at a tick (as the server moves it: GameServer's station orbit) */
export function stationPositionAt(st: StationData, tick: number): { x: number; y: number } {
  const o = st.orbit as (StationData['orbit'] & { timeScale?: number }) | undefined;
  if (!o) return { x: st.position.x, y: st.position.y };
  const epochTick = o.epochTick ?? 0;
  const timeScale = o.timeScale ?? stationOrbitTimeScale(o.semiMajorAxis ?? 0);
  return calcAsteroidPosition({
    orbitType: o.orbitType ?? 0, semiMajorAxis: o.semiMajorAxis ?? 0, eccentricity: o.eccentricity ?? 0,
    argPeriapsis: o.argPeriapsis ?? 0, meanAnomaly0: o.meanAnomaly0 ?? 0, epochTick,
  }, scaledOrbitTick(tick, epochTick, timeScale));
}

/** A body's centre at a tick (null: no such body in this system) */
export function noteBodyPosition(b: NoteBodies, ref: NoteBodyRef | NoteOrbitCentre, tick: number): { x: number; y: number } | null {
  switch (ref.kind) {
    case 'center': return { x: 0, y: 0 };
    case 'planet': case 'moon': {
      const pl = b.planets?.find((p) => p.id === ref.id);
      if (!pl) return null;
      const p = planetPosition(pl, tick);
      if (ref.kind === 'planet') return p;
      if (!pl.moons?.[ref.moon]) return null;
      const m = moonOffset(pl, ref.moon, tick);
      return { x: p.x + m.x, y: p.y + m.y };
    }
    case 'station': {
      const st = b.stations?.find((s) => s.id === ref.id);
      return st ? stationPositionAt(st, tick) : null;
    }
    case 'nest': {
      const n = b.nests?.find((x) => x.id === ref.id);
      return n ? nestPosition(n, b.planets, tick) : null;
    }
    case 'lodestone': {
      const l = b.lodestones?.find((x) => x.id === ref.id);
      if (!l) return null;
      return l.orbit ? planetPosition({ orbit: l.orbit }, tick) : { x: l.position?.x ?? 0, y: l.position?.y ?? 0 };
    }
  }
}

/** An orbit anchor as systems.json writes orbits: radians, and the period's sign for the direction */
export function orbitAsGameOrbit(a: Extract<NoteAnchor, { kind: 'orbit' }>): { radius: number; phase: number; period: number } {
  return { radius: a.radius, phase: a.phaseDeg * DEG, period: a.periodMinutes * a.direction };
}

/** Where a note's anchor is at a tick (null: the body it goes with isn't in its system) */
export function noteAnchorPosition(anchor: NoteAnchor, b: NoteBodies, tick: number): { x: number; y: number } | null {
  if (anchor.kind === 'fixed') return { x: anchor.x, y: anchor.y };
  if (anchor.kind === 'attached') {
    const p = noteBodyPosition(b, anchor.to, tick);
    return p ? { x: p.x + anchor.dx, y: p.y + anchor.dy } : null;
  }
  // The nests' maths: round the centre, a planet or its moon, as planets go round the star
  const c = anchor.around;
  if (c.kind !== 'center' && !noteBodyPosition(b, c, tick)) return null;
  const nest = { around: c.kind === 'center' ? undefined : c.id, moon: c.kind === 'moon' ? c.moon : undefined, orbit: orbitAsGameOrbit(anchor) } as NestData;
  return nestPosition(nest, b.planets, tick);
}

/** An orbit's angle at a tick, degrees (0-360) */
export function orbitAngleDeg(a: Extract<NoteAnchor, { kind: 'orbit' }>, tick: number): number {
  const turns = a.periodMinutes ? (tick / (a.periodMinutes * TICKS_PER_MINUTE)) * a.direction : 0;
  return (((a.phaseDeg + turns * 360) % 360) + 360) % 360;
}

/**
 * An orbit through the point (x, y) at `tick`: its radius from the centre and
 * the phase (at tick 0) that puts it there now
 */
export function orbitThrough(around: NoteOrbitCentre, x: number, y: number, b: NoteBodies, tick: number, periodMinutes: number, direction: 1 | -1): Extract<NoteAnchor, { kind: 'orbit' }> {
  const c = noteBodyPosition(b, around, tick) ?? { x: 0, y: 0 };
  const radius = Math.hypot(x - c.x, y - c.y);
  const now = Math.atan2(y - c.y, x - c.x) / DEG;
  const turns = periodMinutes ? (tick / (periodMinutes * TICKS_PER_MINUTE)) * direction : 0;
  const phaseDeg = ((((now - turns * 360) % 360) + 360) % 360);
  return { kind: 'orbit', around, radius: round2(radius), phaseDeg: round2(phaseDeg), periodMinutes, direction };
}

/** The body whose centre is nearest (x, y) at a tick, and how far (planets, moons, stations, nests, lodestones) */
export function nearestNoteBody(b: NoteBodies, x: number, y: number, tick: number): { ref: NoteBodyRef; name: string; dist: number; x: number; y: number; radius: number } | null {
  let best: { ref: NoteBodyRef; name: string; dist: number; x: number; y: number; radius: number } | null = null;
  const consider = (ref: NoteBodyRef, name: string, radius: number) => {
    const p = noteBodyPosition(b, ref, tick);
    if (!p) return;
    const dist = Math.hypot(p.x - x, p.y - y);
    if (!best || dist < best.dist) best = { ref, name, dist, x: p.x, y: p.y, radius };
  };
  for (const pl of b.planets ?? []) {
    consider({ kind: 'planet', id: pl.id }, pl.name, pl.radius);
    pl.moons?.forEach((m, i) => consider({ kind: 'moon', id: pl.id, moon: i }, m.name ?? `${pl.name} moon ${i + 1}`, m.radius));
  }
  for (const s of b.stations ?? []) consider({ kind: 'station', id: s.id }, s.name, s.radius);
  for (const n of b.nests ?? []) consider({ kind: 'nest', id: n.id }, n.name, 420);
  for (const l of b.lodestones ?? []) consider({ kind: 'lodestone', id: l.id }, l.name ?? 'Stillstone', l.size ?? 1800);
  return best;
}

/** A body's name for people (planet, "Planet's moon 2", station, nest, lodestone) */
export function noteBodyName(b: NoteBodies, ref: NoteBodyRef | NoteOrbitCentre): string {
  switch (ref.kind) {
    case 'center': return 'the system centre';
    case 'planet': return `planet ${b.planets?.find((p) => p.id === ref.id)?.name ?? ref.id} (${ref.id})`;
    case 'moon': {
      const pl = b.planets?.find((p) => p.id === ref.id);
      const m = pl?.moons?.[ref.moon];
      return `moon ${m?.name ?? `#${ref.moon}`} (moon index ${ref.moon}) of planet ${pl?.name ?? ref.id} (${ref.id})`;
    }
    case 'station': return `station ${b.stations?.find((s) => s.id === ref.id)?.name ?? ref.id} (${ref.id})`;
    case 'nest': return `nest ${b.nests?.find((n) => n.id === ref.id)?.name ?? ref.id} (${ref.id})`;
    case 'lodestone': return `stillstone ${b.lodestones?.find((l) => l.id === ref.id)?.name ?? ref.id} (${ref.id})`;
  }
}

/** How far a shape reaches from its anchor (for picking and culling) */
export function noteShapeReach(s: NoteShape): number {
  switch (s.kind) {
    case 'point': return 0;
    case 'circle': return s.radius;
    case 'ring': return s.outer;
    case 'rect': return Math.hypot(s.w, s.h) / 2;
    case 'line': case 'arrow': return Math.hypot(s.dx, s.dy);
    case 'polygon': return Math.max(0, ...s.points.map(([x, y]) => Math.hypot(x, y)));
  }
}

// ============================================
// Validation (the server never trusts a client's note)
// ============================================

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const round2 = (n: number) => Math.round(n * 100) / 100;

/** A finite number within ±max (rounded to hundredths), else null */
function num(v: unknown, max: number = NOTE_LIMITS.coord, min = -max): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) return null;
  return round2(v);
}

/** Text without control characters (newlines and tabs allowed in `multiline`), trimmed, at most `max` long */
function text(v: unknown, max: number, multiline = false): string | null {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const clean = v.replace(multiline ? /[\u0000-\u0008\u000b-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g, '').replace(/\r/g, '').trim();
  return clean.length <= max ? clean : null;
}

function parseShape(v: unknown): Parsed<NoteShape> {
  if (!isObj(v)) return fail('No shape');
  const pos = (x: unknown) => num(x, NOTE_LIMITS.coord, 0.01);
  switch (v.kind) {
    case 'point': return { ok: true, value: { kind: 'point' } };
    case 'circle': {
      const radius = pos(v.radius);
      return radius === null ? fail('A circle needs a radius') : { ok: true, value: { kind: 'circle', radius } };
    }
    case 'ring': {
      const inner = num(v.inner, NOTE_LIMITS.coord, 0), outer = pos(v.outer);
      if (inner === null || outer === null || inner >= outer) return fail('A ring needs inner < outer');
      return { ok: true, value: { kind: 'ring', inner, outer } };
    }
    case 'rect': {
      const w = pos(v.w), h = pos(v.h), rotationDeg = num(v.rotationDeg ?? 0, 360, -360);
      if (w === null || h === null || rotationDeg === null) return fail('A rectangle needs a width and height');
      return { ok: true, value: { kind: 'rect', w, h, rotationDeg } };
    }
    case 'line': case 'arrow': {
      const dx = num(v.dx), dy = num(v.dy);
      if (dx === null || dy === null || (dx === 0 && dy === 0)) return fail('A line needs an end');
      return { ok: true, value: { kind: v.kind, dx, dy } };
    }
    case 'polygon': {
      if (!Array.isArray(v.points) || v.points.length < 3 || v.points.length > NOTE_LIMITS.polygonPoints) return fail(`A polygon needs 3-${NOTE_LIMITS.polygonPoints} points`);
      const points: [number, number][] = [];
      for (const p of v.points) {
        const x = Array.isArray(p) ? num(p[0]) : null, y = Array.isArray(p) ? num(p[1]) : null;
        if (x === null || y === null) return fail('Bad polygon point');
        points.push([x, y]);
      }
      return { ok: true, value: { kind: 'polygon', points } };
    }
  }
  return fail('Unknown shape');
}

function parseBodyRef(v: unknown, b: NoteBodies, allowCentre: true): Parsed<NoteOrbitCentre>;
function parseBodyRef(v: unknown, b: NoteBodies, allowCentre: false): Parsed<NoteBodyRef>;
function parseBodyRef(v: unknown, b: NoteBodies, allowCentre: boolean): Parsed<NoteBodyRef | NoteOrbitCentre> {
  if (!isObj(v)) return allowCentre ? { ok: true, value: { kind: 'center' } } : fail('Attached to what?');
  if (v.kind === 'center' && allowCentre) return { ok: true, value: { kind: 'center' } };
  const id = typeof v.id === 'string' ? v.id.slice(0, 80) : '';
  let ref: NoteBodyRef;
  if (v.kind === 'moon') {
    if (typeof v.moon !== 'number' || !Number.isInteger(v.moon) || v.moon < 0) return fail('Which moon?');
    ref = { kind: 'moon', id, moon: v.moon };
  } else if (v.kind === 'planet' || (!allowCentre && (v.kind === 'station' || v.kind === 'nest' || v.kind === 'lodestone'))) {
    ref = { kind: v.kind, id } as NoteBodyRef;
  } else {
    return fail(allowCentre ? 'Orbits go round the centre, a planet or a moon' : 'Unknown body');
  }
  if (!noteBodyPosition(b, ref, 0)) return fail(`No ${ref.kind} "${id}" in this system`);
  return { ok: true, value: ref };
}

function parseAnchor(v: unknown, b: NoteBodies): Parsed<NoteAnchor> {
  if (!isObj(v)) return fail('No anchor');
  if (v.kind === 'fixed') {
    const x = num(v.x), y = num(v.y);
    return x === null || y === null ? fail('Bad position') : { ok: true, value: { kind: 'fixed', x, y } };
  }
  if (v.kind === 'attached') {
    const to = parseBodyRef(v.to, b, false);
    if (!to.ok) return to;
    const dx = num(v.dx ?? 0), dy = num(v.dy ?? 0);
    return dx === null || dy === null ? fail('Bad offset') : { ok: true, value: { kind: 'attached', to: to.value, dx, dy } };
  }
  if (v.kind === 'orbit') {
    const around = parseBodyRef(v.around, b, true);
    if (!around.ok) return around;
    const radius = num(v.radius, NOTE_LIMITS.coord, 0);
    const phaseDeg = num(v.phaseDeg ?? 0, 3600, -3600);
    const periodMinutes = num(v.periodMinutes ?? 0, NOTE_LIMITS.period, 0);
    if (radius === null || phaseDeg === null || periodMinutes === null) return fail('Bad orbit');
    const direction = v.direction === -1 ? -1 : 1;
    return { ok: true, value: { kind: 'orbit', around: around.value, radius, phaseDeg: round2((((phaseDeg % 360) + 360) % 360)), periodMinutes, direction } };
  }
  return fail('Unknown movement type');
}

/**
 * A client's note, checked and cleaned: lengths, finite numbers in range, a
 * known system (`bodiesOf` gives its bodies, null: no such system) and bodies
 * that are in it
 */
export function parseNoteDraft(raw: unknown, bodiesOf: (system: string) => NoteBodies | null): Parsed<NoteDraft> {
  if (!isObj(raw)) return fail('No note');
  const system = typeof raw.system === 'string' ? raw.system : '';
  const bodies = system ? bodiesOf(system) : null;
  if (!bodies) return fail('Unknown system');
  const title = text(raw.title, NOTE_LIMITS.title);
  if (!title) return fail(`Give it a title (up to ${NOTE_LIMITS.title} characters)`);
  const body = text(raw.text ?? '', NOTE_LIMITS.text, true);
  if (body === null) return fail(`The note is too long (up to ${NOTE_LIMITS.text} characters)`);
  const sizeHint = raw.sizeHint === undefined || raw.sizeHint === '' ? '' : text(raw.sizeHint, NOTE_LIMITS.sizeHint);
  if (sizeHint === null) return fail('The size hint is too long');
  const color = typeof raw.color === 'string' && /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color.toLowerCase() : null;
  if (!color) return fail('Bad colour');
  const shape = parseShape(raw.shape);
  if (!shape.ok) return shape;
  const anchor = parseAnchor(raw.anchor, bodies);
  if (!anchor.ok) return anchor;
  const draft: NoteDraft = { system, title, text: body, shape: shape.value, color, anchor: anchor.value };
  if (sizeHint) draft.sizeHint = sizeHint;
  return { ok: true, value: draft };
}

/** Status and resolution, checked */
export function parseNoteStatus(status: unknown, resolution: unknown): Parsed<{ status: NoteStatus; resolution: string }> {
  if (!NOTE_STATUSES.includes(status as NoteStatus)) return fail('Status is open, done or wontdo');
  const r = resolution === undefined ? '' : text(resolution, NOTE_LIMITS.resolution, true);
  if (r === null) return fail(`The resolution is too long (up to ${NOTE_LIMITS.resolution} characters)`);
  return { ok: true, value: { status: status as NoteStatus, resolution: r } };
}

// ============================================
// For the terminal (scripts/contributor-notes.mjs)
// ============================================

export interface NoteFilter {
  /** Case-insensitive author name */
  author?: string;
  system?: string;
  /** 'all' for every status (default: open) */
  status?: NoteStatus | 'all';
}

/** The notes that pass a filter, sorted by author, then system, then when they were made */
export function filterNotes(notes: readonly ContributorNote[], f: NoteFilter = {}): ContributorNote[] {
  const author = f.author?.toLowerCase();
  const status = f.status ?? 'open';
  return notes
    .filter((n) => (!author || n.author.toLowerCase() === author) && (!f.system || n.system === f.system) && (status === 'all' || n.status === status))
    .sort((a, b) => a.author.toLowerCase().localeCompare(b.author.toLowerCase()) || a.system.localeCompare(b.system) || a.createdAt.localeCompare(b.createdAt));
}

const n0 = (v: number) => Math.round(v).toLocaleString('en-US');
const fmtAngle = (d: number) => `${(Math.round(d * 10) / 10).toFixed(1)}°`;
const fmtDate = (iso: string) => iso.replace('T', ' ').replace(/:\d\d(\.\d+)?Z$/, ' UTC');

/** A shape and its sizes, in world units */
export function describeShape(s: NoteShape): string {
  switch (s.kind) {
    case 'point': return 'point (a pin, no size)';
    case 'circle': return `circle, radius ${n0(s.radius)} u (diameter ${n0(s.radius * 2)} u)`;
    case 'ring': return `ring, inner radius ${n0(s.inner)} u, outer radius ${n0(s.outer)} u (width ${n0(s.outer - s.inner)} u)`;
    case 'rect': return `rectangle ${n0(s.w)} × ${n0(s.h)} u, rotated ${fmtAngle(s.rotationDeg)}`;
    case 'line': case 'arrow': return `${s.kind} from the anchor to offset (${n0(s.dx)}, ${n0(s.dy)}) u, length ${n0(Math.hypot(s.dx, s.dy))} u${s.kind === 'arrow' ? ', head at the far end' : ''}`;
    case 'polygon': return `polygon of ${s.points.length} corners relative to the anchor: ${s.points.map(([x, y]) => `(${n0(x)}, ${n0(y)})`).join(' ')} (reaches ${n0(noteShapeReach(s))} u)`;
  }
}

/** How a note moves, with everything needed to reproduce it in the game data */
export function describeAnchor(a: NoteAnchor, b: NoteBodies, tick: number): string[] {
  if (a.kind === 'fixed') return [`fixed in place at (${n0(a.x)}, ${n0(a.y)})`];
  if (a.kind === 'attached') {
    const at = noteBodyPosition(b, a.to, tick);
    return [`attached to ${noteBodyName(b, a.to)}, offset (${n0(a.dx)}, ${n0(a.dy)}) u from its centre (moves with it)`
      + (at ? `; the body is at (${n0(at.x)}, ${n0(at.y)}) now` : '; that body is not in this system any more')];
  }
  const g = orbitAsGameOrbit(a);
  const lines = [
    `orbit around ${noteBodyName(b, a.around)}, radius ${n0(a.radius)} u from its centre`,
    a.periodMinutes
      ? `period ${a.periodMinutes} min per revolution, direction ${a.direction === 1 ? '+1 (angle increasing: clockwise on screen, like a positive planet period)' : '-1 (counter-clockwise on screen: a negative period)'}`
      : 'period 0 (stays at its phase angle)',
    `phase ${fmtAngle(a.phaseDeg)} at tick 0; angle now ${fmtAngle(orbitAngleDeg(a, tick))}`,
    `as a systems.json orbit: ${JSON.stringify({ radius: g.radius, phase: Math.round(g.phase * 10000) / 10000, period: g.period })}`
      + (a.around.kind === 'center' ? '' : ` with around: "${a.around.id}"${a.around.kind === 'moon' ? `, moon: ${a.around.moon}` : ''} (as nests)`),
  ];
  return lines;
}

/**
 * Notes as plain text an assistant can act on: each one's author, system,
 * title and full text, shape with sizes, movement with its orbit or body, the
 * position now (at `tick`), status and dates
 */
export function formatNotes(notes: readonly ContributorNote[], opts: { bodiesOf: (system: string) => (NoteBodies & { name?: string }) | null; tick: number; tickNote?: string }): string {
  if (!notes.length) return 'No contributor notes match.';
  const out: string[] = [`${notes.length} contributor note${notes.length === 1 ? '' : 's'} · positions at server tick ${n0(opts.tick)}${opts.tickNote ? ` (${opts.tickNote})` : ''}`, ''];
  let author = '';
  for (const n of notes) {
    if (n.author.toLowerCase() !== author) {
      author = n.author.toLowerCase();
      out.push(`=== by ${n.author} ===`, '');
    }
    const b = opts.bodiesOf(n.system) ?? {};
    const pos = noteAnchorPosition(n.anchor, b, opts.tick);
    const sysName = (b as { name?: string }).name;
    out.push(`[${n.status.toUpperCase()}] ${n.id} · system ${sysName ? `${sysName} (${n.system})` : n.system} · "${n.title}"`);
    out.push('  Text:');
    for (const line of (n.text || '(no text)').split('\n')) out.push(`    ${line}`);
    out.push(`  Shape: ${describeShape(n.shape)} · colour ${n.color}`);
    if (n.sizeHint) out.push(`  Size hint: ${n.sizeHint}`);
    const mv = describeAnchor(n.anchor, b, opts.tick);
    out.push(`  Movement: ${mv[0]}`);
    for (const l of mv.slice(1)) out.push(`            ${l}`);
    out.push(pos
      ? `  Position now: (${n0(pos.x)}, ${n0(pos.y)}) world units, ${n0(Math.hypot(pos.x, pos.y))} u from the system centre`
      : '  Position now: unknown (the body it goes with is missing)');
    out.push(`  Status: ${n.status}${n.resolution ? ` · resolution: ${n.resolution}` : ''}${n.statusBy ? ` (by ${n.statusBy})` : ''}`);
    out.push(`  Created ${fmtDate(n.createdAt)} · updated ${fmtDate(n.updatedAt)}`);
    out.push('');
  }
  return out.join('\n').trimEnd() + '\n';
}
