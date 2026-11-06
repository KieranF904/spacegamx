/**
 * Dev-only panels (F8 render tuning, F9 ship swap, Shift+F9 boss tools, F10 weapons range). Kept apart from the window registry so the import.meta.env.DEV
 * guard and the eager blueprint glob are tree-shaken from the deployed build.
 */
import { RenderTuningPanel } from '../ui/RenderTuningPanel';
import { DevShipPanel } from '../ui/DevShipPanel';
import { DevRangePanel, type RangeGun } from '../ui/DevRangePanel';
import { DevBossPanel } from '../ui/DevBossPanel';
import { DevSimPanel } from '../ui/DevSimPanel';
import { NetSim } from '../dev/netSim';
import { SimOverlay } from '../dev/simOverlay/SimOverlay';
import { GameStateSource } from '../dev/simOverlay/gameStateSource';
import { PredictSource } from '../dev/simOverlay/predictSource';
import { PredictController } from '../dev/predict/PredictController';
import type { GameState } from '../state/GameState';
import type { ShipClient } from '../ships/ShipClient';
import type { Prediction } from '../predict/Prediction';
import { devFeeds } from './devFeeds';
import shipModels from '../../../data/ships/models.json';
import type { Renderer } from '../rendering/Renderer';
import type { ClientTransport } from '@space-game/common';

export function installDevTools(host: { readonly renderer: Renderer; readonly network: ClientTransport; readonly state?: GameState; readonly shipClient?: ShipClient; readonly prediction?: Prediction | null }): void {
  if (import.meta.env.DEV) {
      const simTools = installSimTools(host);
      new RenderTuningPanel({ zoom: () => host.renderer.getZoom(), warp: (systemId, x, y) => host.network.send({ type: 'devTeleport', systemId, x, y }), openSim: () => simTools?.toggle() });
      // Ship swap (F9): the plan library's ships and the dev test ships, flown at once
      // (Grouped: a ports design (`power: 'ports'`) first, then the library, then the dev test ships; one marked `retired` isn't listed)
      const library = import.meta.glob(['../../../data/ships/blueprints/*.json', '../../../data/ships/blueprints/dev/*.json'], { eager: true, import: 'default' }) as Record<string, { name: string; parts: { fn: string }[]; power?: string; retired?: unknown }>;
      const groupOf = (path: string, bp: { power?: string }) => (bp.power === 'ports' ? 'Ports energy' : path.includes('/dev/') ? 'Dev test ships' : 'Library');
      // The boss tools (Shift+F9): its state comes back as bossDev (app/devFeeds.ts)
      const bossTools = new DevBossPanel((m) => host.network.send({ type: 'bossDevTool', ...m }));
      devFeeds.bossDev = (msg) => bossTools.update(msg);
      new DevShipPanel(Object.fromEntries(Object.entries(library).filter(([, bp]) => !bp.retired).map(([path, bp]) => [path.replace(/^.*\//, '').replace(/\.json$/, ''), { ...bp, group: groupOf(path, bp) }])), (ship) => host.network.send({ type: 'devShip', ship }),
        (wear, reset) => host.network.send({ type: 'devBoss', wear, reset }), () => host.network.send({ type: 'devRange', action: 'go' }), () => bossTools.toggle());
      // Weapons range (F10): every weapon model to arm a test rig with, the readout, ideal ammo
      const NO_TARGET = new Set(['repair', 'point_defence']);
      const guns: RangeGun[] = (shipModels as unknown as { models: { id: string; name: string; weapon?: string; grade?: number; mount?: string; fire?: { model?: string } }[] }).models
        .filter((m) => m.weapon && !NO_TARGET.has(m.weapon))
        .map((m) => ({ id: m.id, name: m.name, kind: m.weapon!, fire: m.fire?.model ?? 'cycle', grade: m.grade ?? 1, mount: m.mount ?? 'fixed' }));
      new DevRangePanel(guns, (m) => host.network.send({ type: 'devRange', ...m }), () => host.network.send({ type: 'devShip' }));
  }
}

/**
 * The sim tools (F7 panel, Shift+F7 overlay): a network simulator on the browser transport and the overlay over GameState / ShipClient.
 * Dev builds only (the caller is under import.meta.env.DEV); both start off.
 */
function installSimTools(host: { readonly renderer: Renderer; readonly network: ClientTransport; readonly state?: GameState; readonly shipClient?: ShipClient; readonly prediction?: Prediction | null }): DevSimPanel | null {
  const transport = host.network as ClientTransport & { netSim?: NetSim | null };
  let net: NetSim | null = null;
  if ('netSim' in transport) { net = new NetSim(); transport.netSim = net; }
  if (!host.state || !host.shipClient) return null;
  const base = new GameStateSource({ state: host.state, shipClient: host.shipClient, renderer: host.renderer });
  // (The game's prediction, C3, switched live to the other modes for comparison; `?predict=C2` starts in one, `?simOverlay=1` with the overlay on)
  const predict = host.prediction ? new PredictController(host.prediction, host.state, host.shipClient, host.renderer) : null;
  const pSource = predict ? new PredictSource(base, predict, { state: host.state, shipClient: host.shipClient }) : null;
  const overlay = new SimOverlay(pSource ?? base, { attach: () => base.attach(), detach: () => base.detach() });
  const q = new URLSearchParams(location.search);
  if (q.get('predict')) predict?.set(q.get('predict')!);
  if (q.get('simOverlay') === '1') overlay.setOn(true);
  // (For the demo scripts and the console: switch, read the numbers)
  (window as unknown as { __simTools?: unknown }).__simTools = { predict, overlay, net, read: () => ({ mode: predict?.mode.id ?? 'off', ...pSource?.read(), ...(pSource ?? base).counters() }) };
  return new DevSimPanel({
    net, overlay, predict,
    say: (text) => host.network.send({ type: 'chat', text } as never),
    warp: (systemId, x, y) => host.network.send({ type: 'devTeleport', systemId, x, y }),
  });
}
