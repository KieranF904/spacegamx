/**
 * @contract feature.tow.client
 * owns:       the Tow Beam client half: key, pilot row reads, tether drawing, HUD chip
 * needs:      ClientFeature, pixi.js, common canTow / cargoThrust / getPlan, TowIndicator, tether
 * invariants: its keys, parsers, drawers and chips run in feature id order and the first key user wins —
 *             client/src/ships/features/host.test.ts
 * extend:     a new behaviour is a method on the instance created below (FeatureInstance hooks, types.ts)
 */

/**
 * The Tow Beam's client half (shared half: common/src/ships/features/tow): its key, what it reads from the pilot's row,
 * the tether it draws, and its HUD chip.
 */
import { Graphics } from 'pixi.js';
import { EntityType, canTow, cargoThrust, getPlan } from '@space-game/common';
import type { ClientFeature, ClientFeatureHost, ShipDrawCtx } from '../types';
import { TowIndicator } from './TowIndicator';
import { drawTether } from './tether';

/** The wire slots features.wire.json pins to the Tow Beam: its place among the pilot row's extras, and in the status row others get */
let slots: { pilot: number; status: number } | undefined;
function slotsOf(): { pilot: number; status: number } {
  if (!slots) {
    const r = getPlan().replicate;
    slots = {
      pilot: r.find((x) => x.feature === 'tow' && x.where === 'pilotExtra')!.slot,
      status: r.find((x) => x.feature === 'tow' && x.where === 'status')!.slot,
    };
  }
  return slots;
}

/** What the server says this pilot's own beam tows (entity id + 1, 0 nothing) */
const ownTow = (host: ClientFeatureHost): number => host.entity(host.playerId())?.fx?.tow ?? 0;

/** The tow key (U): take hold of what's nearest the cursor, or let go */
function toggleTow(host: ClientFeatureHost): void {
  if (ownTow(host) > 0) { host.send({ type: 'tow', on: false }); return; }
  const ship = host.ship(host.playerId());
  if (!ship || ship.kind !== 'ship' || !ship.derived.fx?.tow) { host.showMessage('No Tow Beam fitted: build one in the hangar to tow', '#f2d24b'); return; }
  if (!canTow(ship.derived)) { host.showMessage('The Tow Beam has no power', '#f2d24b'); return; }
  host.send({ type: 'tow', on: true });
}

const chip = new TowIndicator();
let tethers: Graphics | undefined;

export const clientFeature: ClientFeature = {
  id: 'tow',
  actions: [
    { id: 'tow', label: 'Tow / let go (Tow Beam)', category: 'Ship & world', key: 'KeyU', after: 'dodge', hint: 'Takes hold of the wreck, debris or pod nearest your cursor within reach; tow it into a station to salvage it' },
  ],
  onKey(code, host) {
    if (code !== 'KeyU') return false;
    toggleTow(host);
    return true;
  },
  parsePilot(data, at, fx) {
    fx.tow = data[at + slotsOf().pilot] ?? 0;
  },
  // All the frame's tethers in one graphics, drawn afresh each frame (made on the first frame, over the ships' hulls)
  beginFrame(shared) {
    if (!tethers) { tethers = new Graphics(); shared.addChild(tethers); }
    tethers.clear();
  },
  drawShip(ctx: ShipDrawCtx, host) {
    if (!tethers) return;
    // The pilot's own comes from its snapshot row, everyone else's from their status row
    const towed = ctx.eid === host.playerId() ? ctx.entity.fx?.tow ?? 0 : ctx.entity.status?.[slotsOf().status] ?? 0;
    if (towed > 0) drawTether(tethers, ctx, host, towed);
  },
  indicator: {
    update(host) {
      const me = host.entity(host.playerId());
      const w = host.hangarOpen() ? 0 : me?.fx?.tow ?? 0;
      const ship = host.ship(host.playerId());
      chip.update(w > 0 && ship ? {
        what: host.entity(w - 1)?.type === EntityType.DroppedItem ? 'pod' : 'wreck',
        thrustLoss: 1 - cargoThrust(ship.derived, me?.cargoMass ?? 0),
      } : null, host.keyName('tow'));
    },
  },
};
