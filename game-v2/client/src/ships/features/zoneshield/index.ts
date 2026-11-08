/**
 * Shaped shields' client half (shared half: common/src/ships/features/zoneshield). It reads how full each shield is (the pilot's
 * own row, or the status row others get: features.wire.json "shaped") into the ship's copy, so the hit rules and the
 * schematic see the same shields the server does, and draws each live one: a glowing line or arc with a bright edge (quick
 * ones cyan, deep ones amber), a ripple where a shot struck, a flicker as it breaks, a dashed outline while it is down.
 */
import { Graphics } from 'pixi.js';
import { getPlan, shapedLevel, shapedOf, unpackShaped } from '@space-game/common';
import type { ClientFeature, ShipDrawCtx } from '../types';
import { drawShapedShields, noteShapedHit, resetShapedFrame } from './ShapedView';

/** The wire slots features.wire.json pins to the shaped shields: the pilot row's extra, and the status row's index */
let slots: { pilot: number; status: number } | undefined;
function slotsOf(): { pilot: number; status: number } {
  if (!slots) {
    const r = getPlan().replicate;
    slots = {
      pilot: r.find((x) => x.feature === 'zoneshield' && x.where === 'pilotExtra')!.slot,
      status: r.find((x) => x.feature === 'zoneshield' && x.where === 'status')!.slot,
    };
  }
  return slots;
}

let g: Graphics | undefined;

export const clientFeature: ClientFeature = {
  id: 'zoneshield',
  parsePilot(data, at, fx) {
    fx.shaped = data[at + slotsOf().pilot] ?? 0;
  },
  beginFrame(shared) {
    if (!g) { g = new Graphics(); shared.addChild(g); }
    g.clear();
    resetShapedFrame();
  },
  drawShip(ctx: ShipDrawCtx, host) {
    if (!g) return;
    const list = shapedOf(ctx.ship);
    if (!list.length) return;
    // The pilot's own comes from its snapshot row, everyone else's from their status row
    const v = ctx.eid === host.playerId() ? ctx.entity.fx?.shaped : ctx.entity.status?.[slotsOf().status];
    if (v !== undefined) unpackShaped(ctx.ship, v);
    drawShapedShields(g, ctx, v ?? 0, shapedLevel);
  },
};

/** A shell struck at (x, y) in the world: if that is on a shaped shield, it ripples there (ShipClient.struckFx) */
export function shapedStruck(x: number, y: number): boolean {
  return noteShapedHit(x, y);
}
