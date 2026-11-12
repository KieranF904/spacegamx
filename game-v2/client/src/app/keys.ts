/**
 * Key presses (from InputManager, as DEFAULT codes: it translates rebinds): the ordered modal chain, then the
 * global key-action tables. An action whose default key has moved before is named by its action here (actionKey), so
 * the tables follow input/keybindings.ts. Split out of Game.handleKeyPress; keys.ts never imports Game, it reads a KeyHost.
 *
 * ORDER MATTERS. The chain runs first, top to bottom, and each open window swallows the keys it owns.
 * After it come the autopilot/menu-order cancel, the PRE table (Escape cancels an order, G),
 * the ship's own keys (ShipClient.onKey), and last the POST table (the rest of the global keys).
 * A table entry returns true when it consumed the key.
 * Per keypress, not per tick: no performance constraints here.
 */
import type { Lazy } from '../lazy';
import { actionKey } from '../input/keybindings';
import type { InventoryWindow } from '../ui/InventoryWindow';
import type { ShipWindow } from '../ui/ship/ShipWindow';
import type { PickupWindows } from '../ui/pickup';
import type { HubPanel } from '../ui/hub/HubPanel';
import type { StationWindow } from '../ui/StationWindow';
import type { TradeWindow } from '../ui/TradeWindow';
import type { SocialUI } from '../ui/SocialUI';
import type { QuestClient } from '../ui/QuestUI';
import type { MenuFacade } from '../ui/menuLazy';
import type { DialogueUI } from '../ui/DialogueUI';
import type { QuickBar } from '../ui/QuickBar';
import type { InfoPanel } from '../ui/InfoPanel';
import type { PingUI } from '../ui/PingUI';
import type { TargetUI } from '../ui/TargetUI';
import type { PlayerStatsUI } from '../ui/PlayerStatsUI';
import type { SystemMap } from '../ui/systemMapLazy';
import type { NavMarkersUI } from '../ui/NavMarkersUI';
import type { RegionUI } from '../ui/RegionUI';
import type { AudioManager } from '../audio/AudioManager';
import type { InputManager } from '../input/InputManager';
import type { Renderer } from '../rendering/Renderer';
import type { ShipClient } from '../ships/ShipClient';
import type { Autopilot } from '../ships/Autopilot';
import type { ContextActions } from '../input/ContextActions';
import { settings } from '../settings/Settings';
import { viewMode } from '../input/viewMode';
import { groupKey } from '../ships/weaponGroups/keys';
import { inGunRange } from '../ui/gunRange/rangeState';
import { rangeKey } from '../ui/gunRange/rangeKeys';
import { backupPicker } from '../ui/BackupPicker';

/** What the key handlers read from the game (Game supplies it as getters, so late-built windows resolve at use) */
export interface KeyHost {
  readonly loggedIn: boolean;
  readonly stationOpen: boolean;
  readonly menu: MenuFacade;
  readonly dialogue: DialogueUI;
  /** The side panel on the HUD (Social, Party, Pilot, Components) */
  readonly hub: HubPanel;
  readonly inventoryWindow: InventoryWindow;
  /** The Ship window (not modal: only Esc is its; the flight keys pass on) */
  readonly shipWindow: Pick<ShipWindow, 'onKey' | 'toggle' | 'isOpen'>;
  /** The pickup panel (F), the auto-pickup panel and its catalogue (ui/pickup) */
  readonly pickup: PickupWindows;
  readonly tradeWindow: TradeWindow;
  readonly social: SocialUI;
  readonly quests: QuestClient;
  readonly stationWindow: Lazy<StationWindow>;
  readonly shipClient: ShipClient;
  readonly autopilot: Autopilot;
  readonly context: ContextActions;
  readonly quickBar: QuickBar;
  readonly infoPanel: InfoPanel;
  readonly pingUI: PingUI;
  readonly targetUI: TargetUI;
  readonly playerStatsUI: PlayerStatsUI;
  readonly systemMapUI: SystemMap;
  readonly navMarkers: NavMarkersUI | null;
  /** A moon siege's panel: focus fire (true if it took the key) */
  readonly siegePanel?: { focus(): boolean };
  readonly regionUI: RegionUI;
  readonly audio: AudioManager;
  readonly network: { send(msg: any): void };
  readonly input: InputManager;
  readonly renderer: Renderer;
  /** The gun range's HUD (its weapon picker folds on the inventory key in there) */
  readonly gunRangeHud?: { toggle(): void };
  toggleAutopilotToObjective(): void;
  showSystemMessage(text: string, color?: string): void;
}

/** Keys that fly the ship: pressing one hands control back from the autopilot / a menu jump */
export const FLIGHT_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyJ', 'KeyY', actionKey('helm'), actionKey('interact'), 'KeyH', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight', 'Space']);

