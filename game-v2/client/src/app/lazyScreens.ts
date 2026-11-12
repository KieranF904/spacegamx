/**
 * The screens split out of the main chunk (dynamic imports behind a Lazy), and the idle-time prefetch of them.
 * Adding a heavy window is one line in each place: its factory here, and its loader in prefetchScreens.
 * Never imports Game; the factories read a WindowHost at call time (inside the Lazy's build).
 */
import { ShipTuning } from '@space-game/common';
import shipTuning from '../../../data/ships/tuning.json';
import { Lazy, prefetchIdle } from '../lazy';
import { fieldGuide } from '../ui/fieldGuideLazy';
import { itemIcon } from '../ui/itemIcons';
import { boundKeyName } from '../input/keybindings';
import { settings } from '../settings/Settings';
import { chamberOf, roomName } from '../ui/gunRange/rangeState';
import { onTutorial, resetTutorial } from '../ui/tutorial/tutorialStore';
import { clearTrainingBodies } from '../state/trainingBodies';
import { loadField } from '../ships/field/mount';
import { fieldBridge } from '../ships/field/bridge';
import type { TutorialUI } from '../ui/tutorial/TutorialUI';
import type { GunRangeHud } from '../ui/gunRange/GunRangeHud';
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

/**
 * The training-yard lesson (card, markers, ghosts). Built when the server first sends a tutorial state (the store replays
 * the latest to it), so a pilot who never trains never loads it
 */
export function makeTutorialUI(host: WindowHost, w: WindowSet): Lazy<TutorialUI> {
  const lazy = new Lazy(() => import('../ui/tutorial/TutorialUI').then(({ TutorialUI }) =>
    new TutorialUI({
      state: host.state,
      send: (m) => host.network.send(m),
      worldToScreen: (x, y) => host.renderer.worldToScreen(x, y),
      setTrainingLook: (id, look) => host.renderer.setTrainingLook(id, look),
      keyOf: (a) => boundKeyName(a, settings.data.bindings),
      helm: () => host.shipClient.helmMode(),
      itemName: (id) => host.pilot.econ.items.get(id)?.name ?? id,
      itemIcon: (id) => itemIcon(host.pilot.econ, id),
      sound: (id, v) => host.audio.playUI(id, v ?? 0.5),
      panelsOpen: () => {
        const tab = host.stationOpen ? w.stationWindow.value?.currentTab : '';
        return {
          // (in flight the inventory key opens the Ship window; docked, cargo and storage: either is the lesson's "hold")
          hold: w.inventoryWindow.isOpen || w.shipWindow.isOpen, hangar: host.shipClient.hangarOpen, map: w.systemMapUI.isOpen, guide: !!w.componentGuide.value?.isOpen,
          bank: tab === 'bank', refinery: tab === 'refinery', fabricator: tab === 'fabricator', build: !!fieldBridge.overlay?.isOpen, pickup: w.pickup.panel.isOpen,
        };
      },
    })));
  onTutorial(() => lazy.use(() => {}));
  return lazy;
}

/** The connection starts over: the lesson's state goes whether or not its UI was ever built */
export function resetTutorialUI(lazy: Lazy<TutorialUI>): void {
  if (lazy.value) lazy.value.reset();
  else { resetTutorial(); clearTrainingBodies(); }
}

/** The gun range's HUD (Game loads it on first entering a range) */
export function makeGunRangeHud(host: WindowHost, w: WindowSet): Lazy<GunRangeHud> {
  return new Lazy(() => import('../ui/gunRange/GunRangeHud').then(({ GunRangeHud }) =>
    new GunRangeHud({
      send: (m) => host.network.send(m),
      sound: (id, v) => host.audio.playUI(id, v ?? 0.5),
      catalog: host.pilot.econ.ships,
      econ: host.pilot.econ,
      tuning: shipTuning as ShipTuning,
      chamber: () => chamberOf(host.state.systemId),
      roomName: (id) => roomName(host.state.systemId, id),
      me: () => { const e = host.state.entities.get(host.state.playerId); return e ? { x: e.renderX, y: e.renderY } : null; },
      hull: (id) => {
        const ship = host.shipClient.store.get(id);
        // (A mob target, a mine, is no ship: it is whole for as long as it is there)
        if (!ship) { const e = host.state.entities.get(id); return e ? { hp: 1, max: 1, name: e.name || 'Target' } : null; }
        let hp = 0, max = 0;
        for (let i = 0; i < ship.hp.length; i++) { max += ship.maxHp[i]; if (ship.derived.alive[i]) hp += ship.hp[i]; }
        return { hp, max, name: host.state.entities.get(id)?.name || ship.blueprint.name || 'Target' };
      },
      keyName: (a) => boundKeyName(a, settings.data.bindings),
      column: () => {
        const c = w.cargoPanel.column();
        return { left: c.left, width: c.width, top: Math.max(w.pilotHud.bottom(), w.social.hudBottom()) + 8, lift: w.pilotHud.top(), floor: c.floor };
      },
    })));
}

/** Fetches the split-out screens in idle time once past the sign-in screen, so none waits when first opened */
export function prefetchScreens(host: WindowHost, w: WindowSet): void {
  void prefetchIdle([() => w.stationWindow.load(), () => w.systemMapUI.load(), () => host.menu.load(), () => host.shipClient.hangar.load(), () => w.componentGuide.load(), () => fieldGuide.load(), () => loadField()]);
}
