/**
 * One redraw of the hangar grid (hangarDraw.draw): layer order is grid, turret arcs, parts, placed marks, mounting,
 * groups, overlays, ghost. Each layer is a recorded call here.
 */
import { describe, expect, it, vi } from 'vitest';
import { join } from 'path';
import { blueprintGeometry, createShipState, type PlacedGeom } from '@space-game/common';
import { loadShipConfigCached } from '../../../../server/src/ships/loadShipConfig';
import { createShipBridge } from '../../../../server/src/ships/createShipBridge';
import { sink } from '../../fakeDom.testkit';

const log: string[] = [];
vi.mock('./hangarMarks', () => ({
  drawPlacedMarks: () => log.push('marks'),
  drawHandMarks: () => log.push('ghost'),
  drawHoverCover: () => log.push('hover'),
}));
vi.mock('../weaponGroups/editor', () => ({ drawHangarGroups: () => log.push('groups') }));
vi.mock('../partDecor', () => ({ drawDecor2d: () => log.push('parts') }));
vi.mock('../HangarLitView', () => ({ HangarLitView: class {} }));
import { draw } from './hangarDraw';
import type { HangarHost } from './host';

const bridge = createShipBridge(loadShipConfigCached(join(__dirname, '../../../../data')));

describe('layer order is grid, turret arcs, parts, placed marks, mounting, groups, overlays, ghost', () => {
  it('each layer is drawn after the one before it', () => {
    vi.stubGlobal('window', { devicePixelRatio: 1 });
    log.length = 0;
    const ship = createShipState(bridge.catalog, bridge.tuning, 1, bridge.library.get('drum')!, 0);
    const geoms = blueprintGeometry(bridge.catalog, ship.blueprint) as PlacedGeom[];
    const gridCtx = { setTransform() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fillText: () => log.push('grid'), save() {}, restore() {}, setLineDash() {}, fill() {}, arc() {}, closePath() {}, clearRect() {} };
    const base = {
      isOpen: true, canvas: { clientWidth: 400, clientHeight: 300, width: 400, height: 300 }, grid: { width: 400, height: 300, getContext: () => gridCtx },
      view: { px: 20, cx: 0, cy: 0 }, lit: { setView() {} }, ctx: sink(), aids: { axisX: () => null }, errors: [], unreachable: new Set(),
      derived: { ...ship.derived, weapons: ship.derived.weapons.filter((w) => w.window).slice(0, 1) }, overlays: { arcs: true, connectors: false, joins: false, energy: true, thrust: false, com: false },
      ghostInfo: () => ({ ghosts: new Set<number>(), fresh: new Set<number>() }), geoms, bp: ship.blueprint, deps: { catalog: bridge.catalog, tuning: bridge.tuning, hangarState: () => null },
      mountingBroken: new Map([[0, []]]), mouse: [1, 1],
      drawWindow: (w: { open?: unknown }, _sx: unknown, _sy: unknown, alpha: number) => log.push(alpha === 1 ? 'arcs' : 'ghostArc'),
      drawMounting: (_g: unknown, _b: unknown, _sx: unknown, _sy: unknown, all: boolean) => log.push(all ? 'ghostMount' : 'mounting'),
      ports: { hovering: false, draw: () => log.push('overlay'), flowFrame: () => null, drawGhost: () => {} },
      flow: { show() {}, hide() {} },
      candidate: () => ({ uid: -1, piece: 'sq', fn: 'hull', material: 'alloy', x: 0, y: 0, rot: 0, flip: false }),
      placementProblem: () => null, partName: () => '', slot: 0,
    };
    draw(base as unknown as HangarHost);
    vi.unstubAllGlobals();
    const order = ['grid', 'arcs', 'parts', 'marks', 'mounting', 'groups', 'overlay', 'hover', 'ghost'];
    expect(log.filter((l) => order.includes(l)).filter((l, i, a) => a.indexOf(l) === i)).toEqual(order);
  });
});
