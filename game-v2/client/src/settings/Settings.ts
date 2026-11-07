/**
 * Player settings: one object, saved to localStorage, with change listeners.
 * Everything here is client-side preference (nothing is sent to the server).
 */

import { ACTIONS } from '../input/keybindings';
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
    /** Number keys 1-4 pick the left button's group and 5 picks all, instead of the quick bar */
    digitGroups: boolean;
  };
  /** Action id → key code (KeyboardEvent.code) */
  bindings: Record<string, string>;
}

export function defaultSettings(): SettingsData {
  return {
    audio: { master: 0.8, sfx: 1, music: 0.5, muteUnfocused: true },
    display: { screenShake: 1, jumpEffects: true, jumpCamera: true, planets: true, damageNumbers: true, playerNames: true, bloom: true, lighting: true, renderScale: 1, quality: 'high', fpsCap: 0, ownShield: 0.6 },
    ui: { navMarkers: true, minimap: true, shipHud: true, netStats: false, chat: true, hazardEffects: true, questTracker: true, questGuide: true },
    gameplay: { controlMode: 'mouse', jumpMode: 'tap', invertZoom: false, zoomSpeed: 1, cameraMode: 'auto', wheelGroups: false, digitGroups: false },
    bindings: Object.fromEntries(ACTIONS.filter((a) => a.rebindable !== false).map((a) => [a.id, a.key])),
  };
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
  const data = merge(defaultSettings(), saved);
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
