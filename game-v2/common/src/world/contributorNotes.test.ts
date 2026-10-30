import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { StarSystemData, StationData } from '../data/schemas.js';
import { planetPosition, moonOffset } from './planets.js';
import { nestPosition } from './nests.js';
import {
  noteAnchorPosition, orbitThrough, parseNoteDraft, parseNoteStatus, filterNotes, formatNotes, nearestNoteBody, NOTE_LIMITS,
  type ContributorNote, type NoteBodies, type NoteDraft,
} from './contributorNotes.js';

const data = join(__dirname, '../../../data');
const systems = (JSON.parse(readFileSync(join(data, 'systems.json'), 'utf-8')) as { systems: StarSystemData[] }).systems;
const stations = (JSON.parse(readFileSync(join(data, 'stations.json'), 'utf-8')) as { stations: StationData[] }).stations;
const bodiesOf = (id: string): (NoteBodies & { name: string }) | null => {
  const s = systems.find((x) => x.id === id);
  return s ? { name: s.name, planets: s.planets, nests: s.nests, lodestones: s.lodestones, stations: stations.filter((st) => st.system === id) } : null;
};
const sol = bodiesOf('sol')!;
const ashfall = bodiesOf('ashfall')!;
const close = (a: { x: number; y: number } | null, b: { x: number; y: number }) => {
  expect(a).not.toBeNull();
  expect(a!.x).toBeCloseTo(b.x, 6);
  expect(a!.y).toBeCloseTo(b.y, 6);
};
const TICKS = [0, 1, 3600, 123_457, 9_876_543];

describe('contributor note positions', () => {
  it('an orbit with a planet\'s numbers goes exactly where the planet goes', () => {
    const pl = sol.planets!.find((p) => p.orbit.period)!;
    const anchor = { kind: 'orbit' as const, around: { kind: 'center' as const }, radius: pl.orbit.radius, phaseDeg: (pl.orbit.phase * 180) / Math.PI, periodMinutes: Math.abs(pl.orbit.period), direction: (Math.sign(pl.orbit.period) || 1) as 1 | -1 };
    for (const t of TICKS) close(noteAnchorPosition(anchor, sol, t), planetPosition(pl, t));
  });

  it('an orbit round a moon follows the nests\' maths (Ashfall\'s dig round Cinderjack\'s moon)', () => {
    const n = ashfall.nests!.find((x) => x.moon !== undefined)!;
    const anchor = { kind: 'orbit' as const, around: { kind: 'moon' as const, id: n.around!, moon: n.moon! }, radius: n.orbit.radius, phaseDeg: (n.orbit.phase * 180) / Math.PI, periodMinutes: Math.abs(n.orbit.period), direction: (Math.sign(n.orbit.period) || 1) as 1 | -1 };
    for (const t of TICKS) close(noteAnchorPosition(anchor, ashfall, t), nestPosition(n, ashfall.planets, t));
  });

  it('attached notes ride with their body at their offset', () => {
    const pl = sol.planets!.find((p) => p.moons?.length)!;
    for (const t of TICKS) {
      const p = planetPosition(pl, t), m = moonOffset(pl, 0, t);
      close(noteAnchorPosition({ kind: 'attached', to: { kind: 'planet', id: pl.id }, dx: 500, dy: -250 }, sol, t), { x: p.x + 500, y: p.y - 250 });
      close(noteAnchorPosition({ kind: 'attached', to: { kind: 'moon', id: pl.id, moon: 0 }, dx: 0, dy: 0 }, sol, t), { x: p.x + m.x, y: p.y + m.y });
      const nest = sol.nests![0];
      close(noteAnchorPosition({ kind: 'attached', to: { kind: 'nest', id: nest.id }, dx: 10, dy: 0 }, sol, t), { x: nestPosition(nest, sol.planets, t).x + 10, y: nestPosition(nest, sol.planets, t).y });
    }
    expect(noteAnchorPosition({ kind: 'attached', to: { kind: 'planet', id: 'nowhere' }, dx: 0, dy: 0 }, sol, 0)).toBeNull();
  });

  it('an orbit through a clicked point is at that point when it was placed, and moves on after', () => {
    const t = 777_777;
    const pl = sol.planets![2];
    const at = planetPosition(pl, t);
    const pt = { x: at.x + 3000, y: at.y - 1200 };
    const o = orbitThrough({ kind: 'planet', id: pl.id }, pt.x, pt.y, sol, t, 12, -1);
    const got = noteAnchorPosition(o, sol, t)!;
    expect(got.x).toBeCloseTo(pt.x, 0);
    expect(got.y).toBeCloseTo(pt.y, 0);
    expect(Math.hypot(noteAnchorPosition(o, sol, t + 3600)!.x - got.x, 1)).toBeGreaterThan(1);
  });

  it('finds the nearest body to a point', () => {
    const pl = sol.planets![1];
    const at = planetPosition(pl, 5000);
    const n = nearestNoteBody(sol, at.x + 5, at.y, 5000)!;
    expect(n.ref).toEqual({ kind: 'planet', id: pl.id });
  });
});

