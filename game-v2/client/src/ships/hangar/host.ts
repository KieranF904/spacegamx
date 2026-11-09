/**
 * @contract client.hangar.host
 * owns:       HangarDeps (what the hangar needs from the game) and HangarHost (what its split-out modules may use of the editor)
 * needs:      common ship types, PortsGrid, HangarLitView
 * invariants: modules reach the editor only through this interface — none pinned
 * extend:     a member a new module needs is added to HangarHost, and made public in HangarUI
 */
import { Blueprint, Catalog, Economy, Bag, PlacedPart, PlacedGeom, Side, ShipTuning, ShipDerived, Vec2, BlueprintError, TurretWindow, ClientMessage, ServerHangarMessage, ShipState, type MountingProblem } from '@space-game/common';
import { type LoadTestResult } from '@space-game/common';
import { type PowerReport } from '../wireEdit';
import { PortsGrid } from '../portsGrid';
import type { FlowCanvasLayer } from '../build/powerFlowView';
import { HangarLitView } from '../HangarLitView';
import { type PartTipCtx } from '../partTip';
import type { HangarAids } from './hangarAids';
import type { DeltaHover } from '../build/statDeltaView';
import type { StatDelta } from '../build/statDelta';

export interface HangarDeps {
  catalog: Catalog;
  tuning: ShipTuning;
  econ: Economy;
  /** Parts the pilot has for a slot: storage and the hold's modules, plus that slot's built parts (part item id → count) */
  owned(slot: number): Bag;
  /** Hangar slots and jobs, as the server last sent them */
  hangarState(): ServerHangarMessage | null;
  /** Can the pilot fabricate this item (licences) */
  canMake(id: string): boolean;
  /** The pilot's level (what a locked model waits on) */
  level?(): number;
  /** Licences and recipes the pilot has learned (profile.recipes: the palette's gates, ui/componentGuide.ts) */
  learned?(): string[];
  /** Cargo + storage count of an item */
  have(id: string): number;
  /** Mass of what's in the hold now (common/src/ships/load.ts) */
  cargoMass?(): number;
  /** Station storage's count of an item (unused since wire spools stopped being billed) */
  stored?(id: string): number;
  /** Parts on their way from the fabricator */
  coming(): Bag;
  send(m: ClientMessage): void;
  /** Ship plans the pilot knows (blueprint file names) */
  knownPlans(): string[];
  /** Designs party members sent you (newest first) */
  sharedDesigns?(): { from: string; blueprint: Blueprint }[];
  /** Proto/admin: every part is free */
  grantAll: boolean;
  /** The blueprint the player is flying now */
  getBlueprint(): Blueprint;
  /** The ship you're flying (its parts' HP now) */
  liveShip?(): ShipState | undefined;
  onOpen(): void;
  /** `launch` is the saved blueprint to respawn with, or null when closed without saving */
  onClose(launch: Blueprint | null): void;
}

export type Overlay = 'energy' | 'connectors' | 'joins' | 'power' | 'com' | 'thrust' | 'arcs';

/** What the hangar's split-out modules may use of the editor (HangarUI implements it) */
export interface HangarHost {
  deps: HangarDeps;
  feedPreviewKey: string;
  derived: ShipDerived | null;
  feedPreviewFor: ShipDerived | null;
  feedPreviewVal: { feeds: number[]; hint: string } | null;
  bp: Blueprint;
  /** Undo / redo and symmetry */
  readonly aids: HangarAids;
  ctx: CanvasRenderingContext2D;
  geoms: PlacedGeom[];
  view: { cx: number; cy: number; px: number };
  power: PowerReport | null;
  overlays: Record<Overlay, boolean>;
  isOpen: boolean;
  canvas: HTMLCanvasElement;
  lit: HangarLitView;
  grid: HTMLCanvasElement;
  errors: BlueprintError[];
  /** Parts (uids) the core doesn't hold on to: planned only, drawn faded and dashed */
  unreachable: ReadonlySet<number>;
  grantAll: boolean;
  slot: number;
  mountingBroken: Map<number, MountingProblem[]>;
  ports: PortsGrid;
  /** The power flow overlay's animated layer (pulses, ticks, crosses) */
  flow: FlowCanvasLayer;
  /** Turn the power flow overlay on or off (and remember it) */
  setEnergy(on: boolean): void;
  mouse: Vec2 | null;
  /** The cursor on screen, and what placing / removing under it would change (hangarDelta.ts) */
  mouseClient: { x: number; y: number } | null;
  deltaHover: DeltaHover;
  deltaNow: StatDelta | null;
  paletteHover: { fn: string; piece: string; material: string } | null;
  handTurn(): { rot: 0 | 1 | 2 | 3; flip: boolean };
  stats: HTMLDivElement;
  designSig: string;
  loadSelect: HTMLSelectElement;
  devApi: boolean;
  plan: string | undefined;
  designsOpen: boolean;
  designAsk: { slot: number; kind: 'save' | 'delete' } | null;
  designPanel: HTMLDivElement;
  designBtn: HTMLButtonElement;
  tipKey: string;
  tip: HTMLDivElement;
  tipGen: number;
  ammoHtml(): string;
  bindBuildButtons(): void;
  boltGlyph(cx: number, cy: number, r: number, color: string): void;
  bothTest(): LoadTestResult | null;
  buildHtml(): string;
  candidate(g: Vec2): PlacedPart | null;
  candidateMounting(p: PlacedPart, g?: PlacedGeom): MountingProblem[];
  close(launch: Blueprint | null): void;
  deleteDesign(slot: number): void;
  designKey(): string;
  designs(): (Blueprint | null)[];
  draw(): void;
  drawBanks(d: ShipDerived, sx: (x: number) => number, sy: (y: number) => number, ring: number): void;
  drawFacing(g: PlacedGeom, side: Side, sx: (x: number) => number, sy: (y: number) => number): void;
  drawFeedPreview(cand: PlacedPart, g: PlacedGeom, sx: (x: number) => number, sy: (y: number) => number): void;
  drawMounting(g: PlacedGeom, broken: MountingProblem[], sx: (x: number) => number, sy: (y: number) => number, all: boolean): void;
  drawPower(d: ShipDerived, sx: (x: number) => number, sy: (y: number) => number): void;
  drawWindow(w: TurretWindow, sx: (x: number) => number, sy: (y: number) => number, alpha: number, ctx?: CanvasRenderingContext2D): void;
  feedPreview(cand: PlacedPart): { feeds: number[]; hint: string } | null;
  readonly free: boolean;
  ghostInfo(): { ghosts: Set<number>; fresh: Set<number> };
  gridTip(e: MouseEvent): void;
  hideTip(): void;
  loadDesign(slot: number): void;
  loadSelected(): Promise<void>;
  partAt(g: Vec2): number;
  partName(i: number): string;
  placementProblem(p: PlacedPart): string | null;
  plans(): { file: string; bp: Blueprint }[];
  portsHtml(L: NonNullable<ShipDerived['ports']>): string;
  powerHtml(): string;
  recenter(): void;
  refresh(): void;
  refreshLoadList(): Promise<void>;
  remaining(id: string): number;
  renderDesigns(): void;
  renderPalette(): void;
  renderStats(): void;
  saveDesign(slot: number): void;
  showTip(key: string, html: () => string, x: number, y: number): void;
  status(text: string): void;
  summaryHtml(): string;
  tipCtx(): PartTipCtx;
  toggleDesigns(open?: boolean): void;
  readonly unsaved: boolean;
}
