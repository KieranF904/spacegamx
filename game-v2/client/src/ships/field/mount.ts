/**
 * Mounts the field-fabrication client once the game has what it needs (ShipClient's constructor calls mountField; the
 * idle-time prefetch calls loadField): the HUD and the build overlay, reached by the `machines` client feature through
 * `fieldBridge`. They are their own chunk, so until it arrives both are null (the build key says "not ready yet").
 */
import { fieldBridge, type FieldDeps } from './bridge';

let loading: Promise<void> | null = null;

/** The game's deps arrive: any earlier overlay and HUD go, and the new pair is built by loadField */
export function mountField(deps: FieldDeps): void {
  fieldBridge.overlay?.dispose();
  fieldBridge.hud?.dispose();
  fieldBridge.overlay = null;
  fieldBridge.hud = null;
  fieldBridge.deps = deps;
  loading = null;
}

/** Fetches the overlay and HUD and builds them for the deps now mounted (once per mount) */
export function loadField(): Promise<void> {
  const deps = fieldBridge.deps;
  if (!deps) return Promise.resolve();
  loading ??= Promise.all([import('./FieldOverlay'), import('./FieldHud')]).then(([o, h]) => {
    if (fieldBridge.deps !== deps) return;
    fieldBridge.overlay = new o.FieldOverlay(deps);
    fieldBridge.hud = new h.FieldHud(deps);
  }, (e) => { loading = null; throw e; });
  return loading;
}