describe('contributor note validation', () => {
  const ok: NoteDraft = { system: 'sol', title: 'Water world', text: 'Place a large water planet here\nthe same size as the circle', color: '#38bdf8',
    shape: { kind: 'circle', radius: 4200 }, anchor: { kind: 'orbit', around: { kind: 'center' }, radius: 52000, phaseDeg: 30, periodMinutes: 45, direction: 1 } };
  const parse = (d: unknown) => parseNoteDraft(d, bodiesOf);

  it('takes a good note, cleaned', () => {
    const r = parse({ ...ok, title: '  Water world\u0007 ', extra: 'dropped' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.title).toBe('Water world');
      expect(r.value.text).toContain('\n');
      expect((r.value as unknown as Record<string, unknown>).extra).toBeUndefined();
    }
  });

  it('refuses bad systems, bodies, numbers, lengths and shapes', () => {
    const bad: unknown[] = [
      { ...ok, system: 'atlantis' },
      { ...ok, title: '' },
      { ...ok, title: 'x'.repeat(NOTE_LIMITS.title + 1) },
      { ...ok, text: 'x'.repeat(NOTE_LIMITS.text + 1) },
      { ...ok, color: 'red' },
      { ...ok, shape: { kind: 'circle', radius: Infinity } },
      { ...ok, shape: { kind: 'circle', radius: NaN } },
      { ...ok, shape: { kind: 'circle', radius: -5 } },
      { ...ok, shape: { kind: 'circle', radius: 1e12 } },
      { ...ok, shape: { kind: 'ring', inner: 500, outer: 400 } },
      { ...ok, shape: { kind: 'polygon', points: [[0, 0], [1, 1]] } },
      { ...ok, shape: { kind: 'polygon', points: Array.from({ length: NOTE_LIMITS.polygonPoints + 1 }, (_, i) => [i, i * 2]) } },
      { ...ok, shape: { kind: 'hexagon' } },
      { ...ok, anchor: { kind: 'fixed', x: 'a', y: 0 } },
      { ...ok, anchor: { kind: 'orbit', around: { kind: 'planet', id: 'nowhere' }, radius: 10 } },
      { ...ok, anchor: { kind: 'orbit', around: { kind: 'moon', id: 'vesta', moon: 3 }, radius: 10 } },
      { ...ok, anchor: { kind: 'attached', to: { kind: 'station', id: 'ash_station' } } },
      { ...ok, anchor: { kind: 'teleport' } },
      'a string',
    ];
    for (const b of bad) expect(parse(b).ok, JSON.stringify(b).slice(0, 120)).toBe(false);
  });

  it('checks statuses', () => {
    expect(parseNoteStatus('done', 'Added Halcyon II').ok).toBe(true);
    expect(parseNoteStatus('finished', '').ok).toBe(false);
    expect(parseNoteStatus('done', 'x'.repeat(NOTE_LIMITS.resolution + 1)).ok).toBe(false);
  });
});

