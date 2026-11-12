/**
 * Every control in the game. `key` is the default binding and also the code
 * the game logic listens for: InputManager translates whatever key the player
 * bound to an action into that code, so the rest of the client never needs
 * to know about rebinding.
 *
 * There are no modifier bindings: an action that does something else with Shift held says so in its label (the ping,
 * the weapon group keys), and its handler reads InputManager.shiftDown (the physical Shift keys, whatever boost is bound to).
 */

import { CLIENT_FEATURES } from '../ships/features/index';

export interface ActionDef {
  id: string;
  label: string;
  category: 'Flight' | 'Combat' | 'Ship & world' | 'Interface';
  /** Default key (KeyboardEvent.code), or a mouse / fixed input description */
  key: string;
  /** Extra keys that always work too */
  alt?: string;
  hint?: string;
  /** Mouse buttons, wheel, Esc and Enter are fixed */
  rebindable?: false;
  /** A part feature's action: listed right after this one (default: at the end) */
  after?: string;
}

export const ACTIONS: ActionDef[] = [
  { id: 'forward', label: 'Thrust forward', category: 'Flight', key: 'KeyW', alt: 'ArrowUp' },
  { id: 'backward', label: 'Thrust backward', category: 'Flight', key: 'KeyS', alt: 'ArrowDown' },
  { id: 'left', label: 'Thrust left / turn left (helm)', category: 'Flight', key: 'KeyA', alt: 'ArrowLeft' },
  { id: 'right', label: 'Thrust right / turn right (helm)', category: 'Flight', key: 'KeyD', alt: 'ArrowRight' },
  { id: 'strafeLeft', label: 'Strafe left (helm)', category: 'Flight', key: 'KeyQ' },
  { id: 'strafeRight', label: 'Strafe right (helm)', category: 'Flight', key: 'KeyE' },
  { id: 'boost', label: 'Boost', category: 'Flight', key: 'ShiftLeft', alt: 'ShiftRight' },
  { id: 'jump', label: 'Jump drive', category: 'Flight', key: 'KeyJ', hint: 'Jumps to your cursor (or the station, gate or marker you point at), within range' },
  { id: 'camera', label: 'Switch view: north up / follow heading', category: 'Flight', key: 'Backquote', hint: 'For this session; the default is in Settings, Gameplay' },
  { id: 'helm', label: 'Switch mouse-steer / helm', category: 'Flight', key: 'Quote' },
  { id: 'aim', label: 'Aim / steer', category: 'Flight', key: 'Mouse', rebindable: false },
  { id: 'fire', label: 'Fire', category: 'Combat', key: 'Mouse0', alt: 'Mouse2', rebindable: false },
  { id: 'targetNext', label: 'Target the next hostile', category: 'Combat', key: 'Tab', hint: 'Nearest first. Missiles lock on to your target' },
  { id: 'group1', label: 'Weapon group 1: left button (with Shift: right button)', category: 'Combat', key: 'Digit1', hint: 'The left button fires only that group. Again: back to all weapons. Groups are set in the hangar and the build view' },
  { id: 'group2', label: 'Weapon group 2: left button (with Shift: right button)', category: 'Combat', key: 'Digit2' },
  { id: 'group3', label: 'Weapon group 3: left button (with Shift: right button)', category: 'Combat', key: 'Digit3' },
  { id: 'group4', label: 'Weapon group 4: left button (with Shift: right button)', category: 'Combat', key: 'Digit4' },
  { id: 'group5', label: 'Weapon group 5: left button (with Shift: right button)', category: 'Combat', key: 'Digit5' },
  { id: 'groupPrev', label: 'Left button: previous weapon group', category: 'Combat', key: 'Comma', hint: 'All, 1, 2, 3, 4, 5' },
  { id: 'groupNext', label: 'Left button: next weapon group', category: 'Combat', key: 'Period' },
  { id: 'groupRight', label: 'Right button: next weapon group', category: 'Combat', key: 'Slash', hint: 'On a group, the right button no longer runs the mining lasers' },
  { id: 'targetCursor', label: 'Target the ship under the cursor', category: 'Combat', key: 'KeyT', hint: 'On empty space: clear the target' },
  { id: 'feeds', label: 'Switch tanks (Selectors)', category: 'Combat', key: 'KeyY', hint: 'Every Selector switches to its other tank. What is already in the lines runs out first' },
  { id: 'ping', label: 'Ping for your party (with Shift: danger)', category: 'Combat', key: 'BracketRight', hint: 'On a hostile: attack it. On loot: grab it. On the map: Shift + right-click' },
  { id: 'siegeFocus', label: 'Moon siege: turrets focus on your target', category: 'Combat', key: 'Digit6', hint: 'At night on a siege moon: every turret in reach fires on your target for a few seconds (then it cools down)' },
  { id: 'dock', label: 'Dock / open hangar', category: 'Ship & world', key: 'KeyH', hint: "Inside a station's docking ring" },
  { id: 'interact', label: 'Use jump gate / descend to a planet', category: 'Ship & world', key: 'KeyX', hint: 'In orbit close to a planet you can land on' },
  { id: 'autopilot', label: 'Autopilot to the job you follow', category: 'Ship & world', key: 'KeyG', hint: 'Or click a place on the map. Any flight key takes back control' },
  { id: 'pickup', label: 'Pickup panel: loot in reach', category: 'Ship & world', key: 'KeyF', hint: 'Click an item to take it; Enter takes all. In mining mode ore comes in by itself' },
  { id: 'contextMenu', label: 'Action menu (hold, then right-click)', category: 'Ship & world', key: 'KeyZ', hint: 'What you can do with what is under the cursor: dock, travel, land, hail, target, fly or jump there. A plain right-click fires' },
  { id: 'respawn', label: 'Respawn', category: 'Ship & world', key: 'KeyR', hint: 'After being destroyed' },
  { id: 'menu', label: 'Menu', category: 'Interface', key: 'Escape', rebindable: false },
  { id: 'map', label: 'Galaxy / system map', category: 'Interface', key: 'Semicolon' },
  { id: 'inventory', label: 'Ship window (docked: cargo and storage)', category: 'Interface', key: 'KeyI', hint: 'Status, power, weapons, auto-pickup, refiner, fabricator and kills. You can fly with it open, but not fire' },
  { id: 'components', label: 'Component guide (the side panel)', category: 'Interface', key: 'BracketLeft', hint: 'Every ship part: the level it opens at and what it takes. Again: fold the panel' },
  { id: 'quick1', label: 'Quick bar slot 1', category: 'Ship & world', key: 'KeyC', hint: 'Uses the item in that slot of the bar at the bottom of the screen' },
  { id: 'quick2', label: 'Quick bar slot 2', category: 'Ship & world', key: 'KeyV' },
  { id: 'quick3', label: 'Quick bar slot 3', category: 'Ship & world', key: 'KeyB' },
  { id: 'quick4', label: 'Quick bar slot 4', category: 'Ship & world', key: 'KeyN' },
  { id: 'quick5', label: 'Quick bar slot 5', category: 'Ship & world', key: 'KeyM' },
  { id: 'log', label: 'Pilot log (jobs)', category: 'Interface', key: 'KeyL' },
  { id: 'skills', label: 'Skills', category: 'Interface', key: 'KeyK' },
  { id: 'nav', label: 'Toggle nav markers', category: 'Interface', key: 'Backslash' },
  { id: 'stats', label: 'Session stats panel', category: 'Interface', key: 'KeyO' },
  { id: 'party', label: 'Social: friends in the side panel (hovering a pilot: invite them)', category: 'Interface', key: 'KeyP', hint: 'Again: fold the panel' },
  { id: 'chat', label: 'Chat', category: 'Interface', key: 'Enter', rebindable: false },
  { id: 'zoom', label: 'Zoom', category: 'Interface', key: 'Wheel', rebindable: false },
  { id: 'resetZoom', label: 'Reset zoom', category: 'Interface', key: 'Home' },
];
// Part features' key bindings (ships/features: the Burst Strafer's dodge after the helm switch, the Tow Beam's after that), after the core ones so the order is stable
for (const f of CLIENT_FEATURES) for (const a of f.actions ?? []) {
  if (ACTIONS.some((x) => x.id === a.id)) throw new Error(`client feature ${f.id}: action ${a.id} already exists`);
  const at = a.after ? ACTIONS.findIndex((x) => x.id === a.after) : -1;
  if (at >= 0) ACTIONS.splice(at + 1, 0, a); else ACTIONS.push(a);
}

