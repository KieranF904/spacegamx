/**
 * The dev prediction modes (Sim tools F7, Rockery demo): a registry of strategies, each the GameState.drawMode hook it
 * installs (state/drawMode.ts). Drawing only: the server, the tick layer (hits found, checks, the own ship's step and
 * its inputs) and every other client are the same in every mode; a mode changes which tick each ship is drawn at, and
 * in C2/C3 where (the PT layer, ptst.ts).
 *
 *   A   today: your ship predicted on its tick layer; every other ship at the interpolated render tick
 *   B   prediction off (drawn): your ship and shells at the render tick too, as others see you (input delay felt)
 *   C1  AI ahead: ships flown from their decisions (drones, AI pilots, custom enemies; not bosses) stepped ahead to
 *       where your shells meet them (Timeline 'ahead': your draw tick less AHEAD_BACK), their shells with them; other
 *       pilots interpolated. (The drone stopgap c0f5fb2's idea, as a mode)
 *   C2  PT/ST rubber band: every other ship on a PT layer at your tick (pilots on held last input, AI on its decisions),
 *       checked against ST each snapshot, re-stepped once on a miss and eased from old PT to new
 *   C3  C2 plus the touch register: what a missed ship touched is re-stepped with it
 */
import { AHEAD_BACK } from '@space-game/common';
import type { DrawModeHook } from '../../state/drawMode';
import type { InterpolatedEntity } from '../../state/GameState';
import type { PtStLayer } from './ptst';

export type ModeId = 'A' | 'B' | 'C1' | 'C2' | 'C3';

/** What a mode reads of the game (PredictController fills it from GameState / ShipClient; tests fake it) */
export interface ModeCtx {
  self(): number;
  /** The interpolated render tick (this frame's) */
  renderTick(): number;
  /** The newest tick a snapshot has told */
  confirmedTick(): number;
  /** The own prediction's tick (PT head) */
  predictedTick(): number;
  /** The own ship's draw tick as the timeline has it (without any mode's say) */
  ownDraw(): number;
  /** Flown here from its decisions, hits found here (BodyRunner.ahead): can be stepped ahead */
  ai(id: number): boolean;
  /** A pilot's ship (replica mode Player): hit-tested as it is on a tick, not the tick before */
  pilot(id: number): boolean;
  /** The PT/ST layer (C2/C3) */
  layer: PtStLayer;
}

export interface PredictMode {
  id: ModeId;
  label: string;
  /** One line for the panel */
  blurb: string;
  /** The PT/ST layer it runs (C2/C3) and with what */
  ptst?: { touch: boolean };
  /** The hook it installs (null: today's drawing) */
  hook(ctx: ModeCtx): DrawModeHook | null;
}

/** A pilot is hit-tested at tick t as it ended t, anyone else as it ended t - 1 (sim/timeline.ts hitStateTick): drawn that far behind your shells */
const PILOT_BACK = AHEAD_BACK - 1;

/** The tick C2/C3 draw a PT ship at, for your shells drawn this frame to meet it as they do on the tick layer */
export function ptDrawTick(ctx: ModeCtx, id: number, ownDraw: number): number {
  return Math.max(ctx.renderTick(), ownDraw - (ctx.pilot(id) ? PILOT_BACK : AHEAD_BACK));
}

function ptstHook(ctx: ModeCtx): DrawModeHook {
  let od = 0;
  const place = (e: InterpolatedEntity) => {
    const p = ctx.layer.pose(e.id, ptDrawTick(ctx, e.id, od));
    if (!p) return;
    e.x = e.renderX = p.x;
    e.y = e.renderY = p.y;
    e.angle = e.renderAngle = p.angle;
  };
  return {
    frame() {
      // (Check what's newly confirmed first, then step on to the own tick: a miss is re-stepped once, to the head as it stood)
      ctx.layer.confirm(ctx.confirmedTick());
      ctx.layer.advance(ctx.predictedTick());
      od = ctx.ownDraw();
    },
    placed: place,
    shot: (owner, present, render) => (owner === ctx.self() ? present : ctx.layer.has(owner) ? ptDrawTick(ctx, owner, od) : render),
  };
}

export const PREDICT_MODES: readonly PredictMode[] = [
  {
    id: 'A', label: 'A · current',
    blurb: 'Your ship predicted; everyone else interpolated at the render tick (today).',
    hook: () => null,
  },
  {
    id: 'B', label: 'B · prediction off',
    blurb: 'Your ship and shells drawn at the confirmed render tick too: you feel the input delay.',
    hook: (ctx) => ({ own: () => Math.min(ctx.renderTick(), ctx.confirmedTick()) }),
  },
  {
    id: 'C1', label: 'C1 · AI ahead',
    blurb: 'Drones and AI stepped ahead to where your shells meet them; other pilots interpolated.',
    hook: (ctx) => {
      let ahead = 0;
      return {
        frame() { ahead = Math.max(ctx.renderTick(), ctx.ownDraw() - AHEAD_BACK); },
        ship: (e, rt) => (ctx.ai(e.id) ? ahead : rt),
        shot: (owner, present, render) => (owner === ctx.self() ? present : ctx.ai(owner) ? ahead : render),
      };
    },
  },
  {
    id: 'C2', label: 'C2 · PT/ST rubber band',
    blurb: 'Every ship at your tick (pilots on held input); a snapshot miss re-steps it once and eases it over.',
    ptst: { touch: false },
    hook: ptstHook,
  },
  {
    id: 'C3', label: 'C3 · + touch register',
    blurb: 'C2, and what a mispredicted ship touched is re-stepped with it.',
    ptst: { touch: true },
    hook: ptstHook,
  },
];

export function modeById(id: string | null | undefined): PredictMode | undefined {
  return PREDICT_MODES.find((m) => m.id === id?.toUpperCase());
}
