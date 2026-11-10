/**
 * The rebuild's caches give the same ship as working everything out afresh (rebuild.ts RebuildMemo, design.ts,
 * state.ts splitRebuild): over seeded sequences of losses, sheds, hits, repairs and ghosts on every library ship, a ship
 * rebuilt as the game does (its memo, the design caches, one rebuild a split) is deep-equal, field for field, to one
 * rebuilt the old way (every turret ray and exhaust lane cast afresh, the design worked out anew, a split rebuilt twice).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { loadCatalog, type Catalog } from './catalog.js';
import { parseBlueprint, partMount } from './blueprint.js';
import { rebuild, type ShipDerived } from './rebuild.js';
import { createShipState, damagePart, rebuildShip, repairShip, restorePart, splitRebuild, type ShipState } from './state.js';
import { computeTurretWindow } from './turret.js';
import { designOf } from './design.js';
import { crumbleRebuild } from './debrisLife.js';
import { SHIP_DATA_DIR, readCatalogFiles, readShipJson } from './testData.js';
import type { Blueprint, PlacedPart, Rot } from './types.js';
import type { ShipTuning } from './tuning.js';

const tuning = readShipJson<ShipTuning>('tuning.json');
const catalog: Catalog = loadCatalog(readCatalogFiles(), { overlapShrink: tuning.overlapShrink });

/** Every design under data/ships/blueprints (the plan library, enemies, dev ships, fixtures), by size */
function library(): [string, Blueprint][] {
  const out: [string, Blueprint][] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir).sort()) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f.endsWith('.json')) {
        try { out.push([p.slice(SHIP_DATA_DIR.length + 1), parseBlueprint(readFileSync(p, 'utf-8'))]); } catch { /* not a blueprint */ }
      }
    }
  };
  walk(join(SHIP_DATA_DIR, 'blueprints'));
  return out.filter(([, bp]) => bp.parts.length > 0).sort((a, b) => a[1].parts.length - b[1].parts.length);
}

