/**
 * Player settings: one object, saved to localStorage, with change listeners.
 * Everything here is client-side preference (nothing is sent to the server).
 */

import { ACTIONS, OLD_DEFAULT_KEYS } from '../input/keybindings';
import type { QualitySetting } from './quality';
import type { CameraMode } from '../input/viewMode';

/** Mouse-aim always, unless the pilot picks helm (the old 'auto' is read as mouse) */
export type ControlMode = 'mouse' | 'helm';
export type JumpMode = 'tap' | 'hold';

export interface SettingsData {
  audio: { master: number; sfx: number; music: number; muteUnfocused: boolean };
  display: {
    screenShake: number;
    jumpEffects: boolean;
    jumpCamera: boolean;
    planets: boolean;
    damageNumbers: boolean;
    playerNames: boolean;
    /** Glow around engines, shots and sparks */
    bloom: boolean;
    /** Ships, stations and asteroids lit by the sun, weapons, engines and lamps (off: flat colours) */
    lighting: boolean;
    /** Rendering resolution as a fraction of the screen's (pixel density is capped at 2) */
    renderScale: number;
    /** Graphics quality tier (auto: starts at high, steps down while the frame rate is poor) */
    quality: QualitySetting;
    /** Frame-rate cap (0: none) */
    fpsCap: number;
    /** Your own shield's resting rim, 0..1 of the full look (hits and recharging always show) */
    ownShield: number;
  };
  ui: {
    navMarkers: boolean; minimap: boolean; shipHud: boolean; netStats: boolean; chat: boolean; hazardEffects: boolean;
    /** The jobs tracker (off: just its header, to bring it back) */
    questTracker: boolean;
    /** The objective guide: the next waypoint under the tracker, and chevrons from your ship towards it */
    questGuide: boolean;
  };
  gameplay: {
    controlMode: ControlMode; jumpMode: JumpMode; invertZoom: boolean; zoomSpeed: number;
    /** The view (input/viewMode.ts): 'auto' follows the controls (helm turned, mouse-steer north up), as before it was a setting */
    cameraMode: CameraMode;
    /** Weapon groups (ships/weaponGroups): the mouse wheel cycles the left button's group instead of zooming (zoom stays on Home) */
    wheelGroups: boolean;
  };
  /** Action id → key code (KeyboardEvent.code); '' is an action left with no key (migrateBindings) */
  bindings: Record<string, string>;
  /** Which default keys the saved bindings were made against (BINDINGS_VERSION; absent in a save: 1) */
  bindingsVersion: number;
}

export function defaultSettings(): SettingsData {
  return {
    audio: { master: 0.8, sfx: 1, music: 0.5, muteUnfocused: true },
    display: { screenShake: 1, jumpEffects: true, jumpCamera: true, planets: true, damageNumbers: true, playerNames: true, bloom: true, lighting: true, renderScale: 1, quality: 'high', fpsCap: 0, ownShield: 0.6 },
    ui: { navMarkers: true, minimap: true, shipHud: true, netStats: false, chat: true, hazardEffects: true, questTracker: true, questGuide: true },
    gameplay: { controlMode: 'mouse', jumpMode: 'tap', invertZoom: false, zoomSpeed: 1, cameraMode: 'auto', wheelGroups: false },
    bindings: Object.fromEntries(ACTIONS.filter((a) => a.rebindable !== false).map((a) => [a.id, a.key])),
    bindingsVersion: BINDINGS_VERSION,
  };
}

/**
 * 2 (2026-11-12): the weapon groups took 1-5 (group1..group5); the quick bar moved to [ ] ; ' \
 * 3 (2026-11-12): the quick bar took Z X C V B; the action menu, interact, the component guide, the helm switch and the
 *    ping moved off them (\ ; [ ' ])
 * 4 (2026-11-12): the quick bar on C V B N M; the action menu and interact back on Z and X; the component guide, the helm
 *    switch, the ping, the nav markers and the map on [ ' ] \ ;
 * (2 and 3 were on the dev server only; production's saves are version 1)
 */
export const BINDINGS_VERSION = 4;