/** Keys that can't be bound to an action (they'd fight the browser or the menu). */
export const RESERVED_KEYS = new Set(['Escape', 'Enter', 'NumpadEnter', 'F5', 'F11', 'F12', 'MetaLeft', 'MetaRight']);

/**
 * An action's default code: the code the game's key handlers see for it whatever key the pilot bound (InputManager
 * translates), so a handler names its action and never a letter (app/keys.ts)
 */
export function actionKey(id: string): string {
  const a = ACTIONS.find((x) => x.id === id);
  if (!a) throw new Error(`no action ${id}`);
  return a.key;
}

/**
 * Default keys that moved, by the bindings version a save was made against (settings/Settings.ts BINDINGS_VERSION): a
 * saved binding still on the default of its day moves to today's (migrateBindings).
 * Only the actions whose default differs from today's are listed.
 *  1: before the weapon groups took 1-5 (2026-11-12), the quick bar was on them (production's saves);
 *  2: the quick bar on [ ] ; ' \ (dev only, a few hours);
 *  3: the quick bar on Z X C V B, the action menu on \ and interact on ; (dev only, an hour);
 *  4 (today): the quick bar on C V B N M; the five actions that were on those letters on [ ' ] \ ;
 */
const ON_CVBNM = { components: 'KeyC', helm: 'KeyV', ping: 'KeyB', nav: 'KeyN', map: 'KeyM' };
export const OLD_DEFAULT_KEYS: Readonly<Record<number, Readonly<Record<string, string>>>> = {
  1: { quick1: 'Digit1', quick2: 'Digit2', quick3: 'Digit3', quick4: 'Digit4', quick5: 'Digit5', ...ON_CVBNM },
  2: { quick1: 'BracketLeft', quick2: 'BracketRight', quick3: 'Semicolon', quick4: 'Quote', quick5: 'Backslash', ...ON_CVBNM },
  3: { quick1: 'KeyZ', quick2: 'KeyX', quick3: 'KeyC', quick4: 'KeyV', quick5: 'KeyB', contextMenu: 'Backslash', interact: 'Semicolon', nav: 'KeyN', map: 'KeyM' },
};