type KeyFn = (h: KeyHost, code: string) => boolean;
const COMPONENTS = actionKey('components');

/** The ordered modal chain: the first entry that returns true swallows the key. Do not reorder. */
export const MODAL_CHAIN: readonly KeyFn[] = [
  // The menu owns the keyboard while open (Esc steps back / closes it)
  (h, code) => {
    if (!h.menu.isOpen) return false;
    if (code === 'Escape') h.menu.back();
    return true;
  },
  // A conversation: digits answer, Space skips ahead, Esc walks away
  (h, code) => h.dialogue.onKey(code),
  // Esc puts away the side panel when it was called up over the station or the hangar
  (h, code) => code === 'Escape' && h.hub.dismiss(),
  // The side panel's component guide, again folds it (anywhere but the map; over the station and the hangar it's
  // called up over them)
  (h, code) => {
    if (code === COMPONENTS && h.loggedIn && !h.systemMapUI.isOpen) {
      h.hub.toggle('components');
      return true;
    }
    return false;
  },
  // The pickup windows: the catalogue owns the keyboard while open; Esc closes the pickup or auto-pickup panel
  (h, code) => h.loggedIn && h.pickup.onKey(code),
  // The Ship window: Esc closes it; every other key passes on (it is not modal: the pilot flies with it open)
  (h, code) => h.shipWindow.onKey(code),
  (h, code) => {
    if (!h.inventoryWindow.isOpen) return false;
    if (code === 'Escape' || code === 'KeyI') h.inventoryWindow.close();
    return true;
  },
  (h, code) => {
    if (!h.tradeWindow.isOpen) return false;
    if (code === 'Escape') h.tradeWindow.close();
    return true;
  },
  (h, code) => {
    if (!h.quests.log.isOpen) return false;
    if (code === 'Escape') h.quests.log.close();
    else if (code === 'KeyL') h.quests.log.toggle('jobs');
    else if (code === 'KeyK') h.quests.log.toggle('skills');
    return true;
  },
  (h, code) => {
    if (!(h.stationOpen && !h.shipClient.hangarOpen)) return false;
    if (code === 'Escape' || code === 'KeyH') h.stationWindow.value!.close();
    else if (code === 'KeyI') h.inventoryWindow.open();
    return true;
  },
];

const groups: KeyFn = (h, code) => h.loggedIn && !h.shipClient.hangarOpen && groupKey(code, !!h.input.shiftDown);

/** Global keys that run before the ship's own keys (ShipClient.onKey) */
export const PRE_KEYS: Readonly<Record<string, KeyFn>> = {
  // Weapon groups: 1-5 set the left button's group (with Shift the right button's; again: back to all); , . / cycle them
  Comma: groups, Period: groups, Slash: groups, Digit1: groups, Digit2: groups, Digit3: groups, Digit4: groups, Digit5: groups,
  // Esc calls off a menu order (instead of opening the game menu)
  Escape: (h) => h.context.active && h.context.cancel(h.context.jumpMark() ? 'Jump cancelled' : 'Autopilot off'),
  // G: autopilot to the job you're following (again: off)
  KeyG: (h) => {
    if (!(h.loggedIn && !h.shipClient.hangarOpen)) return false;
    h.toggleAutopilotToObjective();
    return true;
  },
};

/** Run `fn` when logged in and the hangar is shut (the guard most global keys share) */
const flying = (fn: (h: KeyHost, code: string) => void): KeyFn => (h, code) => {
  if (!(h.loggedIn && !h.shipClient.hangarOpen)) return false;
  fn(h, code);
  return true;
};

/**
 * A quick bar slot. Not on the map (its own C centres on the ship, and the key that opened it shuts it), and not with Ctrl or Cmd held (Ctrl+C on a line of
 * chat must copy it, not use an item)
 */
const quick = (n: number): KeyFn => (h) => {
  if (!(h.loggedIn && !h.shipClient.hangarOpen) || h.systemMapUI.isOpen || h.input.ctrlDown) return false;
  h.quickBar.use(n);
  return true;
};

