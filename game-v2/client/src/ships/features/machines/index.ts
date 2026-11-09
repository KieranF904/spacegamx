/**
 * @contract feature.machines.client
 * owns:       the field machines client half: build view and machine keys, HUD chip, the build view drawn on the ship
 * needs:      ClientFeature, pixi.js, field/bridge, field/fieldState
 * invariants: its keys, parsers, drawers and chips run in feature id order and the first key user wins —
 *             client/src/ships/features/host.test.ts
 * extend:     a new behaviour is a method on the instance created below (FeatureInstance hooks, types.ts)
 */

/**
 * The field machines' client half (shared half: common/src/ships/features/machines; server half: the jobs). Its keys
 * (the build view, the fabricator and refiner switches), the HUD chip, and while the build view is open the design on
 * your ship (out in the world, the build's progress is on the HUD's schematic: field/bridge fieldHudMarks). The jobs themselves
 * are the server's: this never predicts a start, a finish or a placement, only shows progress from the machine's clock.
 */
import { Graphics } from 'pixi.js';
import type { ClientFeature, ClientFeatureHost, ShipDrawCtx } from '../types';
import { fieldBridge } from '../../field/bridge';
import { fieldClient } from '../../field/fieldState';

/** A machine's switch: on or off at any time (the server decides whether it then draws) */
function toggleMachine(host: ClientFeatureHost, kind: 'fabricator' | 'refiner'): void {
  const m = fieldClient.machine(kind);
  host.send({ type: 'machine', kind, on: !(m?.on ?? false) });
  host.showMessage(`${kind === 'fabricator' ? 'Fabricator' : 'Refiner'} ${m?.on ? 'off' : 'on'}`);
}

let gfx: Graphics | undefined;

export const clientFeature: ClientFeature = {
  id: 'machines',
  actions: [
    { id: 'fieldBuild', label: 'Build view (edit your ship in flight)', category: 'Ship & world', key: 'Digit7', hint: 'Zooms in on your ship and opens the parts list: place parts, right-click a part to recycle it, then save. New parts are missing parts the fabricator builds from your hold, as it rebuilds parts shot off. Ctrl+Z undoes, Ctrl+Y redoes, M mirrors every edit across the centre line, U shows the power flow' },
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
  // Out in the world a ship looks like any ship: missing parts (planned or lost) aren't drawn, as on the HUD's
  // schematic, which shows the build and recycling (fieldHudMarks). Only the open build view draws the design.
  drawShip(ctx: ShipDrawCtx, host) {
    if (!gfx || ctx.eid !== host.playerId() || !fieldBridge.overlay?.isOpen) return;
    fieldBridge.overlay.draw(gfx, ctx);
  },
  indicator: {
    update() {
      fieldBridge.overlay?.update();
      fieldBridge.hud?.update();
    },
  },
};
