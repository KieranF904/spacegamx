/**
 * The field machines' client half (shared half: common/src/ships/features/machines; server half: the jobs). Its keys
 * (the build overlay, the fabricator and refiner switches), the HUD chip, and while the build overlay is open the plan on
 * your ship (out in the world, the build's progress is on the HUD's schematic: field/fieldState fieldHudMarks). The jobs themselves
 * are the server's: this never predicts a start, a finish or a placement, only shows progress from the machine's clock.
 */
import { Graphics } from 'pixi.js';
import type { ShipState } from '@space-game/common';
import type { ClientFeature, ClientFeatureHost, ShipDrawCtx } from '../types';
import { fieldBridge } from '../../field/bridge';
import { fieldClient } from '../../field/fieldState';
import { fillPoly, frameOf } from '../../field/FieldOverlay';

/** A machine's switch: on or off at any time (the server decides whether it then draws) */
function toggleMachine(host: ClientFeatureHost, kind: 'fabricator' | 'refiner'): void {
  const m = fieldClient.machine(kind);
  host.send({ type: 'machine', kind, on: !(m?.on ?? false) });
  host.showMessage(`${kind === 'fabricator' ? 'Fabricator' : 'Refiner'} ${m?.on ? 'off' : 'on'}`);
}

let gfx: Graphics | undefined;

/** The planned parts of a ship (indices into its blueprint), cached while its structure stands */
const plannedCache = new WeakMap<ShipState, { rebuilds: number; flags: readonly boolean[]; idx: number[] }>();
function plannedOf(ship: ShipState): number[] {
  const hit = plannedCache.get(ship);
  if (hit && hit.rebuilds === ship.rebuilds && hit.flags === ship.ghost) return hit.idx;
  const idx: number[] = [];
  ship.ghost?.forEach((g, i) => { if (g) idx.push(i); });
  plannedCache.set(ship, { rebuilds: ship.rebuilds, flags: ship.ghost, idx });
  return idx;
}

export const clientFeature: ClientFeature = {
  id: 'machines',
  actions: [
    { id: 'fieldBuild', label: 'Build overlay (field plan)', category: 'Ship & world', key: 'Digit7', hint: 'Zooms in on your ship and opens the parts list: place parts to plan, right-click a part to recycle it, then save. The fabricator builds the plan from your hold' },
    { id: 'fabricator', label: 'Fabricator on / off', category: 'Ship & world', key: 'Digit8', after: 'fieldBuild', hint: 'It draws power only while it works' },
    { id: 'refiner', label: 'Refiner on / off', category: 'Ship & world', key: 'Digit9', after: 'fabricator' },
  ],
  onKey(code, host) {
    const o = fieldBridge.overlay;
    if (o?.isOpen && o.onKey(code)) return true;
    if (code === 'Digit7') {
      if (o) o.toggle(); else host.showMessage('Build plans are not ready yet', '#f2d24b');
      return true;
    }
    if (code === 'Digit8') { toggleMachine(host, 'fabricator'); return true; }
    if (code === 'Digit9') { toggleMachine(host, 'refiner'); return true; }
    return false;
  },
  beginFrame(shared) {
    if (!gfx) { gfx = new Graphics(); shared.addChild(gfx); }
    gfx.clear();
  },
  // Out in the world a ship looks like any ship: planned parts aren't drawn (they're missing parts, as on the HUD's
  // schematic, which shows the build and recycling: fieldHudMarks). Only the open build overlay draws the plan.
  drawShip(ctx: ShipDrawCtx, host) {
    if (!gfx || ctx.eid !== host.playerId() || !fieldBridge.overlay?.isOpen) return;
    const X = frameOf(ctx);
    const geoms = ctx.geometry(ctx.ship);
    const parts = ctx.ship.blueprint.parts;
    // (The plan is the overlay's draft: a planned part it has dropped is no longer drawn)
    const kept = new Set(fieldBridge.overlay.draft?.bp.parts.map((p) => p.uid) ?? []);
    for (const i of plannedOf(ctx.ship)) {
      if (geoms[i] && kept.has(parts[i].uid)) fillPoly(gfx, X, geoms[i], 0x7dd3fc, 0.14, 0x7dd3fc, 0.55, 1.2);
    }
    fieldBridge.overlay.draw(gfx, ctx);
  },
  indicator: {
    update() {
      fieldBridge.overlay?.update();
      fieldBridge.hud?.update();
    },
  },
};
