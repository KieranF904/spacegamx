/**
 * @contract client.gun-range.state
 * owns:       the client's copy of this pilot's gun range state (the last gunRangeState): in or out, the weapon flown, the
 *             weapons on offer, the door, the targets' entities and the station to go back to; `inGunRange()` for the code
 *             that behaves differently in there (keys, HUD, ammo shown)
 * needs:      @space-game/common (ServerGunRangeStateMessage, GunRangeDef type), rendering/terrainData (gunRangeFor)
 * invariants: in only between an `in: true` state and the next `in: false` (or a reset on disconnect) — client/src/ui/gunRange/rangeState.test.ts
 *             the chamber is the systems.json one for the system you are in (the same def the server's walls come from) — client/src/ui/gunRange/rangeState.test.ts
 * extend:     a new thing the client keeps about the range is a field of RangeView, filled in setRangeState
 *
 * One module-level store (like ships/field/fieldState): the range's UI, the key gate and the readouts read it; only the
 * gunRangeState handler (app/serverMessages.ts) writes it. Nothing here is predicted: the server says when you are in.
 */

import type { GunRangeDef, ServerGunRangeStateMessage } from '@space-game/common';
import { gunRangeFor } from '../../rendering/terrainData';

export interface RangeView {
  in: boolean;
  /** The weapon model the cheat ship carries */
  weapon: string;
  /** Every weapon model this pilot may pick, in catalog order */
  options: readonly string[];
  /** Where X takes you out, and how near */
  door: { x: number; y: number; reach: number } | null;
  /** Each target: its entity (-1 while it is down), its spot and its name */
  targets: readonly { id: number; x: number; y: number; label: string }[];
  /** The station they came from (its name) */
  station: string;
}

const OUT: RangeView = { in: false, weapon: '', options: [], door: null, targets: [], station: '' };
let view: RangeView = OUT;
let version = 0;
const listeners = new Set<(v: RangeView) => void>();

/** The last state the server sent (OUT before any) */
export function rangeState(): RangeView {
  return view;
}

/** In the gun range now */
export function inGunRange(): boolean {
  return view.in;
}

/** Bumped on every change (a cheap "redraw?" key for the per-frame UI) */
export function rangeVersion(): number {
  return version;
}

/** Take in a gunRangeState; returns whether this one took the pilot in (`entered`) or out (`left`) */
export function setRangeState(msg: ServerGunRangeStateMessage): { entered: boolean; left: boolean } {
  const was = view.in;
  view = msg.in
    ? {
      in: true, weapon: msg.weapon ?? view.weapon, options: msg.options ?? view.options,
      door: msg.door ?? view.door, targets: msg.targets ?? view.targets, station: msg.station ?? view.station,
    }
    : { ...OUT, station: msg.station ?? '' };
  version++;
  for (const fn of listeners) fn(view);
  return { entered: !was && view.in, left: was && !view.in };
}

/** Out of the range on the client's side (a disconnect: the server takes the pilot back to the station itself) */
export function resetRangeState(): void {
  if (!view.in) return;
  view = OUT;
  version++;
  for (const fn of listeners) fn(view);
}

/** Called on every change; returns the unsubscribe */
export function onRangeState(fn: (v: RangeView) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The chamber of the system you are in, if it is a gun range (systems.json `gunRange`) */
export function chamberOf(systemId: string | null | undefined): GunRangeDef | null {
  return gunRangeFor(systemId);
}
