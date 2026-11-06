/**
 * The prediction modes: a registry of strategies, each the GameState.drawMode hook it installs (state/drawMode.ts).
 * C3 is the game's prediction (Prediction.ts installs it at start, dev and production builds alike); the others are
 * dev-only alternatives, switched live from the Sim tools (F7, client dev/predict/PredictController.ts). Drawing only:
 * the server, the tick layer (hits found, checks, the own ship's step and its inputs) and every other client are the
 * same in every mode; a mode changes which tick each ship is drawn at, and in C2/C3 where (the PT layer, ptst.ts).
 *
 *   A   the old drawing: your ship predicted on its tick layer; every other ship at the interpolated render tick
 *   B   prediction off (drawn): your ship and shells at the render tick too, as others see you (input delay felt)
 *   C1  AI ahead: ships flown from their decisions (drones, AI pilots, custom enemies; not bosses) stepped ahead to
 *       where your shells meet them (Timeline 'ahead': your draw tick less AHEAD_BACK), their shells with them; other
 *       pilots interpolated. (The drone stopgap c0f5fb2's idea, as a mode)
 *   C2  PT/ST rubber band: every other ship on a PT layer at your tick (pilots on held last input, AI on its decisions),
 *       checked against ST each snapshot, re-stepped once on a miss and eased from old PT to new
 *   C3  C2 plus the touch register: what a missed ship touched is re-stepped with it (the default: DEFAULT_MODE)
 */
import { AHEAD_BACK } from '@space-game/common';
import type { DrawModeHook } from '../state/drawMode';
import type { InterpolatedEntity } from '../state/GameState';
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
  /** Ticks behind your shells' draw tick a PT ship is drawn at (its kind's, predict/kinds.ts: a pilot 0.5, others AHEAD_BACK) */
  drawBack(id: number): number;
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

/** The game's prediction */
export const DEFAULT_MODE: ModeId = 'C3';

/**
 * The tick C2/C3 draw a PT ship at, for your shells drawn this frame to meet it as they do on the tick layer (a pilot
 * is hit-tested at tick t as it ended t, anyone else as it ended t - 1: sim/timeline.ts hitStateTick)
 */
export function ptDrawTick(ctx: ModeCtx, id: number, ownDraw: number): number {
  return Math.max(ctx.renderTick(), ownDraw - ctx.drawBack(id));
}

/** ms a ship going onto the PT layer or off it eases between its interpolated pose and its PT one */
export const PT_SWITCH_MS = 250;

interface Ease { dx: number; dy: number; da: number; at: number }
const wrapA = (d: number) => { while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };

function ptstHook(ctx: ModeCtx): DrawModeHook {
  let od = 0, frame = 0, now = 0;
  /** Ships drawn last frame (the frame), and where if from PT */
  const drawn = new Map<number, number>();
  const ptLast = new Map<number, { x: number; y: number; angle: number }>();
  /** A ship going onto PT or off it: what's left of the gap between the two poses */
  const eases = new Map<number, Ease>();
  const ease = (e: InterpolatedEntity, x: number, y: number, a: number) => {
    const o = eases.get(e.id);
    if (o) {
      const u = (now - o.at) / PT_SWITCH_MS, w = u >= 1 ? 0 : 1 - u * u * (3 - 2 * u);
      if (w <= 0) eases.delete(e.id);
      else { x += o.dx * w; y += o.dy * w; a += o.da * w; }
    }
    e.x = e.renderX = x;
    e.y = e.renderY = y;
    e.angle = e.renderAngle = a;
  };
  const place = (e: InterpolatedEntity) => {
    const was = drawn.get(e.id) === frame - 1;
    drawn.set(e.id, frame);
    const p = ctx.layer.pose(e.id, ptDrawTick(ctx, e.id, od));
    if (!p) {
      // (Off PT now (out of reach, left the layer): eased from where PT drew it onto its interpolated pose)
      const l = ptLast.get(e.id);
      if (l) { ptLast.delete(e.id); if (was) eases.set(e.id, { dx: l.x - e.x, dy: l.y - e.y, da: wrapA(l.angle - e.angle), at: now }); }
      if (eases.has(e.id)) ease(e, e.x, e.y, e.angle);
      return;
    }
    // (Onto PT now: eased from its interpolated pose (where it was placed this frame) onto its PT one)
    if (!ptLast.has(e.id) && was) eases.set(e.id, { dx: e.x - p.x, dy: e.y - p.y, da: wrapA(e.angle - p.angle), at: now });
    ptLast.set(e.id, p);
    ease(e, p.x, p.y, p.angle);
  };
  return {
    frame(t) {
      now = t;
      frame++;
      if (frame % 600 === 0) for (const [id, f] of drawn) if (f < frame - 2) { drawn.delete(id); ptLast.delete(id); eases.delete(id); }
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
    id: 'A', label: 'A · interpolated',
    blurb: 'Your ship predicted; everyone else interpolated at the render tick (before C3).',
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
    id: 'C3', label: 'C3 · + touch register (game)',
    blurb: 'C2, and what a mispredicted ship touched is re-stepped with it.',
    ptst: { touch: true },
    hook: ptstHook,
  },
];

export function modeById(id: string | null | undefined): PredictMode | undefined {
  return PREDICT_MODES.find((m) => m.id === id?.toUpperCase());
}
