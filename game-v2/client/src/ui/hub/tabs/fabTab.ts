/**
 * The side panel's Fab tab: your fabricator and refiner (switches, jobs, pack mode, the refiner's recipe, what the plan
 * still needs): the field HUD (ships/field/FieldHud.ts) drawn in the tab's body while it is on show.
 */
import { fieldBridge } from '../../../ships/field/bridge';
import type { HubTab } from '../hubTabs';

export function fabTab(): HubTab {
  return {
    id: 'fab',
    label: 'Fab',
    title: 'Fabricator and refiner: switch them, see their jobs and what your plan needs',
    render: (body) => {
      if (fieldBridge.hud) fieldBridge.hud.mountIn(body);
      else body.innerHTML = '<div style="padding:10px; color:#6f8099">No ship to show.</div>';
    },
    hide: () => fieldBridge.hud?.unmount(),
  };
}
