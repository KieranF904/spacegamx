/**
 * Every control in the game. `key` is the default binding and also the code
 * the game logic listens for: InputManager translates whatever key the player
 * bound to an action into that code, so the rest of the client never needs
 * to know about rebinding.
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
  { id: 'helm', label: 'Switch mouse-steer / helm', category: 'Flight', key: 'KeyV' },
  { id: 'aim', label: 'Aim / steer', category: 'Flight', key: 'Mouse', rebindable: false },
  { id: 'fire', label: 'Fire', category: 'Combat', key: 'Mouse0', alt: 'Mouse2', rebindable: false },
  { id: 'targetNext', label: 'Target the next hostile', category: 'Combat', key: 'Tab', hint: 'Nearest first. Missiles lock on to your target' },
  { id: 'targetCursor', label: 'Target the ship under the cursor', category: 'Combat', key: 'KeyT', hint: 'On empty space: clear the target' },
  { id: 'feeds', label: 'Switch feeds (Selectors)', category: 'Combat', key: 'KeyY', hint: 'On a ports ship: every Selector passes its other tank; what is in the lines and buffers runs out first' },
  { id: 'ping', label: 'Ping for your party (with Shift: danger)', category: 'Combat', key: 'KeyB', hint: 'On a hostile: attack it. On loot: grab it. On the map: Shift + right-click' },
  { id: 'siegeFocus', label: 'Moon siege: turrets focus on your target', category: 'Combat', key: 'KeyU', hint: 'At night on a siege moon: every turret in reach fires on your target for a few seconds (then it cools down)' },
  { id: 'dock', label: 'Dock / open hangar', category: 'Ship & world', key: 'KeyH', hint: "Inside a station's docking ring" },
  { id: 'interact', label: 'Use jump gate / descend to a planet', category: 'Ship & world', key: 'KeyX', hint: 'In orbit close to a planet you can land on' },
  { id: 'autopilot', label: 'Autopilot to the job you follow', category: 'Ship & world', key: 'KeyG', hint: 'Or click a place on the map (M). Any flight key takes back control' },
  { id: 'pickup', label: 'Tractor beam pickup', category: 'Ship & world', key: 'KeyF' },
  { id: 'contextMenu', label: 'Action menu (hold, then right-click)', category: 'Ship & world', key: 'KeyZ', hint: 'What you can do with what is under the cursor: dock, travel, land, hail, target, fly or jump there. A plain right-click fires' },
  { id: 'respawn', label: 'Respawn', category: 'Ship & world', key: 'KeyR', hint: 'After being destroyed' },
  { id: 'menu', label: 'Menu', category: 'Interface', key: 'Escape', rebindable: false },
  { id: 'map', label: 'Galaxy / system map', category: 'Interface', key: 'KeyM' },
  { id: 'inventory', label: 'Cargo and storage', category: 'Interface', key: 'KeyI' },
  { id: 'components', label: 'Component guide', category: 'Interface', key: 'KeyC', hint: 'Every ship part: the level it opens at and what it takes' },
  { id: 'quick1', label: 'Quick bar slot 1', category: 'Ship & world', key: 'Digit1' },
  { id: 'quick2', label: 'Quick bar slot 2', category: 'Ship & world', key: 'Digit2' },
  { id: 'quick3', label: 'Quick bar slot 3', category: 'Ship & world', key: 'Digit3' },
  { id: 'quick4', label: 'Quick bar slot 4', category: 'Ship & world', key: 'Digit4' },
  { id: 'quick5', label: 'Quick bar slot 5', category: 'Ship & world', key: 'Digit5' },
  { id: 'log', label: 'Pilot log (jobs)', category: 'Interface', key: 'KeyL' },
  { id: 'skills', label: 'Skills', category: 'Interface', key: 'KeyK' },
  { id: 'nav', label: 'Toggle nav markers', category: 'Interface', key: 'KeyN' },
  { id: 'stats', label: 'Session stats panel', category: 'Interface', key: 'KeyO' },
  { id: 'party', label: 'Party window (hovering a pilot: invite them)', category: 'Interface', key: 'KeyP' },
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

/** Human-readable name for a key code. */
export function keyName(code: string): string {
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