/** Deep and strict (keys, prototypes, Object.is), fast; on a difference, vitest's toStrictEqual says where */
function same<T>(a: T, b: T): void {
  if (!deepSame(a, b)) expect(a).toStrictEqual(b);
}
function deepSame(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b || Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (ArrayBuffer.isView(a)) {
    const x = a as unknown as ArrayLike<number>, y = b as unknown as ArrayLike<number>;
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (!Object.is(x[i], y[i])) return false;
    return true;
  }
  if (a instanceof Map || a instanceof Set) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.prototype.hasOwnProperty.call(b, k) || !deepSame((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  return true;
}

/** rebuildShip, the old way: every ray and lane cast afresh, the design worked out anew */
function refRebuildShip(s: ShipState): void {
  const before = s.derived ? s.derived.alive : null;
  s.derived = rebuild({ catalog, tuning, blueprint: s.blueprint, hp: s.hp, maxHp: s.maxHp, detached: s.detached, ghost: s.ghost, rootMode: s.kind === 'ship' ? 'core' : 'largest', fresh: true });
  s.rebuildHp = [...s.hp];
  s.dirty = false;
  s.rebuilds++;
  if (before) for (const w of s.derived.weapons) {
    if (before[w.part]) continue;
    s.rounds[w.part] = w.fire.model === 'clip' ? w.fire.clip ?? 0 : 0;
    s.reload[w.part] = 0; s.charge[w.part] = 0; s.spin[w.part] = 0;
  }
}

/** The rebuild point, the old way: rebuild, what broke off detached, rebuild again; each rebuild noted as it was */
function refSplit(s: ShipState, notes: [number, ShipDerived['com'], number][]): number[][] {
  refRebuildShip(s);
  notes.push([s.rebuilds, s.derived.com, s.derived.root]);
  const groups = s.derived.orphanGroups.map((g) => [...g]);
  if (groups.length) {
    for (const g of groups) for (const i of g) s.detached[i] = true;
    refRebuildShip(s);
    notes.push([s.rebuilds, s.derived.com, s.derived.root]);
  }
  return groups;
}

function newPair(bp: Blueprint, kind: 'ship' | 'debris'): [ShipState, ShipState] {
  const a = createShipState(catalog, tuning, 1, bp, 0, { kind });
  const b = createShipState(catalog, tuning, 1, bp, 0, { kind });
  // (b as the old code would have built it)
  b.rebuilds = 0;
  refRebuildShip(b);
  return [a, b];
}

/** One seeded sequence on a design: the same steps on both, compared after each */
function runSequence(bp: Blueprint, kind: 'ship' | 'debris', seed: number, steps: number): number {
  let s = seed >>> 0 || 1;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const [a, b] = newPair(bp, kind);
  same(a.derived, b.derived);
  const n = bp.parts.length;
  const pick = (ok: (i: number) => boolean) => { const l: number[] = []; for (let i = 0; i < n; i++) if (ok(i)) l.push(i); return l.length ? l[Math.floor(rnd() * l.length)] : -1; };
  let splits = 0;
  for (let k = 0; k < steps; k++) {
    const r = rnd();
    const both = (f: (x: ShipState) => void) => { f(a); f(b); };
    if (r < 0.55) {
      // A part shot away (the core now and then)
      const i = pick((j) => a.derived.alive[j] && (bp.parts[j].fn !== 'core' || rnd() < 0.05));
      if (i < 0) break;
      both((x) => damagePart(x, i, Infinity, tuning));
    } else if (r < 0.65) {
      // Several at once, as a blast does
      for (let m = 0; m < 3; m++) { const i = pick((j) => a.derived.alive[j] && bp.parts[j].fn !== 'core'); if (i >= 0) both((x) => damagePart(x, i, Infinity, tuning)); }
    } else if (r < 0.72) {
      // A piece shed whole (detached, as ShipBridge.shed does)
      const i = pick((j) => a.derived.alive[j] && bp.parts[j].fn !== 'core');
      if (i >= 0) both((x) => { x.detached[i] = true; });
    } else if (r < 0.8) {
      // A hit that only crosses an HP band
      const i = pick((j) => a.derived.alive[j]);
      if (i >= 0) both((x) => damagePart(x, i, x.maxHp[i] * 0.3, tuning));
    } else if (r < 0.88) {
      // A part rebuilt (a station's regrowth, a kit): parts come back
      const i = pick((j) => !a.derived.alive[j] && !a.ghost[j]);
      if (i >= 0) both((x) => restorePart(x, i, 0.5));
    } else if (r < 0.92) {
      both((x) => repairShip(x));
    } else if (r < 0.97) {
      // A ghost (a hangar part not built yet) and back
      const i = pick((j) => bp.parts[j].fn !== 'core');
      if (i >= 0) { const g = !a.ghost[i]; both((x) => { x.ghost[i] = g; }); }
    }
    // (else: a rebuild with nothing changed)
    const notes: [number, ShipDerived['com'], number][] = [];
    const got = splitRebuild(a, catalog, tuning, (rebuilds, d) => notes.push([rebuilds, d.com, d.root]));
    const want: [number, ShipDerived['com'], number][] = [];
    const wantGroups = refSplit(b, want);
    if (wantGroups.length) splits++;
    same(got, wantGroups);
    same(notes, want);
    same(a, b);
    if (a.derived.root < 0) break;
  }
  return splits;
}

describe('rebuild caches: the same ship as worked out afresh', () => {
  const ships = library();

  it('reads the library (big designs included)', () => {
    expect(ships.length).toBeGreaterThan(50);
    expect(ships[ships.length - 1][1].parts.length).toBeGreaterThanOrEqual(200);
  });

  it('every library ship, seeded part-loss sequences (losses, blasts, sheds, hits, repairs, ghosts)', () => {
    let splits = 0, turrets = 0;
    ships.forEach(([, bp], k) => {
      const big = bp.parts.length >= 150;
      const runs = big ? 3 : 1;
      for (let r = 0; r < runs; r++) splits += runSequence(bp, 'ship', 1000 + k * 31 + r, Math.min(80, bp.parts.length + 10));
      turrets += bp.parts.filter((p) => partMount(catalog, p) === 'turret').length;
    });
    // (It exercised what it's for: splits, and turrets to cast)
    expect(splits).toBeGreaterThan(20);
    expect(turrets).toBeGreaterThan(20);
  }, 300_000);

  it('engines with blocked lanes: a blocker shot away opens one, a repair closes it again', () => {
    // (No library design has a blocked engine: a Torch with armour across its lanes, held on by a frame, as exhaust.test.ts)
    const P = (uid: number, piece: string, fn: string, x: number, y: number, extra: Partial<PlacedPart> = {}): PlacedPart =>
      ({ uid, piece, fn, material: catalog.functions.get(fn)?.material ?? 'alloy', x, y, rot: 0 as Rot, flip: false, ...extra });
    const bp: Blueprint = {
      name: 'blocked', catalogVersion: 1,
      parts: [
        P(0, 'rect2', 'core', 0, 0), P(1, 'sq', 'power_cell_reactor', 0, 1, { rot: 2 }), P(2, 'sq', 'power_cell_reactor', 1, 1, { rot: 2 }),
        P(3, 'rect2', 'engine_torch', 0, 2, { facing: 'S' }), ...[1, 2, 3, 4, 5].map((y) => P(10 + y, 'sq', 'hull', 2, y)),
        P(6, 'sq', 'armor', 0, 4), P(7, 'sq', 'armor', 1, 5), P(8, 'sq', 'hull', 1, 4), P(9, 'sq', 'hull', 0, 5),
      ],
    };
    const shares = new Set<number>();
    for (let seed = 1; seed <= 60; seed++) {
      runSequence(bp, 'ship', seed, 12);
      const s = createShipState(catalog, tuning, 1, bp, 0);
      shares.add(s.derived.thrusters[0]?.exhaust ?? 1);
    }
    expect(shares.has(1)).toBe(false);
  });

  it('debris (the largest piece stays), worn down part by part', () => {
    for (const [, bp] of ships.filter(([, b]) => b.parts.length >= 40)) runSequence(bp, 'debris', 77 + bp.parts.length, 40);
  }, 300_000);

  it("a client's crumbling debris rebuilds as the old way did (debrisLife.ts crumbleRebuild)", () => {
    const [, bp] = ships[ships.length - 1];
    const [a, b] = newPair(bp, 'debris');
    for (let k = 0; k < 30; k++) {
      const parts = [k * 7 % bp.parts.length, (k * 13 + 5) % bp.parts.length];
      const got = crumbleRebuild(a, parts, catalog, tuning);
      for (const i of parts) damagePart(b, i, Infinity, tuning);
      same(got, refSplit(b, []));
      same(a, b);
    }
  });

  it('ships with different histories rebuild alike (a client that missed rebuilds, the server that saw them)', () => {
    const [, bp] = ships[ships.length - 1];
    const server = createShipState(catalog, tuning, 1, bp, 0);
    let seed = 5;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let k = 0; k < 40; k++) {
      const live = server.derived.alive.map((x, i) => (x && bp.parts[i].fn !== 'core' ? i : -1)).filter((i) => i >= 0);
      damagePart(server, live[Math.floor(rnd() * live.length)], Infinity, tuning);
      splitRebuild(server, catalog, tuning);
      if (k % 10 !== 9) continue;
      // (A client's copy, synced now: new to the ship, the design seen before)
      const client = createShipState(catalog, tuning, 1, bp, 0);
      client.hp = [...server.hp]; client.detached = [...server.detached];
      rebuildShip(client, catalog, tuning);
      expect(client.derived).toStrictEqual(server.derived);
    }
  });

  it('a blueprint edited in place (the hangar) is worked out again', () => {
    const bp = JSON.parse(JSON.stringify(ships.find(([, b]) => b.parts.some((p) => partMount(catalog, p) === 'turret') && b.parts.length > 30)![1])) as Blueprint;
    const s = createShipState(catalog, tuning, 1, bp, 0);
    const d0 = designOf(catalog, bp);
    // Moved and turned in place, then a part added and one taken away (a new parts array)
    const p = bp.parts.find((q) => q.fn !== 'core')!;
    p.x += 40; p.rot = ((p.rot + 1) % 4) as typeof p.rot;
    rebuildShip(s, catalog, tuning);
    expect(designOf(catalog, bp)).not.toBe(d0);
    const fresh = rebuild({ catalog, tuning, blueprint: bp, hp: s.hp, maxHp: s.maxHp, detached: s.detached, ghost: s.ghost, rootMode: 'core', fresh: true });
    expect(s.derived).toStrictEqual(fresh);
    bp.parts.push({ ...bp.parts[bp.parts.length - 1], uid: 250, x: bp.parts[bp.parts.length - 1].x + 1 });
    const t = createShipState(catalog, tuning, 2, bp, 0);
    expect(t.derived).toStrictEqual(rebuild({ catalog, tuning, blueprint: bp, hp: t.hp, maxHp: t.maxHp, detached: t.detached, ghost: t.ghost, rootMode: 'core', fresh: true }));
  });

  it('a turret window cast with its rays carried on equals one cast afresh, and the memo is not state', () => {
    const [, bp] = [...ships].reverse().find(([, b]) => b.parts.filter((p) => partMount(catalog, p) === 'turret').length >= 4)!;
    const s = createShipState(catalog, tuning, 1, bp, 0);
    const geoms = designOf(catalog, bp).geoms;
    for (let k = 0; k < 30 && s.derived.root >= 0; k++) {
      const i = s.derived.alive.findIndex((x, j) => x && j % 3 === k % 3 && bp.parts[j].fn !== 'core');
      if (i < 0) break;
      damagePart(s, i, Infinity, tuning);
      splitRebuild(s, catalog, tuning);
      for (const w of s.derived.weapons) if (w.window) expect(w.window).toStrictEqual(computeTurretWindow(geoms, s.derived.alive, w.part, w.dir, tuning, catalog.functions.get(bp.parts[w.part].fn)!.mounting?.arc));
    }
    expect(Object.keys(s)).not.toContain('memo');
    expect(JSON.stringify(s)).not.toContain('turrets');
  });
});
