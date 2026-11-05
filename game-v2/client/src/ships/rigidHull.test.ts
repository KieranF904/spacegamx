/**
 * A rigid design (a boss's) is built once, whole: its next stage beneath sorted by the body parts covering it (shown
 * only once they're gone), its details by what they lie on, its skeletons cut into what each carapace piece covers.
 */
import { describe, expect, it } from 'vitest';
import { join } from 'path';
import { createShipState } from '@space-game/common';
import { loadShipConfigFromDisk } from '../../../server/src/ships/loadShipConfig';
import { createShipBridge } from '../../../server/src/proto/createProtoServer';
import { buildHull, skeletonCovered } from './hullBuild';
import { buildSkeleton } from './skeletonBuild';
import { LitGeometry } from '../rendering/lighting/LitGeometry';

describe('a rigid hull', () => {
  const bridge = createShipBridge(loadShipConfigFromDisk(join(__dirname, '../../../data')));
  const ship = createShipState(bridge.catalog, bridge.tuning, 1, bridge.enemyDesigns.pyreclast, 0);
  const geoms = bridge.geometry(ship), cs = bridge.tuning.cellSize;
  const piece = (i: number) => bridge.catalog.pieces.get(ship.blueprint.parts[i].piece)!;

  it('the Pyreclast is rigid, and its hull is built whole once: its heart covered by its body', () => {
    expect(ship.blueprint.rigid).toBe(true);
    const t = performance.now();
    const g = buildHull(bridge.catalog, geoms, ship, cs, undefined, true).hull.full;
    console.log(`whole build ${(performance.now() - t).toFixed(0)}ms, ${g.vertexCount} vertices`);
    // Every part's there
    const parts = new Set(g.part);
    ship.blueprint.parts.forEach((_, i) => { if (!piece(i).skeleton) expect(parts.has(i)).toBe(true); });
    // Its heart: nearly all of it under its body (shown once what's over it goes), none of it bare at the start but where it's open
    let covered = 0, bare = 0;
    for (let t2 = 0; t2 < g.idx.length; t2 += 3) {
      const v = g.idx[t2];
      if (!piece(g.part[v]).under) continue;
      if (g.dep[v * 2 + 1] >= 0) { covered++; expect(piece(g.dep[v * 2 + 1]).under).toBeFalsy(); } else bare++;
    }
    console.log(`heart triangles: ${covered} covered, ${bare} always`);
    expect(covered).toBeGreaterThan(bare * 4);
  });

  it('its skeletons come in pieces, each under a carapace piece', () => {
    const over = (i: number) => !piece(i).skeleton && !piece(i).under;
    ship.blueprint.parts.forEach((p, i) => {
      const sk = piece(i).skeleton;
      if (!sk) return;
      const g = new LitGeometry();
      buildSkeleton(g, sk, ship.derived.com, cs);
      const cut = skeletonCovered(g, geoms, ship.derived.com, cs, over);
      const tris = [...cut.values()].reduce((n, q) => n + q.idx.length / 3, 0);
      console.log(`${p.piece}: ${cut.size} pieces, ${(cut.get(-1)?.idx.length ?? 0) / 3} of ${tris} triangles always shown`);
      expect(cut.size).toBeGreaterThan(5);
      for (const k of cut.keys()) if (k >= 0) expect(over(k)).toBe(true);
    });
  });
});
