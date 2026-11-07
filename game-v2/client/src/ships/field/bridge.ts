/**
 * What the field-fabrication client needs from the game, and where its parts meet (the `machines` client feature, the
 * HUD, the build overlay). ShipClient mounts it once (mount.ts); the feature reads it each frame. A module-level
 * object, as viewMode and cameraView are: the feature hooks get only the ClientFeatureHost.
 */
import type { Catalog, ShipTuning, Economy, ClientMessage, ShipState } from '@space-game/common';
import type { InterpolatedEntity } from '../../state/GameState';
import { fieldClient, machineProgress, type FieldClocks } from './fieldState';
import type { FieldHud } from './FieldHud';
import type { FieldOverlay } from './FieldOverlay';

/** The camera, as the overlay moves it: the zoom, the helm view, and where a screen point is in the world */
export interface FieldView {
  zoom(): number;
  setZoom(z: number): void;
  helm(): boolean;
  setHelm(on: boolean): void;
  screenToWorld(x: number, y: number): { x: number; y: number };
}

export interface FieldDeps {
  catalog: Catalog;
  tuning: ShipTuning;
  econ: Economy;
  send(msg: ClientMessage): void;
  /** A line at the top of the screen */
  toast(text: string, kind?: 'info' | 'good' | 'warn' | 'bad'): void;
  /** The pilot's own ship and its entity (undefined: none, docked or dead) */
  ship(): ShipState | undefined;
  entity(): InterpolatedEntity | undefined;
  /** The own ship's clocks as predicted now */
  clocks(): FieldClocks;
  level(): number;
  learned(): string[];
  have(id: string): number;
  canMake(id: string): boolean;
  /** The flight keys reach the ship (no menu or hangar over the game) */
  flying(): boolean;
  view: FieldView;
}

export const fieldBridge: { deps: FieldDeps | null; hud: FieldHud | null; overlay: FieldOverlay | null } = {
  deps: null,
  hud: null,
  overlay: null,
};

/** What the HUD's schematic shows of field work on your ship: the part being built or repaired, and parts being recycled */
export interface FieldHudMarks { build: number; k: number; repair: boolean; recycle: ReadonlySet<number> }

const MARKS: FieldHudMarks & { recycle: Set<number> } = { build: -1, k: 0, repair: false, recycle: new Set() };

/** Field work on `ship` for the schematic (indices into its parts); null when there is none */
export function fieldHudMarks(ship: ShipState): FieldHudMarks | null {
  const st = fieldClient.state, clocks = fieldBridge.deps?.clocks();
  if (!st || !clocks) return null;
  const parts = ship.blueprint.parts;
  MARKS.build = -1; MARKS.recycle.clear();
  for (const m of st.machines) {
    const uid = m.job?.uid;
    if (uid === undefined || m.job!.kind === 'refine') continue;
    const i = parts.findIndex((p) => p.uid === uid);
    if (i < 0) continue;
    if (m.job!.kind === 'recycle') { MARKS.recycle.add(i); continue; }
    MARKS.build = i; MARKS.k = machineProgress(m, clocks); MARKS.repair = m.job!.kind === 'repair';
  }
  const rec = fieldClient.recycleUids();
  if (rec.size) parts.forEach((p, i) => { if (rec.has(p.uid)) MARKS.recycle.add(i); });
  return MARKS.build >= 0 || MARKS.recycle.size ? MARKS : null;
}