/** Global keys that run after the ship's own keys */
export const POST_KEYS: Readonly<Record<string, KeyFn>> = {
  // I: the Ship window (docked, the station's entry in the chain opens cargo and storage instead)
  KeyI: flying((h) => h.shipWindow.toggle()),
  // F: the pickup panel, the loot in reach (after the ship's keys: the build overlay flips a part with F)
  KeyF: flying((h) => h.pickup.panel.toggle()),
  // C V B N M: the quick bar (its actions' default codes, input/keybindings.ts quick1..quick5)
  [actionKey('quick1')]: quick(0), [actionKey('quick2')]: quick(1), [actionKey('quick3')]: quick(2), [actionKey('quick4')]: quick(3), [actionKey('quick5')]: quick(4),
  // P: invite the pilot under the cursor, or the side panel's Social tab (again: fold it)
  KeyP: flying((h) => {
    const over = h.infoPanel.hovered;
    if (over > 0 && !h.social.isMember(over)) h.social.invite(over);
    else h.hub.toggle('social');
  }),
  // Ping what's under the cursor for the party (Shift: danger)
  [actionKey('ping')]: flying((h) => h.pingUI.pingAtCursor(h.input.isKeyDown('ShiftLeft') || h.input.isKeyDown('ShiftRight'))),
  // 6: on a siege moon at night, the turrets focus on your target (not U: the Tow Beam's, and ship keys run first)
  Digit6: (h) => !!(h.loggedIn && !h.shipClient.hangarOpen && h.siegePanel?.focus()),
  // Tab: next hostile; T: the ship under the cursor
  Tab: flying((h) => h.targetUI.cycle()),
  KeyT: flying((h) => h.targetUI.pickAtCursor()),
  // L: the pilot log (jobs), K: skills
  KeyL: flying((h) => h.quests.log.open('jobs')),
  KeyK: flying((h) => h.quests.log.open('skills')),
  // Escape opens the menu (the map and the hangar close themselves first; the stats panel closes instead)
  Escape: (h) => {
    if (!h.loggedIn) return false;
    if (h.playerStatsUI.isVisible()) h.playerStatsUI.hide();
    else h.menu.open();
    return true;
  },
  // O: session stats panel
  KeyO: (h) => {
    if (!h.loggedIn) return false;
    h.playerStatsUI.toggle();
    return true;
  },
  // The system map: open, and again shut (the same action's key both ways)
  [actionKey('map')]: (h) => {
    if (!h.loggedIn) return false;
    h.systemMapUI.toggle();
    h.audio.playUI(h.systemMapUI.isOpen || !h.systemMapUI.loaded ? 'ui_open' : 'ui_close', 0.7);
    return true;
  },
  // The view: north up or following the heading, for this session (input/viewMode.ts; the helm key switches the controls)
  Backquote: (h) => {
    if (!h.loggedIn || h.shipClient.hangarOpen) return false;
    const v = viewMode.toggle(h.shipClient.helmMode());
    h.showSystemMessage(v === 'heading' ? 'View: follows your heading' : 'View: north up');
    return true;
  },
  // The navigation markers, on or off
  [actionKey('nav')]: (h) => {
    if (!(h.loggedIn && h.navMarkers)) return false;
    const on = !settings.data.ui.navMarkers;
    settings.update((s) => { s.ui.navMarkers = on; });
    // (No chat line: the markers appearing or going is the answer)
    return true;
  },
  // Respawn with R after being destroyed (in the backup picked, the starter if none: ui/BackupPicker.ts)
  KeyR: (h) => {
    if (!h.loggedIn) return false;
    h.network.send({ type: 'respawn', ...backupPicker.choice() });
    return true;
  },
  // Interact: a jump gate, a planet, a way in, a person, the gun range's doors
  [actionKey('interact')]: (h) => {
    if (!(h.loggedIn && h.regionUI.allowInteract())) return false;
    h.network.send({ type: 'interact' });
    return true;
  },
  // Reset zoom with Home
  Home: (h) => {
    h.input.resetZoom();
    h.renderer.setZoom(1);
    return true;
  },
};

/** One key press: the modal chain, the autopilot cancels, then the key tables */
export function handleKey(h: KeyHost, code: string): void {
  for (let i = 0; i < MODAL_CHAIN.length; i++) if (MODAL_CHAIN[i](h, code)) return;
  // Any flight key hands control back from the autopilot
  if (h.autopilot.active && FLIGHT_KEYS.has(code) && !h.shipClient.hangarOpen) h.autopilot.cancel('Autopilot off');
  // ...and calls off a menu jump
  if (h.context.jumpMark() && FLIGHT_KEYS.has(code) && !h.shipClient.hangarOpen) h.context.cancel('Jump cancelled');
  // In the gun range: some keys do something else there, or nothing (ui/gunRange/rangeKeys.ts)
  if (h.loggedIn && inGunRange()) {
    const r = rangeKey(code);
    if (r) {
      if ('fold' in r) h.gunRangeHud?.toggle();
      else h.showSystemMessage(r.say, '#f2d24b');
      return;
    }
  }
  if (Object.hasOwn(PRE_KEYS, code) && PRE_KEYS[code](h, code)) return;
  if (h.loggedIn && h.shipClient.onKey(code)) return;
  if (Object.hasOwn(POST_KEYS, code)) POST_KEYS[code](h, code);
}
