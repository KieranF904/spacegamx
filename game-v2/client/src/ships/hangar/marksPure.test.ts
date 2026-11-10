/**
 * Marks only draw, never change a design: every build mark (build/buildMarks, build/portMarks, the hangar's marks and
 * overlays) run over a deeply frozen design and its geometry, onto a canvas that records and ignores. A write to the
 * design would throw (these modules are strict).
 */
import { describe, expect, it } from 'vitest';
import { join } from 'path';
import { blueprintGeometry, createShipState, type PlacedGeom } from '@space-game/common';
import { loadShipConfigCached } from '../../../../server/src/ships/loadShipConfig';
import { createShipBridge } from '../../../../server/src/ships/createShipBridge';
import { drawFacingMark, drawShieldCover, facingMark, shieldCover, coverPolyline } from '../build/buildMarks';
import { portMarks, drawPortMarks } from '../build/portMarks';
import { drawPlacedMarks, drawHandMarks } from './hangarMarks';
import { drawMounting, drawFacing, drawWindow } from './hangarOverlays';
import { sink } from '../../fakeDom.testkit';
import type { HangarHost } from './host';

const bridge = createShipBridge(loadShipConfigCached(join(__dirname, '../../../../data')));

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
}


describe('marks only draw, never change a design', () => {
  for (const name of ['drum', 'sunspear', 'hauler']) {
    it(`${name}: every mark over a frozen design draws without touching it`, () => {
      const ship = createShipState(bridge.catalog, bridge.tuning, 1, bridge.library.get(name)!, 0);
      const geoms = blueprintGeometry(bridge.catalog, ship.blueprint) as PlacedGeom[];
      const before = JSON.stringify([ship.blueprint, geoms]);
      deepFreeze(ship.blueprint); deepFreeze(geoms);
      const host = {
        geoms, ctx: sink(), mouse: [1, 1], ports: { hovering: false }, view: { px: 20, cx: 0, cy: 0 }, deps: { catalog: bridge.catalog },
        partAt: () => 0, paletteHover: null, handTurn: () => ({ rot: 0, flip: false }),
      } as unknown as HangarHost;
      const sx = (x: number) => x * 20, g = sink();
      drawPlacedMarks(host, sx, sx);
      for (const geom of geoms) {
        drawHandMarks(host, geom.part, geom, sx, sx, false);
        facingMark(geom.part, geom);
        const s = shieldCover(geom.part, geom);
        if (s) coverPolyline(s);
        portMarks(geom.part, geom);
        drawFacingMark(g, geom.part, geom, (x, y) => ({ x, y }), 20);
        drawShieldCover(g, geom.part, geom, (x, y) => ({ x, y }), 20, 1);
        drawPortMarks(g, geom.part, geom, (x, y) => ({ x, y }), 20, 1);
        drawMounting(host, geom, [], sx, sx, true);
        drawFacing(host, geom, 'N', sx, sx);
      }
      for (const w of ship.derived.weapons) if (w.window) drawWindow(host, w.window, sx, sx, 1);
      expect(JSON.stringify([ship.blueprint, geoms])).toBe(before);
    });
  }
});
