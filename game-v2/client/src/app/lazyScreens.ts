/**
 * The screens split out of the main chunk (dynamic imports behind a Lazy), and the idle-time prefetch of them.
 * Adding a heavy window is one line in each place: its factory here, and its loader in prefetchScreens.
 * Never imports Game; the factories read a WindowHost at call time (inside the Lazy's build).
 */
import { ShipTuning } from '@space-game/common';
import shipTuning from '../../../data/ships/tuning.json';
import { Lazy, prefetchIdle } from '../lazy';
import { fieldGuide } from '../ui/GameMenuUI';
import type { ComponentGuideUI } from '../ui/ComponentGuideUI';
import type { StationWindow } from '../ui/StationWindow';
import type { WindowHost, WindowSet } from './windows';

/** The component guide (calls made before it arrives run when it does) */
export function makeComponentGuide(host: WindowHost): Lazy<ComponentGuideUI> {
  return new Lazy(() => import('../ui/ComponentGuideUI').then(({ ComponentGuideUI }) =>
    new ComponentGuideUI({ catalog: host.pilot.econ.ships, tuning: shipTuning as ShipTuning, pilot: host.pilot, sound: (id, v) => host.audio.playUI(id, v ?? 0.6) })));
}

/** The station window (calls made before it arrives run when it does, in order) */
export function makeStationWindow(host: WindowHost, w: WindowSet): Lazy<StationWindow> {
  return new Lazy(() => import('../ui/StationWindow').then(({ StationWindow }) => new StationWindow({
      quests: w.quests,
      pilot: host.pilot,
      send: (m) => host.network.send(m),
      sound: (id, v) => host.audio.playUI(id, v ?? 0.6),
      openHangar: (slot) => { w.stationWindow.value?.hideForHangar(); host.shipClient.openHangar(slot); },
      openInventory: () => w.inventoryWindow.open(),
      onClose: () => { if (!host.shipClient.hangarOpen) host.shipClient.undock(); },
    })));
}

/** Fetches the split-out screens in idle time once past the sign-in screen, so none waits when first opened */
export function prefetchScreens(host: WindowHost, w: WindowSet): void {
  void prefetchIdle([() => w.stationWindow.load(), () => host.shipClient.hangar.load(), () => w.componentGuide.load(), () => fieldGuide.load()]);
}
