/**
 * Dev-only panels (F8 render tuning, F9 ship swap). Kept apart from the window registry so the import.meta.env.DEV
 * guard and the eager blueprint glob are tree-shaken from the deployed build.
 */
import { RenderTuningPanel } from '../ui/RenderTuningPanel';
import { DevShipPanel } from '../ui/DevShipPanel';
import type { Renderer } from '../rendering/Renderer';
import type { ClientTransport } from '@space-game/common';

export function installDevTools(host: { readonly renderer: Renderer; readonly network: ClientTransport }): void {
  if (import.meta.env.DEV) {
      new RenderTuningPanel({ zoom: () => host.renderer.getZoom(), warp: (systemId, x, y) => host.network.send({ type: 'devTeleport', systemId, x, y }) });
      // Ship swap (F9): the plan library's ships and the dev test ships, flown at once
      const library = import.meta.glob(['../../../data/ships/blueprints/*.json', '../../../data/ships/blueprints/dev/*.json'], { eager: true, import: 'default' }) as Record<string, { name: string; parts: { fn: string }[] }>;
      new DevShipPanel(Object.fromEntries(Object.entries(library).map(([path, bp]) => [path.replace(/^.*\//, '').replace(/\.json$/, ''), bp])), (ship) => host.network.send({ type: 'devShip', ship }),
        (wear, reset) => host.network.send({ type: 'devBoss', wear, reset }));
  }
}