/**
 * Saved bindings made against older default keys (`version`: the save's bindingsVersion, 1 when it has none), put right
 * once (a save has every action's key in it, so an untouched quick bar would otherwise stay where it was and take another
 * action's presses without a word):
 *  - an action still on the default it had at that version (keybindings.ts OLD_DEFAULT_KEYS: a quick bar slot, or an
 *    action whose letter the quick bar took, or gave back) moves to today's default; one the pilot had moved stays where it is;
 *  - then no two actions share a key: the pilot's own choice keeps it, and the action that only has it as a default (a new
 *    action, or one just moved) is left with no key ('': the Controls page shows it blank, to be bound by hand).
 * Returns the saved bindings to merge over the defaults.
 */
export function migrateBindings(saved: Record<string, unknown>, defaults: Readonly<Record<string, string>>, version = 1): Record<string, string> {
  const moved = OLD_DEFAULT_KEYS[version] ?? {};
  const own: Record<string, string> = {};
  for (const [id, code] of Object.entries(saved)) if (typeof code === 'string' && moved[id] !== code) own[id] = code;
  const taken = new Set(Object.values(own));
  const out: Record<string, string> = { ...own };
  for (const [id, code] of Object.entries(defaults)) if (!(id in own) && taken.has(code)) out[id] = '';
  return out;
}

const STORAGE_KEY = 'spacegame.settings.v1';

/** Deep-merge saved values over the defaults, so new settings get their default. */
function merge<T>(base: T, saved: unknown): T {
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return base;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...base };
  for (const [k, v] of Object.entries(saved as object)) {
    const b = (base as any)[k];
    if (b && typeof b === 'object' && !Array.isArray(b)) out[k] = merge(b, v);
    else if (b === undefined || typeof b === typeof v) out[k] = v;
  }
  return out;
}

/** Saved settings (any age) over the defaults, with values that are no longer offered put right */
export function loadSettings(saved: unknown): SettingsData {
  const defaults = defaultSettings();
  const s = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved as Record<string, unknown> : null;
  // (Bindings saved against older default keys: migrateBindings)
  const old = !!s && !!s.bindings && typeof s.bindings === 'object' && !(Number(s.bindingsVersion) >= BINDINGS_VERSION);
  const data = merge(defaults, old ? { ...s, bindings: migrateBindings(s!.bindings as Record<string, unknown>, defaults.bindings, Math.max(1, Math.floor(Number(s!.bindingsVersion)) || 1)) } : saved);
  data.bindingsVersion = BINDINGS_VERSION;
  // (Saved before helm was opt-in: 'auto', or anything else unknown, is mouse-aim)
  if (data.gameplay.controlMode !== 'helm') data.gameplay.controlMode = 'mouse';
  // (Saved before the view was its own setting: it follows the controls, as it did)
  if (!['auto', 'north', 'heading'].includes(data.gameplay.cameraMode)) data.gameplay.cameraMode = 'auto';
  if (!['auto', 'low', 'medium', 'high'].includes(data.display.quality)) data.display.quality = 'high';
  if (![0, 30, 60, 120, 144].includes(data.display.fpsCap)) data.display.fpsCap = 0;
  return data;
}

class SettingsStore {
  data: SettingsData;
  private listeners = new Set<(s: SettingsData) => void>();

  constructor() {
    let saved: unknown = null;
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'); } catch { /* private window, corrupt data */ }
    this.data = loadSettings(saved);
  }

  /** Call `fn` now and on every change. */
  subscribe(fn: (s: SettingsData) => void): () => void {
    this.listeners.add(fn);
    fn(this.data);
    return () => this.listeners.delete(fn);
  }

  /** Change settings in place, then save and notify. */
  update(fn: (s: SettingsData) => void): void {
    fn(this.data);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data)); } catch { /* storage unavailable: session only */ }
    for (const l of this.listeners) l(this.data);
  }

  reset(section?: keyof SettingsData): void {
    const d = defaultSettings();
    this.update((s) => {
      if (section) (s as any)[section] = d[section];
      else Object.assign(s, d);
    });
  }
}

export const settings = new SettingsStore();
