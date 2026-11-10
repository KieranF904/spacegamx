/**
 * Hull build cost, measured (logged, not asserted: timings vary by machine): a full build per design; what a part loss
 * costs the main thread now (the build itself is the hull worker's: runHullJob, run here as the worker runs it); and in
 * a busy scene (the Bastion Dreadnought, the Pyreclast and a wing of small ships together), how much a ShipBatch chunk
 * rebuild copies and how many draws the hulls take. And that the worker's hull is the main thread's, field for field.
 */
import { describe, expect, it, vi } from 'vitest';
import { join } from 'path';
import { Container } from 'pixi.js';
import { blueprintGeometry, createShipState, loadCatalog, rebuildShip, type Blueprint, type ShipState } from '@space-game/common';
import { loadShipConfigFromDisk } from '../../../server/src/ships/loadShipConfig';
import { buildHull } from './hullBuild';
import { fromWire, runHullJob, type DesignCache } from './hullWire';
import { ShipBatch, SOLO_VERTS, type ShipGeometry, type ShipHull } from '../rendering/lighting/ShipBatch';
import { Lighting } from '../rendering/lighting/Lighting';
import { turretHead } from './gunDecor';

// (no WebGL here: the hull program is never compiled, only made)
vi.mock('pixi.js', async (orig) => ({ ...(await orig<typeof import('pixi.js')>()), GlProgram: class { destroy(): void {} } }));

const cfg = loadShipConfigFromDisk(join(__dirname, '../../../data')) as ReturnType<typeof loadShipConfigFromDisk> & { library: Record<string, Blueprint>; enemies: Record<string, Blueprint> };
// (The big-hull case: the Sunspear, the library's largest gunship, since the Bastion Dreadnought left with the pool core)
const catalog = loadCatalog(cfg.catalog as never, { overlapShrink: cfg.tuning.overlapShrink });
const tuning = cfg.tuning, cs = tuning.cellSize;

const time = (n: number, f: () => void) => {
  f();
  const t = performance.now();
  for (let i = 0; i < n; i++) f();
  return (performance.now() - t) / n;
};
const shipOf = (bp: Blueprint, id = 1) => createShipState(catalog, tuning, id, bp, 0);
/** The ship with its last attached non-core part shot off */
function lose(ship: ShipState): ShipState {
  const s = createShipState(catalog, tuning, 2, ship.blueprint, 0);
  const i = s.blueprint.parts.map((p, k) => [p.fn, k] as const).reverse().find(([fn, k]) => fn !== 'core' && s.derived.alive[k])![1];
  s.detached = s.blueprint.parts.map((_, k) => k === i);
  rebuildShip(s, catalog, tuning);
  return s;
}
const fields = ['pos', 'nrm', 'col', 'idx', 'part', 'kind', 'tone', 'hullMat', 'grade', 'engine', 'expo', 'bend', 'dep'] as const;