describe('contributor notes for the terminal', () => {
  const note = (o: Partial<ContributorNote>): ContributorNote => ({
    id: 'n_1', author: 'brotherk3d', authorId: 2, createdAt: '2026-10-25T13:00:00.000Z', updatedAt: '2026-10-25T13:05:00.000Z',
    system: 'sol', title: 'Water world', text: 'Place a large water planet here\nthe same size as the circle', status: 'open',
    shape: { kind: 'circle', radius: 4200 }, color: '#38bdf8',
    anchor: { kind: 'orbit', around: { kind: 'center' }, radius: 52000, phaseDeg: 90, periodMinutes: 45, direction: 1 },
    sizeHint: 'match circle size', ...o,
  });
  const notes = [
    note({}),
    note({ id: 'n_2', author: 'Zed', system: 'ashfall', title: 'Pirate den', shape: { kind: 'point' }, anchor: { kind: 'fixed', x: 1000, y: -2000 } }),
    note({ id: 'n_3', author: 'BrotherK3D', system: 'borealis', title: 'Done one', status: 'done', resolution: 'Added' }),
    note({ id: 'n_4', author: 'alice', title: 'Station ring', createdAt: '2026-10-24T09:00:00.000Z', shape: { kind: 'ring', inner: 900, outer: 1400 },
      anchor: { kind: 'attached', to: { kind: 'station', id: 'sol_station_central' }, dx: 0, dy: 0 } }),
  ];

  it('filters by author (any case) and status, sorted by author then system', () => {
    expect(filterNotes(notes).map((n) => n.id)).toEqual(['n_4', 'n_1', 'n_2']);
    expect(filterNotes(notes, { author: 'BROTHERK3D', status: 'all' }).map((n) => n.id)).toEqual(['n_3', 'n_1']);
    expect(filterNotes(notes, { status: 'done' }).map((n) => n.id)).toEqual(['n_3']);
    expect(filterNotes(notes, { system: 'ashfall' }).map((n) => n.id)).toEqual(['n_2']);
  });

  it('prints everything needed to build it', () => {
    const out = formatNotes(filterNotes(notes, { author: 'brotherk3d' }), { bodiesOf, tick: 0, tickNote: 'test' });
    expect(out).toContain('=== by brotherk3d ===');
    expect(out).toContain('[OPEN] n_1 · system Sol System (sol) · "Water world"');
    expect(out).toContain('    Place a large water planet here\n    the same size as the circle');
    expect(out).toContain('Shape: circle, radius 4,200 u (diameter 8,400 u) · colour #38bdf8');
    expect(out).toContain('Size hint: match circle size');
    expect(out).toContain('orbit around the system centre, radius 52,000 u');
    expect(out).toContain('period 45 min per revolution');
    expect(out).toContain('phase 90.0° at tick 0; angle now 90.0°');
    expect(out).toContain('as a systems.json orbit: {"radius":52000,"phase":1.5708,"period":45}');
    // At tick 0 a 90° phase is straight down (y grows down the screen)
    expect(out).toContain('Position now: (0, 52,000) world units, 52,000 u from the system centre');
    expect(out).toContain('Created 2026-10-25 13:00 UTC · updated 2026-10-25 13:05 UTC');
    // A quarter turn later (45 min / 4) it has gone round to the west
    expect(formatNotes([notes[0]], { bodiesOf, tick: 45 * 3600 / 4 })).toContain('Position now: (-52,000, 0)');
    const st = formatNotes([notes[3]], { bodiesOf, tick: 0 });
    expect(st).toContain('ring, inner radius 900 u, outer radius 1,400 u (width 500 u)');
    expect(st).toContain('attached to station Sol Central Station (sol_station_central)');
    expect(formatNotes([], { bodiesOf, tick: 0 })).toBe('No contributor notes match.');
  });
});
