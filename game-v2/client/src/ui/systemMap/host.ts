/**
 * @contract client.system-map.host
 * owns:       MapScene (one frame of the system view) and MapHost (what the map's layer and panel modules may use of SystemMapUI)
 * needs:      GameState, map types; npm: @space-game/common
 * invariants: modules reach the map only through this interface — client/src/ui/systemMap/systemMapViews.test.ts
 * extend:     a member a new layer needs is added to MapHost, and made public in SystemMapUI
 */

import { StarSystemData, type ShipDerived } from '@space-game/common';
import type { GameState } from '../../state/GameState';
import { type RouteView } from '../../ships/Autopilot';
import type { PartyMemberView } from '@space-game/common';
import type { Camera, Hit } from './types';

/** What a frame of the system view works from (worked out once per draw, then handed to each layer) */
export interface MapScene {
  ctx: CanvasRenderingContext2D;
  sx: (x: number) => number;
  sy: (y: number) => number;
  cam: Camera;
  /** World to screen scale */
  S: number;
  w: number;
  h: number;
  time: number;
  /** The central body on screen */
  ox: number;
  oy: number;
  sys: StarSystemData | undefined;
  cb: { type: string; radius?: number; hue?: number; diskHue?: number; beamHue?: number };
  /** The system's ships (near ones and the far list) */
  ships: ReturnType<MapHost['mapShips']>;
  /** Your ship, if it's in the system */
  me: ReturnType<GameState['entities']['get']>;
}

/** What the map's split-out modules may use of SystemMapUI */
export interface MapHost {
  canvas: HTMLCanvasElement;
  systems: StarSystemData[];
  sectorColor: Map<string, string>;
  byId: Map<string, StarSystemData>;
  state: GameState;
  hover: Hit | null;
  locked: ((systemId: string) => { name: string; hint: string } | null) | null;
  myRating: (() => number) | null;
  hits: Hit[];
  party: (() => PartyMemberView[]) | null;
  jump: (() => { aiming: boolean; phase: string; reach: number }) | null;
  jumpAim: { angle: number; dist: number; label: string | null } | null;
  labelQueue: { text: string; x: number; y: number; color: string; pri: number; my: number }[] | null;
  labelWidths: Map<string, number>;
  tooltip: HTMLDivElement;
  myShip: (() => ShipDerived | null) | null;
  onWarp: ((systemId: string, x?: number, y?: number) => void) | null;
  mouse: { x: number; y: number };
  belt: { inner: number; outer: number } | null;
  ghostList: import('../../state/Populations').PopGhost[];
  wreck?: () => { system: string; x: number; y: number; until: number } | null;
  autoRoute: (() => RouteView | null) | null;
  autoTarget: (() => { x: number; y: number } | null) | null;
  pings: (() => { name: string; x: number; y: number }[]) | null;
  beltDotsFor(key: string, seed: number, inner: number, outer: number, n: number): Float32Array;
  cam(): Camera;
  central(): { type: string; radius?: number; hue?: number; diskHue?: number; beamHue?: number } | null;
  destRows(t: StarSystemData | undefined): string;
  drawBodyGlyph(ctx: CanvasRenderingContext2D, cb: { type: string; hue?: number; diskHue?: number; beamHue?: number }, starColor: string | undefined, x: number, y: number, r: number, time: number): void;
  drawGalaxy(ctx: CanvasRenderingContext2D, sx: (x: number) => number, sy: (y: number) => number, cam: Camera, time: number): void;
  drawGalaxyPin(ctx: CanvasRenderingContext2D, x: number, y: number, time: number): void;
  drawJump(ctx: CanvasRenderingContext2D, me: { renderX: number; renderY: number }, sx: (x: number) => number, sy: (y: number) => number, S: number, time: number): void;
  drawLabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string): void;
  drawYou(ctx: CanvasRenderingContext2D, me: { renderAngle: number; vx: number; vy: number; renderX: number; renderY: number }, x: number, y: number, time: number, w: number, h: number): void;
  injectStyles(): void;
  label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, pri?: number, my?: number): void;
  landingDanger(x: number, y: number): string | null;
  mapShips(): { id: number; name?: string; data?: number[]; renderX: number; renderY: number; renderAngle: number }[];
  placeLabels(ctx: CanvasRenderingContext2D, you: { x: number; y: number } | null): void;
  updateTooltip(): void;
}
