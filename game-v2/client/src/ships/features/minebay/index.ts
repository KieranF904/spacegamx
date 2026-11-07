/**
 * The Mine Bay's client half (shared half: common/src/ships/features/minebay; docs/design/groups-mines-docking.md,
 * package M): the drop key (Digit0, "Drop mines"), the magazine chip, and the mines drawn from their drops (mines.ts,
 * MinesLayer.ts). The server's three messages reach mines.ts through app/serverMessages.ts.
 */
import type { ClientFeature, ClientFeatureHost } from '../types';
import { mineClient } from './mines';
import { MinesLayer } from './MinesLayer';
import { MineChip } from './MineChip';

const KEY = 'Digit0';
const layer = new MinesLayer();
const chip = new MineChip();

/** The drawing tick of a mine: yours on your own ship's timeline, others' on the replicas' */
function tickOf(host: ClientFeatureHost, me: number): (owner: number) => number {
  const own = host.tick?.(true) ?? 0, other = host.tick?.(false) ?? 0;
  return (owner) => (owner === me ? own : other);
}

/** The drop key: the batch drawn at once (predicted), and the press sent with its tick */
function drop(host: ClientFeatureHost): void {
  const me = host.playerId(), ship = host.ship(me), e = host.entity(me);
  const info = ship?.kind === 'ship' ? ship.derived.fx?.minebay : undefined;
  if (!ship || !e || !info?.bays.length) {
    const fitted = !!ship?.blueprint.parts.some((p) => host.catalog.functions.get(p.fn)?.mineBay);
    host.showMessage(fitted ? 'The Mine Bay is destroyed' : 'No Mine Bay fitted: build one in the hangar to drop mines', '#f2d24b');
    return;
  }
  const tick = Math.floor(host.tick?.(true) ?? 0);
  if (mineClient.bay && mineClient.loaded(info) <= 0) { host.showMessage('No mines loaded: the fabricator makes more', '#f2d24b'); return; }
  const d = tick > 0 && host.cellSize ? mineClient.press(me, info, ship.derived.com, host.cellSize, { x: e.x, y: e.y, angle: e.angle, vx: e.vx, vy: e.vy }, tick) : null;
  // (Cooling down: nothing to send; not told yet: the server decides)
  if (!d && mineClient.bay) return;
  host.send(tick > 0 ? { type: 'mineDrop', tick } : { type: 'mineDrop' });
}

let seen = { me: -1, sys: '' };

export const clientFeature: ClientFeature = {
  id: 'minebay',
  actions: [
    { id: 'dropMines', label: 'Drop mines', category: 'Combat', key: KEY, after: 'siegeFocus', hint: 'Drops a batch of proximity mines from your Mine Bay. They arm after a second and never go off for you or your party' },
  ],
  onKey(code, host) {
    if (code !== KEY || host.hangarOpen()) return false;
    drop(host);
    return true;
  },
  beginFrame(shared, host) {
    const me = host.playerId(), sys = host.systemId?.() ?? '';
    // (A new ship, or another system: what was known is gone; the server tells this one's mines afresh)
    if (me !== seen.me || sys !== seen.sys) { mineClient.reset(); seen = { me, sys }; }
    if (!mineClient.drops.length && !mineClient.blasts.length) return;
    layer.draw(shared, mineClient, me, tickOf(host, me), performance.now());
  },
  indicator: {
    update(host) {
      const me = host.playerId(), ship = host.ship(me);
      const info = !host.hangarOpen() && ship?.kind === 'ship' ? ship.derived.fx?.minebay : undefined;
      if (!info?.bays.length) { chip.update(null, ''); return; }
      const now = host.tick?.(true) ?? 0, b = mineClient.bay;
      const loaded = mineClient.loaded(info);
      const wait = b && b.readyAt > now ? (b.readyAt - now) / 60 : 0;
      chip.update({ loaded, capacity: info.bays.reduce((s, x) => s + x.capacity, 0), wait }, host.keyName('dropMines'));
    },
  },
};
