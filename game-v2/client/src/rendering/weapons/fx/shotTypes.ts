/**
 * @contract client.weapon-fx.shot-types
 * owns:       the record of one drawn shell (Shot) and the shapes WeaponFx's callers hand it (PredictedShell, ShellLook, DrawnHit)
 * needs:      weaponStyles (WeaponStyle type)
 * invariants: a Shot's head and tail are null until it has left the barrel on its timeline — client/src/rendering/weapons/visualStop.test.ts
 * extend:     a new per-shell field is one line on Shot, set in shotFactory
 */

import type { WeaponStyle } from '../weaponStyles';
import type { ModFx } from './mods/kit';

export interface Shot {
  id: number;
  style: WeaponStyle;
  /** Shell size relative to the base shot (fixed cannons fire bigger shells) */
  size: number;
  /** x its flash, recoil and impact, from its damage (weaponStyles.shotScale) */
  power: number;
  /** Its own phase for sway and pulsing (so two shots do not beat together) */
  phase: number;
  /** x its brightness: a stream's dim rounds (style.accent) */
  dim: number;
  /** The firing gun's spin as it left the barrel (0..1): turns its colours from cold to hot (style.heat) */
  hot: number;
  type: number;
  owner: number;
  glow: number;
  spawnX: number;
  spawnY: number;
  spawnTick: number;
  vx: number;
  vy: number;
  hit: { x: number; y: number } | null;
  /** Its muzzle flash has gone off (at age 0 on its timeline): its shot is heard then (sounds) */
  flashed: boolean;
  /** Its gun's model, grade and mount, for its shot's sound */
  model?: string;
  grade: number;
  turret: boolean;
  /** Fired by your own client ahead of the server (until the server's copy takes it over) */
  predicted: boolean;
  /** The firing ship's pose on the fire tick (the flash sits on the barrel in its frame) */
  pose?: FirePoseXY;
  /** Drawn from the barrel's tip, not the spawn point: this offset at first, easing to none over BARREL_EASE ticks (muzzleFlash) */
  vox?: number;
  voy?: number;
  /** The tick its flight ends (a mortar's landing: projectile row data[9]), 0 for none */
  endTick: number;
  /** Where it lands, when it has an end */
  landX: number;
  landY: number;
  /** Its blast radius (world units), when its gun is known: the landing ring's */
  splash: number;
  /** 0..1 through its flight to its end (swells a lobbed shell) */
  arc: number;
  /** The timeline tick it was last placed at */
  t: number;
  /** Rings swelled so far (a sonar's, accumulated so a changing period never jumps the phase) */
  pulse: number;
  /** Frames since the shot stopped (hit or removed); null while flying */
  fading: number | null;
  /** Hulls it can still pass through (its gun's pierce; the server's count): a hit on one throws the impact and flies on */
  pierceLeft: number;
  /**
   * The tick its flight ends on its timeline (Infinity until known): the end of its life, where that's known (fire-event
   * and predicted shells), or about where the server dropped it. A straight shell flies on to it after the server's
   * removal comes (another pilot's is drawn a few ticks behind the server: a short-lived shell, the Spark's six ticks,
   * would otherwise be gone before it got out of the barrel) and stops there however late the removal comes.
   */
  endAt: number;
  /** The server has removed it: it flies out what's left of its flight on its timeline */
  gone: boolean;
  /** Hits reported ahead of where it's drawn (its timeline behind the server's): each lands as the head gets there */
  pending: { x: number; y: number; age: number; at: number }[] | null;
  head: { x: number; y: number } | null;
  tail: { x: number; y: number } | null;
  /** Where its contrail was last laid down (NaN until the first frame) */
  ctX: number;
  ctY: number;
  /**
   * It stopped at a surface drawn here (castHit), or at the server's hit: nothing of it is drawn past that point, and
   * from then on the server's hits for it only confirm (never move its impact or bring it back)
   */
  ended: boolean;
  /** When it ended (clock): it's kept, undrawn, for a while after its fade, so a late row, hit or adopt finds it ended */
  endedAt: number;
  /** Ships it has passed through (a piercing shell's surfaces, as drawn here): not struck again */
  passed: number[] | null;
  /** Hits drawn here the server hasn't told yet: its hits for them are taken as said */
  unconfirmed: number;
  /** Ticks into its flight before it can strike anything (a shell that arms late: the Leviathan's) */
  arm: number;
  /** Its gun's live modifier effects (each an effect id and a strength): what its modifier layers draw (fx/mods) */
  fx?: readonly ModFx[];
}

/** Where a shell's drawn line meets a drawn surface (WeaponFx.castHit fills it) */
export interface DrawnHit { t: number; x: number; y: number; target: number }

export interface ShellLook { model?: string; damage?: number; splash?: number; pierce?: number; life?: number; arm?: number; /** Its gun's live modifier effects (fx/mods) */ fx?: readonly ModFx[] }

export interface FirePoseXY { x: number; y: number; angle: number }

/** A shell your client fired ahead of the server */
export interface PredictedShell {
  /** Your ship's pose on the fire tick */
  pose: FirePoseXY;
  owner: number;
  type: number;
  /** Its gun's grade (Mk I-V): the mark only scales its size and brightness */
  grade?: number;
  /** Its gun's model (PlacedPart.fn): its look (weaponStyles MODEL_STYLES) */
  model?: string;
  /** Damage a shot does: its recoil, flash and impact scale with it */
  damage?: number;
  /** Hulls it passes through (its gun's pierce) */
  pierce?: number;
  /** Ticks it flies (a straight shell's life), if known */
  life?: number;
  /** Ticks before it can strike anything (it arms late), if any */
  arm?: number;
  /** Ticks it flies to where it ends at the aim (an aim burst's fuse), if it does */
  fuse?: number;
  /** Fired from a turret (its shot's sound) */
  turret?: boolean;
  /** Its gun's live modifier effects (fx/mods) */
  fx?: readonly ModFx[];
  spawnX: number;
  spawnY: number;
  spawnTick: number;
  vx: number;
  vy: number;
  size: number;
}
