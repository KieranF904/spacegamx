/**
 * Dev-only panels (F8 render tuning, F9 ship swap, F10 weapons range). Kept apart from the window registry so the import.meta.env.DEV
 * guard and the eager blueprint glob are tree-shaken from the deployed build.
 */
import { RenderTuningPanel } from '../ui/RenderTuningPanel';
import { DevShipPanel } from '../ui/DevShipPanel';
import { DevRangePanel, type RangeGun } from '../ui/DevRangePanel';
import shipModels from '../../../data/ships/models.json';
import type { Renderer } from '../rendering/Renderer';
import type { ClientTransport } from '@space-game/common';

export function installDevTools(host: { readonly renderer: Renderer; readonly network: ClientTransport }): void {
  if (import.meta.env.DEV) {
      new RenderTuningPanel({ zoom: () => host.renderer.getZoom(), warp: (systemId, x, y) => host.network.send({ type: 'devTeleport', systemId, x, y }) });
      // Ship swap (F9): the plan library's ships and the dev test ships, flown at once
      // (Grouped: a ports design (`power: 'ports'`) first, then the library, then the dev test ships; one marked `retired` isn't listed)
      const library = import.meta.glob(['../../../data/ships/blueprints/*.json', '../../../data/ships/blueprints/dev/*.json'], { eager: true, import: 'default' }) as Record<string, { name: string; parts: { fn: string }[]; power?: string; retired?: unknown }>;
      const groupOf = (path: string, bp: { power?: string }) => (bp.power === 'ports' ? 'Ports energy' : path.includes('/dev/') ? 'Dev test ships' : 'Library');
      new DevShipPanel(Object.fromEntries(Object.entries(library).filter(([, bp]) => !bp.retired).map(([path, bp]) => [path.replace(/^.*\//, '').replace(/\.json$/, ''), { ...bp, group: groupOf(path, bp) }])), (ship) => host.network.send({ type: 'devShip', ship }),
        (wear, reset) => host.network.send({ type: 'devBoss', wear, reset }), () => host.network.send({ type: 'devRange', action: 'go' }));
      // Weapons range (F10): every weapon model to arm a test rig with, the readout, ideal ammo
      const NO_TARGET = new Set(['repair', 'point_defence']);
      const guns: RangeGun[] = (shipModels as unknown as { models: { id: string; name: string; weapon?: string; grade?: number; mount?: string; fire?: { model?: string } }[] }).models
        .filter((m) => m.weapon && !NO_TARGET.has(m.weapon))
        .map((m) => ({ id: m.id, name: m.name, kind: m.weapon!, fire: m.fire?.model ?? 'cycle', grade: m.grade ?? 1, mount: m.mount ?? 'fixed' }));
      new DevRangePanel(guns, (m) => host.network.send({ type: 'devRange', ...m }), () => host.network.send({ type: 'devShip' }));
  }
}
