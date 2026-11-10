/**
 * Asking the hull worker for a hull (HullDrawer.ask): a design changed in place since it was asked drops the worker's
 * stale answer (ShipRenderer forgets a design's number when it changes in place: DESIGN_NO).
 */
import { describe, expect, it, vi } from 'vitest';
import { join } from 'path';
import { createShipState, type ShipState } from '@space-game/common';
import { loadShipConfigCached } from '../../../../server/src/ships/loadShipConfig';
import { createShipBridge } from '../../../../server/src/ships/createShipBridge';
import { HULLS, DESIGN_NO, hullKey } from './hullCaches';

const jobs: { done: (d: unknown) => void }[] = [];
vi.mock('../hullWorkerClient', () => ({
  HullWorker: class {
    ok = true;
    build(_job: unknown, done: (d: unknown) => void) { jobs.push({ done }); }
    terminate() {}
  },
}));
import { HullDrawer, type HullDrawHost } from './HullDrawer';

const bridge = createShipBridge(loadShipConfigCached(join(__dirname, '../../../../data')));
const answer = () => ({ id: 1, full: { f: {} }, far: { f: {} }, barrels: [], bones: [] });

function rig(name: string, id: number) {
  const ship = createShipState(bridge.catalog, bridge.tuning, id, bridge.library.get(name)!, 0) as ShipState;
  const drawer = new HullDrawer({ bridge: bridge as never, destroyed: () => false } as unknown as HullDrawHost);
  return { ship, drawer };
}

describe('a design changed in place drops a stale worker answer', () => {
  it('the answer is kept for an unchanged design, and dropped for one changed in place since it was asked', () => {
    const kept = rig('hauler', 31);
    kept.drawer.ask(kept.ship, 20, undefined);
    jobs.pop()!.done(answer());
    expect(HULLS.get(kept.ship.blueprint)?.has(hullKey(kept.ship, undefined))).toBe(true);

    const stale = rig('bulwark', 32);
    stale.drawer.ask(stale.ship, 20, undefined);
    DESIGN_NO.delete(stale.ship.blueprint); // (ShipRenderer: the design was edited in place)
    jobs.pop()!.done(answer());
    expect(HULLS.get(stale.ship.blueprint)?.has(hullKey(stale.ship, undefined)) ?? false).toBe(false);
  });
});
