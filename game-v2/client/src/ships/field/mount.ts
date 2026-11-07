/**
 * Mounts the field-fabrication client once the game has what it needs (ShipClient's constructor calls it): the HUD and
 * the build overlay, reached by the `machines` client feature through `fieldBridge`.
 */
import { fieldBridge, type FieldDeps } from './bridge';
import { FieldHud } from './FieldHud';
import { FieldOverlay } from './FieldOverlay';

export function mountField(deps: FieldDeps): void {
  fieldBridge.overlay?.dispose();
  fieldBridge.hud?.dispose();
  fieldBridge.deps = deps;
  const overlay = new FieldOverlay(deps);
  fieldBridge.overlay = overlay;
  fieldBridge.hud = new FieldHud(deps, () => overlay.isOpen);
}
