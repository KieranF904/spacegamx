/**
 * Timeline: which tick each kind of thing is confirmed at, predicted to, drawn at and hit-tested at (sim foundation;
 * the API is the Stage 0 contract, Stage 1C wires it into GameState). It replaces GameState.ownDrawTick, aheadTick
 * (the drone agent's branch), renderTickNow and the per-shot timeline picks (WeaponFx.timeline) with one service.
 *
 * Ticks:
 *   confirmed  the newest tick the server's snapshots have told (ST: the tick-accurate layer is final up to here)
 *   predicted  the newest tick the client has stepped (PT); its own ship and shells run here
 *   render     the interpolated tick other pilots, bosses, debris and the world are drawn at (an interpolation
 *              delay behind the estimated server tick)
 *
 * Draw tick per kind (fractional):
 *   own, ownShot        ownDraw: half a tick behind the prediction's frame tick, between its last two steps
 *   ahead, aheadShot    ships flown from decisions whose hits the client finds itself (AI pilots, custom enemies,
 *                       not bosses) and their shells: max(render, ownDraw - AHEAD_BACK)
 *   pilot, pilotShot, boss, debris, world   render
 * With prediction off, every kind draws at render (own at the raw server tick).
 *
 * Hit-test tick (the collision step of tick t, server and SelfHits alike): a pilot's state after its move that tick
 * (t), any other ship's from the tick before (t - 1: pilotless ships move after the collision step).
 */

/** Ticks behind the own shells' timeline the ships stepped ahead are drawn: a shell's stretch k..k+1 meets a ship that isn't a pilot as it ended k - 1 */
export const AHEAD_BACK = 1.5;

export type TimelineKind = 'own' | 'ownShot' | 'ahead' | 'aheadShot' | 'pilot' | 'pilotShot' | 'boss' | 'debris' | 'world';

/** What a Timeline reads from the client's clock each frame (GameState has all of it today) */
export interface TimelineClock {
  predictionEnabled: boolean;
  /** Newest tick told by a snapshot */
  confirmedTick: number;
  /** Newest tick the prediction has stepped (0: none yet) */
  predictedTick: number;
  /** Where the prediction should be this frame (estimated server tick + lead), fractional */
  frameTick: number;
  /** The raw server tick estimate (no lead), fractional */
  rawServerTick: number;
  /** The interpolated tick (estimated server tick less the interpolation delay), fractional */
  renderTick: number;
  /** The prediction has a previous step to draw between */
  hasPrev: boolean;
}

export class Timeline {
  constructor(private clock: TimelineClock) {}

  /** Swap in this frame's clock reading */
  set(clock: TimelineClock): void { this.clock = clock; }

  get confirmedTick(): number { return this.clock.confirmedTick; }
  get predictedTick(): number { return this.clock.predictedTick; }
  get renderTick(): number { return this.clock.renderTick; }

  /** The own ship's (and own shells') draw tick */
  ownDraw(): number {
    const c = this.clock;
    if (!c.predictionEnabled || c.predictedTick <= 0) return c.rawServerTick;
    if (!c.hasPrev) return c.predictedTick;
    return c.predictedTick - 1 + Math.max(0, Math.min(1, c.frameTick - c.predictedTick + 0.5));
  }

  /** The tick a kind of thing is drawn at this frame */
  drawTick(kind: TimelineKind): number {
    const c = this.clock;
    switch (kind) {
      case 'own': case 'ownShot': return this.ownDraw();
      case 'ahead': case 'aheadShot':
        return c.predictionEnabled && c.predictedTick > 0 ? Math.max(c.renderTick, this.ownDraw() - AHEAD_BACK) : c.renderTick;
      default: return c.renderTick;
    }
  }

  /** Is tick t final on the tick-accurate layer (no snapshot can still change it) */
  confirmed(t: number): boolean { return t <= this.clock.confirmedTick; }
}

/** The state a ship is hit-tested at in tick t's collision step */
export function hitStateTick(t: number, pilot: boolean): number {
  return pilot ? t : t - 1;
}
