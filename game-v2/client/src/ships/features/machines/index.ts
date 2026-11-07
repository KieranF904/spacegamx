/**
 * The field machines' client half (shared half: common/src/ships/features/machines; server half: the jobs). Its keys
 * (the build overlay, the fabricator and refiner switches), the HUD chip, and what it draws on a ship: planned parts as
 * translucent ghosts, a fill on the part being built, a red outline on parts queued for recycling. The jobs themselves
 * are the server's: this never predicts a start, a finish or a placement, only shows progress from the machine's clock.
 */
import { Graphics } from 'pixi.js';
import type { ShipState } from '@space-game/common';
import type { ClientFeature, ClientFeatureHost, ShipDrawCtx } from '../types';
import { fieldBridge } from '../../field/bridge';
import { fieldClient, machineProgress } from '../../field/fieldState';
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
  drawShip(ctx: ShipDrawCtx, host) {
    if (!gfx) return;
    const own = ctx.eid === host.playerId();
    const planned = plannedOf(ctx.ship);
    const recycling = own ? fieldClient.recycleUids() : undefined;
    const open = own && !!fieldBridge.overlay?.isOpen;
    if (!planned.length && !recycling?.size && !open && !(own && fieldClient.state?.machines.some((m) => m.job))) return;
    const X = frameOf(ctx);
    const geoms = ctx.geometry(ctx.ship);
    const parts = ctx.ship.blueprint.parts;
    // (Open, the plan is the overlay's draft: a planned part it has dropped is no longer drawn)
    const draft = open ? fieldBridge.overlay!.draft : null;
    const kept = draft ? new Set(draft.bp.parts.map((p) => p.uid)) : null;
    for (const i of planned) {
      if (geoms[i] && (!kept || kept.has(parts[i].uid))) fillPoly(gfx, X, geoms[i], 0x7dd3fc, 0.14, 0x7dd3fc, 0.55, 1.2);
    }
    if (!own) return;
    const clocks = fieldBridge.deps?.clocks();
    for (const m of fieldClient.state?.machines ?? []) {
      const uid = m.job?.uid;
      if (uid === undefined || m.job?.kind === 'refine' || !clocks) continue;
      const i = parts.findIndex((p) => p.uid === uid);
      if (i < 0 || !geoms[i]) continue;
      const k = machineProgress(m, clocks);
      // The part being built fills in as it goes (a repair glows amber instead)
      const repair = m.job!.kind === 'repair';
      fillPoly(gfx, X, geoms[i], repair ? 0xfbbf24 : 0x38bdf8, 0.12 + 0.5 * k, repair ? 0xfde68a : 0xbae6fd, 0.9, 1.6);
    }
    if (recycling?.size && !open) {
      parts.forEach((p, i) => { if (recycling.has(p.uid) && geoms[i]) fillPoly(gfx!, X, geoms[i], 0xef4444, 0.12, 0xef4444, 0.9, 1.8); });
    }
    if (open) fieldBridge.overlay!.draw(gfx, ctx);
  },
  indicator: {
    update() {
      fieldBridge.overlay?.update();
      fieldBridge.hud?.update();
    },
  },
};
