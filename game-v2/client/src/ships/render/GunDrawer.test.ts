/**
 * Turret heads each frame (GunDrawer.drawTurrets): a gun too small on screen is neither drawn nor turned.
 */
import { describe, expect, it, vi } from 'vitest';
import { join } from 'path';
import { Container } from 'pixi.js';
import { createShipState, type ShipState } from '@space-game/common';
import { loadShipConfigCached } from '../../../../server/src/ships/loadShipConfig';
import { createShipBridge } from '../../../../server/src/ships/createShipBridge';

vi.mock('../gunDecor', async (orig) => ({
  ...(await orig<typeof import('../gunDecor')>()),
  turretHead: () => ({ shapes: [{ pts: [0, 0, 4, 0, 4, 4], color: 0x888888 }], outline: [] }),
}));
import { GunDrawer, type GunDrawHost } from './GunDrawer';
import { GUN_MIN_PX } from './constants';
import type { BodyView } from './viewTypes';

const bridge = createShipBridge(loadShipConfigCached(join(__dirname, '../../../../data')));

function rig(zoom: number) {
  const ship = createShipState(bridge.catalog, bridge.tuning, 1, bridge.library.get('drum')!, 0) as ShipState;
  const host = { catalog: bridge.catalog, geometry: (s: ShipState) => bridge.geometry(s), renderer: { getZoom: () => zoom, ventPuff: () => {} }, playerId: 1, lvl: [1, 1, 1] } as unknown as GunDrawHost;
  const view = { guns: new Container(), barrels: new Container(), turrets: [], fixed: [], container: new Container() } as unknown as BodyView;
  return { ship, view, drawer: new GunDrawer(host) };
}
const cs = bridge.tuning.cellSize;

describe('a gun too small on screen is neither drawn nor turned', () => {
  it('zoomed out below GUN_MIN_PX the guns are hidden and the turret heads stay where they were', () => {
    const near = rig(GUN_MIN_PX / cs * 2);
    near.drawer.drawTurrets(near.view, near.ship, cs, 1);
    expect(near.view.guns.visible).toBe(true);
    expect(near.view.turrets.length).toBeGreaterThan(0);
    // the aim swings away: a drawn turret eases after it
    for (const w of near.ship.derived.weapons) near.ship.aim[w.part] = 0.8;
    const before = near.view.turrets.map((t) => t.barrel.rotation);
    near.drawer.drawTurrets(near.view, near.ship, cs, 1);
    expect(near.view.turrets.map((t) => t.barrel.rotation)).not.toEqual(before);

    const far = rig(GUN_MIN_PX / cs / 2);
    far.drawer.drawTurrets(far.view, far.ship, cs, 1);
    expect(far.view.guns.visible).toBe(false);
    for (const w of far.ship.derived.weapons) far.ship.aim[w.part] = 0.8;
    const turned = far.view.turrets.map((t) => t.barrel.rotation);
    far.drawer.drawTurrets(far.view, far.ship, cs, 1);
    expect(far.view.turrets.map((t) => t.barrel.rotation)).toEqual(turned);
    expect(far.view.guns.visible).toBe(false);
  });
});
