/**
 * The view, apart from the controls: north up, or turned so the ship's nose points up the screen. Any of the four
 * pairings flies:
 *   mouse-steer + north up       the default: the nose chases the cursor, WASD push along the screen (the world)
 *   helm + follow heading        A/D turn, W/S along the nose, Q/E strafe, the view turned with the ship
 *   helm + north up              the same keys; only the view stays put
 *   mouse-steer + follow heading the aim is pinned in the world while the view turns (input/aimPin.ts), or the ship
 *                                would chase its own camera; WASD push along the ship (W the nose: common flight.ts
 *                                noseFrame, hits.ts CAPS.NOSE), which with the view on the nose is along the screen
 *
 * Settings gameplay.cameraMode picks it ('auto', older saves too: the view follows the controls as it always did, helm
 * turned and mouse-steer north up); the camera key switches it for the session, as V does the controls.
 */
import { settings } from '../settings/Settings';

export type CameraMode = 'auto' | 'north' | 'heading';
export const CAMERA_MODES: readonly CameraMode[] = ['auto', 'north', 'heading'];

/** Does the view follow the heading, for this setting and controls? */
export function followsHeading(mode: CameraMode, helm: boolean): boolean {
  return mode === 'heading' || (mode === 'auto' && helm);
}

export class ViewMode {
  /** The camera key's pick this session (null: the setting's) */
  private picked: 'north' | 'heading' | null = null;
  private applied: CameraMode;

  constructor(private setting: () => CameraMode) {
    this.applied = setting();
  }

  private mode(): CameraMode {
    // (The setting changed: it wins over the session's pick)
    const s = this.setting();
    if (s !== this.applied) { this.applied = s; this.picked = null; }
    return this.picked ?? s;
  }

  /** The view follows the heading */
  followsHeading(helm: boolean): boolean {
    return followsHeading(this.mode(), helm);
  }

  /** Mouse-steer with the view on the heading: the aim is pinned in the world, the keys push along the ship */
  pinnedAim(helm: boolean): boolean {
    return !helm && this.followsHeading(false);
  }

  /** The camera key: the other view, for this session. Returns the view now in use */
  toggle(helm: boolean): 'north' | 'heading' {
    this.mode();
    this.picked = this.followsHeading(helm) ? 'north' : 'heading';
    return this.picked;
  }
}

export const viewMode = new ViewMode(() => settings.data.gameplay.cameraMode);