describe('hull build cost', () => {
  const designs: [string, Blueprint, boolean][] = [
    ['sparrow-t', cfg.library['sparrow-t'], false],
    ['sunspear', cfg.library['sunspear'], false],
    ['boss_scrap_mother (whole)', cfg.enemies.boss_scrap_mother, true],
    ['pyreclast (whole)', cfg.enemies.pyreclast, true],
  ];

  it('builds each design; a part loss costs the main thread only the hand-over', () => {
    const cache: DesignCache = new Map();
    for (const [name, bp, whole] of designs) {
      const ship = shipOf(bp), geoms = blueprintGeometry(catalog, ship.blueprint);
      const runs = whole ? 2 : name === 'sparrow-t' ? 40 : 5;
      let verts = 0, far = 0;
      const ms = time(runs, () => { const h = buildHull(catalog, geoms, ship, cs, undefined, whole).hull; verts = h.full.vertexCount; far = h.far.vertexCount; });
      console.log(`[hullPerf] ${name}: ${bp.parts.length} parts, build ${ms.toFixed(2)} ms, ${verts} full + ${far} far vertices`);
      expect(verts).toBeGreaterThan(0);
      if (whole) continue;
      const hurt = lose(ship);
      const syncMs = time(runs, () => buildHull(catalog, geoms, hurt, cs, undefined, false));
      const job = { id: 1, blueprint: bp, cs, design: 1, kind: 'ship' as const, alive: [...hurt.derived.alive], com: [hurt.derived.com[0], hurt.derived.com[1]] as [number, number] };
      cache.clear();
      const workerMs = time(runs, () => runHullJob(catalog, tuning, job, cache));
      // (what's left on the main thread: the hull key, and the answer turned back into geometry)
      const done = runHullJob(catalog, tuning, job, cache).done;
      const mainMs = time(runs * 20, () => {
        hurt.derived.alive.map((a) => (a ? 1 : 0)).join('');
        fromWire<ShipGeometry>(structuredClone(done.full)); fromWire<ShipGeometry>(structuredClone(done.far));
      });
      console.log(`[hullPerf] ${name}: part loss: main thread before ${syncMs.toFixed(2)} ms (built there); now ${mainMs.toFixed(3)} ms (incl. a copy standing in for the transfer), the worker ${workerMs.toFixed(2)} ms`);
      // The worker's hull is the main thread's
      const here = buildHull(catalog, geoms, hurt, cs, undefined, false), there = fromWire<ShipGeometry>(done.full);
      for (const f of fields) expect(Array.from(there[f] as ArrayLike<number>), f).toEqual(Array.from((here.hull.full as ShipGeometry)[f]).map((v) => Math.fround(v)));
      expect(done.barrels).toEqual(here.barrels);
    }
  });

  it('a busy scene: the boss and the dreadnought have chunks of their own; a small ship arriving copies only its own chunk', () => {
    const lighting = new Lighting(new Container());
    const batch = new ShipBatch(lighting, cs);
    const hullOf = (bp: Blueprint, whole: boolean): ShipHull => { const s = shipOf(bp); return buildHull(catalog, blueprintGeometry(catalog, s.blueprint), s, cs, undefined, whole).hull; };
    const boss = hullOf(cfg.enemies.pyreclast, true), dread = hullOf(cfg.library['sunspear'], false);
    const small = [cfg.library['sparrow-t'], cfg.enemies.pirate_raider, cfg.enemies.pirate_gunship, cfg.enemies.pirate_skiff].map((bp) => hullOf(bp, false));
    const scene: [number, ShipHull][] = [[1, boss], [2, dread], ...Array.from({ length: 20 }, (_, k) => [10 + k, small[k % small.length]] as [number, ShipHull])];
    for (const [id, h] of scene) { batch.track(id, id * 50, 0); batch.set(id, h, 400); }
    for (let f = 0; f < 4; f++) { batch.begin(); for (const [id] of scene) batch.place(id, id * 50, 0, 0, 1); batch.end(1); }
    const v = (h: ShipHull) => h.full.vertexCount + h.far.vertexCount;
    // Before: one chunk for all 22 (under 32, all close), its full and far geometry merged on every change
    const beforeAll = scene.reduce((a, [, h]) => a + v(h), 0);
    console.log(`[hullPerf] scene: ${scene.length} ships, ${scene.reduce((a, [, h]) => a + h.full.vertexCount, 0)} close-in vertices; hull draws before 1, now ${batch.chunkCount} (big hulls >= ${SOLO_VERTS} vertices alone)`);
    expect(batch.chunkCount).toBe(3);
    // A small ship arrives beside the boss
    const before = batch.stats.copied;
    batch.track(99, 60, 0); batch.set(99, small[0], 100);
    batch.begin(); for (const [id] of scene) batch.place(id, id * 50, 0, 0, 1); batch.end(1);
    const copied = batch.stats.copied - before;
    console.log(`[hullPerf] a small ship arrives: vertices copied before ${beforeAll + v(small[0])}, now ${copied}`);
    // (just the shared chunk's close-in geometry: the small ships, now 21 of them)
    expect(copied).toBe(scene.slice(2).reduce((n, [, h]) => n + h.full.vertexCount, 0) + small[0].full.vertexCount);
    // The dreadnought loses a part (a new hull): only its own chunk
    const c0 = batch.stats.copied;
    batch.set(2, hullOf(cfg.library['sunspear'], false), 400);
    batch.begin(); for (const [id] of scene) batch.place(id, id * 50, 0, 0, 1); batch.end(1);
    console.log(`[hullPerf] the dreadnought loses a part: vertices copied before ${beforeAll + v(small[0])}, now ${batch.stats.copied - c0}`);
    // Zoomed far out: the far versions merged once, then not again
    const f0 = batch.stats.farMerges;
    for (let f = 0; f < 3; f++) { batch.begin(); for (const [id] of scene) batch.place(id, id * 50, 0, 0, 1); batch.end(0.001); }
    expect(batch.stats.farMerges - f0).toBe(3);
    // Everyone leaves: the solo chunks go, one shared one kept
    for (const [id] of [...scene, [99]]) batch.remove(id as number);
    for (let f = 0; f < 3; f++) { batch.begin(); batch.end(1); }
    expect(batch.chunkCount).toBe(1);
    batch.destroy();
  });

  it('a fleet of one design shares its gun looks', () => {
    const ship = shipOf(cfg.library['sunspear']), geoms = blueprintGeometry(catalog, ship.blueprint);
    const turrets = ship.derived.weapons.filter((w) => w.window).length;
    const barrels = buildHull(catalog, geoms, ship, cs).barrels.length;
    const looks = new Set(ship.derived.weapons.filter((w) => w.window).map((w) => `${ship.blueprint.parts[w.part].fn}|${w.window!.barrel}|${geoms[w.part].area}`));
    const lit = ship.derived.weapons.filter((w) => w.window).filter((w) => turretHead(ship.blueprint.parts[w.part].fn, w.window!.barrel, geoms[w.part].area).shapes.some((s) => s.glow)).length;
    const fleet = 10;
    // Before: per turret metal + (lit) + crack Graphics, each its own context; per barrel the same. Now: Graphics over shared contexts, cracks only once hurt
    const graphicsBefore = fleet * (turrets * 2 + lit + barrels * 2), graphicsNow = fleet * (turrets + lit + barrels);
    const contextsBefore = graphicsBefore, contextsNow = (looks.size + barrels) * 3;
    console.log(`[hullPerf] ${fleet} dreadnoughts (${turrets} turrets, ${barrels} fixed barrels each): Graphics before ${graphicsBefore}, now ${graphicsNow} (+ cracks on hurt guns); GraphicsContexts built before ${contextsBefore}, now at most ${contextsNow}`);
    expect(turrets + barrels).toBeGreaterThan(0);
  });
});