/** Human-readable name for a key code ('' is an action with no key: shown blank). */
export function keyName(code: string): string {
  if (code === '') return '';
  if (code === 'Mouse') return 'Mouse';
  if (code === 'Mouse0') return 'Left click';
  if (code === 'Mouse2') return 'Right click';
  if (code === 'Wheel') return 'Mouse wheel';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
  const named: Record<string, string> = {
    ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift', ControlLeft: 'Left Ctrl', ControlRight: 'Right Ctrl',
    AltLeft: 'Left Alt', AltRight: 'Right Alt', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    Space: 'Space', Escape: 'Esc', Enter: 'Enter', Tab: 'Tab', Backquote: '`', Minus: '-', Equal: '=',
    BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\',
    CapsLock: 'Caps Lock', Backspace: 'Backspace', Home: 'Home', End: 'End', PageUp: 'Page Up', PageDown: 'Page Down',
    Insert: 'Insert', Delete: 'Delete',
  };
  return named[code] ?? code;
}

/** Display name of the key an action is bound to (for the in-game "press X" hints). */
export function boundKeyName(actionId: string, bindings: Record<string, string>): string {
  const a = ACTIONS.find((x) => x.id === actionId);
  return keyName(bindings[actionId] ?? a?.key ?? '?');
}

/**
 * Server text with `{actionId}` key slots ("New work in your log ({log})"): each slot naming a known action
 * becomes the key the pilot bound to it, so the server never hard-codes a key letter. Other braces stay as sent.
 */
export function fillKeyNames(text: string, bindings: Record<string, string>): string {
  if (!text.includes('{')) return text;
  return text.replace(/\{([a-zA-Z0-9]+)\}/g, (m, id: string) => (ACTIONS.some((x) => x.id === id) ? boundKeyName(id, bindings) : m));
}
