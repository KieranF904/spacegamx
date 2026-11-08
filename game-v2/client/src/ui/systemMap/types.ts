/** The map's shared types: the two views, the camera, and what the cursor can land on */

import { PlanetData, CometData, StructureData, StarSystemData, type SystemRegionData, type SystemZoneData } from '@space-game/common';
import { type LodestoneData } from '@space-game/common';
import { type NestData } from '@space-game/common';

export type View = 'galaxy' | 'system';
export interface Camera { x: number; y: number; scale: number }
export interface Fit { cx: number; cy: number; scale: number }

export type Hit =
  | { kind: 'system'; sys: StarSystemData; sx: number; sy: number }
  | { kind: 'station'; name: string; x: number; y: number; sx: number; sy: number }
  | { kind: 'gate'; target: StarSystemData | undefined; x: number; y: number; sx: number; sy: number }
  | { kind: 'rift'; label: string; dest: StarSystemData | undefined; x: number; y: number; sx: number; sy: number }
  | { kind: 'ship'; id: number; name: string; x: number; y: number; sx: number; sy: number }
  | { kind: 'planet'; planet: PlanetData; x: number; y: number; sx: number; sy: number }
  /** A moon you can land on (a siege) */
  | { kind: 'moon'; name: string; surface: string; planet: PlanetData; radius: number; x: number; y: number; sx: number; sy: number }
  | { kind: 'wreck'; name: string; x: number; y: number; sx: number; sy: number }
  | { kind: 'freighter'; name: string; x: number; y: number; sx: number; sy: number }
  | { kind: 'comet'; comet: CometData; x: number; y: number; sx: number; sy: number }
  | { kind: 'structure'; structure: StructureData; x: number; y: number; sx: number; sy: number }
  /** A stillstone (its field charges the jump drive; a dead or shattered one's doesn't) */
  | { kind: 'lodestone'; lodestone: LodestoneData; x: number; y: number; sx: number; sy: number }
  /** A hostile nest (its packs launch from it) */
  | { kind: 'nest'; nest: NestData; x: number; y: number; sx: number; sy: number }
  /** A pocket's way in (a boss's nest: X there takes you in) */
  | { kind: 'wayin'; pocket: StarSystemData; x: number; y: number; sx: number; sy: number }
  /** A danger band's edge (or its name) */
  | { kind: 'region'; region: SystemRegionData; inner: number; sx: number; sy: number }
  | { kind: 'zone'; zone: SystemZoneData; sx: number; sy: number }
  | { kind: 'hostile'; name: string; rating: number; rank: number; calm: boolean; sx: number; sy: number }
  /** Your own wreck, kept for you a while */
  | { kind: 'beacon'; x: number; y: number; sx: number; sy: number };

/** Hits a left click acts on (elsewhere, left fires) */
export const actionable = (h: Hit | null): h is Hit => !!h && h.kind !== 'region' && h.kind !== 'zone' && h.kind !== 'hostile';
