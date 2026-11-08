/**
 * @contract client.ship.render.hull-caches
 * owns:       the shared caches of built hulls, skeleton pieces and hull-worker requests, keyed by design, and the hull key a ship wears
 * needs:      common Blueprint/ShipState, hullBuild HullBuild, LitGeometry
 * invariants: built hulls are shared by every ship of a design and kept at most HULLS_KEPT per design — client/src/ships/rigidHull.test.ts
 * extend:     a new per-design cache is one more WeakMap here
 */

import type { Blueprint, ShipState } from '@space-game/common';
import type { HullBuild } from '../hullBuild';
import type { LitGeometry } from '../../rendering/lighting/LitGeometry';

/** Each design's number (a fixed gun's look is keyed by its design, part and barrel; the hull worker keeps designs by
 * it): a design changed in place gets a new one (ShipRenderer.refresh) */
export const DESIGN_NO = new WeakMap<Blueprint, number>();
let designs = 0;
export const designNo = (bp: Blueprint) => { let n = DESIGN_NO.get(bp); if (n === undefined) DESIGN_NO.set(bp, (n = ++designs)); return n; };

/** Built hulls by design, then by which parts are attached, colouring and kind (the last few of each design: a boss's
 * hull is built again as each part breaks, and one is a lot of geometry) */
export const HULLS = new WeakMap<Blueprint, Map<string, HullBuild>>();
export const HULLS_KEPT = 6;
/**
 * A rigid design's (a boss's: Blueprint `rigid`) skeletons, built once and cut into what each part over them covers
 * (hullBuild skeletonCovered): by skeleton part, each piece with the part it's shown once gone (-1: always)
 */
export const BONES = new WeakMap<Blueprint, { sk: number; cover: number; g: LitGeometry }[]>();
/** Built once and kept whatever comes off: its parts shown and hidden as they go (ShipBatch `dep`) */
export const isRigid = (ship: ShipState) => !!ship.blueprint.rigid && ship.kind === 'ship';
/** Hulls asked of the hull worker (by design, then hull key), and designs it couldn't build (built here instead) */
export const ASKED = new WeakMap<Blueprint, Set<string>>();
export const BUILD_HERE = new WeakSet<Blueprint>();
/** The centre of mass each hull was built about (one built for parts since lost is drawn shifted onto the new centre) */
export const BUILT_COM = new WeakMap<HullBuild, ShipState["derived"]["com"]>();

/** Which built hull a ship wears: the parts attached, its colouring and kind (its design is the HULLS map it's in) */
export function hullKey(ship: ShipState, tint?: number): string {
  return `${ship.kind}|${tint ?? ''}|${isRigid(ship) ? 'whole' : ship.derived.alive.map((a) => (a ? 1 : 0)).join('')}`;
}
